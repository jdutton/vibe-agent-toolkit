import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as yaml from 'yaml';

import { corpusScanCommand } from '../../src/commands/corpus/scan.js';
import { commitTestFixture } from '../test-helpers.js';

const META = {
  bucket: 'official',
  confidence: 'first-party',
  maturity: 'production',
} as const;

let workspace: string;
let seedPath: string;
let outDir: string;

function makeSkill(dir: string, descriptionWords: string): void {
  mkdirSyncReal(dir, { recursive: true });
  const skillName = basename(dir);
  writeFileSync(
    safePath.join(dir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: ${descriptionWords}\n---\n\n# ${skillName}\n\nBody.\n`,
    'utf-8'
  );
}

/** What `process.exit` is stubbed to throw, so the command unwinds instead of ending the worker. */
const EXITED = 'process.exit called';

/**
 * Run the scan in-process, as the CLI would: it publishes its report on stdout
 * and ends on the code the report derives. Both are captured.
 */
async function runScan(seed: string, out: string): Promise<{ exitCode: number | undefined; document: Record<string, unknown> }> {
  const chunks: string[] = [];
  let exitCode: number | undefined;
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(EXITED);
  }) as never);
  try {
    await expect(corpusScanCommand(seed, { out, withReview: false, debug: false })).rejects.toThrow(EXITED);
  } finally {
    stdout.mockRestore();
    exit.mockRestore();
  }
  return { exitCode, document: yaml.parse(chunks.join('')) as Record<string, unknown> };
}

function firstEntry(dir: string): string {
  const entries = readdirSync(dir);
  const first = entries[0];
  if (first === undefined) {
    throw new Error(`Expected at least one entry in ${dir}`);
  }
  return first;
}

beforeAll(() => {
  workspace = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-int-'));

  const cleanRoot = safePath.join(workspace, 'clean-plugin');
  makeSkill(
    safePath.join(cleanRoot, 'plugins', 'clean'),
    'A clean fixture skill that should pass audit without findings.'
  );

  const noisyRoot = safePath.join(workspace, 'noisy-plugin');
  makeSkill(
    safePath.join(noisyRoot, 'plugins', 'noisy'),
    'A short description that may or may not trigger warnings depending on validators.'
  );

  seedPath = safePath.join(workspace, 'seed.yaml');
  writeFileSync(
    seedPath,
    yaml.stringify({
      plugins: [
        { source: cleanRoot, name: 'clean', ...META },
        { source: noisyRoot, name: 'noisy', ...META },
      ],
    }),
    'utf-8'
  );

  outDir = safePath.join(workspace, 'runs');
});

describe('vat corpus scan — integration', () => {
  it('produces a run directory with summary.yaml and per-plugin audit YAMLs', async () => {
    const { exitCode, document } = await runScan(seedPath, outDir);
    expect(exitCode).toBe(0);
    expect(document).toMatchObject({ status: 'ok', examined: 2 });

    const runDirs = readdirSync(outDir);
    expect(runDirs).toHaveLength(1);
    const runDir = safePath.join(outDir, firstEntry(outDir));

    const summaryPath = safePath.join(runDir, 'summary.yaml');
    expect(statSync(summaryPath).isFile()).toBe(true);

    const summary = yaml.parse(readFileSync(summaryPath, 'utf-8')) as Record<string, unknown>;
    expect(summary.plugins as unknown[]).toHaveLength(2);
    expect((summary.totals as Record<string, number>).plugins).toBe(2);

    const cleanAudit = safePath.join(runDir, 'clean-audit.yaml');
    const noisyAudit = safePath.join(runDir, 'noisy-audit.yaml');
    expect(statSync(cleanAudit).isFile()).toBe(true);
    expect(statSync(noisyAudit).isFile()).toBe(true);
  });

  it('records unloadable for a missing local source path without aborting the run', async () => {
    const seedWithBad = safePath.join(workspace, 'seed-with-bad.yaml');
    writeFileSync(
      seedWithBad,
      yaml.stringify({
        plugins: [
          { source: '/absolutely/missing/plugin', name: 'ghost', ...META },
          { source: safePath.join(workspace, 'clean-plugin'), name: 'clean2', ...META },
        ],
      }),
      'utf-8'
    );
    const out2 = safePath.join(workspace, 'runs2');

    const { exitCode, document } = await runScan(seedWithBad, out2);
    // The entry it could not audit is a warning naming it, so the run still exits 0.
    expect(exitCode).toBe(0);
    expect(document).toMatchObject({ status: 'findings', findings: [{ code: 'CORPUS_ENTRY_INCOMPLETE', field: 'plugins[0]' }] });

    const runDir = safePath.join(out2, firstEntry(out2));
    const summary = yaml.parse(readFileSync(safePath.join(runDir, 'summary.yaml'), 'utf-8')) as Record<
      string,
      unknown
    >;

    const totals = summary.totals as Record<string, number>;
    expect(totals.unloadable).toBe(1);
    expect(totals.audit_ok + totals.audit_findings).toBe(1);
  });
});

