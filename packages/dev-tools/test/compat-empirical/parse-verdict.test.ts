import { describe, expect, it } from 'vitest';

import { parseVerdictFromEnvelope } from '../../src/compat-empirical/judge/parse-verdict.js';

function envelope(result: string): string {
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: 's1', usage: { output_tokens: 5 } });
}

const VALID = '{"verdict":"completed","rationale":"did the thing","confidence":"high"}';

describe('parseVerdictFromEnvelope', () => {
  it('parses a bare-JSON result', () => {
    const v = parseVerdictFromEnvelope(envelope(VALID));
    expect(v.verdict.verdict).toBe('completed');
    expect(v.verdict.confidence).toBe('high');
    expect(v.sessionId).toBe('s1');
  });

  it('parses a fenced result', () => {
    const v = parseVerdictFromEnvelope(envelope('```json\n' + VALID + '\n```'));
    expect(v.verdict.verdict).toBe('completed');
  });

  it('parses with leading prose', () => {
    const v = parseVerdictFromEnvelope(envelope('Here is my verdict: ' + VALID));
    expect(v.verdict.verdict).toBe('completed');
  });

  it('truncates rationale to 240 chars', () => {
    const long = 'x'.repeat(300);
    const v = parseVerdictFromEnvelope(envelope(`{"verdict":"partial","rationale":"${long}","confidence":"low"}`));
    expect(v.verdict.rationale).toHaveLength(240);
  });

  it('throws when the envelope has no string result', () => {
    expect(() => parseVerdictFromEnvelope('{"type":"result"}')).toThrow(/result/);
  });

  it('throws when no JSON object is present', () => {
    expect(() => parseVerdictFromEnvelope(envelope('no json here'))).toThrow(/JSON object/);
  });

  it('throws when the verdict enum is invalid', () => {
    expect(() => parseVerdictFromEnvelope(envelope('{"verdict":"great","rationale":"r","confidence":"high"}'))).toThrow();
  });
});
