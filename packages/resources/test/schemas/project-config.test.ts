import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { ZodSchema } from 'zod';

import {
  ClaudeMarketplacePluginEntrySchema,
  ClaudeMarketplaceSchema,
  ProjectConfigSchema,
  SkillExecutableEntrySchema,
  SkillFileEntrySchema,
  SkillPackagingConfigSchema,
  SkillsConfigSchema,
  SkillTestGlobalConfigSchema,
  TestConfigSchema,
} from '../../src/schemas/project-config.js';
import type { SkillExecutableEntry, SkillFileEntry } from '../../src/schemas/project-config.js';

const SKILL_GLOB_INCLUDE = 'skills/**/SKILL.md';
const GRADER_MODEL = 'claude-sonnet-5';
const CSVSUM_PATH = 'scripts/csvsum.py';
const CSVSUM_HOW_INVOKED = 'uv run csvsum.py';

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

describe('SkillFileEntrySchema', () => {
  const BASE_SOURCE = 'dist/report.mjs';
  const BASE_DEST = 'report.mjs';

  it('parses a valid entry with integrity: true', () => {
    const result = SkillFileEntrySchema.safeParse({
      source: BASE_SOURCE,
      dest: BASE_DEST,
      integrity: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.integrity).toBe(true);
    }
  });

  it('parses a valid entry with integrity omitted (undefined)', () => {
    const result = SkillFileEntrySchema.safeParse({
      source: BASE_SOURCE,
      dest: BASE_DEST,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.integrity).toBeUndefined();
    }
  });

  it('rejects integrity: "yes" (wrong type — must be boolean)', () => {
    const result = SkillFileEntrySchema.safeParse({
      source: BASE_SOURCE,
      dest: BASE_DEST,
      integrity: 'yes',
    });
    expect(result.success).toBe(false);
  });

  it('type-level: SkillFileEntry accepts integrity?: boolean', () => {
    // compile-time check — if the type is wrong this file will not typecheck
    const entry: SkillFileEntry = { source: 'dist/a.mjs', dest: 'a.mjs', integrity: true };
    expect(entry.integrity).toBe(true);
  });

  // H1 — dest must be a contained relative path (zip-slip-class write-anywhere guard).
  it('accepts a nested relative dest', () => {
    const result = SkillFileEntrySchema.safeParse({ source: BASE_SOURCE, dest: 'a/b/c.mjs' });
    expect(result.success).toBe(true);
  });

  it('rejects a dest containing a ".." traversal segment', () => {
    for (const dest of ['../../../etc/x', '../escape.json', 'a/../../b']) {
      const result = SkillFileEntrySchema.safeParse({ source: BASE_SOURCE, dest });
      expect(result.success).toBe(false);
    }
  });

  it('rejects an absolute POSIX dest', () => {
    const result = SkillFileEntrySchema.safeParse({ source: BASE_SOURCE, dest: '/etc/passwd' });
    expect(result.success).toBe(false);
  });

  it('rejects a Windows drive-letter dest (host-independent)', () => {
    const result = SkillFileEntrySchema.safeParse({ source: BASE_SOURCE, dest: String.raw`C:\Users\evil` });
    expect(result.success).toBe(false);
  });
});

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

  it('parses executables[] with path, kind, and howInvoked', () => {
    const result = SkillPackagingConfigSchema.safeParse({
      executables: [
        { path: CSVSUM_PATH, kind: 'python', howInvoked: CSVSUM_HOW_INVOKED },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.executables?.[0]).toEqual({
        path: CSVSUM_PATH,
        kind: 'python',
        howInvoked: CSVSUM_HOW_INVOKED,
      });
    }
  });

  it('parses a config without executables (optional)', () => {
    const result = SkillPackagingConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.executables).toBeUndefined();
    }
  });

  it('rejects an executables entry with an unknown key (strict)', () => {
    const result = SkillPackagingConfigSchema.safeParse({
      executables: [
        { path: CSVSUM_PATH, kind: 'python', howInvoked: CSVSUM_HOW_INVOKED, bogus: true },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an executables entry with a bad kind enum value', () => {
    const result = SkillPackagingConfigSchema.safeParse({
      executables: [
        { path: CSVSUM_PATH, kind: 'ruby', howInvoked: 'ruby csvsum.rb' },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('SkillExecutableEntrySchema', () => {
  it('parses each supported kind', () => {
    for (const kind of ['node', 'python', 'shell', 'pwsh', 'binary'] as const) {
      const result = SkillExecutableEntrySchema.safeParse({
        path: 'bin/tool',
        kind,
        howInvoked: 'run it',
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an empty path', () => {
    const result = SkillExecutableEntrySchema.safeParse({
      path: '',
      kind: 'node',
      howInvoked: 'node dist/tool.mjs',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty howInvoked', () => {
    const result = SkillExecutableEntrySchema.safeParse({
      path: 'dist/tool.mjs',
      kind: 'node',
      howInvoked: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key via strict mode', () => {
    expectStrictRejection(SkillExecutableEntrySchema, {
      path: 'dist/tool.mjs',
      kind: 'node',
      howInvoked: 'node dist/tool.mjs',
      extra: 'nope',
    });
  });

  it('type-level: SkillExecutableEntry has path/kind/howInvoked', () => {
    // compile-time check — if the type is wrong this file will not typecheck
    const entry: SkillExecutableEntry = {
      path: 'scripts/csvsum.py',
      kind: 'python',
      howInvoked: 'uv run csvsum.py',
    };
    expect(entry.kind).toBe('python');
  });
});

describe('TestConfigSchema', () => {
  it('accepts an empty test config (all fields optional)', () => {
    const result = TestConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a build: command string', () => {
    const result = TestConfigSchema.safeParse({ build: 'pnpm bundle:report' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.build).toBe('pnpm bundle:report');
    }
  });

  it('rejects an empty build: string (min 1 char)', () => {
    const result = TestConfigSchema.safeParse({ build: '' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys via strict mode', () => {
    const result = TestConfigSchema.safeParse({ unknownField: true });
    expect(result.success).toBe(false);
  });

  it('rejects graderModel — the global grader is deliberately kept out of the per-skill schema (issue #145)', () => {
    const result = TestConfigSchema.safeParse({ graderModel: GRADER_MODEL });
    expect(result.success).toBe(false);
  });
});

describe('SkillTestGlobalConfigSchema', () => {
  it('accepts an empty global test config (all fields optional)', () => {
    const result = SkillTestGlobalConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('parses graderModel + concurrency', () => {
    const result = SkillTestGlobalConfigSchema.safeParse({
      graderModel: GRADER_MODEL,
      concurrency: 4,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.graderModel).toBe(GRADER_MODEL);
      expect(result.data.concurrency).toBe(4);
    }
  });

  it('rejects an unknown key via strict mode', () => {
    expectStrictRejection(SkillTestGlobalConfigSchema, { bogus: true });
  });

  it('rejects a non-positive concurrency', () => {
    const result = SkillTestGlobalConfigSchema.safeParse({ concurrency: 0 });
    expect(result.success).toBe(false);
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

  it('parses a top-level test: { graderModel, concurrency } node', () => {
    const result = ProjectConfigSchema.safeParse({
      version: 1,
      test: { graderModel: GRADER_MODEL, concurrency: 4 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.test).toEqual({ graderModel: GRADER_MODEL, concurrency: 4 });
    }
  });

  it('rejects an unknown key under the top-level test node (strict)', () => {
    expectStrictRejection(ProjectConfigSchema, {
      version: 1,
      test: { graderModel: GRADER_MODEL, bogus: true },
    });
  });

  it('parses the vat-development-agents config from disk', async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only fixture path resolved from known monorepo location
    const content = await readFile(VAT_DEV_AGENTS_CONFIG, 'utf-8');
    const parsed = parseYaml(content);

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
  it('accepts plugin with skills: "*"', () => {
    const result = ClaudeMarketplacePluginEntrySchema.safeParse({
      name: 'my-plugin',
      skills: '*',
    });
    expect(result.success).toBe(true);
  });

  it('accepts plugin with skills: [names]', () => {
    const result = ClaudeMarketplacePluginEntrySchema.safeParse({
      name: 'my-plugin',
      skills: ['foo', 'bar*', '*baz'],
    });
    expect(result.success).toBe(true);
  });

  it('requires skills field on plugin entry', () => {
    const result = ClaudeMarketplacePluginEntrySchema.safeParse({ name: 'my-plugin' });
    expect(result.success).toBe(false);
  });

  it('accepts plugin with name regex conforming (lowercase alnum + hyphens)', () => {
    for (const name of ['foo', 'foo-bar', 'a1', 'p1-p2-p3']) {
      const result = ClaudeMarketplacePluginEntrySchema.safeParse({ name, skills: '*' });
      expect(result.success).toBe(true);
    }
  });

  it('rejects plugin name with uppercase or invalid chars', () => {
    for (const name of ['Foo', 'foo_bar', 'foo.bar', '-foo', 'foo!', '']) {
      const result = ClaudeMarketplacePluginEntrySchema.safeParse({ name, skills: '*' });
      expect(result.success).toBe(false);
    }
  });

  it('accepts optional source path', () => {
    const result = ClaudeMarketplacePluginEntrySchema.safeParse({
      name: 'p',
      skills: '*',
      source: 'custom/dir',
    });
    expect(result.success).toBe(true);
  });

  it('accepts files[] with source+dest entries', () => {
    const result = ClaudeMarketplacePluginEntrySchema.safeParse({
      name: 'p',
      skills: [],
      files: [{ source: 'dist/hooks/h.mjs', dest: 'hooks/h.mjs' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown top-level keys (strict)', () => {
    const result = ClaudeMarketplacePluginEntrySchema.safeParse({
      name: 'p',
      skills: '*',
      bogus: true,
    });
    expect(result.success).toBe(false);
  });

  describe('version field', () => {
    it('accepts a valid semver version', () => {
      const result = ClaudeMarketplacePluginEntrySchema.safeParse({
        name: 'p',
        skills: '*',
        version: '0.2.0',
      });
      expect(result.success).toBe(true);
    });

    it('accepts a prerelease semver version', () => {
      const result = ClaudeMarketplacePluginEntrySchema.safeParse({
        name: 'p',
        skills: '*',
        version: '1.0.0-rc.1',
      });
      expect(result.success).toBe(true);
    });

    it('accepts an entry without version (backwards compat)', () => {
      const result = ClaudeMarketplacePluginEntrySchema.safeParse({
        name: 'p',
        skills: '*',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.version).toBeUndefined();
      }
    });

    it('rejects a non-semver version string', () => {
      for (const version of ['not-a-version', '1.2', '1', 'latest', '']) {
        const result = ClaudeMarketplacePluginEntrySchema.safeParse({
          name: 'p',
          skills: '*',
          version,
        });
        expect(result.success).toBe(false);
      }
    });
  });

  describe('changelog field', () => {
    it('accepts a relative changelog path', () => {
      const result = ClaudeMarketplacePluginEntrySchema.safeParse({
        name: 'p',
        skills: '*',
        changelog: 'CHANGELOG.md',
      });
      expect(result.success).toBe(true);
    });

    it('accepts a nested relative changelog path', () => {
      const result = ClaudeMarketplacePluginEntrySchema.safeParse({
        name: 'p',
        skills: '*',
        changelog: 'docs/CHANGELOG.md',
      });
      expect(result.success).toBe(true);
    });

    it('leaves changelog undefined when not declared', () => {
      const result = ClaudeMarketplacePluginEntrySchema.safeParse({
        name: 'p',
        skills: '*',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.changelog).toBeUndefined();
      }
    });
  });
});

describe('ClaudeMarketplaceSchema (pool filter)', () => {
  it('accepts top-level skills: "*"', () => {
    const result = ClaudeMarketplaceSchema.safeParse({
      owner: { name: 'Test Org' },
      skills: '*',
      plugins: [{ name: 'test', skills: '*' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts top-level skills: [names]', () => {
    const result = ClaudeMarketplaceSchema.safeParse({
      owner: { name: 'Test Org' },
      skills: ['foo*'],
      plugins: [{ name: 'test', skills: '*' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts marketplace without skills filter (allows all)', () => {
    const result = ClaudeMarketplaceSchema.safeParse({
      owner: { name: 'Test Org' },
      plugins: [{ name: 'test', skills: '*' }],
    });
    expect(result.success).toBe(true);
  });
});
