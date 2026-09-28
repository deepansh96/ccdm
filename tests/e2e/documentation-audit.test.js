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

test("scenario matrix records Thread Conversation reminders", () => {
  for (const [scenario, detail] of [
    ["Thread reply arms an in-thread reminder", /conversation-reminder-codex\.test\.js.*Codex thread host.*conversation-reminder-claude\.test\.js/],
    ["Per-conversation Claude capability marker", /capabilities\/<project>\/<channel_id>\.json.*not verified/],
    ["Thread-local acknowledgment", /thread A acknowledges only A.*guest/],
    ["Thread close events", /`\/close`.*owner archive.*`conversation_closed`/],
    ["Thread deletion", /`conversation_deleted`.*deletes the thread's outstanding reminder/],
    ["Reminder into an auto-archived thread", /reopens it.*starts no session/],
    ["Thread discovery on enable", /6-day-old archived thread.*8-day-old.*closed/],
    ["Thread readiness in status", /readiness\.projects\.<project>\.threads\.<thread_id>.*blockers/],
    ["Thread provider switch resets reminders", /`conversation_reset`.*outstanding reminder is deleted.*`\/clear` emits no reset/],
  ]) {
    const row = matrix.split("\n").find(line => line.startsWith(`| Conversation reminders | ${scenario} | Covered | `));
    assert.ok(row, scenario);
    assert.match(row, detail);
  }
  const guide = fs.readFileSync("docs/conversation-reminders.md", "utf8");
  for (const phrase of ["## Thread Conversations", "conversation_closed", "conversation_deleted",
    "conversation_reset", "readiness.projects.<project>.threads.<thread_id>", "within 7 days",
    "capabilities/<project>/<conversation_id>.json", "--conversation <thread_id>"]) {
    assert.ok(guide.includes(phrase), phrase);
  }
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

test("operator documentation and scenario matrix record Codex Thread Conversations", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["scripts/codex-thread-host.js", "<screen_name>-threads", "thread_ws_port", "codex_sandbox",
    "config.mcp_servers", "default_tools_approval_mode", "enabled: false", "control.sock", "host-event"]) {
    assert.ok(section.includes(phrase), phrase);
  }
  for (const scenario of ["Codex thread session start", "Codex thread tool scope", "Codex thread settings",
    "Two Codex threads", "Codex thread boot handoff", "Codex thread host eligibility"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| .*thread-codex-session\\.test\\.js`));
  }
  assert.match(matrix, /\| Fixture contracts \| Codex thread host fakes \| Covered \| .*forbidDiscordConfigWrites/);
  assert.match(fs.readFileSync(".mex/context/session-management.md", "utf8"), /codex-thread-host\.js/);
  // The project-mode Codex scope token lives as long as its process, not one turn.
  assert.match(fs.readFileSync(".mex/context/decisions.md", "utf8"), /reply scope token is per process/);
});

test("operator documentation and scenario matrix record the Codex Thread Conversation lifecycle", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["thread/unsubscribe", "thread/resume", "thread/unarchive", "never calls `thread/archive`",
    "stops its app-servers and exits", "refreshed override"]) {
    assert.ok(section.includes(phrase), phrase);
  }
  for (const scenario of ["Codex thread stop and host exit", "Codex thread resume", "Codex thread close and delete",
    "Codex thread tool-scope drift"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| .*thread-codex-lifecycle\\.test\\.js`));
  }
  assert.match(matrix, /\| Fixture contracts \| Codex thread host fakes \| Covered \| .*setHomeMcpServers/);
  assert.match(fs.readFileSync(".mex/context/session-management.md", "utf8"), /thread\/unsubscribe/);
});

