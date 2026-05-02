import { describe, expect, it } from 'vitest';

import { detectNonImperativeBody } from '../../src/validators/imperative-body-detection.js';

const LOC = '/skill.md';

describe('detectNonImperativeBody', () => {
  it('emits one issue per second-person-opener line outside code/quote blocks', () => {
    const body = [
      '# Heading',
      'You should configure the server.',
      'You can run scripts/cli.mjs.',
      'Configure the server.',
    ].join('\n');
    const issues = detectNonImperativeBody(body, LOC);
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue.code).toBe('SKILL_BODY_NOT_IMPERATIVE');
      expect(issue.severity).toBe('info');
    }
  });

  it('skips lines inside fenced code blocks', () => {
    const body = [
      '```bash',
      'You should run this',
      '```',
      'You should rewrite outside.',
    ].join('\n');
    const issues = detectNonImperativeBody(body, LOC);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('You should rewrite');
  });

  it('skips lines starting with ">" (quoted blocks)', () => {
    const body = '> You should not be flagged here.\nYou should be flagged.';
    const issues = detectNonImperativeBody(body, LOC);
    expect(issues).toHaveLength(1);
  });

  it('only matches "You" + modal verb, not "You are" or "You did"', () => {
    const body = [
      'You are a developer.',
      'You did this earlier.',
      'You should change this.',
    ].join('\n');
    const issues = detectNonImperativeBody(body, LOC);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('You should');
  });

  it('matches all targeted modal verbs', () => {
    const body = [
      'You should X.',
      'You can Y.',
      'You need to Z.',
      'You must A.',
      'You will B.',
      'You may C.',
    ].join('\n');
    const issues = detectNonImperativeBody(body, LOC);
    expect(issues).toHaveLength(6);
  });

  it('reports the line number in the location', () => {
    const body = ['# h', '', 'You should configure.'].join('\n');
    const issues = detectNonImperativeBody(body, LOC);
    expect(issues[0]?.location).toBe(`${LOC}:3`);
  });
});
