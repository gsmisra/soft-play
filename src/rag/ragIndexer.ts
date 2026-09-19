import * as vscode from 'vscode';
import * as path from 'path';
import { parseRagFile } from './ragFrontmatter';
import { RagRecipe } from './ragTypes';
import { buildRagIndex, RagIndex } from './ragIndexBuilder';

export type { RagIndex } from './ragIndexBuilder';

/**
 * The vscode-aware half of RAG indexing — finds every `.md` file under
 * `.github/rag/`, recursively (a project/framework zip dropped on
 * "Generate RAG Corpus format" preserves its own folder structure there —
 * see ragCorpusGenerator.ts, zipReader.ts — so retrieval has to walk every
 * subfolder too, not just the top level), parses each one
 * (ragFrontmatter.ts), and hands the result to ragIndexBuilder.ts's pure
 * `buildRagIndex()`. Uses `vscode.workspace.findFiles` (glob-based, so
 * recursion is a one-line pattern rather than a hand-rolled directory walk)
 * so this keeps working in virtual/remote workspaces, not just a local disk
 * checkout.
 *
 * Cached in-memory, invalidated by a fingerprint of every recipe file's
 * path + mtime + size — the same "re-read only when something actually
 * changed" idea as cache/fileCache.ts, just fingerprinting a whole
 * directory tree's listing instead of one file. A missing `.github/rag`
 * folder, or one with no valid `.md` recipes anywhere under it, resolves to
 * `undefined` — always treated as "retrieval has nothing to offer right
 * now," never as an error a user needs to fix before generating code.
 */

const RAG_FOLDER_SEGMENTS = ['.github', 'rag'];

export function ragFolderUri(workspaceRoot: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(workspaceRoot, ...RAG_FOLDER_SEGMENTS);
}

interface CachedIndex {
  fingerprint: string;
  index: RagIndex;
}

let cached: CachedIndex | undefined;
// R02: bumped by clearRagIndexCache() — an in-flight getOrBuildRagIndex()
// call captures the epoch BEFORE its own async read/parse work starts, and
// only actually WRITES `cached` if the epoch is still the one it started
// with. Without this, a build already in flight when "Clear Data"/"Kill
// All Browsers" fires could still complete afterward and silently
// repopulate the just-cleared cache with its (now stale-relative-to-the-
// reset) result — the exact "cache survives a reset" gap a review
// reproduced. The one in-flight caller still gets its own computed index
// back (harmless — its own request is being cancelled through its own,
// separate cancellation token regardless), only the SHARED module cache
// itself is protected from being repopulated post-reset.
let epoch = 0;

async function computeFingerprint(uris: vscode.Uri[]): Promise<string> {
  const stats = await Promise.all(
    uris.map(async (uri) => {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        return `${uri.fsPath}:${stat.mtime}:${stat.size}`;
      } catch {
        // Deleted/inaccessible in the window between findFiles() and this
        // stat() — a real race on a live workspace, not a hypothetical one.
        // Previously this rejected the WHOLE Promise.all, which propagated
        // out of getOrBuildRagIndex() uncaught and could leave a caller's
        // request stuck (see runLlmRefinement()'s own fix for that). The
        // actual read loop below already tolerates exactly this same race
        // per-file (its own try/catch + onWarn, skipping just that file) —
        // the fingerprint must be equally tolerant, or a transient race
        // here would crash retrieval entirely before that loop even runs.
        // Folding the file's own path into the "missing" marker still
        // changes the fingerprint (forcing a rebuild) rather than masking
        // the change, which is exactly what should happen either way.
        return `${uri.fsPath}:MISSING`;
      }
    })
  );
  return stats.sort().join('|');
}

/** Builds (or reuses a cached) RAG index for `workspaceRoot`. `undefined`
 * means "nothing to retrieve" (no folder, or no valid recipes in it) —
 * never throws for that. `onWarn`, if given, is called once per recipe
 * file that exists but fails to parse (e.g. malformed frontmatter from a
 * hand-edited file), so the caller can surface it (Output channel) without
 * this function needing to know how — PLUS (F16) once more with an
 * aggregate "N valid recipe(s) indexed; M skipped" summary whenever at
 * least one file was skipped, so a `.github/rag/` folder that visibly
 * contains files but silently indexes NONE of them (every one failed to
 * parse) is never a purely invisible mismatch to a caller already
 * surfacing `onWarn`'s own messages. Only called on an actual (re)build —
 * a cache HIT (nothing changed since the last real build) calls `onWarn`
 * zero times, same as it always has, since nothing new was re-derived to
 * warn about. */
