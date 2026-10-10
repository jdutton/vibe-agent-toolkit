/**
 * The fault matrix's driver against a toy command: stubs the environment per case, reads the
 * published report into an outcome, turns an escaped throw into INTERNAL_ERROR, and
 * normalises what differs between two roots by construction.
 */
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, normalizedTmpdir, normalizePath, safePath } from '@vibe-agent-toolkit/utils';
import { tempDirTracker } from '@vibe-agent-toolkit/utils/testing';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as YAML from 'yaml';

import { makeCaseRoot, provenanceMismatch, rootsOf, runVerb, snapshotCase, type VerbCase } from '../fault-matrix/drive.js';

const byName = (a: string, b: string): number => a.localeCompare(b);
const scratch = tempDirTracker('fault-matrix-drive-');
// makeCaseRoot stubs TMPDIR; a test that never reaches runVerb must unstub it before the
// tracker's guarded remove asks where the host tmpdir is.
afterEach(() => {
  vi.unstubAllEnvs();
  scratch.cleanupAll();
});

function toyCase(action: () => void): VerbCase {
  return {
    id: 'toy/lane/variant',
    group: () => new Command('toy').exitOverride().action(action),
    argv: () => [],
    fixture: () => {},
    watched: (r) => [safePath.join(r.home, '.claude')],
    units: (r) => [safePath.relative(r.root, safePath.join(r.home, '.claude', 'u'))],
    sources: (r) => [safePath.join(r.project, 'src')],
  };
}

/** Publish as the CLI's writer does: each document opens with `---`. */
const publish = (report: object): void => {
  process.stdout.write(`---\n${YAML.stringify(report)}`);
};

