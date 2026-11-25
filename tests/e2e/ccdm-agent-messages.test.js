// Root's `scripts/ccdm agent-messages` subcommand: allow, revoke, list, registry lock, and live Router reload.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import {
  createRouterWorkspace,
  routerRegistry,
  routerSocketPath,
  routerWithWebhooks,
  waitFor,
} from "./support/router.js";
import { createWorkspace, runScript } from "./support/runner.js";
import { seedRegistry } from "./support/state.js";
import { cleanup, registerTeardownCallback } from "./support/teardown.js";

test.afterEach(cleanup);

const unix = text => text.replaceAll("\r\n", "\n");
const registryPath = workspace => path.join(workspace.repoDir, "registry.json");
const readRegistry = workspace => JSON.parse(fs.readFileSync(registryPath(workspace), "utf8"));

function cliWorkspace(projects = {}) {
  const workspace = createWorkspace();
  seedRegistry(workspace, {
    discord_user_id: "owner-1",
    guild_id: "guild-1",
    root_channels: ["root-ch"],
    projects: {
      alpha: { path: workspace.repoDir, screen_name: "alpha_s", channel_id: "ch-alpha", type: "claude", webhook_id: "wh-alpha" },
      beta: { path: workspace.repoDir, screen_name: "beta_s", channel_id: "ch-beta", type: "codex", webhook_id: "wh-beta" },
      gamma: { path: workspace.repoDir, screen_name: "gamma_s", channel_id: "ch-gamma", type: "gemini", webhook_id: "wh-gamma" },
      remote_box: { path: "remote:box", screen_name: "remote_s", channel_id: "ch-remote", type: "claude" },
      ...projects,
    },
  });
  const ccdm = async (args, options = {}) => {
    const result = await runScript(workspace, "scripts/ccdm", { args, timeoutMs: 20000, ...options });
    return { ...result, stdout: unix(result.stdout), stderr: unix(result.stderr) };
  };
  return { workspace, ccdm };
}

function assertOk(result) {
  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
}

function assertFailed(result, pattern) {
  assert.equal(result.exitCode, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /^ccdm: /m);
  assert.match(result.stderr, pattern);
}

test("scripts/ccdm --help lists agent-messages and allow adds a grant idempotently without touching other fields", async () => {
  const { workspace, ccdm } = cliWorkspace();

  const help = await ccdm(["--help"]);
  assertOk(help);
  assert.match(help.stdout, /^\s+agent-messages\s/m);
  assert.doesNotMatch(help.stderr, /skipping subcommand/);

  const before = readRegistry(workspace);
  const first = await ccdm(["agent-messages", "allow", "alpha", "beta"]);
  assertOk(first);
  assert.equal(first.stderr, "");

  const afterFirst = readRegistry(workspace);
  const expected = structuredClone(before);
  expected.projects.alpha.agent_message_targets = ["beta"];
  assert.deepEqual(afterFirst, expected);

  const rawAfterFirst = fs.readFileSync(registryPath(workspace), "utf8");
  const repeat = await ccdm(["agent-messages", "allow", "alpha", "beta"]);
  assertOk(repeat);
  assert.equal(fs.readFileSync(registryPath(workspace), "utf8"), rawAfterFirst);

  // Self-grant is allowed.
  const selfGrant = await ccdm(["agent-messages", "allow", "alpha", "alpha"]);
  assertOk(selfGrant);
  assert.deepEqual(readRegistry(workspace).projects.alpha.agent_message_targets, ["beta", "alpha"]);
});

test("allow warns with the guest count when the sender has guests and refuses unknown or remote projects on either side", async () => {
  const { workspace, ccdm } = cliWorkspace({
    alpha: {
      path: "/tmp/alpha",
      screen_name: "alpha_s",
      channel_id: "ch-alpha",
      type: "claude",
      webhook_id: "wh-alpha",
      guest_user_ids: ["guest-1", "guest-2"],
    },
    beta: {
      path: "/tmp/beta",
      screen_name: "beta_s",
      channel_id: "ch-beta",
      type: "codex",
      webhook_id: "wh-beta",
      guest_user_ids: ["guest-3"],
    },
  });

  // Sender has 2 guests -> warns naming count 2, still records grant.
  const withGuests = await ccdm(["agent-messages", "allow", "alpha", "gamma"]);
  assertOk(withGuests);
  assert.match(withGuests.stderr, /warning/i);
  assert.match(withGuests.stderr, /\b2 guests\b/i);
  assert.deepEqual(readRegistry(workspace).projects.alpha.agent_message_targets, ["gamma"]);

  // Target having guests (sender gamma has none) -> no warning.
  const targetOnlyGuests = await ccdm(["agent-messages", "allow", "gamma", "beta"]);
  assertOk(targetOnlyGuests);
  assert.equal(targetOnlyGuests.stderr, "");
  assert.deepEqual(readRegistry(workspace).projects.gamma.agent_message_targets, ["beta"]);

  // Sender has 1 guest -> singular guest count warning.
  const oneGuest = await ccdm(["agent-messages", "allow", "beta", "gamma"]);
  assertOk(oneGuest);
  assert.match(oneGuest.stderr, /warning/i);
  assert.match(oneGuest.stderr, /\b1 guest\b/i);
  assert.deepEqual(readRegistry(workspace).projects.beta.agent_message_targets, ["gamma"]);

  // Unknown or remote: on either side -> ccdm: ..., exit 1, registry untouched.
  const rawBeforeErrors = fs.readFileSync(registryPath(workspace), "utf8");
  assertFailed(await ccdm(["agent-messages", "allow", "missing", "beta"]), /unknown project: missing/i);
  assertFailed(await ccdm(["agent-messages", "allow", "alpha", "missing"]), /unknown project: missing/i);
  assertFailed(await ccdm(["agent-messages", "allow", "remote_box", "beta"]), /remote/i);
  assertFailed(await ccdm(["agent-messages", "allow", "alpha", "remote_box"]), /remote/i);
  assert.equal(fs.readFileSync(registryPath(workspace), "utf8"), rawBeforeErrors);
});

