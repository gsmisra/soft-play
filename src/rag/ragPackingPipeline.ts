import * as vscode from 'vscode';
import { ObjectSpySettings } from '../settings/settingsStore';
import { getOrBuildRagIndex, loadRagRecipesByPath } from './ragIndexer';
import { dedupeRecipeIds } from './ragIndexBuilder';
import { formatRagPromptSection, formatSelectedRagSection, RagMatch } from './ragRetriever';
import { retrieveForOperations, OperationRagCandidate } from './ragOperationRetrieval';
import { OperationPlan } from './ragOperationPlanner';
import { SelectedRagPurpose, UnusableRagFilesError } from '../llm/customInstructionsSection';
import { resolveHybridRetrieveMatches } from './ragHybridConfig';
import { packOperationCandidates, PackingDiagnostics } from './ragOperationPacking';
import { getOrBuildFreshnessReport } from './ragFreshnessService';
import { findModel } from '../llm/copilotClient';
import { PROMPT_TOKEN_SAFETY_MARGIN } from '../llm/tokenBudget';

/**
 * Item 2 (dedupe): the retrieve -> check-staleness -> pack-against-budget ->
 * format pipeline `objectSpyPanel.ts` and `agenticModeController.ts` each
 * used to implement independently as their own `buildRagSection()` method —
 * genuinely identical logic once each caller has its own `OperationPlan`
 * (built differently: Gherkin steps/API details/Playwright code for
 * Standard mode, ingested-file segments for Agentic Mode — that part
 * correctly stays in each caller, since it's the one thing that actually
 * differs). Real correctness fixes (A08's stale-recipe exclusion, A10's
 * cancellation-aware hybrid retrieval, Phase 6's hybrid RRF fusion) used to
 * require editing BOTH copies in lockstep — a live maintenance risk this
 * module removes by construction.
 */

export interface RagPackingContext {
  /** Needed by `resolveHybridRetrieveMatches()` for the semantic-provider's
   * own API-key lookup (secretVault) — both callers already have this as
   * their own `context` field. */
  extensionContext: vscode.ExtensionContext;
  settings: ObjectSpySettings;
  /** The caller's own already-measured cost of everything else in the
   * prompt — `undefined` falls back to `formatRagPromptSection()`'s
   * character-based packing. See each caller's own `buildRagSection()`
   * doc comment (now this module's) for the full reasoning. */
  mandatoryTokens: number | undefined;
  /** Reused rather than re-resolved by id string when the caller already
   * has one — see F12. */
  model?: vscode.LanguageModelChat;
  cancellationToken?: vscode.CancellationToken;
  /** Distinguishes each caller's own Output-channel lines — "Reusable
   * components (RAG)" (Standard mode) vs "Agentic Mode RAG" — the only
   * thing that ever differed between the two copies' own logging. */
  logPrefix: string;
  onLog: (message: string) => void;
  /** Workspace-relative paths of whichever "RAG Data" checkboxes the user
   * has explicitly checked (the "RAG Data" search+checkbox list) — when
   * non-empty, this ENTIRELY bypasses automatic TF-IDF/hybrid retrieval:
   * no ranking, no freshness exclusion, no budget packing, regardless of
   * `settings.ragEnabled`. Selected recipes hold the SAME importance as
   * selected Custom Instructions (see `packSelectedRagSection()`): rendered
   * in FULL with a highest-priority statement, and if ANY selected file
   * cannot be used (missing/unreadable, not a valid recipe, not tagged for
   * the target language, no workspace) this THROWS `UnusableRagFilesError`
   * instead of quietly omitting it. `undefined`/empty (the default) is
   * byte-for-byte the existing automatic-retrieval behavior. */
  selectedRagFiles?: string[];
  /** What the section is for — code generation (default) or feature-file
   * generation (recipes are business context there, never code). Only
   * affects the wording of a SELECTED-recipes section. */
  purpose?: SelectedRagPurpose;
  /** Selected recipes ALREADY loaded for this request (see `loadSelectedRagMatches()`); when given, the
   * files are not read again. */
  preloadedSelected?: RagMatch[];
}

