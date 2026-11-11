import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PYTHON } from "./support/platform.js";

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
  ".mex/patterns/operate-thread-supervisor.md",
  "docs/thread-supervisor.md",
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

// The thread docs, each with the phrases that pin the shipped behaviour (ADR 0005).
const ROOT_THREAD_PERMISSIONS = ["Create Public Threads", "Send Messages in Threads", "Manage Threads", "View Audit Log"];
const threadDocs = {
  "docs/thread-supervisor.md": [
    "Thread Conversation", "Thread Supervisor", "Channel Conversation", "Session Scope", "Closed Conversation",
    "no Discord credential", "com.ccdm.thread-supervisor", "scripts/install-thread-supervisor.sh",
    "scripts/thread-supervisor.py run", "preflight", "scripts/start-thread-session.sh", "keys/.thread-<thread_id>.key",
    "/thread <name>", "create_thread", "scripts/threads.sh create", "10080", "/config", "/close", "/restart",
    "/clear", "/compact", "✅", "👀", "💤", "<project>-<provider> · N%", "archive-actor-unknown", "auto-archive",
    "--resume", "thread_session_caps", "claude_accounts", "Claude 6", "Codex 8",
    "Paused to free a session slot; send a message here to resume.", "Queued, N sessions busy.", "reconcile",
    "stop-session.sh <project> --threads", "--all", "Conversation Reminder", "router status",
    ...ROOT_THREAD_PERMISSIONS, "granted once by hand", "Operator checklist", "thread → Claude reply",
    "thread → Codex reply", "not run in CI",
  ],
  "README.md": [
    "## Thread Conversations", "docs/thread-supervisor.md", "scripts/install-thread-supervisor.sh", "/thread",
    "scripts/threads.sh", "thread_session_caps", "claude_accounts", "--threads", ...ROOT_THREAD_PERMISSIONS,
  ],
  "AGENTS.md": [
    "Thread Conversations", "channel's session only", "unless the request names its threads",
    ...ROOT_THREAD_PERMISSIONS, "granted once by hand",
  ],
  ".mex/ROUTER.md": ["Thread Conversation", "scripts/threads.sh", "install-thread-supervisor.sh",
    "thread-conversation-journey.test.js"],
  ".mex/context/architecture.md": ["Thread Supervisor", "scripts/ccdm start-thread-session", "thread role"],
  ".mex/context/session-management.md": ["Thread Conversation", "scripts/ccdm start-thread-session", "--threads", "--all",
    "restart <project>"],
  ".mex/context/discord-security.md": ["## Thread Conversations", "thread alone", "holds no Discord credential",
    ...ROOT_THREAD_PERMISSIONS, "granted once by hand"],
  ".mex/patterns/operate-thread-supervisor.md": ["scripts/install-thread-supervisor.sh", "preflight",
    "scripts/thread-supervisor.py status", "scripts/threads.sh list", ...ROOT_THREAD_PERMISSIONS],
  ".mex/patterns/register-project.md": ["Thread Conversations", "closed/deregistered", "scripts/ccdm stop-session <project> --all"],
  ".mex/patterns/INDEX.md": ["operate-thread-supervisor.md"],
  "tests/e2e/README.md": ["## Thread Conversations", "thread-conversation-journey.test.js",
    "Thread Supervisor", "Live Smoke Suite"],
};

test("thread docs describe Thread Conversations, the Thread Supervisor and root's thread permissions", () => {
  for (const [file, phrases] of Object.entries(threadDocs)) {
    const source = fs.readFileSync(file, "utf8");
    for (const phrase of phrases) {
      assert.match(source, new RegExp(escape(phrase)), `${file} is missing "${phrase}"`);
    }
  }
  for (const workflow of ["Thread Conversations", "Thread Supervisor", "Thread journey"]) {
    assert.match(matrix, new RegExp(`\\| ${workflow} \\|`), `SCENARIO_MATRIX.md is missing a ${workflow} row`);
  }
});

// Root's runbook: the files root follows, word for word, to act on either OS.
const runbookFiles = [
  "AGENTS.md",
  ".mex/ROUTER.md",
  ".mex/context/architecture.md",
  ".mex/context/conventions.md",
  ".mex/context/decisions.md",
  ".mex/context/discord-security.md",
  ".mex/context/session-management.md",
  ".mex/context/setup.md",
  ".mex/context/stack.md",
  ".mex/patterns/debug-discord-session.md",
  ".mex/patterns/manage-claude-home-login.md",
  ".mex/patterns/manage-session.md",
  ".mex/patterns/operate-conversation-reminders.md",
  ".mex/patterns/operate-thread-supervisor.md",
  ".mex/patterns/register-project.md",
  ".mex/patterns/root-commands.md",
  ".mex/patterns/setup-chatgpt-codex-account.md",
  ".mex/patterns/setup-deepseek-codex.md",
  ".mex/patterns/setup-mimo-codex.md",
];

// Descriptive history, which records what was built and decided and is never
// followed as steps. A whole file, or one section named by its heading line.
const descriptiveHistory = [
  { file: ".mex/context/decisions.md" },
  { file: ".mex/ROUTER.md", section: "## Current Project State" },
];

// Root's command entries in CLAUDE.md.example: "Commands" up to "Channel Routing
// Rules", which takes in "Discord Polls" and "Voice Messages". The rest of the
// file is P5.7b's, so it carries a pending marker or is left alone.
const ROOT_ENTRIES = { file: "CLAUDE.md.example", from: "### Commands", to: "### Channel Routing Rules" };

const headingLevel = line => /^#{1,6} /.test(line) ? line.indexOf(" ") : 0;

