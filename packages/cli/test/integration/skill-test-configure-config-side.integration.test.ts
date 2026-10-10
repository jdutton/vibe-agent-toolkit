/**
 * `vat skill test configure` reads the config it edits. Which side that read is on
 * depends on the run: written back over the file, the config is the run's
 * DESTINATION (a refused read is `RUN_INCOMPLETE`); under `--print`, which writes
 * nothing, it is only an input (a refused read is `INPUT_UNREADABLE`).
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { type FaultFsSession, installFaultFs } from '@vibe-agent-toolkit/utils/testing';
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

// The config is the adopter's hand-authored file. Written in place (open-truncate, then write) a
// full disk or an interruption after the truncate left it empty or cut short.
describe('skill test configure — the config is replaced whole, never truncated in place', () => {
  let project: string;
  let session: FaultFsSession | undefined;
  const configPath = (): string => safePath.join(project, 'vibe-agent-toolkit.config.yaml');
  const ORIGINAL = 'version: 1\nskills:\n  include:\n    - "skills/*/SKILL.md"\n';

  beforeEach(() => {
    project = safePath.resolve(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-configure-write-')));
    writeFileSync(configPath(), ORIGINAL);
    mkdirSyncReal(safePath.join(project, 'skills', 'my-skill'), { recursive: true });
    writeFileSync(safePath.join(project, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: d\n---\n');
    vi.spyOn(process, 'cwd').mockReturnValue(project);
  });

  afterEach(() => {
    session?.restore();
    session = undefined;
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
  });

  const configure = (): Promise<{ stdout: string; stderr: string; exited: number | undefined }> => captureCommand(async () => {
    await createSkillTestConfigureCommand().parseAsync(['my-skill', '--max-turns', '5'], { from: 'user' });
  });

  it('writes a temp beside the config and renames it over: the config itself is never opened for writing', async () => {
    session = installFaultFs({ within: project });

    const captured = await configure();

    expect(captured.exited ?? 0, captured.stderr).toBe(0);
    expect(readFileSync(configPath(), 'utf8')).toContain('maxTurns: 5');
    // The one write-family call on the config itself is the open that PROVES it writable (`r+`: no
    // truncation, no bytes) before anything is staged; its bytes only ever arrive by the rename.
    const writesToConfig = session.calls.filter((call) => call.family === 'write' && call.path === configPath());
    expect(writesToConfig.map((call) => call.op)).toEqual(['open']);
    expect(session.calls.filter((call) => call.family === 'rename' && call.dest === configPath())).toHaveLength(1);
  });

  it('a full disk while writing leaves the config byte for byte as it was, and no temp beside it', async () => {
    session = installFaultFs({ within: project, faults: [{ family: 'write', path: (p) => p.includes('.vat-staged-'), errno: 'ENOSPC' }] });

    const captured = await configure();

    expect(captured.exited).toBe(2);
    expect(refusalOf(captured)).toBe('RUN_INCOMPLETE');
    expect(readFileSync(configPath(), 'utf8')).toBe(ORIGINAL);
    expect(readdirSync(project).filter((name) => name.includes('.vat-staged-'))).toEqual([]);
  });
});
