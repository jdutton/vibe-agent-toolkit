/**
 * `vat skill test configure` reads the config it edits. Which side that read is on
 * depends on the run: written back over the file, the config is the run's
 * DESTINATION (a refused read is `RUN_INCOMPLETE`); under `--print`, which writes
 * nothing, it is only an input (a refused read is `INPUT_UNREADABLE`).
 */

import { mkdtempSync, rmSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as YAML from 'yaml';

import { createSkillTestConfigureCommand } from '../../src/commands/skill/test/configure.js';
import { captureCommand } from '../helpers/stdout-capture.js';

/** The refusal code a run published, whichever stream carried the report. */
function refusalOf(captured: { stdout: string; stderr: string }): unknown {
  const text = captured.stdout.trim() === '' ? captured.stderr : captured.stdout;
  const document = YAML.parse(text) as { error?: { code?: string } } | null;
  return document?.error?.code;
}

describe('skill test configure — the side of the config read', () => {
  let project: string;

  beforeEach(() => {
    project = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-configure-side-')));
    // A directory where the config file should be: EISDIR on every platform.
    mkdirSyncReal(safePath.join(project, 'vibe-agent-toolkit.config.yaml'));
    vi.spyOn(process, 'cwd').mockReturnValue(project);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
  });

  it('refuses RUN_INCOMPLETE when the update would be written back over the config', async () => {
    const captured = await captureCommand(async () => {
      await createSkillTestConfigureCommand().parseAsync(['my-skill', '--max-turns', '5'], { from: 'user' });
    });
    expect(captured.exited).toBe(2);
    expect(refusalOf(captured)).toBe('RUN_INCOMPLETE');
  });

  it('refuses INPUT_UNREADABLE under --print, which only reads the config', async () => {
    const captured = await captureCommand(async () => {
      await createSkillTestConfigureCommand().parseAsync(['my-skill', '--max-turns', '5', '--print'], { from: 'user' });
    });
    expect(captured.exited).toBe(2);
    expect(refusalOf(captured)).toBe('INPUT_UNREADABLE');
  });
});
