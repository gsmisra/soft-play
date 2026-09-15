import * as vscode from 'vscode';
import * as path from 'path';
import { sendPrompt, countModelTokens, CopilotUnavailableError } from '../llm/copilotClient';
import { readFileCachedSync } from '../cache/fileCache';
import { normalizeGeneratedRecipe, resolveRagTargets, RagTargetSource } from './ragRecipeNormalizer';
import { parseRagFile } from './ragFrontmatter';
import { buildSourceIdentity, extractJavaPackageDeclaration, selectSourceHashInput } from './ragSourceIdentity';
import { capabilitiesForFile, countDeferredCapabilities, extractAllCallableUnitsForDependencyDiscovery, MAX_CAPABILITIES_PER_FILE, ExtractedCapability } from './ragCapabilityExtraction';
import { validateSourceGrounding } from './ragSourceGrounding';
import { scrubSecretsFromRecipe } from './ragSecretScrubber';
import { resolveSourceFile } from './ragFreshnessService';

/**
 * "Generate RAG Corpus format" (Settings) — turns an arbitrary uploaded
 * source/config file into one or more well-structured
 * `.github/rag/<name>.md` COMPACT CALLING-CONTRACT recipes via Copilot, so
 * a team can point this at their existing helper classes instead of
 * hand-writing recipe files from scratch. Analyzing arbitrary code to
 * infer a title/tags/target-language/import statement — and now, a
 * verifiable calling contract for one specific capability — is exactly
 * the kind of judgment call that needs an LLM — a template alone can't do
 * it — so this is the one place in the RAG feature that calls Copilot
 * rather than running fully offline.
 *
 * ONE RECIPE PER CAPABILITY, not per file: a single uploaded file is first
 * split (ragCapabilityExtraction.ts, best-effort for Java/Python) into its
 * individual public methods/constructors, each generated and validated
 * independently — a whole class full of unrelated helpers no longer
 * becomes one bloated, poorly-matchable recipe. A file with no
 * capability-level split available (a config file, or one where
 * extraction found nothing) still gets exactly ONE recipe for the whole
 * file, named exactly as before this feature existed — see
 * `capabilitiesForFile()`'s own doc comment for why that fallback is a
 * hard backward-compatibility guarantee, not just a convenience.
 *
 * Every generated recipe candidate is checked THREE ways before being
 * saved, in order: (1) `normalizeGeneratedRecipe()` — schema/structural
 * validity; (2) `validateSourceGrounding()` — does it actually describe
 * the real capability it was given (a real CALL to the right name on the
 * right owner, with a plausible ARGUMENT COUNT — never types/order, see
 * that function's own doc comment — fences complete, Java import
 * consistent with the real package), for capability-level generations
 * only; (3) `scrubSecretsFromRecipe()` — a DETERMINISTIC
 * scan for credential-shaped values, regardless of whether the model
 * honored the "never reproduce a secret" prompt instruction. Any of the
 * first two failing means the candidate is quarantined as a draft (see
 * `saveRejectedDraft()`), never indexed; the third can't fail a
 * generation — it silently redacts and flags what it found.
 *
 * Vscode-dependent glue (file writing, model resolution) — reviewed rather
 * than unit tested directly, same as llm/copilotClient.ts and
 * agent/vscodeCopilotToolCallingModel.ts; every piece of real decision
 * logic (capability extraction, response normalization, source grounding,
 * secret scrubbing) is pulled out into its own pure, directly-tested
 * module instead.
 */

export interface UploadedFile {
  fileName: string;
  content: string;
  /** Folder path this file lived at inside an uploaded project/framework
   * zip (see zipReader.ts) — empty/undefined for a directly dropped single
   * file. Used to mirror the original directory structure under
   * `.github/rag/` (see `ragTargetRelPath()` in ragRecipeNormalizer.ts). */
  relativePath?: string;
}

export interface GenerationProgress {
  /** A whole file's name for a whole-file generation, or
   * "fileName :: capabilityName" for one specific capability within it —
   * display text only, never matched against anything by exact string
   * elsewhere. */
  fileName: string;
  status: 'started' | 'success' | 'skipped' | 'error';
  message?: string;
  /** Running total of REAL tokens (each model's own tokenizer, via
   * `countModelTokens()` — same primitive that already powers Standard
   * mode's own "Token Monitoring" segment) consumed by this batch SO FAR —
   * every prompt actually sent, plus every response actually received,
   * across every unit processed up to and including this one event. Lets
   * a caller show a live running total next to "End Process" so the user
   * can judge remaining Copilot quota before deciding whether to keep
   * going. Always present (0/0 before the first unit starts) — never
   * `undefined` — so a UI can bind to it unconditionally. */
  tokensSoFar: { sent: number; received: number };
}

