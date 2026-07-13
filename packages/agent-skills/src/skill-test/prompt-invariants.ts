/**
 * Thrown when a vat-generated prompt (executor or grader) violates one of its
 * required invariants — a missing required directive, or the presence of a
 * forbidden phrase (e.g. an executor "blinding breaker").
 *
 * Shared across the `*-prompt.ts` modules in `skill-test/` so
 * `exit-codes.ts`'s `mapErrorToExitCode` maps all of them to the same
 * user-correctable preflight exit code (2), regardless of which prompt
 * builder raised it.
 */
export class PromptInvariantError extends Error {
  constructor(message: string) {
    super(`Prompt invariant violated: ${message}`);
    this.name = 'PromptInvariantError';
  }
}

/**
 * Append the per-run integrity-nonce directive to the grader prompt. The recipient must copy
 * `nonce` verbatim into the artifact it writes, as a top-level `runNonce`
 * field; the harness then rejects any artifact whose nonce is absent or wrong.
 * This is defense-in-depth against untrusted skill code forging a passing
 * result in the shared sandbox — without the secret nonce (delivered only via
 * stdin, never written to disk) a forged result cannot be authenticated.
 *
 * Appended AFTER any prompt-invariant assertion and AFTER any user prompt
 * override, so the nonce requirement is ALWAYS enforced and a committed
 * config cannot opt out of it.
 */
export function appendIntegrityNonceDirective(prompt: string, nonce: string): string {
  return [
    prompt,
    '',
    'INTEGRITY (required, do this LAST): the artifact you write MUST include a',
    `top-level string field "runNonce" whose value is EXACTLY: ${nonce}`,
    'Copy it verbatim. vat rejects an artifact whose runNonce is missing or wrong.',
  ].join('\n');
}
