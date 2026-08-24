/**
 * Transcript parser for `claude -p --output-format stream-json`. The format
 * is one JSON object per line; we collect the assistant text + tool-use
 * events for the observation record.
 *
 * The stream-json schema is informally documented and may shift between
 * Claude Code releases. This parser is intentionally tolerant of unknown
 * event kinds — an event whose `type` we do not recognise is simply not
 * consumed. Tolerance stops at unknown SHAPES: a line that is not JSON at all is
 * counted into {@link ParsedTranscript.malformedLineCount}, because that is data
 * loss, not forward compatibility.
 *
 * Shape notes (empirically verified):
 * - `tool_use` content blocks carry `input.command` for Bash calls.
 * - `tool_result` content blocks (on `user` events) carry `is_error`.
 * - `parent_tool_use_id` lives on the TOP-LEVEL event object (not the content
 *   block) — `null` for top-level tool calls, the parent's tool_use id for
 *   subagent-attributed calls.
 * - The terminal `result` event carries `subtype`, `is_error`, `num_turns`,
 *   and `total_cost_usd`.
 */

export interface ParsedTranscript {
  text: string;
  toolUseEvents: Array<{ name: string; inputSummary: string }>;
  errors: string[];
  /**
   * How many non-empty lines failed `JSON.parse` and were therefore NOT consumed.
   *
   * This is the only thing that distinguishes "parsed fine, nothing found" from
   * "we lost the evidence". A corrupted line drops its whole event — the tool call
   * in it, and any contamination it proves — while every other line, including the
   * terminal `result`, still parses. Every downstream "did this transcript decode?"
   * test is an any-of over the populated fields, so the surviving `result` line on
   * its own certifies the transcript as decoded and the loss goes unremarked.
   *
   * Non-zero means the scan that consumed this transcript ran on less than the
   * whole transcript and its verdict must be reported as DEGRADED, never clean.
   * Zero is a positive statement, not an absence: every line was accounted for.
   */
  malformedLineCount: number;
  toolUses: Array<{
    id: string | null;
    name: string;
    command?: string;
    /**
     * The FULL, unsummarized tool input.
     *
     * `inputSummary` beside it is truncated to 200 characters by
     * {@link summarizeValue}, which is fine for an observation record a human
     * skims and useless for anything that has to REASON about what the call did
     * — a path 200 characters into a `Read` input simply is not there. The
     * baseline-integrity detector walks tool inputs to decide whether the
     * skill-absent arm reached the skill, so it needs the whole value; the
     * summary stays for the consumers that only ever display it.
     *
     * `unknown` because the shape is per-tool and informally documented — every
     * consumer narrows it itself rather than trusting a type we invented.
     */
    input: unknown;
    inputSummary: string;
    parentToolUseId: string | null;
  }>;
  toolResults: Array<{
    toolUseId: string | null;
    isError: boolean;
    contentSummary: string;
    /**
     * The FULL tool result, flattened to text. Same reason as `input` above:
     * `contentSummary` is truncated to 200 characters, so scanning a tool RESULT
     * for evidence (a file's contents echoed back, a grep hit line) cannot be
     * done through it. Never truncated — the caller bounds what it keeps.
     */
    content: string;
  }>;
  result?: { subtype?: string; isError: boolean; numTurns?: number; totalCostUsd?: number };
  rateLimited: boolean;
}

function summarizeValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json.length > 200 ? `${json.slice(0, 197)}...` : json;
  } catch {
    return '<unserializable>';
  }
}

function stringifyValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '<unserializable>';
  }
}

/**
 * Flatten a `tool_result` `content` field to plain text, WITHOUT truncating.
 *
 * Three shapes occur in practice: a bare string (most Bash results), an array of
 * content blocks (`{type:'text',text}` and friends), and — for a tool that
 * returns structured data — an arbitrary object. The array case is the one that
 * matters: `JSON.stringify` of it would bury the text behind escaped quotes, and
 * a consumer scanning for a verbatim sentence would never find it.
 */
function contentToText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((block) => contentBlockToText(block)).join('\n');
  if (value === undefined || value === null) return '';
  return stringifyValue(value);
}

function contentBlockToText(block: unknown): string {
  if (typeof block === 'string') return block;
  if (block !== null && typeof block === 'object') {
    const { text } = block as { text?: unknown };
    if (typeof text === 'string') return text;
  }
  return stringifyValue(block);
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

interface MessageEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  parent_tool_use_id?: string | null;
  message?: { content?: ContentBlock[] };
  error?: string | { message?: string };
  num_turns?: number;
  total_cost_usd?: number;
}

