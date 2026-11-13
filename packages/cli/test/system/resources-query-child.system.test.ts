/**
 * A supervised `vat resources query` child, spawned by this test as its supervisor would spawn it:
 * this process is its parent, so the `--supervised-by` it is handed names this pid.
 *
 * What the child owes its supervisor, and nothing the supervisor itself does: the progress units a
 * kill names where it landed by, and — when the supervisor is gone — its one stderr line, naming
 * the query. The supervisor's half is `resources-query-budget.system.test.ts`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { gitExecutable, NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SUPERVISED_BY_FLAG, supervisedByValue } from '../../src/commands/resources/check-supervisor.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, createTestTempDir, safePath, writeFileTree } from './test-common.js';
import { BIN_PATH } from './test-helpers/checks-phase.js';

// ⛔ Disposal paths: every `vat` child this suite spawns inherits the scratch TMPDIR.
const scratch = useScratchTmpdir('vat-scratch-query-child-');

/** A cheap statement over the fixture's one markdown file. */
const MD_ROWS = "SELECT path FROM resource_realizations WHERE ext = '.md'";

/** How one child ended. */
interface ChildEnding {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the query child with this process as its supervisor.
 *
 * @param project - The root the child queries
 * @param progressLog - The progress log it appends to
 * @param supervisorGone - End the child's stdin at once, as the OS does when the supervisor dies
 * @returns How the child ended
 */
function runChild(project: string, progressLog: string, supervisorGone: boolean): Promise<ChildEnding> {
  const args = [
    BIN_PATH,
    'resources',
    'query',
    '--format=yaml',
    SUPERVISED_BY_FLAG,
    supervisedByValue({ invoker: 'standalone', progressLog }),
    '--',
    MD_ROWS,
    project,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_EXECUTABLE, args, { cwd: project, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    // A live supervisor holds stdin open and never writes it; a dead one's end closes.
    if (supervisorGone) child.stdin.end();
    child.once('error', reject);
    // Node closes a supervisor's end itself once the child has exited (see `superviseRun`).
    child.once('exit', () => child.stdin.end());
    child.once('close', (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

/** The `kind` of every entry the child appended to its progress log. */
function progressKinds(progressLog: string): string[] {
  return readFileSync(progressLog, 'utf-8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as { kind: string }).kind);
}

describe('a supervised query child', () => {
  let project: string;

  beforeAll(() => {
    project = createTestTempDir('vat-query-child-');
    writeFileTree(project, { 'a.md': '# Alpha\n', 'vibe-agent-toolkit.config.yaml': 'resources: {}\n' });
    spawnSync(gitExecutable(), ['init', '--quiet'], { cwd: project });
  });

  afterAll(() => {
    cleanupTestTempDir(project);
  });

  it('writes started, the population, then statements-complete, and publishes its document', async () => {
    const progressLog = safePath.join(scratch(), 'completed.jsonl');

    const ending = await runChild(project, progressLog, false);

    expect(ending.status, ending.stderr).toBe(0);
    // Positive control: the child ran the statement and published its answer.
    expect(ending.stdout).toContain('a.md');
    expect(progressKinds(progressLog)).toStrictEqual(['started', 'population', 'statements-complete']);
  });

  it('ends itself, naming the query, when its supervisor is gone: exit 2 and nothing published', async () => {
    const ending = await runChild(project, safePath.join(scratch(), 'orphaned.jsonl'), true);

    expect(ending.status).toBe(2);
    expect(ending.stderr).toMatch(/^vat resources query: the process supervising this query run \(pid \d+\) is gone/);
    expect(ending.stdout).toBe('');
  });
});