const RAG_FOLDER_SEGMENTS = ['.github', 'rag'];

/** Sibling of `.github/rag/` — deliberately NOT a subfolder of it — where a
 * 'rejected' `normalizeGeneratedRecipe()` result's raw response is saved
 * for manual review. Being a sibling, not a subfolder, means it is
 * STRUCTURALLY impossible for ragIndexer.ts's own recursive
 * `.github/rag/**\/*.md` glob to ever pick these up — "outside the indexed
 * corpus" here isn't a naming convention the indexer has to know about and
 * honor, it's a location the indexer's own search pattern can't reach. */
export const RAG_DRAFTS_FOLDER_SEGMENTS = ['.github', 'rag-drafts'];

/** Soft target ceiling for one recipe's saved size — an initial
 * 250–450-token target per capability (never a hard cap): a recipe over
 * this is still saved (a real, complete contract is more useful than none,
 * and a rigid cutoff risks cutting through the very content the earlier
 * RAG-truncation fix went to lengths to avoid), just flagged in its own
 * success message so a reviewer knows to consider splitting the source
 * capability further or accepting the larger unit — exactly the "split
 * the capability or allow a larger complete unit" choice, left to a human
 * rather than guessed at automatically. */
const RAG_RECIPE_TOKEN_TARGET = 450;

/** Saves a rejected response's raw text for a human to look at later —
 * never silently discarded, but never treated as a successful recipe
 * either (see the 'rejected' branch in `generateRagCorpus()` below). Mirrors
 * the SAME relative path a successful recipe would have used, just rooted
 * under `.github/rag-drafts/` instead of `.github/rag/`, so a reviewer can
 * tell at a glance which source file a given draft came from. */
async function saveRejectedDraft(workspaceRoot: vscode.Uri, targetRelPath: string, rawResponse: string, reason: string): Promise<vscode.Uri> {
  const draftsFolder = vscode.Uri.joinPath(workspaceRoot, ...RAG_DRAFTS_FOLDER_SEGMENTS);
  const targetSegments = targetRelPath.split('/');
  if (targetSegments.length > 1) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(draftsFolder, ...targetSegments.slice(0, -1)));
  } else {
    await vscode.workspace.fs.createDirectory(draftsFolder);
  }
  const draftUri = vscode.Uri.joinPath(draftsFolder, ...targetSegments);
  // Scrub (F06) — a REJECTED response is still written to disk under
  // `.github/rag-drafts/`, and the model's raw response can itself have
  // echoed a real credential straight out of the source excerpt it was
  // given, whether or not it was ultimately accepted as a recipe. Applied
  // to the rejection `reason` too, defensively, since some reasons quote
  // fragments of the model's own output back.
  const scrubbedResponse = scrubSecretsFromRecipe(rawResponse).text;
  const scrubbedReason = scrubSecretsFromRecipe(reason).text;
  const draftContent = `<!-- REJECTED by SoftPlay's "Generate RAG Corpus format" — NOT a valid recipe, NOT indexed by RAG.\n     Reason: ${scrubbedReason} -->\n\n${scrubbedResponse}\n`;
  await vscode.workspace.fs.writeFile(draftUri, new TextEncoder().encode(draftContent));
  return draftUri;
}

function readGenerateRecipeInstructions(): string {
  return readFileCachedSync(path.join(__dirname, '..', '..', 'prompts', 'generate-rag-recipe.md'));
}

/** Scans the CURRENT `.github/rag/**\/*.md` corpus and builds a
 * `sourcePath`-identity -> existing-target-path map — the fix for a
 * generated recipe's target filename depending on which OTHER files
 * happened to be in the SAME upload batch (see
 * ragRecipeNormalizer.ts's `resolveRagTargets()` own doc comment): handed
 * to that function so a source already represented in the corpus reuses
 * its OWN already-assigned path on a re-upload, rather than deriving a
 * fresh (potentially different) one from scratch every single batch. Keyed
 * by the exact same lowercased `buildSourceIdentity()` string
 * `resolveRagTargets()` itself uses, so the two line up directly. A recipe
 * with no `sourcePath` at all (hand-authored, or predating this field) has
 * nothing to key by and is simply not included — never a resolution
 * error. Read failures/parse failures for an individual file are skipped
 * silently — this is a best-effort optimization for naming STABILITY, not
 * a source of truth anything else depends on being complete. */
