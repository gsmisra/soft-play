/**
 * Renders the "Custom Instructions" (`.github/*.md`) parts of an LLM prompt —
 * ONE implementation shared by every prompt builder in Standard mode
 * (objectSpyPanel.ts: UI + API automation code, both feature-file prompts)
 * and Total Agentic Mode, instead of a copy per builder. Pure (no `vscode`).
 *
 * `userSelected` is set ONLY for files the user explicitly checked in the
 * "Custom Instructions" list. Those get the HIGHEST precedence in the prompt:
 * they beat the generic built-in "Mandatory refinement standard", RAG
 * guidance, example code AND the user's own chat-box instructions wherever
 * they genuinely conflict. Everything else — the "nothing checked = send every
 * .github/*.md file" default, and the auto-added database-testing file —
 * renders EXACTLY as before, so unrelated behavior is unchanged.
 *
 * What never yields, even to a selected file: the things the environment
 * itself depends on — target language/version, the browser-executable launch
 * requirement, Auto Password Encryption (`ENC[...]`) handling, and the
 * required output format. A user rule that removed those would produce code
 * that cannot run or leaks a credential. Such a rule (and any chat
 * instruction a selected file overrules) is never dropped silently: the model
 * is told to name it in a short comment near the top of its output.
 *
 * A selected file that cannot be read is NEVER silently omitted — see
 * `UnreadableInstructionFilesError`.
 */

export interface InstructionFile {
  path: string;
  content: string;
  userSelected?: boolean;
}

const DEFAULT_HEADER = '\n## Project instructions/skills/prompts (from .github/) — follow these';

export const NON_NEGOTIABLE =
  'the target language/version, the browser-executable launch requirement, Auto Password Encryption ' +
  '(`ENC[...]`) handling, and the required output format';

/** How a set-aside instruction is reported — inside the code block, so it
 * never breaks the "code only, one fenced block" output contract. */
export const REPORT_SET_ASIDE =
  'say so in a short comment near the top of your output (after any shebang/encoding line), naming the ' +
  'instruction and why';

/** The ONE statement of how selected Custom Instructions and selected RAG Data
 * recipes relate — they are PEERS. Used by both sides' headers and reminders
 * so the prompt can never say "A outranks everything" in one place and "B
 * outranks everything" in another. */
const PEER_CONFLICT_RULE =
  `if a selected Custom Instructions file and a selected RAG Data recipe genuinely conflict, neither simply wins: ` +
  `follow the more specific rule and ${REPORT_SET_ASIDE} (naming both)`;

export function buildProjectInstructionsSection(instructions: InstructionFile[], ragSection = ''): string[] {
  const selected = instructions.filter((f) => f.userSelected);
  const others = instructions.filter((f) => !f.userSelected);
  const render = (f: InstructionFile): string => `### ${f.path}\n${f.content}`;
  const parts: string[] = [];

  if (selected.length) {
    const which = selected.length === 1 ? 'this file' : `these ${selected.length} files`;
    parts.push(
      `\n## ⚠ Custom Instructions the user SELECTED (from .github/) — HIGHEST PRIORITY`,
      `The user deliberately checked ${which} in SoftPlay's "Custom Instructions" list for THIS request. Every rule ` +
        `below is a binding requirement that takes priority over EVERYTHING else in this prompt — the generic ` +
        `"Mandatory refinement standard", any automatically matched reusable-component (RAG) guidance, any example ` +
        `code, AND the user's own chat-box instructions: wherever one of those genuinely conflicts with a selected ` +
        `file, the selected file wins${isSelectedRagSection(ragSection) ? ` — except the RAG Data recipes the user ALSO selected, which hold EQUAL priority with these files (${PEER_CONFLICT_RULE})` : ''}. ` +
        `Apply ALL selected files together, not just the first (if two of them conflict, follow the more ` +
        `specific rule). The only things that never yield are ${NON_NEGOTIABLE}, because the code could not run — or ` +
        `would leak a credential — without them. Never silently ignore an instruction: if you set one aside (a chat ` +
        `instruction a selected file overrules, or a selected-file rule that would break one of those non-negotiable ` +
        `requirements), ${REPORT_SET_ASIDE}.`,
      ...selected.map(render)
    );
  }
  if (others.length) {
    parts.push(DEFAULT_HEADER, ...others.map(render));
  }
  return parts;
}

/** Recency-boosted restatement (same "primacy + recency" pattern as the RAG
 * and linked-source reminders): the section above sits early in a very long
 * prompt, so it is repeated in one line near the end, right before generation.
 * Returns `[]` when the user selected nothing — an unselected request is
 * unchanged — so a caller can just `parts.push(...buildSelectedInstructionsReminder(x))`. */
