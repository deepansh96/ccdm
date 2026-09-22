import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const repoDir = path.resolve(".");
const script = path.join(repoDir, "scripts", "usage-dashboard-renderer.py");
const fixture = path.join(repoDir, "tests", "fixtures", "usage-dashboard.json");

function runRenderer(output, input = fixture) {
  return new Promise((resolve) => {
    const child = spawn("python3", [script, "--input", input, "--output", output], {
      cwd: repoDir,
      env: { ...process.env, PYTHONHASHSEED: "0" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("usage dashboard renderer produces a deterministic PNG for multi-account history", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-dashboard-"));
  const first = path.join(directory, "first.png");
  const second = path.join(directory, "second.png");
  const firstRun = await runRenderer(first);
  const secondRun = await runRenderer(second);
  assert.equal(firstRun.code, 0, firstRun.stderr || firstRun.stdout);
  assert.equal(secondRun.code, 0, secondRun.stderr || secondRun.stdout);
  assert.match(firstRun.stdout.trim(), /first\.png$/);
  const firstBytes = fs.readFileSync(first);
  const secondBytes = fs.readFileSync(second);
  assert.deepEqual(firstBytes, secondBytes);
  assert.equal(firstBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(firstBytes.readUInt32BE(16), 1600);
  assert.equal(firstBytes.readUInt32BE(20), 1000);
  assert.equal(crypto.createHash("sha256").update(firstBytes).digest("hex"), crypto.createHash("sha256").update(secondBytes).digest("hex"));
});

test("usage dashboard renderer accepts stdin and keeps unavailable data non-fatal", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-dashboard-"));
  const output = path.join(directory, "stdin.png");
  const child = spawn("python3", [script, "--input", "-", "--output", output], { cwd: repoDir });
  const payload = JSON.stringify({
    generated_at: "2026-08-18T20:30:00Z",
    cards: [{ key: "claude_5h", label: "Claude", window: "5-hour", available: false, reason: "No token" }],
    history: [{ at: "2026-08-18T20:30:00Z", claude_5h: null }],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(payload);
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  assert.ok(fs.statSync(output).size > 1000);
});

test("usage dashboard chart omits history-empty series but keeps rail cards", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("renderer", ${JSON.stringify(script)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    `data = json.load(open(${JSON.stringify(fixture)}, encoding="utf-8"))`,
    "normalized = module.normalize_data(data)",
    "chart = module._chart_cards(normalized)",
    "print(json.dumps({'rail': len(normalized['cards']), 'chart': [card['key'] for card in chart]}))",
  ].join("\n")], { cwd: repoDir, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), {
    rail: 5,
    chart: [
      "claude:personal:5_hour",
      "claude:personal:7_day",
      "codex:primary:5_hour",
      "codex:primary:7_day",
    ],
  });
});

test("usage dashboard rail groups windows by provider and account", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("renderer", ${JSON.stringify(script)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    `data = json.load(open(${JSON.stringify(fixture)}, encoding="utf-8"))`,
    "groups = module._rail_groups(module.normalize_data(data)[\"cards\"])",
    "print(json.dumps([len(group) for group in groups]))",
  ].join("\n")], { cwd: repoDir, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), [2, 1, 2]);
});

test("usage dashboard rail subtitle summarizes every current limit window", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("renderer", ${JSON.stringify(script)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    `data = json.load(open(${JSON.stringify(fixture)}, encoding="utf-8"))`,
    "cards = module.normalize_data(data)['cards']",
    "cases = [",
    "    module._availability_summary(cards),",
    "    module._availability_summary([{'available': True}, {'available': True}]),",
    "    module._availability_summary([]),",
    "]",
    "print(json.dumps(cases))",
  ].join("\n")], { cwd: repoDir, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), [
    "4 of 5 limits available",
    "All limits available",
    "No limits available",
  ]);
});

test("usage dashboard chart spaces snapshots by elapsed time", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("renderer", ${JSON.stringify(script)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "history = [{\"at\": \"2026-08-18T15:50:00Z\"}, {\"at\": \"2026-08-18T17:20:00Z\"}, {\"at\": \"2026-08-18T17:30:00Z\"}]",
    "print(json.dumps(module._history_x_positions([{'at': module._time(item['at'])} for item in history], 0, 100)))",
  ].join("\n")], { cwd: repoDir, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), [0, 90, 100]);
});