async function buildExistingTargetsByIdentity(ragFolder: vscode.Uri): Promise<Map<string, string>> {
  const byIdentity = new Map<string, string>();
  let mdFiles: vscode.Uri[];
  try {
    mdFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(ragFolder, '**/*.md'));
  } catch {
    return byIdentity;
  }
  for (const uri of mdFiles) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = parseRagFile(new TextDecoder('utf-8').decode(bytes));
      const sourcePath = parsed.ok ? parsed.value.frontmatter.sourcePath : undefined;
      if (!sourcePath) {
        continue;
      }
      const relPath = path.relative(ragFolder.fsPath, uri.fsPath).split(path.sep).join('/');
      byIdentity.set(sourcePath.toLowerCase(), relPath);
    } catch {
      // Unreadable/unparsable — skip; see this function's own doc comment.
    }
  }
  return byIdentity;
}

/** One capability-level (or whole-file) unit of work — the expansion of
 * `UploadedFile[]` into "one entry per recipe to actually generate,"
 * computed once up front so target-path resolution (`resolveRagTargets()`)
 * sees the WHOLE batch, across every file's every capability, before any
 * generation starts. */
interface GenerationUnit {
  file: UploadedFile;
  capability: ExtractedCapability;
  /** Every capability `capabilitiesForFile()` found in this SAME file
   * (including `capability` itself) — the same public/capped list used for
   * actual generation. Kept for anything that genuinely wants THAT scope
   * (currently nothing outside this module) — dependency-hash computation
   * uses `allCallableUnitsInFile` below instead, see A09. */
  allCapabilitiesInFile: ExtractedCapability[];
  /** A09: the file's COMPLETE callable surface (public AND private/
   * protected Java, AND underscore-prefixed Python — see
   * `extractAllCallableUnitsForDependencyDiscovery()`'s own doc comment),
   * uncapped — carried alongside each unit so
   * ragSourceIdentity.ts's `selectSourceHashInput()` can compute a
   * dependency-aware hash (F09) that can actually SEE a private helper
   * `capability` calls, without re-running extraction a second time per
   * capability. Deliberately a SEPARATE field from `allCapabilitiesInFile`
   * above — generation itself (target naming, disambiguation) must keep
   * using ONLY the public/capped list, unaffected by this broader one. */
  allCallableUnitsInFile: ExtractedCapability[];
  /** Display label for progress/log lines — the bare filename for a
   * whole-file unit, "fileName :: capabilityName" for a real capability. */
  label: string;
}

function buildGenerationUnits(files: UploadedFile[]): GenerationUnit[] {
  return files.flatMap((file) => {
    const allCapabilitiesInFile = capabilitiesForFile(file.fileName, file.content);
    const allCallableUnitsInFile = extractAllCallableUnitsForDependencyDiscovery(file.fileName, file.content);
    return allCapabilitiesInFile.map((capability) => ({
      file,
      capability,
      allCapabilitiesInFile,
      allCallableUnitsInFile,
      label: capability.kind === 'whole-file' ? file.fileName : `${file.fileName} :: ${capability.name}`
    }));
  });
}

/** The capability name to use for target-path/source-identity purposes —
 * `undefined` for a 'whole-file' capability, so its target filename and
 * `sourcePath` stay byte-for-byte identical to before this feature
 * existed (see `capabilitiesForFile()`'s own doc comment). Uses `namingId`
 * (falling back to the plain `name`) rather than `name` directly — `name`
 * alone collides for overloaded methods sharing one bare name (e.g.
 * `find(int)`/`find(String)`), which previously made two entirely valid,
 * different overloads resolve to the SAME `sourcePath` and target file,
 * reported as a spurious content conflict by `resolveRagTargets()` in
 * ragRecipeNormalizer.ts — see ragCapabilityExtraction.ts's own doc
 * comment on `namingId`. The capability's own `name` field (used inside
 * the generated contract text itself, never here) is unaffected. */
function capabilityNameForNaming(capability: ExtractedCapability): string | undefined {
  return capability.kind === 'whole-file' ? undefined : capability.namingId ?? capability.name;
}

