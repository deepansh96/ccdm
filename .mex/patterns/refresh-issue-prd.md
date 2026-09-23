---
name: refresh-issue-prd
description: Refresh an existing CCDM issue into a code-grounded Ralph PRD without starting implementation.
triggers:
  - "create-and-review-prd"
  - "refresh PRD"
edges:
  - target: context/architecture.md
    condition: when identifying executable boundaries and provider integrations
  - target: context/conventions.md
    condition: when selecting test seams and verifying the result
last_updated: 2026-09-24
---

# Refresh an Issue PRD

## Context

Read the issue, project `CONTEXT.md`, canonical agent anchor, applicable ADRs, and the supplied Ralph skill. Load only task-relevant mex context. Treat the issue's confirmed decisions as requirements, not invitations to expand scope.

## Steps

1. Read the step's `reviewRounds` from its workspace state; default to zero. Do not infer review count from the reviewers list.
2. Save the issue body's exact decoded text to the workspace's `original-issue.md` with exclusive creation. Never overwrite that first capture on reruns.
3. Explore the relevant Executable Surfaces and existing Local Fakes. Distinguish repository code, external provider behavior, and Instruction-Only Workflows.
4. Draft the required sections using the project vocabulary. Prefer one process-level testing seam, literal behavioral expectations, and explicit integration prerequisites where capability is unproven.
5. Run only the configured council rounds. For each, preserve pre-existing edits, check for reviewer mutations, verify feedback against sources, and retain actual reviewer attribution. Omit attribution when no round ran.
6. Check the complete draft against the original requirements, compact repetition, and update the same issue using a body file. Fetch it back and compare the complete body.

## Gotchas

- An agent's tool-start flag is not evidence that Discord accepted a message.
- Codex bridge behavior does not establish Claude plugin parity. A shared observer cannot by itself intercept messages already forwarded by another transport.
- Preserve the difference between a proposed adapter contract and an experimentally verified provider capability.
- Never copy machine-specific setup, registry values, or credential-bearing material into a public PRD.

## Verify

- Original body remains unchanged; the final issue has exactly one complete PRD.
- Review count and attribution match the rounds actually executed.
- Tests observe behavior at existing executable boundaries, with independently specified expected values.
- Record verification results and provider/history limitations without claiming the planned feature is implemented.

## Debug

If issue publication fails, retain the final body file and retry the same issue. If source requirements changed during drafting, reconcile them before overwriting the issue.

## Update Scaffold

Update runtime context only when implemented behavior changes. Record recurring planning gotchas here; do not list planned features as working.
