# Agentic hardening: validation and remediation instructions

Review date: 2026-09-15. Audience: Claude Code implementation agent.

## Verdict

**Do not mark all seven requirements complete yet.** The shared generation helper and shared RAG pipeline are implemented. Agentic Verify & Fix is connected, and direct controller tests now exist. However, lifecycle races, incomplete validation, and incomplete CSV-template enforcement remain.

This review changed no source code. The only authored artifact is this report. Findings reference the current working tree, including its uncommitted changes; line numbers will move as fixes land.

### Verification performed

- `npm test`: **895 passed, 0 failed**, including compilation of `tsconfig.test.json`.
- `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`: passed.
- `node node_modules/typescript/bin/tsc -p tsconfig.test-integration.json --noEmit`: passed.
- Executed isolated probes against compiled pure CSV and Gherkin helpers; reproductions below.
- Reviewed generation, ingestion, shared RAG packing, panel content synchronization, verification orchestration and tools, and the eight new controller tests.
- Did **not** run the VS Code integration suite, live Copilot calls, or generated Java/Python executions. Compilation of integration tests is not an integration-test pass.
- The referenced `agentic-mode-hardening-2026-09-15.md` and `toasty-swimming-thimble.md` were not found by the workspace file search. Their contents and claimed approvals cannot be independently validated here.

## Requirement status

| Item | Assessment |
| --- | --- |
| 1. Deduplicate generation | Core resolve/build/measure/pack/invoke work is shared in `runAgenticChain()`. Cancel/dispose, commit and error handling remain per action; the complete nine-step lifecycle is not centralized. Useful improvement, but lifecycle correctness is incomplete. |
| 2. Shared RAG packing | Implemented. Both modes delegate to `packRagSection()`. No concrete regression in the extracted packing algorithm was established in this review. Add direct pipeline/wrapper contract tests. |
| 3. Direct controller tests | Eight tests exist, but several do not exercise the public action or assertion claimed in their names. Verification itself is untested by that file. |
| 4. Agentic Verify & Fix | Wired through the panel callback to the existing agent and three tools. Cancellation, shared-panel ownership, failure handling and security parity need fixes. |
| 5. Validation loop | Not implemented as requested. Feature generation has one weak rejection check, not a repair loop. CSV checks formatting/completeness heuristics, not requirement coverage. Code verification is a separate manual action. Preserve execution approval while closing these gaps. |
| 6. Correct by design | Session epoch protects ingestion, and action shapes fix directive measurement drift. Other asynchronous boundaries still allow stale effects; current evidence does not support a blanket correctness claim. |
| 7. CSV template | Reads `.github/Jira_test_case_template.csv`; enforces parsed width, not exact header names/order or strict row shape. Filename and soft-population interpretation differ from the original requirement; supplied summary says these were approved, but that approval was not independently available. |

## Confirmed findings and fix instructions

### F01 — P1: Verify can restart after Clear Data or mode shutdown

**Location:** `src/agentic/agenticModeController.ts:1065–1139`, `1251`.

`verifyAndFixAgenticCode()` awaits editor content, environment checks, directory creation and feature-file writing before creating `verifyCancellation`. `reset()` can only cancel an already-existing token. If Clear Data happens during those awaits, the old invocation can subsequently create a fresh token and start the agent for the cleared session. There is no captured session-epoch check. The unconditional `finally` also enables the Verify button even when a newer generation/session owns it.

**Fix:** Reserve a verification operation ID, session epoch and cancellation source synchronously at entry, before the first await. Guard every subsequent side effect and callback against ownership, epoch and cancellation. Cancel/dispose with owner-aware cleanup; an old invocation must never modify a new session's button state. Add a reentrancy guard before requesting editor content.

**Regression tests:** Pause editor read, environment probe, directory creation and secret lookup separately; reset/dispose while paused; then release. Assert no agent invocation, panel update, new confirmation or stale state restoration. Repeat with two overlapping verify clicks.