export async function getOrBuildRagIndex(workspaceRoot: vscode.Uri, onWarn?: (message: string) => void): Promise<RagIndex | undefined> {
  // R02: captured BEFORE any async work — see `epoch`'s own doc comment.
  const capturedEpoch = epoch;
  const folder = ragFolderUri(workspaceRoot);
  let mdFiles: vscode.Uri[];
  try {
    mdFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.md'));
  } catch {
    return undefined;
  }

  if (mdFiles.length === 0) {
    cached = undefined;
    return undefined;
  }

  const fingerprint = await computeFingerprint(mdFiles);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.index;
  }

  const recipes: RagRecipe[] = [];
  for (const uri of mdFiles) {
    let content: string;
    let mtimeMs: number;
    try {
      const [bytes, stat] = await Promise.all([vscode.workspace.fs.readFile(uri), vscode.workspace.fs.stat(uri)]);
      content = new TextDecoder('utf-8').decode(bytes);
      mtimeMs = stat.mtime;
    } catch (err) {
      onWarn?.(`Could not read ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = parseRagFile(content);
    if (!parsed.ok) {
      onWarn?.(`Skipping ${uri.fsPath} — ${parsed.error}`);
      continue;
    }
    // Relative to the .github/rag/ folder itself (see RagRecipe's own doc
    // comment for why NOT the full absolute machine path) — normalized to
    // forward slashes so a recipe's own folder/file-name keywords match
    // consistently regardless of whether this indexing ran on Windows or
    // POSIX.
    const relativePath = path.relative(folder.fsPath, uri.fsPath).split(path.sep).join('/');
    recipes.push({ filePath: uri.fsPath, relativePath, frontmatter: parsed.value.frontmatter, body: parsed.value.body, mtimeMs });
  }

  // F16: a per-file skip reason (above) is easy to miss buried in the
  // Output channel, and says nothing about the AGGREGATE picture — a
  // workspace can have a `.github/rag/` folder a user can see files in,
  // while the real indexed corpus is silently empty (every file present
  // failed to parse), with no visible sign anywhere that a mismatch even
  // exists. This one summary line — emitted only when there's an actual
  // gap to report, never for the common all-valid case — makes that
  // "visible library, empty index" mismatch impossible to miss for anyone
  // already watching the same Output channel `onWarn`'s own per-file
  // messages go to.
  if (recipes.length < mdFiles.length) {
    const skipped = mdFiles.length - recipes.length;
    onWarn?.(`Indexed ${recipes.length} valid recipe(s); skipped ${skipped} file(s) that could not be read or parsed as a recipe — see the reason(s) above.`);
  }

  if (recipes.length === 0) {
    cached = undefined;
    return undefined;
  }

  const index = await buildRagIndex(recipes);
  // R02: only write back to the SHARED cache if nothing reset it while
  // this build was in flight — see `epoch`'s own doc comment. This
  // request's own caller still gets a real, freshly-built index either
  // way; only the module-level cache is protected from a stale repopulate.
  if (epoch === capturedEpoch) {
    cached = { fingerprint, index };
  }
  return index;
}

/**
 * Reads and parses ONLY the given already-known `.github/rag/*.md` files,
 * given as paths WORKSPACE-relative (exactly what `vscode.workspace.asRelativePath()`
 * produces, and exactly what the "RAG Data" checkbox list's own values
 * already are — see `objectSpyPanel.ts`'s `partitionRagFilesByValidity()`)
 * — used for an explicit manual selection (`rag/ragPackingPipeline.ts`),
 * which must never require a full corpus scan/fingerprint/index build just
 * to send the handful of files the user actually checked. Resolving each
 * path directly against `workspaceRoot` (rather than comparing against
 * `RagRecipe.relativePath`, which is relative to `.github/rag/` ITSELF, a
 * genuinely different string) is also what keeps this correct regardless
 * of path format — no separate normalization step needed at the call site.
 *
 * A path that no longer exists, or fails to parse, is logged via `onWarn`
 * AND returned in `unusable` with its reason (never thrown here) — every
 * selected path lands in exactly one of `loaded`/`unusable`, so the caller
 * can refuse to proceed rather than quietly generate without a recipe the
 * user explicitly checked. `loaded` keeps the caller's own selected path
 * beside each recipe (for accurate error messages), in selection order.
 */
export async function loadRagRecipesByPath(
  workspaceRoot: vscode.Uri,
  workspaceRelativePaths: string[],
  onWarn?: (message: string) => void
): Promise<{ loaded: { path: string; recipe: RagRecipe }[]; unusable: { path: string; reason: string }[] }> {
  const folder = ragFolderUri(workspaceRoot);
  const loaded: { path: string; recipe: RagRecipe }[] = [];
  const unusable: { path: string; reason: string }[] = [];
  for (const workspaceRelativePath of workspaceRelativePaths) {
    const uri = vscode.Uri.joinPath(workspaceRoot, workspaceRelativePath);
    try {
      const [bytes, stat] = await Promise.all([vscode.workspace.fs.readFile(uri), vscode.workspace.fs.stat(uri)]);
      const content = new TextDecoder('utf-8').decode(bytes);
      const parsed = parseRagFile(content);
      if (!parsed.ok) {
        onWarn?.(`Manually selected "${workspaceRelativePath}" could not be used — ${parsed.error}`);
        unusable.push({ path: workspaceRelativePath, reason: `not a valid recipe — ${parsed.error}` });
        continue;
      }
      // Same relative-to-.github/rag/ normalization as getOrBuildRagIndex()
      // above, for consistency with every other RagRecipe this codebase
      // ever produces (embedding text, traceability banners, ...).
      const relativePath = path.relative(folder.fsPath, uri.fsPath).split(path.sep).join('/');
      loaded.push({
        path: workspaceRelativePath,
        recipe: { filePath: uri.fsPath, relativePath, frontmatter: parsed.value.frontmatter, body: parsed.value.body, mtimeMs: stat.mtime }
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      onWarn?.(`Manually selected "${workspaceRelativePath}" could not be read: ${reason} (renamed or deleted since it was selected?)`);
      unusable.push({ path: workspaceRelativePath, reason });
    }
  }
  return { loaded, unusable };
}

/** Forces the next `getOrBuildRagIndex()` call to rebuild from disk
 * regardless of the fingerprint — not currently wired to a command,
 * exposed for tests and a future explicit "rebuild index" affordance. Also
 * called automatically right after the RAG corpus generator writes new
 * files (see ragCorpusGenerator.ts) so the very next code generation
 * already sees them, without waiting for a fingerprint recheck. */
export function clearRagIndexCache(): void {
  cached = undefined;
  epoch++;
}
