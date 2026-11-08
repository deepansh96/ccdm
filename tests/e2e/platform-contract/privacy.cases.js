import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WIN = process.platform === "win32";
const BUILTIN_USERS = "S-1-5-32-545";
const ICACLS = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
const blockers = { node: "privacy.privateDirBlockers", python: "private_fs.blockers" };
const isPrivate = { node: "privacy.isPrivateFile", python: "private_fs.is_private" };
const fromSddl = { node: "privacy.blockersFromSddl", python: "private_fs.blockers_from_sddl" };
const ensure = { node: "privacy.ensurePrivateDirSync", python: "private_fs.ensure_private_dir" };

function icacls(...args) {
  const result = spawnSync(ICACLS, args, { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `icacls ${args.join(" ")}: ${result.stdout}${result.stderr}`);
}

const dirIn = (ctx, name) => path.join(ctx.work, name);
const fixCommands = lines => lines.map(line => {
  const at = line.indexOf("; run icacls ");
  assert.ok(at >= 0, `no fix command in: ${line}`);
  return line.slice(at + "; run ".length);
});

function runInCmd(line) {
  const result = spawnSync(line, { shell: "cmd.exe", encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `cmd: ${line}: ${result.stdout}${result.stderr}`);
}

function runInPowerShell(line) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", line], {
    encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0, `powershell: ${line}: ${result.stdout}${result.stderr}`);
}

// A directory private to this user, made by Node (the Python cases are compared to it).
const privateDir = async (ctx, name = "private") => {
  const dir = dirIn(ctx, name);
  await ctx.node("privacy.ensurePrivateDirSync", dir);
  return dir;
};

const inheritedDir = ctx => {
  const dir = dirIn(ctx, "inherited");
  fs.mkdirSync(dir);
  return dir;
};

async function foreignEntryDir(ctx) {
  const dir = await privateDir(ctx);
  icacls(dir, "/grant", `*${BUILTIN_USERS}:(OI)(CI)R`);
  return dir;
}

const me = ctx => ctx.node("privacy.currentUserSid");
const foreignOwner = "S-1-5-21-1000000000-1000000001-1000000002-1234";

// Each row: name, SDDL built from this user's SID, the problem words expected per line.
const sddlRows = [
  ["a protected user-only DACL", sid => `O:${sid}D:PAI(A;OICI;FA;;;${sid})`, []],
  ["SYSTEM beside the user", sid => `O:${sid}D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)`, []],
  ["a foreign owner", sid => `O:${foreignOwner}D:P(A;OICI;FA;;;${sid})`, [/is owned by S-1-5-21-1000000000/]],
  ["an alias owner", sid => `O:BAD:P(A;OICI;FA;;;${sid})`, [/is owned by S-1-5-32-544/]],
  ["inheritance on", sid => `O:${sid}D:AI(A;OICI;FA;;;${sid})`, [/inherits permissions/]],
  ["an explicit foreign entry", sid => `O:${sid}D:P(A;OICI;FA;;;${sid})(A;;FR;;;BU)`, [/gives access to S-1-5-32-545/]],
  ["a foreign deny entry", sid => `O:${sid}D:P(D;;FA;;;WD)(A;OICI;FA;;;${sid})`, [/deny entry for S-1-1-0/]],
  ["the user without (OI)(CI)", sid => `O:${sid}D:P(A;;FA;;;${sid})`, [/does not give this user full control/]],
  ["the user with less than full control", sid => `O:${sid}D:P(A;OICI;FR;;;${sid})`, [/does not give this user full control/]],
  ["a NULL DACL", sid => `O:${sid}D:NO_ACCESS_CONTROL`, [/no access control/]],
  ["an empty protected DACL", sid => `O:${sid}D:P`, [/does not give this user full control/]],
  ["an inherited foreign entry is left to the inheritance fix",
    sid => `O:${sid}D:AI(A;OICIID;FA;;;BU)(A;OICIID;FA;;;${sid})`, [/inherits permissions/]],
];

