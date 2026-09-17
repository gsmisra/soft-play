import * as vscode from 'vscode';
import { ObjectSpySettings } from '../settings/settingsStore';
import { getOrBuildRagIndex, loadRagRecipesByPath } from './ragIndexer';
import { dedupeRecipeIds } from './ragIndexBuilder';
import { formatRagPromptSection, RagMatch } from './ragRetriever';
import { retrieveForOperations, OperationRagCandidate } from './ragOperationRetrieval';
import { OperationPlan, RagOperation } from './ragOperationPlanner';
import { RagLanguage, RagRecipe } from './ragTypes';
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
   * non-empty, this ENTIRELY bypasses automatic TF-IDF/hybrid retrieval's
   * RANKING/SCORING: no relevance judgment is applied, and the freshness/
   * staleness check that would otherwise exclude a candidate never applies
   * either, regardless of `settings.ragEnabled`. This is NOT an
   * unconditional guarantee that every selected file reaches the prompt,
   * though — two real constraints still apply, deliberately, and are
   * logged (never silent) when they remove something: (1) `language` is
   * still a hard filter (see `buildManuallySelectedCandidates()`'s own doc
   * comment — a structural incompatibility, not a relevance judgment), and
   * (2) the SAME token/character budget packing every other path goes
   * through (`packOperationCandidates()`/`formatRagPromptSection()`) can
   * still omit a selected file whole if it genuinely doesn't fit — a
   * selection is a strong request to include, never a bypass of the actual
   * context-window limit. `undefined`/empty (the default) is byte-for-byte
   * the existing automatic-retrieval behavior. */
  selectedRagFiles?: string[];
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
 * Builds `OperationRagCandidate[]` from recipes ALREADY loaded specifically
 * for an explicit "RAG Data" checkbox selection (`loadRagRecipesByPath()`
 * in ragIndexer.ts — deliberately NOT a full corpus index build, see that
 * function's own doc comment) — completely bypassing automatic TF-IDF/
 * hybrid retrieval and its scoring/ranking, since an explicit user
 * selection needs no relevance judgment at all. `language` is still a HARD
 * filter (the one thing automatic retrieval ALSO never relaxes, unlike
 * `automationMode`, which is only ever a soft preference) — a recipe that's
 * genuinely incompatible with the target language (e.g. a Python-only
 * helper while generating Java) is structurally unusable regardless of the
 * user's intent, so it's skipped with a clear log line rather than silently
 * included and confusing the model with syntax that doesn't apply. A
 * selected path that no longer resolves to a valid recipe at all is
 * already reported by `loadRagRecipesByPath()` itself (it simply isn't in
 * `recipes` here), so this function only needs to report the
 * language-incompatible case.
 *
 * `coveredOperationIds` is set to EVERY operation for each selected match —
 * that bookkeeping exists purely to guide automatic retrieval's own
 * prioritization/packing tie-breaks (ragOperationPacking.ts's "redundant
 * candidate" logic), which has no meaning for an explicit selection that
 * was never competing against anything else for inclusion; this just
 * ensures packing never treats a manually selected file as "redundant" and
 * demotes it below another one.
 */
function buildManuallySelectedCandidates(
  recipes: RagRecipe[],
  canonicalIds: string[],
  operations: RagOperation[],
  language: RagLanguage,
  logPrefix: string,
  onLog: (message: string) => void
): OperationRagCandidate[] {
  const skippedForLanguage: string[] = [];
  const candidates: OperationRagCandidate[] = [];
  const operationIds = operations.map((op) => op.operationId);

  recipes.forEach((recipe, i) => {
    if (!(recipe.frontmatter.language as string[]).includes(language)) {
      skippedForLanguage.push(recipe.relativePath);
      return;
    }
    const match: RagMatch = {
      id: canonicalIds[i],
      title: recipe.frontmatter.title,
      body: recipe.body,
      imports: recipe.frontmatter.imports,
      score: 1,
      filePath: recipe.filePath
    };
    candidates.push({ match, coveredOperationIds: operationIds, bestScore: 1 });
  });

  if (skippedForLanguage.length > 0) {
    onLog(`${logPrefix}: ${skippedForLanguage.length} manually selected RAG file(s) skipped — not tagged for ${language}: ${skippedForLanguage.join(', ')}.`);
  }
  return candidates;
}

/**
 * Builds the "Reusable components available" prompt section for `plan` —
 * see `RagPackingContext`'s own doc comment for what each field is for.
 * `''`/no matches whenever RAG is off (and nothing was manually selected —
 * see `selectedRagFiles`), no workspace is open, `.github/rag` has nothing
 * indexed, or `plan` has no operations — every one of those is a silent,
 * normal no-op, never surfaced as an error.
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
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceRoot) {
    return empty;
  }
  if (plan.operations.length === 0) {
    return empty;
  }

  let candidates: OperationRagCandidate[];
  // A08's stale/missing exclusion only ever applies to AUTOMATIC retrieval
  // — a manual selection is never filtered out for staleness (the user
  // explicitly asked for this exact file), so this stays empty for that
  // path, same as "nothing known stale."
  let staleFilePaths = new Set<string>();
  if (hasManualSelection) {
    // Deliberately NEVER calls getOrBuildRagIndex() — a manual selection
    // must not require scanning/parsing the WHOLE .github/rag/ corpus just
    // to send the handful of files the user actually checked (this was a
    // real, reported gap: the "reduce load" goal the checkbox list exists
    // for wasn't served by reusing the shared, whole-corpus index). Loads
    // and parses ONLY the requested files, resolved directly by their own
    // workspace-relative path — see loadRagRecipesByPath()'s own doc
    // comment for why this is also what keeps path matching correct
    // regardless of format (a prior version compared these paths against
    // RagRecipe.relativePath, which is relative to .github/rag/ ITSELF, a
    // different string, and so never actually matched a real UI selection).
    const recipes = await loadRagRecipesByPath(workspaceRoot, selectedRagFiles!, (message) => onLog(`${logPrefix}: ${message}`));
    if (recipes.length === 0) {
      logPackingResult(context, plan, [], [], undefined);
      return empty;
    }
    const canonicalIds = dedupeRecipeIds(recipes);
    candidates = buildManuallySelectedCandidates(recipes, canonicalIds, plan.operations, settings.language, logPrefix, onLog);
  } else {
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
    candidates = await retrieveForOperations(index, plan.operations, settings.language, settings.automationMode, undefined, retrieveMatches, staleFilePaths);
  }
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
