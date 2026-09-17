import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * mtime-validated file-content caches — local system memory only, no disk
 * persistence of its own (the cache itself disappears on extension
 * deactivation; only the mtime check is disk I/O, and it's a single cheap
 * `stat`, far cheaper than re-reading and re-decoding the whole file).
 *
 * Two variants because this extension reads two different kinds of files
 * through two different APIs:
 *  - `readFileCachedSync`: bundled files shipped inside the extension
 *    itself (e.g. prompts/*.md) — plain Node `fs`, synchronous, matches how
 *    they were already being read before caching was added.
 *  - `readWorkspaceFileCached`: user-selected files living in the *editor's*
 *    workspace (e.g. linked custom-instruction .md files) — must go through
 *    `vscode.workspace.fs` so virtual/remote workspaces keep working, and
 *    these are far more likely to be edited mid-session, which is exactly
 *    why the cache is mtime-checked rather than "read once and keep
 *    forever."
 */

interface CachedFile {
  mtimeMs: number;
  content: string;
}

const syncCache = new Map<string, CachedFile>();

/** Reads `absPath` with Node's `fs`, caching by content keyed on the file's
 * own mtime — a file edited on disk (e.g. a prompt file during development)
 * is picked up on the very next read, while an unchanged file skips the
 * actual read+decode. Missing/unreadable resolves to `fallback`, same
 * "benign, never a hard failure" behavior the call sites already relied on
 * before this cache existed. */
export function readFileCachedSync(absPath: string, fallback = ''): string {
  try {
    const stat = fs.statSync(absPath);
    const cached = syncCache.get(absPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.content;
    }
    const content = fs.readFileSync(absPath, 'utf8');
    syncCache.set(absPath, { mtimeMs: stat.mtimeMs, content });
    return content;
  } catch {
    return fallback;
  }
}

const workspaceCache = new Map<string, CachedFile>();

// R02 (external review, 2026-09-17): bumped by clearFileCaches() — a
// readWorkspaceFileCached() call already in flight (its own `stat`/
// `readFile` awaits) when a "Clear Data"/"Kill All Browsers" reset fires
// captures the epoch BEFORE that work starts, and only actually WRITES
// `workspaceCache` if the epoch is still the one it started with. Without
// this, a Custom Instructions file read that was already in progress at
// reset time could still complete afterward and silently repopulate the
// just-cleared cache — the exact same race class already closed for the
// RAG index cache (see rag/ragIndexer.ts's own `epoch`). The in-flight
// call's own caller still gets the real, freshly-read content back
// (harmless on its own — see objectSpyPanel.ts's own request-epoch guard
// for why that stale caller's RESULT is separately prevented from ever
// reaching a prompt or the model); only the shared cache itself is
// protected from being repopulated post-reset. `readFileCachedSync`
// (bundled prompts) needs no equivalent — it's fully synchronous, so there
// is no in-flight window for a reset to race against at all.
let workspaceCacheEpoch = 0;

/** Same idea as `readFileCachedSync`, for a file reached through
 * `vscode.workspace.fs` (the user-linked custom-instruction files) instead
 * of plain `fs`. Throws exactly like a direct `vscode.workspace.fs.readFile`
 * would on a missing/unreadable file — callers here already wrap this in
 * their own try/catch (see readInstructionFiles()), so this stays a
 * transparent drop-in rather than swallowing errors itself. */
export async function readWorkspaceFileCached(uri: vscode.Uri): Promise<string> {
  const capturedEpoch = workspaceCacheEpoch;
  const stat = await vscode.workspace.fs.stat(uri);
  const key = uri.toString();
  const cached = workspaceCache.get(key);
  if (cached && cached.mtimeMs === stat.mtime) {
    return cached.content;
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  const content = new TextDecoder('utf-8').decode(bytes);
  if (workspaceCacheEpoch === capturedEpoch) {
    workspaceCache.set(key, { mtimeMs: stat.mtime, content });
  }
  return content;
}

/** Drops every cached file (both variants) and bumps `workspaceCacheEpoch`
 * — see its own doc comment for why the epoch matters on top of just
 * clearing the Map. Not currently wired to a command — exposed for
 * symmetry with the other caches and for tests. */
export function clearFileCaches(): void {
  syncCache.clear();
  workspaceCache.clear();
  workspaceCacheEpoch++;
}
