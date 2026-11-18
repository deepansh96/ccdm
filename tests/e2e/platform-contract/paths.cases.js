import path from "node:path";

const WIN = process.platform === "win32";
const fromHome = (...parts) => ctx => path.join(ctx.home, ...parts);
const stateRoot = { node: "paths.stateRoot", python: "paths.state_root" };
const expandHome = { node: "paths.expandHome", python: "paths.expand_home" };
const samePath = { node: "paths.samePath", python: "paths.same_path" };
const isAbs = { python: "paths.is_abs" };

const expansions = [
  ["~", fromHome()],
  ["~/x", fromHome("x")],
  ["~/a/b", fromHome("a", "b")],
  ["~/a/../b", fromHome("b")],
  ["~/a//b", fromHome("a", "b")],
  ["~/", fromHome()],
  ["~/x/", ctx => path.join(ctx.home, "x") + path.sep],
  ["~\\x", WIN ? fromHome("x") : "~\\x"],
  ["~other/x", "~other/x"],
  ["a/~/x", "a/~/x"],
  ["/abs/x", "/abs/x"],
  ["", ""],
  [null, null],
];

const comparisons = [
  ["identical paths", ctx => [path.join(ctx.work, "a"), path.join(ctx.work, "a")], true],
  ["relative against absolute", ctx => ["a", path.join(ctx.work, "a")], true],
  ["a dot-dot segment", ctx => [path.join(ctx.work, "x", "..", "a"), path.join(ctx.work, "a")], true],
  ["a trailing separator", ctx => [path.join(ctx.work, "a") + path.sep, path.join(ctx.work, "a")], true],
  ["different paths", ctx => [path.join(ctx.work, "a"), path.join(ctx.work, "b")], false],
  ["different case", ctx => [path.join(ctx.work, "Name"), path.join(ctx.work, "name")], WIN],
  ...(WIN ? [] : [["a two-slash root", () => ["//abs/x", "/abs/x"], true]]),
];

const absolutes = {
  win32: [
    ["\\x", false], ["C:x", false], ["C:", false], ["x", false], ["", false], ["\\\\host", false],
    ["C:\\x", true], ["C:/x", true], ["\\\\host\\share\\x", true], ["\\\\host\\share", true], ["//host/share/x", true],
  ],
  posix: [["/x", true], ["x", false], ["", false], ["C:\\x", false]],
};

export default [
  {
    name: "state root defaults under the home directory",
    ...stateRoot,
    value: fromHome(".local", "state", "ccdm"),
  },
  {
    name: "state root honours CCDM_STATE_ROOT",
    ...stateRoot,
    env: ctx => ({ CCDM_STATE_ROOT: path.join(ctx.dir, "custom", "root") }),
    value: ctx => path.join(ctx.dir, "custom", "root"),
  },
  {
    name: "state root normalizes CCDM_STATE_ROOT the same way",
    ...stateRoot,
    env: ctx => ({ CCDM_STATE_ROOT: `${ctx.dir}/custom/../root/` }),
    value: ctx => path.join(ctx.dir, "root"),
  },
  {
    name: "an empty CCDM_STATE_ROOT counts as unset",
    ...stateRoot,
    env: { CCDM_STATE_ROOT: "" },
    value: fromHome(".local", "state", "ccdm"),
  },
  ...expansions.map(([input, expected]) => ({
    name: `expandHome of ${JSON.stringify(input)}`,
    ...expandHome,
    args: [input],
    value: expected,
  })),
  ...comparisons.map(([label, args, expected]) => ({
    name: `samePath with ${label}`,
    ...samePath,
    args,
    value: expected,
  })),
  ...Object.entries(absolutes).flatMap(([only, table]) => table.map(([input, expected]) => ({
    name: `is_abs of ${JSON.stringify(input)} on ${only}`,
    only,
    ...isAbs,
    args: [input],
    value: expected,
  }))),
];
