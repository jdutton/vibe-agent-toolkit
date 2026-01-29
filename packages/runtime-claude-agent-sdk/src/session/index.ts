/**
 * Session stores for Claude Agent SDK runtime.
 *
 * Provides file-based session persistence strategy.
 */

export { FileSessionStore, type FileSessionStoreOptions } from './file-session-store.js';

// Note: CloudSessionStore planned for future when Anthropic Files API supports this use case
