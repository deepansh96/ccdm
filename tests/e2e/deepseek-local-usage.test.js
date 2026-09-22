import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoDir = path.resolve(".");
const script = path.join(repoDir, "scripts", "deepseek-local-usage.py");
const NOW = "2026-09-15T12:00:00Z";
const SESSION = "01a0c900-0000-7000-8000-000000000001";

const usage = (input, output, cached = 0, reasoning = 0) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});

const zeroUsage = () => usage(0, 0);

function addUsage(base, extra) {
  return {
    input_tokens: base.input_tokens + extra.input_tokens,
    cached_input_tokens: base.cached_input_tokens + extra.cached_input_tokens,
    output_tokens: base.output_tokens + extra.output_tokens,
    reasoning_output_tokens: base.reasoning_output_tokens + extra.reasoning_output_tokens,
    total_tokens: base.total_tokens + extra.total_tokens,
  };
}

function sumUsage(turns) {
  return turns.reduce((total, turn) => addUsage(total, turn.own || zeroUsage()), zeroUsage());
}

// Build a realistic rollout: session_meta, then per turn a turn_context and one
// or more token_count notifications carrying the cumulative totals Codex emits.
function buildRollout({ sessionId = SESSION, provider = "deepseek", turns }) {
  const lines = [];
  if (sessionId !== null) {
    lines.push(JSON.stringify({
      timestamp: turns[0]?.at ?? "2026-09-10T10:00:00Z",
      type: "session_meta",
      payload: { id: sessionId, model_provider: provider, cwd: "/tmp/fake-home", cli_version: "0.0.0" },
    }));
  }
  let cumulative = zeroUsage();
  for (const [index, turn] of turns.entries()) {
    if (turn.model !== undefined) {
      lines.push(JSON.stringify({
        timestamp: turn.at,
        type: "turn_context",
        payload: { turn_id: turn.turnId ?? `turn-${index}`, model: turn.model },
      }));
    }
    cumulative = turn.cumulative ?? addUsage(cumulative, turn.own ?? zeroUsage());
    for (const at of turn.notify ?? [turn.at]) {
      lines.push(JSON.stringify({
        timestamp: at,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: cumulative,
            last_token_usage: turn.own ?? cumulative,
            model_context_window: 1048576,
          },
        },
      }));
    }
  }
  return `${lines.join("\n")}\n`;
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-deepseek-usage-"));
}

