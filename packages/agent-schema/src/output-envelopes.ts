/**
 * Output envelope types for different agent archetypes.
 */

import type { AgentResult, StatefulAgentResult } from './result-types.js';

/**
 * Output envelope for one-shot agents (pure functions, analyzers).
 *
 * Simpler envelope for synchronous, single-execution agents.
 * Used by archetypes: Pure Function Tool, One-Shot LLM Analyzer
 */
export interface OneShotAgentOutput<TData, TError extends string = string> {
  /** Machine-readable result for orchestration */
  result: AgentResult<TData, TError>;

  /** Optional metadata (tokens used, confidence score, timing, etc.) */
  metadata?: Record<string, unknown>;
}

/**
 * Output envelope for conversational agents.
 *
 * Combines human-facing conversational interface with
 * machine-readable result for orchestration.
 * Used by archetype: Conversational Assistant
 */
export interface ConversationalAgentOutput<TData, TError extends string = string, TSessionState = unknown> {
  /** Human-readable response for display */
  reply: string;

  /** Updated session state for next turn */
  sessionState: TSessionState;

  /** Machine-readable result for orchestration */
  result: StatefulAgentResult<TData, TError, {
    /** Optional progress indicators for monitoring */
    progress?: {
      current: number;
      total: number;
      message?: string;
    };
  }>;
}
