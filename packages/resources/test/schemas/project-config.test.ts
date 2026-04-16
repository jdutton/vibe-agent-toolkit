import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import type { ZodSchema } from 'zod';

import {
  ProjectConfigSchema,
  SkillPackagingConfigSchema,
  SkillsConfigSchema,
} from '../../src/schemas/project-config.js';

const SKILL_GLOB_INCLUDE = 'skills/**/SKILL.md';

const VAT_DEV_AGENTS_CONFIG = fileURLToPath(
  new URL('../../../vat-development-agents/vibe-agent-toolkit.config.yaml', import.meta.url),
);

/** Assert that parsing `input` against `schema` fails with an `unrecognized_keys` Zod issue. */
function expectStrictRejection(schema: ZodSchema, input: unknown): void {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success) {
    const issue = result.error.issues.find((i) => i.code === 'unrecognized_keys');
    expect(issue).toBeDefined();
  }
}

describe('SkillPackagingConfigSchema', () => {
  it('parses validation.severity and validation.accept', () => {
    const result = SkillPackagingConfigSchema.safeParse({
      linkFollowDepth: 1,
      validation: {
        severity: { LINK_DROPPED_BY_DEPTH: 'error' },
        accept: {
          PACKAGED_UNREFERENCED_FILE: [{ paths: ['internal/*.json'], reason: 'runtime consumed' }],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects the removed ignoreValidationErrors field via strict mode', () => {
    expectStrictRejection(SkillPackagingConfigSchema, {
      ignoreValidationErrors: { SKILL_TOO_MANY_FILES: 'reason' },
    });
  });

  it('rejects unknown keys via strict mode', () => {
    expectStrictRejection(SkillPackagingConfigSchema, { unknownTypo: 123 });
  });
});

describe('SkillsConfigSchema', () => {
  it('accepts a minimal valid skills config', () => {
    const result = SkillsConfigSchema.safeParse({
      include: [SKILL_GLOB_INCLUDE],
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys at the skills level', () => {
    const result = SkillsConfigSchema.safeParse({
      include: [SKILL_GLOB_INCLUDE],
      bogusKey: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects nested ignoreValidationErrors under skills.config.<name>', () => {
    const result = SkillsConfigSchema.safeParse({
      include: [SKILL_GLOB_INCLUDE],
      config: {
        foo: {
          ignoreValidationErrors: { SKILL_TOO_MANY_FILES: 'reason' },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('ProjectConfigSchema', () => {
  it('accepts a minimal valid project config', () => {
    const result = ProjectConfigSchema.safeParse({ version: 1 });
    expect(result.success).toBe(true);
  });

  it('rejects unknown top-level keys', () => {
    const result = ProjectConfigSchema.safeParse({
      version: 1,
      bogusRoot: 'nope',
    });
    expect(result.success).toBe(false);
  });

  it('parses the vat-development-agents config from disk', async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only fixture path resolved from known monorepo location
    const content = await readFile(VAT_DEV_AGENTS_CONFIG, 'utf-8');
    const parsed = loadYaml(content);

    const result = ProjectConfigSchema.safeParse(parsed);
    if (!result.success) {
      const errors = result.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`vat-development-agents config failed to parse:\n${errors}`);
    }
    expect(result.success).toBe(true);
  });
});
