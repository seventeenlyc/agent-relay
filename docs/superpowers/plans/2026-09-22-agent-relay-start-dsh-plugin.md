# Agent Relay Start and DSH Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a foreground `agent-relay start` command for Codex, Claude, and a dynamically loaded DSH plugin without coupling DSH into the core CLI.

**Architecture:** Keep Codex and Claude runtime factories in the CLI integration layer. Define a small runtime factory contract and implement it in `integrations/dsh-plugin.mjs`; the DSH host-facing `apply(ctx)` event bridge remains side-effect free unless an event-log path is configured. The command creates the existing `RunController`, runs it to a terminal outcome, and always shuts down the adapter and database.

**Tech Stack:** Node.js 24 ESM, `node:test`, native SQLite already used by the repository, existing `AgentRelayAdapter`, `RunController`, and DSH JSON-RPC mock fixture.

**Spec:** `docs/superpowers/specs/2026-09-22-agent-relay-start-dsh-plugin-design.md`

## Global Constraints

- Preserve the existing `AgentRelayAdapter` and `RunController` contracts.
- Keep one active writer per normalized workspace.
- Do not add third-party runtime dependencies.
- Do not silently fall back from a missing or invalid DSH plugin to an in-process DSH adapter.
- Do not modify the pre-existing untracked `.dsh/` user configuration during tests.
- Do not claim real DSH host loading until only contract/mock evidence exists.

---

### Task 1: Define the start command contract

**Files:**
- Create: `packages/cli/src/start.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `tests/cli/start.test.ts`

**Interfaces:**
- Produces `start` argument parsing with required `--target`, `--workspace`, `--goal`, and `--prompt`.
- Produces target validation that accepts only `codex`, `claude`, and `dsh`.
- Produces task-file parsing with a default single `main` task.

- [x] Write tests for missing required arguments, invalid targets, default task creation, and valid task-file loading.
- [x] Run `node --experimental-strip-types --test tests/cli/start.test.ts` and verify it fails because the command and parser do not exist.
- [x] Add the smallest parser and task normalization helpers while keeping existing status/control parsing unchanged.
- [x] Run the focused test and verify it passes.
- [x] Run the existing CLI tests to ensure status/control behavior is unchanged.

### Task 2: Add runtime factories for built-in targets

**Files:**
- Create: `packages/cli/src/runtime.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `tests/cli/runtime.test.ts`

**Interfaces:**
- `createBuiltInRuntime(target, options)` returns `{ adapter, adapterName, createCoordinator, shutdown }` for `codex` and `claude`.
- The factory owns adapter-specific handshake selection and exposes one shutdown method to the CLI.

- [x] Write tests using the existing mock Codex and Claude runners to assert target-to-adapter and target-to-coordinator mapping.
- [x] Run the focused runtime test and verify it fails because the runtime module does not exist.
- [x] Implement the built-in factory with `CodexAdapter`/`CodexHandshakeCoordinator` and `ClaudeAdapter`/`TwoPhaseHandshakeCoordinator`.
- [x] Make shutdown idempotent and close only resources owned by the factory.
- [x] Run the focused runtime test and the existing adapter contract tests.

### Task 3: Implement the DSH plugin entry

**Files:**
- Create: `integrations/dsh-plugin.mjs`
- Create: `integrations/dsh-plugin-manifest.json`
- Test: `tests/integrations/dsh-plugin.test.ts`

**Interfaces:**
- `pluginManifest` identifies `agent-relay-dsh`, protocol version `1`, and target `dsh`.
- `createRuntime({ cwd, dataDir })` dynamically constructs `DshAdapter` and `DshHandshakeCoordinator` and returns the common runtime shape.
- `apply(ctx)` subscribes only to the observed `session/event` hook and writes JSONL only when `AGENT_RELAY_EVENT_LOG` is set.

- [x] Write a test that imports the manifest and rejects an invalid manifest shape.
- [x] Write a test with the existing mock DSH server that calls `createRuntime`, creates a fresh session, and shuts it down without leaking the worker.
- [x] Write a test that invokes `apply` with a fake context, emits a session event, and verifies the opt-in event log.
- [x] Run the focused plugin tests and verify they fail because the plugin entry and manifest do not exist.
- [x] Implement the plugin using only repository modules and Node built-ins; do not duplicate DSH protocol code.
- [x] Run the focused plugin tests and the existing DSH adapter/handshake tests.

### Task 4: Wire dynamic DSH loading and foreground execution

**Files:**
- Modify: `packages/cli/src/runtime.ts`
- Modify: `packages/cli/src/cli.ts`
- Test: `tests/cli/start.test.ts`

**Interfaces:**
- `loadDshRuntime(pluginPath, options)` imports the plugin, validates the manifest and required `createRuntime` export, and returns the common runtime shape.
- `runStart(args, deps)` creates the database/controller, starts the run, executes until settled, prints run ID and outcomes, and returns a deterministic exit code.

- [x] Add tests for dynamic DSH plugin loading, invalid plugin rejection, controller start invocation, and shutdown on execution failure.
- [x] Run the focused start tests and verify the new cases fail before wiring.
- [x] Implement `runStart` with `try/finally` resource ownership and no detached child processes.
- [x] Map terminal outcomes to documented exit codes and reject `--target=all` for `start`.
- [x] Run all CLI, plugin, and adapter tests.

### Task 5: Register the DSH plugin through the installer

**Files:**
- Modify: `packages/installer/src/targets/dsh.ts`
- Modify: `packages/installer/src/uninstaller.ts`
- Test: `tests/installer/targets.test.ts`
- Test: `tests/installer/uninstaller.test.ts`

**Interfaces:**
- Workspace DSH config registers `{ id: 'agent-relay', entry: '<repo>/integrations/dsh-plugin.mjs', managedBy: 'agent-relay' }` without duplicating existing plugins.
- Uninstall removes only the managed Agent Relay entry and preserves other DSH plugins and user fields.

- [x] Extend installer tests to assert the plugin entry path and managed marker.
- [x] Run the focused installer tests and verify the new assertion fails against the placeholder entry.
- [x] Implement entry registration using the repository root supplied to the installer; keep global installation explicit.
- [x] Update uninstall matching to remove only Agent Relay's managed entry and retain unrelated entries.
- [x] Run all installer tests.

### Task 6: Document and verify the new entry point

**Files:**
- Modify: `docs/delivery/release-notes-v1.0.md`
- Modify: `docs/delivery/final-acceptance-report.md`
- Modify: `packages/cli/src/cli.ts`
- Test: `tests/acceptance/start-entry.test.ts`

**Interfaces:**
- Help output documents `start` and its arguments.
- Acceptance test exercises the start orchestration with a controlled mock runtime for each target mapping and verifies cleanup/exit behavior.

- [x] Add an acceptance test for the common start lifecycle and three target selection paths without requiring live credentials.
- [x] Run it and verify it fails until help, orchestration, and documentation are wired.
- [x] Update help and release documentation with the real command examples and the explicit DSH live-validation boundary.
- [x] Run `npm test` fresh, inspect the complete summary, and separate any pre-existing flaky Claude timing failure from new failures.
- [x] Run `git diff --check` and inspect the final diff before reporting.
