/**
 * File-based session store for Claude Agent SDK runtime.
 *
 * Uses local file system for durable session storage following
 * Claude Agent SDK's storage patterns.
 */

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  RuntimeSession,
  SessionStore,
  SessionStoreOptions,
} from '@vibe-agent-toolkit/agent-runtime';
import {
  createInitialSession,
  isSessionExpired,
  updateSessionAccess,
  SessionNotFoundError,
  validateSessionId,
} from '@vibe-agent-toolkit/agent-runtime';

/**
 * File-based session store using Claude Agent SDK's storage pattern.
 *
 * Storage location: ~/.claude/vat-sessions/{session-id}/
 *
 * Use cases:
 * - Local development matching Claude Code behavior
 * - Single-machine deployments with persistence
 * - File checkpointing integration
 *
 * Characteristics:
 * - Durable (survives process restart)
 * - Local (single machine only)
 * - Integrates with Claude Agent SDK checkpointing
 */
export class FileSessionStore<TState = unknown> implements SessionStore<TState> {
  private readonly baseDir: string;
  private readonly generateId: () => string;
  private readonly createInitialState: (() => TState) | undefined;
  private readonly ttl: number | undefined;

  constructor(options: FileSessionStoreOptions<TState> = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.claude', 'vat-sessions');
    this.generateId = options.generateId ?? (() => crypto.randomUUID());
    this.createInitialState = options.createInitialState;
    this.ttl = options.ttl;
  }

  async create(initialState?: TState): Promise<string> {
    const id = this.generateId();
    const session = createInitialSession(id, initialState, this.createInitialState, this.ttl);
    await this.save(session);
    return id;
  }

  async load(sessionId: string): Promise<RuntimeSession<TState>> {
    const sessionPath = this.getSessionPath(sessionId);

    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- sessionId validated by getSessionPath
      const data = await readFile(sessionPath, 'utf-8');
      const session = JSON.parse(data) as RuntimeSession<TState>;

      // Parse dates
      session.metadata.createdAt = new Date(session.metadata.createdAt);
      session.metadata.lastAccessedAt = new Date(session.metadata.lastAccessedAt);
      if (session.metadata.expiresAt) {
        session.metadata.expiresAt = new Date(session.metadata.expiresAt);
      }

      // Check expiration
      if (isSessionExpired(session)) {
        await this.delete(sessionId);
        throw new SessionNotFoundError(sessionId);
      }

      // Update last access and extend TTL
      updateSessionAccess(session, this.ttl);

      // Save updated access time
      await this.save(session);

      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }
  }

  async save(session: RuntimeSession<TState>): Promise<void> {
    const sessionPath = this.getSessionPath(session.id);
    const sessionDir = join(this.baseDir, session.id);

    // Ensure directory exists
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- session.id validated by getSessionPath
    await mkdir(sessionDir, { recursive: true });

    // Write session data
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- sessionPath validated by getSessionPath
    await writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
  }

  async delete(sessionId: string): Promise<void> {
    const sessionPath = this.getSessionPath(sessionId);
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- sessionPath validated by getSessionPath
      await unlink(sessionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async exists(sessionId: string): Promise<boolean> {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- sessionId validated by getSessionPath
      await readFile(this.getSessionPath(sessionId));
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<string[]> {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- baseDir set in constructor
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async cleanup(): Promise<number> {
    const sessionIds = await this.list();
    let cleaned = 0;

    for (const id of sessionIds) {
      try {
        const session = await this.load(id);
        if (isSessionExpired(session)) {
          await this.delete(id);
          cleaned++;
        }
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          cleaned++;
        }
      }
    }

    return cleaned;
  }

  private getSessionPath(sessionId: string): string {
    validateSessionId(sessionId);
    return join(this.baseDir, sessionId, 'session.json');
  }

  /**
   * Get checkpoint directory for this session (for Claude Agent SDK integration)
   */
  getCheckpointDir(sessionId: string): string {
    validateSessionId(sessionId);
    return join(this.baseDir, sessionId, 'checkpoints');
  }
}

export interface FileSessionStoreOptions<TState = unknown> extends SessionStoreOptions<TState> {
  /** Base directory for sessions (default: ~/.claude/vat-sessions) */
  baseDir?: string;
}
