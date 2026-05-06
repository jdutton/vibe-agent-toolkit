import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'js-yaml';
import { beforeAll, describe, expect, it } from 'vitest';

import { corpusScanCommand } from '../../src/commands/corpus/scan.js';

let workspace: string;
let seedPath: string;
let outDir: string;

function makeSkill(dir: string, descriptionWords: string): void {
  mkdirSyncReal(dir, { recursive: true });
  const skillName = basename(dir);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled path under workspace
  writeFileSync(
    safePath.join(dir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: ${descriptionWords}\n---\n\n# ${skillName}\n\nBody.\n`,
    'utf-8'
  );
}

function firstEntry(dir: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled path under workspace
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled path
  writeFileSync(
    seedPath,
    yaml.dump({
      plugins: [
        { source: cleanRoot, name: 'clean' },
        { source: noisyRoot, name: 'noisy' },
      ],
    }),
    'utf-8'
  );

  outDir = safePath.join(workspace, 'runs');
});

describe('vat corpus scan — integration', () => {
  it('produces a run directory with summary.yaml and per-plugin audit YAMLs', async () => {
    await corpusScanCommand(seedPath, { out: outDir, withReview: false, debug: false });

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled
    const runDirs = readdirSync(outDir);
    expect(runDirs).toHaveLength(1);
    const runDir = safePath.join(outDir, firstEntry(outDir));

    const summaryPath = safePath.join(runDir, 'summary.yaml');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled
    expect(statSync(summaryPath).isFile()).toBe(true);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled
    const summary = yaml.load(readFileSync(summaryPath, 'utf-8')) as Record<string, unknown>;
    expect((summary.plugins as unknown[]).length).toBe(2);
    expect((summary.totals as Record<string, number>).plugins).toBe(2);

    const cleanAudit = safePath.join(runDir, 'clean-audit.yaml');
    const noisyAudit = safePath.join(runDir, 'noisy-audit.yaml');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled
    expect(statSync(cleanAudit).isFile()).toBe(true);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled
    expect(statSync(noisyAudit).isFile()).toBe(true);
  });

  it('records unloadable for a missing local source path without aborting the run', async () => {
    const seedWithBad = safePath.join(workspace, 'seed-with-bad.yaml');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled
    writeFileSync(
      seedWithBad,
      yaml.dump({
        plugins: [
          { source: '/absolutely/missing/plugin', name: 'ghost' },
          { source: safePath.join(workspace, 'clean-plugin'), name: 'clean2' },
        ],
      }),
      'utf-8'
    );
    const out2 = safePath.join(workspace, 'runs2');

    await corpusScanCommand(seedWithBad, { out: out2, withReview: false, debug: false });

    const runDir = safePath.join(out2, firstEntry(out2));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled
    const summary = yaml.load(readFileSync(safePath.join(runDir, 'summary.yaml'), 'utf-8')) as Record<
      string,
      unknown
    >;

    const totals = summary.totals as Record<string, number>;
    expect(totals.unloadable).toBe(1);
    expect(totals.audit_clean + totals.audit_warning + totals.audit_error).toBe(1);
  });
});