// The lines of a section: from its heading to the next heading of the same or a
// higher level. Lines inside a fenced block are never headings.
function sectionRange(lines, heading) {
  const start = lines.findIndex(line => line.startsWith(heading));
  if (start < 0) return null;
  const level = headingLevel(lines[start]);
  let fenced = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index])) fenced = !fenced;
    if (!fenced && headingLevel(lines[index]) && headingLevel(lines[index]) <= level) return [start, index];
  }
  return [start, lines.length];
}

// The audited lines of each runbook file, as { file, lines, audited(index) }.
function runbookSources() {
  const sources = runbookFiles.map(file => {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const history = descriptiveHistory.filter(entry => entry.file === file);
    if (history.some(entry => !entry.section)) return { file, lines, audited: () => false };
    const skipped = history.map(entry => {
      const range = sectionRange(lines, entry.section);
      assert.ok(range, `${file} has no "${entry.section}" section; fix the descriptive-history allowlist`);
      return range;
    });
    return { file, lines, audited: index => !skipped.some(([start, end]) => index >= start && index < end) };
  });
  const lines = fs.readFileSync(ROOT_ENTRIES.file, "utf8").split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(ROOT_ENTRIES.from));
  const end = lines.findIndex(line => line.startsWith(ROOT_ENTRIES.to));
  assert.ok(start >= 0 && end > start, `${ROOT_ENTRIES.file} lost one of root's command headings`);
  sources.push({ file: ROOT_ENTRIES.file, lines, audited: index => index >= start && index < end });
  return sources;
}

// A command only macOS can run: tmux, a zsh launch, launchd, nohup, a bare
// python3, a ./ path, or any .sh script.
const POSIX_ONLY = /^(?:tmux |zsh -ic|launchctl |nohup |python3 |\.\/)|[\w-]\.sh(?![\w-])/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const MACOS = /^(?:\*\*)?macOS:/;

// The POSIX-only commands a line names: in a fenced block the line itself, elsewhere its backticked spans.
const posixOnlyCommands = (line, fenced) => (fenced ? [line.trim()] : [...line.matchAll(/`([^`\n]+)`/g)].map(([, command]) => command))
  .filter(command => POSIX_ONLY.test(command));
// `threads.sh` wherever a line names it, backticked or not.
const threadsShNames = line => (/(?<![\w-])threads\.sh(?![\w-])/.test(line) ? ["threads.sh"] : []);

// Every POSIX-only command that does not sit under "macOS:". A paragraph or list
// item is under it when its first line starts with `macOS:`; so are its
// continuation lines and any fenced block it introduces. `commandsIn(line, fenced)`
// picks what counts as a command on a line.
function posixOnlyOutsideMacos({ file, lines, audited }, commandsIn = posixOnlyCommands) {
  const problems = [];
  const report = (index, command) => problems.push(`${file}:${index + 1} \`${command}\` is not under "macOS:"`);
  let block = { indent: 0, macos: false };
  let blank = true;
  let fenced = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      if (audited(index) && !block.macos) for (const command of commandsIn(line, true)) report(index, command);
      continue;
    }
    if (!line.trim()) {
      blank = true;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const item = LIST_ITEM.exec(line);
    if (item) block = { indent: item[1].length, macos: MACOS.test(item[2]) };
    else if (headingLevel(line) || (blank && indent <= block.indent)) block = { indent, macos: MACOS.test(line.trim()) };
    blank = false;
    if (!audited(index) || block.macos) continue;
    for (const command of commandsIn(line, false)) report(index, command);
  }
  return problems;
}

test("the macOS rule finds POSIX-only commands outside macOS: and accepts them under it", () => {
  const audit = text => posixOnlyOutsideMacos({ file: "sample.md", lines: text.split("\n"), audited: () => true });
  assert.deepEqual(audit([
    "1. macOS: run `tmux ls`, then `scripts/threads.sh list`.",
    "   Still the same item: `./setup.sh`.",
    "",
    "   ```sh",
    "   nohup ./restart-root-agent.sh &",
    "   ```",
    "2. Windows: run `scripts/ccdm list`.",
    "- **macOS:** `launchctl list`",
    "",
    "macOS: `python3 scripts/x.py` and `zsh -ic \"claude\"`.",
    "",
    "Run `scripts/ccdm start-session <project>` and read `skills/x.md`, `a.sha`, `~/.zshrc`.",
  ].join("\n")), []);
  assert.deepEqual(audit([
    "1. Run `scripts/stop-session.sh <project>`.",
    "2. Windows: `tmux ls`",
    "",
    "A paragraph with `zsh -ic`, `launchctl load x`, `nohup x &`, `python3 x.py` and `./setup.sh`.",
    "",
    "macOS: fine `tmux ls`.",
    "",
    "Not fine again: `install-router-service.sh`.",
    "",
    "```sh",
    "tmux kill-session -t x",
    "```",
    "- macOS: fine",
    "",
    "Outdented paragraph `threads.sh`.",
  ].join("\n")).map(problem => problem.replace(/^sample\.md:(\d+) `(.*)` is not.*$/, "$1 $2")), [
    "1 scripts/stop-session.sh <project>",
    "2 tmux ls",
    "4 zsh -ic", "4 launchctl load x", "4 nohup x &", "4 python3 x.py", "4 ./setup.sh",
    "8 install-router-service.sh",
    "11 tmux kill-session -t x",
    "15 threads.sh",
  ]);
});

test("root's runbook names POSIX-only commands only under macOS:", () => {
  const problems = runbookSources().flatMap(source => posixOnlyOutsideMacos(source));
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
});

// The thread operator doc is not root's runbook, but an operator on Windows follows its thread steps.
const THREAD_OPERATOR_DOC = "docs/thread-supervisor.md";

// A file's front matter holds search phrases, not steps.
function afterFrontMatter({ file, lines, audited }) {
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  return { file, lines, audited: index => index > end && audited(index) };
}

