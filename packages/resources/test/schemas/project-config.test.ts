import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import type { ZodSchema } from 'zod';

import {
  ClaudeMarketplacePluginEntrySchema,
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
  it('parses validation.severity and validation.allow', () => {
    const result = SkillPackagingConfigSchema.safeParse({
      linkFollowDepth: 1,
      validation: {
        severity: { LINK_DROPPED_BY_DEPTH: 'error' },
        allow: {
          PACKAGED_UNREFERENCED_FILE: [{ paths: ['internal/*.json'], reason: 'runtime consumed' }],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('allows validation.allow entries without explicit paths (defaults to ["**/*"])', () => {
    const result = SkillPackagingConfigSchema.safeParse({
      validation: {
        allow: {
          SKILL_LENGTH_EXCEEDS_RECOMMENDED: [{ reason: 'whole-skill concern' }],
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.data.validation?.allow?.SKILL_LENGTH_EXCEEDS_RECOMMENDED?.[0];
      expect(entry?.paths).toEqual(['**/*']);
    }
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

describe('ClaudeMarketplacePluginEntrySchema (full plugin support)', () => {
  it('accepts plugin with only name (no skills, no source, no files)', () => {
    // Schema-level: `{ name: 'x' }` alone is valid — an author may declare the plugin
    // and then supply content via a plugins/<name>/ dir on disk. Build-time emptiness
    // (no dir, no skills, no files) is enforced in Task 9's `buildPlugin()` guard,
    // NOT here.
    const result = ClaudeMarketplacePluginEntrySchema.safeParse({ name: 'my-plugin' });
    expect(result.success).toBe(true);
  });

  it('accepts plugin with name regex conforming (lowercase alnum + hyphens)', () => {
    for (const name of ['foo', 'foo-bar', 'a1', 'p1-p2-p3']) {
      const result = ClaudeMarketplacePluginEntrySchema.safeParse({ name });
      expect(result.success).toBe(true);
    }
  });

  it('rejects plugin name with uppercase or invalid chars', () => {
    for (const name of ['Foo', 'foo_bar', 'foo.bar', '-foo', 'foo!', '']) {
      const result = ClaudeMarketplacePluginEntrySchema.safeParse({ name });
      expect(result.success).toBe(false);
    }
  });

  it('normalizes skills: [] to absent', () => {
    const result = ClaudeMarketplacePluginEntrySchema.safeParse({ name: 'p', skills: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.skills).toBeUndefined();
    }
  });

  it('accepts skills: "*" and skills: [names]', () => {
    expect(ClaudeMarketplacePluginEntrySchema.safeParse({ name: 'p', skills: '*' }).success).toBe(true);
    expect(ClaudeMarketplacePluginEntrySchema.safeParse({ name: 'p', skills: ['a', 'b'] }).success).toBe(true);
  });

  it('accepts optional source path', () => {
    const result = ClaudeMarketplacePluginEntrySchema.safeParse({
      name: 'p',
      source: 'custom/dir',
    });
    expect(result.success).toBe(true);
  });

  it('accepts files[] with source+dest entries', () => {
    const result = ClaudeMarketplacePluginEntrySchema.safeParse({
      name: 'p',
      files: [{ source: 'dist/hooks/h.mjs', dest: 'hooks/h.mjs' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const result = ClaudeMarketplacePluginEntrySchema.safeParse({
      name: 'p',
      bogus: true,
    });
    expect(result.success).toBe(false);
  });
});