test("revoke removes active and stale grants and exits 0 saying nothing to remove when absent", async () => {
  const { workspace, ccdm } = cliWorkspace({
    alpha: {
      path: "/tmp/alpha",
      screen_name: "alpha_s",
      channel_id: "ch-alpha",
      type: "claude",
      webhook_id: "wh-alpha",
      agent_message_targets: ["beta", "retired_proj"],
    },
  });

  // Remove one grant while keeping the other.
  const first = await ccdm(["agent-messages", "revoke", "alpha", "beta"]);
  assertOk(first);
  assert.deepEqual(readRegistry(workspace).projects.alpha.agent_message_targets, ["retired_proj"]);

  // Revoking a stale (unregistered) target succeeds.
  const stale = await ccdm(["agent-messages", "revoke", "alpha", "retired_proj"]);
  assertOk(stale);
  assert.equal("agent_message_targets" in readRegistry(workspace).projects.alpha, false);

  // Revoking an absent grant exits 0, says there was nothing to remove, and leaves the file untouched.
  const rawAfter = fs.readFileSync(registryPath(workspace), "utf8");
  const absent = await ccdm(["agent-messages", "revoke", "alpha", "beta"]);
  assertOk(absent);
  assert.match(absent.stdout, /nothing to remove/i);
  assert.equal(fs.readFileSync(registryPath(workspace), "utf8"), rawAfter);

  // Unknown sender fails with ccdm: ... and exit 1.
  assertFailed(await ccdm(["agent-messages", "revoke", "missing", "beta"]), /unknown project: missing/i);
  assert.equal(fs.readFileSync(registryPath(workspace), "utf8"), rawAfter);
});

test("list prints one from -> to line per grant, flags stale targets, filters by project, and supports --json", async () => {
  const { ccdm } = cliWorkspace({
    alpha: {
      path: "/tmp/alpha",
      screen_name: "alpha_s",
      channel_id: "ch-alpha",
      type: "claude",
      webhook_id: "wh-alpha",
      agent_message_targets: ["beta", "retired_proj"],
    },
    gamma: {
      path: "/tmp/gamma",
      screen_name: "gamma_s",
      channel_id: "ch-gamma",
      type: "gemini",
      webhook_id: "wh-gamma",
      agent_message_targets: ["alpha"],
    },
  });

  const allText = await ccdm(["agent-messages", "list"]);
  assertOk(allText);
  assert.deepEqual(allText.stdout.trimEnd().split("\n"), [
    "alpha -> beta",
    "alpha -> retired_proj (stale)",
    "gamma -> alpha",
  ]);

  const allJson = await ccdm(["agent-messages", "list", "--json"]);
  assertOk(allJson);
  assert.deepEqual(JSON.parse(allJson.stdout), [
    { from: "alpha", to: "beta", stale: false },
    { from: "alpha", to: "retired_proj", stale: true },
    { from: "gamma", to: "alpha", stale: false },
  ]);

  // Filter by project matches grants involving that project (as sender or target).
  const byBeta = await ccdm(["agent-messages", "list", "beta"]);
  assertOk(byBeta);
  assert.deepEqual(byBeta.stdout.trimEnd().split("\n"), ["alpha -> beta"]);

  const byGammaJson = await ccdm(["agent-messages", "list", "gamma", "--json"]);
  assertOk(byGammaJson);
  assert.deepEqual(JSON.parse(byGammaJson.stdout), [
    { from: "gamma", to: "alpha", stale: false },
  ]);

  // Filtering by a deregistered project name surfaces stale grants targeting it.
  const byStale = await ccdm(["agent-messages", "list", "retired_proj"]);
  assertOk(byStale);
  assert.deepEqual(byStale.stdout.trimEnd().split("\n"), ["alpha -> retired_proj (stale)"]);

  // Empty result when no grants match.
  const emptyText = await ccdm(["agent-messages", "list", "remote_box"]);
  assertOk(emptyText);
  assert.equal(emptyText.stdout, "");

  const emptyJson = await ccdm(["agent-messages", "list", "remote_box", "--json"]);
  assertOk(emptyJson);
  assert.deepEqual(JSON.parse(emptyJson.stdout), []);
});

