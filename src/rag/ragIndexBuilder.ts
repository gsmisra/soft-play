import * as crypto from 'crypto';
import { Document } from '@langchain/core/documents';
import { TfIdfEmbeddings } from './tfidfEmbeddings';
import { LocalFlatVectorStore } from './flatVectorStore';
import { RagRecipe, recipeToEmbeddingText } from './ragTypes';

/**
 * The pure half of RAG indexing — given already-parsed recipes (see
 * ragTypes.ts), fits the TF-IDF embedder and builds the flat vector store.
 * Zero `vscode` import, so it's directly unit-testable with hand-built
 * `RagRecipe` fixtures — the actual "does retrieval rank the right recipe
 * highest" logic lives and is tested here, not in the vscode-dependent
 * directory-reading glue (ragIndexer.ts), matching the same split already
 * used for the Verify & Fix agent (agent/verifyFixAgent.ts vs.
 * agent/verifyFixOrchestrator.ts).
 */
export interface RagIndex {
  store: LocalFlatVectorStore;
  embeddings: TfIdfEmbeddings;
  recipes: RagRecipe[];
  /** The SAME corpus-wide-deduped ids baked into `store`'s Document
   * metadata (see `RagRecipeMetadata.id`'s own doc comment) — same
   * order/length as `recipes`, so `recipes[i]`'s canonical id is
   * `canonicalIds[i]`. Any consumer that needs to identify a recipe from
   * `recipes` by id (e.g. ragHybridRetriever.ts's semantic ranking, which
   * never touches the vector store's metadata directly) MUST use this,
   * never `recipe.frontmatter.id` — see `dedupeRecipeIds()`'s own doc
   * comment for why the raw frontmatter id can collide across recipes. */
  canonicalIds: string[];
}

export interface RagRecipeMetadata extends Record<string, unknown> {
  /** The recipe's own frontmatter `id` — EXCEPT when two or more recipes
   * in this corpus share the same `frontmatter.id` (a model-supplied value
   * with no cross-generation uniqueness guarantee — see
   * `dedupeRecipeIds()` below), in which case every occurrence is
   * corpus-wide disambiguated. Always use THIS field, never
   * `recipe.frontmatter.id` directly, when identifying a retrieval result —
   * see ragRetriever.ts's `RagMatch.id`. */
  id: string;
  title: string;
  automationMode: string[];
  language: string[];
  imports?: { java?: string[]; python?: string[] };
  recipeIndex: number;
  /** The recipe's own source file path (see RagRecipe.filePath) — carried
   * through the vector store into every RagMatch so a caller can point a
   * user at EXACTLY which `.github/rag/*.md` file a piece of generated
   * code was traced back to (see ragRetriever.ts's RagMatch and
   * objectSpyPanel.ts's RAG traceability banner). */
  filePath: string;
  /** The SAME workspace-relative path (see RagRecipe.relativePath's own
   * doc comment) already folded into this recipe's embedding text — carried
   * through into metadata too so ranking-time logic (ragRetriever.ts's
   * path/filename keyword-match boost) can check it directly against the
   * portable, machine-independent path rather than the absolute `filePath`
   * above, which embeds a local machine's own checkout location. */
  relativePath: string;
}

/** Short, stable, deterministic hash of a recipe's own absolute `filePath`
 * — used ONLY to disambiguate a duplicate `frontmatter.id` (see
 * `dedupeRecipeIds()` below), never for anything security-sensitive (SHA-1
 * is fine here, same "collision-avoidance suffix, not an integrity
 * fingerprint" posture as ragRecipeNormalizer.ts's own `shortHash()`, which
 * this deliberately mirrors — kept as its own private copy rather than a
 * shared import so this module has no dependency on that one). */
function shortHash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 8);
}

/**
 * A generated recipe's `id` is supplied by the MODEL (see
 * ragCorpusGenerator.ts/ragRecipeNormalizer.ts — nothing forces it to be
 * unique across independent generations, or across a generated recipe and
 * a hand-authored one), yet `retrieveForOperations()`
 * (ragOperationRetrieval.ts) deduplicates candidates BY that same id — two
 * genuinely DIFFERENT recipes sharing one id would silently collapse into
 * a single retrieval result, discarding one entirely and, worse,
 * potentially crediting it for an operation the discarded recipe (not the
 * surviving one) was the actual match for. This is the one place the
 * WHOLE corpus is known at once, so it's the only place a corpus-wide
 * uniqueness violation can actually be caught and fixed.
 *
 * Every id that occurs MORE THAN ONCE across `recipes` is disambiguated —
 * EVERY occurrence, including the first, gets a stable hash of its own
 * `filePath` appended (never leaving exactly one bare instance "win" by
 * processing order, which would make the result depend on array order).
 * An id occurring exactly once is left completely untouched — the
 * overwhelming common case, and full backward compatibility for every
 * existing non-colliding recipe. Returns a NEW array of frontmatter ids
 * (same order/length as `recipes`) — never mutates the input recipes. */
export function dedupeRecipeIds(recipes: RagRecipe[]): string[] {
  const countById = new Map<string, number>();
  for (const recipe of recipes) {
    countById.set(recipe.frontmatter.id, (countById.get(recipe.frontmatter.id) ?? 0) + 1);
  }
  return recipes.map((recipe) => {
    const id = recipe.frontmatter.id;
    return (countById.get(id) ?? 0) > 1 ? `${id}-${shortHash(recipe.filePath)}` : id;
  });
}

export async function buildRagIndex(recipes: RagRecipe[]): Promise<RagIndex> {
  const embeddings = new TfIdfEmbeddings();
  const texts = recipes.map(recipeToEmbeddingText);
  embeddings.fit(texts);
  const vectors = await embeddings.embedDocuments(texts);

  const dedupedIds = dedupeRecipeIds(recipes);
  const documents = recipes.map((recipe, index) => {
    const metadata: RagRecipeMetadata = {
      id: dedupedIds[index],
      title: recipe.frontmatter.title,
      automationMode: recipe.frontmatter.automationMode,
      language: recipe.frontmatter.language,
      imports: recipe.frontmatter.imports,
      recipeIndex: index,
      filePath: recipe.filePath,
      relativePath: recipe.relativePath
    };
    return new Document({ pageContent: recipe.body, metadata });
  });

  const store = new LocalFlatVectorStore(embeddings);
  await store.reset(vectors, documents);

  return { store, embeddings, recipes, canonicalIds: dedupedIds };
}
