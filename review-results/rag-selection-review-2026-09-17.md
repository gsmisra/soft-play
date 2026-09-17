# RAG search and selection review — remediation instructions

Date: 2026-09-17
Repository: C:\Users\User\OneDrive\Documents\projects\softplay\soft-play
This is the current project location; the previous Documents path is obsolete.

## Verdict and evidence

The implementation is not ready to declare complete. Manual RAG selection has a reproducible path-identity defect, reset does not purge the requested caches, and search does not actually search class identifiers in recipe contents. Source code was not changed during this review.

Validation performed:
- npm test: 963 passed, zero failed; test TypeScript compilation passed.
- Production and integration-test TypeScript configurations: passed with --noEmit.
- node --check media/main.js: passed.
- Executed the compiled RAG pipeline tests in memory with the manual-selection fixture changed to the actual UI path format. Two existing success tests then FAILED. No test source or compiled file was edited for this probe.
- No live VS Code/Copilot execution or browser interaction was performed. Findings below distinguish executed evidence from source-traced behavior.

Line references refer to the reviewed working tree and may shift during remediation. Preserve all existing uncommitted work.

## R01 — P1: Actual UI selections do not match indexed recipe paths

Locations:
- src/panel/objectSpyPanel.ts:1074–1082 — partitionRagFilesByValidity emits workspace-relative paths.
- media/main.js:1177–1186 — checkbox values and selection messages retain those paths.
- src/rag/ragIndexer.ts:124–125 — recipe.relativePath is relative to .github/rag, NOT the workspace.
- src/rag/ragPackingPipeline.ts:152 — selectedSet.has(recipe.relativePath) compares the incompatible formats.
- test/rag/ragPackingPipeline.test.ts:162 onward — success fixtures use recipe-relative names instead of UI values.

Example: a real checkbox sends .github/rag/cassandra-helper.md. The index stores cassandra-helper.md. No candidate matches; the request proceeds without the explicitly selected recipe and logs it as missing. Automatic retrieval is bypassed because the selection is nonempty, so this is not rescued by fallback.

Executed reproduction: loaded out-test/test/rag/ragPackingPipeline.test.js through Module._compile after replacing the single-element ['cassandra-helper.md'] fixture with ['.github/rag/cassandra-helper.md'] IN MEMORY. The ordinary manual-selection and ragEnabled-off success tests both failed; the other five tests passed.

Fix instructions:
1. Define one canonical identity across listing, checkbox payload, request snapshot and lookup. Prefer workspace URI plus root identity, or normalize workspace-relative paths at the boundary with explicit containment checks.
2. Do not fix this by stripping arbitrary substrings or comparing basenames: nested files can share a basename.
3. Handle separators consistently on Windows and retain nested paths.
4. Add an end-to-end contract test using the actual listing output as the selection input, for both UI and API mode, nested directories and duplicate basenames.
5. If a selected file genuinely cannot be loaded, surface an actionable user-visible error/warning before silently generating without the requested context.

## R02 — P1: Clear Data / Kill All Browsers do not clear loaded file or RAG caches

Locations:
- src/panel/objectSpyPanel.ts:722–751 — clearSharedLlmContext clears fields/panels but invokes no file/index cache invalidation.
- src/cache/fileCache.ts:59–76 — workspace file contents remain cached; clearFileCaches exists.
- src/rag/ragIndexer.ts:41,149,159–160 — the cached index retains recipe bodies and embeddings; clearRagIndexCache exists.
- media/main.js:948–951 and 1218–1222 — clear resets selection/search while retaining allFiles metadata.

The requirement explicitly asks for no loaded RAG/custom-instruction data retained in cache/local session context. Clearing checkbox arrays is not equivalent to purging cached content. Cached recipe bodies and instruction text survive the reset.

Fix instructions:
1. Introduce one scoped context reset/invalidation routine covering the current workspace's file contents, RAG index and any content-bearing retrieval/semantic caches. Inventory actual caches before clearing unrelated application state.
2. Invalidate in-flight producers with a generation/epoch as well as clearing Maps; otherwise an old asynchronous read/index build can repopulate a just-cleared cache.
3. Cancel pending estimates/context preparation on reset and prevent old work from invoking the LLM afterward.
4. Preserve on-disk user files and stored credentials; the user requested session/cache clearing, not file deletion or key rotation.
5. Distinguish visible file-path metadata from loaded contents in the UI/documentation. If the requirement is interpreted to include clearing the visible list, clear it until explicit refresh; do not claim loaded content was removed merely because boxes are unchecked.

