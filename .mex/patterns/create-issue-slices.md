---
name: create-issue-slices
description: Publish idempotent AFK implementation sub-issues from a CCDM parent PRD.
triggers:
  - "create-and-review-slices"
  - "implementation sub-issues"
edges:
  - target: context/architecture.md
    condition: when grounding slice boundaries in executable workflows
  - target: context/conventions.md
    condition: when verifying planning artifacts and repository state
last_updated: 2026-09-24
---

# Create Implementation Slices

## Context

Follow the supplied Ralph to-tickets skill and step instructions. Read the parent PRD and comments, project vocabulary, agent anchor, and applicable ADRs. Planning must not claim the feature is implemented or deploy it.

## Steps

1. Read this step's `reviewRounds`; missing means zero. Skip the interactive quiz in the AFK pipeline and run only the configured council rounds.
2. Inspect native parent sub-issues and all repository issues referencing the parent, including closed issues. Match intended behavior before creating anything; reuse or update matching issues. Check whether closed slices are already implemented before changing their state.
3. Ground each slice in one executable user/operator workflow with acceptance criteria, process-level Local Fake tests, write boundaries, and exclusions. Unproven provider compatibility belongs in an explicit prerequisite with observable proof, not an assumed capability.
4. Declare only genuine blockers. Separate parallel module/test ownership; do not serialize unrelated work solely because it shares a repository. Keep small preparatory extractions with the behavior they enable unless a standalone prefactor is warranted.
5. For configured council rounds, snapshot status, enforce read-only review, verify feedback against source, and preserve pre-existing edits. Record actual reviewer attribution; do not invent reviewers when review is skipped.
6. Create/reuse issues in dependency order using body files. Include `AFK: true`, the parent reference, and actual GitHub issue numbers for blockers. Record each issue immediately so interrupted publication can resume without duplicates.
7. Link missing parent relationships with GraphQL `addSubIssue`. Reconcile native blocker edges in both directions using numeric database IDs, distinct from issue numbers and GraphQL node IDs.
8. Fetch back all bodies, parent links, and native edges. Write the final workspace slice plan with creation/reuse/link status and any dependency API limitation. Do not modify or close the parent PRD.

## Gotchas

- Markdown parent references alone do not create native sub-issues.
- Stale native blockers can stop AFK implementation even when body references are correct.
- Preserve unresolved compatibility gates; an unsupported-provider report is not successful completion of a provider implementation prerequisite.
- Keep credentials, machine-local IDs, and local access instructions out of public issue bodies.

## Verify

- Every final slice exists, is AFK, and is natively linked under the parent.
- Body blocker numbers and native dependency sets agree, or the API limitation is recorded.
- Review count/attribution matches state, and the dependency graph has no cycles or unexplained edges.
- Existing edits remain intact; record repository verification and run mex check after scaffold edits.

## Update Scaffold

Update runtime context only when implemented behavior changes. Keep planning-specific recurring lessons in this pattern.
