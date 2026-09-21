import * as vscode from 'vscode';
import { KnowledgeHost } from './knowledgeSession';
import { Credentials } from './knowledgeTypes';

/**
 * The VS Code side of the knowledge session's host boundary: the masked
 * credential prompt and the attachment approval list. Deliberately tiny — all
 * decisions (when to prompt, what may be downloaded) live in
 * `KnowledgeSession`, which is tested against fakes; this file only renders
 * two native VS Code inputs and reports what the user chose.
 *
 * Nothing typed here ever passes through the chat, the LLM, the transcript or
 * a log: the returned value goes straight into the session's memory-only
 * credential map.
 */

function linkAbort(signal: AbortSignal): { token: vscode.CancellationToken; dispose: () => void } {
  const source = new vscode.CancellationTokenSource();
  const onAbort = (): void => source.cancel();
  if (signal.aborted) {
    source.cancel();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    token: source.token,
    dispose: () => {
      signal.removeEventListener('abort', onAbort);
      source.dispose();
    }
  };
}

const formatSize = (bytes?: number): string | undefined =>
  bytes === undefined ? undefined : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function createVsCodeKnowledgeHost(callbacks: Pick<KnowledgeHost, 'redact' | 'ingestAttachment'>): KnowledgeHost {
  return {
    redact: callbacks.redact,
    ingestAttachment: callbacks.ingestAttachment,

    async promptCredentials({ connection }, signal): Promise<Credentials | undefined> {
      const link = linkAbort(signal);
      try {
        const where = `${connection.label} (${connection.origin})`;
        const title = `SoftPlay — connect to ${connection.label}`;
        const reassurance = 'Kept in memory for this session only; never sent to the AI model.';
        let username: string | undefined;
        if (connection.authMode === 'basic') {
          username = await vscode.window.showInputBox(
            { title, prompt: `Username for ${where}. ${reassurance}`, ignoreFocusOut: true, placeHolder: 'Username' },
            link.token
          );
          if (!username?.trim()) {
            return undefined;
          }
        }
        const secret = await vscode.window.showInputBox(
          {
            title,
            prompt: connection.authMode === 'pat' ? `Personal access token for ${where}. ${reassurance}` : `Password for ${where}. ${reassurance}`,
            password: true,
            ignoreFocusOut: true,
            placeHolder: connection.authMode === 'pat' ? 'Personal access token' : 'Password'
          },
          link.token
        );
        if (!secret) {
          return undefined;
        }
        return { username: username?.trim(), secret: connection.authMode === 'pat' ? secret.trim() : secret };
      } finally {
        link.dispose();
      }
    },

    async selectAttachments({ source, choices, preselected }, signal): Promise<string[] | undefined> {
      const link = linkAbort(signal);
      try {
        const items = choices.map((c) => ({
          label: c.filename,
          description: formatSize(c.sizeBytes),
          detail: `${c.id}${c.mimeType ? ` · ${c.mimeType}` : ''}`,
          picked: preselected.includes(c.id),
          attachmentId: c.id
        }));
        const picked = await vscode.window.showQuickPick(
          items,
          {
            canPickMany: true,
            ignoreFocusOut: true,
            title: `SoftPlay — attachments of ${source.key} (${source.connectionLabel})`,
            placeHolder: 'Tick the files to read, then press OK. Nothing is downloaded until you confirm.'
          },
          link.token
        );
        return picked?.map((p) => p.attachmentId);
      } finally {
        link.dispose();
      }
    }
  };
}
