import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

  // Each line that waits for a later slice names its issue.
  for (const [file, issues] of Object.entries({
    ".mex/patterns/operate-thread-supervisor.md": ["#249"],
    ".mex/patterns/operate-conversation-reminders.md": ["#242", "#249"],
  })) {
    for (const issue of issues) {
      assert.match(read(file), new RegExp(`Windows: pending[^\\n]*${issue}\\b`), `${file} has no "Windows: pending" line for ${issue}`);
    }
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
