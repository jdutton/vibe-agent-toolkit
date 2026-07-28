/**
 * Synthetic-fixture builder for {@link resolveSkillReference} tests.
 *
 * Fabricates a throwaway temp project that declares pool skills (via
 * `skills.include`) and/or plugin-local tree-copy skills (via a marketplace
 * plugin whose `plugins/<plug>/skills/<name>/SKILL.md` exists on disk). The
 * shapes mirror production — never a real adopter skill.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- test helper builds synthetic fixtures at dynamic temp paths */
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { computeTreeCopiedSkillLocations } from '@vibe-agent-toolkit/agent-skills';
import type { SkillFileEntry } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'yaml';

import { createTestTempDir } from '../system/test-common.js';

const MARKETPLACE_NAME = 'fixture-mp';
const PLUGIN_NAME = 'fixture-plug';

/** A persisted `skills.config.<name>.test` block (subset used by fixtures). */
export interface PoolTestBlock {
  evals?: string;
  model?: string;
  timeout?: number;
  /** Pre-stage `test.build` shell hook — runs with the DECLARING config's root as cwd. */
  build?: string;
}

/**
 * A NESTED sub-project: its own `vibe-agent-toolkit.config.yaml` under `<root>/<dir>`,
 * declaring its own pool skills. Mirrors a monorepo package with a package-level VAT
 * config — the shape that proves per-skill config lookups resolve against the config
 * that GOVERNS a skill rather than the outer/subject one.
 */
export interface NestedProjectSpec {
  /** Sub-directory (relative to the fixture root) that becomes the nested config root. */
  dir: string;
  pool: string[];
  poolTest?: Record<string, PoolTestBlock>;
  /** Optional per-skill `skills.config.<name>.files` blocks (keyed by skill name). */
  skillFiles?: Record<string, SkillFileEntry[]>;
  /**
   * Path (relative to THIS nested project's root — the config root a `files:`
   * `source` resolves against) → file content, written to disk before the
   * nested config so a `files:` `source` genuinely resolves.
   */
  sourceFiles?: Record<string, string>;
}

export interface ReferenceFixtureSpec {
  /** Pool skills declared via `skills.include`, built to `dist/skills/<name>`. */
  pool?: string[];
  /** Plugin-local tree-copy skills under `plugins/<plug>/skills/<name>`. */
  pluginLocal?: string[];
  /** Optional per-skill `skills.config.<name>.test` blocks (for test-config resolution tests). */
  poolTest?: Record<string, PoolTestBlock>;
  /**
   * Optional per-skill `skills.config.<name>.files` blocks, keyed by skill NAME —
   * applies to pool AND plugin-local skills alike (one field, not two).
   */
  skillFiles?: Record<string, SkillFileEntry[]>;
  /**
   * Path (relative to the fixture root — the project root a `files:` `source`
   * resolves against) → file content, written to disk before the config so a
   * `files:` `source` genuinely resolves.
   */
  sourceFiles?: Record<string, string>;
  /** Optional second config root nested inside this one. */
  nested?: NestedProjectSpec;
}

/** Accessors for a fixture's {@link NestedProjectSpec} (absent when none was declared). */
export interface NestedProjectFixture {
  /** Absolute path of the nested config root (where its config.yaml lives). */
  root: string;
  /** Authored source DIR of a nested pool skill (the `path:` a companion would use). */
  skillDir: (name: string) => string;
  /** Absolute path of a declared `sourceFiles` entry (relative to THIS nested root). */
  sourceFilePath: (relPath: string) => string;
}

export interface ReferenceFixture {
  root: string;
  poolSkillMd: (name: string) => string;
  poolDistDir: (name: string) => string;
  /** Authored SKILL.md of a plugin-local skill (its dirname is the build INPUT dir). */
  pluginSkillMd: (name: string) => string;
  pluginDistDir: (name: string) => string;
  /** Absolute path of a declared `sourceFiles` entry (relative to the fixture root). */
  sourceFilePath: (relPath: string) => string;
  /** Set only when the spec declared a {@link NestedProjectSpec}. */
  nested?: NestedProjectFixture;
}

/** Bind a `sourceFiles` relative-path key to an absolute path under `root`. */
function makeSourceFilePathAccessor(root: string): (relPath: string) => string {
  return (relPath: string) => safePath.join(root, relPath);
}

function writeSkillMd(skillDir: string, name: string): void {
  mkdirSyncReal(skillDir, { recursive: true });
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Synthetic ${name} fixture skill for reference-resolution tests.\n---\n\n# ${name}\n\nSynthetic body.\n`,
  );
}

/**
 * Merge `poolTest` and `skillFiles` into one `skills.config.<name>` block per
 * skill name — a skill declared in BOTH must end up with a single object
 * carrying both `test:` and `files:`, never two blocks or a clobbered one.
 */
function buildSkillsConfig(
  poolTest: Record<string, PoolTestBlock> | undefined,
  skillFiles: Record<string, SkillFileEntry[]> | undefined,
): Record<string, unknown> | undefined {
  const names = new Set([...Object.keys(poolTest ?? {}), ...Object.keys(skillFiles ?? {})]);
  if (names.size === 0) return undefined;

  const config: Record<string, unknown> = {};
  for (const name of names) {
    const entry: Record<string, unknown> = {};
    const test = poolTest?.[name];
    if (test !== undefined) entry.test = test;
    const files = skillFiles?.[name];
    if (files !== undefined) entry.files = files;
    config[name] = entry;
  }
  return config;
}

