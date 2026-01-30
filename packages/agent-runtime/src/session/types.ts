/**
 * Session management types for VAT runtime.
 *
 * These types enable pluggable session persistence strategies
 * (memory, file, cloud) independent of transport layer.
 */

/**
 * A message in the conversation history.
 */
export type Message = {
  role: 'user' | 'assistant' | 'system';
  content: string;
};

/**
 * Session data stored by runtime
 */
export interface RuntimeSession<TState = unknown> {
  /** Unique session identifier */
  id: string;
  /** Conversation history */
  history: Message[];
  /** Application-specific state */
  state: TState;
  /** Session metadata */
  metadata: SessionMetadata;
}

/**
 * Session metadata
 */
export interface SessionMetadata {
  /** Creation timestamp */
  createdAt: Date;
  /** Last access timestamp */
  lastAccessedAt: Date;
  /** Optional expiration timestamp */
  expiresAt?: Date;
  /** Runtime-specific data (checkpoints, etc.) */
  runtimeData?: Record<string, unknown>;
}

/**
 * Pluggable session storage interface
 */
export interface SessionStore<TState = unknown> {
  /**
   * Create a new session with optional initial state
   * @returns Session ID
   */
  create(initialState?: TState): Promise<string>;

  /**
   * Load session by ID
   * @throws SessionNotFoundError if session doesn't exist
   */
  load(sessionId: string): Promise<RuntimeSession<TState>>;

  /**
   * Save session (create or update)
   */
  save(session: RuntimeSession<TState>): Promise<void>;

  /**
   * Delete session
   */
  delete(sessionId: string): Promise<void>;

  /**
   * Check if session exists
   */
  exists(sessionId: string): Promise<boolean>;

  /**
   * List all session IDs (for debugging/admin)
   */
  list(): Promise<string[]>;

  /**
   * Clean up expired sessions
   */
  cleanup(): Promise<number>;
}

/**
 * Session store factory options
 */
export interface SessionStoreOptions<TState = unknown> {
  /** Session TTL in milliseconds (optional) */
  ttl?: number;
  /** Custom session ID generator */
  generateId?: () => string;
  /** Initial state factory */
  createInitialState?: () => TState;
}
