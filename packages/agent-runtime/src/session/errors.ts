import { VatError } from '@vibe-agent-toolkit/utils';

/**
 * Session management errors for VAT runtime.
 */

/**
 * Error thrown when session not found
 */
export class SessionNotFoundError extends VatError {
  constructor(public sessionId: string) {
    super('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
  }
}
