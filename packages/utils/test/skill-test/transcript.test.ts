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

  it('is tolerant of unknown/malformed lines: keeps going and does not invent errors', () => {
    const raw = ['not json {{{', JSON.stringify({ type: 'unknown_future_event', foo: 'bar' })].join(
      '\n',
    );
    const parsed = parseStreamJsonTranscript(raw);
    // Tolerance means "do not throw", not "do not report": the unparseable line is
    // counted, the unknown-but-valid line is not, and neither is a runtime `error`.
    expect(parsed.malformedLineCount).toBe(1);
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

/**
 * The one failure this module exists to prevent.
 *
 * A per-line `JSON.parse` failure used to be swallowed with a bare `continue`, so a
 * corrupted `tool_use` line simply vanished from `toolUses` — and the terminal
 * `result` line, which parses fine, still satisfied every downstream any-of
 * "did this transcript decode?" check. The contamination detector then reported a
 * confident CLEAN verdict on evidence it never saw.
 *
 * `malformedLineCount` is the only thing that separates "parsed fine, nothing
 * found" from "we lost the evidence". Its name is a contract with the detector,
 * which raises a degradation when it is non-zero.
 */
describe('parseStreamJsonTranscript malformed-line accounting', () => {
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- fixture path, mirrors the real harness staging root
  const HARNESS_PATH = '/tmp/vat-skill-test/my-skill-abc12345/staged/s/SKILL.md';

  const TOOL_USE_EVENT = {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: HARNESS_PATH } }],
    },
  };
  const RESULT_EVENT = { type: 'result', subtype: 'success', is_error: false, num_turns: 1 };

  /** Break a line's JSON without touching any other line (what a split chunk does in effect). */
  const corrupt = (transcript: string): string => transcript.replace('{"type":"assistant"', '�{"type":"assistant"');

  it('is 0 when every non-empty line parsed', () => {
    const parsed = parseStreamJsonTranscript(stream(TOOL_USE_EVENT, RESULT_EVENT));
    expect(parsed.malformedLineCount).toBe(0);
    expect(parsed.toolUses[0]?.input).toEqual({ file_path: HARNESS_PATH });
  });

  it('counts the corrupted line whose contamination evidence it dropped, and still parses the rest', () => {
    const intact = stream(TOOL_USE_EVENT, RESULT_EVENT);
    const parsed = parseStreamJsonTranscript(corrupt(intact));

    // The evidence is gone: the reach the detector would have convicted on is not here.
    expect(parsed.toolUses).toEqual([]);
    // And the any-of decoded check downstream is STILL satisfied by the result line
    // alone — which is exactly why the count has to exist.
    expect(parsed.result).toBeDefined();
    expect(parsed.malformedLineCount).toBe(1);
  });

  it('counts each corrupted line separately', () => {
    const parsed = parseStreamJsonTranscript(['{"type":"assistant"', 'also not json', JSON.stringify(RESULT_EVENT)].join('\n'));
    expect(parsed.malformedLineCount).toBe(2);
  });

  it('does not count a valid line carrying an unknown event type', () => {
    const parsed = parseStreamJsonTranscript(stream({ type: 'unknown_future_event', foo: 'bar' }));
    expect(parsed.malformedLineCount).toBe(0);
  });

  it('does not count blank or whitespace-only lines', () => {
    const parsed = parseStreamJsonTranscript(`\n   \n${JSON.stringify(RESULT_EVENT)}\n\n`);
    expect(parsed.malformedLineCount).toBe(0);
    expect(parsed.result).toBeDefined();
  });

  it('reports 0 for an empty transcript — distinguishable from a transcript that decoded to nothing', () => {
    const empty = parseStreamJsonTranscript('');
    expect(empty.malformedLineCount).toBe(0);
    expect(empty.result).toBeUndefined();
    expect(empty.toolUses).toEqual([]);

    // Valid JSONL that simply made no tool calls: same emptiness, same zero count.
    const quiet = parseStreamJsonTranscript(stream({ type: 'assistant', message: { content: [{ type: 'text', text: 'no tools needed' }] } }, RESULT_EVENT));
    expect(quiet.malformedLineCount).toBe(0);
    expect(quiet.toolUses).toEqual([]);
    expect(quiet.text).toBe('no tools needed');
  });

  it('counts a line of non-UTF8 bytes decoded to replacement characters', () => {
    const garbage = Buffer.from([0xff, 0xfe, 0x00, 0x41]).toString('utf8');
    const parsed = parseStreamJsonTranscript(garbage);
    expect(parsed.malformedLineCount).toBe(1);
    // Nothing else fired, so without the count this is indistinguishable from ''.
    expect(parsed.result).toBeUndefined();
    expect(parsed.text).toBe('');
  });

  it('a replacement character INSIDE a JSON string is still valid JSON and is not counted', () => {
    const parsed = parseStreamJsonTranscript(
      stream({ type: 'assistant', message: { content: [{ type: 'text', text: 'caf�' }] } }),
    );
    expect(parsed.malformedLineCount).toBe(0);
    expect(parsed.text).toBe('caf�');
  });

  /**
   * Pins the field SET, not just the values: `toEqual` cannot tell an absent key
   * from an `undefined` one, so the removal of the unconsumed `raw` array (which
   * held a second full copy of the transcript) and the arrival of
   * `malformedLineCount` are both asserted here.
   */
  it('exposes exactly the documented fields — no `raw` second copy of the transcript', () => {
    const parsed = parseStreamJsonTranscript(stream(TOOL_USE_EVENT, RESULT_EVENT));
    expect(Object.keys(parsed).sort((a, b) => a.localeCompare(b))).toEqual([
      'errors',
      'malformedLineCount',
      'rateLimited',
      'result',
      'text',
      'toolResults',
      'toolUseEvents',
      'toolUses',
    ]);
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
