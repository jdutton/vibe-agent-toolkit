/* eslint-disable security/detect-non-literal-fs-filename -- harness-controlled tmpdir paths */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  indexPromptsById,
  loadManifest,
  loadTriggerPrompts,
  validateEntryPromptKinds,
} from '../../src/compat-empirical/corpus/load-manifest.js';

const TRIGGER_PROMPTS_FIXTURE = 'trigger-prompts.yaml';
const fixturesDir = safePath.join(safePath.resolve(fileURLToPath(import.meta.url), '..'), 'fixtures');

function writeFixtures(manifestYaml: string, promptsYaml: string): {
  manifestPath: string;
  promptsPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'compat-empirical-loadtest-'));
  const manifestPath = safePath.join(dir, 'manifest.yaml');
  const promptsPath = safePath.join(dir, 'prompts.yaml');
  writeFileSync(manifestPath, manifestYaml, 'utf8');
  writeFileSync(promptsPath, promptsYaml, 'utf8');
  return { manifestPath, promptsPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Shared driver for cross-file-validation test cases: writes the supplied
 * manifest + prompts YAML to a tmpdir, loads them via the public APIs, and
 * invokes the assertion against `validateEntryPromptKinds`. Extracted to keep
 * the three sibling tests free of structural duplication.
 */
function runValidationCase(
  manifestYaml: string,
  promptsYaml: string,
  assertion: (run: () => void) => void,
): void {
  const { manifestPath, promptsPath, cleanup } = writeFixtures(manifestYaml, promptsYaml);
  try {
    const manifest = loadManifest(manifestPath);
    const prompts = loadTriggerPrompts(promptsPath);
    const promptById = indexPromptsById(prompts);
    assertion(() => validateEntryPromptKinds(manifest, promptById));
  } finally {
    cleanup();
  }
}

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
    expect(prompts.prompts).toHaveLength(4);
    expect(prompts.prompts[0]?.authoring).toBe('hand');
  });
});

describe('indexPromptsById', () => {
  it('indexes prompts by id', () => {
    const prompts = loadTriggerPrompts(safePath.join(fixturesDir, TRIGGER_PROMPTS_FIXTURE));
    const idx = indexPromptsById(prompts);
    expect(idx.size).toBe(4);
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

const MISSING_KIND_PATTERN = /must reference at least one positive and one negative prompt/;

describe('loadManifest cross-file validation', () => {
  it('rejects an entry with no negative prompt', () => {
    runValidationCase(
      `version: 1
entries:
  - id: skill-a
    bucket: own
    source: { kind: local, path: ./skills/a }
    skillRelPath: SKILL.md
    expectedCapabilities: []
    triggerPromptRefs: [pos-1, pos-2]
`,
      `version: 1
prompts:
  - id: pos-1
    forSkillId: skill-a
    prompt: do the thing
    expectedBehavior: { description: succeeds, invocationSignals: [thing] }
    authoring: hand
    kind: positive
  - id: pos-2
    forSkillId: skill-a
    prompt: do the other thing
    expectedBehavior: { description: succeeds, invocationSignals: [thing] }
    authoring: hand
    kind: positive
`,
      (run) => expect(run).toThrowError(MISSING_KIND_PATTERN),
    );
  });

  it('rejects an entry with no positive prompt', () => {
    runValidationCase(
      `version: 1
entries:
  - id: skill-b
    bucket: own
    source: { kind: local, path: ./skills/b }
    skillRelPath: SKILL.md
    expectedCapabilities: []
    triggerPromptRefs: [neg-1, neg-2]
`,
      `version: 1
prompts:
  - id: neg-1
    forSkillId: skill-b
    prompt: don't do the thing
    expectedBehavior: { description: should not invoke, invocationSignals: [thing] }
    authoring: hand
    kind: negative
  - id: neg-2
    forSkillId: skill-b
    prompt: ignore the thing
    expectedBehavior: { description: should not invoke, invocationSignals: [thing] }
    authoring: hand
    kind: negative
`,
      (run) => expect(run).toThrowError(MISSING_KIND_PATTERN),
    );
  });

  it('accepts an entry with at least one positive and one negative prompt', () => {
    runValidationCase(
      `version: 1
entries:
  - id: skill-c
    bucket: own
    source: { kind: local, path: ./skills/c }
    skillRelPath: SKILL.md
    expectedCapabilities: []
    triggerPromptRefs: [pos-1, neg-1]
`,
      `version: 1
prompts:
  - id: pos-1
    forSkillId: skill-c
    prompt: do the thing
    expectedBehavior: { description: succeeds, invocationSignals: [thing] }
    authoring: hand
    kind: positive
  - id: neg-1
    forSkillId: skill-c
    prompt: don't do the thing
    expectedBehavior: { description: should not invoke, invocationSignals: [thing] }
    authoring: hand
    kind: negative
`,
      (run) => expect(run).not.toThrow(),
    );
  });
});
