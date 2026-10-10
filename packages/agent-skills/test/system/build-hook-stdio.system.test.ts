/**
 * `vat skill test run`'s `test.build` hook writes nothing to the run's STDOUT: stdout is the YAML
 * report alone, and a hook that prints (`npm run build`, `pnpm bundle`) used to put its lines ahead
 * of it — two documents, or a parse error, for whoever pipes the report into a parser.
 *
 * System tier: a real child process runs the real hook, so the fd the hook's stdout lands on is
 * what is measured, not what an injected spawn function was handed.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import { NODE_EXECUTABLE } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

const HOOK_LINE = 'HOOK-STDOUT-LINE';
/** The built module: the child process runs what ships. */
const BUILD_HOOK_MODULE = pathToFileURL(safePath.resolve(import.meta.dirname, '../../dist/skill-test/build-hook.js')).href;

/** Run the real hook with `command` in a child process; what the child wrote to each stream. */
function runHookInChild(command: string): { stdout: string; stderr: string; status: number | null } {
  const script = `import { runPreStageBuild } from ${JSON.stringify(BUILD_HOOK_MODULE)}; runPreStageBuild({ buildCommand: ${JSON.stringify(command)}, configRoot: process.cwd() });`;
  const child = spawnSync(NODE_EXECUTABLE, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  return { stdout: child.stdout, stderr: child.stderr, status: child.status };
}

describe('the test.build hook\'s stdout', () => {
  it('goes to the run\'s stderr, leaving stdout for the report alone', () => {
    const child = runHookInChild(`echo ${HOOK_LINE}`);

    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe('');
    expect(child.stderr).toContain(HOOK_LINE);
  });

  it('still fails the run when the hook exits non-zero, its output on stderr', () => {
    const child = runHookInChild(`echo ${HOOK_LINE} && exit 3`);

    expect(child.status).not.toBe(0);
    expect(child.stdout).toBe('');
    expect(child.stderr).toContain(HOOK_LINE);
  });
});
