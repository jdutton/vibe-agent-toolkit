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

import type { TurboTask } from '../src/built-output-edges.js';
import { PROJECT_ROOT } from '../src/common.js';
import {
  checkBuiltOutputEdges,
  checkChangelogFragments,
  checkClaudeMdByteBudget,
  checkLockfileWorkspaceResolutions,
  checkNoStrayGeneratedMarkers,
  checkPackageScripts,
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

// `alpha`, `beta` and `gamma` are not packages of this repository: the fixture
// sources below name them, and the same scan run over this file ignores them.
const ALPHA_BUILD = `${SCOPE}/alpha#build`;
const ALPHA_SKILLS = `${SCOPE}/alpha#build:skills`;
const BETA_BUILD = `${SCOPE}/beta#build`;
const BETA_SYSTEM = `${SCOPE}/beta#test:system`;
const BETA_UNIT = `${SCOPE}/beta#test:unit`;
const SYSTEM_TEST = 'packages/beta/test/system/runs-alpha.system.test.ts';
const RUNS_ALPHA = "spawn(NODE, [safePath.resolve(here, '../../../alpha/dist/bin.js')]);";

/** One node of turbo's dry-run graph. */
function task(id: string, dependencies: string[] = [], outputs: string[] = [], command = 'run'): [string, TurboTask] {
  const [pkg = '', name = ''] = id.split('#');
  return [id, { package: pkg, task: name, command, dependencies, outputs }];
}

/** turbo's graph with beta's tiers ordering only beta's own build — not alpha's. */
function unordered(): Map<string, TurboTask> {
  return new Map([
    task(ALPHA_BUILD, [], ['dist/**', '*.tsbuildinfo']),
    task(ALPHA_SKILLS, [ALPHA_BUILD], ['dist/skills/**']),
    task(BETA_BUILD, [], ['dist/**']),
    task(BETA_SYSTEM, [BETA_BUILD]),
    task(BETA_UNIT, [BETA_BUILD]),
  ]);
}

/** Workspace of alpha, beta and gamma; `files` maps a repo-relative path to its text. Returns the paths. */
function writeAlphaBetaWorkspace(root: string, files: Record<string, string>, betaScripts: Record<string, string> = GOOD_SCRIPTS): string[] {
  writeWorkspace(root, { dir: 'alpha', scripts: GOOD_SCRIPTS });
  writeWorkspace(root, { dir: 'gamma', scripts: GOOD_SCRIPTS });
  writeWorkspace(root, { dir: 'beta', scripts: betaScripts }, files);
  return Object.keys(files);
}

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

  describe('checkBuiltOutputEdges', () => {
    const workspaceWith = (files: Record<string, string>, betaScripts?: Record<string, string>): string[] =>
      writeAlphaBetaWorkspace(root, files, betaScripts);
    const firstWords = (findings: ReturnType<typeof checkBuiltOutputEdges>): string[][] =>
      findings.map((f) => [f.path, f.message.split(' ')[0] ?? '']);
    /** The one finding a system test reading `source` draws against the unordered graph. */
    const soleSystemTestFinding = (source: string): string => {
      const findings = checkBuiltOutputEdges(root, unordered(), workspaceWith({ [SYSTEM_TEST]: source }));
      expect(findings.map((f) => f.path)).toEqual([SYSTEM_TEST]);
      return findings[0]?.message ?? '';
    };

    it('flags a test reading a sibling build that turbo does not order, naming reader and producer', () => {
      expect(soleSystemTestFinding(RUNS_ALPHA)).toContain(`${BETA_SYSTEM} reads ${SCOPE}/alpha's dist/bin.js, which ${ALPHA_BUILD} produces`);
    });

    it('accepts a reach turbo orders, directly or through another task', () => {
      const files = workspaceWith({ [SYSTEM_TEST]: RUNS_ALPHA });
      const direct = unordered().set(...task(BETA_SYSTEM, [BETA_BUILD, ALPHA_BUILD]));
      const transitive = unordered().set(...task(BETA_BUILD, [ALPHA_BUILD], ['dist/**']));

      expect(checkBuiltOutputEdges(root, direct, files)).toEqual([]);
      expect(checkBuiltOutputEdges(root, transitive, files)).toEqual([]);
    });

    it('demands the task whose outputs cover the path most specifically, and fails a path no task produces', () => {
      const files = workspaceWith({
        [SYSTEM_TEST]: "safePath.join(root, 'packages', 'alpha', 'dist', 'skills');",
        'packages/beta/test/reads-alpha-docs.test.ts': "safePath.join(root, 'packages', 'alpha', 'docs');\nsafePath.join(here, '..', 'alpha', 'distant');",
      });
      const orderedBuild = unordered().set(...task(BETA_SYSTEM, [ALPHA_BUILD]));
      const noOutputs = unordered().set(...task(ALPHA_BUILD)).set(...task(ALPHA_SKILLS));

      const demanded = checkBuiltOutputEdges(root, orderedBuild, files);
      expect(demanded.map((f) => f.path)).toEqual([SYSTEM_TEST]);
      expect(demanded[0]?.message).toContain(`which ${ALPHA_SKILLS} produces`);
      expect(checkBuiltOutputEdges(root, noOutputs, files)[0]?.message).toContain(`no turbo task of ${SCOPE}/alpha declares an output covering it`);
    });

    it('attributes a helper\'s reach to every tier of every test that imports it, in any package', () => {
      const files = workspaceWith({
        'packages/beta/test/helpers/alpha-bin.ts': "export const BIN = safePath.resolve(here, '../../../alpha/dist/bin.js');",
        [SYSTEM_TEST]: "import { BIN } from '../helpers/alpha-bin.js';",
        'packages/beta/test/uses.test.ts': "import './helpers/alpha-bin.js';",
        'packages/gamma/test/cross.test.ts': "import { BIN } from '../../beta/test/helpers/alpha-bin.js';",
        'packages/beta/test/unrelated.test.ts': 'expect(1).toBe(1);',
      });
      const graph = unordered().set(...task(`${SCOPE}/gamma#test:unit`));

      expect(firstWords(checkBuiltOutputEdges(root, graph, files))).toEqual([
        ['packages/beta/test/helpers/alpha-bin.ts', BETA_SYSTEM],
        ['packages/beta/test/helpers/alpha-bin.ts', BETA_UNIT],
        ['packages/beta/test/helpers/alpha-bin.ts', `${SCOPE}/gamma#test:unit`],
      ]);
    });

    it('fails a test in a tier its package has no task for, rather than passing it', () => {
      const files = workspaceWith({ 'packages/beta/test/integration/x.integration.test.ts': 'expect(1).toBe(1);' });

      expect(checkBuiltOutputEdges(root, unordered(), files)[0]?.message).toContain(`no ${SCOPE}/beta#test:integration task`);
    });

    it('fails a dist path whose package segment is not static', () => {
      const message = soleSystemTestFinding("const PACKAGES = safePath.join(ROOT, '..');\nsafePath.join(PACKAGES, bundle.pkg, 'dist', 'skills');");

      expect(message).toContain("`safePath.join(PACKAGES, bundle.pkg, 'dist', 'skills')`");
      expect(message).toContain('not static');
    });

    it('attributes a script to the turbo task that runs it, and fails one no task runs', () => {
      const scripts = {
        ...GOOD_SCRIPTS,
        build: 'bun run build:code',
        'build:code': 'node ../alpha/dist/bin/vat.js build',
        'build:skills': 'node ../alpha/dist/bin/vat.js skills build',
        vat: 'node ../alpha/dist/bin/vat.js',
      };
      const files = workspaceWith({ 'packages/beta/test/plain.test.ts': 'expect(1).toBe(1);' }, scripts);
      const graph = unordered()
        .set(...task(BETA_BUILD, [], ['dist/**'], scripts.build))
        .set(...task(`${SCOPE}/beta#build:skills`, [BETA_BUILD], [], scripts['build:skills']));

      expect(firstWords(checkBuiltOutputEdges(root, graph, files))).toEqual([
        ['packages/beta/package.json (script "build:code")', BETA_BUILD],
        ['packages/beta/package.json (script "build:skills")', `${SCOPE}/beta#build:skills`],
        ['packages/beta/package.json (script "vat")', 'reads'],
      ]);
    });
  });
});

describe('derived-artifact rules on the real tree', () => {
  it.each([
    ['package scripts', checkPackageScripts],
    ['lockfile workspace resolutions', checkLockfileWorkspaceResolutions],
    ['validate.yml is generated', checkValidateWorkflowGenerated],
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
