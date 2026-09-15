import * as path from 'path';
import { readFileCachedSync } from '../cache/fileCache';
import * as secretVault from './secretVault';

/**
 * F04: extracted from `objectSpyPanel.ts` (its own private helpers) so
 * Total Agentic Mode's `agenticModeController.ts` can reuse the EXACT same
 * "Auto Password Encryption" mandatory-standard + decrypt-helper prompt
 * section Standard mode's own fix-prompt builder
 * (`objectSpyPanel.ts`'s `buildFixPrompt()`) already appends, instead of
 * the new Agentic Verify & Fix path building its own prompt with none of
 * this context at all. Neither panel module imports from the other — see
 * `agent/verifyFixTextTruncation.ts` for the same "proper segregation"
 * posture applied to a different shared helper earlier in this codebase's
 * history.
 */

// "Auto Password Encryption" — the mandatory standard (what an ENC[v1:...]
// token means and the exact rules for handling it) plus the two
// language-specific decrypt-helper implementations the LLM is told to copy
// verbatim into the generated file. See security/secretVault.ts and
// security/uiPasswordRedactor.ts for where the tokens themselves come from.
function readPasswordEncryptionStandard(): string {
  return readFileCachedSync(path.join(__dirname, '..', '..', 'prompts', 'password-encryption-standard.md'));
}
function readSecretVaultTemplate(language: 'java' | 'python'): string {
  const file = language === 'java' ? 'secret-vault-java.txt' : 'secret-vault-python.txt';
  return readFileCachedSync(path.join(__dirname, '..', '..', 'prompts', file));
}

/** Appends the Auto Password Encryption standard + decrypt-helper section
 * to a prompt's `parts`, but ONLY when `content` actually contains at least
 * one `ENC[` token — a request with no credentials in it stays exactly as
 * lean as it was before this feature existed, rather than every single
 * prompt paying for a section it doesn't need.
 *
 * Scope, stated plainly (F04): this does not itself detect secrets — it
 * only reacts to a token ALREADY produced by
 * `security/uiPasswordRedactor.ts`'s `encryptPasswordLiteralsInCode()`
 * (password-shaped `.fill()`/`.type()` calls in code) or
 * `security/chatInstructionRedactor.ts`'s `encryptCredentialsInFreeText()`
 * (connection-string-shaped credentials in free text) — a caller MUST run
 * its own content through one of those redactors BEFORE calling this, or
 * there is nothing here to react to. Neither redactor claims universal
 * secret detection; a plaintext value in an unrecognized shape is a
 * residual, documented limitation of both, not something this function
 * can compensate for. */
export function appendPasswordEncryptionSection(parts: string[], content: string, language: 'java' | 'python'): void {
  if (!content.includes(secretVault.TOKEN_MARKER)) {
    return;
  }
  const standard = readPasswordEncryptionStandard();
  const template = readSecretVaultTemplate(language);
  if (standard) {
    parts.push(`\n## Mandatory standard — Auto Password Encryption (encrypted credential(s) present above)\n${standard}`);
  }
  if (template) {
    parts.push(
      `\n## Decrypt helper — include this exact ${language === 'java' ? 'Java' : 'Python'} code verbatim in the generated file\n\`\`\`${language}\n${template}\n\`\`\``
    );
  }
}