const windowsCases = [
  {
    name: "a directory made private passes in both languages",
    ...blockers,
    setup: privateDir,
    args: (ctx, dir) => [dir],
    value: [],
  },
  {
    name: "ensure creates a missing directory that passes the other language's check",
    ...ensure,
    args: ctx => [dirIn(ctx, "made/by/ensure")],
    check: async (outcomes, ctx) => {
      const dir = dirIn(ctx, "made/by/ensure");
      assert.deepEqual(await ctx.node("privacy.privateDirBlockers", dir), []);
      assert.deepEqual(await ctx.py("private_fs.blockers", dir), []);
    },
  },
  {
    name: "ensure is idempotent on a private directory and repairs an inherited one",
    ...ensure,
    setup: ctx => inheritedDir(ctx),
    args: (ctx, dir) => [dir],
    check: async (outcomes, ctx, dir) => {
      assert.deepEqual(await ctx.node("privacy.privateDirBlockers", dir), []);
    },
  },
  {
    name: "a directory with inheritance on blocks with its fix line",
    ...blockers,
    setup: inheritedDir,
    args: (ctx, dir) => [dir],
    check: async ({ node, python }, ctx, dir) => {
      const sid = await me(ctx);
      assert.deepEqual(node.value, [
        `Private directory ${dir} inherits permissions from its parent; run icacls "${dir}" /inheritance:r /grant:r "*${sid}:(OI)(CI)F"`,
      ]);
      assert.deepEqual(python.value, node.value);
    },
  },
  {
    name: "an explicit foreign entry blocks with its fix line",
    ...blockers,
    setup: foreignEntryDir,
    args: (ctx, dir) => [dir],
    check: async ({ node, python }, ctx, dir) => {
      assert.deepEqual(node.value, [
        `Private directory ${dir} gives access to ${BUILTIN_USERS}; run icacls "${dir}" /remove:g *${BUILTIN_USERS}`,
      ]);
      assert.deepEqual(python.value, node.value);
    },
  },
  {
    name: "a directory really owned by another SID blocks, read-only",
    ...blockers,
    // The Windows directory is only read here, never changed.
    args: () => [process.env.SystemRoot],
    check: async ({ node, python }) => {
      assert.match(node.value[0], /is owned by S-1-5-/);
      assert.match(node.value[0], /\/setowner \*S-1-5-21-/);
      assert.deepEqual(python.value, node.value);
    },
  },
  ...sddlRows.map(([label, build, patterns]) => ({
    name: `the SDDL rule: ${label}`,
    ...fromSddl,
    setup: me,
    args: (ctx, sid) => ["X:\\state", build(sid), sid],
    check: async ({ node, python }) => {
      assert.equal(node.value.length, patterns.length, node.value.join("\n"));
      patterns.forEach((pattern, index) => assert.match(node.value[index], pattern));
      assert.deepEqual(python.value, node.value);
    },
  })),
  {
    name: "the fix for a foreign owner puts the owner first and sets it to this user",
    ...fromSddl,
    setup: me,
    args: (ctx, sid) => ["X:\\state", `O:${foreignOwner}D:AI(A;OICI;FA;;;${sid})(A;;FR;;;BU)`, sid],
    check: async ({ node, python }, ctx, sid) => {
      assert.deepEqual(fixCommands(node.value), [
        `icacls "X:\\state" /setowner *${sid}`,
        `icacls "X:\\state" /inheritance:r /grant:r "*${sid}:(OI)(CI)F"`,
        `icacls "X:\\state" /remove:g *${BUILTIN_USERS}`,
      ]);
      assert.deepEqual(python.value, node.value);
    },
  },
  {
    name: "the printed fix lines, run in order in cmd, make the directory private",
    ...blockers,
    setup: async ctx => {
      const dir = inheritedDir(ctx);
      icacls(dir, "/grant", `*${BUILTIN_USERS}:(OI)(CI)R`);
      return dir;
    },
    args: (ctx, dir) => [dir],
    check: async ({ node }, ctx, dir) => {
      assert.ok(node.value.length >= 2, node.value.join("\n"));
      for (const line of fixCommands(node.value)) runInCmd(line);
      assert.deepEqual(await ctx.node("privacy.privateDirBlockers", dir), []);
      assert.deepEqual(await ctx.py("private_fs.blockers", dir), []);
    },
  },
  {
    name: "the printed fix lines also work in PowerShell, whose parser eats unquoted parentheses",
    ...blockers,
    setup: async ctx => {
      const dir = path.join(ctx.work, "with space");
      fs.mkdirSync(dir);
      icacls(dir, "/grant", `*${BUILTIN_USERS}:(OI)(CI)R`);
      return dir;
    },
    args: (ctx, dir) => [dir],
    check: async ({ node }, ctx, dir) => {
      for (const line of fixCommands(node.value)) runInPowerShell(line);
      assert.deepEqual(await ctx.node("privacy.privateDirBlockers", dir), []);
    },
  },
  {
    name: "a file in a private directory is private",
    ...isPrivate,
    setup: async ctx => {
      const file = path.join(await privateDir(ctx), "state.db");
      fs.writeFileSync(file, "x");
      return file;
    },
    args: (ctx, file) => [file],
    value: true,
  },
  {
    name: "a file with its own foreign entry in a private directory is not private",
    ...isPrivate,
    setup: async ctx => {
      const file = path.join(await privateDir(ctx), "state.db");
      fs.writeFileSync(file, "x");
      icacls(file, "/grant", `*${BUILTIN_USERS}:R`);
      return file;
    },
    args: (ctx, file) => [file],
    value: false,
  },
  {
    name: "a file in a directory that inherits is not private",
    ...isPrivate,
    setup: ctx => {
      const file = path.join(inheritedDir(ctx), "state.db");
      fs.writeFileSync(file, "x");
      return file;
    },
    args: (ctx, file) => [file],
    value: false,
  },
  {
    name: "the check is not cached: a file stops being private once an entry appears",
    node: "privacy.isPrivateFile",
    setup: async ctx => {
      const file = path.join(await privateDir(ctx), "state.db");
      fs.writeFileSync(file, "x");
      return file;
    },
    args: (ctx, file) => [file],
    value: true,
    check: async (outcomes, ctx, file) => {
      const twice = `const p = require(${JSON.stringify(path.join(ctx.root, "scripts/platform/privacy.js"))});`
        + `const before = p.isPrivateFile(process.argv[1]);`
        + `require("node:child_process").spawnSync(${JSON.stringify(ICACLS)}, [process.argv[1], "/grant", "*${BUILTIN_USERS}:R"]);`
        + `console.log(JSON.stringify([before, p.isPrivateFile(process.argv[1])]));`;
      const run = await ctx.nodeScript(twice, [file]);
      assert.deepEqual(JSON.parse(run.stdout), [true, false], run.stderr);
    },
  },
  {
    name: "a file written with write_private in a private directory is private to both",
    python: "private_fs.write_private",
    setup: async ctx => path.join(await privateDir(ctx), "secret.key"),
    args: (ctx, file) => [file, "value\n"],
    check: async (outcomes, ctx, file) => {
      assert.equal(fs.readFileSync(file, "utf8"), "value\n");
      assert.equal(await ctx.node("privacy.isPrivateFile", file), true);
      assert.equal(await ctx.py("private_fs.is_private", file), true);
    },
  },
  {
    name: "the temp directory is private under the state root",
    node: "privacy.privateTmpDir",
    env: ctx => ({ CCDM_STATE_ROOT: path.join(ctx.dir, "root") }),
    args: ["session-"],
    check: async ({ node }, ctx) => {
      const tmp = path.join(ctx.dir, "root", "tmp");
      assert.equal(path.dirname(node.value), tmp);
      assert.match(path.basename(node.value), /^session-/);
      assert.deepEqual(await ctx.node("privacy.privateDirBlockers", tmp), []);
      assert.deepEqual(await ctx.node("privacy.privateDirBlockers", node.value), []);
    },
  },
];

