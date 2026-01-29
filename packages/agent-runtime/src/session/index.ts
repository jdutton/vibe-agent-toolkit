/**
 * Session management for VAT runtime.
 *
 * Provides pluggable session persistence strategies independent
 * of transport layer.
 */

export type {
  Message,
  RuntimeSession,
  SessionMetadata,
  SessionStore,
  SessionStoreOptions,
} from './types.js';
export { SessionNotFoundError } from './errors.js';
export { MemorySessionStore } from './memory-session-store.js';
export {
  createInitialSession,
  isSessionExpired,
  updateSessionAccess,
  validateSessionId,
} from './session-store-helpers.js';
// NOTE: test-helpers is NOT exported from main index to avoid importing vitest
// in production code. Import from '@vibe-agent-toolkit/agent-runtime/session/test-helpers' in test files.
