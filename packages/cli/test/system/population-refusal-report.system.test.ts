/**
 * Every CLI lane that populates a tree from its rows reports what that
 * population declined — `vat claude context` and `vat inventory` as well as the
 * query verbs — because the report lives inside the one population entry
 * (`populateAndReport`) rather than in a call each lane places by hand.
 *
 * Each corpus holds the same binary bytes twice: at `logo.png`, a committed
 * image and the ordinary shape of a repository, which is NOT reported, and at a
 * path typed as text, which is. So `(1 not text)` pins the line both ways.
 *
 * Isolation: `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and the temp directory (`TMPDIR`,
 * `TEMP`, `TMP`) all point into scratch, and no projection store is selected, so every run
 * derives.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commitTestFixture } from '../test-helpers.js';

import { createIsolatedScratch, executeCli, getBinPath, isolatedScratchEnv } from './test-common.js';

const binPath = getBinPath(import.meta.url);

/** PNG signature bytes: a NUL inside the sniff window, so the blob stage declines them as not text. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

let scratch: string;

/**
 * A committed corpus: `files` as given, plus the image the report stays silent about.
 *
 * @param name - The corpus directory's name under scratch
 * @param files - Root-relative path → content
 * @returns The corpus root
 */
function corpus(name: string, files: Readonly<Record<string, string | Buffer>>): string {
  const root = safePath.join(scratch, name);
  for (const [relative, content] of Object.entries({ ...files, 'assets/logo.png': PNG_BYTES })) {
    const absolute = safePath.join(root, relative);
    mkdirSyncReal(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  commitTestFixture(root);
  return root;
}

/**
 * Run one verb in a corpus, isolated.
 *
 * @param root - The corpus root, used as the working directory
 * @param args - The verb and its arguments
 * @returns The run's stderr, with its exit status for the failure message
 */
async function stderrOf(root: string, args: string[]): Promise<{ status: number | null; stderr: string }> {
  const result = await executeCli(binPath, args, {
    cwd: root,
    env: isolatedScratchEnv(scratch),
  });
  return { status: result.status, stderr: result.stderr };
}

describe('the population refusal report, on every lane that populates (system test)', () => {
  beforeAll(() => {
    scratch = createIsolatedScratch('vat-refusal-report-');
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('vat claude context names a binary its @-import chain reached, and not the image', async () => {
    const root = corpus('context', {
      'CLAUDE.md': '# Project\n\n@notes.md\n',
      'notes.md': Buffer.concat([PNG_BYTES, Buffer.from('# not really notes\n')]),
    });

    const run = await stderrOf(root, ['claude', 'context', '.', '--format', 'json']);

    expect(run.stderr, `exit ${String(run.status)}`).toContain('claude-context population: blob derivation declined');
    expect(run.stderr).toContain('(1 not text)');
  });

  it('vat inventory names a binary the plugin\'s skill ships, and not the image', async () => {
    // A plugin directory: the one subject shape whose skills share a population.
    const root = corpus('inventory', {
      '.claude-plugin/plugin.json': '{ "name": "demo-plugin", "version": "0.0.1" }\n',
      'skills/demo/SKILL.md': '---\nname: demo\ndescription: A demo skill for the refusal report.\n---\n\n# Demo\n\nSee [the data](./data.json).\n',
      'skills/demo/data.json': Buffer.concat([PNG_BYTES, Buffer.from('{}')]),
    });

    const run = await stderrOf(root, ['inventory', '.']);

    expect(run.stderr, `exit ${String(run.status)}`).toContain('inventory population: blob derivation declined');
    expect(run.stderr).toContain('(1 not text)');
  });
});