### F02 — P1: Independent tokens do not protect the shared code panel

**Location:** `agenticModeController.ts:989–1026`, `1171–1220`.

Generation and verification have separate cancellation fields but both write the same `AiCodePanel`. Starting generation does not invalidate an older verification result. Verification's `onStep` calls `finish(args.code)` without checking ownership, and its final success can replace newly generated or manually edited code. Conversely generation can overwrite a candidate under verification. Both paths also change the same button state.

**Fix:** Define artifact ownership explicitly. Track the code revision verified, and accept candidate/final updates only while that revision and operation still own the panel. Either serialize generation/verification or deliberately supersede the older operation. Keep separate cancellation sources, but do not mistake them for output isolation. Use a distinct per-verification scratch directory so overlapping runs cannot share build artifacts.

**Regression tests:** Begin verify, then regenerate or edit code, then release an old tool callback/final result. The newer code and its unverified status must remain intact. Test old-finally/new-generation button ordering.

### F03 — P1: Cancellation while a run-confirmation dialog is open can still execute code

**Location:** `agenticModeController.ts:1159–1170`; `src/agent/verifyFixTools.ts:103–114`.

The confirmation callback returns `choice === 'Yes'` without rechecking cancellation/session ownership. The shared tool awaits that callback and immediately executes. If Clear Data or cancellation occurs while the dialog is open, subsequently choosing Yes can still launch the stale candidate. Checking cancellation between agent turns cannot protect this await inside a tool call.

**Fix:** Recheck cancellation and ownership after confirmation and immediately before execution. Thread a cancellation predicate/token into the run tool, or wrap confirmation with an ownership-aware result plus a final tool-side guard. Preserve approval for every execution. Where supported, propagate cancellation to the running process separately; do not describe discarded UI updates as process termination.

**Regression test:** Defer confirmation, cancel/reset, resolve Yes, assert executor call count stays zero. Cover Standard mode too because the tool is shared.

### F04 — P1: New verification path bypasses credential-protection context

**Location:** `agenticModeController.ts:1104–1130`, `1157`, `1172`; compare `src/panel/objectSpyPanel.ts:3087` and `appendPasswordEncryptionSection()`.

The new verifier sends `buildIngestedContext(true)`, raw `lastUserRequest` and `initialCode` directly into its prompt. There is no credential redactor or encryption-standard/helper assembly in this path; the only vault operation injects the runtime key into execution. That does not protect prompt text. The agent also logs tool arguments/results verbatim. A user-supplied test password in the request or ingested content can therefore reach the model/logs. Standard mode's fix-prompt builder explicitly appends encryption guidance. The generation path already has related exposure; this finding calls out the newly introduced verification path rather than claiming this review discovered universal secret detection.

**Fix:** Reuse an explicit, testable sanitization and encryption-context policy before prompt assembly and logging. Preserve encrypted tokens and required decryption helpers during repairs. Sanitize tool outputs too. Do not invent regex rules and claim they detect every secret; document supported fields and residual free-text limitations. Never include the runtime master key in prompts or logs.

**Regression tests:** Use fake credentials in ingested text, request text, edited code and executor output. Capture model messages/logs and assert protected values and master key are absent. Verify encrypted-token repair keeps its helper and remains executable with the supplied test key.

### F05 — P2: Verification preflight exceptions escape without useful UI feedback

**Location:** `agenticModeController.ts:1065–1254`, constructor callback at `145`.

The method has `try/finally` but no catch for exceptions from the environment probe, filesystem, secret storage or model resolution. Handling `result.stopReason === 'error'` covers only a returned agent result. The panel callback invokes the async method with `void`, so thrown failures can become unhandled rejections and leave the user with the last in-progress status.

**Fix:** Add an ownership-aware outer catch covering preflight and orchestration. Present a safe error/status and log diagnostic context. Treat cancellation as cancellation. Do not automatically restart with the legacy loop after arbitrary errors or repeat already-approved executions. If compatibility fallback is needed, restrict it to a recognized unsupported-tool capability before execution.

