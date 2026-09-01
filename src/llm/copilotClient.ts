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
 * `onChunk` as it arrives. Per the API's own contract, this must only be
 * called in direct response to a user action (VS Code shows a one-time
 * consent dialog on first use per extension) — callers here are always
 * triggered by the panel's "Send to Copilot" button, never automatically.
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