const posixCases = [
  {
    name: "a 0700 directory has no blockers",
    only: "posix",
    ...blockers,
    setup: ctx => {
      const dir = dirIn(ctx, "private");
      fs.mkdirSync(dir, { mode: 0o700 });
      return dir;
    },
    args: (ctx, dir) => [dir],
    value: [],
  },
  {
    name: "a 0755 directory blocks with the chmod text",
    only: "posix",
    ...blockers,
    setup: ctx => {
      const dir = dirIn(ctx, "open");
      fs.mkdirSync(dir);
      fs.chmodSync(dir, 0o755);
      return dir;
    },
    args: (ctx, dir) => [dir],
    value: (ctx, dir) => [`Private directory ${dir} has mode 0755; run chmod 700 ${dir}`],
  },
  {
    name: "ensure leaves a 0700 directory",
    only: "posix",
    ...ensure,
    args: ctx => [dirIn(ctx, "made/by/ensure")],
    check: async (outcomes, ctx) => {
      assert.equal(fs.statSync(dirIn(ctx, "made/by/ensure")).mode & 0o777, 0o700);
    },
  },
  {
    name: "a 0600 file is private",
    only: "posix",
    ...isPrivate,
    setup: ctx => {
      const file = dirIn(ctx, "a");
      fs.writeFileSync(file, "x", { mode: 0o600 });
      return file;
    },
    args: (ctx, file) => [file],
    value: true,
  },
  {
    name: "a 0644 file is not private",
    only: "posix",
    ...isPrivate,
    setup: ctx => {
      const file = dirIn(ctx, "a");
      fs.writeFileSync(file, "x");
      fs.chmodSync(file, 0o644);
      return file;
    },
    args: (ctx, file) => [file],
    value: false,
  },
  {
    name: "write_private leaves a 0600 file",
    only: "posix",
    python: "private_fs.write_private",
    args: ctx => [dirIn(ctx, "secret.key"), "value\n"],
    check: async (outcomes, ctx) => {
      assert.equal(fs.statSync(dirIn(ctx, "secret.key")).mode & 0o777, 0o600);
    },
  },
];

