/**
 * Regression harness for the build race that made turbo builds fail intermittently
 * with `ERR_MODULE_NOT_FOUND` / "does not provide an export named X" on a *different*
 * package and symbol each run.
 *
 * The property under test is the one that actually matters to a concurrent reader:
 * **a package's `dist/` is never observably incomplete while it is being rebuilt.**
 * Turbo's dependency graph is not enough on its own — an undeclared edge, a
 * `tsc --build` reaching through project references, or a script that imports a
 * workspace `dist` all put a reader next to a writer. If a rebuild only ever
 * overwrites complete files, none of those degrade into a crash.
 *
 * This is deliberately a *structural* sampler rather than a "run it N times and
 * hope for the flake": it rebuilds a fixture package while polling the barrel that
 * a concurrent consumer would import, and fails on the first sample that is missing
 * or missing its export.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { delimiter } from 'node:path';

import { setupSyncTempDirSuite, safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

/* eslint-disable security/detect-non-literal-fs-filename -- fixture paths under a temp dir */

const TSC_CLEAN_BUILD = safePath.resolve(import.meta.dirname, '../../src/tsc-clean-build.ts');
/** The fixture lives outside the repo, so `tsc` has to be put on its PATH explicitly. */
const REPO_BIN = safePath.resolve(import.meta.dirname, '../../../../node_modules/.bin');

/** The export a concurrent consumer of the fixture would import through the barrel. */
const BARREL_EXPORT = 'assembleFixtureArgs';

interface Fixture {
  root: string;
  barrel: string;
}

function writeFixture(root: string): Fixture {
  const srcDir = safePath.join(root, 'src');
  fs.mkdirSync(srcDir, { recursive: true });

  fs.writeFileSync(
    safePath.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        composite: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        outDir: './dist',
        rootDir: './src',
        types: [],
      },
      include: ['src/**/*'],
    }),
  );
  fs.writeFileSync(
    safePath.join(root, 'package.json'),
    JSON.stringify({ name: 'dist-visibility-fixture', type: 'module', version: '0.0.0' }),
  );

  // Several modules so the emit takes long enough to sample, and so the barrel
  // re-exports through a deeper module — the exact shape of the observed failures
  // (`utils/dist/index.js` -> `./skill-test/spawn-claude.js`).
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(
      safePath.join(srcDir, `module-${index}.ts`),
      `export const value${index} = ${index};\n`,
    );
  }
  fs.writeFileSync(
    safePath.join(srcDir, 'spawn-fixture.ts'),
    `export function ${BARREL_EXPORT}(args: string[]): string[] {\n  return [...args];\n}\n`,
  );
  fs.writeFileSync(
    safePath.join(srcDir, 'index.ts'),
    [
      `export { ${BARREL_EXPORT} } from './spawn-fixture.js';`,
      ...Array.from({ length: 12 }, (_, index) => `export { value${index} } from './module-${index}.js';`),
    ].join('\n') + '\n',
  );

  return { root, barrel: safePath.join(root, 'dist', 'index.js') };
}

function runBuild(root: string): ReturnType<typeof spawn> {
  const isWindows = process.platform === 'win32';
  const tsx = safePath.join(REPO_BIN, isWindows ? 'tsx.cmd' : 'tsx');
  return spawn(tsx, [TSC_CLEAN_BUILD], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: isWindows,
    env: { ...process.env, PATH: `${REPO_BIN}${delimiter}${process.env['PATH'] ?? ''}` },
  });
}

async function buildOnce(root: string): Promise<void> {
  const child = runBuild(root);
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`build exited ${String(code)}`)),
    );
  });
}

type Observation = 'ok' | 'missing' | 'partial';

function observe(barrel: string): Observation {
  let contents: string;
  try {
    contents = fs.readFileSync(barrel, 'utf8');
  } catch {
    return 'missing';
  }
  return contents.includes(BARREL_EXPORT) ? 'ok' : 'partial';
}

/**
 * Rebuilds the fixture while sampling its barrel as tightly as the event loop allows.
 * Returns every non-`ok` observation seen between the moment the rebuild started and
 * the moment it exited.
 */
async function sampleDuringRebuild(fixture: Fixture): Promise<Observation[]> {
  const violations: Observation[] = [];
  const child = runBuild(fixture.root);
  let running = true;
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', (error) => {
      running = false;
      reject(error);
    });
    child.on('exit', () => {
      running = false;
      resolve();
    });
  });

  while (running) {
    const seen = observe(fixture.barrel);
    if (seen !== 'ok') violations.push(seen);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await exited;

  // The build must still have produced a usable barrel.
  expect(observe(fixture.barrel)).toBe('ok');
  return violations;
}

describe('dist visibility during a rebuild', () => {
  const suite = setupSyncTempDirSuite('dist-visibility');
  let fixture: Fixture;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    fixture = writeFixture(suite.getTempDir());
  });

  it('never exposes a missing or partial barrel while the package is rebuilt', async () => {
    await buildOnce(fixture.root);
    expect(observe(fixture.barrel)).toBe('ok');

    const violations = await sampleDuringRebuild(fixture);

    expect(violations).toEqual([]);
  }, 120_000);

  it('never exposes a missing or partial barrel while a changed package is rebuilt', async () => {
    await buildOnce(fixture.root);
    fs.writeFileSync(
      safePath.join(fixture.root, 'src', 'module-0.ts'),
      'export const value0 = 100;\n',
    );

    const violations = await sampleDuringRebuild(fixture);

    expect(violations).toEqual([]);
  }, 120_000);
});