Tests: populate instruction/index caches, reset through EACH real button handler, and prove subsequent access does a fresh read. Pause a read/index build, reset, finish it, and prove it cannot restore old-session entries or messages. Do not claim guaranteed physical RAM zeroization in a garbage-collected runtime.

## R03 — P1: Request payload selection is ignored; mutable state decides later

Locations:
- media/main.js:985–990 and 1318–1324 — selectedRagFiles is sent in draft and generation payloads.
- src/panel/objectSpyPanel.ts:490–493,552–558 — those handlers never consume payload.selectedRagFiles.
- src/panel/objectSpyPanel.ts:529–534 — separate selection messages update a mutable field.
- src/panel/objectSpyPanel.ts:1114–1115 — instructions are read before entering the generation method.
- src/panel/objectSpyPanel.ts:2230–2242 — RAG packing reads the current mutable selection after asynchronous preparation.

The selection embedded in the clicked request is not authoritative. Example: click Generate with recipe A selected; while file reads/redaction/token measurement are pending, select B or uncheck everything. That already-started request can pack B or automatic matches, contrary to the context selected at click time. The added payload field provides no protection because it is ignored. Related reset risk: a pending sendToLlm instruction read can finish after reset and enter runLlmRefinement with old instructions; the cancellation source is created later inside that method.

Fix instructions:
1. Snapshot RAG and instruction selections at action entry from the payload, alongside the operation/session epoch. Regenerate should explicitly capture current selection once.
2. Pass the snapshot through prompt measurement and packing; never reread live selections mid-request.
3. Reserve cancellation/ownership before instruction reads, not only at inference start. Check after awaits before further side effects or model invocation.
4. Apply the same snapshot to token estimates so estimate and send reflect one consistent selection.

Tests: hold a preflight promise, change selection A to B, release and inspect the captured final prompt; only A should appear. Repeat with reset and assert no old-session model call. Test that a generation message carrying A works without relying on a preceding selection message.

## R04 — P2: Search matches paths only, not class names inside recipes

Locations:
- media/main.js:1166–1167 — filtering is f.toLowerCase().includes(query), where f is just the displayed path.
- src/panel/objectSpyPanel.ts:1074–1082 — the list payload contains only paths.
- src/panel/objectSpyPanel.ts:2534 — placeholder advertises class/file-name search.

A recipe database/helpers.md whose body/title describes CassandraHelper will not appear when searching cassandra unless its PATH contains that word. This fails the stated class-name lookup use case for non-descriptive recipe filenames.

Fix instructions: return lightweight structured search metadata (stable identity, display path, class/symbol names and relevant title) from existing parsed recipes, and filter it case-insensitively. Reuse metadata; do not reread every body on each keystroke. Keep selection separate from visibility. If only path search is intentionally supported, that is a scope reduction requiring explicit agreement, and the class-name placeholder must be corrected.

Tests: class name only in content/title; path-only match; mixed case; nested paths; no match; selected hidden item remains selected. Cover both modes.

## R05 — P2: Manual selection still scans/indexes the entire corpus

Locations:
- src/rag/ragPackingPipeline.ts:205 — unconditional getOrBuildRagIndex before the manual branch at 219–220.
- src/rag/ragIndexer.ts:86–125 — discovers all recipes, fingerprints them and reads/parses every recipe on a cold or invalidated index.

Manual selection skips similarity/hybrid retrieval, which is useful, but it does not avoid whole-corpus discovery/index building. With one file selected, a cold request still loads all files. This falls short of the stated load-reduction purpose and unnecessarily keeps unrelated recipe content resident.

Fix instructions: branch on manual selection before automatic index construction. Load/validate only selected canonical URIs, construct matches with existing reusable parsing helpers, and retain context-budget checks. Keep automatic indexing unchanged for an empty selection. Avoid creating a second parser or expensive full-corpus search on each keystroke.

