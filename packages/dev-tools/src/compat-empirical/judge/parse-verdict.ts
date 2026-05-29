/**
 * Parse the `claude -p --output-format json` envelope into a validated verdict.
 *
 * The judge no longer gets the SDK's forced-tool guarantee, so well-formedness
 * is enforced here: extract the envelope's `result` text, locate the first
 * balanced JSON object inside it (tolerating a ```json fence or leading prose),
 * and strict-validate it against the verdict shape.
 */

import { z } from 'zod';

import { JudgeVerdictSchema, type JudgeVerdict } from '../types.js';

const VerdictObjectSchema = z
  .object({
    verdict: JudgeVerdictSchema,
    rationale: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
  })
  .strict();

export interface ParsedVerdict {
  verdict: { verdict: JudgeVerdict; rationale: string; confidence: 'high' | 'medium' | 'low' };
  usage: unknown;
  sessionId?: string;
  /** The raw parsed envelope, persisted into the judge-call artifact for debugging. */
  envelope: unknown;
}

/** Advance the string-scanning state machine by one character. */
function advanceScanState(
  ch: string,
  state: { depth: number; inString: boolean; escaped: boolean },
): void {
  if (state.escaped) { state.escaped = false; return; }
  if (ch === '\\') { state.escaped = true; return; }
  if (ch === '"') { state.inString = !state.inString; return; }
  if (state.inString) return;
  if (ch === '{') { state.depth++; return; }
  if (ch === '}') { state.depth--; }
}

/** Find the first balanced top-level {...} object in a string. */
function extractFirstJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in judge result');
  const state = { depth: 0, inString: false, escaped: false };
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) continue;
    advanceScanState(ch, state);
    if (!state.inString && state.depth === 0 && ch === '}') return text.slice(start, i + 1);
  }
  throw new Error('no JSON object found in judge result (unbalanced braces)');
}

export function parseVerdictFromEnvelope(stdout: string): ParsedVerdict {
  const envelope = JSON.parse(stdout) as Record<string, unknown>;
  const result = envelope['result'];
  if (typeof result !== 'string') {
    throw new Error('claude --output-format json envelope missing string `result` field');
  }
  const objText = extractFirstJsonObject(result.trim());
  const parsed = VerdictObjectSchema.parse(JSON.parse(objText));
  return {
    verdict: {
      verdict: parsed.verdict,
      rationale: parsed.rationale.slice(0, 240),
      confidence: parsed.confidence,
    },
    usage: envelope['usage'],
    ...(typeof envelope['session_id'] === 'string' ? { sessionId: envelope['session_id'] } : {}),
    envelope,
  };
}
