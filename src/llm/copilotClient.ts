import * as vscode from 'vscode';

export interface CopilotModelInfo {
  id: string;
  name: string;
  vendor: string;
  family: string;
}

/**
 * Wraps VS Code's Language Model API (`vscode.lm`) — stable since VS Code
 * 1.90, no proposed-API flags needed — to discover and call whatever chat
 * models the user's installed GitHub Copilot Chat extension actually
 * exposes. Deliberately never hardcodes a model list: what's available
 * depends on the user's Copilot subscription/installed extension version,
 * so the only correct approach is to ask VS Code at call time.
 */

/** Lists Copilot's available chat models right now. Empty if GitHub Copilot
 * Chat isn't installed, the user isn't signed in, or no models are exposed —
 * callers should treat an empty list as "not available" and say so in the UI,
 * not throw. */
export async function listCopilotModels(): Promise<CopilotModelInfo[]> {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return models.map((m) => ({ id: m.id, name: m.name, vendor: m.vendor, family: m.family }));
  } catch {
    return [];
  }
}

async function findModel(modelId: string): Promise<vscode.LanguageModelChat | undefined> {
  const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  return models.find((m) => m.id === modelId) ?? models[0];
}

export class CopilotUnavailableError extends Error {
  constructor() {
    super('No GitHub Copilot chat model is available. Is GitHub Copilot Chat installed and are you signed in?');
    this.name = 'CopilotUnavailableError';
  }
}

/**
 * Sends `prompt` to the selected model and streams the response text via
 * `onChunk` as it arrives. VS Code shows a one-time consent dialog the
 * first time an extension calls this API in a session — that's the API's
 * own gate; callers here (the chat composer's manual send, and the
 * automatic post-recording refinement pipeline — see objectSpyPanel.ts's
 * runLlmRefinement()) both only ever fire while the user has explicitly
 * turned on "Link with GitHub Copilot LLM" (Control Panel) and picked a model in Settings.
 */
export async function sendPrompt(
  modelId: string,
  prompt: string,
  onChunk: (chunk: string) => void,
  token: vscode.CancellationToken
): Promise<void> {
  const model = await findModel(modelId);
  if (!model) {
    throw new CopilotUnavailableError();
  }
  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  const response = await model.sendRequest(messages, {}, token);
  for await (const fragment of response.text) {
    onChunk(fragment);
  }
}

/**
 * Best-effort extraction of the first fenced code block from a chat
 * response — models often add commentary despite being asked not to.
 * Falls back to the full trimmed text when no fence is found, so a plain
 * (non-fenced) response still shows up rather than disappearing.
 */
export function extractCodeBlock(responseText: string): string {
  const match = responseText.match(/```[^\n]*\n([\s\S]*?)```/);
  return match ? match[1].trimEnd() : responseText.trim();
}

export interface ModelTokenCount {
  /** Real token count for `text`, from the model's OWN tokenizer via VS
   * Code's Language Model API (`LanguageModelChat.countTokens`) — never a
   * character-count heuristic, so this is exactly what the model itself
   * would bill/consider for that text. */
  count: number;
  /** `LanguageModelChat.maxInputTokens` — the real context-window ceiling
   * for this specific model, so a percentage-used figure means something
   * (and updates correctly the moment the user picks a different model in
   * Settings, since each model reports its own). */
  maxInputTokens: number;
}

/** Powers the "Token Monitoring" segment — counts `text` (a prompt about
 * to be sent, or a response just received) against whichever model is
 * currently selected. Returns `undefined` rather than throwing when the
 * model can't be resolved (not installed/signed in/no longer offered) or
 * `countTokens` itself fails — a monitoring feature must never surface as
 * a hard error interrupting the rest of the UI. */
export async function countModelTokens(modelId: string, text: string, token?: vscode.CancellationToken): Promise<ModelTokenCount | undefined> {
  try {
    const model = await findModel(modelId);
    if (!model) {
      return undefined;
    }
    const count = await model.countTokens(text, token);
    return { count, maxInputTokens: model.maxInputTokens };
  } catch {
    return undefined;
  }
}