**Regression tests:** Reject each preflight dependency and model lookup; assert handled failure, restored owner-specific button state and no executor call. Test cancellation separately.

### F06 — P1: CSV-template equality is not enforced

**Location:** `src/agentic/csvTestCaseGenerator.ts:82–137`; `src/agentic/csvUtils.ts:80–81`.

Only `header.length` is compared. Header names/order are never checked. The ingestion-oriented parser pads **all rows, including the header**, to the widest row before validation. This can disguise a short header as a valid-width one.

**Executed reproductions:** With expected header `['Summary', 'Expected Result']` and example `[['x','y']]`, both inputs were accepted with no population note:

```text
Wrong,Headers
a,b
```

```text
OnlyOne
a,b
```

The second serializes as `OnlyOne,` followed by `a,b`. It has no valid second column name but passes the claimed hard check.

**Fix:** Add strict output/template parsing which preserves original row widths and rejects malformed quoting. Validate unique/nonempty expected headers and exact generated header names/order (with only an explicitly documented BOM policy). Validate each unpadded row's width. Keep permissive ingestion parsing unchanged unless separately justified. Keep the agreed soft population note if that approval is authoritative; column identity and syntax still need deterministic enforcement.

**Regression tests:** Wrong/reordered headers of identical width; duplicate/empty headers; short header with wider row; short/long data rows; malformed quotes; BOM; embedded commas/newlines. Assert malformed data is never written.

### F07 — P2: Template and mandatory prompt are read repeatedly, not snapshotted

**Location:** `agenticModeController.ts:669–729`, `900–903`, `1298`.

`runAgenticChain()` builds system instructions twice, rereading mutable custom instructions/templates each time. CSV validation reads the template a third time after the response. Editing the template during a request can cause the measured prompt, sent prompt and accepted output to use different schemas. The immutable action shape covers only suffix/fallback, not these inputs. RAG operations are also built from current mutable controller state after awaits.

**Fix:** Capture one request snapshot: settings, selected input segments, request text, selected instructions, template schema/examples and operation plan. Build mandatory text once, measure it once and add only the packed RAG section. Return that same template snapshot for output validation. Distinguish absent template from unreadable/invalid template rather than silently treating all read/parse errors as unconfigured.

**Regression tests:** Change template/instructions/draft during deferred measurement or inference. Assert the original operation uses one consistent snapshot; the next operation sees the edit. Assert invalid existing templates report an actionable error.

### F08 — P2: Stale CSV writes and token counts restore cleared state

**Location:** `agenticModeController.ts:798–804`, `1298–1332`.

CSV generation checks ownership before `writeFile()` but not after it resolves. Reset/supersede during the write still allows `lastCsvUri` assignment, a done status and opening the stale document. `recordReceivedTokens()` also awaits a count then unconditionally updates state, so an old completion can overwrite Clear Data's token display. The extra template read before directory creation is another unguarded boundary.

**Fix:** Guard after each await before UI/state commits, including write and document open. Define a policy for writes already in flight: preferably use an operation-owned temporary file and guarded publication, with cleanup limited to files owned by that operation. Never delete another run's output. Give token updates an epoch/operation guard. Guard stale error branches too.

**Regression tests:** Hold write/count/document-open promises, reset or supersede, release and assert no old URI/status/editor/token update. Confirm newer outputs are not removed during cleanup.

### F09 — P2: Feature validation accepts malformed Gherkin; no bounded repair loop exists

**Location:** `agenticModeController.ts:951–975`; `src/bdd/gherkinParser.ts`; `runAgenticChain()`.

The validator only checks whether a lenient extraction parser found a scenario. It is not a syntax validator. An executed probe accepted this unterminated doc string:

```gherkin
Feature: Login
Scenario: test
Given a user
"""
unterminated
```