function buildCapabilityPrompt(instructions: string, file: UploadedFile, capability: ExtractedCapability, javaPackage: string | undefined): string {
  const sourceIdentity = buildSourceIdentity(file.fileName, file.relativePath);
  const ownerLine = capability.ownerClassName ? `### Owner class\n${capability.ownerClassName}\n\n` : '';
  // Scrub the source excerpt BEFORE it ever leaves this machine (F06) — the
  // prompt-only "never reproduce a real secret" instruction is advisory,
  // not enforced, and a source file can itself already contain a real
  // embedded credential the model would otherwise see verbatim (and might
  // echo back, or a cloud-side log of the request might capture). Uses
  // capability.excerpt's RAW (unscrubbed) form for `sourceHash` provenance
  // elsewhere (`normalizeGeneratedRecipe()`'s own `sourceRawContent`
  // param) — hashing must stay based on the real content so
  // rag/ragFreshnessChecker.ts's later re-extraction-and-rehash comparison
  // isn't permanently mismatched against a scrubbed value it can never
  // reproduce again from the real file.
  const scrubbedExcerpt = scrubSecretsFromRecipe(capability.excerpt).text;
  // A01 fix: the signature line is ITS OWN source-derived text, not merely
  // a substring the excerpt scrub above already covers — a credential-
  // shaped default argument value (e.g. Python's
  // `def login(password="SYNTHETIC_SECRET"):`) lives directly in the
  // signature line, and until this fix was sent to the model completely
  // unscrubbed even though the byte-identical text, when it also appears
  // inside `capability.excerpt`, was already redacted there. Scrubbed into
  // its OWN local variable, exactly like `scrubbedExcerpt` above — never
  // mutates `capability.signature` itself, which every OTHER consumer
  // (ragSourceGrounding.ts's F04 argument-count verification,
  // ragSourceIdentity.ts's F09 dependency-aware hashing, ...) still needs
  // as the real, raw signature text, never a redacted stand-in.
  const scrubbedSignature = scrubSecretsFromRecipe(capability.signature).text;
  return (
    `${instructions}\n\n` +
    `### Capability name\n${capability.name}\n\n` +
    `### Kind\n${capability.kind}\n\n` +
    ownerLine +
    `### File's path within the uploaded project\n${sourceIdentity}\n\n` +
    (javaPackage
      ? `### Detected Java package declaration (ground truth — use this verbatim; do not re-derive the package from the path above)\n${javaPackage}\n\n`
      : '') +
    `### Signature\n${scrubbedSignature}\n\n` +
    `### Source excerpt (read-only context — do NOT reproduce this in your output)\n\`\`\`\n${scrubbedExcerpt}\n\`\`\``
  );
}

export interface GenerateRagCorpusOptions {
  modelId: string;
  files: UploadedFile[];
  workspaceRoot: vscode.Uri;
  cancellationToken: vscode.CancellationToken;
  onProgress: (progress: GenerationProgress) => void;
  /** Called once, before any generation starts, for every file whose
   * target `.md` already exists — return `true` to overwrite ALL of them,
   * `false` to skip ALL of them (generation still proceeds for every other
   * file). Lets the caller show one confirmation dialog instead of one per
   * file. */
  confirmOverwrite: (existingFileNames: string[]) => Promise<boolean>;
}

