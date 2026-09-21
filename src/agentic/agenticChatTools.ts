import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * The tools Total Agentic Mode's chat agent (agenticChatSession.ts) may call.
 * Zero `vscode` import: the two kinds of capability are split so each is
 * directly testable —
 *
 *  - READ tools work on `ChatFileSegment`s, i.e. exactly the trimmed text the
 *    model is already given for each loaded file (never the raw upload, and
 *    never anything outside the loaded files), so `search`/`read` can only
 *    ever reveal what the user already chose to send.
 *  - GENERATE tools call back into the controller's existing generation
 *    pipelines via `deps.generate` — the very same code the sidebar's three
 *    buttons run (senior-QE standards, RAG, custom instructions, validation),
 *    not a second, weaker implementation.
 */

export interface ChatFileSegment {
  fileName: string;
  kind: string;
  text: string;
  truncated: boolean;
}

export type ChatGenerateKind = 'feature' | 'code' | 'csv';

/** Host-side implementations of the Jira/Confluence tools. Every result is a plain JSON-serialisable object
 * with structured status/error and NO credential, request header or download URL. Deliberately no tool takes a
 * username, password, token or arbitrary URL other than the link the user pasted (checked by the host). */
export interface KnowledgeToolDeps {
  openLink: (url: string, refresh: boolean) => Promise<unknown>;
  readResource: (sourceId: string, offset: number | undefined, maxChars: number | undefined) => unknown;
  listAttachments: (sourceId: string) => unknown;
  requestAttachmentImport: (sourceId: string, attachmentIds: string[] | undefined) => Promise<unknown>;
}

export interface AgenticChatToolDeps {
  getSegments: () => ChatFileSegment[];
  generate: (kind: ChatGenerateKind, instructions: string | undefined) => Promise<{ ok: boolean; message: string }>;
  /** Present when Jira/Confluence connections are available to this session. */
  knowledge?: KnowledgeToolDeps;
}

const DEFAULT_MAX_MATCHES = 20;
const HARD_MAX_MATCHES = 50;
const MAX_MATCH_LINE_CHARS = 300;
const DEFAULT_READ_CHARS = 8000;
const HARD_MAX_READ_CHARS = 20000;

export function listSegments(segments: ChatFileSegment[]): { fileName: string; kind: string; chars: number; truncated: boolean }[] {
  return segments.map((s) => ({ fileName: s.fileName, kind: s.kind, chars: s.text.length, truncated: s.truncated }));
}

/** Case-insensitive LITERAL substring search (a regex would let a model
 * write a catastrophic pattern) — one hit per matching line, with 1-based
 * line numbers so the answer can cite exactly where something was found. */
export function searchSegments(
  segments: ChatFileSegment[],
  query: string,
  maxResults = DEFAULT_MAX_MATCHES
): { query: string; totalMatches: number; shown: number; matches: { fileName: string; line: number; text: string }[] } {
  const needle = query.trim().toLowerCase();
  const limit = Math.max(1, Math.min(maxResults, HARD_MAX_MATCHES));
  const matches: { fileName: string; line: number; text: string }[] = [];
  let total = 0;
  if (needle) {
    for (const segment of segments) {
      const lines = segment.text.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (line.toLowerCase().includes(needle)) {
          total++;
          if (matches.length < limit) {
            matches.push({ fileName: segment.fileName, line: index + 1, text: line.length > MAX_MATCH_LINE_CHARS ? `${line.slice(0, MAX_MATCH_LINE_CHARS)}…` : line });
          }
        }
      });
    }
  }
  return { query, totalMatches: total, shown: matches.length, matches };
}

export type ReadSegmentResult =
  | { error: string }
  | { fileName: string; totalChars: number; offset: number; returnedChars: number; hasMore: boolean; content: string };

/** Pages through one file's segment. `fileName` matches exactly
 * (case-insensitive), or by unique substring when that is unambiguous. */
export function readSegment(segments: ChatFileSegment[], fileName: string, offset = 0, maxChars = DEFAULT_READ_CHARS): ReadSegmentResult {
  const wanted = fileName.trim().toLowerCase();
  const exact = segments.filter((s) => s.fileName.toLowerCase() === wanted);
  const candidates = exact.length > 0 ? exact : segments.filter((s) => s.fileName.toLowerCase().includes(wanted));
  if (!wanted || candidates.length === 0) {
    return { error: `No loaded file matches "${fileName}". Loaded: ${segments.map((s) => s.fileName).join(', ') || '(none)'}.` };
  }
  if (candidates.length > 1) {
    return { error: `"${fileName}" matches several files (${candidates.map((s) => s.fileName).join(', ')}) — use the full name.` };
  }
  const segment = candidates[0];
  const start = Math.max(0, Math.min(offset, segment.text.length));
  const length = Math.max(1, Math.min(maxChars, HARD_MAX_READ_CHARS));
  const content = segment.text.slice(start, start + length);
  return {
    fileName: segment.fileName,
    totalChars: segment.text.length,
    offset: start,
    returnedChars: content.length,
    hasMore: start + content.length < segment.text.length,
    content
  };
}