/** The set of `RagMatch.filePath` values currently `stale` or `missing` per
 * Phase 5's active freshness check — fetched (cached, never forced) on
 * every request so a known-stale recipe is excluded from retrieval itself
 * (A08), not filtered out of an already-truncated result afterward.
 * Failures (workspace not resolvable, freshness check itself erroring)
 * degrade to "nothing known stale" — never blocks generation on a
 * diagnostic feature failing. */
export async function getStaleRagFilePaths(workspaceRoot: vscode.Uri, context: Pick<RagPackingContext, 'logPrefix' | 'onLog'>): Promise<Set<string>> {
  try {
    const report = await getOrBuildFreshnessReport(workspaceRoot, {
      onWarn: (message) => context.onLog(`${context.logPrefix} Source Freshness: ${message}`)
    });
    return new Set(report.entries.filter((e) => e.state === 'stale' || e.state === 'missing').map((e) => e.filePath));
  } catch (err) {
    context.onLog(`${context.logPrefix} Source Freshness: could not check freshness for this request (${err instanceof Error ? err.message : String(err)}) — proceeding without excluding any recipe.`);
    return new Set();
  }
}

/** Logs the retrieved -> included -> operation-coverage breakdown for one
 * RAG packing pass — implementation diagnostics in the Output channel only,
 * never surfaced to the model itself. Was previously `objectSpyPanel.ts`'s
 * own `logRagPackingResult()` (richer than Agentic Mode's own inline
 * logging) — Agentic Mode now gets the same operation-coverage/measured-
 * token detail Standard mode always had, a strict improvement, not a
 * behavior change either caller depended on differing. */
function logPackingResult(context: RagPackingContext, plan: OperationPlan, candidates: OperationRagCandidate[], includedMatches: RagMatch[], diagnostics: PackingDiagnostics | undefined): void {
  if (candidates.length === 0) {
    return;
  }
  context.onLog(
    `${context.logPrefix}: ${plan.operations.length} operation(s) planned (${plan.method}), ${candidates.length} distinct candidate(s) retrieved — ` +
      `${candidates.map((c) => c.match.id).join(', ')}.`
  );
  if (includedMatches.length < candidates.length) {
    const detail = diagnostics ? diagnostics.omitted.map((o) => `${o.id} (${o.reason})`).join(', ') : 'size cap';
    context.onLog(`${context.logPrefix}: ${candidates.length - includedMatches.length} candidate(s) omitted from the prompt — ${detail}.`);
  }
  if (diagnostics) {
    const uncovered = diagnostics.operationCoverage.filter((c) => !c.covered);
    if (uncovered.length > 0) {
      context.onLog(
        `${context.logPrefix}: ${uncovered.length} of ${plan.operations.length} operation(s) have NO included RAG coverage (${uncovered.map((c) => c.operationId).join(', ')}).`
      );
    }
    context.onLog(`${context.logPrefix}: packed section is ${diagnostics.tokensUnmeasured ? 'an UNMEASURED (char-capped) best effort' : `${diagnostics.countedTokens} measured token(s)`}.`);
  }
}

/**
 * The section for recipes the user EXPLICITLY checked in the "RAG Data" list
 * (`selectedRagFiles`) — a different job from automatic retrieval, so it does
 * NOT go through retrieval/ranking/staleness/budget packing at all. Selected
 * recipes hold the same importance as selected Custom Instructions:
 *
 *  - rendered in FULL, highest priority (`formatSelectedRagSection()`), in the
 *    user's own selection order, regardless of `settings.ragEnabled`;
 *  - loaded directly by path (`loadRagRecipesByPath()` — never a whole-corpus
 *    index build just to send the few files the user checked);
 *  - NEVER silently dropped: if ANY selected file is missing/unreadable, is not
 *    a valid recipe, is not tagged for the target `language` (the one hard
 *    filter — a Python-only helper can't be used from Java), or no workspace is
 *    open, this throws `UnusableRagFilesError` naming every such file, and the
 *    caller stops before contacting the model. Whether the FULL text fits the
 *    model's context window is the caller's job (it owns the real token count)
 *    — it stops rather than trims, because trimming a recipe the user chose is
 *    exactly the silent omission this rule forbids.
 *
 * Deliberately independent of the operation plan: nothing here competes for
 * inclusion, so there is nothing to plan.
 */