test("usage dashboard chart drops clustered interior ticks but keeps boundaries", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("renderer", ${JSON.stringify(script)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "history = [{} for _ in range(5)]",
    "positions = [0, 733, 815, 897, 979]",
    "print(json.dumps(module._history_tick_indexes(history, positions)))",
  ].join("\n")], { cwd: repoDir, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), [0, 1, 4]);
});

test("usage dashboard heading reflects valid history coverage", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("renderer", ${JSON.stringify(script)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "point = lambda at: {'at': module._time(at)}",
    "cases = [",
    "    [point('2026-08-18T15:30:00Z'), point('2026-08-18T17:30:00Z')],",
    "    [point('2026-08-17T20:30:00Z'), point('2026-08-18T19:30:00Z')],",
    "    [point('2026-08-01T00:00:00Z'), point('2026-08-19T00:00:00Z')],",
    "    [{'at': None}, point('2026-08-18T16:00:00Z'), {'at': 'invalid'}, point('2026-08-18T17:30:00Z')],",
    "    [{'at': None}, point('2026-08-18T17:30:00Z')],",
    "]",
    "print(json.dumps([module._history_coverage_label(history) for history in cases]))",
  ].join("\n")], { cwd: repoDir, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), [
    "LAST 2 HOURS",
    "24-HOUR TRAJECTORY",
    "LAST 18 DAYS",
    "LAST 1 HOUR 30 MINUTES",
    "RECENT SNAPSHOT",
  ]);
});

test("usage dashboard uses dates on ticks when the history crosses days", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("renderer", ${JSON.stringify(script)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "print(json.dumps([module._history_tick_label(module._time('2026-08-18T23:30:00Z'), True), module._history_tick_label(module._time('2026-08-18T23:30:00Z'), False)]))",
  ].join("\n")], { cwd: repoDir, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), ["Aug 18\n11:30 PM", "11:30 PM"]);
});

test("usage dashboard rail leaves a gap below the full-width value glyph", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("renderer", ${JSON.stringify(script)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "font = module._font(34)",
    "value_y, bar_y = module._rail_value_layout(100, font)",
    "value_bottom = value_y + font.getbbox('100%')[3]",
    "print(json.dumps({'value_y': value_y, 'value_bottom': value_bottom, 'bar_y': bar_y}))",
  ].join("\n")], { cwd: repoDir, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const layout = JSON.parse(probe.stdout);
  assert.equal(layout.value_y, 96);
  assert.ok(layout.bar_y >= layout.value_bottom + 6);
});

test("usage dashboard reset annotations deduplicate markers and avoid label collisions", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("renderer", ${JSON.stringify(script)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "layout = module._reset_annotation_layout([100, 104, 500, 500], 100, 600, 44)",
    "print(json.dumps(layout))",
  ].join("\n")], { cwd: repoDir, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const layout = JSON.parse(probe.stdout);
  assert.equal(layout.length, 3);
  assert.deepEqual(layout.map(([anchor]) => anchor), [100, 104, 500]);
  assert.ok(layout.every(([, textX]) => textX >= 100 && textX + 44 <= 600));
  const sameLane = layout.filter(([, , lane]) => lane === 0);
  assert.deepEqual(sameLane.map(([anchor]) => anchor), [100, 500]);
});

test("usage dashboard chart insets percentage extrema while preserving linear mapping", () => {
  const probe = spawnSync("python3", ["-c", [
    "import importlib.util, json",
    `spec = importlib.util.spec_from_file_location("renderer", ${JSON.stringify(script)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "outer = (100, 500)",
    "bounds = module._plot_y_bounds(*outer)",
    "values = [module._plot_y(percent, *outer) for percent in (0, 25, 50, 75, 100)]",
    "print(json.dumps({'inset': module.PLOT_VERTICAL_INSET, 'bounds': bounds, 'values': values}))",
  ].join("\n")], { cwd: repoDir, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  const mapping = JSON.parse(probe.stdout);
  assert.equal(mapping.inset, 10);
  assert.deepEqual(mapping.bounds, [110, 490]);
  assert.deepEqual(mapping.values, [490, 395, 300, 205, 110]);
  assert.ok(mapping.values[0] + 8 <= 500);
  assert.ok(mapping.values[4] - 8 >= 100);
  assert.equal(mapping.values[1] - mapping.values[2], mapping.values[2] - mapping.values[3]);
});