export function buildSelectedInstructionsReminder(instructions: InstructionFile[], ragSection = ''): string[] {
  const selected = instructions.filter((f) => f.userSelected);
  if (!selected.length) {
    return [];
  }
  const names = selected.map((f) => `"${f.path}"`).join(', ');
  return [
    `\n## ⚠ Selected Custom Instructions reminder (read this again before writing the final result)\n` +
      `The user explicitly selected ${names}. Before finalizing, re-check your output against EVERY rule in ` +
      `${selected.length === 1 ? 'that file' : 'those files'}: they take priority over the generic refinement standard, ` +
      `automatically matched RAG guidance, example code AND the chat-box instructions below wherever they conflict (except ` +
      `${NON_NEGOTIABLE}), and must be reflected in the result — not merely acknowledged.` +
      `${isSelectedRagSection(ragSection) ? ` The selected RAG Data recipes hold EQUAL priority with these files: ${PEER_CONFLICT_RULE}.` : ''} ` +
      `If you set an instruction aside, ${REPORT_SET_ASIDE}.`
  ];
}

/**
 * The free-text "Instant instructions to LLM" chat block — ONE shared copy
 * (it used to be duplicated in all four Standard-mode builders). With no
 * selected Custom Instructions the wording is EXACTLY what it always was (the
 * chat box is the user's most specific ask and beats anything more generic
 * earlier in the prompt). When the user DID select files, the same block now
 * states the one exception, so this last-read section can never contradict
 * the selected-files section above it. `[]` for an empty chat.
 */
export function buildChatInstructionsSection(customInstructions: string, instructions: InstructionFile[], ragSection = ''): string[] {
  if (!customInstructions) {
    return [];
  }
  // Selected Custom Instructions AND selected RAG Data recipes hold EQUAL
  // priority, so the chat block yields to whichever of them the user picked.
  const hasInstructions = instructions.some((f) => f.userSelected);
  const hasRag = isSelectedRagSection(ragSection);
  const exception =
    hasInstructions || hasRag
      ? ` — with ONE exception: ${[hasInstructions && 'the Custom Instructions', hasRag && 'the RAG Data recipes'].filter(Boolean).join(' and ')} ` +
        `the user SELECTED (the "HIGHEST PRIORITY" ${hasInstructions && hasRag ? 'sections above and their reminders' : 'section above and its reminder'}) ` +
        `outrank this text wherever the two genuinely conflict. Follow ${hasInstructions && hasRag ? 'the selected files and recipes' : hasRag ? 'the selected recipe' : 'the selected file'} ` +
        `and, if you set a chat instruction aside, ${REPORT_SET_ASIDE}`
      : '';
  return [
    `\n## ⚠ Additional instructions from the user — read this last and apply it\nThe user typed the following ` +
      `into SoftPlay's chat box specifically for this request. Treat it as a real, binding requirement, not a ` +
      `suggestion — if it conflicts with something more generic stated earlier in this prompt, this wins${exception}:\n${customInstructions}`
  ];
}

// ---------------------------------------------------------------------
// "RAG Data" recipes the user explicitly CHECKED hold the SAME importance as
// selected Custom Instructions: highest priority, delivered in full, never
// silently dropped. (Automatically MATCHED recipes are unchanged — optional
// "reuse the ones that genuinely fit" guidance, budget-packed.) The recipe
// rendering itself lives in rag/ragRetriever.ts's `formatSelectedRagSection()`;
// the shared WORDING lives here so both kinds of selection say the same thing.
// ---------------------------------------------------------------------

/** Appears in the header of a selected-RAG section — how callers (the recency
 * reminder, the chat block) recognise one without any extra plumbing. */
export const SELECTED_RAG_SECTION_MARKER = 'Reusable components (RAG Data) the user SELECTED';
const FEATURE_FILE_RAG_MARKER = '— feature-file context';

export type SelectedRagPurpose = 'code' | 'feature-file';

export function isSelectedRagSection(section: string): boolean {
  return !!section && section.includes(SELECTED_RAG_SECTION_MARKER);
}

const rules = (purpose: SelectedRagPurpose): string =>
  purpose === 'code'
    ? `USE EVERY selected recipe: wherever this request involves what a recipe does, you MUST use that component instead of ` +
      `writing equivalent logic yourself — call it exactly as shown in its example, without modifying its own ` +
      `implementation, and copy its import statement EXACTLY as printed under "Required imports" below, character for ` +
      `character (never invent, abbreviate, or restructure a package path). `
    : `Treat EVERY selected recipe as binding business context: reflect its terminology, operations, parameters and ` +
      `expected behavior in the feature file's scenarios and step wording (a feature file contains no code or imports, ` +
      `so never write any). `;

