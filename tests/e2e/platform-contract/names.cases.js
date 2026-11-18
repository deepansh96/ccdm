import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const WIN = process.platform === "win32";
const CONTENT = "the attachment's bytes";
const safeName = { node: "paths.safeFileName", python: "paths.safe_name" };
const { safeFileName } = createRequire(import.meta.url)("../../../scripts/platform/paths.js");

const a = count => "a".repeat(count);
const same = Symbol("unchanged");

// [input, expected on win32, expected on POSIX]
const names = [
  // Forbidden characters. POSIX writes every one of these today, so keeps them.
  ["notes.txt:payload", "notes.txtpayload", same],
  ["report?.pdf", "report.pdf", same],
  ["a<b>.txt", "ab.txt", same],
  ["q\"uote|pipe*.txt", "quotepipe.txt", same],
  ["a\\b.txt", "ab.txt", same],
  ["a\u0001b\u001f\u007f.txt", "ab.txt", same],

  // Device names, in any case, with or without an extension.
  ["CON", "file", same],
  ["con", "file", same],
  ["PRN", "file", same],
  ["AUX.txt", "file.txt", same],
  ["CON.txt", "file.txt", same],
  ["NUL.tar.gz", "file.tar.gz", same],
  ["CON .txt", "file.txt", same],
  ["CON.", "file", same],
  ["CONIN$", "file", same],
  ["conout$.log", "file.log", same],
  ["COM1", "file", same],
  ["COM9.txt", "file.txt", same],
  ["LPT1", "file", same],
  ["LPT9.txt", "file.txt", same],
  ["COM¹", "file", same],
  ["COM².txt", "file.txt", same],
  ["LPT³", "file", same],

  // Close to a device name, but not one.
  ["COM0", same, same],
  ["COM10.txt", same, same],
  ["CONSOLE.txt", same, same],
  ["xCON", same, same],
  ["CONıN$", same, same],
  ["a.CON", same, same],

  // Trailing dots and spaces.
  ["name. ", "name", same],
  ["name...", "name", same],
  ["...", "file", same],
  ["   ", "file", same],
  [" leading.txt", same, same],

  // Nothing left.
  ["???", "file", same],
  ["<>:\"|?*", "file", same],
  ["", "file", "file"],
  [".", "file", "file"],
  ["..", "file", "file"],
  ["/", "file", "file"],
  [null, "file", "file"],

  // Separators never survive.
  ["../../x", "....x", "x"],
  ["a/b/", "ab", "b"],

  // A NUL can never be written anywhere.
  ["a\0b.txt", "ab.txt", "ab.txt"],
  [".\0.", "file", "file"],

  // Ordinary names.
  ["plain.txt", same, same],
  [".hidden", same, same],
  ["日本語.txt", same, same],

  // The caps: 120 code points on win32, 255 UTF-8 bytes on POSIX.
  [`${a(116)}.txt`, same, same],
  [`${a(251)}.txt`, `${a(116)}.txt`, same],
  [`${a(296)}.txt`, `${a(116)}.txt`, `${a(251)}.txt`],
  [a(300), a(120), a(255)],
  [`${a(119)} ${"b".repeat(50)}`, a(119), same],
  [`a.${"b".repeat(300)}`, `a.${"b".repeat(118)}`, `a.${"b".repeat(253)}`],
  ["\u{1f600}".repeat(130) + ".txt", `${"\u{1f600}".repeat(116)}.txt`, `${"\u{1f600}".repeat(62)}.txt`],
  ["日".repeat(100), same, "日".repeat(85)],

  // A device name the cut exposes, and a replacement that must stay in the cap.
  [`CONxxxxxx.${"e".repeat(116)}`, `fil.${"e".repeat(116)}`, same],
  [`CON.${"e".repeat(116)}`, `fil.${"e".repeat(116)}`, same],
];

// `dir /r` lists alternate data streams as `name:stream:$DATA`. It prints that
// suffix in every display language.
function dataStreams(dir) {
  const listing = spawnSync("cmd.exe", ["/d", "/c", "dir", "/r", dir], { encoding: "utf8", windowsHide: true });
  assert.equal(listing.status, 0, listing.stderr);
  return listing.stdout.split(/\r?\n/).filter(line => line.includes(":$DATA"));
}

function label(input) {
  const shown = JSON.stringify(input);
  return shown.length > 40 ? `${shown.slice(0, 37)}..." (${input.length})` : shown;
}

export default [
  ...names.map(([input, win32, posix]) => {
    const expected = WIN ? win32 : posix;
    return {
      name: `safe name of ${label(input)}`,
      ...safeName,
      args: [input],
      value: expected === same ? input : expected,
      check({ node }, ctx) {
        const dir = path.join(ctx.dir, "downloads");
        fs.mkdirSync(dir);
        const target = path.join(dir, node.value);
        assert.equal(path.dirname(target), dir);
        fs.writeFileSync(target, CONTENT);
        assert.deepEqual(fs.readdirSync(dir), [node.value]);
        assert.ok(fs.lstatSync(target).isFile());
        assert.equal(fs.readFileSync(target, "utf8"), CONTENT);
        if (WIN) assert.deepEqual(dataStreams(dir), []);
      },
    };
  }),
  {
    name: "the stream check sees the stream a raw name writes",
    only: "win32",
    check(_outcomes, ctx) {
      const dir = path.join(ctx.dir, "downloads");
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "notes.txt:payload"), CONTENT);
      assert.deepEqual(fs.readdirSync(dir), ["notes.txt"]);
      assert.equal(fs.statSync(path.join(dir, "notes.txt")).size, 0);
      assert.equal(dataStreams(dir).length, 1);
    },
  },
  {
    name: "a smaller win32 cap is honoured and POSIX ignores it",
    ...safeName,
    nodeArgs: ["abcdefghijklmnop.txt", { max: 10 }],
    pythonArgs: ["abcdefghijklmnop.txt", 10],
    value: WIN ? "abcdef.txt" : "abcdefghijklmnop.txt",
  },
  {
    name: "a lone surrogate counts the same in both languages",
    ...safeName,
    args: [`${"\ud83d".repeat(130)}.txt`],
    value: WIN ? `${"\ud83d".repeat(116)}.txt` : `${"\ud83d".repeat(83)}.txt`,
  },
  {
    name: "a safe name is already safe",
    check() {
      for (const [input] of names) {
        const once = safeFileName(input);
        assert.equal(safeFileName(once), once, `not stable for ${label(input)}`);
      }
    },
  },
];
