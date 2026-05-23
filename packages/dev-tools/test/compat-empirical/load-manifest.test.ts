import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  indexPromptsById,
  loadManifest,
  loadTriggerPrompts,
} from '../../src/compat-empirical/corpus/load-manifest.js';

const TRIGGER_PROMPTS_FIXTURE = 'trigger-prompts.yaml';
const fixturesDir = safePath.join(safePath.resolve(fileURLToPath(import.meta.url), '..'), 'fixtures');

describe('loadManifest', () => {
  it('parses and validates a well-formed manifest', () => {
    const manifest = loadManifest(safePath.join(fixturesDir, 'manifest-valid.yaml'));
    expect(manifest.version).toBe(1);
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0]?.id).toBe('skill-one');
    expect(manifest.entries[1]?.source.kind).toBe('git');
  });

  it('rejects a malformed manifest', () => {
    expect(() => loadManifest(safePath.join(fixturesDir, 'manifest-invalid.yaml'))).toThrow();
  });
});

describe('loadTriggerPrompts', () => {
  it('parses a well-formed prompts file', () => {
    const prompts = loadTriggerPrompts(safePath.join(fixturesDir, TRIGGER_PROMPTS_FIXTURE));
    expect(prompts.prompts).toHaveLength(2);
    expect(prompts.prompts[0]?.authoring).toBe('hand');
  });
});

describe('indexPromptsById', () => {
  it('indexes prompts by id', () => {
    const prompts = loadTriggerPrompts(safePath.join(fixturesDir, TRIGGER_PROMPTS_FIXTURE));
    const idx = indexPromptsById(prompts);
    expect(idx.size).toBe(2);
    expect(idx.get('skill-one-default')?.prompt).toContain('skill one');
  });

  it('rejects duplicate prompt ids', () => {
    const prompts = loadTriggerPrompts(safePath.join(fixturesDir, TRIGGER_PROMPTS_FIXTURE));
    const first = prompts.prompts[0];
    if (!first) throw new Error('test fixture must contain at least one prompt');
    const dup = { version: 1 as const, prompts: [...prompts.prompts, first] };
    expect(() => indexPromptsById(dup)).toThrow();
  });
});
