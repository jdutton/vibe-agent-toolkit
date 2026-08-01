/**
 * Unit tests for phase/surface selection across the three top-level
 * orchestrators (`vat build`, `vat verify`, `vat validate`).
 *
 * Neither `vat verify` nor `vat validate` has a `--only` any more: on a real
 * 90-skill project those commands are ~32s and ~35s, and the filter saved at
 * most ~18s and ~19s respectively — which did not pay for a flag that
 * repeatedly produced wrong answers. Both selections are now pure functions of
 * the config alone. **`vat build` keeps its `--only`** (measured 143s, skills
 * 106s + claude 37s), so the two defects below are still pinned for it:
 *
 *  1. **`--only <unconfigured phase>` must not silently pass.** `vat verify`
 *     used to push `resources` and `skills` without ever consulting the config,
 *     so `vat verify --only skills` in a project with no `skills:` block exited
 *     0 while `vat validate --only skills` on the same project exited 1. The
 *     config-gating that fixed it is what the bare commands still rely on.
 *
 *  2. **An unroutable `--only` threw outside the try block.** The user got a raw
 *     Node stack trace, zero bytes of stdout, and an exit 1 masquerading as
 *     "validation errors". `vat build`'s message was self-refuting on top of
 *     that: "Unknown phase: claude. Valid phases: skills, claude."
 *
 * The retired flag is still DECLARED on verify/validate so the run can explain
 * the removal rather than emit Commander's bare `unknown option '--only'`; that
 * contract is pinned in the `rejectRetiredOnly` block at the bottom.
 *
 * Selection is pure — config in, a decision out — so it is stated here rather
 * than through a subprocess.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { selectBuildPhases } from '../../src/commands/build.js';
import {
  decidePhaseSelection,
  rejectRetiredOnly,
  type Phase,
  type PhaseSelection,
} from '../../src/commands/phase-utils.js';
import { selectValidateSurfaces } from '../../src/commands/validate.js';
import {
  checkFilesConfigDests,
  formatVerifyAnnouncement,
  selectVerifyPhases,
} from '../../src/commands/verify.js';

/** Narrow to the `run` arm, failing loudly (not silently passing) otherwise. */
function runPhases(selection: PhaseSelection): Phase[] {
  if (selection.kind !== 'run') {
    throw new Error(`Expected a 'run' selection, got '${selection.kind}': ${JSON.stringify(selection)}`);
  }
  return selection.phases;
}

/** The names of a `run` arm's phases. */
function phaseNames(selection: PhaseSelection): string[] {
  return runPhases(selection).map((p) => p.name);
}

/** The message of a `fail` arm, failing loudly if the selection was not a failure. */
function failMessage(selection: PhaseSelection): string {
  if (selection.kind !== 'fail') {
    throw new Error(`Expected a 'fail' selection, got '${selection.kind}': ${JSON.stringify(selection)}`);
  }
  return selection.message;
}

/**
 * Run `rejectRetiredOnly` with `process.exit` and `process.stderr.write`
 * captured. `exit` is stubbed to THROW rather than return, because the real one
 * never returns: a stub that returns would let execution fall through into code
 * the production path can never reach, and the test would then be asserting
 * against a control flow that does not exist.
 */
function captureRetiredOnly(only: string | undefined): {
  stderr: string;
  exited: number | undefined;
} {
  let stderr = '';
  let exited: number | undefined;
  const writeSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exited = code;
    throw new Error('process.exit');
  }) as never);

  try {
    rejectRetiredOnly(only, 'vat validate', 35);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'process.exit') throw error;
  } finally {
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { stderr, exited };
}

const SKILL_GLOB = '**/SKILL.md';

const CONFIG_RESOURCES_ONLY = { version: 1, resources: {} } as unknown as ProjectConfig;
const CONFIG_SKILLS_ONLY = { version: 1, skills: { include: [SKILL_GLOB] } } as unknown as ProjectConfig;
const CONFIG_BOTH = {
  version: 1,
  resources: {},
  skills: { include: [SKILL_GLOB] },
} as unknown as ProjectConfig;
const CONFIG_EMPTY = { version: 1 } as unknown as ProjectConfig;
/** What a config that exists but does not parse hands back to the orchestrator. */
const BROKEN_CONFIG_ERROR = 'Failed to load config: bad yaml';
const CONFIG_MARKETPLACE = {
  version: 1,
  skills: { include: [SKILL_GLOB] },
  claude: { marketplaces: { 'test-tools': {} } },
} as unknown as ProjectConfig;

