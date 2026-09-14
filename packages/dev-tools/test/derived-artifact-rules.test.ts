/**
 * Each derived-artifact rule is pointed at a fixture tree that violates it, so
 * the gate's "nothing found" on the real tree is known to mean "nothing wrong"
 * rather than "the rule cannot see". The real-tree cases at the end are what
 * the gate asserts; they run here too so a regression is a unit-test red
 * before it is a gate red.
 */

import { mkdirSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';
import {
  checkChangelogFragments,
  checkClaudeMdByteBudget,
  checkLockfileWorkspaceResolutions,
  checkNoStrayGeneratedMarkers,
  checkPackageScripts,
  checkTurboAdopterEdges,
  checkValidateWorkflowGenerated,
  CLAUDE_MD_BYTE_BUDGET,
  STANDARD_COMPILE,
  STANDARD_SCRIPTS,
} from '../src/derived-artifact-rules.js';

import { cleanupTestTempDir, createTestTempDir } from './test-helpers.js';

const SCOPE = '@vibe-agent-toolkit';

/** A minimal workspace: root manifest, one package, optional extras. */
function writeWorkspace(
  root: string,
  pkg: { dir: string; scripts: Record<string, string>; tests?: string[] },
  extras: Record<string, string> = {},
): void {
  const pkgDir = safePath.join(root, 'packages', pkg.dir);
  // eslint-disable-next-line local/no-fs-mkdirSync -- fixture path is a temp dir; realpath is not read back
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(safePath.join(root, 'package.json'), JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }));
  writeFileSync(safePath.join(pkgDir, 'package.json'), JSON.stringify({ name: `${SCOPE}/${pkg.dir}`, scripts: pkg.scripts }));
  writeFileSync(safePath.join(pkgDir, 'tsconfig.json'), '{}');
  for (const test of pkg.tests ?? []) {
    const file = safePath.join(pkgDir, 'test', test);
    // eslint-disable-next-line local/no-fs-mkdirSync -- fixture path is a temp dir; realpath is not read back
    mkdirSync(safePath.join(file, '..'), { recursive: true });
    writeFileSync(file, '');
  }
  for (const [rel, text] of Object.entries(extras)) {
    const file = safePath.join(root, rel);
    // eslint-disable-next-line local/no-fs-mkdirSync -- fixture path is a temp dir; realpath is not read back
    mkdirSync(safePath.join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  }
}

const GOOD_SCRIPTS = { build: STANDARD_COMPILE, typecheck: STANDARD_SCRIPTS.typecheck, clean: STANDARD_SCRIPTS.clean };

