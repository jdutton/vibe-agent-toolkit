/**
 * Transcript parser for `claude -p --output-format stream-json`. The format
 * is one JSON object per line; we collect the assistant text + tool-use
 * events for the observation record.
 *
 * The stream-json schema is informally documented and may shift between
 * Claude Code releases. This parser is intentionally tolerant of unknown
 * event kinds — anything we don't recognise is appended to `raw`.
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
  raw: string[];
  toolUses: Array<{
    id: string | null;
    name: string;
    command?: string;
    inputSummary: string;
    parentToolUseId: string | null;
  }>;
  toolResults: Array<{ toolUseId: string | null; isError: boolean; contentSummary: string }>;
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
    raw: [],
    toolUses: [],
    toolResults: [],
    rateLimited: false,
  };
  const lines = streamText.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    out.raw.push(trimmed);

    let parsed: MessageEvent;
    try {
      parsed = JSON.parse(trimmed) as MessageEvent;
    } catch {
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