test("threads.sh is named only under macOS:, in root's runbook and the thread operator doc", () => {
  const audit = text => posixOnlyOutsideMacos({ file: "sample.md", lines: text.split("\n"), audited: () => true }, threadsShNames)
    .map(problem => problem.replace(/^sample\.md:(\d+) .*$/, "$1"));
  assert.deepEqual(audit([
    "- macOS: `scripts/threads.sh list`, or plain threads.sh in words.",
    "- Windows: `scripts/ccdm threads list`.",
    "",
    "macOS: run it:",
    "",
    "```sh",
    "scripts/threads.sh list",
    "```",
    "",
    "Other names are not it: `thread-supervisor.py`, `old-threads.sh`, `threads.shell`.",
  ].join("\n")), []);
  assert.deepEqual(audit([
    "Run `scripts/threads.sh list`.",
    "",
    "The control socket used by threads.sh, with no backticks.",
    "",
    "- Windows: `scripts/threads.sh list`",
    "",
    "```sh",
    "./scripts/threads.sh stop x",
    "```",
  ].join("\n")), ["1", "3", "5", "8"]);

  const doc = { file: THREAD_OPERATOR_DOC, lines: fs.readFileSync(THREAD_OPERATOR_DOC, "utf8").split(/\r?\n/), audited: () => true };
  const problems = [...runbookSources(), doc].flatMap(source => posixOnlyOutsideMacos(afterFrontMatter(source), threadsShNames));
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
  // Wherever a step names it, the Windows form stands beside it.
  for (const file of ["AGENTS.md", ".mex/context/architecture.md", ".mex/context/session-management.md",
    ".mex/patterns/operate-thread-supervisor.md", ".mex/patterns/register-project.md", THREAD_OPERATOR_DOC]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /macOS: [^\n]*`scripts\/threads\.sh/, `${file} lost its macOS thread command`);
    assert.match(source, /Windows: [^\n]*`scripts\/ccdm threads/, `${file} has no Windows thread command`);
    assert.doesNotMatch(source, /#241\b/, `${file} still waits for the thread command`);
  }
  // A first message never travels as an argument on Windows.
  for (const file of [".mex/context/session-management.md", ".mex/patterns/operate-thread-supervisor.md", THREAD_OPERATOR_DOC]) {
    assert.match(fs.readFileSync(file, "utf8"), /Windows: [^\n]*--message-stdin[^\n]*--message-file <path>[^\n]*as arguments/,
      `${file} does not say how Windows gives a thread its first message`);
  }
});

// The subcommands a `--help` screen lists.
function listedCommands(...args) {
  const result = spawnSync(PYTHON, [path.join("scripts", "ccdm.py"), ...args, "--help"], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" },
    windowsHide: true,
  });
  assert.equal(result.status, 0, `ccdm ${args.join(" ")} --help failed: ${result.stderr}`);
  const listing = result.stdout.split(/\r?\n/);
  return new Set(listing.slice(listing.findIndex(line => /^commands:/.test(line)) + 1)
    .map(line => /^ {4}([a-z][a-z0-9-]*)(?:\s|$)/.exec(line)?.[1])
    .filter(Boolean));
}

