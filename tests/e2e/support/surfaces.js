// Which suites run on which OS. platformGate() and the skip-budget contract test
// (tests/e2e/windows-skip-budget.test.js) both read this map.

const ALL = ["linux", "darwin", "win32"];

// What each tag means: the OSes that run a test carrying it.
export const TAG_SURFACES = Object.freeze({
  posix: Object.freeze(["linux", "darwin"]),
  darwin: Object.freeze(["darwin"]),
  win32: Object.freeze(["win32"]),
});

// Suites gated as a whole. A suite not listed runs on every OS, apart from any
// single tests gated with platformGate(). Each entry also needs a line in
// windows-skip-budget.json.
const WHOLE_SUITES = Object.freeze({
  "conversation-reminder-launchagent.test.js": { tag: "posix", reason: "installs through launchd and a zsh script; Windows installers have their own suites" },
  "router-installer.test.js": { tag: "posix", reason: "installs through launchd and a zsh script; Windows installers have their own suites" },
  "thread-supervisor-launchagent.test.js": { tag: "posix", reason: "installs through launchd and a zsh script; Windows installers have their own suites" },
  "usage-stats-installer.test.js": { tag: "posix", reason: "installs through launchd and a zsh script; Windows installers have their own suites" },
  "setup.test.js": { tag: "posix", reason: "drives zsh scripts, which the Windows port replaces" },
  "stop-restart.test.js": { tag: "posix", reason: "drives zsh scripts, which the Windows port replaces" },
});

// The surface of one suite file (by basename), or of every listed suite.
export function runSurface(file) {
  const surface = name => {
    const gated = WHOLE_SUITES[name];
    return Object.freeze(gated
      ? { oses: TAG_SURFACES[gated.tag], reason: gated.reason, tag: gated.tag }
      : { oses: ALL });
  };
  if (file !== undefined) return surface(file);
  return Object.fromEntries(Object.keys(WHOLE_SUITES).map(name => [name, surface(name)]));
}