A Markdown-fenced feature was also accepted; the controller commits the original trimmed text, including the fence. Invalid output with no scenario is rejected once and requires manual regeneration. No diagnostic-feedback retry occurs. CSV output similarly has no requirement-ID/coverage validation; a well-shaped row may omit almost every ingested requirement.

**Fix:** Normalize one outer fence, then validate with a real Gherkin grammar (or explicitly specified strict supported-subset validator). Add a bounded generation→validate→repair loop for feature and CSV text, retaining the request snapshot, cancellation and token budget. Track requirement IDs from the selected input and report missing coverage; do not claim semantic completeness from column count or filled cells. Distinguish deterministic checks from model-assisted judgments. For code, preserve explicit run approval; offer syntax/static validation or the existing user-triggered execution path, and describe that honestly instead of calling it automatic validation.

**Regression tests:** Unterminated doc strings, malformed Examples tables, fenced valid output, invalid→valid repair, retry exhaustion, cancellation between repairs, CSV omission of a known requirement, and zero code execution without approval.

### F10 — P2: New tests overstate actual lifecycle coverage

**Location:** `test/agentic/agenticModeController.generation.test.ts:164–232`, `262–275`.

The supersession test manually cancels/replaces fields and calls `runAgenticChain()`; it does not call `generateAutomationCode()` twice or assert a panel remains unchanged. The isolation test also invokes only the helper, never `verifyAndFixAgenticCode()`. The ingestion reset test increments `sessionEpoch` manually rather than invoking `reset()`. These tests pass even if the real action's cancellation/commit wiring is removed. The file contains no direct verification execution test, despite the new method being a major orchestration addition.

**Fix:** Keep useful pure/helper tests, rename them accurately, and add public-action tests using deferred dependency promises and observable fake panels/filesystem/model. Exercise actual reset/dispose. Add direct shared-RAG pipeline tests and both wrapper delegation tests, covering stale-recipe exclusion, supplied-model reuse, measured/fallback packing and cancellation. Use the regression scenarios in F01–F09 as the acceptance contract, not just an increased test count.

## Additional requirement clarifications

- **Template filename:** Original text asks for `TEXT_CASE_TEMPLATE.CSV`; implementation reads only `Jira_test_case_template.csv`. If the later approval in the supplied implementation summary is authoritative, retain it and document it. Otherwise support the requested filename with deterministic precedence and tests; do not silently assume the naming change was approved. Workspace search found no matching template CSV to validate against.
- **Documentation:** Update the Architecture page after fixes with the real validation sequence, manual execution boundary, stop conditions and supported template rules. Do not call compilation a live integration test or describe heuristic checks as complete coverage/security. The current working-tree change list contains no Architecture HTML edit for this hardening batch.
- **No proven shared-packing regression:** Do not rewrite the RAG algorithm gratuitously. Preserve existing freshness filtering, hybrid fallback, packing budgets and Standard-mode behavior; add tests around the extraction.

## Implementation order and completion criteria

1. Add failing public-action regression tests for F01–F03 and F08; implement operation/session/revision ownership.
2. Close credential/context and error-handling gaps (F04–F05), including shared-tool cancellation tests for Standard mode.
3. Snapshot request/template inputs (F07); implement strict output validation (F06).
4. Add bounded text-validation/repair and coverage reporting (F09), preserving human approval for execution.
5. Replace overstated test assertions, add shared-pipeline contracts, update documentation and run validation.

Run all three TypeScript checks and the full unit suite. Run VS Code integration tests where the environment supports them and clearly report any unavailable live checks. Perform a manual Agentic-mode smoke test: generate each artifact, edit/regenerate, verify, decline a rerun, Clear Data during a pending run and repeat with a template. Confirm Standard mode remains functional. Do not commit/push, change dependencies broadly or alter unrelated user edits without task authorization.

Completion means the reproductions are fixed and the corresponding regression tests pass—not merely that the existing 895 tests still pass.