test("every scripts/ccdm command in root's runbook exists, and so does every .sh under macOS:", () => {
  const commands = listedCommands();
  assert.ok(commands.has("start-session") && commands.has("list"), "could not read scripts/ccdm --help");
  const nested = new Map();
  const scripts = new Set(spawnSync("git", ["ls-files", "*.sh"], { encoding: "utf8" }).stdout.split(/\r?\n/)
    .filter(Boolean).map(file => path.posix.basename(file)));
  assert.ok(scripts.has("start-session.sh"), "could not list the tracked .sh scripts");
  const problems = [];
  let named = 0;
  for (const { file, lines, audited } of runbookSources()) {
    for (const [index, line] of lines.entries()) {
      if (!audited(index)) continue;
      for (const [, sub, verb] of line.matchAll(/scripts\/ccdm"?\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/g)) {
        named += 1;
        if (!commands.has(sub)) {
          problems.push(`${file}:${index + 1} scripts/ccdm ${sub} is not in scripts/ccdm --help`);
          continue;
        }
        if (!verb) continue;
        if (!nested.has(sub)) nested.set(sub, listedCommands(sub));
        if (nested.get(sub).size && !nested.get(sub).has(verb)) {
          problems.push(`${file}:${index + 1} scripts/ccdm ${sub} ${verb} is not in scripts/ccdm ${sub} --help`);
        }
      }
      for (const [, script] of line.matchAll(/([\w-]+\.sh)(?![\w-])/g)) {
        if (!scripts.has(script)) problems.push(`${file}:${index + 1} ${script} is not a tracked script`);
      }
    }
  }
  assert.ok(named > 20, `only ${named} scripts/ccdm commands were found in the runbook`);
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
});

test("root-commands.md covers root's commands and restarts root without nohup", () => {
  const source = fs.readFileSync(".mex/patterns/root-commands.md", "utf8");
  for (const phrase of [
    "scripts/ccdm list",
    "scripts/ccdm status",
    "scripts/ccdm start-session <project>",
    "scripts/ccdm start-codex-session <project>",
    "scripts/ccdm stop-session <project>",
    "scripts/ccdm restart-session <project>",
    "scripts/ccdm context report",
    "scripts/ccdm restart-root",
    "scripts/ccdm transcribe \"<path>\"",
    "poll",
    "macOS:",
    "Windows:",
  ]) {
    assert.match(source, new RegExp(escape(phrase)), `root-commands.md is missing "${phrase}"`);
  }
  assert.doesNotMatch(source, /nohup/);
  assert.match(fs.readFileSync(".mex/patterns/INDEX.md", "utf8"), /\[root-commands\.md\]\(root-commands\.md\)/);
  assert.match(fs.readFileSync(".mex/ROUTER.md", "utf8"), /\| .* \| `patterns\/root-commands\.md` \|/);
});

test("the runbook carries the launch, restart, capture and trust rules and marks what Windows still lacks", () => {
  const read = file => fs.readFileSync(file, "utf8");
  const agents = read("AGENTS.md");
  assert.match(agents, /[Ll]aunch sessions only through `scripts\/ccdm`/);
  assert.doesNotMatch(agents, /zsh -ic/);
  assert.match(agents, /`scripts\/ccdm restart-root`[^\n]*detaches itself[^\n]*never use `nohup`/);

  assert.match(read(".mex/patterns/debug-discord-session.md"), /scripts\/ccdm session capture/);
  assert.match(read(".mex/patterns/debug-discord-session.md"), /node scripts\/ccdm-host\.js pids -t <screen_name>/);
  const login = read(".mex/patterns/manage-claude-home-login.md");
  assert.match(login, /scripts\/ccdm session capture ccdm_claude_login --join/);
  assert.doesNotMatch(login, /tmux capture-pane/);
  assert.match(read(".mex/patterns/register-project.md"), /first launch[^\n]*folder-trust dialog[^\n]*#191[^\n]*hooks and MCP servers/);

  // Both services install on Windows now, so neither runbook waits for a later slice.
  for (const [file, service] of Object.entries({
    ".mex/patterns/operate-thread-supervisor.md": "thread-supervisor",
    ".mex/patterns/operate-conversation-reminders.md": "reminders",
  })) {
    assert.doesNotMatch(read(file), /Windows: pending/, `${file} still has a "Windows: pending" line`);
    assert.match(read(file), new RegExp(`Windows: run \`scripts/ccdm install-service ${service}\``), `${file} does not name the Windows install`);
  }
});

test("root's voice entry runs scripts/ccdm transcribe on both OSes and names no temp path", () => {
  const example = fs.readFileSync(ROOT_ENTRIES.file, "utf8").split(/\r?\n/);
  const [start, end] = sectionRange(example, "### Voice Messages");
  const entry = example.slice(start, end).join("\n");
  assert.match(entry, /Run: `scripts\/ccdm transcribe "<path>"`/);
  assert.match(entry, /same on macOS and Windows/);
  assert.match(entry, /exits 3/);
  // No whisper command line of its own, no shared temp directory, nothing pending.
  assert.doesNotMatch(entry, /\/tmp|--output_dir|`whisper |Windows: pending/);
});

test("the Codex home helpers' runbook gives Windows a command and no pending marker", () => {
  for (const [file, helper] of [
    [".mex/patterns/setup-deepseek-codex.md", "setup-codex-deepseek.py"],
    [".mex/patterns/setup-mimo-codex.md", "setup-codex-mimo.py"],
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, new RegExp(`macOS: \`python3 scripts/${escape(helper)} `), `${file} lost its macOS command`);
    assert.match(source, new RegExp(`Windows: \`python scripts/${escape(helper)} [^\\n]*\`node\`[^\\n]*\`PATH\``),
      `${file} has no Windows command that names the node auth command`);
    assert.doesNotMatch(source, /Windows: pending/);
  }
  const setup = fs.readFileSync(".mex/context/setup.md", "utf8");
  assert.match(setup, /Windows: `python scripts\/setup-codex-mimo\.py [^\n]*`python scripts\/setup-codex-deepseek\.py /);
  assert.match(setup, /`scripts\/ccdm transcribe "<audio path>"`/);
  assert.doesNotMatch(setup, /#246/);
});

test("root's usage entry names the script on macOS and scripts/ccdm usage on Windows", () => {
  const example = fs.readFileSync(ROOT_ENTRIES.file, "utf8").split(/\r?\n/);
  const [start, end] = sectionRange(example, "#### 11. ");
  const pattern = fs.readFileSync(".mex/patterns/root-commands.md", "utf8").split(/\r?\n/);
  const [patternStart, patternEnd] = sectionRange(pattern, "### Usage report");
  for (const [name, entry] of [
    [`${ROOT_ENTRIES.file} entry 11`, example.slice(start, end).join("\n")],
    ["root-commands.md \"Usage report\"", pattern.slice(patternStart, patternEnd).join("\n")],
  ]) {
    assert.match(entry, /^\s*- macOS: `scripts\/claude-usage\.sh`$/m, `${name} does not give the macOS command`);
    assert.match(entry, /^\s*- Windows: `scripts\/ccdm usage`$/m, `${name} does not give the Windows command`);
    assert.doesNotMatch(entry, /pending/i, `${name} still carries a pending marker`);
    assert.match(entry, /`~\/\.claude\/\.credentials\.json` on Windows/, `${name} does not say where Windows keeps the login`);
    assert.match(entry, /Could not fetch profile[^\n]*Could not fetch live usage[^\n]*exits 0/, `${name} does not say what a missing or stale login prints`);
    assert.match(entry, /Never refresh or edit the login yourself/, `${name} lost the rule against refreshing the login`);
  }
  assert.match(pattern.slice(0, pattern.indexOf("---", 1)).join("\n"), /^ {2}- "usage"$/m, "root-commands.md has no usage trigger");
});

test("CLAUDE.md and .mex/AGENTS.md stay symlinks to AGENTS.md", () => {
  const listed = spawnSync("git", ["ls-files", "-s", "CLAUDE.md", ".mex/AGENTS.md"], { encoding: "utf8" }).stdout;
  assert.match(listed, /^120000 \S+ 0\tCLAUDE\.md$/m);
  assert.match(listed, /^120000 \S+ 0\t\.mex\/AGENTS\.md$/m);
});

// --- The session skills and the rest of root's template ---------------------
// A session follows skills/restart-self.md and skills/check-context.md word for
// word, on either OS. CLAUDE.md.example is audited here as a whole file.

const RESTART_SKILL = "skills/restart-self.md";
const CONTEXT_SKILL = "skills/check-context.md";
const SESSION_DOCS = [RESTART_SKILL, CONTEXT_SKILL, ROOT_ENTRIES.file];
const wholeFile = file => ({ file, lines: fs.readFileSync(file, "utf8").split(/\r?\n/), audited: () => true });

// The lines inside fenced blocks: the commands a session copies.
function fencedLines(lines) {
  const found = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (fenced && line.trim()) found.push(line.trim());
  }
  return found;
}