describe('selectVerifyPhases', () => {
  it('runs only the surfaces the config declares', () => {
    // Config-gating is what closed the headline incoherence (a `verify` run
    // claiming coverage of a surface its config does not declare). `--only` is
    // gone; the gating it exposed is not.
    expect(phaseNames(selectVerifyPhases(CONFIG_RESOURCES_ONLY))).toEqual(['resources']);
    expect(phaseNames(selectVerifyPhases(CONFIG_SKILLS_ONLY))).toEqual(['skills']);
    expect(phaseNames(selectVerifyPhases(CONFIG_BOTH))).toEqual(['resources', 'skills']);
  });

  it('includes one subprocess phase per configured marketplace', () => {
    expect(phaseNames(selectVerifyPhases(CONFIG_MARKETPLACE))).toEqual([
      'skills',
      'marketplace:test-tools',
    ]);
  });

  it('is a warned no-op when nothing at all is configured', () => {
    const selection = selectVerifyPhases(CONFIG_EMPTY);

    expect(selection.kind).toBe('noop');
  });

  it('still runs every phase when the config could not be read', () => {
    // A broken config is not "the surface is unconfigured" — we do not know what
    // it declares. Run the children and let THEM report the config error
    // (exit 2), rather than answering an unknown with a confident "not
    // configured".
    expect(phaseNames(selectVerifyPhases(undefined, BROKEN_CONFIG_ERROR))).toEqual([
      'resources',
      'skills',
    ]);
  });

  it('passes no --verbose to any child by default', () => {
    expect(runPhases(selectVerifyPhases(CONFIG_MARKETPLACE)).map((p) => p.args)).toEqual([
      ['skills', 'validate'],
      ['claude', 'marketplace', 'validate', 'dist/.claude/plugins/marketplaces/test-tools'],
    ]);
  });

  it('forwards --verbose to every subprocess phase', () => {
    // The children own their own summarization: `vat verify` nests each child's
    // document verbatim, so the only way it can ask for the detailed form is to
    // relay the flag. A phase left off this list silently keeps its compact
    // default while the operator believes they asked the whole run for detail.
    const phases = runPhases(selectVerifyPhases(CONFIG_MARKETPLACE, undefined, true));

    expect(phases.map((p) => p.args)).toEqual([
      ['skills', 'validate', '--verbose'],
      [
        'claude',
        'marketplace',
        'validate',
        'dist/.claude/plugins/marketplaces/test-tools',
        '--verbose',
      ],
    ]);
    for (const phase of phases) {
      expect(phase.args).toContain('--verbose');
    }
  });

  it('forwards --verbose to the resources phase too', () => {
    expect(runPhases(selectVerifyPhases(CONFIG_BOTH, undefined, true)).map((p) => p.args)).toEqual([
      ['resources', 'validate', '--verbose'],
      ['skills', 'validate', '--verbose'],
    ]);
  });
});

describe('decidePhaseSelection', () => {
  const VOCAB = {
    noun: 'Phase',
    verb: 'verify',
    validNames: ['resources', 'skills'],
  } as const;

  it('reports the config error rather than a confident "not configured"', () => {
    // `emptyIsValid` used to be checked BEFORE this arm, so `vat verify --only
    // consistency` against an unparseable config answered "no skills: block"
    // and exited 1 on a config it had never managed to read. `emptyIsValid` is
    // deleted with `--only`, and this is the arm that must win when a phase list
    // comes out empty on an unreadable config.
    const selection = decidePhaseSelection(undefined, [], VOCAB, {
      unreadableConfig: BROKEN_CONFIG_ERROR,
    });

    expect(selection).toEqual({ kind: 'fail', message: BROKEN_CONFIG_ERROR });
  });
});

describe('formatVerifyAnnouncement', () => {
  /** The announcement for a config, built from that run's own selection. */
  const announce = (config: ProjectConfig): string =>
    formatVerifyAnnouncement(phaseNames(selectVerifyPhases(config)), config);

  it('names the in-process phases a run also executes', () => {
    // The announcement used to list the SUBPROCESS phases only, so a run
    // printed 'resources → skills' and then ran two more phases, one of which
    // (consistency) contributed its own entry to the emitted document.
    expect(announce(CONFIG_BOTH)).toBe(
      '🔍 vat verify (phases: resources → skills → files-config-dests → consistency)',
    );
  });

  it('names files-config-dests and consistency alongside skills', () => {
    // All three read the same `skills:` block, so a run that has one runs all
    // three. The announcement must not deny that coupling.
    expect(announce(CONFIG_SKILLS_ONLY)).toBe(
      '🔍 vat verify (phases: skills → files-config-dests → consistency)',
    );
  });

  it('names no in-process phase when the project declares no skills:', () => {
    // The first fix traded under-reporting for OVER-reporting. Both in-process
    // phases read the same input — the `skills:` block. Without one,
    // `checkFilesConfigDests` has no `files:` entry to resolve and
    // `runConsistencyPhase` returns before its first lookup, so a run on a
    // resources-only project announced 'resources → files-config-dests →
    // consistency' and emitted a document containing `resources` and nothing
    // else. An operator reading that line believed distribution consistency had
    // been checked. It had not, and nothing said so.
    expect(announce(CONFIG_RESOURCES_ONLY)).toBe('🔍 vat verify (phases: resources)');
  });

  it('names no in-process phase when the config could not be read', () => {
    // An unreadable config still runs the subprocess phases so the CHILD reports
    // the real error. The in-process phases cannot even look:
    // `checkFilesConfigDests` re-reads the same broken file and yields nothing.
    expect(formatVerifyAnnouncement(['resources', 'skills'], undefined)).toBe(
      '🔍 vat verify (phases: resources → skills)',
    );
  });
});

