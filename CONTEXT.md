# CCDM

CCDM manages Discord-connected coding-agent sessions by assigning project bots, isolating them to project channels, and starting or stopping their local runtimes.

## Language

**End-to-End Test Suite**:
Tests that execute CCDM's real command and bridge surfaces across realistic workflows, while replacing external services with local fakes by default.
_Avoid_: unit coverage, atomic tests, coverage target

**Live Smoke Suite**:
An opt-in set of E2E tests that touches real Discord, Claude, Codex, tmux, and user credentials.
_Avoid_: default CI tests, required tests

**Local Fake**:
A test-controlled substitute for an external service such as Discord, Claude, Codex, or Anthropic OAuth APIs.
_Avoid_: mock when referring to the whole service boundary

**Executable Surface**:
A CCDM command, script, or bridge process that exists as runnable code in this repository.
_Avoid_: root-agent intent, conversational command

**Root-Agent Conversation**:
The Discord interaction where a language-model operator interprets CCDM instructions and performs management actions.
_Avoid_: command handler, deterministic API

**Instruction-Only Workflow**:
A CCDM behavior documented for the root agent but not yet implemented as reusable executable code.
_Avoid_: tested command, script behavior

**Phase-One Workflow Matrix**:
The first comprehensive E2E scope covering CCDM's existing executable setup, session lifecycle, Codex bridge, Discord MCP, usage, nickname, and restart surfaces.
_Avoid_: full product coverage, root-agent instruction coverage

**Harness**:
The Node-based E2E test system that runs CCDM executable surfaces in controlled temporary workspaces.
_Avoid_: unit test framework, coverage tool

**Fixture Binary**:
A test-controlled executable placed earlier on `PATH` to simulate a system tool such as `tmux`, `claude`, `codex`, `security`, or `curl`.
_Avoid_: service fake

**Contract-Checking Fake**:
A stateful local fake that validates requests and records observable side effects at an external service boundary.
_Avoid_: canned stub, happy-path mock

**Test Workspace**:
A temporary isolated repo and home directory used by an E2E run.
_Avoid_: developer checkout, real home directory

**Live Gate**:
An explicit opt-in environment setting that allows tests to use real credentials or external services.
_Avoid_: default test switch, CI default

**Default CI Suite**:
The local-fake E2E suite that must run automatically for ordinary pushes and pull requests.
_Avoid_: live smoke, manual validation

**Feature Regression**:
E2E coverage for behavior that is already implemented and intended to remain stable.
_Avoid_: speculative feature test, future behavior

**Extraction Follow-Up**:
A separate issue to turn an instruction-only root-agent workflow into executable code that deterministic E2E can cover later.
_Avoid_: phase-one requirement

**Black-Box Harness**:
An E2E harness that tests current executable behavior without requiring production-code changes.
_Avoid_: testability refactor, code extraction

**Process-Level Interception**:
Testing current executables by controlling environment, `PATH`, `HOME`, working directories, and child-process dependencies from outside the production code.
_Avoid_: production test hook, source patch

**E2E Deliverable**:
A runnable test harness, scenario suite, CI integration, and contributor documentation for CCDM's executable workflows.
_Avoid_: tests only, undocumented harness

**Default Acceptance Bar**:
The minimum pass/fail standard for the local-fake E2E suite to be considered complete.
_Avoid_: coverage percentage, unit-test count

## Relationships

- The **End-to-End Test Suite** uses **Local Fakes** by default.
- The **Live Smoke Suite** verifies a narrow subset of workflows against real external services.
- The **End-to-End Test Suite** drives **Executable Surfaces** directly by default.
- A **Root-Agent Conversation** is covered by the **Live Smoke Suite**, not the default deterministic E2E suite.
- **Instruction-Only Workflows** are outside the first E2E phase until they are extracted into **Executable Surfaces**.
- The **Phase-One Workflow Matrix** defines comprehensive coverage for current **Executable Surfaces**.
- The **Harness** uses `node:test` and **Fixture Binaries** to run executable workflows without depending on host tools or credentials.
- **Local Fakes** should be **Contract-Checking Fakes** when the external boundary has meaningful protocol or state.
- Default E2E runs use a **Test Workspace** and never read or write real CCDM state, Claude/Codex state, tmux sessions, keychain entries, or Discord credentials.
- A **Live Gate** is required before any **Live Smoke Suite** test may use real external services.
- The **Default CI Suite** runs the full local-fake E2E suite without real external services.
- The **Live Smoke Suite** stays narrow and checks only real-boundary drift such as Discord visibility, one session round trip, attachments, and cleanup.
- A **Feature Regression** belongs in the suite only after the feature exists.
- **Instruction-Only Workflows** should become **Extraction Follow-Ups**, not hidden scope inside the E2E suite issue.
- The initial E2E suite is a **Black-Box Harness** and must not require production-code refactors.
- A **Black-Box Harness** uses **Process-Level Interception** to replace host tools and isolate state.
- The E2E initiative must produce an **E2E Deliverable**, not only test files.
- The **Default Acceptance Bar** requires isolated execution, phase-one workflow coverage, readable diagnostics, CI execution, and live-smoke skipping unless gated.