async function packSelectedRagSection(context: RagPackingContext): Promise<{ section: string; matches: RagMatch[] }> {
  // A request that already loaded its selected recipes (`preloadedSelected`) formats THOSE — it never reads
  // the files a second time, so the recipes a chat turn used and the ones its generation tool uses are the
  // same bytes even if a file is edited in between.
  const matches = context.preloadedSelected ?? (await loadSelectedRagMatches(context));
  return { section: formatSelectedRagSection(matches, context.settings.language, context.purpose ?? 'code'), matches };
}

/**
 * Reads and validates the recipes the user checked (see `packSelectedRagSection`), throwing
 * `UnusableRagFilesError` for any missing/invalid/wrong-language one or when no workspace is open.
 * Exported so a caller can load them ONCE per request and reuse the result for several purposes.
 */
export async function loadSelectedRagMatches(context: RagPackingContext): Promise<RagMatch[]> {
  const { settings, logPrefix, onLog } = context;
  const selectedPaths = context.selectedRagFiles ?? [];
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceRoot) {
    throw new UnusableRagFilesError(selectedPaths.map((p) => ({ path: p, reason: 'no workspace folder is open' })));
  }

  const { loaded, unusable } = await loadRagRecipesByPath(workspaceRoot, selectedPaths, (message) => onLog(`${logPrefix}: ${message}`));
  const usable: typeof loaded = [];
  for (const entry of loaded) {
    const languages = entry.recipe.frontmatter.language as string[];
    if (languages.includes(settings.language)) {
      usable.push(entry);
    } else {
      unusable.push({ path: entry.path, reason: `not tagged for ${settings.language} — its "language:" frontmatter lists ${languages.join(', ') || 'nothing'}` });
    }
  }
  if (unusable.length > 0) {
    throw new UnusableRagFilesError(unusable);
  }

  const canonicalIds = dedupeRecipeIds(usable.map((e) => e.recipe));
  const matches: RagMatch[] = usable.map((e, i) => ({
    id: canonicalIds[i],
    title: e.recipe.frontmatter.title,
    body: e.recipe.body,
    imports: e.recipe.frontmatter.imports,
    score: 1,
    filePath: e.recipe.filePath
  }));
  onLog(`${logPrefix}: ${matches.length} manually selected RAG recipe(s) included IN FULL as highest-priority context — ${matches.map((m) => m.id).join(', ')}.`);
  return matches;
}

/**
 * Builds the "Reusable components available" prompt section for `plan` —
 * see `RagPackingContext`'s own doc comment for what each field is for.
 * `''`/no matches whenever RAG is off (and nothing was manually selected —
 * see `selectedRagFiles`), no workspace is open, `.github/rag` has nothing
 * indexed, or `plan` has no operations — every one of those is a silent,
 * normal no-op, never surfaced as an error. The ONE exception is an explicit
 * `selectedRagFiles` selection: that never no-ops silently — see
 * `packSelectedRagSection()`.
 */