// The verbs `scripts/ccdm threads` takes. Its help is a usage text, not a command list.
function threadVerbs() {
  const result = spawnSync(PYTHON, [path.join("scripts", "ccdm.py"), "threads", "--help"], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" },
    windowsHide: true,
  });
  assert.equal(result.status, 0, `ccdm threads --help failed: ${result.stderr}`);
  return new Set([...result.stdout.matchAll(/(?:threads\.sh|ccdm threads) ([a-z|]+)/g)].flatMap(([, verbs]) => verbs.split("|")));
}

test("the restart-self skill restarts each kind of session with its own scripts/ccdm command", () => {
  const source = fs.readFileSync(RESTART_SKILL, "utf8");
  assert.doesNotMatch(source, /nohup|pstree|tmux|DISCORD_STATE_DIR|zsh -ic|launchctl|\.sh\b/i);
  assert.deepEqual(posixOnlyOutsideMacos(wholeFile(RESTART_SKILL)), []);
  // Every command it gives to copy is a scripts/ccdm command, or the line that prints who the session is.
  const commands = fencedLines(source.split(/\r?\n/));
  assert.ok(commands.length >= 4, "the skill lost its commands");
  for (const command of commands) assert.match(command, /^(?:scripts\/ccdm |echo "session=\$CCDM_SESSION_NAME )/, command);

  const section = (from, to) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start + from.length);
    assert.ok(start >= 0 && end > start, `${RESTART_SKILL} lost "${from}" or "${to}"`);
    return source.slice(start, end);
  };
  const project = section("**Project session:**", "**Thread session:**");
  const thread = section("**Thread session:**", "**Root:**");
  const root = section("**Root:**", "\n4. ");
  assert.match(project, /^\s+scripts\/ccdm restart-session <project>$/m);
  assert.match(thread, /^\s+scripts\/ccdm threads restart <project> <thread id>$/m);
  assert.doesNotMatch(thread, /restart-session|restart-root/);
  assert.match(root, /^\s+scripts\/ccdm restart-root$/m);
  assert.match(root, /Windows: root Codex is not supported/);
  assert.doesNotMatch(root, /restart-session|threads restart/);

  // The message goes out before the command: the command ends the session.
  const tell = source.indexOf("**Tell the user you are restarting.**");
  assert.ok(tell >= 0 && tell < source.indexOf("scripts/ccdm restart-session <project>"), "the skill must post before it restarts");
  assert.match(source, /Do not put it in the background and do not wrap it in another command/);
  // A session finds the checkout and itself without a path of its own.
  assert.match(source, /"\$CCDM_REMINDER_PROJECT_ROOT\/scripts\/ccdm" <command>/);
  assert.match(source, /"\$env:CCDM_REMINDER_PROJECT_ROOT\\scripts\\ccdm\.cmd" <command>/);
  assert.match(source, /sends `\/restart` in the thread/);
});

test("the check-context skill reads context.json and never waits on its own session", () => {
  const source = fs.readFileSync(CONTEXT_SKILL, "utf8");
  assert.doesNotMatch(source, /Nickname updated|nohup|pstree|pgrep|tmux|capture-pane|zsh -ic|\.sh\b/i);
  assert.deepEqual(posixOnlyOutsideMacos(wholeFile(CONTEXT_SKILL)), []);
  for (const phrase of [
    "launches/<project>/context.json",
    "launches/<project>/threads/<thread id>/context.json",
    "launches/.root/context.json",
    "`context_pct`",
    "Do not make up a number",
    "after your next message",
  ]) {
    assert.match(source, new RegExp(escape(phrase)), `${CONTEXT_SKILL} is missing "${phrase}"`);
  }
  // The breakdown is typed into the session; nothing waits for it.
  const commands = fencedLines(source.split(/\r?\n/));
  assert.deepEqual(commands.filter(command => command.startsWith("scripts/ccdm")),
    ["scripts/ccdm session send \"$CCDM_SESSION_NAME\" --literal /context --enter"]);
  const waits = source.split(/\r?\n/).filter(line => /session context/.test(line));
  assert.equal(waits.length, 1, "only the rule against it may name `session context`");
  assert.match(waits[0], /^\s*Never run `scripts\/ccdm session context` on your own session\./);
  assert.doesNotMatch(source, /session context[^\n]*CCDM_SESSION_NAME|context report/);
});

