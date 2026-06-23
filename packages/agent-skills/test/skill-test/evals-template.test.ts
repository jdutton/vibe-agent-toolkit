/**
 * Unit tests for `evals-template` — the scaffolded `evals.json` template
 * (`buildEvalsTemplate`) and its writer (`writeEvalsTemplate`).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  buildEvalsTemplate,
  writeEvalsTemplate,
} from '../../src/skill-test/evals-template.js';
import { setupTempDir } from '../test-helpers.js';

const SKILL_NAME = 'my-skill';

interface PlaceholderEval {
  id: number;
  prompt: string;
  expected_output: string;
  expectations: string[];
}

interface EvalsTemplate {
  _comment: string[];
  skill_name: string;
  evals: PlaceholderEval[];
}

describe('buildEvalsTemplate', () => {
  it('produces valid JSON with the expected shape', () => {
    const text = buildEvalsTemplate(SKILL_NAME);
    const parsed = JSON.parse(text) as EvalsTemplate;

    expect(parsed.skill_name).toBe(SKILL_NAME);
    expect(Array.isArray(parsed._comment)).toBe(true);
    for (const line of parsed._comment) {
      expect(typeof line).toBe('string');
    }

    expect(parsed.evals).toHaveLength(1);
    const [placeholder] = parsed.evals;
    expect(placeholder).toBeDefined();
    expect(typeof placeholder?.id).toBe('number');
    expect(typeof placeholder?.prompt).toBe('string');
    expect(typeof placeholder?.expected_output).toBe('string');
    expect(Array.isArray(placeholder?.expectations)).toBe(true);
  });

  it('ends with a trailing newline', () => {
    expect(buildEvalsTemplate(SKILL_NAME).endsWith('\n')).toBe(true);
  });
});

describe('writeEvalsTemplate', () => {
  const { getTempDir } = setupTempDir('vat-evals-template-');

  it('creates missing parent dirs and writes the template, returning the path', () => {
    // Parent ('nested') does not exist yet — writer must create it.
    const evalsPath = safePath.join(getTempDir(), 'nested', 'evals.json');

    const returned = writeEvalsTemplate(evalsPath, SKILL_NAME);

    expect(toForwardSlash(returned)).toBe(toForwardSlash(evalsPath));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled temp path
    expect(existsSync(evalsPath)).toBe(true);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled temp path
    expect(readFileSync(evalsPath, 'utf8')).toBe(buildEvalsTemplate(SKILL_NAME));
  });

  it('never overwrites an existing eval suite (data-loss guard)', () => {
    const evalsPath = safePath.join(getTempDir(), 'authored', 'evals.json');
    const authored = '{ "skill_name": "real", "evals": [{ "id": 1 }] }\n';
    // First call creates the parent dir; then simulate the user's authored suite.
    writeEvalsTemplate(evalsPath, SKILL_NAME);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled temp path
    writeFileSync(evalsPath, authored, 'utf8');

    const returned = writeEvalsTemplate(evalsPath, SKILL_NAME);

    expect(toForwardSlash(returned)).toBe(toForwardSlash(evalsPath));
    // The authored content must survive — the writer must not clobber it.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- controlled temp path
    expect(readFileSync(evalsPath, 'utf8')).toBe(authored);
  });
});
