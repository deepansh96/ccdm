"use strict";

// Cuts one project over from its pool bot to the Router, verified and
// reversible; `--rollback` refuses, since no pool bot remains. Each step prints
// `<step>: ok` or `<step>: failed — <reason>`.
//
//   scripts/migrate-to-router.sh <project>
//   scripts/migrate-to-router.sh --rollback <project>
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { RouterClient } = require("./client.js");
const { registryPath, rootToken, socketPath, stateDir } = require("./paths.js");
const { probe } = require("./probe.js");
const { readRegistry, updateRegistry } = require("./registry.js");
const { assignmentChanged } = require("./reminders.js");
const { ensureWebhook } = require("./webhooks.js");

const SCRIPTS = path.resolve(__dirname, "..");
// How long the Router may take to reload the registry or see the session's hello.
const WAIT_MS = Number(process.env.CCDM_MIGRATE_WAIT_MS) || 15000;

class StepFailure extends Error {
  constructor(step, error) {
    super(error.message);
    this.step = step;
  }
}

async function step(name, action) {
  let detail;
  try {
    detail = await action();
  } catch (error) {
    console.log(`${name}: failed — ${error.message}`);
    throw new StepFailure(name, error);
  }
  console.log(`${name}: ok${detail ? ` (${detail})` : ""}`);
}

// A lifecycle script, run to completion; its last error line (or, lacking
// one, its last output line) explains a failure.
function script(name, project) {
  const result = spawnSync(path.join(SCRIPTS, name), [project], { encoding: "utf8", env: process.env });
  if (result.status === 0) return;
  const lastLine = text => (text || "").trim().split("\n").filter(Boolean).at(-1);
  const reason = lastLine(result.stderr) || lastLine(result.stdout);
  throw new Error(`${name} exited ${result.status ?? result.signal}${reason ? `: ${reason}` : ""}`);
}

const launcher = entry => (entry.type === "codex" ? "start-codex-session.sh" : "start-session.sh");

async function routerStatus(project) {
  const client = new RouterClient({ role: "status", timeoutMs: 5000 });
  try {
    await client.connect();
    return await client.request("status", { project });
  } catch (error) {
    throw new Error(`the Router is not reachable at ${socketPath()}: ${error.message}`);
  } finally {
    client.close();
  }
}

async function waitForStatus(project, predicate, describe) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const status = await routerStatus(project);
    if (predicate(status)) return status;
    if (Date.now() >= deadline) throw new Error(describe(status));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function projectEntry(project) {
  const registry = await readRegistry(registryPath());
  const entry = registry.projects?.[project];
  if (!entry?.channel_id) throw new Error(`${project} is not a registered project with a channel_id`);
  return entry;
}

async function preflight(project) {
  const entry = await projectEntry(project);
  if (entry.transport === "router") throw new Error(`${project} is already on the Router`);
  const status = await routerStatus(project);
  if (status.gateway !== "ready") throw new Error(`the Router's gateway is ${status.gateway}, not ready`);
  const missing = status.target?.missing_permissions;
  if (!Array.isArray(missing)) throw new Error(`the Router cannot check root's permissions in ${entry.channel_id}`);
  if (missing.length) throw new Error(`root lacks ${missing.join(", ")} in ${entry.channel_id}`);
  return `Router ready, root permitted in ${entry.channel_id}`;
}

function setTransport(project, transport) {
  return updateRegistry(registryPath(), registry => {
    if (transport) registry.projects[project].transport = transport;
    else delete registry.projects[project].transport;
  });
}

async function reassign(project) {
  await assignmentChanged(project, { registryFile: registryPath() });
  return (await readRegistry(registryPath())).projects[project].assignment_generation;
}

async function verify(project, entry) {
  await waitForStatus(project,
    status => status.sessions.some(session => session.role === "project" && session.project === project
      && session.scope.channel_id === String(entry.channel_id)),
    () => `the Router shows no ${project} session connected in ${entry.channel_id}`);
  const result = await probe({ project, registryFile: registryPath(), stateDir: stateDir(), token: await rootToken() });
  return `session connected in ${entry.channel_id}; probe message ${result.message_id} webhook_id=${result.webhook_id}`;
}

async function migrate(project) {
  let entry;
  await step("preflight", async () => {
    const detail = await preflight(project);
    entry = await projectEntry(project);
    return detail;
  });
  let reassigned = false;
  try {
    await step("stop", () => script("stop-session.sh", project));
    await step("ensure-webhook", async () => `webhook_id=${(await ensureWebhook({
      project, registryFile: registryPath(), stateDir: stateDir(), token: await rootToken(),
    })).webhook_id}`);
    await step("transport", async () => {
      await setTransport(project, "router");
      await waitForStatus(project, status => status.projects.some(route => route.project === project),
        () => `the Router has not loaded ${project} as a router project`);
      return "router";
    });
    reassigned = true;
    await step("assignment-changed", async () => `generation ${await reassign(project)}`);
    await step("start", () => script(launcher(entry), project));
    await step("verify", () => verify(project, entry));
  } catch (error) {
    if (!(error instanceof StepFailure)) throw error;
    // Neither Claude nor Codex has a pool mode: the fallback is the project's previous registry state.
    const previous = "its previous registry state";
    console.log(`rolling back ${project} to ${previous} after the ${error.step} step failed`);
    const rolledBack = await rollbackSteps(project, entry, { reassign: reassigned })
      .then(() => `rolled back to ${previous}`, failure => `rollback also failed at ${failure.step}: ${failure.message}`);
    throw new Error(`migration of ${project} failed at ${error.step}: ${error.message}; ${rolledBack}`);
  }
  console.log(`migrated ${project} to the Router`);
}

// Stops whatever serves the project, then restores its previous registry state.
async function rollbackSteps(project, entry, { reassign: issue = true } = {}) {
  await step("stop", () => script("stop-session.sh", project));
  await step("transport", async () => { await setTransport(project, null); return "previous"; });
  if (issue) await step("assignment-changed", async () => `generation ${await reassign(project)}`);
  await step("start", () => script(launcher(entry), project));
}

// Neither Claude nor Codex has a pool bot to return to, so a rollback only
// explains that and changes nothing.
async function rollback(project) {
  await step("preflight", async () => {
    const entry = await projectEntry(project);
    const provider = entry.type === "codex" ? "Codex" : "Claude";
    throw new Error(`${project} is a ${provider} project, and ${provider} has no pool bot to return to`);
  });
}

const args = process.argv.slice(2);
const rollingBack = args[0] === "--rollback";
const project = rollingBack ? args[1] : args[0];
if (!project || args.length !== (rollingBack ? 2 : 1)) {
  console.error("usage: migrate-to-router.sh [--rollback] <project>");
  process.exit(2);
}
(rollingBack ? rollback(project) : migrate(project)).catch(error => {
  if (!(error instanceof StepFailure) || error.step !== "preflight") console.error(error.message);
  else console.error(`${rollingBack ? "rollback" : "migration"} of ${project} stopped at preflight: ${error.message}; nothing changed`);
  process.exit(1);
});