describe('derived-artifact rules on fixture trees', () => {
  let root: string;
  beforeEach(() => {
    root = createTestTempDir({ prefix: 'derived-rules-' });
  });
  afterEach(() => {
    cleanupTestTempDir(root);
  });

  describe('checkPackageScripts', () => {
    it('accepts the standard set with test scripts exactly where the tiers exist', () => {
      writeWorkspace(root, {
        dir: 'lib',
        scripts: { ...GOOD_SCRIPTS, 'test:unit': 'vitest run', 'test:watch': 'vitest', 'test:integration': STANDARD_SCRIPTS['test:integration'] },
        tests: ['a.test.ts', 'integration/b.integration.test.ts'],
      });

      expect(checkPackageScripts(root)).toEqual([]);
    });

    it('flags a build that bypasses the atomic-promotion compile', () => {
      writeWorkspace(root, { dir: 'lib', scripts: { ...GOOD_SCRIPTS, build: 'rimraf dist && tsc' } });

      const messages = checkPackageScripts(root).map((f) => f.message);
      expect(messages.some((m) => m.includes('must compile through'))).toBe(true);
      expect(messages.some((m) => m.includes('invokes `tsc` directly'))).toBe(true);
    });

    it('flags a missing tier script, an orphan tier script, a variant spelling, and a root-owned script', () => {
      writeWorkspace(root, {
        dir: 'lib',
        scripts: { ...GOOD_SCRIPTS, typecheck: 'tsc --build --dry', 'test:system': STANDARD_SCRIPTS['test:system'], lint: 'eslint .' },
        tests: ['a.test.ts'],
      });

      const messages = checkPackageScripts(root).map((f) => f.message);
      expect(messages).toEqual([
        expect.stringContaining('`typecheck` must be exactly "tsc --noEmit"'),
        expect.stringContaining('`test:unit` must be exactly'),
        expect.stringContaining('`test:watch` must be exactly'),
        expect.stringContaining('`test:system` is declared but the package has no matching test tier'),
        expect.stringContaining('`lint` is owned by the root'),
      ]);
    });

    it('ignores a package with no build script (the umbrella)', () => {
      writeWorkspace(root, { dir: 'umbrella', scripts: {} });

      expect(checkPackageScripts(root)).toEqual([]);
    });
  });

  describe('checkLockfileWorkspaceResolutions', () => {
    it('flags a workspace package the lockfile also resolves to a published version', () => {
      writeWorkspace(root, { dir: 'utils', scripts: GOOD_SCRIPTS }, {
        'bun.lock': [
          '"@vibe-agent-toolkit/utils": ["@vibe-agent-toolkit/utils@workspace:packages/utils", {}],',
          '"vibe-validate/@vibe-agent-toolkit/utils": ["@vibe-agent-toolkit/utils@0.1.42", "", {}, "sha512-x"],',
          '"@vibe-agent-toolkit/not-ours": ["@vibe-agent-toolkit/not-ours@1.0.0", "", {}, "sha512-y"],',
        ].join('\n'),
      });

      const findings = checkLockfileWorkspaceResolutions(root);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('@vibe-agent-toolkit/utils resolves to "0.1.42"');
    });
  });

  describe('checkClaudeMdByteBudget', () => {
    it('passes at the budget and fails one byte over, naming the overage', () => {
      writeWorkspace(root, { dir: 'x', scripts: GOOD_SCRIPTS }, { 'CLAUDE.md': 'a'.repeat(100) });

      expect(checkClaudeMdByteBudget(root, 100)).toEqual([]);
      expect(checkClaudeMdByteBudget(root, 99)[0]?.message).toContain('100 bytes, over the 99-byte budget by 1');
    });

    it('defaults to a 20 KiB budget', () => {
      expect(CLAUDE_MD_BYTE_BUDGET).toBe(20 * 1024);
    });
  });

  describe('checkChangelogFragments', () => {
    it('reports a malformed fragment by path and points at the README', () => {
      writeWorkspace(root, { dir: 'x', scripts: GOOD_SCRIPTS }, { '.changes/bad.md': '## [1.0.0]\n- x\n', '.changes/good.md': '### Fixed\n\n- y\n' });

      const findings = checkChangelogFragments(root);

      expect(findings.map((f) => f.path)).toEqual(['.changes/bad.md']);
      expect(findings[0]?.message).toContain('.changes/README.md');
    });
  });

  describe('checkTurboAdopterEdges', () => {
    const adopter = { dir: 'adopter', scripts: { ...GOOD_SCRIPTS, 'build:skills': 'node ../cli/dist/bin/vat.js skills build' } };

    it('flags a package that runs the CLI binary with no turbo edge on cli#build', () => {
      writeWorkspace(root, adopter, { 'turbo.json': '{ "tasks": { "build:skills": { "dependsOn": ["build"] } } }' });

      expect(checkTurboAdopterEdges(root).map((f) => f.path)).toEqual(['turbo.json']);
    });

    it('accepts a direct edge, and a transitive one through the package\'s own #build', () => {
      writeWorkspace(root, adopter, {
        'turbo.json': '{ "tasks": { "@vibe-agent-toolkit/adopter#build:skills": { "dependsOn": ["@vibe-agent-toolkit/cli#build", "build"] } } }',
      });
      expect(checkTurboAdopterEdges(root)).toEqual([]);

      writeFileSync(
        safePath.join(root, 'turbo.json'),
        '{ "tasks": { "build:skills": { "dependsOn": ["build"] }, "@vibe-agent-toolkit/adopter#build": { "dependsOn": ["@vibe-agent-toolkit/cli#build", "^build"] } } }',
      );
      expect(checkTurboAdopterEdges(root)).toEqual([]);
    });
  });
});

describe('derived-artifact rules on the real tree', () => {
  it.each([
    ['package scripts', checkPackageScripts],
    ['lockfile workspace resolutions', checkLockfileWorkspaceResolutions],
    ['validate.yml is generated', checkValidateWorkflowGenerated],
    ['turbo adopter edges', checkTurboAdopterEdges],
    ['changelog fragments', checkChangelogFragments],
  ])('%s: no findings', (_label, rule) => {
    expect(rule(PROJECT_ROOT)).toEqual([]);
  });
});

describe('checkNoStrayGeneratedMarkers', () => {
  const texts: Record<string, string> = {
    'CLAUDE.md': '<!-- gen:packages-tree -->\n<!-- /gen:packages-tree -->',
    'docs/plain.md': '# nothing generated here',
    'docs/pasted.md': 'a copy\n<!-- gen:packages-tree -->\nstale\n<!-- /gen:packages-tree -->',
    'docs/closer-only.md': '<!-- /gen:skills-table -->',
  };
  const read = (rel: string): string => texts[rel] ?? '';

  it('passes a registered document and a plain one', () => {
    expect(checkNoStrayGeneratedMarkers(PROJECT_ROOT, ['CLAUDE.md', 'docs/plain.md'], read)).toEqual([]);
  });

  it('fails an unregistered document carrying a marker — an opener or a lone closer', () => {
    const findings = checkNoStrayGeneratedMarkers(PROJECT_ROOT, Object.keys(texts), read);
    expect(findings.map((f) => f.path).sort((a, b) => a.localeCompare(b))).toEqual(['docs/closer-only.md', 'docs/pasted.md']);
    expect(findings[0]?.message).toContain('GENERATED_DOCUMENTS');
  });

  it('finds no stray marker in the real tree', () => {
    expect(checkNoStrayGeneratedMarkers(PROJECT_ROOT)).toEqual([]);
  });
});