/** The header + precedence statement that opens a selected-RAG section. */
export function buildSelectedRagSectionHeader(count: number, purpose: SelectedRagPurpose): string[] {
  const which = count === 1 ? 'this recipe' : `these ${count} recipes`;
  return [
    `\n## ⚠ ${SELECTED_RAG_SECTION_MARKER} (from .github/rag/) — HIGHEST PRIORITY${purpose === 'feature-file' ? ` ${FEATURE_FILE_RAG_MARKER}` : ''}`,
    `The user deliberately checked ${which} in SoftPlay's "RAG Data" list for THIS request. ${count === 1 ? 'It holds' : 'They hold'} ` +
      `EQUAL, highest priority with any Custom Instructions the user selected: every recipe below is a binding ` +
      `requirement, not an optional suggestion, and takes priority over EVERYTHING else in this prompt — the generic ` +
      `"Mandatory refinement standard", any example code, AND the user's own chat-box instructions: wherever one of ` +
      `those genuinely conflicts with a selected recipe, the selected recipe wins — except that ${PEER_CONFLICT_RULE}. ` +
      rules(purpose) +
      `The only things that never yield are ${NON_NEGOTIABLE}. Never silently skip a selected recipe: if one cannot ` +
      `apply (nothing in this request involves it, or using it would break one of those non-negotiable requirements), ` +
      `${REPORT_SET_ASIDE}.` +
      (purpose === 'code'
        ? ` TRACEABILITY: the first time you call a component, add a one-line comment directly above the call, in this ` +
          `exact form (this language's own comment syntax): "RAG match: <component id> (from <source file>)", using the ` +
          `exact id/source file shown below.`
        : '')
  ];
}

/** Recency restatement for a selected-RAG section, mirroring
 * `buildSelectedInstructionsReminder()`. `[]` when `ragSection` isn't a
 * selected-RAG section (automatic matches keep their own, softer reminder). */
export function buildSelectedRagReminder(ragSection: string): string[] {
  if (!isSelectedRagSection(ragSection)) {
    return [];
  }
  const feature = ragSection.includes(FEATURE_FILE_RAG_MARKER);
  return [
    `\n## ⚠ Selected RAG Data reminder (read this again before writing the final result)\n` +
      `Under "## ⚠ ${SELECTED_RAG_SECTION_MARKER}" earlier in this prompt are recipes the user explicitly chose. They hold ` +
      `EQUAL priority with any selected Custom Instructions and outrank the generic refinement standard, example code AND ` +
      `the chat-box instructions below wherever they conflict (except ${NON_NEGOTIABLE}); ${PEER_CONFLICT_RULE}. Before finalizing, check EVERY ` +
      `selected recipe: ${
        feature
          ? `make sure each one's terminology and behavior is reflected in the feature file`
          : `use each one wherever this request involves what it does — called exactly as shown, its imports copied EXACTLY`
      }, and leave none unmentioned — if you set one aside, ${REPORT_SET_ASIDE}.`
  ];
}

/**
 * Thrown when the user EXPLICITLY checked "RAG Data" file(s) that cannot be
 * used — missing/unreadable, not a valid recipe, not tagged for the selected
 * language, or no workspace open. Same rule as `UnreadableInstructionFilesError`:
 * silently generating WITHOUT a recipe the user chose is exactly what "selected
 * means highest priority" forbids, so the request stops before the model is
 * contacted and says how to proceed.
 */
export class UnusableRagFilesError extends Error {
  constructor(readonly files: { path: string; reason: string }[]) {
    const list = files.map((f) => `"${f.path}" (${f.reason})`).join(', ');
    const plural = files.length > 1;
    super(
      `Selected RAG Data file${plural ? 's' : ''} could not be used: ${list}. Nothing was sent to the model. ` +
        `Fix or restore ${plural ? 'them' : 'it'}, or uncheck ${plural ? 'them' : 'it'} in "RAG Data", then try again.`
    );
    this.name = 'UnusableRagFilesError';
  }
}

/**
 * Thrown when the user EXPLICITLY selected Custom Instructions file(s) that
 * cannot be read (deleted, renamed, permissions, ...). Generation must stop —
 * quietly sending code generated WITHOUT an instruction the user chose is
 * exactly the failure "selected files take priority" exists to prevent. The
 * message names each file, says nothing was sent, and tells the user how to
 * proceed. (The "nothing checked = send every .github/*.md" default is NOT an
 * explicit choice and keeps skipping a file that vanished mid-listing.)
 */
export class UnreadableInstructionFilesError extends Error {
  constructor(readonly files: { path: string; reason: string }[]) {
    const list = files.map((f) => `"${f.path}" (${f.reason})`).join(', ');
    const plural = files.length > 1;
    super(
      `Selected Custom Instructions file${plural ? 's' : ''} could not be read: ${list}. Nothing was sent to the model. ` +
        `Restore ${plural ? 'them' : 'it'}, or uncheck ${plural ? 'them' : 'it'} in "Custom Instructions", then try again.`
    );
    this.name = 'UnreadableInstructionFilesError';
  }
}