/**
 * A plugin whose root holds a DIRECTORY named `vibe-agent-toolkit.config.yaml`,
 * so the validation overlay the seed asks for cannot be written into it (EISDIR)
 * — a refusal of the SOURCE, on every platform, with no mode bits.
 */
function pluginRefusingTheOverlay(name: string): string {
  const root = safePath.join(workspace, name);
  makeSkill(safePath.join(root, 'plugins', 'clean'), 'A clean fixture skill that should pass audit without findings.');
  writeFileSync(safePath.join(mkdirIn(root, 'vibe-agent-toolkit.config.yaml'), 'keep'), 'x', 'utf-8');
  return root;
}

function mkdirIn(root: string, name: string): string {
  const dir = safePath.join(root, name);
  mkdirSyncReal(dir, { recursive: true });
  return dir;
}

/** A one-entry seed file for `source`, asking for a validation overlay when `validation` is set. */
function seedFor(file: string, source: string, validation: boolean): string {
  const path = safePath.join(workspace, file);
  const entry = { source, name: 'entry', ...META, ...(validation ? { validation: { severity: { LINK_DROPPED_BY_DEPTH: 'ignore' } } } : {}) };
  writeFileSync(path, yaml.stringify({ plugins: [entry] }), 'utf-8');
  return path;
}

/** The run directory name the scan will use today: `<UTC date>-<VAT's own short commit>`. */
function todaysRunDirName(): string {
  const commit = spawnSync(gitExecutable(), ['rev-parse', '--short=8', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf-8' }).stdout.trim();
  return `${new Date().toISOString().slice(0, 10)}-${commit}`;
}

describe('vat corpus scan — which failures are an entry, and which are the run', () => {
  it('a git-URL entry whose audit file cannot be written under --out refuses the run as RUN_INCOMPLETE', async () => {
    const origin = safePath.join(workspace, 'url-origin');
    makeSkill(safePath.join(origin, 'plugins', 'clean'), 'A clean fixture skill that should pass audit without findings.');
    commitTestFixture(origin);
    const out = safePath.join(workspace, 'runs-audit-refused');
    // Only the entry's audit file is refused (a directory in its place: EISDIR, on every
    // platform) — summary.yaml beside it still writes, so this can only go red on the audit write.
    mkdirIn(safePath.join(out, todaysRunDirName()), 'entry-audit.yaml');

    const { exitCode, document } = await runScan(seedFor('seed-url.yaml', pathToFileURL(origin).href, false), out);

    // A write under --out is the RUN's, never the entry's: not an unloadable row at exit 0.
    expect(document).toMatchObject({ status: 'error', error: { code: 'RUN_INCOMPLETE' } });
    expect(exitCode).toBe(2);
  });

  // The overlay writes into the SOURCE, not --out: in both lanes a source that
  // refuses it is that entry's unloadable row, and the scan finishes.
  it.each([
    { lane: 'local', source: (): string => pluginRefusingTheOverlay('overlay-local') },
    {
      lane: 'git-URL',
      source: (): string => {
        const origin = pluginRefusingTheOverlay('overlay-url');
        commitTestFixture(origin);
        return pathToFileURL(origin).href;
      },
    },
  ])('a $lane entry whose validation overlay the source refuses is that entry\'s unloadable row', async ({ lane, source }) => {
    const { exitCode, document } = await runScan(seedFor(`seed-overlay-${lane}.yaml`, source(), true), safePath.join(workspace, `runs-overlay-${lane}`));

    expect(document).toMatchObject({ status: 'findings', findings: [{ code: 'CORPUS_ENTRY_INCOMPLETE' }] });
    expect((document['data'] as { entries: unknown[] }).entries).toEqual([expect.objectContaining({ audit: 'unloadable' })]);
    expect(exitCode).toBe(0);
  });
});
