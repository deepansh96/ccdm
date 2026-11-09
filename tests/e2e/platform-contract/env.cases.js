// cleanEnv and clean_env keep and drop exactly the same names, on every OS.
import assert from "node:assert/strict";

const clean = { node: "env.cleanEnv", python: "env.clean_env" };

const DROPPED = {
  CLAUDE_CONFIG_DIR: "a", CLAUDECODE: "a", claude_lowercase: "a",
  ANTHROPIC_API_KEY: "a", AnthropicMixed: "a",
  MCP_SERVER_TOKEN: "a", mcp_lower_token: "a",
  CCDM_ROUTER_KEY_FILE: "a", CCDM_STATE_ROOT: "a", ccdm_lower: "a",
};
const KEPT = { KEEP_ME: "yes", NOTCLAUDE_VALUE: "yes", MCPSERVER: "yes", PATHEXT_P31A: "yes" };
const names = Object.keys({ ...DROPPED, ...KEPT });

// The drivers' full environments differ in case and content; compare only ours.
function surviving(value) {
  const upperKeys = new Map(Object.entries(value).map(([key, val]) => [key.toUpperCase(), val]));
  return names.filter(name => upperKeys.has(name.toUpperCase())).map(name => name.toUpperCase()).sort();
}

const expected = Object.keys(KEPT).map(name => name.toUpperCase()).sort();

export default [
  {
    name: "cleanEnv and clean_env drop the same names, without regard to case",
    ...clean,
    env: { ...DROPPED, ...KEPT },
    args: [],
    agree: false,
    check({ node, python }) {
      assert.deepEqual(surviving(node.value), expected);
      assert.deepEqual(surviving(python.value), expected);
    },
  },
  {
    name: "an explicit value survives, even under a stripped name",
    ...clean,
    env: { CLAUDE_CONFIG_DIR: "inherited" },
    args: [{ CLAUDE_CONFIG_DIR: "explicit", P31A_EXTRA: "1" }],
    agree: false,
    check({ node, python }) {
      for (const { value } of [node, python]) {
        const upper = new Map(Object.entries(value).map(([key, val]) => [key.toUpperCase(), val]));
        assert.equal(upper.get("CLAUDE_CONFIG_DIR"), "explicit");
        assert.equal(upper.get("P31A_EXTRA"), "1");
      }
    },
  },
  {
    name: "cleanEnv and clean_env take an explicit base instead of the process environment",
    ...clean,
    args: [{ B: "2" }, { A: "1", CCDM_X: "gone", MCP_Y: "gone", ANTHROPIC_Z: "gone" }],
    value: { A: "1", B: "2" },
  },
  {
    name: "a Windows extra replaces a base value that differs only in case",
    only: "win32",
    ...clean,
    args: [{ PATH: "new" }, { Path: "old", Other: "x" }],
    agree: false,
    check({ node, python }) {
      assert.deepEqual(node.value, { Other: "x", PATH: "new" });
      assert.deepEqual(python.value, { Other: "x", PATH: "new" });
    },
  },
];