const common = [
  {
    name: "a missing directory has no blockers",
    ...blockers,
    args: ctx => [dirIn(ctx, "missing")],
    value: [],
  },
  {
    name: "a plain file where a directory belongs is reported",
    ...blockers,
    setup: ctx => {
      const file = dirIn(ctx, "file");
      fs.writeFileSync(file, "x");
      return file;
    },
    args: (ctx, file) => [file],
    value: (ctx, file) => [`Private directory ${file} is not a directory; move it aside`],
  },
  {
    name: "checking a missing file throws, like stat",
    ...isPrivate,
    args: ctx => [dirIn(ctx, "missing")],
    throws: ["ENOENT"],
  },
  {
    name: "the state-path defaults go through the state root",
    node: "paths.stateRoot",
    check: async (outcomes, ctx) => {
      const scripts = path.join(ctx.root, "scripts");
      const moved = [
        "ccdm-channel-server.js", "claude-reminder-hook.js", "codex-bridge.js", "conversation-reminder-adapter.js",
        "conversation-reminder-observer.js", "conversation-resolver.js", "router/paths.js", "router/retire-pool.js",
        "conversation-reminder-events.py", "conversation-reminder-service.py", "thread_supervisor/paths.py",
      ];
      for (const name of moved) {
        const source = fs.readFileSync(path.join(scripts, name), "utf8");
        assert.doesNotMatch(source, /\.local[/"',\s]+state/, name);
        assert.match(source, name.endsWith(".py") ? /state_root\(\)/ : /stateRoot\(\)/, name);
      }
      const home = ctx.home;
      const script = `const r=require(${JSON.stringify(path.join(scripts, "router/paths.js"))});console.log(r.stateDir())`;
      const defaulted = await ctx.nodeScript(script);
      assert.equal(defaulted.stdout.trim(), path.join(home, ".local", "state", "ccdm", "router"), defaulted.stderr);
      const rerooted = await ctx.nodeScript(script, [], { env: { CCDM_STATE_ROOT: path.join(ctx.dir, "other") } });
      assert.equal(rerooted.stdout.trim(), path.join(ctx.dir, "other", "router"), rerooted.stderr);
      const pythonScript = "from thread_supervisor import paths; print(paths.default_state_dir()); print(paths.router_state_dir())";
      const python = await ctx.pythonScript(pythonScript, [], { env: { PYTHONPATH: scripts } });
      assert.deepEqual(python.stdout.trim().split(/\r?\n/), [
        path.join(home, ".local", "state", "ccdm", "thread-supervisor"),
        path.join(home, ".local", "state", "ccdm", "router"),
      ], python.stderr);
    },
  },
  {
    name: "no test file asserts raw permission bits",
    node: "paths.stateRoot",
    check: async (outcomes, ctx) => {
      const e2e = path.join(ctx.root, "tests", "e2e");
      const raw = /\.mode\s*&\s*0o777/;
      for (const name of fs.readdirSync(e2e).filter(file => file.endsWith(".test.js"))) {
        // live-smoke copies a checkout, mode included; it asserts nothing about it.
        if (name === "live-smoke.test.js") continue;
        assert.doesNotMatch(fs.readFileSync(path.join(e2e, name), "utf8"), raw, name);
      }
    },
  },
];

export default [...common, ...posixCases, ...(WIN ? windowsCases : [])];