describe('runVerb', () => {
  it('reads the refusal, its message and the warning findings off the published report, and the exit code', async () => {
    const c = toyCase(() => {
      publish({
        status: 'error',
        error: { code: 'RUN_INCOMPLETE', message: 'ran out of space' },
        findings: [{ severity: 'warning', code: 'W', message: 'left /x/.u.vat-staged-1' }, { severity: 'error', code: 'E', message: 'not a warning' }],
      });
      process.exit(ExitCode.ERROR);
    });
    const r = makeCaseRoot(scratch.create());
    expect(await runVerb(c, r)).toMatchObject({
      exitCode: 2, refusal: 'RUN_INCOMPLETE', message: 'ran out of space', warnings: ['left /x/.u.vat-staged-1'],
    });
  });

  it('a verb that never exits is exit undefined with no refusal', async () => {
    const outcome = await runVerb(toyCase(() => publish({ status: 'ok', findings: [] })), makeCaseRoot(scratch.create()));
    expect(outcome).toMatchObject({ exitCode: undefined, refusal: undefined, warnings: [] });
  });

  // A verb owes ONE report envelope: none readable, or two published before a single exit, is a broken report.
  it.each([
    ['no parseable report', 'exit 2 with no parseable report', (): void => {
      process.stdout.write('crashed before the report\n: [unclosed');
    }],
    ['two documents', 'exit 2 with 2 documents and 1 exit call(s)', (): void => {
      publish({ status: 'ok', findings: [] });
      publish({ status: 'error', error: { code: 'RUN_INCOMPLETE', message: 'second envelope' } });
    }],
  ])('an exit 2 with %s is NO_REPORT, which I1 refuses', async (_label, message, write) => {
    const c = toyCase(() => {
      write();
      process.exit(ExitCode.ERROR);
    });
    const outcome = await runVerb(c, makeCaseRoot(scratch.create()));
    expect(outcome).toMatchObject({ exitCode: 2, refusal: 'NO_REPORT' });
    expect(outcome.message).toContain(message);
  });

  it('a findings exit with a valid report that carries no refusal is not NO_REPORT', async () => {
    const c = toyCase(() => {
      publish({ status: 'findings', findings: [] });
      process.exit(ExitCode.FINDINGS);
    });
    expect(await runVerb(c, makeCaseRoot(scratch.create()))).toMatchObject({ exitCode: 1, refusal: undefined });
  });

  // The real process.exit never returns. A verb that publishes and exits inside its own try (as
  // `skill test configure` does) catches the stub's throw and publishes a second, refusal document:
  // that run ended at the FIRST exit, with the first document.
  it('a verb whose catch sees the exit stub ends at its first exit, with its first document', async () => {
    const c = toyCase(() => {
      try {
        publish({ status: 'ok', findings: [{ severity: 'warning', code: 'W', message: 'from the first document' }] });
        process.exit(ExitCode.OK);
      } catch (error) {
        // What a verb's own catch does with the exit stub's throw: publish it as a defect, and exit again.
        publish({ status: 'error', error: { code: 'INTERNAL_ERROR', message: String(error) } });
        process.exit(ExitCode.ERROR);
      }
    });
    expect(await runVerb(c, makeCaseRoot(scratch.create()))).toMatchObject({ exitCode: 0, refusal: undefined, warnings: ['from the first document'] });
  });

  it('the first-exit hook runs when the verb first exits, before anything its catch does', async () => {
    const seen: string[] = [];
    const c = toyCase(() => {
      try {
        seen.push('before');
        process.exit(ExitCode.OK);
      } catch (error) {
        // What a verb's own catch might do with the exit stub's throw: carry on, in code the real process never runs.
        seen.push(`after ${String(error)}`);
      }
    });
    await runVerb(c, makeCaseRoot(scratch.create()), () => seen.push('first exit'));
    expect(seen).toEqual(['before', 'first exit', 'after Error: process.exit']);
  });

  it('a throw that escapes the command is INTERNAL_ERROR, not a crashed test, and is the value the outcome was built from', async () => {
    const boom = new Error('boom');
    const outcome = await runVerb(toyCase(() => { throw boom; }), makeCaseRoot(scratch.create()));
    expect(outcome).toMatchObject({ refusal: 'INTERNAL_ERROR', message: 'boom' });
    expect(outcome.thrown).toBe(boom);
  });

  // Loaded after drive.js, so through the refusal observer's mock (a static import would sort ahead of it).
  it('hands back the value a real refusal was built from: the last one before the first exit, not what a catch did after it', async () => {
    const { endWithRefusal, NOTHING_FINISHED } = await import('../../src/utils/document-writer.js');
    const { errorMessageOf } = await import('../../src/utils/command-refusal.js');
    const refused = new Error('the refusal');
    const c = toyCase(() => {
      errorMessageOf(new Error('an earlier warning'));
      try {
        endWithRefusal('inventory', 'RUN_INCOMPLETE', refused, 'yaml', { strict: false }, NOTHING_FINISHED);
      } catch (error) {
        errorMessageOf(error);
      }
    });
    const outcome = await runVerb(c, makeCaseRoot(scratch.create()));
    expect(outcome).toMatchObject({ exitCode: ExitCode.ERROR, refusal: 'RUN_INCOMPLETE', message: 'the refusal' });
    expect(outcome.thrown).toBe(refused);
    expect(await provenanceMismatch(outcome)).toBeUndefined();
  });

  it('provenance: a thrown value the published message was NOT built from (a stale earlier one) is named', async () => {
    const { errorMessageOf } = await import('../../src/utils/command-refusal.js');
    const c = toyCase(() => {
      errorMessageOf(new Error('an earlier warning'));
      publish({ status: 'error', error: { code: 'RUN_INCOMPLETE', message: 'the refusal' }, findings: [] });
      process.exit(ExitCode.ERROR);
    });
    const outcome = await runVerb(c, makeCaseRoot(scratch.create()));
    expect(outcome.thrown).toEqual(new Error('an earlier warning'));
    expect(await provenanceMismatch(outcome)).toBe('published "the refusal" but the observed thrown value gives "an earlier warning"');
  });

  it('provenance on a declared composite: judged against its failed phase, which must be the thrown value\'s', async () => {
    const { errorMessageOf } = await import('../../src/utils/command-refusal.js');
    const { refusalOfRecord } = await import('../fault-matrix/composite.js');
    const foldOver = (phaseMessage: string) => toyCase(() => {
      errorMessageOf(new Error('the phase refused'));
      publish({
        status: 'error',
        error: { code: 'RUN_INCOMPLETE', message: "The run did not finish: phase 'p' (INPUT_UNREADABLE) stopped before it did." },
        findings: [],
        data: { phases: [{ name: 'p', status: 'error', error: { code: 'INPUT_UNREADABLE', message: phaseMessage } }] },
      });
      process.exit(ExitCode.ERROR);
    });
    const judge = async (phaseMessage: string, composite: boolean): Promise<string | undefined> => {
      const outcome = await runVerb(foldOver(phaseMessage), makeCaseRoot(scratch.create()));
      const record = refusalOfRecord(outcome, composite);
      if ('problem' in record) throw new Error(record.problem);
      return provenanceMismatch(outcome, record);
    };
    expect(await judge('the phase refused', true)).toBeUndefined();
    expect(await judge('some other phase message', true)).toBe('published "some other phase message" (phase \'p\') but the observed thrown value gives "the phase refused"');
    expect(await judge('the phase refused', false)).toContain('published "The run did not finish');
  });

  it('provenance: an empty message is the refusal code\'s own description, and a classified fault carries its remedy', async () => {
    const { endWithRefusal, NOTHING_FINISHED } = await import('../../src/utils/document-writer.js');
    const { classifyFsFault } = await import('@vibe-agent-toolkit/utils');
    for (const thrown of [new Error(''), classifyFsFault(Object.assign(new Error('x'), { code: 'ENOSPC', path: '/p' }), { side: 'destination', action: 'write' })]) {
      const outcome = await runVerb(toyCase(() => endWithRefusal('inventory', 'RUN_INCOMPLETE', thrown, 'yaml', { strict: false }, NOTHING_FINISHED)), makeCaseRoot(scratch.create()));
      expect(outcome.thrown).toBe(thrown);
      expect(await provenanceMismatch(outcome)).toBeUndefined();
    }
  });

  it('a run that refused nothing through the refusal path carries no thrown value', async () => {
    const outcome = await runVerb(toyCase(() => publish({ status: 'ok', findings: [] })), makeCaseRoot(scratch.create()));
    expect(outcome).not.toHaveProperty('thrown');
  });

  it('runs against the case root, then hands the environment back', async () => {
    const home = process.env['HOME'];
    const seen: { home?: string; tmp?: string } = {};
    const r = makeCaseRoot(scratch.create());
    await runVerb(toyCase(() => { seen.home = homedir(); seen.tmp = normalizedTmpdir(); }), r);
    expect(seen.home).toBe(r.home);
    expect(safePath.resolve(seen.tmp ?? '')).toBe(r.tmp);
    expect(process.env['HOME']).toBe(home);
  });

  it('runs in the case\'s cwd with no Claude config dir or parse cache of the host, then hands all three back', async () => {
    const cwd = process.cwd();
    const seen: { cwd?: string; claude?: string | undefined; cache?: string | undefined } = {};
    const r = makeCaseRoot(scratch.create());
    const c = { ...toyCase(() => { seen.cwd = process.cwd(); seen.claude = process.env['CLAUDE_CONFIG_DIR']; seen.cache = process.env['VAT_CACHE']; }), cwd: (root: typeof r) => root.project };
    await runVerb(c, r);
    expect(safePath.resolve(seen.cwd ?? '')).toBe(safePath.resolve(normalizePath(r.project)));
    expect(seen).toMatchObject({ claude: '', cache: '0' });
    expect(process.cwd()).toBe(cwd);
  });
});

