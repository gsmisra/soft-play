/**
 * Links the USER typed into the conversation. `open_knowledge_link` only ever
 * contacts one of these: a URL the model invented, or one lifted out of a
 * fetched Jira/Confluence page, is refused before anything is resolved.
 */

const URL_PATTERN = /https?:\/\/[^\s<>"'`\])}]+/gi;

/** URLs in `text`, without the sentence punctuation that commonly trails a pasted link. */
export function extractUrls(text: string): string[] {
  return (text.match(URL_PATTERN) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ''));
}

/** A comparable form of `url` (`undefined` when it is not a valid URL). The fragment is ignored. */
export function normalizeUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = '';
    return parsed.href;
  } catch {
    return undefined;
  }
}