test("operator documentation and scenario matrix record the /thread command and Claude account aliases", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["/thread <name> [--provider claude|codex] [--account X] [--model Y] [--effort Z] [first message…]",
    "claude_accounts", "codex_accounts", "creation request", "/config"]) {
    assert.ok(section.includes(phrase), phrase);
  }
  assert.ok(operatorReadme.includes("### Claude Accounts"));
  for (const scenario of ["Thread command creation", "Cross-provider thread command", "Thread command validation",
    "Thread command eligibility"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| .*thread-commands\\.test\\.js`));
  }
  assert.match(matrix, /\| Codex bridge \| Reserved thread commands \| Covered \| .*\/thread.*\/config/);
  assert.match(matrix, /\| Fixture contracts \| Thread creation routes \| Covered \| .*threadCreates/);
});

test("operator documentation and scenario matrix record root and channel-agent thread creation", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["scripts/threads.sh create <project> <name>", "create_thread", "requests.sock", "channel-agent",
    "From root: …"]) {
    assert.ok(section.includes(phrase), phrase);
  }
  const rootInstructions = fs.readFileSync("CLAUDE.md.example", "utf8");
  for (const phrase of ["scripts/threads.sh create <project> <name>", "create_thread"]) {
    assert.ok(rootInstructions.includes(phrase), phrase);
  }
  assert.match(fs.readFileSync("docs/thread-supervisor.md", "utf8"), /requests\.sock/);
  for (const scenario of ["Root thread creation", "Thread creation without a supervisor", "Root thread creation validation",
    "Channel agent create_thread tool", "Thread sessions lack create_thread"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| .*thread-create-requests\\.test\\.js`));
  }
});

test("operator documentation and scenario matrix record in-thread /config", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["/config [provider=claude|codex] [account=X] [model=Y] [effort=Z]", "(inherited)", "✅",
    "never resumed again"]) {
    assert.ok(section.includes(phrase), phrase);
  }
  for (const scenario of ["Thread config display", "Thread config model change", "Thread config provider switch",
    "Thread config validation", "Thread config never reaches a model"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| .*thread-config\\.test\\.js`));
  }
});

test("operator documentation and scenario matrix record in-thread management commands", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["/restart  /clear  /compact  /pause  /unpause  /close", "exactly one line",
    "PATCH archived: true", "close intent", "only the owner's `/close` counts"]) {
    assert.ok(section.includes(phrase), phrase);
  }
  for (const scenario of ["Thread restart and compact isolation", "Thread clear", "Codex thread management commands",
    "Thread close", "Bot archive without close intent", "Thread management commands never reach a model"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| .*thread-management-commands\\.test\\.js`));
  }
});

test("operator documentation, example registry, and scenario matrix record thread session caps", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["`thread_session_caps`", '`{ "claude": 6, "codex": 12 }`', "30 minutes",
    "`stopped` / `evicted`", "Paused to free a session slot; reply to resume.", "Queued, N sessions busy.",
    "never evicted", "first-in, first-out", "`Stop` or `StopFailure`", "never a Channel Conversation"]) {
    assert.ok(section.includes(phrase), phrase);
  }
  const example = JSON.parse(fs.readFileSync("registry.example.json", "utf8"));
  assert.deepEqual(example.thread_session_caps, { claude: 6, codex: 12 });
  for (const scenario of ["Thread cap eviction", "Evicted thread resume", "Mid-turn session never evicted",
    "Codex mid-turn never evicted", "Thread queue FIFO", "Codex cap across hosts"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| .*thread-capacity\\.test\\.js`));
  }
});

test("operator documentation, root instructions, and scenario matrix record the shared conversation resolver", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["scripts/resolve-conversation.py <channel_or_thread_id>", "`thread_id: null`",
    "never calls Discord", "send-claude-command.sh --channel <thread id> compact", "parent project bot's token"]) {
    assert.ok(section.includes(phrase), phrase);
  }
  assert.ok(fs.readFileSync("CLAUDE.md.example", "utf8").includes("scripts/resolve-conversation.py <channel_or_thread_id>"));
  for (const scenario of ["Channel and thread resolution", "Unknown or ambiguous id"]) {
    assert.match(matrix, new RegExp(`\\| Conversation resolver \\| ${scenario} \\| Covered \\| .*conversation-resolver\\.test\\.js`));
  }
  assert.match(matrix, /\| Claude command relay \| Thread relay \| Covered \| .*claude-command-relay\.test\.js/);
  assert.match(matrix, /\| Discord export \| Thread export \| Covered \| .*discord-export\.test\.js/);
  assert.match(matrix, /\| Guest access \| Thread target \| Covered \| .*guest-access\.test\.js/);
  assert.match(matrix, /\| Discord MCP \| Root thread access \| Covered \| .*discord-mcp\.test\.js/);
  assert.match(matrix, /\| Codex bridge \| Root thread access \| Covered \| .*bridge-basic-turn\.test\.js/);
});

test("operator documentation, root instructions, patterns, and scenario matrix record root thread operations", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["scripts/threads.sh list <project>", "scripts/threads.sh stop|restart|close [<project>] <thread>",
    "scripts/stop-session.sh <project> --threads", "scripts/stop-session.sh <project> --all", "`stopped` / `operator`",
    "https://discord.com/channels/<guild>/<thread>"]) {
    assert.ok(section.includes(phrase), phrase);
  }
  const rootInstructions = fs.readFileSync("CLAUDE.md.example", "utf8");
  for (const phrase of ["scripts/threads.sh list <project>", "scripts/threads.sh stop|restart|close [<project>] <thread>",
    "scripts/stop-session.sh <project> --threads"]) {
    assert.ok(rootInstructions.includes(phrase), phrase);
  }
  const pattern = fs.readFileSync(".mex/patterns/manage-threads.md", "utf8");
  for (const phrase of ["scripts/threads.sh list <project>", "--threads", "--all"]) assert.ok(pattern.includes(phrase), phrase);
  assert.match(fs.readFileSync(".mex/patterns/INDEX.md", "utf8"), /\[manage-threads\.md\]\(manage-threads\.md\)/);
  assert.match(fs.readFileSync(".mex/patterns/manage-session.md", "utf8"), /--threads/);
  for (const scenario of ["Thread list", "Thread operations by name", "Thread operations by link",
    "Ambiguous or unknown thread", "Channel-only and thread-only stop", "Codex thread host stop"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| .*thread-operations\\.test\\.js`));
  }
});

