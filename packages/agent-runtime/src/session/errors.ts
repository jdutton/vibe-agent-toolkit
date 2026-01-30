/**
 * Session management errors for VAT runtime.
 */

/**
 * Error thrown when session not found
 */
export class SessionNotFoundError extends Error {
  constructor(public sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}