export async function packRagSection(plan: OperationPlan, context: RagPackingContext): Promise<{ section: string; matches: RagMatch[] }> {
  const { extensionContext, settings, mandatoryTokens, model, cancellationToken, logPrefix, onLog, selectedRagFiles } = context;
  const empty = { section: '', matches: [] as RagMatch[] };
  const hasManualSelection = !!selectedRagFiles && selectedRagFiles.length > 0;
  // An explicit "RAG Data" checkbox selection is a deliberate, unambiguous
  // per-request user action — it's honored regardless of the separate
  // "Use reusable components" (ragEnabled) toggle, which exists to gate
  // AUTOMATIC matching specifically, not an explicit choice the user just
  // made in the very same section of the UI.
  if (!hasManualSelection && !settings.ragEnabled) {
    return empty;
  }
  // An explicit selection is handled entirely separately — see packSelectedRagSection().
  if (hasManualSelection) {
    return packSelectedRagSection(context);
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceRoot) {
    return empty;
  }
  if (plan.operations.length === 0) {
    return empty;
  }

  // Automatic retrieval. A08's stale/missing exclusion applies here only (a manual selection never reaches this point).
  let staleFilePaths = new Set<string>();
  const index = await getOrBuildRagIndex(workspaceRoot, (message) => onLog(`${logPrefix}: ${message}`));
  if (!index) {
    return empty;
  }
  // Phase 6: `undefined` (hybrid mode off, the default) falls straight
  // through to retrieveForOperations()'s own default (plain lexical
  // retrieveRagMatches()), zero behavior change.
  //
  // A10: `cancellationToken` (this SAME generation request's own, when the
  // caller has one) is bridged into a plain `AbortSignal` and forwarded to
  // every per-operation semantic-embedding call this resolves to;
  // `onSemanticFailure` reports a real (non-cancellation) semantic failure
  // ONCE for this whole generation.
  const retrieveMatches = await resolveHybridRetrieveMatches(extensionContext, settings, {
    cancellationToken,
    onSemanticFailure: (message) => onLog(`${logPrefix}: semantic (hybrid) retrieval failed for this request (${message}) — falling back to lexical-only matching for the rest of it.`)
  });
  if (retrieveMatches) {
    onLog(`${logPrefix}: hybrid (lexical + semantic, RRF-fused) retrieval is active for this request.`);
  }

  // A08: fetched BEFORE retrieval and threaded INTO retrieveForOperations()
  // itself, so a known stale/missing recipe is excluded from EACH
  // operation's own per-operation top-k rather than discarded from an
  // already-truncated result afterward.
  staleFilePaths = await getStaleRagFilePaths(workspaceRoot, context);
  const candidates = await retrieveForOperations(index, plan.operations, settings.language, settings.automationMode, undefined, retrieveMatches, staleFilePaths);
  if (candidates.length === 0) {
    logPackingResult(context, plan, candidates, [], undefined);
    return empty;
  }

  // F12: reuse an already-resolved model handle when the caller has one,
  // rather than re-resolving by id string here.
  const resolvedModel = mandatoryTokens !== undefined ? (model ?? (await findModel(settings.copilotModelId))) : undefined;
  if (!resolvedModel || mandatoryTokens === undefined) {
    // No live token count available this time — fall back to
    // formatRagPromptSection()'s own fence-safe character-based packing,
    // still benefiting from per-operation retrieval's wider candidate
    // coverage even without a real token-budget guarantee.
    const eligibleCandidates = candidates.filter((c) => !staleFilePaths.has(c.match.filePath));
    const { section, includedMatches } = formatRagPromptSection(
      eligibleCandidates.map((c) => c.match),
      settings.language
    );
    logPackingResult(context, plan, candidates, includedMatches, undefined);
    return { section, matches: includedMatches };
  }

  const packed = await packOperationCandidates(candidates, plan.operations, settings.language, {
    maxInputTokens: resolvedModel.maxInputTokens,
    safetyMargin: PROMPT_TOKEN_SAFETY_MARGIN,
    mandatoryTokens,
    staleFilePaths,
    countTokens: async (text) => {
      try {
        return await resolvedModel.countTokens(text);
      } catch {
        return undefined;
      }
    }
  });
  logPackingResult(context, plan, candidates, packed.includedMatches, packed.diagnostics);
  const { section, includedMatches } = packed;
  return { section, matches: includedMatches };
}
