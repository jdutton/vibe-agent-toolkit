/**
 * Transcript parser for `claude -p --output-format stream-json`. The format
 * is one JSON object per line; we collect the assistant text + tool-use
 * events for the observation record.
 *
 * The stream-json schema is informally documented and may shift between
 * Claude Code releases. This parser is intentionally tolerant of unknown
 * event kinds — anything we don't recognise is appended to `raw`.
 */

export interface ParsedTranscript {
  text: string;
  toolUseEvents: Array<{ name: string; inputSummary: string }>;
  errors: string[];
  raw: string[];
}

function summarizeInput(input: unknown): string {
  try {
    const json = JSON.stringify(input);
    return json.length > 200 ? `${json.slice(0, 197)}...` : json;
  } catch {
    return '<unserializable>';
  }
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface MessageEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  message?: { content?: ContentBlock[] };
  error?: string | { message?: string };
}

function consumeContentBlocks(blocks: ContentBlock[], out: ParsedTranscript): void {
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out.text += block.text;
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      out.toolUseEvents.push({ name: block.name, inputSummary: summarizeInput(block.input) });
    }
  }
}

export function parseStreamJsonTranscript(streamText: string): ParsedTranscript {
  const out: ParsedTranscript = { text: '', toolUseEvents: [], errors: [], raw: [] };
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

    if (parsed.type === 'assistant' && parsed.message?.content) {
      consumeContentBlocks(parsed.message.content, out);
    } else if (parsed.type === 'result' && parsed.is_error === true) {
      // `claude -p --output-format stream-json` reports in-stream failures
      // (max-turns, rate-limit, content-filter, tool error) as a terminal
      // `result` event with is_error:true and a `subtype` discriminator.
      out.errors.push(`runtime ${parsed.subtype ?? 'error'}`);
    } else if (parsed.type === 'error') {
      // Kept for forward compatibility — the stream-json schema is informally
      // documented and may emit standalone error events in future releases.
      const errMsg = typeof parsed.error === 'string'
        ? parsed.error
        : parsed.error?.message ?? 'unknown error event';
      out.errors.push(errMsg);
    }
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
