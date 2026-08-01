/**
 * Coverage for the `setupReferenceFixture` fixture grammar itself (not the
 * resolver): the `files:` extensions (issue #158's structural gap — the
 * fixture builder could not express a `skills.config.<name>.files` entry at
 * all, so no unit test could reproduce the leak class).
 */
/* eslint-disable security/detect-non-literal-fs-filename -- reading fixture files at dynamic temp paths */
import { existsSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { setupReferenceFixture } from './helpers.js';

const UNREACHABLE = 'unreachable';
const GEN_SOURCE = 'build-output/gen.md';
const OTHER_SOURCE = 'build-output/other.md';
const NESTED_SOURCE = 'artifacts/nested-gen.md';

function readFixtureConfig(root: string): { skills?: { config?: Record<string, unknown> } } {
  const raw = readFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), 'utf8');
  return yaml.parse(raw) as { skills?: { config?: Record<string, unknown> } };
}

describe('setupReferenceFixture — files: fixture grammar', () => {
  it('emits skills.config.<name>.files from skillFiles', () => {
    const fx = setupReferenceFixture({
      pool: ['pool-a'],
      skillFiles: {
        'pool-a': [{ source: GEN_SOURCE, dest: 'gen.md' }],
      },
      sourceFiles: {
        [GEN_SOURCE]: '# generated\n',
      },
    });

    const config = readFixtureConfig(fx.root);
    expect(config.skills?.config).toEqual({
      'pool-a': {
        files: [{ source: GEN_SOURCE, dest: 'gen.md' }],
      },
    });
  });

  it('merges poolTest and skillFiles for the same skill into one skills.config.<name> block', () => {
    const fx = setupReferenceFixture({
      pool: ['pool-b'],
      poolTest: {
        'pool-b': { evals: 'evals/pool-b.yaml' },
      },
      skillFiles: {
        'pool-b': [{ source: OTHER_SOURCE, dest: 'other.md' }],
      },
      sourceFiles: {
        [OTHER_SOURCE]: '# other\n',
      },
    });

    const config = readFixtureConfig(fx.root);
    expect(config.skills?.config).toEqual({
      'pool-b': {
        test: { evals: 'evals/pool-b.yaml' },
        files: [{ source: OTHER_SOURCE, dest: 'other.md' }],
      },
    });
  });

  it('writes declared sourceFiles to disk at the fixture root, resolvable via sourceFilePath', () => {
    const fx = setupReferenceFixture({
      pool: ['pool-c'],
      sourceFiles: {
        [GEN_SOURCE]: '# generated content\n',
      },
    });

    const abs = fx.sourceFilePath(GEN_SOURCE);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe('# generated content\n');
  });

  it('nested project spec emits its own merged skills.config with files, resolvable via nested.sourceFilePath', () => {
    const fx = setupReferenceFixture({
      pool: ['outer-a'],
      nested: {
        dir: 'nested-proj',
        pool: ['nested-a'],
        poolTest: { 'nested-a': { evals: 'evals/nested-a.yaml' } },
        skillFiles: {
          'nested-a': [{ source: NESTED_SOURCE, dest: 'nested-gen.md' }],
        },
        sourceFiles: {
          [NESTED_SOURCE]: '# nested generated\n',
        },
      },
    });

    if (fx.nested === undefined) throw new Error(UNREACHABLE);
    const nestedConfig = readFixtureConfig(fx.nested.root);
    expect(nestedConfig.skills?.config).toEqual({
      'nested-a': {
        test: { evals: 'evals/nested-a.yaml' },
        files: [{ source: NESTED_SOURCE, dest: 'nested-gen.md' }],
      },
    });

    const abs = fx.nested.sourceFilePath(NESTED_SOURCE);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe('# nested generated\n');
  });
});
