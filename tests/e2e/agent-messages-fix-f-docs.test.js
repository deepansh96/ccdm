// Documentation contract test for PR #409 worker F (finding 10):
// README.md and .mex/patterns/manage-agent-message-grants.md list every
// refusal code the Router can return for agent_request, agent_reply, and
// agent_targets, and README.md accurately explains unknown_target and
// ambiguous_target instead of claiming an unknown target returns not_granted.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// Literal list from PRD #387 and the Router implementation
// (scripts/router/agent-messages/index.js, ledger.js, and server.js).
const AGENT_MESSAGE_REFUSAL_CODES = [
  "invalid_args",
  "forbidden",
  "ledger_unavailable",
  "not_granted",
  "unknown_target",
  "ambiguous_target",
  "text_too_long",
  "request_rate_exceeded",
  "open_requests_exceeded",
  "depth_exceeded",
  "target_closed",
  "target_offline",
  "unknown_request",
  "request_expired",
  "already_replied",
  "request_failed",
];

function sectionRange(lines, heading) {
  const start = lines.indexOf(heading);
  if (start < 0) return null;
  const level = heading.match(/^#+/)[0].length;
  const next = lines.findIndex((line, i) => i > start && new RegExp(`^#{1,${level}} `).test(line));
  return [start, next < 0 ? lines.length : next];
}

test("README Agent Messages refusal table and grant pattern cover every refusal code accurately", () => {
  const readme = fs.readFileSync("README.md", "utf8");
  const readmeLines = readme.split(/\r?\n/);
  const agentRange = sectionRange(readmeLines, "## Agent Messages");
  assert.ok(agentRange, 'README.md is missing "## Agent Messages"');
  const agentSection = readmeLines.slice(agentRange[0], agentRange[1]).join("\n");

  // Must no longer falsely claim that an unknown target returns not_granted.
  assert.doesNotMatch(
    agentSection,
    /ungranted or unknown target returns\s+`?not_granted`?/i,
    "README.md still claims an unknown target returns not_granted",
  );

  // Must have a refusal codes table inside ## Agent Messages covering every code.
  const refusalRange = sectionRange(readmeLines.slice(agentRange[0], agentRange[1]), "### Refusal codes");
  assert.ok(refusalRange, 'README.md "## Agent Messages" is missing "### Refusal codes"');
  const refusalSection = readmeLines
    .slice(agentRange[0] + refusalRange[0], agentRange[0] + refusalRange[1])
    .join("\n");

  for (const code of AGENT_MESSAGE_REFUSAL_CODES) {
    assert.match(
      refusalSection,
      new RegExp(`^\\|\\s*\`${code}\`\\s*\\|`, "m"),
      `README.md refusal-codes table is missing row for ${code}`,
    );
  }

  // .mex/patterns/manage-agent-message-grants.md must list every refusal code too.
  const grantPattern = fs.readFileSync(".mex/patterns/manage-agent-message-grants.md", "utf8");
  for (const code of AGENT_MESSAGE_REFUSAL_CODES) {
    assert.match(
      grantPattern,
      new RegExp(`\`${code}\``),
      `.mex/patterns/manage-agent-message-grants.md is missing ${code}`,
    );
  }
});
