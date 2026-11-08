import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const WIN = process.platform === "win32";
const DAY_MS = 24 * 60 * 60 * 1000;

// Windows sweeps the shared root under the state root; POSIX leaves its temp
// directory alone, so the same planted directories must all survive there.
const tmpRoot = ctx => WIN ? path.join(ctx.dir, "root", "tmp") : path.join(ctx.dir, "posix-tmp");

function plantDir(root, name, ageDays) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(dir, "attachments", "a.txt"), "body");
  const when = new Date(Date.now() - ageDays * DAY_MS);
  fs.utimesSync(dir, when, when);
  return dir;
}

export default [
  {
    name: "a new temp directory removes only its own prefix's directories older than 7 days, and only on Windows",
    node: "privacy.privateTmpDir",
    setup(ctx) {
      const root = tmpRoot(ctx);
      fs.mkdirSync(root, { recursive: true });
      const outside = path.join(ctx.dir, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
      const link = path.join(root, "discord-recent-link");
      fs.symlinkSync(outside, link, "junction");
      return {
        old: plantDir(root, "discord-recent-old", 8),
        young: plantDir(root, "discord-recent-young", 6),
        otherPrefix: plantDir(root, "discord-export-old", 8),
        keep: path.join(outside, "keep.txt"),
        link,
      };
    },
    env: ctx => ({ CCDM_STATE_ROOT: path.join(ctx.dir, "root"), TMPDIR: tmpRoot(ctx) }),
    args: ["discord-recent-"],
    check({ node }, ctx, planted) {
      assert.equal(path.dirname(node.value), tmpRoot(ctx));
      assert.match(path.basename(node.value), /^discord-recent-/);
      assert.equal(fs.existsSync(node.value), true);
      assert.equal(fs.existsSync(planted.old), !WIN);
      assert.equal(fs.existsSync(planted.young), true);
      assert.equal(fs.existsSync(planted.otherPrefix), true);
      assert.equal(fs.lstatSync(planted.link).isSymbolicLink(), true);
      assert.equal(fs.readFileSync(planted.keep, "utf8"), "keep");
    },
  },
];