export async function generateRagCorpus(options: GenerateRagCorpusOptions): Promise<{ succeeded: number; skipped: number; failed: number }> {
  const { modelId, files, workspaceRoot, cancellationToken, onProgress, confirmOverwrite } = options;
  const ragFolder = vscode.Uri.joinPath(workspaceRoot, ...RAG_FOLDER_SEGMENTS);

  // Live running total of REAL tokens consumed by this batch so far — see
  // GenerationProgress.tokensSoFar's own doc comment. `emitProgress()`
  // (used everywhere in this function that used to call `onProgress()`
  // directly) stamps the CURRENT totals onto every event automatically, so
  // neither total needs repeating at each of this function's many
  // individual progress call sites.
  let sentTokensTotal = 0;
  let receivedTokensTotal = 0;
  const emitProgress = (progress: Omit<GenerationProgress, 'tokensSoFar'>): void =>
    onProgress({ ...progress, tokensSoFar: { sent: sentTokensTotal, received: receivedTokensTotal } });

  // Batch-level setup — creating .github/rag, reading the bundled prompt
  // instructions, expanding files into per-capability units, resolving
  // target paths, and the one overwrite-confirm dialog — used to run
  // OUTSIDE any try/catch. A failure here (folder creation denied, the
  // bundled prompt file missing from a broken install, ...) propagated
  // straight out of this function uncaught; since this is always awaited
  // from a fire-and-forget message handler (see settingsPanel.ts's
  // handleGenerateRagCorpus()), that left the webview's "Generate" button
  // disabled forever with no `ragGenerationDone` message ever coming to
  // re-enable it. This function now ALWAYS resolves — never rejects — so
  // its caller can always send a terminal message; see settingsPanel.ts's
  // own belt-and-suspenders try/catch around the call for the other half
  // of this fix.
  let instructions: string;
  let units: GenerationUnit[];
  let resolutions: ReturnType<typeof resolveRagTargets>;
  let targets: string[];
  let existing: Set<string>;
  let overwriteApproved: boolean;
  try {
    await vscode.workspace.fs.createDirectory(ragFolder);
    instructions = readGenerateRecipeInstructions();

    // Expand every uploaded file into its individual capabilities (or one
    // whole-file unit when no split is available) BEFORE resolving target
    // paths, so collision disambiguation (resolveRagTargets()) sees every
    // recipe this batch will actually try to generate — including two
    // capabilities from the SAME file, which must never be treated as
    // duplicates/conflicts of each other.
    units = buildGenerationUnits(files);

    // Surface F03's "silent 20-method cutoff" explicitly — a file with
    // MORE real capabilities than MAX_CAPABILITIES_PER_FILE previously had
    // the excess simply vanish with no trace at all; now the user is told
    // exactly how many were left out and why, per file. Purely
    // informational (never counted as skipped/failed in the final
    // succeeded/skipped/failed tally) — every capability that WAS
    // extracted still goes through the normal generation loop below
    // exactly as before.
    for (const file of files) {
      const deferredCount = countDeferredCapabilities(file.fileName, file.content);
      if (deferredCount > 0) {
        emitProgress({
          fileName: file.fileName,
          status: 'skipped',
          message: `This file has ${deferredCount} additional public method(s) beyond the ${MAX_CAPABILITIES_PER_FILE}-per-file extraction limit — they were NOT generated. Split this file or re-upload it in smaller pieces to cover the rest.`
        });
      }
    }

    const targetSources: RagTargetSource[] = units.map((unit) => ({
      fileName: unit.file.fileName,
      relativePath: unit.file.relativePath,
      content: unit.capability.excerpt,
      capabilityName: capabilityNameForNaming(unit.capability)
    }));
    // Reuse an already-existing recipe's own path for a source already
    // represented in the corpus (see `buildExistingTargetsByIdentity()`'s
    // own doc comment) — makes a re-upload of a subset of a prior batch
    // reliably OVERWRITE the same file(s) rather than silently deriving a
    // differently-named duplicate.
    const existingTargetsByIdentity = await buildExistingTargetsByIdentity(ragFolder);
    resolutions = resolveRagTargets(targetSources, existingTargetsByIdentity);
    targets = resolutions.map((r) => r.targetRelPath);

    // One batch-level overwrite confirmation rather than one dialog per
    // recipe. Each target is a full relative path (e.g.
    // "src/db/postgres-helper-queryone.md") so two same-named
    // files/capabilities from different zip folders never collide.
    existing = new Set<string>();
    const uniqueTargets = new Set(resolutions.filter((r) => r.status !== 'conflict').map((r) => r.targetRelPath));
    for (const targetName of uniqueTargets) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(ragFolder, targetName));
        existing.add(targetName);
      } catch {
        // Doesn't exist yet — nothing to confirm for this one.
      }
    }
    overwriteApproved = existing.size === 0 ? true : await confirmOverwrite(Array.from(existing));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    for (const file of files) {
      emitProgress({ fileName: file.fileName, status: 'error', message: `Could not start generation: ${message}` });
    }
    return { succeeded: 0, skipped: 0, failed: files.length };
  }

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  // A07: per-FILE cache (not per-capability — every capability extracted
  // from the same `file` shares the identical answer, since resolution
  // only ever depends on `file.fileName`/`file.relativePath`, never on
  // which capability is being generated) for whether this upload's own
  // path can be confirmed present in some currently open workspace folder
  // — see `isSourceMappedAtGeneration()` below. Keyed by object identity
  // (the same `UploadedFile` instance is shared across every capability
  // `buildGenerationUnits()` extracted from it), scoped to THIS single
  // `generateRagCorpus()` call so nothing here outlives one generation
  // batch or leaks across unrelated calls.
  const sourceMappedCache = new Map<UploadedFile, Promise<boolean>>();
  function isSourceMappedAtGeneration(file: UploadedFile): Promise<boolean> {
    let cached = sourceMappedCache.get(file);
    if (!cached) {
      // The exact same identity string resolveSourceFile() itself expects
      // (it strips any `#capabilityName` suffix internally) — built without
      // a capability name here since mapping is a property of the FILE,
      // never of one specific capability within it.
      const wholeFileSourcePath = buildSourceIdentity(file.fileName, file.relativePath);
      cached = resolveSourceFile(vscode.workspace.workspaceFolders ?? [], wholeFileSourcePath).then((resolution) => resolution.kind === 'found');
      sourceMappedCache.set(file, cached);
    }
    return cached;
  }

  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const { file, capability, label } = unit;
    const targetName = targets[i];
    const resolution = resolutions[i];
    if (cancellationToken.isCancellationRequested) {
      emitProgress({ fileName: label, status: 'skipped', message: 'Cancelled.' });
      skipped += 1;
      continue;
    }
    if (resolution.status === 'duplicate') {
      const other = units[resolution.matchesIndex!];
      emitProgress({
        fileName: label,
        status: 'skipped',
        message: `Identical duplicate of "${other.label}" already in this batch — skipped rather than generating it twice.`
      });
      skipped += 1;
      continue;
    }
    if (resolution.status === 'conflict') {
      const other = units[resolution.matchesIndex!];
      failed += 1;
      emitProgress({
        fileName: label,
        status: 'error',
        message:
          `Conflicts with "${other.label}" in this same batch — both share the same name and folder but have ` +
          'different content, so which one should win is ambiguous. Rename one of them (or place them in ' +
          'different folders) and try again.'
      });
      continue;
    }
    if (existing.has(targetName) && !overwriteApproved) {
      emitProgress({ fileName: label, status: 'skipped', message: `${targetName} already exists — not overwritten.` });
      skipped += 1;
      continue;
    }

    emitProgress({ fileName: label, status: 'started' });
    try {
      // The file's real location within the uploaded project (and, for
      // Java, its own authoritative `package` declaration) — ground truth
      // this extension already has, handed to the model explicitly instead
      // of leaving it to guess an import/module path from a bare filename.
      // Python especially has no self-declared module path at all; without
      // this, "framework/db/client.py" is presented as just "client.py"
      // with nothing to derive `framework.db.client` from. See
      // ragSourceIdentity.ts and generate-rag-recipe.md's own instructions
      // for how the model is told to use (and when to distrust) this.
      const javaPackage = extractJavaPackageDeclaration(file.content);
      const prompt = buildCapabilityPrompt(instructions, file, capability, javaPackage);
      // Measured BEFORE sending, using the SAME real-tokenizer primitive
      // ("Token Monitoring" section) already used elsewhere in this file
      // for the saved-recipe size check below — counted here regardless of
      // how this unit's own request turns out (cancelled mid-flight,
      // rejected, or a genuine error), since the prompt has already left
      // the machine and counts against the user's real Copilot quota the
      // moment `sendPrompt()` is called, not only once a response comes
      // back. The one rare exception — `sendPrompt()`'s own token-budget
      // preflight rejecting an oversized prompt BEFORE any real request
      // goes out — is deliberately not special-cased: keeping this simple
      // is worth a negligible overcount in that uncommon case, for a
      // monitoring figure that was never meant to be a precise billing
      // ledger.
      const promptMeasured = await countModelTokens(modelId, prompt, cancellationToken);
      sentTokensTotal += promptMeasured?.count ?? 0;
      let response = '';
      await sendPrompt(modelId, prompt, (chunk) => (response += chunk), cancellationToken);
      const responseMeasured = await countModelTokens(modelId, response, cancellationToken);
      receivedTokensTotal += responseMeasured?.count ?? 0;

      // F14 fix: re-check AFTER the model call — the only cancellation
      // check before this point (at the TOP of this loop iteration) can't
      // see a cancellation that arrived WHILE `sendPrompt()` was in
      // flight. `sendPrompt()`'s own cancellation token is passed straight
      // through to `model.sendRequest()`, but a response that finishes at
      // (or just after) the moment cancellation fires can still resolve
      // normally rather than reject — without this check, execution would
      // silently continue on into normalization/scrubbing/writing a
      // recipe the user already asked to stop generating. Reported as
      // 'skipped' (never 'success' — nothing was saved — and never
      // 'error', since nothing actually went wrong).
      if (cancellationToken.isCancellationRequested) {
        emitProgress({ fileName: label, status: 'skipped', message: 'Cancelled after the model responded — not saved.' });
        skipped += 1;
        continue;
      }

      // F09: hash the CAPABILITY's own excerpt PLUS its same-file
      // dependencies (never the whole file) — a change elsewhere in the
      // file that this capability does NOT depend on must never mark THIS
      // recipe stale, but a change to a same-file helper it DOES call
      // through to now correctly does (see rag/ragFreshnessChecker.ts's
      // extractComparableContent(), which re-derives this SAME
      // canonicalized content from the file's current content before
      // comparing, for exactly this reason).
      const sourceHashInput = selectSourceHashInput(capability, unit.allCallableUnitsInFile);
      // A07: confirm (or not) that this upload's OWN source path exists in
      // some open workspace folder RIGHT NOW, at generation time — stamped
      // onto the recipe so a LATER "not found" during freshness checking
      // can tell "this genuinely went missing" (was present, now isn't)
      // apart from "this was never mapped into a workspace to begin with"
      // (a true external upload) — see ragFreshnessChecker.ts's
      // classifyFreshness() and ragTypes.ts's own doc comment on
      // `sourceMapped` for how each case is reported.
      const sourceMapped = await isSourceMappedAtGeneration(file);
      let normalized = normalizeGeneratedRecipe(
        file.fileName,
        response,
        file.relativePath,
        sourceHashInput.content,
        capabilityNameForNaming(capability),
        sourceHashInput.scheme,
        sourceMapped
      );

      // Source grounding — layered ON TOP of schema validation, and ONLY
      // for a real per-capability generation (the whole-file fallback path
      // keeps exactly its pre-existing validation, unchanged, for
      // backward compatibility — see validateSourceGrounding()'s own doc
      // comment). Schema-valid frontmatter says nothing about whether the
      // model actually described the real capability it was given.
      if (normalized.status !== 'rejected' && capability.kind !== 'whole-file') {
        const reparsed = parseRagFile(normalized.content!);
        if (reparsed.ok) {
          const grounding = validateSourceGrounding(reparsed.value.body, reparsed.value.frontmatter.imports?.java, capability, javaPackage);
          if (!grounding.ok) {
            normalized = { status: 'rejected', reason: `Source-grounding check failed: ${grounding.reason}` };
          }
        }
      }

      if (normalized.status === 'rejected') {
        // Never written into .github/rag, never indexed — see
        // ragRecipeNormalizer.ts's own doc comment on why 'rejected' has no
        // `content` at all. The raw response is still preserved (a draft,
        // outside the indexed corpus) rather than silently discarded, so a
        // human can decide whether it's salvageable by hand.
        failed += 1;
        const draftUri = await saveRejectedDraft(workspaceRoot, targetName, response, normalized.reason!);
        emitProgress({
          fileName: label,
          status: 'error',
          message: `Rejected — ${normalized.reason} Raw response saved for review at "${vscode.workspace.asRelativePath(draftUri)}" (NOT indexed).`
        });
        continue;
      }

      // Deterministic secret scrub — a DETERMINISTIC check, not a prompt
      // instruction: the model was told never to reproduce a real secret,
      // but "the model followed an instruction" is never itself a
      // guarantee. Any credential-shaped value still present is redacted
      // right here, regardless of whether it came from the model
      // hallucinating one or copying one straight out of the source
      // excerpt it was given.
      const scrubbed = scrubSecretsFromRecipe(normalized.content!);
      const finalContent = scrubbed.text;

      // Revalidate AFTER scrubbing (F07) — redaction is a text-level regex
      // replace, not a structure-aware edit; a scrub that (despite its own
      // best effort) still lands badly enough to break the file's
      // frontmatter/body structure must never be silently written into the
      // indexed corpus as if nothing happened. Never blocks on a scrub
      // that changed nothing structurally significant — this only fires
      // when the POST-scrub content genuinely fails to parse.
      const revalidated = parseRagFile(finalContent);
      if (!revalidated.ok) {
        failed += 1;
        const draftUri = await saveRejectedDraft(workspaceRoot, targetName, finalContent, `Secret scrubbing left the recipe structurally invalid: ${revalidated.error}`);
        emitProgress({
          fileName: label,
          status: 'error',
          message: `Rejected after secret scrubbing — the result is no longer a valid recipe (${revalidated.error}). Raw (scrubbed) response saved for review at "${vscode.workspace.asRelativePath(draftUri)}" (NOT indexed).`
        });
        continue;
      }

      // Recipe-size target — informational only (never blocks saving; see
      // RAG_RECIPE_TOKEN_TARGET's own doc comment). Measured against
      // whichever model is ACTUALLY selected, via its real tokenizer
      // (llm/copilotClient.ts's countModelTokens) — never a
      // characters-per-token assumption.
      const measured = await countModelTokens(modelId, finalContent, cancellationToken);
      const sizeNote =
        measured && measured.count > RAG_RECIPE_TOKEN_TARGET
          ? ` (${measured.count} tokens — over the ${RAG_RECIPE_TOKEN_TARGET}-token target; consider splitting this capability further.)`
          : '';
      const scrubNote = scrubbed.scrubbedCount > 0 ? ` ${scrubbed.scrubbedCount} credential-shaped value(s) were redacted before saving.` : '';

      const targetSegments = targetName.split('/');
      if (targetSegments.length > 1) {
        // Recreate the original folder structure (e.g. "src/db") before
        // writing — vscode.workspace.fs.createDirectory creates any
        // missing intermediate directories too, like `mkdir -p`.
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(ragFolder, ...targetSegments.slice(0, -1)));
      }
      const targetUri = vscode.Uri.joinPath(ragFolder, ...targetSegments);

      // F14 fix: a SECOND, LAST-LINE-OF-DEFENSE re-check immediately
      // before the actual write — the async gap since the check right
      // after sendPrompt() above (normalization, source grounding, secret
      // scrubbing, revalidation, the countModelTokens() call, directory
      // creation) is real time cancellation could arrive during, and this
      // is the actual side effect ("check ... immediately before side
      // effects") that must never happen once cancellation has been
      // requested.
      if (cancellationToken.isCancellationRequested) {
        emitProgress({ fileName: label, status: 'skipped', message: 'Cancelled — not saved.' });
        skipped += 1;
        continue;
      }
      await vscode.workspace.fs.writeFile(targetUri, new TextEncoder().encode(finalContent));

      succeeded += 1;
      emitProgress({
        fileName: label,
        status: 'success',
        message: `Saved as ${targetName}${normalized.status === 'repaired' ? ` — ${normalized.reason}` : '.'}${sizeNote}${scrubNote}`
      });
    } catch (err) {
      // "End Process": `sendPrompt()`/`countModelTokens()` above pass
      // `cancellationToken` straight into `vscode.lm`'s own
      // `model.sendRequest()` — when the token fires WHILE that request is
      // actually in flight, VS Code aborts it immediately and rejects with
      // a `vscode.CancellationError` (rather than letting it resolve
      // normally, which is what the OTHER `isCancellationRequested` checks
      // in this loop are for). This is a clean, user-requested stop, not a
      // failure — report and count it exactly like every other
      // cancellation checkpoint above ('skipped', never 'error'/'failed'),
      // so ending the process mid-request never shows a spurious failure
      // for whichever unit happened to be running at that moment.
      if (err instanceof vscode.CancellationError || cancellationToken.isCancellationRequested) {
        emitProgress({ fileName: label, status: 'skipped', message: 'Cancelled — not saved.' });
        skipped += 1;
        continue;
      }
      // sendPrompt() (llm/copilotClient.ts) now runs its own token-budget
      // preflight before ever contacting Copilot — an oversized source
      // excerpt surfaces here as a PromptTooLargeError with a concrete
      // token count and actionable guidance, not a raw provider rejection
      // or a silent send of a request already known to be too large.
      // `PromptTooLargeError` extends `Error`, so its message flows
      // straight through the fallback branch below with no special-casing
      // needed.
      failed += 1;
      const message = err instanceof CopilotUnavailableError ? err.message : err instanceof Error ? err.message : String(err);
      emitProgress({ fileName: label, status: 'error', message });
    }
  }

  return { succeeded, skipped, failed };
}
