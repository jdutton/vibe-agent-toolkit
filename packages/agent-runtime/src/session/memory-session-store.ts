/**
 * In-memory session store for VAT runtime.
 *
 * Provides ephemeral session storage suitable for development,
 * testing, and single-process deployments.
 */

import { SessionNotFoundError } from './errors.js';
import {
  createInitialSession,
  isSessionExpired,
  updateSessionAccess,
} from './session-store-helpers.js';
import type { RuntimeSession, SessionStore, SessionStoreOptions } from './types.js';

/**
 * In-memory session store (ephemeral, process-local).
 *
 * Use cases:
 * - Development and testing
 * - Single-process deployments
 * - Stateless functions with short-lived sessions
 *
 * Characteristics:
 * - Fast (no I/O)
 * - Volatile (lost on process restart)
 * - No cross-process sharing
 */
export class MemorySessionStore<TState = unknown> implements SessionStore<TState> {
  private readonly sessions = new Map<string, RuntimeSession<TState>>();
  private readonly ttl: number | undefined;
  private readonly generateId: () => string;
  private readonly createInitialState: (() => TState) | undefined;

  constructor(options: SessionStoreOptions<TState> = {}) {
    this.ttl = options.ttl;
    this.generateId = options.generateId ?? (() => crypto.randomUUID());
    this.createInitialState = options.createInitialState;
  }

  async create(initialState?: TState): Promise<string> {
    const id = this.generateId();
    const session = createInitialSession(id, initialState, this.createInitialState, this.ttl);
    this.sessions.set(id, session);
    return id;
  }

  async load(sessionId: string): Promise<RuntimeSession<TState>> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    // Check expiration
    if (isSessionExpired(session)) {
      this.sessions.delete(sessionId);
      throw new SessionNotFoundError(sessionId);
    }

    // Update last access and extend TTL
    updateSessionAccess(session, this.ttl);

    return session;
  }

  async save(session: RuntimeSession<TState>): Promise<void> {
    session.metadata.lastAccessedAt = new Date();
    this.sessions.set(session.id, session);
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.sessions.has(sessionId);
  }

  async list(): Promise<string[]> {
    return [...this.sessions.keys()];
  }

  async cleanup(): Promise<number> {
    let cleaned = 0;

    for (const [id, session] of this.sessions.entries()) {
      if (isSessionExpired(session)) {
        this.sessions.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }
}