export function createAgenticChatTools(deps: AgenticChatToolDeps) {
  const instructionsSchema = z.object({
    instructions: z
      .string()
      .optional()
      .describe('Extra requirements for the artifact, taken from the conversation. If omitted, the user\'s latest message is used.')
  });

  const generateTool = (kind: ChatGenerateKind, name: string, description: string) =>
    tool(
      async ({ instructions }: { instructions?: string }): Promise<string> => {
        const outcome = await deps.generate(kind, instructions?.trim() || undefined);
        return JSON.stringify(outcome);
      },
      { name, description, schema: instructionsSchema }
    );

  const knowledgeTools = deps.knowledge ? createKnowledgeTools(deps.knowledge) : [];

  return [
    tool(async (): Promise<string> => JSON.stringify({ files: listSegments(deps.getSegments()) }), {
      name: 'list_ingested_files',
      description: 'Lists the input files the user has loaded (name, kind, size of the part sent to you, whether it was cut by the size cap). Takes no arguments.',
      schema: z.object({})
    }),
    tool(
      async ({ query, maxResults }: { query: string; maxResults?: number }): Promise<string> =>
        JSON.stringify(searchSegments(deps.getSegments(), query, maxResults)),
      {
        name: 'search_ingested_files',
        description:
          'Case-insensitive text search across every loaded file. Returns matching lines with file name and line number. Use it to find exact rows, IDs, field names or steps before answering.',
        schema: z.object({
          query: z.string().describe('The literal text to look for.'),
          maxResults: z.number().int().min(1).max(HARD_MAX_MATCHES).optional().describe('Maximum matching lines to return (default 20).')
        })
      }
    ),
    tool(
      async ({ fileName, offset, maxChars }: { fileName: string; offset?: number; maxChars?: number }): Promise<string> =>
        JSON.stringify(readSegment(deps.getSegments(), fileName, offset, maxChars)),
      {
        name: 'read_ingested_file',
        description:
          'Reads part of one loaded file (the same trimmed text you were given) so you can quote or check it exactly. Pages of up to 20,000 characters; use `offset` to continue when `hasMore` is true.',
        schema: z.object({
          fileName: z.string().describe('The loaded file\'s name.'),
          offset: z.number().int().min(0).optional().describe('Character offset to start from (default 0).'),
          maxChars: z.number().int().min(1).max(HARD_MAX_READ_CHARS).optional().describe('Characters to return (default 8,000).')
        })
      }
    ),
    generateTool(
      'feature',
      'generate_feature_file',
      'Generates a Gherkin .feature file from the loaded files and opens it in the Generated Feature File panel. Only call when the user explicitly asks for a feature file.'
    ),
    generateTool(
      'code',
      'generate_automation_code',
      'Generates runnable automation code (in the project\'s selected language) from the loaded files and opens it in the AI Generated Code panel. Only call when the user explicitly asks for automation code.'
    ),
    generateTool(
      'csv',
      'generate_test_case_csv',
      'Generates manual test cases as a CSV, saves it into the workspace and opens it. Only call when the user explicitly asks for a test-case CSV.'
    ),
    ...knowledgeTools
  ];
}

function createKnowledgeTools(k: KnowledgeToolDeps) {
  const sourceIdSchema = z.string().describe('The resource id shown in the conversation, e.g. "src-1". Never a URL.');
  return [
    tool(async ({ url, refresh }: { url: string; refresh?: boolean }): Promise<string> => JSON.stringify(await k.openLink(url, refresh === true)), {
      name: 'open_knowledge_link',
      description:
        'Reads a Jira ticket or Confluence page from a link THE USER PASTED in this conversation (pass it exactly as they wrote it — links you make up are refused). ' +
        'If a secure connection is needed the user is asked to connect and you must stop and wait; you never see or ask for credentials. ' +
        'Returns the resource id, a summary, a text preview and the attachment list (metadata only — nothing is downloaded). Set refresh=true only when the user asks for the latest version.',
      schema: z.object({
        url: z.string().describe('The exact link the user pasted.'),
        refresh: z.boolean().optional().describe('true = fetch again instead of using the session copy.')
      })
    }),
    tool(async ({ sourceId, offset, maxChars }: { sourceId: string; offset?: number; maxChars?: number }): Promise<string> => JSON.stringify(k.readResource(sourceId, offset, maxChars)), {
      name: 'read_knowledge_resource',
      description: 'Reads more of an already-retrieved Jira/Confluence resource (paged, up to 20,000 characters per call). Use the resource id returned by open_knowledge_link.',
      schema: z.object({
        sourceId: sourceIdSchema,
        offset: z.number().int().min(0).optional().describe('Character offset to continue from (default 0).'),
        maxChars: z.number().int().min(1).max(HARD_MAX_READ_CHARS).optional().describe('Characters to return (default 8,000).')
      })
    }),
    tool(async ({ sourceId }: { sourceId: string }): Promise<string> => JSON.stringify(k.listAttachments(sourceId)), {
      name: 'list_resource_attachments',
      description: 'Lists the attachments (metadata only: id, file name, type, size, whether importable) of an already-retrieved resource. Downloads nothing.',
      schema: z.object({ sourceId: sourceIdSchema })
    }),
    tool(async ({ sourceId, attachmentIds }: { sourceId: string; attachmentIds?: string[] }): Promise<string> => JSON.stringify(await k.requestAttachmentImport(sourceId, attachmentIds)), {
      name: 'request_attachment_import',
      description:
        'Asks the USER to choose which of a resource\'s attachments to read. The app shows its own approval prompt; only the files the user ticks are downloaded and added to Input Files. ' +
        'Call it only after the user said they want attachments read. `attachmentIds` optionally pre-selects ids from list_resource_attachments. It never downloads anything by itself.',
      schema: z.object({
        sourceId: sourceIdSchema,
        attachmentIds: z.array(z.string()).max(50).optional().describe('Attachment ids (e.g. "att-2") to pre-select in the approval prompt.')
      })
    })
  ];
}
