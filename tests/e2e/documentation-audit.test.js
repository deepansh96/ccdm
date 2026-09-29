import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const readme = fs.readFileSync("tests/e2e/README.md", "utf8");
const operatorReadme = fs.readFileSync("README.md", "utf8");
const matrix = fs.readFileSync("tests/e2e/SCENARIO_MATRIX.md", "utf8");

test("e2e documentation publishes the final coverage audit and follow-up boundaries", () => {
  for (const phrase of [
    "Harness Architecture",
    "Public Helper APIs",
    "Fixture Contracts",
    "Local Fakes",
    "Test Workspace Isolation",
    "Approved Dependency Resolution",
    "Run Commands",
    "Diagnostics",
    "CI Behavior",
    "Live Gate",
    "Adding Scenarios",
    "Extraction Follow-Ups",
    "Hardcoded-Boundary Inventory",
    "Child-Scoped JavaScript Interception",
  ]) {
    assert.match(readme, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  for (const phrase of [
    "register",
    "deregister",
    "polls",
    "context report",
    "LaunchAgent",
    "/tmp/cc-context-<state>",
    "CCDM_LIVE_E2E=1",
    "Authorization",
    "OAuth tokens",
    "Discord bot tokens",
  ]) {
    assert.match(readme, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }

  for (const workflow of [
    "Root setup",
    "Claude start",
    "Stop session",
    "Codex start",
    "Codex bridge",
    "Discord MCP",
    "Claude usage",
    "Nickname/statusline",
    "Root restart",
    "Usage stats poster",
    "Live smoke",
    "Instruction-only root-agent workflows",
    "Router",
    "Claude channel server",
    "Codex Router mode",
    "Root fallback",
    "Cutover",
    "Retirement",
  ]) {
    assert.match(matrix, new RegExp(`\\| ${workflow} \\|`));
  }
});

test("operator documentation publishes the named Codex account model", () => {
  for (const phrase of [
    "Codex Account Alias",
    "Codex Home",
    "codex_accounts",
    "default_codex_account",
    "codex_account",
    "Project precedence",
    "Root precedence",
    "Legacy Codex Home Override",
    "ROOT_CODEX_HOME",
    "same configuration scope",
    "unknown alias",
    "cli_auth_credentials_store = \"file\"",
    "subscription",
    "codex login",
    "persisted on a project only",
    "Manual migration checklist",
    "Create and authenticate the new home",
    "migrate the ignored",
    "restart every affected long-lived Codex project session",
    "Rollback",
  ]) {
    assert.match(operatorReadme, new RegExp(phrase, "i"));
  }

  for (const workflow of [
    "Named account registry template",
    "Named account operator documentation",
  ]) {
    assert.match(matrix, new RegExp(`\\| ${workflow} \\|`));
  }
});

test("e2e README records the named-account setup and documentation scenarios", () => {
  for (const phrase of [
    "Fresh setup and registry example scenarios",
    "generic named-account fields",
    "operator documentation",
  ]) {
    assert.match(readme, new RegExp(phrase, "i"));
  }
});

test("live-smoke docs and matrix describe the gated Router live smoke test", () => {
  for (const phrase of [
    "## Live Smoke",
    "CCDM_LIVE_E2E=1 node --test tests/e2e/live-smoke.test.js",
    "development-channel confirmation",
    "webhook_id",
    "reaches root only",
    "CCDM_LIVE_OWNER_WAIT_MS",
    "CCDM_LIVE_CODEX_HOME",
    "even when an assertion fails",
  ]) {
    assert.match(readme, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(matrix, /\| Live smoke \| Router live smoke against real Discord, Claude, and Codex \| Covered \|/);
});

const escape = phrase => phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The operator and agent docs rewritten for the one-bot Router model.
const oneBotDocs = [
  "README.md",
  "CLAUDE.md.example",
  "AGENTS.md",
  "registry.example.json",
  "setup.sh",
  ".mex/ROUTER.md",
  ".mex/context/architecture.md",
  ".mex/context/discord-security.md",
  ".mex/context/session-management.md",
  ".mex/patterns/register-project.md",
];

test("operator and agent docs never instruct pool bot management or registry bot tokens", () => {
  for (const file of oneBotDocs) {
    const source = fs.readFileSync(file, "utf8");
    for (const phrase of [
      "pool add",
      "pool remove",
      "pool status",
      "Adding bots to the pool",
      "Managing the Bot Pool",
      "Claim the first available bot",
      "claim one unassigned pool bot",
      "Claims an available bot",
      "returns it to the pool",
      "Rename the bot",
      "Reset the bot name",
      "Pool Project Steps",
      "pool projects",
      "Create bot",
      "Automated bot creation",
      "plugin:discord@claude-plugins-official",
      "DISCORD_BOT_TOKEN=<token>",
      "Bot tokens live only in ignored `registry.json`",
      "One project bot serves one assigned channel",
    ]) {
      assert.doesNotMatch(source, new RegExp(escape(phrase), "i"), `${file} still says "${phrase}"`);
    }
  }
});

test("operator docs document the Router, its tools, and root's emergency fallback", () => {
  for (const phrase of [
    "Router",
    "router status",
    "scripts/install-router-service.sh",
    "scripts/migrate-to-router.sh",
    "ensure-webhook",
    "delete-webhook",
    "probe",
    "scripts/retire-pool.sh",
    "emergency",
    "root_channels",
    "root_allowed_user_ids",
    "webhook_id",
    "Session Scope",
    "Project Identity",
  ]) {
    assert.match(operatorReadme, new RegExp(escape(phrase)), `README.md is missing "${phrase}"`);
  }
  const rootInstructions = fs.readFileSync("CLAUDE.md.example", "utf8");
  for (const phrase of [
    "router status",
    "ensure-webhook",
    "delete-webhook",
    "probe",
    "scripts/retire-pool.sh",
    "emergency",
    "root_channels",
  ]) {
    assert.match(rootInstructions, new RegExp(escape(phrase)), `CLAUDE.md.example is missing "${phrase}"`);
  }
});

test("agent anchor and .mex describe Session Scope enforcement by the Router", () => {
  const agents = fs.readFileSync("AGENTS.md", "utf8");
  assert.match(agents, /One session serves one project channel, enforced by the Router/);

  const security = fs.readFileSync(".mex/context/discord-security.md", "utf8");
  assert.doesNotMatch(security, /## Bot Isolation/);
  assert.match(security, /## Session Scope/);
  assert.match(security, /`project-bot` role and (its )?(per-channel )?override model (is|are) obsolete/);

  const router = fs.readFileSync(".mex/ROUTER.md", "utf8");
  for (const phrase of ["router status", "install-router-service.sh", "migrate-to-router.sh", "retire-pool.sh"]) {
    assert.match(router, new RegExp(escape(phrase)));
  }
});
