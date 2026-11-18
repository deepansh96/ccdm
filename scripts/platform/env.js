"use strict";

// The environment a CCDM session may inherit: no agent, API or CCDM settings of
// whatever started it. Names are matched without regard to case, as Windows
// does. ccdmlib/platform/env.py is the Python twin.
const STRIPPED_PREFIXES = ["CLAUDE", "ANTHROPIC", "MCP_", "CCDM"];
const WIN32 = process.platform === "win32";

const stripped = name => {
  const upper = name.toUpperCase();
  return STRIPPED_PREFIXES.some(prefix => upper.startsWith(prefix));
};

// `base` without the stripped names, with `extra` on top. An explicit value is
// always kept, even under a stripped name.
function cleanEnv(extra = {}, base = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    if (!stripped(name) && value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (WIN32) {
      const upper = name.toUpperCase();
      for (const existing of Object.keys(env)) {
        if (existing.toUpperCase() === upper) delete env[existing];
      }
    }
    env[name] = value;
  }
  return env;
}

module.exports = { cleanEnv };