test("two concurrent allow calls on different projects both land under the shared registry lock", async () => {
  const { workspace, ccdm } = cliWorkspace();
  const hold = path.join(workspace.tmpRoot, "registry-hold");
  const env = { CCDM_TEST_REGISTRY_HOLD: hold };
  fs.writeFileSync(`${hold}.armed`, "");

  const first = ccdm(["agent-messages", "allow", "alpha", "beta"], { env });
  await waitFor(() => fs.existsSync(`${hold}.waiting`), () => "first allow to pause holding the registry lock", 15000);

  const second = ccdm(["agent-messages", "allow", "gamma", "alpha"], { env });
  await waitFor(() => fs.existsSync(`${hold}.blocked`), () => "second allow to wait on the registry lock", 15000);

  fs.writeFileSync(`${hold}.release`, "");
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assertOk(firstResult);
  assertOk(secondResult);

  const registry = readRegistry(workspace);
  assert.deepEqual(registry.projects.alpha.agent_message_targets, ["beta"]);
  assert.deepEqual(registry.projects.gamma.agent_message_targets, ["alpha"]);
  assert.deepEqual(
    fs.readdirSync(workspace.repoDir).filter(name => /registry\.json\.(lock|.*\.tmp)/.test(name)),
    [],
  );
});

async function connectAgentClient(workspace, project, key) {
  const socket = net.connect(routerSocketPath(workspace));
  registerTeardownCallback(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const frames = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });
  const send = frame => socket.write(`${JSON.stringify(frame)}\n`);
  send({ type: "hello", v: 1, role: "project", project, key, capabilities: ["agent_messages"] });
  const hello = await waitFor(
    () => frames.find(frame => frame.type === "hello_ok" || frame.type === "hello_error"),
    () => `${project} hello: ${JSON.stringify(frames)}`,
  );
  assert.equal(hello.type, "hello_ok", JSON.stringify(hello));
  let reqCount = 0;
  return {
    get events() { return frames.filter(frame => frame.type === "event"); },
    async request(op, args = {}, timeoutMs = 5000) {
      const id = `req-${++reqCount}`;
      send({ type: "request", id, op, args });
      return waitFor(
        () => frames.find(frame => frame.type === "response" && frame.id === id),
        () => `${op} response: ${JSON.stringify(frames)}`,
        timeoutMs,
      );
    },
  };
}

async function afterRouterReload(router, change) {
  await new Promise(resolve => setTimeout(resolve, 100));
  const reloads = () => router.stdout.split("registry reloaded").length - 1;
  const before = reloads();
  const result = await change();
  await waitFor(() => reloads() > before, () => `registry reload:\n${router.stdout}\n${router.stderr}`);
  return result;
}

test("with a live Router, allow and revoke take effect on the next send with no Router or session restart", async () => {
  const workspace = createRouterWorkspace(routerRegistry({
    demo: { channel_id: "demo-channel", type: "claude", transport: "router" },
    beta: { channel_id: "beta-channel", type: "codex", transport: "router" },
  }));
  const router = await routerWithWebhooks(workspace, ["demo", "beta"], {
    env: { CCDM_ROUTER_REGISTRY_DEBOUNCE_MS: "20" },
  });
  const demo = await connectAgentClient(workspace, "demo", "demo-key");
  const beta = await connectAgentClient(workspace, "beta", "beta-key");
  const ccdm = async args => {
    const result = await runScript(workspace, "scripts/ccdm", { args, timeoutMs: 20000 });
    return { ...result, stdout: unix(result.stdout), stderr: unix(result.stderr) };
  };

  // Before allow: refused with not_granted.
  const deniedBefore = await demo.request("agent_request", {
    target: "beta",
    text: "before allow",
    idempotency_key: "live-before",
  });
  assert.equal(deniedBefore.ok, false);
  assert.equal(deniedBefore.error.code, "not_granted");

  // Allow via CLI -> hot-reloaded without restarting Router or sessions.
  const allowedCli = await afterRouterReload(router, () => ccdm(["agent-messages", "allow", "demo", "beta"]));
  assertOk(allowedCli);

  const accepted = await demo.request("agent_request", {
    target: "beta",
    text: "after allow",
    idempotency_key: "live-after-allow",
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const requestId = accepted.result.request_id;
  await waitFor(
    () => beta.events.some(event => event.event === "agent_message" && event.request_id === requestId),
    () => `beta delivery of ${requestId}: ${JSON.stringify(beta.events)}`,
  );

  // Revoke via CLI -> refused again on the next send with no restart.
  const revokedCli = await afterRouterReload(router, () => ccdm(["agent-messages", "revoke", "demo", "beta"]));
  assertOk(revokedCli);

  const deniedAfter = await demo.request("agent_request", {
    target: "beta",
    text: "after revoke",
    idempotency_key: "live-after-revoke",
  });
  assert.equal(deniedAfter.ok, false);
  assert.equal(deniedAfter.error.code, "not_granted");
});
