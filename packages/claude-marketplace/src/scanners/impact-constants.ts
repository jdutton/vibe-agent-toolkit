/**
 * Shared impact level constants for scanners.
 *
 * These are temporary — WS6 replaces scanner impact maps with
 * observation emission. Until then, centralise them to avoid duplication.
 */

import type { ImpactLevel, Target } from '../types.js';

/** Chat needs review, cowork and code ok */
export const CHAT_NEEDS_REVIEW: Record<Target, ImpactLevel> = { 'claude-chat': 'needs-review', 'claude-cowork': 'ok', 'claude-code': 'ok' };

/** All targets ok */
export const ALL_OK: Record<Target, ImpactLevel> = { 'claude-chat': 'ok', 'claude-cowork': 'ok', 'claude-code': 'ok' };

/** Chat incompatible, cowork and code ok */
export const CHAT_INCOMPATIBLE: Record<Target, ImpactLevel> = { 'claude-chat': 'incompatible', 'claude-cowork': 'ok', 'claude-code': 'ok' };
