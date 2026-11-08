import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// CLAUDE.md and .mex/AGENTS.md are committed as symlinks to the root AGENTS.md.
// A clone made without symlink support (Windows without Developer Mode and
// core.symlinks=true) checks them out as small text files holding the link
// target, and the agent then loads no runbook.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNBOOK_LINKS = ["CLAUDE.md", ".mex/AGENTS.md"];
const FIX = "On Windows, turn on Developer Mode and run `git config --global core.symlinks true` "
  + "before cloning, then clone again (see tests/e2e/README.md).";

function runbookLinkProblems(root) {
  const target = path.join(root, "AGENTS.md");
  const runbook = fs.readFileSync(target);
  const problems = [];
  for (const name of RUNBOOK_LINKS) {
    const file = path.join(root, ...name.split("/"));
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      problems.push(`${name} is missing; it must be a symlink to AGENTS.md. ${FIX}`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      if (fs.existsSync(file) && fs.realpathSync(file) === fs.realpathSync(target)) continue;
      problems.push(`${name} is a symlink to ${fs.readlinkSync(file)}, not to AGENTS.md. ${FIX}`);
    } else if (!stat.isFile() || !fs.readFileSync(file).equals(runbook)) {
      problems.push(`${name} is neither a symlink to AGENTS.md nor a copy of it, so the agent loads no runbook. ${FIX}`);
    }
  }
  return problems;
}

function copiedTree(t, contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccdm-checkout-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".mex"));
  fs.copyFileSync(path.join(REPO, "AGENTS.md"), path.join(root, "AGENTS.md"));
  for (const [name, content] of Object.entries(contents)) {
    fs.writeFileSync(path.join(root, ...name.split("/")), content);
  }
  return root;
}

test("CLAUDE.md and .mex/AGENTS.md in this checkout resolve to AGENTS.md", () => {
  const problems = runbookLinkProblems(REPO);
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("a runbook link checked out as a plain text file fails, naming the file and the fix", (t) => {
  const runbook = fs.readFileSync(path.join(REPO, "AGENTS.md"));
  const cases = [
    { broken: "CLAUDE.md", contents: { "CLAUDE.md": "AGENTS.md", ".mex/AGENTS.md": runbook } },
    { broken: ".mex/AGENTS.md", contents: { "CLAUDE.md": runbook, ".mex/AGENTS.md": "../AGENTS.md" } },
  ];
  for (const { broken, contents } of cases) {
    const problems = runbookLinkProblems(copiedTree(t, contents));
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.ok(problems[0].startsWith(`${broken} is neither a symlink to AGENTS.md nor a copy of it`), problems[0]);
    assert.match(problems[0], /Developer Mode/);
    assert.match(problems[0], /git config --global core\.symlinks true/);
  }
});

test("byte-identical copies of AGENTS.md are accepted", (t) => {
  const runbook = fs.readFileSync(path.join(REPO, "AGENTS.md"));
  const root = copiedTree(t, { "CLAUDE.md": runbook, ".mex/AGENTS.md": runbook });
  assert.deepEqual(runbookLinkProblems(root), []);
});

test("symlinks to AGENTS.md are accepted and symlinks elsewhere fail", (t) => {
  const root = copiedTree(t, { "OTHER.md": "other\n" });
  try {
    fs.symlinkSync("AGENTS.md", path.join(root, "CLAUDE.md"));
    fs.symlinkSync(path.join("..", "AGENTS.md"), path.join(root, ".mex", "AGENTS.md"));
  } catch (error) {
    if (error.code === "EPERM") return t.skip("this account cannot create symlinks");
    throw error;
  }
  assert.deepEqual(runbookLinkProblems(root), []);

  fs.rmSync(path.join(root, "CLAUDE.md"));
  fs.symlinkSync("OTHER.md", path.join(root, "CLAUDE.md"));
  const problems = runbookLinkProblems(root);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /^CLAUDE\.md is a symlink to OTHER\.md, not to AGENTS\.md\./);
});
