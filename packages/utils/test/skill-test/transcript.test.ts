import { describe, expect, it } from 'vitest';

import {
  detectInvocationFromTranscript,
  parseStreamJsonTranscript,
} from '../../src/skill-test/transcript.js';

/** Builds a one-JSON-object-per-line stream-json fixture from event objects. */
function stream(...events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

describe('parseStreamJsonTranscript', () => {
  it('captures assistant text into `text` (legacy field)', () => {
    const parsed = parseStreamJsonTranscript(
      stream({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: 'hello world' }] },
      }),
    );
    expect(parsed.text).toBe('hello world');
  });

  it('captures tool_use into both toolUseEvents (legacy) and toolUses (rich), with input.command for Bash', () => {
    const parsed = parseStreamJsonTranscript(
      stream({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } },
          ],
        },
      }),
    );

    expect(parsed.toolUseEvents).toEqual([
      { name: 'Bash', inputSummary: JSON.stringify({ command: 'echo hi' }) },
    ]);

    expect(parsed.toolUses).toEqual([
      {
        id: 'toolu_1',
        name: 'Bash',
        command: 'echo hi',
        input: { command: 'echo hi' },
        inputSummary: JSON.stringify({ command: 'echo hi' }),
        parentToolUseId: null,
      },
    ]);
  });

  it('omits `command` for non-Bash tool_use blocks (input.command not a string)', () => {
    const parsed = parseStreamJsonTranscript(
      stream({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/x' } }],
        },
      }),
    );

    expect(parsed.toolUses).toHaveLength(1);
    expect(parsed.toolUses[0]).not.toHaveProperty('command');
    expect(parsed.toolUses[0]?.name).toBe('Read');
  });

  it('reads parent_tool_use_id from the top-level event, not the block: null for top-level calls', () => {
    const parsed = parseStreamJsonTranscript(
      stream({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_use', id: 'toolu_top', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
    );
    expect(parsed.toolUses[0]?.parentToolUseId).toBeNull();
  });

  it('reads parent_tool_use_id from the top-level event for subagent tool calls', () => {
    const parsed = parseStreamJsonTranscript(
      stream({
        type: 'assistant',
        parent_tool_use_id: 'toolu_parent',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_child', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
    );
    expect(parsed.toolUses[0]?.parentToolUseId).toBe('toolu_parent');
  });

  it('captures tool_result blocks with tool_use_id and is_error', () => {
    const parsed = parseStreamJsonTranscript(
      stream({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', is_error: true, content: 'boom' },
          ],
        },
      }),
    );

    expect(parsed.toolResults).toEqual([
      { toolUseId: 'toolu_1', isError: true, contentSummary: JSON.stringify('boom'), content: 'boom' },
    ]);
  });

  // The whole reason the full fields exist: the summaries are capped at 200
  // characters, so anything that has to REASON about a call (which path did it
  // read? did the output quote the skill?) cannot be done through them. A long
  // path or a grep hit 200 characters in simply is not present in the summary.
  it('keeps the FULL tool input and result alongside the 200-char summaries', () => {
    const longPath = `/private/var/folders/${'d'.repeat(300)}/staged/s/SKILL.md`;
    const longOutput = `${'x'.repeat(400)} the verbatim sentence lifted from the skill body`;
    const parsed = parseStreamJsonTranscript(
      stream(
        {
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: longPath } }],
          },
        },
        {
          type: 'user',
          parent_tool_use_id: null,
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: longOutput }],
          },
        },
      ),
    );

    expect(parsed.toolUses[0]?.input).toEqual({ file_path: longPath });
    expect(parsed.toolUses[0]?.inputSummary, 'the summary must stay truncated').toHaveLength(200);
    expect(parsed.toolUses[0]?.inputSummary).not.toContain('SKILL.md');

    expect(parsed.toolResults[0]?.content).toBe(longOutput);
    expect(parsed.toolResults[0]?.contentSummary).toHaveLength(200);
    expect(parsed.toolResults[0]?.contentSummary).not.toContain('verbatim sentence');
  });

  // The array-of-blocks shape is why `content` is not just JSON.stringify: the
  // stringified form buries the text behind escaped quotes, and a consumer
  // scanning for a verbatim sentence would never find it.
  it('flattens an array-of-blocks tool_result to plain text', () => {
    const parsed = parseStreamJsonTranscript(
      stream({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [{ type: 'text', text: 'first line' }, { type: 'text', text: 'second line' }],
            },
          ],
        },
      }),
    );

    expect(parsed.toolResults[0]?.content).toBe('first line\nsecond line');
  });

  it('renders a non-text tool_result content shape without throwing', () => {
    const parsed = parseStreamJsonTranscript(
      stream({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: { rows: 3 } }],
        },
      }),
    );

    expect(parsed.toolResults[0]?.content).toBe(JSON.stringify({ rows: 3 }));
  });

  it('defaults isError to false when tool_result omits is_error', () => {
    const parsed = parseStreamJsonTranscript(
      stream({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
        },
      }),
    );
    expect(parsed.toolResults[0]?.isError).toBe(false);
  });

  it('populates `result` from the terminal result event (success)', () => {
    const parsed = parseStreamJsonTranscript(
      stream({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 3,
        total_cost_usd: 0.0123,
      }),
    );

    expect(parsed.result).toEqual({
      subtype: 'success',
      isError: false,
      numTurns: 3,
      totalCostUsd: 0.0123,
    });
    expect(parsed.errors).toEqual([]);
  });

  it('populates `result` and pushes into legacy `errors` when the terminal result is_error is true', () => {
    const parsed = parseStreamJsonTranscript(
      stream({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        num_turns: 10,
      }),
    );

    expect(parsed.result).toEqual({
      subtype: 'error_max_turns',
      isError: true,
      numTurns: 10,
    });
    expect(parsed.errors).toEqual(['runtime error_max_turns']);
  });

  it('detects rate limiting via a `rate_limit` substring in `type`', () => {
    const parsed = parseStreamJsonTranscript(stream({ type: 'rate_limit_error' }));
    expect(parsed.rateLimited).toBe(true);
  });

  it('detects rate limiting via a `rate_limit` substring in `subtype`', () => {
    const parsed = parseStreamJsonTranscript(
      stream({ type: 'result', subtype: 'rate_limit_exceeded', is_error: true }),
    );
    expect(parsed.rateLimited).toBe(true);
  });

  it('detects rate limiting via a nested `rate_limit_event` field', () => {
    const parsed = parseStreamJsonTranscript(
      stream({ type: 'stream_event', rate_limit_event: { retryAfterSeconds: 30 } }),
    );
    expect(parsed.rateLimited).toBe(true);
  });

  it('leaves rateLimited false when no rate-limit signal is present', () => {
    const parsed = parseStreamJsonTranscript(
      stream({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    );
    expect(parsed.rateLimited).toBe(false);
  });

  it('keeps legacy standalone `error` event handling', () => {
    const parsed = parseStreamJsonTranscript(stream({ type: 'error', error: 'boom' }));
    expect(parsed.errors).toEqual(['boom']);
  });

  it('is tolerant of unknown/malformed lines: appends to raw and continues', () => {
    const raw = ['not json {{{', JSON.stringify({ type: 'unknown_future_event', foo: 'bar' })].join(
      '\n',
    );
    const parsed = parseStreamJsonTranscript(raw);
    expect(parsed.raw).toEqual(['not json {{{', JSON.stringify({ type: 'unknown_future_event', foo: 'bar' })]);
    expect(parsed.errors).toEqual([]);
  });

  it('handles a full multi-line transcript end to end', () => {
    const full = stream(
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'text', text: 'Running the command...' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } },
          ],
        },
      },
      {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'hi' }],
        },
      },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.01 },
    );

    const parsed = parseStreamJsonTranscript(full);
    expect(parsed.text).toBe('Running the command...');
    expect(parsed.toolUseEvents).toHaveLength(1);
    expect(parsed.toolUses).toHaveLength(1);
    expect(parsed.toolUses[0]?.command).toBe('echo hi');
    expect(parsed.toolResults).toHaveLength(1);
    expect(parsed.toolResults[0]?.isError).toBe(false);
    expect(parsed.result?.subtype).toBe('success');
    expect(parsed.rateLimited).toBe(false);
  });
});

describe('detectInvocationFromTranscript', () => {
  it('still returns true when toolUseEvents (legacy field) is non-empty', () => {
    const parsed = parseStreamJsonTranscript(
      stream({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }],
        },
      }),
    );
    expect(detectInvocationFromTranscript(parsed, [])).toBe(true);
  });

  it('falls back to text substring matching against invocation signals', () => {
    const parsed = parseStreamJsonTranscript(
      stream({ type: 'assistant', message: { content: [{ type: 'text', text: 'The skill triggered.' }] } }),
    );
    expect(detectInvocationFromTranscript(parsed, ['triggered'])).toBe(true);
    expect(detectInvocationFromTranscript(parsed, ['nope'])).toBe(false);
  });
});