test("CLAUDE.md.example names POSIX-only commands only under macOS:, in the whole file", () => {
  const template = wholeFile(ROOT_ENTRIES.file);
  const problems = posixOnlyOutsideMacos(template);
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
  const source = template.lines.join("\n");
  assert.doesNotMatch(source, /zsh -ic|bash -i?c/);
  // `nohup` appears only where root is told never to use it.
  for (const line of template.lines.filter(line => /nohup/.test(line))) assert.match(line, /Never use `nohup`/, line);
  // tmux is named as the session host on macOS, or under macOS:, never as a command for both OSes.
  const tmuxCommands = posixOnlyOutsideMacos(template, (line, fenced) =>
    (fenced ? [line.trim()] : [...line.matchAll(/`([^`\n]+)`/g)].map(([, span]) => span)).filter(span => /^tmux\b/.test(span)));
  assert.deepEqual(tmuxCommands, []);
  for (const phrase of [
    "scripts/ccdm start-session <project>",
    "- macOS: load the agent with `launchctl load",
    "- Windows: install three scheduled tasks, in this order: `scripts/ccdm install-service router`, `scripts/ccdm install-service host`, `scripts/ccdm install-service root-at-logon`",
    "- macOS: `scripts/install-usage-stats-poster.sh`",
    "- Windows: `scripts/ccdm install-service usage-poster`",
    "Launch sessions only through `scripts/ccdm`",
    "- Windows: `scripts/ccdm threads restart <name|link>`.",
  ]) {
    assert.match(source, new RegExp(escape(phrase)), `${ROOT_ENTRIES.file} is missing "${phrase}"`);
  }
});

// Root's command entries, with the usage entry, "Discord Polls" and "Voice
// Messages": the lines from "Commands" up to "Channel Routing Rules". They are
// final. A change that rewrites one on purpose updates this hash with it.
const ROOT_ENTRIES_SHA256 = "c72c7c826bfe7f5ac617a67fe0f256add115422e5a88cb82b769c68682c394cb";

test("root's command, usage and voice entries in CLAUDE.md.example are unchanged", () => {
  const { lines } = wholeFile(ROOT_ENTRIES.file);
  const start = lines.findIndex(line => line.startsWith(ROOT_ENTRIES.from));
  const end = lines.findIndex(line => line.startsWith(ROOT_ENTRIES.to));
  assert.ok(start >= 0 && end > start, `${ROOT_ENTRIES.file} lost one of root's command headings`);
  const entries = lines.slice(start, end);
  for (const heading of ["#### 11. Usage report", "#### 12. Self-restart", "### Discord Polls", "### Voice Messages"]) {
    assert.ok(entries.some(line => line.startsWith(heading)), `"${heading}" is no longer among root's entries`);
  }
  assert.equal(createHash("sha256").update(entries.join("\n")).digest("hex"), ROOT_ENTRIES_SHA256,
    "root's entries changed; they are final, so restore them or update the hash on purpose");
});

test("every scripts/ccdm command in the skills and CLAUDE.md.example exists, with the variables the skills read", () => {
  const commands = listedCommands();
  const nested = new Map([["threads", threadVerbs()]]);
  assert.ok(nested.get("threads").has("restart") && nested.get("threads").has("list"), "could not read the thread verbs");
  const scripts = new Set(spawnSync("git", ["ls-files", "*.sh"], { encoding: "utf8" }).stdout.split(/\r?\n/)
    .filter(Boolean).map(file => path.posix.basename(file)));
  assert.ok(scripts.has("start-session.sh"), "could not list the tracked .sh scripts");
  const problems = [];
  const named = new Set();
  for (const file of SESSION_DOCS) {
    for (const [index, line] of fs.readFileSync(file, "utf8").split(/\r?\n/).entries()) {
      for (const [, sub, verb] of line.matchAll(/scripts[\\/]ccdm(?:\.cmd)?"?\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/g)) {
        named.add(sub);
        if (!commands.has(sub)) {
          problems.push(`${file}:${index + 1} scripts/ccdm ${sub} is not in scripts/ccdm --help`);
          continue;
        }
        if (!verb) continue;
        if (!nested.has(sub)) nested.set(sub, listedCommands(sub));
        if (nested.get(sub).size && !nested.get(sub).has(verb)) {
          problems.push(`${file}:${index + 1} scripts/ccdm ${sub} ${verb} is not a verb of scripts/ccdm ${sub}`);
        }
      }
      for (const [, script] of line.matchAll(/([\w-]+\.sh)(?![\w-])/g)) {
        if (!scripts.has(script)) problems.push(`${file}:${index + 1} ${script} is not a tracked script`);
      }
    }
  }
  for (const sub of ["restart-session", "restart-root", "threads", "session", "install-service", "usage", "transcribe"]) {
    assert.ok(named.has(sub), `scripts/ccdm ${sub} was not found in the skills or the template`);
  }
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);

  // Each variable a skill tells a session to read is one the launchers give a session.
  const launchers = ["scripts/ccdmlib/cli/start_session.py", "scripts/ccdmlib/cli/start_thread_session.py",
    "scripts/ccdmlib/cli/start_codex_session.py", "scripts/ccdmlib/cli/_launch.py", "scripts/ccdmlib/platform/session_host.py",
    "scripts/ccdmlib/platform/paths.py", "scripts/codex-bridge.js"].map(file => fs.readFileSync(file, "utf8")).join("\n");
  for (const file of [RESTART_SKILL, CONTEXT_SKILL]) {
    const variables = new Set(fs.readFileSync(file, "utf8").match(/CCDM_[A-Z_]+/g));
    assert.ok(variables.has("CCDM_SESSION_NAME"), `${file} does not read CCDM_SESSION_NAME`);
    for (const variable of variables) {
      assert.ok(launchers.includes(variable), `${file} reads ${variable}, which no launcher sets`);
    }
  }
});

test("the thread operator doc and the e2e README name the launcher and shims as the code runs them", () => {
  const shims = line => [...line.matchAll(/(?<![\w-])(?:start-thread-session|start-session|stop-session|send-claude-command)\.sh(?![\w-])/g)]
    .map(([name]) => name);
  const doc = wholeFile(THREAD_OPERATOR_DOC);
  const problems = posixOnlyOutsideMacos(afterFrontMatter(doc), shims);
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
  const source = doc.lines.join("\n");
  for (const phrase of [
    "`scripts/ccdm start-thread-session <project> <thread_id> --provider …`",
    "`scripts/ccdm stop-session <project> --threads`",
    "`scripts/ccdm send-claude-command`",
  ]) {
    assert.match(source, new RegExp(escape(phrase)), `${THREAD_OPERATOR_DOC} is missing "${phrase}"`);
  }
  assert.match(readme, /`thread-operations\.test\.js`[^\n]*`scripts\/threads\.sh` on macOS and Linux, `scripts\/ccdm threads` on Windows/);
});