test("operator documentation, root instructions, patterns, and scenario matrix record the project-changed hook", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["scripts/thread-supervisor.py project-changed --project <project>", "`bot-changed`",
    "`guest-changed`", "Stopped, queued, and closed threads stay as they are."]) {
    assert.ok(section.includes(phrase), phrase);
  }
  const rootInstructions = fs.readFileSync("CLAUDE.md.example", "utf8");
  const deregistration = rootInstructions.slice(rootInstructions.indexOf("#### 6. Deregister a project"),
    rootInstructions.indexOf("#### 7. Pool status"));
  assert.ok(deregistration.includes("scripts/thread-supervisor.py project-changed --project <project>"));
  assert.match(deregistration, /bot is reassigned/);
  assert.match(fs.readFileSync(".mex/patterns/register-project.md", "utf8"), /project-changed --project <project>/);
  assert.match(fs.readFileSync(".mex/patterns/manage-guest-access.md", "utf8"), /project-changed --project <project>/);
  for (const scenario of ["Thread deregistration", "Thread bot reassignment", "Thread guest change"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| .*thread-project-changes\\.test\\.js`));
  }
});

test("operator documentation, guide, and scenario matrix record Thread Supervisor reconciliation", () => {
  const section = operatorReadme.slice(operatorReadme.indexOf("## Thread Supervisor"));
  for (const phrase of ["scripts/thread-supervisor.py reconcile", "`stopped` / `crashed`", "Gateway reconnect",
    "newest owner message"]) {
    assert.ok(section.includes(phrase), phrase);
  }
  const guide = fs.readFileSync("docs/thread-supervisor.md", "utf8");
  for (const phrase of ["## Reconciliation", "scripts/thread-supervisor.py reconcile", "`stopped` / `crashed`"]) {
    assert.ok(guide.includes(phrase), phrase);
  }
  for (const scenario of ["Missed thread creation", "Missed owner message", "Missed archive", "Crashed thread session",
    "Gateway reconnect reconciliation"]) {
    assert.match(matrix, new RegExp(`\\| Thread Supervisor \\| ${scenario} \\| Covered \\| .*thread-reconcile\\.test\\.js`));
  }
  assert.match(matrix, /\| Fixture contracts \| Thread lists \| Covered \| .*threadListFetches/);
});
