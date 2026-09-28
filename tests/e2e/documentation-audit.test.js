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
    "pool management",
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

test("scenario matrix records the channel bridge's thread-message filtering", () => {
  assert.match(matrix, /\| Codex bridge \| Thread message filtering \| Covered \| .*type 11.*parentId/);
});

test("scenario matrix records the Conversation Reminder store schema v7 migration", () => {
  assert.match(matrix, /\| Conversation reminders \| Store schema v7 migration \| Covered \| `conversation-reminder-migration\.test\.js` seeds a v6 store.*consecutive_reminders.*future version is refused.*conversation_id.*stale.*pre-upgrade event without `conversation_id`/);
});

test("scenario matrix records the always-on Claude conversation-scoped proxy", () => {
  assert.match(matrix, /\| Claude start \| Always-on conversation-scoped proxy \| Covered \| .*--dangerously-load-development-channels server:discord/);
  assert.match(matrix, /\| Claude start \| Proxy Claude Code version gate \| Covered \| .*2\.1\.281/);
  assert.match(matrix, /\| Claude proxy \| Channel Conversation scoping \| Covered \| .*\/thread.*\/config.*\/close/);
  assert.match(matrix, /\| Claude proxy \| Thread Conversation scoping and bootstrap \| Covered \| .*exactly once/);
  assert.match(matrix, /\| Claude proxy \| Fail closed on plugin tool contract \| Covered \|/);
});

test("operator documentation and scenario matrix record the Thread Supervisor", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  assert.ok(operatorReadme.includes("## Thread Supervisor"));
  for (const phrase of ["scripts/thread-supervisor.py preflight", "scripts/thread-supervisor.py run",
    "scripts/thread-supervisor.py status", "CCDM_THREAD_STATE_DIR", "10080", "Manage Threads"]) {
    assert.ok(section.includes(phrase), phrase);
  }
  for (const scenario of ["Owner thread binding and one-week auto-archive", "Binding eligibility",
    "Thread event dedupe", "Missing Manage Threads", "Worker lock, private state, and preflight"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| `));
  }
  assert.match(fs.readFileSync(".mex/context/architecture.md", "utf8"), /\*\*Thread Supervisor\*\*/);
});

test("operator documentation and scenario matrix record the Thread Supervisor LaunchAgent", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["scripts/install-thread-supervisor.sh", "docs/thread-supervisor.md",
    "scripts/thread-supervisor.py disable", "scripts/thread-supervisor.py enable"]) {
    assert.ok(section.includes(phrase), phrase);
  }
  const guide = fs.readFileSync("docs/thread-supervisor.md", "utf8");
  for (const phrase of ["## Install", "## Restart", "## Foreground debug mode", "scripts/install-thread-supervisor.sh",
    "com.discord.thread-supervisor", "scripts/thread-supervisor.py disable", "scripts/thread-supervisor.py enable",
    "scripts/thread-supervisor.py run", "KeepAlive", "CCDM_THREAD_NODE", "service.log"]) {
    assert.ok(guide.includes(phrase), phrase);
  }
  for (const scenario of ["Supervised LaunchAgent installation", "Disable, enable, and restart",
    "Foreground run against the supervised lock"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| .*thread-supervisor-launchagent\\.test\\.js`));
  }
});

test("registration documentation grants project bots the thread permissions", () => {
  // 274878008384 plus Manage Threads (bit 34) and Create Public Threads (bit 35).
  const threadAllow = "326417615936";
  for (const file of ["CLAUDE.md.example", "skills/create-discord-pool-bot/SKILL.md", ".mex/patterns/register-project.md"]) {
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.includes(threadAllow), `${file} uses ${threadAllow}`);
    assert.ok(!text.includes("274878008384"), `${file} drops the pre-thread integer`);
    for (const phrase of ["Create Public Threads", "Manage Threads"]) assert.ok(text.includes(phrase), `${file}: ${phrase}`);
  }
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["scripts/thread-supervisor.py grant-thread-permissions --all", "--project", threadAllow]) {
    assert.ok(section.includes(phrase), phrase);
  }
  for (const scenario of ["Grant thread permissions", "Scoped thread permission grant", "Missing thread permissions in status"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| .*thread-supervisor-permissions\\.test\\.js`));
  }
});

test("operator documentation and scenario matrix record Claude Thread Conversation sessions", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["scripts/start-thread-session.sh", "<screen_name>-t-", "DISCORD_ACCESS_MODE=static",
    "120 seconds", "stop-session.sh <project>"]) {
    assert.ok(section.includes(phrase), phrase);
  }
  for (const scenario of ["Claude thread session start", "Claude thread boot handoff", "Claude thread starter message",
    "Claude thread boot timeout", "Thread session eligibility"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| .*thread-claude-session\\.test\\.js`));
  }
  assert.match(matrix, /\| Claude start \| Shared launch mapping \| Covered \| .*claude-launch\.py/);
  assert.match(matrix, /\| Fixture contracts \| Claude startup screens \| Covered \| .*claudeBootScreens/);
  assert.match(fs.readFileSync(".mex/context/session-management.md", "utf8"), /start-thread-session\.sh/);
});

test("operator documentation, glossary, and scenario matrix record the Thread Conversation lifecycle", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["action 111", "archive-actor-unknown", "60 seconds", "claude --resume <session id>",
    "View Audit Log"]) {
    assert.ok(section.includes(phrase), phrase);
  }
  for (const scenario of ["Thread archive by owner or root", "Thread auto-archive", "Audit log unavailable",
    "Thread deletion", "Thread resume"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| .*thread-lifecycle\\.test\\.js`));
  }
  assert.match(matrix, /\| Thread Supervisor \| Thread store schema v2 \| Covered \| .*thread-supervisor\.test\.js/);
  assert.match(matrix, /\| Fixture contracts \| Thread lifecycle events \| Covered \| .*auditLogEntries/);
  assert.match(fs.readFileSync("CONTEXT.md", "utf8"), /closed when the owner or root archives its thread/);
});