Tests: spy on filesystem reads/index construction; selecting one of many files must not read/index unrelated bodies or invoke semantic retrieval. Empty selection with RAG enabled must preserve the existing automatic path.

## R06 — P2: Refresh silently changes an explicit selection to broader context

Locations:
- media/main.js:1208–1213 — setFiles clears selection and search on every list response.
- media/main.js:1494–1498 — both refreshed lists use setFiles.
- src/panel/objectSpyPanel.ts:2316–2326 — empty instruction selection means all files.

Select one instruction and one recipe, then click Refresh. Both selections become empty. The next request sends ALL instructions and returns to automatic RAG matching. Refresh was already clearing instruction checkboxes before this change, but the new empty=all rule turns this into silent context expansion; RAG checkbox reset is new.

Fix instructions: ordinary refresh should reconcile selections against available IDs and preserve search text. Explicit reset buttons should clear them. When the last selected file disappears, notify the user that the effective mode is changing rather than silently broadening it. Keep intentional unchecking-all behavior as specified.

Tests: refresh with unchanged files preserves selection; refresh with one missing file preserves remaining choices; refresh with all selected files removed exposes the changed behavior; explicit reset clears both searches and selections.

## R07 — P2: Selected context is not applied to feature-file generation

Location: src/panel/objectSpyPanel.ts:1153–1207, especially prompt assembly at 1190 onward.

Feature-file generation reads built-in feature instructions and recording/API/chat input but never calls readInstructionFiles or buildRagSection. Thus a user checking Custom Instructions or RAG files then clicking Start AI Feature File Generation does not send those selected files. This omission predates the change, but the new general promise about selected files in the LLM request context is not implemented for this visible AI action.

Fix instructions: apply the same request-scoped selection resolver to feature generation and regeneration, with appropriate feature-specific instructions and token budgeting. If the intended scope is code generation only, explicitly document and obtain that narrower interpretation instead of implying every AI action honors the list. Avoid adding automatic execution.

Tests: capture feature-generation prompts in UI and API mode, with explicit selection and empty-selection defaults. Assert selected/unselected sentinel contents appear or are absent correctly.

## Policy gaps and limits to resolve, not silently redesign

1. The request says selected recipes should be sent. Current manual packing can still omit/truncate them for token/character limits, skip incompatible language tags, or return empty when the operation plan is empty (pipeline:209). Budget protection must remain; make omissions visible and test them rather than claiming “exactly all selected files” unconditionally.
2. The manual branch also bypasses freshness exclusion and the RAG enabled setting. These are deliberate agent decisions, not explicit requirements in the quoted ask. Document them and keep stale-source warnings; do not conceal known-invalid context merely because it was selected.
3. Total Agentic Mode remains unchanged. Both UI and API modes in Standard Mode are covered structurally; the quoted reset buttons support that scope interpretation. Treat extension-wide Agentic-mode parity as a scope clarification, not an established regression.
4. Multi-root handling needs a regression case: listing uses workspace-wide findFiles/asRelativePath while instruction loading and indexing resolve against the first workspace folder. Prefer root-aware URI identities; avoid exposing selectable files which cannot be resolved correctly.
5. Existing new pipeline tests mostly use unmeasured packing and recipe-relative fixtures. Add the UI→host→index contract, measured-budget, reset/cache and frontend interaction tests. Passing 963 tests did not catch R01.

## Suggested remediation sequence

1. Fix canonical identity R01 and add the real UI path regression before refactoring anything else.
2. Implement request snapshots/epoch ownership R03 and cache reset R02 together.
3. Preserve refresh state R06 and implement class metadata search R04 using one reusable checkbox-list component.
4. Optimize manual loading R05 and address feature-generation context R07 according to confirmed scope.
5. Run the full unit suite, all TypeScript configs and JS syntax check. Perform live webview smoke tests for UI/API mode, filtering while selected, refresh, generation, Clear Data and Kill All Browsers. Report unavailable integration checks honestly.

No source changes, dependency updates, commit or push were made by this review. This document is the instruction handoff; fixes should preserve unrelated working-tree changes.