// `runVerb` undoes the case root's env stubs when it returns. A second run on the same root used to
// go ahead against the ambient environment — and a real `vat claude plugin install` did exactly that,
// into a live Claude config. It now refuses before the verb runs.
describe('runVerb never runs a verb outside its case root', () => {
  it('throws on a second run whose stubs the first run undid, and runs again once the root is re-stubbed', async () => {
    let runs = 0;
    const c = toyCase(() => { runs += 1; });
    const r = makeCaseRoot(scratch.create());
    await runVerb(c, r);

    await expect(runVerb(c, r)).rejects.toThrow(/would run outside its case root/);
    expect(runs).toBe(1);

    await runVerb(c, makeCaseRoot(r.root));
    expect(runs).toBe(2);
  });
});

describe('snapshotCase', () => {
  it('keys watched trees relative to the case root, and the temp dir relative to itself', () => {
    const c = toyCase(() => {});
    const r = makeCaseRoot(scratch.create());
    mkdirSyncReal(safePath.join(r.home, '.claude', 'u'), { recursive: true });
    writeFileSync(safePath.join(r.home, '.claude', 'u', 'f'), 'x');
    writeFileSync(safePath.join(r.tmp, 'left'), 'x');
    const snaps = snapshotCase(c, r);
    expect([...snaps.watched.keys()].toSorted(byName)).toEqual(['home/.claude', 'home/.claude/u', 'home/.claude/u/f']);
    expect([...snaps.tmp.keys()].toSorted(byName)).toEqual(['.', 'left']);
    expect(snaps.sources.size).toBe(0);
  });

  it('two cases in different roots snapshot equal when only the root and a timestamp differ in a registry file', () => {
    const c = toyCase(() => {});
    const make = (stamp: string) => {
      const r = makeCaseRoot(scratch.create());
      mkdirSyncReal(safePath.join(r.home, '.claude'), { recursive: true });
      writeFileSync(safePath.join(r.home, '.claude', 'installed.json'), JSON.stringify({ path: `${r.home}/.claude/u`, at: stamp }));
      return { r, snaps: snapshotCase(c, r) };
    };
    const one = make('2026-10-07T01:02:03.000Z');
    const two = make('2026-10-08T09:09:09.999Z');
    expect(one.r.root).not.toBe(two.r.root);
    expect(two.snaps.watched).toEqual(one.snaps.watched);
  });

  it('rootsOf carries the case sources', () => {
    const r = makeCaseRoot(scratch.create());
    expect(rootsOf(toyCase(() => {}), r)).toEqual({ home: r.home, tmp: r.tmp, project: r.project, sources: [safePath.join(r.project, 'src')] });
  });
});