function extractCommand(input: unknown): string | undefined {
  if (input !== null && typeof input === 'object' && typeof (input as { command?: unknown }).command === 'string') {
    return (input as { command: string }).command;
  }
  return undefined;
}

function consumeAssistantBlocks(
  blocks: ContentBlock[],
  parentToolUseId: string | null,
  out: ParsedTranscript,
): void {
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out.text += block.text;
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      const inputSummary = summarizeValue(block.input);
      out.toolUseEvents.push({ name: block.name, inputSummary });

      const command = extractCommand(block.input);
      out.toolUses.push({
        id: typeof block.id === 'string' ? block.id : null,
        name: block.name,
        ...(command === undefined ? {} : { command }),
        input: block.input,
        inputSummary,
        parentToolUseId,
      });
    }
  }
}

function consumeUserBlocks(blocks: ContentBlock[], out: ParsedTranscript): void {
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      out.toolResults.push({
        toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
        isError: block.is_error === true,
        contentSummary: summarizeValue(block.content),
        content: contentToText(block.content),
      });
    }
  }
}

/** True when the event's `type`/`subtype` mentions rate-limiting, or it carries a `rate_limit_event` field. */
function detectRateLimit(parsed: Record<string, unknown>): boolean {
  const { type, subtype } = parsed;
  if (typeof type === 'string' && type.includes('rate_limit')) return true;
  if (typeof subtype === 'string' && subtype.includes('rate_limit')) return true;
  return Object.prototype.hasOwnProperty.call(parsed, 'rate_limit_event');
}

function consumeResultEvent(parsed: MessageEvent, out: ParsedTranscript): void {
  // `claude -p --output-format stream-json` reports in-stream failures
  // (max-turns, rate-limit, content-filter, tool error) as a terminal
  // `result` event with is_error:true and a `subtype` discriminator.
  out.result = {
    ...(typeof parsed.subtype === 'string' ? { subtype: parsed.subtype } : {}),
    isError: parsed.is_error === true,
    ...(typeof parsed.num_turns === 'number' ? { numTurns: parsed.num_turns } : {}),
    ...(typeof parsed.total_cost_usd === 'number' ? { totalCostUsd: parsed.total_cost_usd } : {}),
  };
  if (parsed.is_error === true) {
    out.errors.push(`runtime ${parsed.subtype ?? 'error'}`);
  }
}

function consumeErrorEvent(parsed: MessageEvent, out: ParsedTranscript): void {
  // Kept for forward compatibility — the stream-json schema is informally
  // documented and may emit standalone error events in future releases.
  const errMsg = typeof parsed.error === 'string'
    ? parsed.error
    : parsed.error?.message ?? 'unknown error event';
  out.errors.push(errMsg);
}

function applyEvent(parsed: MessageEvent, out: ParsedTranscript): void {
  if (detectRateLimit(parsed as Record<string, unknown>)) {
    out.rateLimited = true;
  }

  if (parsed.type === 'assistant' && parsed.message?.content) {
    consumeAssistantBlocks(parsed.message.content, parsed.parent_tool_use_id ?? null, out);
  } else if (parsed.type === 'user' && parsed.message?.content) {
    consumeUserBlocks(parsed.message.content, out);
  } else if (parsed.type === 'result') {
    consumeResultEvent(parsed, out);
  } else if (parsed.type === 'error') {
    consumeErrorEvent(parsed, out);
  }
}

export function parseStreamJsonTranscript(streamText: string): ParsedTranscript {
  const out: ParsedTranscript = {
    text: '',
    toolUseEvents: [],
    errors: [],
    toolUses: [],
    toolResults: [],
    rateLimited: false,
    malformedLineCount: 0,
  };
  const lines = streamText.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: MessageEvent;
    try {
      parsed = JSON.parse(trimmed) as MessageEvent;
    } catch {
      // Counted, not thrown on, and never pushed into `errors`: `errors` reports
      // what the AGENT hit, this reports what the PARSER lost. Conflating them
      // would make a harness defect look like a run failure and vice versa.
      out.malformedLineCount += 1;
      continue;
    }

    applyEvent(parsed, out);
  }

  return out;
}

export function detectInvocationFromTranscript(
  parsed: ParsedTranscript,
  invocationSignals: readonly string[],
): boolean {
  if (parsed.toolUseEvents.length > 0) return true;
  if (invocationSignals.length === 0) {
    return parsed.text.trim().length > 0;
  }
  const haystack = parsed.text.toLowerCase();
  return invocationSignals.some((s) => haystack.includes(s.toLowerCase()));
}