## Example Dialogue

> **Dev:** "Should the E2E tests create real Discord bots every run?"
> **Domain expert:** "No. The **End-to-End Test Suite** should run against **Local Fakes** by default; only the **Live Smoke Suite** may touch real Discord."

> **Dev:** "Should the default suite message the root bot and wait for the agent to decide what to do?"
> **Domain expert:** "No. It should drive the **Executable Surfaces** directly; **Root-Agent Conversation** belongs in the opt-in smoke path."

> **Dev:** "Should phase one test register and pool-add exactly as written in `CLAUDE.md`?"
> **Domain expert:** "Only where those behaviors exist as **Executable Surfaces**. **Instruction-Only Workflows** need extraction before deterministic E2E can cover them."

> **Dev:** "What does comprehensive mean before register and pool-add are extracted?"
> **Domain expert:** "It means the **Phase-One Workflow Matrix** fully exercises setup, session lifecycle, bridge, MCP, usage, nickname, and restart behavior that is already executable."

> **Dev:** "Do we need Jest or Vitest for this?"
> **Domain expert:** "No. The **Harness** can use `node:test`; the important pieces are temporary workspaces, fake services, and **Fixture Binaries**."

> **Dev:** "Can the fake Discord API just return 200 for everything?"
> **Domain expert:** "No. It should be a **Contract-Checking Fake** that records messages, uploads, reactions, permission changes, and rejects malformed requests."

> **Dev:** "Can default E2E tests use my real `~/.claude` and `registry.json`?"
> **Domain expert:** "No. They must run in a **Test Workspace**. Real credentials and state require a **Live Gate**."

> **Dev:** "Should GitHub Actions run the live Discord smoke tests on every PR?"
> **Domain expert:** "No. The **Default CI Suite** runs local-fake E2E. Live Discord checks require a **Live Gate**."

> **Dev:** "Should live smoke repeat every local-fake scenario?"
> **Domain expert:** "No. The **Live Smoke Suite** should stay narrow and catch integration drift at real boundaries."

> **Dev:** "Should issue #2 be an acceptance criterion for this E2E suite?"
> **Domain expert:** "No. That behavior is not built yet, so it is not a **Feature Regression** for this suite."

> **Dev:** "Should the E2E suite implement register, deregister, pool, polls, and context report command modules first?"
> **Domain expert:** "No. Those should be **Extraction Follow-Ups** where they are still **Instruction-Only Workflows**."

> **Dev:** "Can the E2E issue change `codex-bridge.js` or the shell scripts to add test hooks?"
> **Domain expert:** "No. The initial scope is a **Black-Box Harness** around current executable behavior."

> **Dev:** "How do tests handle hardcoded commands and endpoints without production hooks?"
> **Domain expert:** "Use **Process-Level Interception** where possible and explicitly document any hardcoded-boundary coverage that must wait for live smoke or future extraction."

> **Dev:** "Is it enough to add test files?"
> **Domain expert:** "No. The result should be an **E2E Deliverable** with run scripts, CI, and documentation for extending the harness."

> **Dev:** "How do we know the default E2E suite is done?"
> **Domain expert:** "It meets the **Default Acceptance Bar**: isolated local-fake execution, phase-one workflow coverage, diagnostics, CI, and gated live smoke."

## Flagged Ambiguities

- "End-to-end" could mean real third-party services for every run or real CCDM workflows with fake external boundaries. Resolved: default E2E uses real CCDM scripts and bridges with **Local Fakes**, while **Live Smoke Suite** is opt-in.
- "Command" could mean an executable script or a natural-language Discord request handled by the root agent. Resolved: default E2E targets **Executable Surfaces**; conversational behavior is smoke-tested.
- "Comprehensive" could imply covering every documented root-agent instruction immediately. Resolved: phase one comprehensively covers current **Executable Surfaces** and tracks **Instruction-Only Workflows** as future extraction work.
- "Black-box" does not mean every external boundary can be fully faked without source hooks. Resolved: use **Process-Level Interception** where possible and document hardcoded-boundary limitations explicitly.
