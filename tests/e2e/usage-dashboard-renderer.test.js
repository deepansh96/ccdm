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

function runProbe(body) {
  return spawnSync("python3", ["-c", [
    "import importlib.util, json",
    "from PIL import Image, ImageDraw",
    `spec = importlib.util.spec_from_file_location("renderer", ${JSON.stringify(script)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "image = Image.new('RGB', (1600, 1000), '#000000')",
    "draw = ImageDraw.Draw(image)",
    ...body,
  ].join("\n")], { cwd: repoDir, encoding: "utf8" });
}

function renderNotePng(target, note) {
  const input = `${target}.json`;
  fs.writeFileSync(input, JSON.stringify({
    generated_at: "2026-09-22T18:00:00Z",
    cards: [{ provider: "codex", account: "deepseek-flash", window: "Weekly", used_percent: 27, reset: "3d 5h" }],
    notes: [note],
  }));
  return { input, output: target };
}

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

test("usage dashboard renders generic notes as bounded multiline text", () => {
  const probe = runProbe([
    "notes = [",
    "    {'title': 'DeepSeek · local Codex sessions', 'tag': 'DEEPSEEK',",
    "     'lines': ['This month 12.57M tokens · 3 sessions', 'Input 12.47M · Output 100.0k',",
    "               'Cached 12.32M in · Reasoning 49.8k out', 'Local homes only · no account-wide spend']},",
    "    {'title': 'Claude API · API estimate',",
    "     'lines': ['Today  $1.2500 · 2 requests', 'This month  $3.5000 · 4 requests',",
    "               'Local estimate · no rate-limit graph']},",
    "]",
    "layout = module._rail_notes_layout(draw, notes, 1176, 1568, module.RAIL_NOTES_TOP, 940, 420)",
    "print(json.dumps({",
    "    'kinds': [entry['kind'] for entry in layout['entries']],",
    "    'lines': [entry['lines'] for entry in layout['entries']],",
    "    'heights': [entry['height'] for entry in layout['entries']],",
    "    'height': layout['height'],",
    "}))",
  ]);
  assert.equal(probe.status, 0, probe.stderr);
  const layout = JSON.parse(probe.stdout);
  // The Claude estimate keeps its dedicated two-column layout...
  assert.deepEqual(layout.kinds, ["text", "cost"]);
  // ...while the generic DeepSeek note renders every bounded line.
  assert.equal(layout.lines[0].length, 4);
  assert.deepEqual(layout.lines[1], []);
  assert.ok(layout.heights[0] > layout.heights[1], "multiline note box must grow with its lines");
  assert.ok(layout.height <= 420);
});

test("usage dashboard binds the note stack to the rail panel budget", () => {
  const probe = runProbe([
    "notes = [{'title': 'Note %d' % index, 'lines': ['x' * 220, 'y' * 220]} for index in range(10)]",
    "layout = module._rail_notes_layout(draw, notes, 1176, 1568, module.RAIL_NOTES_TOP, 940, 260)",
    "print(json.dumps({",
    "    'count': len(layout['entries']),",
    "    'cap': module.RAIL_NOTES_MAX,",
    "    'height': layout['height'],",
    "    'top': layout['entries'][0]['y'] if layout['entries'] else None,",
    "    'bottom': max((entry['y'] + entry['height'] for entry in layout['entries']), default=0),",
    "    'floor': module.RAIL_NOTES_TOP,",
    "}))",
  ]);
  assert.equal(probe.status, 0, probe.stderr);
  const layout = JSON.parse(probe.stdout);
  assert.ok(layout.count > 0);
  assert.ok(layout.count <= layout.cap);
  assert.ok(layout.height <= 260, `note stack height ${layout.height} exceeded its budget`);
  assert.ok(layout.top >= layout.floor);
  assert.ok(layout.bottom <= 940);
});

test("usage dashboard wraps overlong note lines with an explicit ellipsis", () => {
  const probe = runProbe([
    "lines = module._wrap_note_line(draw, 'token ' * 80, module._font(16), 200, 3)",
    "print(json.dumps({'lines': lines, 'widths': [module._measure(draw, line, module._font(16))[0] for line in lines]}))",
  ]);
  assert.equal(probe.status, 0, probe.stderr);
  const wrapped = JSON.parse(probe.stdout);
  assert.equal(wrapped.lines.length, 3);
  assert.ok(wrapped.widths.every((width) => width <= 200));
  assert.match(wrapped.lines.at(-1), /…$/);
});

test("usage dashboard draws multiple note lines instead of only the first", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-dashboard-notes-"));
  const single = renderNotePng(path.join(directory, "single.png"), {
    title: "DeepSeek · local Codex sessions",
    tag: "DEEPSEEK",
    lines: ["This month 12.57M tokens · 3 sessions"],
  });
  const multi = renderNotePng(path.join(directory, "multi.png"), {
    title: "DeepSeek · local Codex sessions",
    tag: "DEEPSEEK",
    lines: [
      "This month 12.57M tokens · 3 sessions",
      "Input 12.47M · Output 100.0k",
      "Cached 12.32M in · Reasoning 49.8k out",
      "Local homes only · no account-wide spend",
    ],
  });
  const repeat = renderNotePng(path.join(directory, "multi-repeat.png"), {
    title: "DeepSeek · local Codex sessions",
    tag: "DEEPSEEK",
    lines: [
      "This month 12.57M tokens · 3 sessions",
      "Input 12.47M · Output 100.0k",
      "Cached 12.32M in · Reasoning 49.8k out",
      "Local homes only · no account-wide spend",
    ],
  });
  const singleRun = await runRenderer(single.output, single.input);
  const multiRun = await runRenderer(multi.output, multi.input);
  const repeatRun = await runRenderer(repeat.output, repeat.input);
  assert.equal(singleRun.code, 0, singleRun.stderr || singleRun.stdout);
  assert.equal(multiRun.code, 0, multiRun.stderr || multiRun.stdout);
  assert.equal(repeatRun.code, 0, repeatRun.stderr || repeatRun.stdout);
  const singleBytes = fs.readFileSync(single.output);
  const multiBytes = fs.readFileSync(multi.output);
  const repeatBytes = fs.readFileSync(repeat.output);
  assert.notDeepEqual(singleBytes, multiBytes, "each note line must change the rendered image");
  assert.deepEqual(multiBytes, repeatBytes, "multiline notes stay deterministic");
});

test("usage dashboard renders the shipped DeepSeek local-usage fixture deterministically", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-dashboard-deepseek-"));
  const deepseekFixture = path.join(repoDir, "tests", "fixtures", "deepseek-usage-dashboard.json");
  const first = path.join(directory, "first.png");
  const second = path.join(directory, "second.png");
  const firstRun = await runRenderer(first, deepseekFixture);
  const secondRun = await runRenderer(second, deepseekFixture);
  assert.equal(firstRun.code, 0, firstRun.stderr || firstRun.stdout);
  assert.equal(secondRun.code, 0, secondRun.stderr || secondRun.stdout);
  const bytes = fs.readFileSync(first);
  assert.equal(bytes.readUInt32BE(16), 1600);
  assert.equal(bytes.readUInt32BE(20), 1000);
  assert.deepEqual(bytes, fs.readFileSync(second));
});

test("usage dashboard rail keeps many cards clear of multiline notes", () => {
  const probe = runProbe([
    "def build(count):",
    "    cards = [{'provider': 'codex', 'account': 'acct-%d' % index, 'window': 'Weekly',",
    "              'used_percent': (index * 7) % 100, 'reset': '3d 5h'} for index in range(count)]",
    "    notes = [{'title': 'DeepSeek · note %d' % index, 'tag': 'DEEPSEEK',",
    "              'lines': ['This month 12.57M tokens · 3 sessions',",
    "                        'Input 12.47M · Output 100.0k',",
    "                        'Cached 12.32M in · Reasoning 49.8k out']} for index in range(2)]",
    "    return module.normalize_data({'generated_at': '2026-09-22T18:00:00Z', 'cards': cards, 'notes': notes})",
    "shapes = []",
    "for count in (8, 10):",
    "    normalized = build(count)",
    "    geom = module._rail_geometry(draw, normalized, (1176, 136, 1568, 968))",
    "    repeat = module._rail_geometry(draw, normalized, (1176, 136, 1568, 968))",
    "    notes = geom['notes']['entries']",
    "    shapes.append({",
    "        'count': count,",
    "        'grouped': geom['grouped'],",
    "        'visible': geom['visible'],",
    "        'overflow': geom['overflow'],",
    "        'row_height': geom['row_height'],",
    "        'card_bottom': geom['card_bottom'],",
    "        'notes_top': min(entry['y'] for entry in notes),",
    "        'notes_bottom': max(entry['y'] + entry['height'] for entry in notes),",
    "        'panel_bottom': geom['notes_bottom'],",
    "        'notes_floor': module.RAIL_NOTES_TOP,",
    "        'deterministic': geom == repeat,",
    "    })",
    "print(json.dumps(shapes))",
  ]);
  assert.equal(probe.status, 0, probe.stderr);
  const shapes = JSON.parse(probe.stdout);
  for (const shape of shapes) {
    assert.equal(shape.grouped, false);
    assert.equal(shape.visible + shape.overflow, shape.count);
    assert.ok(shape.visible >= 1, "at least one card row must render");
    assert.ok(
      shape.card_bottom <= shape.notes_top,
      `${shape.count} cards end at ${shape.card_bottom} but notes start at ${shape.notes_top}`,
    );
    assert.ok(shape.notes_bottom <= shape.panel_bottom);
    assert.ok(shape.notes_top >= shape.notes_floor);
    assert.equal(shape.deterministic, true);
  }
  assert.ok(shapes[1].overflow > 0, "ten cards must trigger the bounded overflow marker");
});

test("usage dashboard renders many cards plus multiline notes deterministically", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-dashboard-overflow-"));
  const cards = Array.from({ length: 10 }, (_, index) => ({
    provider: "codex",
    account: `acct-${index}`,
    window: "Weekly",
    used_percent: (index * 7) % 100,
    reset: "3d 5h",
  }));
  const notes = [0, 1].map((index) => ({
    title: `DeepSeek · note ${index}`,
    tag: "DEEPSEEK",
    lines: [
      "This month 12.57M tokens · 3 sessions",
      "Input 12.47M · Output 100.0k",
      "Cached 12.32M in · Reasoning 49.8k out",
    ],
  }));
  const input = path.join(directory, "input.json");
  fs.writeFileSync(input, JSON.stringify({
    generated_at: "2026-09-22T18:00:00Z",
    cards,
    notes,
  }));
  const first = path.join(directory, "first.png");
  const second = path.join(directory, "second.png");
  const firstRun = await runRenderer(first, input);
  const secondRun = await runRenderer(second, input);
  assert.equal(firstRun.code, 0, firstRun.stderr || firstRun.stdout);
  assert.equal(secondRun.code, 0, secondRun.stderr || secondRun.stdout);
  const bytes = fs.readFileSync(first);
  assert.equal(bytes.readUInt32BE(16), 1600);
  assert.equal(bytes.readUInt32BE(20), 1000);
  assert.deepEqual(bytes, fs.readFileSync(second));
});
