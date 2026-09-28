/**
 * The subjects file schema — pure (`parseVerdictSubjects` reads no file).
 */

import { describe, expect, it } from 'vitest';

import { parseVerdictSubjects } from '../src/facets/verdict/subjects.js';

/**
 * @param subject - Fields over a minimal valid subject
 * @returns A subjects document with that one subject
 */
function doc(subject: Record<string, unknown>): unknown {
  return { subjects: [{ alias: 'crucible-1', path: '../trees/one', verbs: ['audit'], ...subject }] };
}

describe('parseVerdictSubjects', () => {
  it('accepts a minimal subject and applies the defaults (positive control)', () => {
    expect(parseVerdictSubjects(doc({}))).toEqual({
      ok: true,
      subjects: {
        subjects: [{ alias: 'crucible-1', path: '../trees/one', verbs: ['audit'], sqlFiles: [], buildVerbs: false }],
      },
    });
  });

  it('requires contextPath when context-path is listed', () => {
    expect(parseVerdictSubjects(doc({ verbs: ['context-path'] }))).toMatchObject({
      ok: false,
      refusal: expect.stringContaining("'context-path' is listed"),
    });
  });

  it('refuses a contextPath nothing would use', () => {
    expect(parseVerdictSubjects(doc({ contextPath: 'docs/x.md' }))).toMatchObject({
      ok: false,
      refusal: expect.stringContaining('silently unused'),
    });
  });

  it('refuses an unknown verb', () => {
    expect(parseVerdictSubjects(doc({ verbs: ['skill-lint'] }))).toMatchObject({
      ok: false,
      refusal: expect.stringContaining('verbs.0'),
    });
  });

  it('refuses resources-query without SQL files', () => {
    expect(parseVerdictSubjects(doc({ verbs: ['resources-query'] }))).toMatchObject({
      ok: false,
      refusal: expect.stringContaining('sqlFiles'),
    });
  });

  it('refuses an alias that is not lowercase-hyphenated, and a repeated alias', () => {
    expect(parseVerdictSubjects(doc({ alias: 'Some Adopter' }))).toMatchObject({ ok: false });
    const twice = { subjects: [{ alias: 'a', path: 'x', verbs: ['audit'] }, { alias: 'a', path: 'y', verbs: ['audit'] }] };
    expect(parseVerdictSubjects(twice)).toMatchObject({ ok: false, refusal: expect.stringContaining('declared twice') });
  });
});