function buildConfigYaml(spec: ReferenceFixtureSpec): string {
  const include: string[] = [];
  if (spec.pool && spec.pool.length > 0) include.push('skills/*/SKILL.md');
  if (spec.pluginLocal && spec.pluginLocal.length > 0) {
    include.push(`plugins/${PLUGIN_NAME}/skills/*/SKILL.md`);
  }

  const config: Record<string, unknown> = { version: 1 };
  if (include.length > 0) {
    const skills: Record<string, unknown> = { include };
    const skillsConfig = buildSkillsConfig(spec.poolTest, spec.skillFiles);
    if (skillsConfig !== undefined) skills.config = skillsConfig;
    config.skills = skills;
  }
  if (spec.pluginLocal && spec.pluginLocal.length > 0) {
    config.claude = {
      marketplaces: {
        [MARKETPLACE_NAME]: {
          owner: { name: 'Fixture Owner' },
          plugins: [
            {
              name: PLUGIN_NAME,
              description: 'Synthetic plugin for reference-resolution tests.',
              source: `plugins/${PLUGIN_NAME}`,
              skills: [],
            },
          ],
        },
      },
    };
  }
  return yaml.stringify(config);
}

/** Write declared `sourceFiles` (relative to `root`) to disk BEFORE the config that references them. */
function writeSourceFiles(root: string, sourceFiles: Record<string, string> | undefined): void {
  for (const [relPath, content] of Object.entries(sourceFiles ?? {})) {
    const absPath = safePath.join(root, relPath);
    mkdirSyncReal(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content);
  }
}

/** Write a project root: its pool skills plus the `vibe-agent-toolkit.config.yaml` that declares them. */
function writePoolProject(root: string, spec: ReferenceFixtureSpec): void {
  mkdirSyncReal(root, { recursive: true });
  for (const name of spec.pool ?? []) {
    writeSkillMd(safePath.join(root, 'skills', name), name);
  }
  writeSourceFiles(root, spec.sourceFiles);
  writeFileSync(safePath.join(root, 'vibe-agent-toolkit.config.yaml'), buildConfigYaml(spec));
}

/** Write the marketplace plugin tree (manifest + skills) the plugin-local arm needs. */
function writePluginTree(root: string, pluginLocal: string[]): void {
  const pluginRoot = safePath.join(root, 'plugins', PLUGIN_NAME);
  mkdirSyncReal(safePath.join(pluginRoot, '.claude-plugin'), { recursive: true });
  writeFileSync(
    safePath.join(pluginRoot, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify(
      { name: PLUGIN_NAME, version: '0.1.0', description: 'Synthetic fixture plugin.', license: 'MIT' },
      null,
      2,
    )}\n`,
  );
  for (const name of pluginLocal) {
    writeSkillMd(safePath.join(pluginRoot, 'skills', name), name);
  }
}

/** Materialize a {@link NestedProjectSpec} as a second, self-governing config root. */
function setupNestedProject(root: string, nested: NestedProjectSpec): NestedProjectFixture {
  const nestedRoot = safePath.join(root, nested.dir);
  writePoolProject(nestedRoot, {
    pool: nested.pool,
    ...(nested.poolTest === undefined ? {} : { poolTest: nested.poolTest }),
    ...(nested.skillFiles === undefined ? {} : { skillFiles: nested.skillFiles }),
    ...(nested.sourceFiles === undefined ? {} : { sourceFiles: nested.sourceFiles }),
  });
  return {
    root: nestedRoot,
    skillDir: (name) => safePath.join(nestedRoot, 'skills', name),
    sourceFilePath: makeSourceFilePathAccessor(nestedRoot),
  };
}

export function setupReferenceFixture(spec: ReferenceFixtureSpec): ReferenceFixture {
  const root = safePath.resolve(createTestTempDir('vat-skill-ref-'));

  if (spec.pluginLocal && spec.pluginLocal.length > 0) {
    writePluginTree(root, spec.pluginLocal);
  }
  writePoolProject(root, spec);

  return {
    root,
    ...(spec.nested === undefined ? {} : { nested: setupNestedProject(root, spec.nested) }),
    poolSkillMd: (name) => safePath.resolve(root, 'skills', name, 'SKILL.md'),
    poolDistDir: (name) => safePath.join(root, 'dist', 'skills', name),
    pluginSkillMd: (name) => safePath.resolve(root, 'plugins', PLUGIN_NAME, 'skills', name, 'SKILL.md'),
    sourceFilePath: makeSourceFilePathAccessor(root),
    pluginDistDir: (name) => {
      const location = computeTreeCopiedSkillLocations(loadFixtureConfig(spec), root).find(
        (loc) => loc.skillDirName === name,
      );
      if (location === undefined) {
        throw new Error(`fixture has no plugin-local location for '${name}'`);
      }
      return location.skillOutputDir;
    },
  };
}

/** Minimal config object mirroring the YAML, for {@link computeTreeCopiedSkillLocations}. */
function loadFixtureConfig(spec: ReferenceFixtureSpec): Parameters<typeof computeTreeCopiedSkillLocations>[0] {
  if (!spec.pluginLocal || spec.pluginLocal.length === 0) {
    return { claude: { marketplaces: {} } } as never;
  }
  return {
    claude: {
      marketplaces: {
        [MARKETPLACE_NAME]: {
          owner: { name: 'Fixture Owner' },
          plugins: [{ name: PLUGIN_NAME, source: `plugins/${PLUGIN_NAME}` }],
        },
      },
    },
  } as never;
}