function writeFile(home, relative, content) {
  const target = path.join(home, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function writeRollout(home, name, content, directory = "sessions") {
  return writeFile(home, path.join(directory, "2026", "09", "15", name), content);
}

function runCollector(homes, now = NOW, extraSetup = []) {
  const probe = [
    "import importlib.util, json, sys",
    "from pathlib import Path",
    "from datetime import datetime",
    `spec = importlib.util.spec_from_file_location("deepseek_local_usage", ${JSON.stringify(script)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    ...extraSetup,
    "payload = json.load(sys.stdin)",
    "now = datetime.fromisoformat(payload['now'].replace('Z', '+00:00'))",
    "result = module.collect_month_usage([Path(home) for home in payload['homes']], now)",
    "print(json.dumps(result))",
  ].join("\n");
  const run = spawnSync("python3", ["-c", probe], {
    cwd: repoDir,
    input: JSON.stringify({ homes, now }),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
}

// A raw token_count notification with explicit coverage of the info object so a
// test can supply malformed or partial counters verbatim.
function rawTokenLine(at, info) {
  return JSON.stringify({
    timestamp: at,
    type: "event_msg",
    payload: { type: "token_count", info },
  });
}

function sessionMeta(at, payload) {
  return JSON.stringify({ timestamp: at, type: "session_meta", payload });
}

function turnContext(at, payload) {
  return JSON.stringify({ timestamp: at, type: "turn_context", payload });
}

test("collector sums per-turn deltas and ignores repeated notifications", () => {
  const home = tempHome();
  const turns = [
    {
      at: "2026-09-10T10:00:00Z",
      model: "deepseek-flash",
      own: usage(12000, 300, 11000, 250),
      // Codex re-emits the same cumulative totals for every completed item.
      notify: ["2026-09-10T10:00:00Z", "2026-09-10T10:00:04Z", "2026-09-10T10:00:07Z"],
    },
    { at: "2026-09-10T11:00:00Z", model: "deepseek-flash", own: usage(900, 150, 512, 90) },
  ];
  writeRollout(home, "rollout-a.jsonl", buildRollout({ turns }));

  const result = runCollector([home]);
  const expected = sumUsage(turns);
  assert.equal(result.status, "available");
  assert.equal(result.period, "2026-09");
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.cached_input_tokens, expected.cached_input_tokens);
  assert.equal(result.output_tokens, expected.output_tokens);
  assert.equal(result.reasoning_output_tokens, expected.reasoning_output_tokens);
  assert.equal(result.total_tokens, expected.total_tokens);
  assert.equal(result.total_tokens, result.input_tokens + result.output_tokens);
  assert.ok(result.cached_input_tokens <= result.input_tokens);
  assert.ok(result.reasoning_output_tokens <= result.output_tokens);
  assert.equal(result.sessions, 1);
  assert.equal(result.partial, false);
  assert.equal(result.reason, null);
});

test("collector prefers the explicit turn model over a stale session provider", () => {
  const home = tempHome();
  const counted = [
    { at: "2026-09-10T10:00:00Z", model: "deepseek-flash", own: usage(500, 100, 400, 40) },
  ];
  // A DeepSeek home whose session provider label is stale must still count the
  // turn because turn_context names the model explicitly.
  writeRollout(home, "rollout-a.jsonl", buildRollout({ provider: "openai", turns: counted }));
  // A non-DeepSeek turn inside a DeepSeek home is excluded, and the baseline
  // keeps advancing so the following DeepSeek delta stays correct.
  const mixed = [
    { at: "2026-09-11T10:00:00Z", model: "gpt-5-codex", own: usage(40000, 900, 30000, 700) },
    { at: "2026-09-11T11:00:00Z", model: "deepseek-flash", own: usage(700, 120, 640, 60) },
  ];
  writeRollout(home, "rollout-b.jsonl", buildRollout({ sessionId: "01a0c900-0000-7000-8000-000000000002", turns: mixed }));

  const result = runCollector([home]);
  const expected = addUsage(sumUsage(counted), sumUsage([mixed[1]]));
  assert.equal(result.status, "available");
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.output_tokens, expected.output_tokens);
  assert.equal(result.sessions, 2);
  assert.equal(result.partial, false);
});

test("collector falls back to the session provider only without a conflicting model", () => {
  const home = tempHome();
  const fallback = [
    { at: "2026-09-12T10:00:00Z", model: null, own: usage(1000, 200, 900, 100) },
  ];
  writeRollout(home, "rollout-a.jsonl", buildRollout({ turns: fallback }));
  const foreign = [
    { at: "2026-09-12T10:00:00Z", model: null, own: usage(5000, 800) },
  ];
  writeRollout(home, "rollout-b.jsonl", buildRollout({ sessionId: "01a0c900-0000-7000-8000-000000000003", provider: "openai", turns: foreign }));

  const result = runCollector([home]);
  const expected = sumUsage(fallback);
  assert.equal(result.status, "available");
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.output_tokens, expected.output_tokens);
  assert.equal(result.sessions, 1);
  assert.equal(result.partial, false);
});

test("collector excludes unprovable usage and reports a partial result", () => {
  const home = tempHome();
  // No session_meta and no turn_context: nothing proves DeepSeek ownership.
  const unknown = [
    { at: "2026-09-12T10:00:00Z", own: usage(9000, 300) },
  ];
  writeRollout(home, "rollout-a.jsonl", buildRollout({ sessionId: null, turns: unknown }));
  const counted = [
    { at: "2026-09-12T11:00:00Z", model: "deepseek-flash", own: usage(300, 30) },
  ];
  writeRollout(home, "rollout-b.jsonl", buildRollout({ sessionId: "01a0c900-0000-7000-8000-000000000004", turns: counted }));

  const result = runCollector([home]);
  const expected = sumUsage(counted);
  assert.equal(result.status, "available");
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.partial, true);
  assert.match(result.reason, /attributed to DeepSeek/);
});

test("collector counts a copied rollout once and keeps resumed branch work", () => {
  const homeA = tempHome();
  const homeB = tempHome();
  const early = [
    { at: "2026-09-10T10:00:00Z", model: "deepseek-flash", own: usage(1000, 200, 900, 150) },
    { at: "2026-09-10T10:30:00Z", model: "deepseek-flash", own: usage(2000, 300, 1800, 200) },
  ];
  const all = [
    ...early,
    { at: "2026-09-10T11:00:00Z", model: "deepseek-flash", own: usage(3000, 400, 2500, 250) },
    { at: "2026-09-10T11:30:00Z", model: "deepseek-flash", own: usage(4000, 500, 3500, 300) },
  ];
  const prefix = buildRollout({ turns: early });
  writeRollout(homeA, "rollout-a.jsonl", prefix);
  // An exact copy of the same session in a second home must not double count.
  writeRollout(homeB, "rollout-a.jsonl", prefix);
  // A longer file that replays the same prefix and adds new turns beside it.
  writeRollout(homeB, "rollout-b.jsonl", buildRollout({ turns: all }));

  const result = runCollector([homeA, homeB]);
  const expected = sumUsage(all);
  assert.equal(result.status, "available");
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.output_tokens, expected.output_tokens);
  assert.equal(result.total_tokens, expected.total_tokens);
  assert.equal(result.sessions, 1);
  assert.equal(result.partial, false);
});

test("collector keeps only current UTC month deltas across a month boundary", () => {
  const home = tempHome();
  const turns = [
    { at: "2026-08-31T23:00:00Z", model: "deepseek-flash", own: usage(10000, 1000, 9000, 800) },
    { at: "2026-09-01T00:30:00Z", model: "deepseek-flash", own: usage(500, 60, 400, 40) },
  ];
  writeRollout(home, "rollout-a.jsonl", buildRollout({ turns }));

  const result = runCollector([home], "2026-09-15T12:00:00Z");
  const expected = sumUsage([turns[1]]);
  assert.equal(result.period, "2026-09");
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.output_tokens, expected.output_tokens);
  assert.equal(result.total_tokens, expected.total_tokens);
  assert.equal(result.sessions, 1);

  const august = runCollector([home], "2026-08-31T23:45:00Z");
  const augustExpected = sumUsage([turns[0]]);
  assert.equal(august.period, "2026-08");
  assert.equal(august.total_tokens, augustExpected.total_tokens);
});

test("collector falls back to the turn usage and flags a cumulative reset", () => {
  const home = tempHome();
  const turns = [
    { at: "2026-09-10T10:00:00Z", model: "deepseek-flash", own: usage(90000, 4000, 80000, 3000) },
    {
      at: "2026-09-10T11:00:00Z",
      model: "deepseek-flash",
      own: usage(4000, 300, 3800, 200),
      // Compaction restarted the cumulative counter below the previous peak.
      cumulative: usage(1500, 120, 1400, 90),
    },
    { at: "2026-09-10T12:00:00Z", model: "deepseek-flash", own: usage(800, 90, 700, 60) },
  ];
  writeRollout(home, "rollout-a.jsonl", buildRollout({ turns }));

  const result = runCollector([home]);
  const expected = addUsage(sumUsage([turns[0], turns[1]]), sumUsage([turns[2]]));
  assert.equal(result.status, "available");
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.output_tokens, expected.output_tokens);
  assert.equal(result.partial, true);
  assert.match(result.reason, /continuity/);
});

test("collector tolerates malformed, truncated, and oversized lines", () => {
  const home = tempHome();
  const turns = [
    { at: "2026-09-10T10:00:00Z", model: "deepseek-flash", own: usage(1500, 220, 1200, 120) },
  ];
  const valid = buildRollout({ turns });
  const oversized = `{"timestamp":"2026-09-10T10:00:00Z","type":"response_item","payload":{"text":"${"x".repeat(1_100_000)}"}}`;
  const content = [
    "{partial",
    "",
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: "corrupt" } }),
    "[1,2,3]",
    oversized,
    ...valid.trimEnd().split("\n"),
    '{"timestamp":"2026-09-10T13:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":-5,"output_tokens":-1}}}}',
  ].join("\n") + "\n";
  writeRollout(home, "rollout-a.jsonl", content);

  const result = runCollector([home]);
  const expected = sumUsage(turns);
  assert.equal(result.status, "available");
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.output_tokens, expected.output_tokens);
  assert.equal(result.sessions, 1);
});

test("collector restarts the cumulative baseline for a second session in one file", () => {
  const home = tempHome();
  const first = [
    { at: "2026-09-12T09:00:00Z", model: "deepseek-flash", own: usage(1000, 100, 900, 40) },
  ];
  const second = [
    { at: "2026-09-12T10:00:00Z", model: "deepseek-flash", own: usage(5, 1, 4, 1) },
  ];
  const content = [
    buildRollout({ sessionId: "01a0c900-0000-7000-8000-000000000010", turns: first }).trimEnd(),
    buildRollout({ sessionId: "01a0c900-0000-7000-8000-000000000011", turns: second }).trimEnd(),
  ].join("\n") + "\n";
  writeRollout(home, "rollout-a.jsonl", content);

  const result = runCollector([home]);
  const expected = addUsage(sumUsage(first), sumUsage(second));
  assert.equal(result.status, "available");
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.output_tokens, expected.output_tokens);
  // The smaller second total must not be read as a compaction regression.
  assert.equal(result.partial, false);
  assert.equal(result.sessions, 2);
});

test("collector counts archived sessions and aggregates multiple homes", () => {
  const homeA = tempHome();
  const homeB = tempHome();
  const live = [
    { at: "2026-09-12T10:00:00Z", model: "deepseek-flash", own: usage(111, 11, 100, 5) },
  ];
  const archived = [
    { at: "2026-09-12T11:00:00Z", model: "deepseek-flash", own: usage(222, 22, 200, 10) },
  ];
  writeRollout(homeA, "rollout-a.jsonl", buildRollout({ turns: live }));
  writeRollout(homeB, "rollout-b.jsonl", buildRollout({ sessionId: "01a0c900-0000-7000-8000-000000000005", turns: archived }), "archived_sessions");

  const result = runCollector([homeA, homeB]);
  const expected = addUsage(sumUsage(live), sumUsage(archived));
  assert.equal(result.status, "available");
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.output_tokens, expected.output_tokens);
  assert.equal(result.sessions, 2);
  assert.equal(result.partial, false);
});

test("collector reports zero, not failure, for readable homes without sessions", () => {
  const home = tempHome();
  const result = runCollector([home]);
  assert.equal(result.status, "available");
  assert.equal(result.period, "2026-09");
  assert.equal(result.total_tokens, 0);
  assert.equal(result.sessions, 0);
  assert.equal(result.partial, false);
  assert.equal(result.reason, null);
});

test("collector reports unavailable homes without leaking the requested path", () => {
  const missing = path.join(tempHome(), "not-created");
  const result = runCollector([missing]);
  assert.equal(result.status, "unavailable");
  assert.equal(result.total_tokens, 0);
  assert.equal(result.sessions, 0);
  assert.match(result.reason, /homes were unavailable/);
  assert.equal(JSON.stringify(result).includes(missing), false);

  const empty = runCollector([]);
  assert.equal(empty.status, "unavailable");
  assert.match(empty.reason, /No DeepSeek homes configured/);
});

test("collector returns counters only, never paths, session ids, or prompts", () => {
  const home = tempHome();
  const secret = "SECRET-PROMPT-TEXT-MUST-NOT-LEAK";
  const sessionId = "01a0c900-0000-7000-8000-0000000000ff";
  const turns = [
    { at: "2026-09-10T10:00:00Z", model: "deepseek-flash", own: usage(700, 70, 600, 30) },
  ];
  const content = [
    buildRollout({ sessionId, turns }).trimEnd(),
    JSON.stringify({ timestamp: "2026-09-10T10:00:05Z", type: "response_item", payload: { role: "user", content: secret } }),
  ].join("\n") + "\n";
  writeRollout(home, "rollout-a.jsonl", content);

  const result = runCollector([home]);
  const serialized = JSON.stringify(result);
  assert.equal(result.status, "available");
  assert.equal(result.total_tokens, sumUsage(turns).total_tokens);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(sessionId), false);
  assert.equal(serialized.includes(home), false);
  assert.equal(serialized.includes("rollout-a"), false);
  assert.deepEqual(Object.keys(result).sort(), [
    "cached_input_tokens",
    "input_tokens",
    "output_tokens",
    "partial",
    "period",
    "reason",
    "reasoning_output_tokens",
    "sessions",
    "status",
    "total_tokens",
  ]);
});

test("collector counts only the per-turn delta when a rollout starts mid-thread", () => {
  const home = tempHome();
  const lifetimeBefore = usage(480000, 19000, 460000, 12000);
  const firstTurn = usage(800, 120, 700, 60);
  const secondTurn = usage(300, 40, 250, 20);
  const turns = [
    {
      at: "2026-09-10T10:00:00Z",
      model: "deepseek-flash",
      own: firstTurn,
      // The file begins after earlier-month work, so its first cumulative
      // already carries lifetime history that must not land in this month.
      cumulative: addUsage(lifetimeBefore, firstTurn),
    },
    { at: "2026-09-10T11:00:00Z", model: "deepseek-flash", own: secondTurn },
  ];
  writeRollout(home, "rollout-a.jsonl", buildRollout({ turns }));

  const result = runCollector([home]);
  const expected = addUsage(firstTurn, secondTurn);
  assert.equal(result.status, "available");
  assert.equal(result.total_tokens, expected.total_tokens);
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.output_tokens, expected.output_tokens);
  assert.notEqual(result.total_tokens, lifetimeBefore.total_tokens);
  assert.equal(result.partial, true);
  assert.match(result.reason, /continuity/);
});

test("collector keeps two distinct turns that share a timestamp and equal usage", () => {
  const home = tempHome();
  const turnUsage = usage(500, 60, 400, 30);
  const turns = [
    { at: "2026-09-10T10:00:00Z", turnId: "turn-aaa", model: "deepseek-flash", own: turnUsage },
    { at: "2026-09-10T10:00:00Z", turnId: "turn-bbb", model: "deepseek-flash", own: turnUsage },
  ];
  writeRollout(home, "rollout-a.jsonl", buildRollout({ turns }));

  const result = runCollector([home]);
  assert.equal(result.status, "available");
  assert.equal(result.total_tokens, turnUsage.total_tokens * 2);
  assert.equal(result.partial, false);
  assert.equal(result.sessions, 1);
});

test("collector counts mid-turn progress within one turn exactly once", () => {
  const home = tempHome();
  const session = "01a0c900-0000-7000-8000-0000000000b1";
  const first = usage(1000, 100, 900, 50);
  const more = usage(200, 30, 150, 10);
  const combined = addUsage(first, more);
  const at = "2026-09-10T10:00:00Z";
  const lines = [
    sessionMeta(at, { id: session, model_provider: "deepseek" }),
    turnContext(at, { turn_id: "turn-1", model: "deepseek-flash" }),
    // Codex emits a token_count per completed item: the cumulative counter
    // grows mid-turn, so both deltas are real, and a byte-identical repeat must
    // still be suppressed.
    rawTokenLine(at, { total_token_usage: first, last_token_usage: first }),
    rawTokenLine(at, { total_token_usage: combined, last_token_usage: more }),
    rawTokenLine(at, { total_token_usage: combined, last_token_usage: more }),
  ];
  writeRollout(home, "rollout-a.jsonl", `${lines.join("\n")}\n`);

  const result = runCollector([home]);
  assert.equal(result.status, "available");
  assert.equal(result.total_tokens, combined.total_tokens);
  assert.equal(result.input_tokens, combined.input_tokens);
  assert.equal(result.partial, false);
  assert.equal(result.sessions, 1);
});

test("collector dedups fork-inherited turns by turn id and keeps new fork work", () => {
  const parentHome = tempHome();
  const forkHome = tempHome();
  const inherited = [
    { at: "2026-09-10T10:00:00Z", turnId: "turn-1", model: "deepseek-flash", own: usage(1000, 100, 900, 50) },
    { at: "2026-09-10T10:30:00Z", turnId: "turn-2", model: "deepseek-flash", own: usage(2000, 200, 1800, 100) },
  ];
  const newWork = [
    { at: "2026-09-10T11:00:00Z", turnId: "turn-3", model: "deepseek-flash", own: usage(3000, 300, 2700, 150) },
  ];
  writeRollout(parentHome, "rollout-parent.jsonl", buildRollout({
    sessionId: "01a0c900-0000-7000-8000-0000000000a1",
    turns: inherited,
  }));
  // The fork copies the parent's events under a new session id but keeps the
  // original turn ids, then appends genuinely new turns.
  writeRollout(forkHome, "rollout-fork.jsonl", buildRollout({
    sessionId: "01a0c900-0000-7000-8000-0000000000a2",
    turns: [...inherited, ...newWork],
  }));

  const result = runCollector([parentHome, forkHome]);
  const expected = sumUsage([...inherited, ...newWork]);
  assert.equal(result.status, "available");
  assert.equal(result.total_tokens, expected.total_tokens);
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.output_tokens, expected.output_tokens);
  assert.equal(result.sessions, 2);
  assert.equal(result.partial, false);
});

test("collector rejects fractional, boolean, oversized, and inconsistent counters", () => {
  const home = tempHome();
  const session = "01a0c900-0000-7000-8000-0000000000c1";
  // A valid JSON integer far beyond any IEEE-754 float range: the old float()
  // path would raise OverflowError instead of skipping the event.
  const hugeInt = "9".repeat(400);
  const lines = [
    sessionMeta("2026-09-10T09:00:00Z", { id: session, model_provider: "deepseek" }),
    turnContext("2026-09-10T09:00:00Z", { turn_id: "turn-1", model: "deepseek-flash" }),
    rawTokenLine("2026-09-10T09:01:00Z", { total_token_usage: { input_tokens: 12.5, output_tokens: 3 } }),
    rawTokenLine("2026-09-10T09:02:00Z", { total_token_usage: { input_tokens: true, output_tokens: 3 } }),
    rawTokenLine("2026-09-10T09:03:00Z", { total_token_usage: { input_tokens: 1e30, output_tokens: 3 } }),
    `{"timestamp":"2026-09-10T09:04:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":${hugeInt},"output_tokens":3}}}}`,
    rawTokenLine("2026-09-10T09:05:00Z", { total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 500 } }),
    rawTokenLine("2026-09-10T09:06:00Z", { total_token_usage: { input_tokens: 100, output_tokens: 10, reasoning_output_tokens: 500 } }),
    rawTokenLine("2026-09-10T09:07:00Z", { total_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 999 } }),
    rawTokenLine("2026-09-10T09:08:00Z", {
      total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 50, reasoning_output_tokens: 5, total_tokens: 110 },
      last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 50, reasoning_output_tokens: 5, total_tokens: 110 },
    }),
  ];
  writeRollout(home, "rollout-a.jsonl", `${lines.join("\n")}\n`);

  const result = runCollector([home]);
  assert.equal(result.status, "available");
  // Only the single well-formed event contributes; nothing is coerced to zero.
  assert.equal(result.total_tokens, 110);
  assert.equal(result.input_tokens, 100);
  assert.equal(result.cached_input_tokens, 50);
  assert.equal(result.output_tokens, 10);
  assert.equal(result.reasoning_output_tokens, 5);
  assert.equal(result.total_tokens, result.input_tokens + result.output_tokens);
  assert.equal(result.partial, true);
  assert.match(result.reason, /malformed or truncated/);
});

test("collector avoids misattributing skipped work after a malformed record", () => {
  const home = tempHome();
  const session = "01a0c900-0000-7000-8000-0000000000d1";
  const first = usage(1000, 100, 900, 50);
  const lostWork = usage(50000, 4000, 49000, 3000); // real work whose record was lost
  const second = usage(700, 80, 600, 40);
  const lines = [
    sessionMeta("2026-09-10T10:00:00Z", { id: session, model_provider: "deepseek" }),
    turnContext("2026-09-10T10:00:00Z", { turn_id: "turn-1", model: "deepseek-flash" }),
    rawTokenLine("2026-09-10T10:00:00Z", { total_token_usage: first, last_token_usage: first }),
    '{"timestamp":"2026-09-10T10:05:00Z","type":"event_msg","payload"',
    turnContext("2026-09-10T10:10:00Z", { turn_id: "turn-2", model: "deepseek-flash" }),
    rawTokenLine("2026-09-10T10:10:00Z", {
      total_token_usage: addUsage(addUsage(first, lostWork), second),
      last_token_usage: second,
    }),
  ];
  writeRollout(home, "rollout-a.jsonl", `${lines.join("\n")}\n`);

  const result = runCollector([home]);
  const expected = addUsage(first, second);
  const ifMisattributed = addUsage(expected, lostWork);
  assert.equal(result.status, "available");
  assert.equal(result.total_tokens, expected.total_tokens);
  assert.notEqual(result.total_tokens, ifMisattributed.total_tokens);
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.partial, true);
  assert.match(result.reason, /malformed or truncated|continuity/);
});

test("collector marks a file partial when oversized content cannot be parsed", () => {
  const home = tempHome();
  const turns = [
    { at: "2026-09-10T10:00:00Z", model: "deepseek-flash", own: usage(1500, 220, 1200, 120) },
  ];
  const oversized = `{"timestamp":"2026-09-10T10:00:00Z","type":"response_item","payload":{"text":"${"x".repeat(1_100_000)}"}}`;
  const content = [oversized, ...buildRollout({ turns }).trimEnd().split("\n")].join("\n") + "\n";
  writeRollout(home, "rollout-a.jsonl", content);

  const result = runCollector([home]);
  assert.equal(result.status, "available");
  assert.equal(result.total_tokens, sumUsage(turns).total_tokens);
  assert.equal(result.partial, true);
  assert.match(result.reason, /malformed or truncated/);
});

test("collector drops a stale turn model when a new turn_context omits it", () => {
  const home = tempHome();
  const counted = { at: "2026-09-10T10:00:00Z", turnId: "turn-1", model: "deepseek-flash", own: usage(500, 50, 400, 20) };
  const foreign = { at: "2026-09-10T11:00:00Z", turnId: "turn-2", model: null, own: usage(7000, 700, 6000, 400) };
  writeRollout(home, "rollout-a.jsonl", buildRollout({ provider: "openai", turns: [counted, foreign] }));

  const result = runCollector([home]);
  assert.equal(result.status, "available");
  // The model-less turn must not inherit the previous DeepSeek model; the
  // OpenAI session provider proves it is foreign, so the count stays clean.
  assert.equal(result.total_tokens, counted.own.total_tokens);
  assert.equal(result.partial, false);
});

test("collector does not inherit the previous session provider for a new session", () => {
  const home = tempHome();
  const firstSession = "01a0c900-0000-7000-8000-0000000000e1";
  const firstUsage = usage(300, 30, 200, 10);
  const lines = [
    sessionMeta("2026-09-10T10:00:00Z", { id: firstSession, model_provider: "deepseek" }),
    turnContext("2026-09-10T10:00:00Z", { turn_id: "turn-1", model: "deepseek-flash" }),
    rawTokenLine("2026-09-10T10:00:00Z", { total_token_usage: firstUsage, last_token_usage: firstUsage }),
    // A second session with no provider and no per-turn model must not be
    // credited to the previous session's DeepSeek provider.
    sessionMeta("2026-09-10T11:00:00Z", { id: "01a0c900-0000-7000-8000-0000000000e2" }),
    turnContext("2026-09-10T11:00:00Z", { turn_id: "turn-1", model: null }),
    rawTokenLine("2026-09-10T11:00:00Z", {
      total_token_usage: usage(9000, 900, 8000, 500),
      last_token_usage: usage(9000, 900, 8000, 500),
    }),
  ];
  writeRollout(home, "rollout-a.jsonl", `${lines.join("\n")}\n`);

  const result = runCollector([home]);
  assert.equal(result.status, "available");
  assert.equal(result.total_tokens, firstUsage.total_tokens);
  assert.equal(result.sessions, 1);
  assert.equal(result.partial, true);
  assert.match(result.reason, /attributed to DeepSeek/);
});

test("collector flags a partial scan when it reaches its safety bounds", () => {
  const home = tempHome();
  const first = usage(100, 10, 90, 5);
  const second = usage(200, 20, 180, 10);
  writeRollout(home, "rollout-a.jsonl", buildRollout({
    sessionId: "01a0c900-0000-7000-8000-0000000000f1",
    turns: [{ at: "2026-09-10T10:00:00Z", model: "deepseek-flash", own: first }],
  }));
  writeRollout(home, "rollout-b.jsonl", buildRollout({
    sessionId: "01a0c900-0000-7000-8000-0000000000f2",
    turns: [{ at: "2026-09-10T11:00:00Z", model: "deepseek-flash", own: second }],
  }));

  const result = runCollector([home], NOW, ["module.MAX_SESSION_FILES = 1"]);
  assert.equal(result.status, "available");
  // Only the first file is scanned; the second is skipped and the total is
  // reported as partial rather than silently truncated.
  assert.equal(result.total_tokens, first.total_tokens);
  assert.equal(result.partial, true);
  assert.match(result.reason, /safety bounds/);
});

test("collector treats a directory walk error as partial, not empty", () => {
  const home = tempHome();
  writeFile(home, path.join("sessions", "placeholder.txt"), "not a session\n");
  const patchWalk = [
    "def _fake_walk(root, followlinks=False, onerror=None):",
    "    if onerror is not None:",
    "        onerror(OSError('walk failed'))",
    "    return iter(())",
    "module.os.walk = _fake_walk",
  ];

  const result = runCollector([home], NOW, patchWalk);
  assert.equal(result.status, "available");
  assert.equal(result.total_tokens, 0);
  assert.equal(result.partial, true);
  assert.match(result.reason, /could not be read/);
});

test("collector counts a repeated last-only notification once and keeps progress", () => {
  const home = tempHome();
  const session = "01a0c900-0000-7000-8000-0000000000b2";
  const counted = usage(100, 50, 10, 5);
  // A genuinely different delta for the same turn is real mid-turn progress.
  const progress = usage(20, 10, 4, 2);
  const lines = [
    sessionMeta("2026-09-10T10:00:00Z", { id: session, model_provider: "deepseek" }),
    turnContext("2026-09-10T10:00:00Z", { turn_id: "turn-1", model: "deepseek-flash" }),
    // No cumulative counter at all: only the per-turn delta is available.
    rawTokenLine("2026-09-10T10:00:00Z", { last_token_usage: counted }),
    rawTokenLine("2026-09-10T10:04:00Z", { last_token_usage: counted }),
    rawTokenLine("2026-09-10T10:07:00Z", { last_token_usage: progress }),
  ];
  writeRollout(home, "rollout-a.jsonl", `${lines.join("\n")}\n`);

  const result = runCollector([home]);
  const expected = addUsage(counted, progress);
  assert.equal(result.status, "available");
  assert.equal(result.total_tokens, expected.total_tokens);
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.output_tokens, expected.output_tokens);
  // The identical repeat is not double-counted, but the approximation is
  // reported rather than presented as complete.
  assert.notEqual(result.total_tokens, addUsage(counted, counted).total_tokens);
  assert.equal(result.sessions, 1);
  assert.equal(result.partial, true);
  assert.match(result.reason, /continuity/);
});

test("collector falls back to the turn delta when a component counter resets", () => {
  const home = tempHome();
  const session = "01a0c900-0000-7000-8000-0000000000b3";
  const firstTotal = usage(100, 100, 50, 10);
  const secondTotal = {
    input_tokens: 110,
    cached_input_tokens: 0,
    output_tokens: 200,
    reasoning_output_tokens: 20,
    total_tokens: 310,
  };
  const secondLast = usage(10, 100, 10, 10);
  const lines = [
    sessionMeta("2026-09-10T10:00:00Z", { id: session, model_provider: "deepseek" }),
    turnContext("2026-09-10T10:00:00Z", { turn_id: "turn-1", model: "deepseek-flash" }),
    rawTokenLine("2026-09-10T10:00:00Z", { total_token_usage: firstTotal, last_token_usage: firstTotal }),
    rawTokenLine("2026-09-10T11:00:00Z", { total_token_usage: secondTotal, last_token_usage: secondLast }),
  ];
  writeRollout(home, "rollout-a.jsonl", `${lines.join("\n")}\n`);

  const result = runCollector([home]);
  // cached only regressed (50 -> 0) while the cumulative total kept growing;
  // the reset must fall back to the per-turn delta instead of clamping to zero.
  assert.equal(result.status, "available");
  assert.equal(result.cached_input_tokens, firstTotal.cached_input_tokens + secondLast.cached_input_tokens);
  assert.equal(result.input_tokens, firstTotal.input_tokens + secondLast.input_tokens);
  assert.equal(result.output_tokens, firstTotal.output_tokens + secondLast.output_tokens);
  assert.equal(result.total_tokens, firstTotal.total_tokens + secondLast.total_tokens);
  // The fallback subset stays internally valid.
  assert.ok(result.cached_input_tokens <= result.input_tokens);
  assert.ok(result.reasoning_output_tokens <= result.output_tokens);
  assert.equal(result.partial, true);
  assert.match(result.reason, /continuity/);
});

test("collector counts only sessions with current-month usage", () => {
  const home = tempHome();
  const august = [
    { at: "2026-08-20T10:00:00Z", model: "deepseek-flash", own: usage(100, 10, 90, 5) },
  ];
  writeRollout(home, "rollout-a.jsonl", buildRollout({
    sessionId: "01a0c900-0000-7000-8000-0000000000b4",
    turns: august,
  }));

  const september = runCollector([home], "2026-09-15T12:00:00Z");
  assert.equal(september.status, "available");
  assert.equal(september.period, "2026-09");
  assert.equal(september.total_tokens, 0);
  assert.equal(september.sessions, 0);

  const collected = runCollector([home], "2026-08-31T12:00:00Z");
  assert.equal(collected.period, "2026-08");
  assert.equal(collected.sessions, 1);
});

test("collector excludes a first cumulative-only event until a baseline exists", () => {
  const home = tempHome();
  const session = "01a0c900-0000-7000-8000-0000000000b5";
  const lifetime = usage(300, 100);
  const nextLast = usage(20, 5);
  const nextTotal = addUsage(lifetime, nextLast);
  const lines = [
    sessionMeta("2026-09-10T10:00:00Z", { id: session, model_provider: "deepseek" }),
    turnContext("2026-09-10T10:00:00Z", { turn_id: "turn-1", model: "deepseek-flash" }),
    // The file starts mid-thread with only a cumulative counter: that value may
    // include earlier work, so it is not counted as this month's usage.
    rawTokenLine("2026-09-10T10:00:00Z", { total_token_usage: lifetime }),
    // Once the baseline exists the next cumulative delta is provable.
    rawTokenLine("2026-09-10T11:00:00Z", { total_token_usage: nextTotal, last_token_usage: nextLast }),
  ];
  writeRollout(home, "rollout-a.jsonl", `${lines.join("\n")}\n`);

  const result = runCollector([home]);
  assert.equal(result.status, "available");
  assert.equal(result.total_tokens, nextLast.total_tokens);
  assert.equal(result.input_tokens, nextLast.input_tokens);
  assert.equal(result.output_tokens, nextLast.output_tokens);
  assert.notEqual(result.total_tokens, lifetime.total_tokens);
  assert.notEqual(result.total_tokens, nextTotal.total_tokens);
  assert.equal(result.sessions, 1);
  assert.equal(result.partial, true);
  assert.match(result.reason, /continuity/);
});

test("collector excludes cumulative-only work after a gap or reset with no delta", () => {
  const home = tempHome();
  const session = "01a0c900-0000-7000-8000-0000000000d2";
  const first = usage(1000, 100, 900, 50);
  const lostWork = usage(50000, 4000, 49000, 3000); // real work whose record was lost
  const afterGap = usage(700, 80, 600, 40);
  const resetTotal = usage(90, 30, 20, 5); // below the running cumulative: a reset
  const afterReset = usage(120, 25, 100, 10);
  const lines = [
    sessionMeta("2026-09-10T10:00:00Z", { id: session, model_provider: "deepseek" }),
    turnContext("2026-09-10T10:00:00Z", { turn_id: "turn-1", model: "deepseek-flash" }),
    rawTokenLine("2026-09-10T10:00:00Z", { total_token_usage: first, last_token_usage: first }),
    // A truncated record sits between the baseline and the next token_count.
    '{"timestamp":"2026-09-10T10:05:00Z","type":"event_msg","payload"',
    turnContext("2026-09-10T10:10:00Z", { turn_id: "turn-2", model: "deepseek-flash" }),
    // The gap event carries only a cumulative counter, which still folds in the
    // lost turn.  It must be excluded, not counted as this window's delta, while
    // the baseline still advances to keep later turns attributable.
    rawTokenLine("2026-09-10T10:10:00Z", {
      total_token_usage: addUsage(addUsage(first, lostWork), afterGap),
    }),
    turnContext("2026-09-10T10:20:00Z", { turn_id: "turn-3", model: "deepseek-flash" }),
    // A reset with no per-turn delta must likewise never inflate the month.
    rawTokenLine("2026-09-10T10:20:00Z", { total_token_usage: resetTotal }),
    turnContext("2026-09-10T10:30:00Z", { turn_id: "turn-4", model: "deepseek-flash" }),
    rawTokenLine("2026-09-10T10:30:00Z", {
      total_token_usage: addUsage(resetTotal, afterReset),
      last_token_usage: afterReset,
    }),
  ];
  writeRollout(home, "rollout-a.jsonl", `${lines.join("\n")}\n`);

  const result = runCollector([home]);
  const expected = addUsage(first, afterReset);
  const ifGapInflated = addUsage(addUsage(expected, lostWork), afterGap);
  const ifResetInflated = addUsage(expected, resetTotal);
  assert.equal(result.status, "available");
  assert.equal(result.total_tokens, expected.total_tokens);
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.output_tokens, expected.output_tokens);
  assert.equal(result.cached_input_tokens, expected.cached_input_tokens);
  assert.notEqual(result.total_tokens, ifGapInflated.total_tokens);
  assert.notEqual(result.total_tokens, ifResetInflated.total_tokens);
  assert.equal(result.partial, true);
  assert.match(result.reason, /malformed or truncated/);
  assert.match(result.reason, /continuity/);
});

test("collector never reports an impossible per-turn delta subset", () => {
  const home = tempHome();
  const session = "01a0c900-0000-7000-8000-0000000000d3";
  const first = usage(1000, 100, 0, 0);
  // Both cumulative samples are individually valid: cached input stays within
  // input and reasoning stays within output.  But the cached component jumps by
  // far more than the input parent, so the naive monotonic delta would claim
  // more cached input than input.
  const skewedTotal = {
    input_tokens: 1010,
    cached_input_tokens: 1005,
    output_tokens: 200,
    reasoning_output_tokens: 100,
    total_tokens: 1210,
  };
  const skewedLast = usage(12, 6, 5, 2);
  // A second skewed cumulative with no per-turn delta at all: it must be
  // excluded rather than emitted as a corrupt delta.
  const skewedTotal2 = {
    input_tokens: 1013,
    cached_input_tokens: 1012,
    output_tokens: 205,
    reasoning_output_tokens: 101,
    total_tokens: 1218,
  };
  const progress = usage(40, 10, 5, 2);
  const lines = [
    sessionMeta("2026-09-10T10:00:00Z", { id: session, model_provider: "deepseek" }),
    turnContext("2026-09-10T10:00:00Z", { turn_id: "turn-1", model: "deepseek-flash" }),
    rawTokenLine("2026-09-10T10:00:00Z", { total_token_usage: first, last_token_usage: first }),
    turnContext("2026-09-10T10:10:00Z", { turn_id: "turn-2", model: "deepseek-flash" }),
    rawTokenLine("2026-09-10T10:10:00Z", {
      total_token_usage: skewedTotal,
      last_token_usage: skewedLast,
    }),
    turnContext("2026-09-10T10:20:00Z", { turn_id: "turn-3", model: "deepseek-flash" }),
    rawTokenLine("2026-09-10T10:20:00Z", { total_token_usage: skewedTotal2 }),
    turnContext("2026-09-10T10:30:00Z", { turn_id: "turn-4", model: "deepseek-flash" }),
    rawTokenLine("2026-09-10T10:30:00Z", {
      total_token_usage: addUsage(skewedTotal2, progress),
      last_token_usage: progress,
    }),
  ];
  writeRollout(home, "rollout-a.jsonl", `${lines.join("\n")}\n`);

  const result = runCollector([home]);
  const expected = addUsage(addUsage(first, skewedLast), progress);
  // The implausible deltas that trusting the cumulative counter alone produces.
  const naiveSkew = {
    input_tokens: 13,
    cached_input_tokens: 1012,
    output_tokens: 105,
    reasoning_output_tokens: 101,
    total_tokens: 118,
  };
  const ifTrusted = addUsage(addUsage(first, naiveSkew), progress);
  assert.equal(result.status, "available");
  assert.equal(result.total_tokens, expected.total_tokens);
  assert.equal(result.input_tokens, expected.input_tokens);
  assert.equal(result.output_tokens, expected.output_tokens);
  assert.equal(result.cached_input_tokens, expected.cached_input_tokens);
  assert.equal(result.reasoning_output_tokens, expected.reasoning_output_tokens);
  assert.notEqual(result.total_tokens, ifTrusted.total_tokens);
  // The reported breakdown stays internally consistent.
  assert.ok(result.cached_input_tokens <= result.input_tokens);
  assert.ok(result.reasoning_output_tokens <= result.output_tokens);
  assert.equal(result.partial, true);
  assert.match(result.reason, /continuity/);
});

test("collector charges a discarded oversized line against the file byte budget", () => {
  const home = tempHome();
  const turns = [
    { at: "2026-09-10T10:00:00Z", model: "deepseek-flash", own: usage(1500, 220, 1200, 120) },
  ];
  const oversized = `{"timestamp":"2026-09-10T10:00:00Z","type":"response_item","payload":{"text":"${"x".repeat(4000)}"}}`;
  const file = writeRollout(home, "rollout-a.jsonl", [oversized, ...buildRollout({ turns }).trimEnd().split("\n")].join("\n") + "\n");
  const patches = ["module.MAX_LINE_BYTES = 64", "module.MAX_FILE_BYTES = 512"];

  // The discarded remainder of the oversized line must be charged, not just the
  // yielded prefix, so the scan stops at the file budget before the valid turn.
  const scan = spawnSync("python3", ["-c", [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("deepseek_local_usage", ${JSON.stringify(script)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "module.MAX_LINE_BYTES = 64",
    "module.MAX_FILE_BYTES = 512",
    `scan = module._scan_session_file(${JSON.stringify(file)}, "0-0-0")`,
    "print(json.dumps({'bytes': scan['bytes'], 'truncated': scan['truncated'], 'events': len(scan['events']), 'limit': module.MAX_FILE_BYTES}))",
  ].join("\n")], { cwd: repoDir, encoding: "utf8" });
  assert.equal(scan.status, 0, scan.stderr);
  const scanned = JSON.parse(scan.stdout);
  assert.ok(scanned.bytes > scanned.limit, `discarded bytes were not charged (${scanned.bytes} <= ${scanned.limit})`);
  assert.equal(scanned.truncated, true);
  assert.equal(scanned.events, 0);

  const result = runCollector([home], NOW, patches);
  assert.equal(result.status, "available");
  assert.equal(result.total_tokens, 0);
  assert.equal(result.partial, true);
  assert.match(result.reason, /malformed or truncated/);
});

test("collector keeps copied and forked session counts stable across home order", () => {
  const parentHome = tempHome();
  const forkHome = tempHome();
  const inherited = [
    { at: "2026-09-10T10:00:00Z", turnId: "turn-1", model: "deepseek-flash", own: usage(1000, 100, 900, 50) },
    { at: "2026-09-10T10:30:00Z", turnId: "turn-2", model: "deepseek-flash", own: usage(2000, 200, 1800, 100) },
  ];
  const newWork = [
    { at: "2026-09-10T11:00:00Z", turnId: "turn-3", model: "deepseek-flash", own: usage(3000, 300, 2700, 150) },
  ];
  writeRollout(parentHome, "rollout-parent.jsonl", buildRollout({
    sessionId: "01a0c900-0000-7000-8000-0000000000a1",
    turns: inherited,
  }));
  writeRollout(forkHome, "rollout-fork.jsonl", buildRollout({
    sessionId: "01a0c900-0000-7000-8000-0000000000a2",
    turns: [...inherited, ...newWork],
  }));

  const forward = runCollector([parentHome, forkHome]);
  const reversed = runCollector([forkHome, parentHome]);
  assert.equal(forward.sessions, 2);
  assert.deepEqual(forward, reversed);
});