describe('checkFilesConfigDests', () => {
  it('reports nothing for a project with no skills: block', () => {
    // Load-bearing for the announcement above. Dropping `files-config-dests`
    // from a no-`skills:` run changes the announced phase list and never the
    // findings: both `defaults.files` and `config.<skill>.files` live under
    // `skills:`, so the merged files config is empty for every candidate and
    // the scan has nothing to resolve. Without this, "the executed set is
    // unchanged" would be an argument rather than a check.
    const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-verify-no-skills-'));
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is this test's own mkdtemp dir
      writeFileSync(
        safePath.join(dir, 'vibe-agent-toolkit.config.yaml'),
        'version: 1\nresources:\n  include: ["docs/**/*.md"]\n',
      );

      expect(checkFilesConfigDests(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('selectBuildPhases', () => {
  it('forwards --verbose to every spawned phase, or to none', () => {
    // Each phase is its own process: a flag not in `args` cannot reach it, so
    // `vat build --verbose` would silently produce the collapsed report.
    expect(selectBuildPhases(undefined, true, true).phases.map((p) => p.args)).toEqual([
      ['skills', 'build', '--verbose'],
      ['claude', 'plugin', 'build', '--verbose'],
    ]);
    expect(selectBuildPhases(undefined, true, false).phases.map((p) => p.args)).toEqual([
      ['skills', 'build'],
      ['claude', 'plugin', 'build'],
    ]);
  });

  it('builds skills, and claude only when marketplaces are configured', () => {
    expect(phaseNames(selectBuildPhases(undefined, false))).toEqual(['skills']);
    expect(phaseNames(selectBuildPhases(undefined, true))).toEqual(['skills', 'claude']);
  });

  it('does not tell the user that "claude" is both unknown and valid', () => {
    // The old message was self-refuting: "Unknown phase: claude. Valid phases:
    // skills, claude." The phase is recognized; it is just not configured.
    const message = failMessage(selectBuildPhases('claude', false));

    expect(message).not.toContain('Unknown phase');
    expect(message).toContain("Phase 'claude' is not configured");
  });

  it('fails --only for an unrecognized phase name', () => {
    const message = failMessage(selectBuildPhases('bogus', true));

    expect(message).toContain('Unknown phase: bogus');
    expect(message).toContain('skills, claude');
  });
});

describe('selectValidateSurfaces', () => {
  it('runs only the surfaces the config declares', () => {
    expect(phaseNames(selectValidateSurfaces(CONFIG_BOTH))).toEqual(['resources', 'skills']);
    expect(phaseNames(selectValidateSurfaces(CONFIG_RESOURCES_ONLY))).toEqual(['resources']);
  });

  it('is a warned no-op when nothing at all is configured', () => {
    expect(selectValidateSurfaces(CONFIG_EMPTY).kind).toBe('noop');
  });
});

describe('rejectRetiredOnly', () => {
  it('is a no-op when --only was not passed', () => {
    const { stderr, exited } = captureRetiredOnly(undefined);

    expect(stderr).toBe('');
    expect(exited).toBeUndefined();
  });

  it('fails with exit 1 when --only was passed', () => {
    // Exit 1, not 0: a CI gate that was failing on a bad --only must keep
    // failing across the removal rather than flip to green.
    expect(captureRetiredOnly('skills').exited).toBe(1);
  });

  /**
   * The whole point of declaring a retired flag is the diagnosis. Commander's
   * bare `unknown option '--only'` names the flag and nothing else — the reader
   * cannot tell a typo from a removal, and has no way to learn what replaced
   * it. Each assertion below is one thing that error could not say.
   */
  it('names the removal, the command, the evidence, and where --only still works', () => {
    const { stderr } = captureRetiredOnly('skills');

    expect(stderr).toContain("'--only' was removed");
    expect(stderr).toContain('vat validate');
    expect(stderr).toContain('~35s');
    expect(stderr).toContain('vat build --only');
  });
});
