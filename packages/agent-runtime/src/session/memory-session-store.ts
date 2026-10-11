/**
 * In-memory session store for VAT runtime.
 *
 * Ephemeral storage for development, tests and single-process deployments.
 */

import { promised } from '@vibe-agent-toolkit/utils';

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

  create(initialState?: TState): Promise<string> {
    return promised(() => {
      const id = this.generateId();
      const session = createInitialSession(id, initialState, this.createInitialState, this.ttl);
      this.sessions.set(id, session);
      return id;
    });
  }

  load(sessionId: string): Promise<RuntimeSession<TState>> {
    return promised(() => this.loadNow(sessionId));
  }

  private loadNow(sessionId: string): RuntimeSession<TState> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    if (isSessionExpired(session)) {
      this.sessions.delete(sessionId);
      throw new SessionNotFoundError(sessionId);
    }

    updateSessionAccess(session, this.ttl);

    return session;
  }

  save(session: RuntimeSession<TState>): Promise<void> {
    return promised(() => {
      session.metadata.lastAccessedAt = new Date();
      this.sessions.set(session.id, session);
    });
  }

  delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }

  exists(sessionId: string): Promise<boolean> {
    return Promise.resolve(this.sessions.has(sessionId));
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.sessions.keys()]);
  }

  cleanup(): Promise<number> {
    let cleaned = 0;

    for (const [id, session] of this.sessions.entries()) {
      if (isSessionExpired(session)) {
        this.sessions.delete(id);
        cleaned++;
      }
    }

    return Promise.resolve(cleaned);
  }
}