// --- The README's Windows section --------------------------------------------
// A Windows user sets CCDM up from this section alone, so it is checked against
// the commands the code registers.

const WINDOWS_SECTION = "## Running on Windows";

function windowsSection() {
  const lines = operatorReadme.split(/\r?\n/);
  const range = sectionRange(lines, WINDOWS_SECTION);
  assert.ok(range, `README.md has no "${WINDOWS_SECTION}" section`);
  return lines.slice(range[0], range[1]);
}

// The service names `install-service` knows, as the command itself lists them
// when it refuses an unknown one. Nothing is installed, read or changed.
function knownServices() {
  const result = spawnSync(PYTHON, [path.join("scripts", "ccdm.py"), "service-status", "no-such-service"], {
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONUTF8: "1" },
    windowsHide: true,
  });
  assert.equal(result.status, 2, `ccdm service-status no-such-service should refuse: ${result.stderr}`);
  const listed = /known: ([a-z, -]+)/.exec(result.stderr);
  assert.ok(listed, `could not read the service names: ${result.stderr}`);
  return new Set(listed[1].split(",").map(name => name.trim()).filter(Boolean));
}

test("the README has a Windows section that covers setup, services, guests, sleep, limits and two machines", () => {
  const lines = windowsSection();
  const section = lines.join("\n");
  for (const heading of [
    "### Step 1: Install the tools",
    "### Step 2: Turn on symlinks, then clone",
    "### Step 3: Create the Windows bot and its category",
    "### Step 4: Run setup",
    "### Step 5: Install the services",
    "### Step 6: Start root and register a project",
    "### Everyday commands",
    "### Guests on Windows",
    "### Context % on Windows",
    "### Preventing sleep on Windows",
    "### Auto-start on Windows",
    "### Troubleshooting on Windows",
    "### Limitations on Windows",
    "### Multiple machines",
  ]) {
    assert.ok(lines.includes(heading), `the Windows section has no "${heading}"`);
  }
  for (const phrase of [
    // Prerequisites and the clone.
    "Node.js 22.5", "Python 3.11", "py -3", "Git for Windows", "ffmpeg", "Windows Terminal", "openai-whisper",
    "Developer Mode", "git config --global core.symlinks true", "OneDrive", "npm ci",
    // Setup and the bot.
    "pwsh -NoProfile -File setup.ps1", "Win+V", "Message Content Intent", "View Audit Log", "Manage Permissions",
    "deny View Channel", "CLAUDE.local.md",
    // Services.
    "scripts\\ccdm install-service router", "scripts\\ccdm install-service host",
    "scripts\\ccdm install-service thread-supervisor", "scripts\\ccdm install-service root-at-logon",
    "scripts\\ccdm install-service reminders", "scripts\\ccdm install-service usage-poster", "--collect-only",
    "never posts to Discord", "scripts\\ccdm service-status", "scripts\\ccdm uninstall-service",
    "records its environment", "CLAUDE_CONFIG_DIR", "CCDM_CODEX_PATH", "scripts\\ccdm restart-root",
    // Everyday commands.
    "scripts\\ccdm threads", "--message-stdin", "--message-file <path>", "scripts\\ccdm usage",
    "scripts\\ccdm transcribe", "code 3",
    // Guests.
    "guest_mode", "\"roles\"", "\"none\"", "\"member-overwrites\"", "what `@everyone` sees",
    "Revoke every guest before you change `guest_mode`",
    // Context, sleep and auto-start.
    "statusLine", "--chain", "AC power", "On battery", "only while you are signed in",
    "Use my sign-in info to automatically finish setting up after an update", "one to three minutes",
    // Troubleshooting and limits.
    "node scripts\\router.js status", "crashloop", "<name>.disabled", "preflight", "<stateRoot>\\services\\<name>.log",
    "scripts\\ccdm install-service host --force", "--resume <id>", "Signing out of Windows stops",
    "Root on Windows is Claude only", "-win",
  ]) {
    assert.ok(section.includes(phrase), `the Windows section is missing "${phrase}"`);
  }
  // Git must be able to make symlinks before the clone is made.
  const symlinks = section.indexOf("git config --global core.symlinks true");
  const developerMode = section.indexOf("Turn on Developer Mode");
  const clone = section.indexOf("git clone ");
  assert.ok(developerMode >= 0 && developerMode < clone, "Developer Mode must come before the clone");
  assert.ok(symlinks >= 0 && symlinks < clone, "the symlink setting must come before the clone");
  assert.ok(clone < section.indexOf("-File setup.ps1"), "the clone must come before setup");
  // The macOS Quick Start is not for Windows: a line above it points at the section.
  assert.match(operatorReadme.slice(0, operatorReadme.indexOf("## Prerequisites")), /\[Running on Windows\]\(#running-on-windows\)/);
});

test("every scripts\\ccdm command in the README's Windows section is registered", () => {
  const commands = listedCommands();
  const services = knownServices();
  const nested = new Map([["threads", threadVerbs()]]);
  const takesService = new Set(["install-service", "uninstall-service", "service-status"]);
  assert.ok(commands.has("install-service") && services.has("router"), "could not read the commands or the services");
  const problems = [];
  const named = new Set();
  for (const [index, line] of windowsSection().entries()) {
    for (const [, sub, word] of line.matchAll(/scripts[\\/]ccdm(?:\.cmd)?\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/g)) {
      named.add(sub);
      if (!commands.has(sub)) {
        problems.push(`Windows section line ${index + 1}: scripts\\ccdm ${sub} is not in scripts/ccdm --help`);
        continue;
      }
      if (!word) continue;
      if (takesService.has(sub)) {
        if (!services.has(word)) problems.push(`Windows section line ${index + 1}: ${word} is not a service of scripts\\ccdm ${sub}`);
        continue;
      }
      if (!nested.has(sub)) nested.set(sub, listedCommands(sub));
      if (nested.get(sub).size && !nested.get(sub).has(word)) {
        problems.push(`Windows section line ${index + 1}: scripts\\ccdm ${sub} ${word} is not a verb of scripts/ccdm ${sub}`);
      }
    }
  }
  for (const sub of ["install-service", "uninstall-service", "service-status", "restart-root", "start-session",
    "start-codex-session", "stop-session", "restart-session", "list", "status", "attach", "threads", "reminders", "usage",
    "transcribe"]) {
    assert.ok(named.has(sub), `the Windows section never names scripts\\ccdm ${sub}`);
  }
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
  // Every service the section installs, and every thread verb it uses, is one the code knows.
  for (const service of ["router", "host", "thread-supervisor", "root-at-logon", "reminders", "usage-poster"]) {
    assert.ok(services.has(service), `scripts/ccdm does not know the service ${service}`);
  }
  for (const verb of ["list", "create", "stop", "restart", "close"]) {
    assert.ok(nested.get("threads").has(verb), `scripts/ccdm threads has no ${verb}`);
  }
});

test("the README's Windows section never offers server-wide Manage Roles and documents the three guest modes", () => {
  const lines = windowsSection();
  const naming = lines.filter(line => /Manage Roles/.test(line));
  assert.ok(naming.length > 0, "the Windows section must say that the bot never gets Manage Roles");
  for (const line of naming) assert.match(line, /\bnever\b/i, `this line offers Manage Roles: ${line}`);
  const table = lines.filter(line => /^\| /.test(line)).join("\n");
  for (const mode of ["\"roles\"", "\"none\"", "\"member-overwrites\""]) {
    assert.ok(table.includes(`\`${mode}\``), `the guest mode table has no row for ${mode}`);
  }
  const section = lines.join("\n");
  assert.match(section, /`"roles"`[^\n]*never used on Windows/);
  assert.match(section, /`"none"`[^\n]*Answer `none` at the setup prompt/);
  assert.match(section, /Setup offers `"member-overwrites"` by default/);
  assert.match(section, /Manage Permissions on its own category, and never Manage Roles for the whole server/);
  assert.match(section, /After setup, check it on your own server with one invite/);
  assert.doesNotMatch(section, /Keep `"none"` until/);
});

test("the README's Windows section holds no local path, account name, ID or token, and one command per line", () => {
  const lines = windowsSection();
  for (const [index, line] of lines.entries()) {
    const where = `Windows section line ${index + 1}: ${line}`;
    assert.doesNotMatch(line, /[A-Za-z]:[\\/]Users[\\/]|\/c\/Users\/|\/(?:home|Users)\/[A-Za-z]/, where);
    assert.doesNotMatch(line, /\b\d{17,20}\b/, where);
    assert.doesNotMatch(line, /[\w-]{24,}\.[\w-]{6}\.[\w-]{27,}|DISCORD_BOT_TOKEN=\S/, where);
  }
  for (const command of fencedLines(lines)) {
    assert.doesNotMatch(command, /&&|;\s*\S|\|\s*\S/, `more than one command on a line: ${command}`);
  }
});

test("the README's Multiple machines part states the mention and resume limits", () => {
  const lines = windowsSection();
  const [start, end] = sectionRange(lines, "### Multiple machines");
  const part = lines.slice(start, end).join("\n");
  for (const phrase of [
    "Each machine has its own bot",
    "Windows project names end in `-win`",
    "Each machine's Router answers only in its own root channel and project channels",
    "`--resume` works only on that machine",
    "Only the Mac posts the usage report",
  ]) {
    assert.ok(part.includes(phrase), `"Multiple machines" is missing "${phrase}"`);
  }
});

test("the README describes the two skills as they work now and installs them on both OSes", () => {
  const lines = operatorReadme.split(/\r?\n/);
  const [start, end] = sectionRange(lines, "## Global Skills");
  const skills = lines.slice(start, end).join("\n");
  assert.doesNotMatch(skills, /tmux|nohup/);
  assert.match(skills, /`\/restart-self`[^\n]*`restart-session`[^\n]*`threads restart`[^\n]*`restart-root`/);
  assert.match(skills, /`\/check-context`[^\n]*`context\.json`/);
  assert.ok(skills.includes("cp skills/*.md ~/.claude/commands/"), "the macOS install line is gone");
  assert.ok(skills.includes("Copy-Item skills\\*.md \"$HOME\\.claude\\commands\\\""), "there is no Windows install line");
  assert.match(skills, /`CLAUDE_CONFIG_DIR`[^\n]*`commands` folder/);
});

test("the macOS sections of the README are still there", () => {
  const lines = operatorReadme.split(/\r?\n/);
  for (const heading of ["## Prerequisites", "## Quick Start", "## Manual Setup", "## Creating the root bot", "## The Router",
    "## Preventing Sleep", "## Auto-Start on Reboot (macOS)", "## Troubleshooting", "## Limitations"]) {
    assert.ok(lines.includes(heading), `README.md lost "${heading}"`);
  }
  for (const phrase of ["./setup.sh", "scripts/install-router-service.sh", "./restart-root-agent.sh", "brew install tmux",
    "launchctl load ~/Library/LaunchAgents/com.claude.root-agent.plist"]) {
    assert.ok(operatorReadme.includes(phrase), `README.md lost "${phrase}"`);
  }
});
