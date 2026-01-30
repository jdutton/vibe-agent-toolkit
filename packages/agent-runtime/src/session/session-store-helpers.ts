/**
 * Shared helper functions for session store implementations.
 *
 * These functions eliminate code duplication between MemorySessionStore
 * and FileSessionStore by providing common validation and state management logic.
 */

import type { RuntimeSession } from './types.js';

/**
 * Validate session ID to prevent path traversal and other security issues.
 * @throws Error if session ID is invalid
 */
export function validateSessionId(sessionId: string): void {
  // Prevent path traversal attacks
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
    throw new Error(`Invalid session ID: contains path separators`);
  }
  // Prevent empty or unreasonably long IDs
  if (sessionId.length === 0 || sessionId.length > 255) {
    throw new Error(`Invalid session ID: invalid length`);
  }
}

/**
 * Create an initial session with proper metadata.
 */
export function createInitialSession<TState>(
  id: string,
  initialState: TState | undefined,
  createInitialState: (() => TState) | undefined,
  ttl: number | undefined
): RuntimeSession<TState> {
  const now = new Date();
  return {
    id,
    history: [],
    state: initialState ?? createInitialState?.() ?? ({} as TState),
    metadata: {
      createdAt: now,
      lastAccessedAt: now,
      ...(ttl && { expiresAt: new Date(now.getTime() + ttl) }),
    },
  };
}

/**
 * Update session access timestamp and extend TTL if configured.
 * Mutates the session object in place.
 */
export function updateSessionAccess<TState>(
  session: RuntimeSession<TState>,
  ttl: number | undefined
): void {
  session.metadata.lastAccessedAt = new Date();

  // Extend TTL if configured
  if (ttl) {
    session.metadata.expiresAt = new Date(Date.now() + ttl);
  }
}

/**
 * Check if a session has expired.
 */
export function isSessionExpired(session: RuntimeSession<unknown>): boolean {
  return !!(session.metadata.expiresAt && session.metadata.expiresAt < new Date());
}
