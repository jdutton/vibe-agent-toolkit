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
  toPublishedIssue,
} from '../../src/commands/verify.js';
import { captureProcessExit, type CapturedExit } from '../test-doubles.js';

/**
 * The three phase entry points a selection can bind, stubbed.
 *
 * A phase used to carry an argv array, so "did this phase get `--verbose`" was
 * answerable by reading `phase.args`. It carries a bound closure now, so the
 * only honest way to ask is to RUN it and see what the entry point was called
 * with — which is also the thing that actually matters. A test that inspected a
 * serialized argv could pass while the option never reached the function.
 */
vi.mock('../../src/commands/resources/validate.js', () => ({
  runResourcesValidatePhase: vi.fn(() => Promise.resolve({ document: undefined, exitCode: 0 })),
}));
vi.mock('../../src/commands/skills/validate.js', () => ({
  runSkillsValidatePhase: vi.fn(() => Promise.resolve({ document: undefined, exitCode: 0 })),
}));
vi.mock('../../src/commands/claude/marketplace/validate.js', () => ({
  runMarketplaceValidatePhase: vi.fn(() => Promise.resolve({ document: undefined, exitCode: 0 })),
}));
vi.mock('../../src/commands/skills/build.js', () => ({
  runSkillsBuildPhase: vi.fn(() => Promise.resolve({ document: undefined, exitCode: 0 })),
}));
vi.mock('../../src/commands/claude/plugin/build.js', () => ({
  runClaudePluginBuildPhase: vi.fn(() => Promise.resolve({ document: undefined, exitCode: 0 })),
}));

const { runResourcesValidatePhase } = await import('../../src/commands/resources/validate.js');
const { runSkillsValidatePhase } = await import('../../src/commands/skills/validate.js');
const { runMarketplaceValidatePhase } = await import(
  '../../src/commands/claude/marketplace/validate.js'
);
const { runSkillsBuildPhase } = await import('../../src/commands/skills/build.js');
const { runClaudePluginBuildPhase } = await import('../../src/commands/claude/plugin/build.js');

/** Every stubbed phase entry point, so a run's calls can be cleared as one. */
const PHASE_STUBS = [
  runResourcesValidatePhase,
  runSkillsValidatePhase,
  runMarketplaceValidatePhase,
  runSkillsBuildPhase,
  runClaudePluginBuildPhase,
];

/** Run every phase in a selection, so the stubs record how each was invoked. */
async function invokeAll(selection: PhaseSelection): Promise<void> {
  for (const stub of PHASE_STUBS) vi.mocked(stub).mockClear();
  for (const phase of runPhases(selection)) await phase.run();
}

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
 * captured. See {@link captureProcessExit} for why the exit stub throws.
 */
async function captureRetiredOnly(only: string | undefined): Promise<CapturedExit> {
  return captureProcessExit(() => {
    rejectRetiredOnly(only, 'vat validate', 35);
  });
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

  it('passes verbose: false to every phase by default', async () => {
    await invokeAll(selectVerifyPhases(CONFIG_MARKETPLACE));

    expect(runSkillsValidatePhase).toHaveBeenCalledWith(undefined, { verbose: false });
    expect(runMarketplaceValidatePhase).toHaveBeenCalledWith(
      'dist/.claude/plugins/marketplaces/test-tools',
      { verbose: false },
    );
  });

  it('forwards verbose to every phase', async () => {
    // The phases own their own summarization: `vat verify` nests each document
    // verbatim, so the only way it can ask for the detailed form is to relay the
    // request. A phase left off silently keeps its compact default while the
    // operator believes they asked the whole run for detail.
    await invokeAll(selectVerifyPhases(CONFIG_MARKETPLACE, undefined, true));

    expect(runSkillsValidatePhase).toHaveBeenCalledWith(undefined, { verbose: true });
    expect(runMarketplaceValidatePhase).toHaveBeenCalledWith(
      'dist/.claude/plugins/marketplaces/test-tools',
      { verbose: true },
    );
  });

  it('forwards verbose to the resources phase too', async () => {
    await invokeAll(selectVerifyPhases(CONFIG_BOTH, undefined, true));

    expect(runResourcesValidatePhase).toHaveBeenCalledWith(undefined, { verbose: true });
    expect(runSkillsValidatePhase).toHaveBeenCalledWith(undefined, { verbose: true });
  });

  it('binds each marketplace phase to its OWN path, not the last one in the loop', async () => {
    // The classic closure-in-a-loop defect, and it is newly reachable: the
    // marketplace phase list is built by iterating the adopter's config, and a
    // path captured by reference rather than per iteration would point every
    // phase at whichever marketplace happened to be last.
    const twoMarketplaces = {
      claude: { marketplaces: { alpha: {}, beta: {} } },
    } as unknown as ProjectConfig;

    await invokeAll(selectVerifyPhases(twoMarketplaces));

    expect(vi.mocked(runMarketplaceValidatePhase).mock.calls.map((c) => c[0])).toEqual([
      'dist/.claude/plugins/marketplaces/alpha',
      'dist/.claude/plugins/marketplaces/beta',
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
    // The announcement used to list the DELEGATED phases only, so a run
    // printed 'resources → skills' and then ran two more phases, one of which
    // (consistency) contributed its own entry to the emitted document.
    expect(announce(CONFIG_BOTH)).toBe(
      '🔍 vat verify (phases: resources → skills → files-config-dests → packaged-content → consistency)',
    );
  });

  it('names every in-process phase alongside skills', () => {
    // All of them read the same `skills:` block, so a run that has one runs all
    // of them. The announcement must not deny that coupling.
    expect(announce(CONFIG_SKILLS_ONLY)).toBe(
      '🔍 vat verify (phases: skills → files-config-dests → packaged-content → consistency)',
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
    // An unreadable config still runs the delegated phases so THE PHASE reports
    // the real error. Verify's own phases cannot even look:
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

      // `[]` is what the command itself passes here: with no `skills:` block
      // there is nothing to discover, so this is the real input, not a stub.
      expect(checkFilesConfigDests(dir, [])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('selectBuildPhases', () => {
  it('forwards verbose to every phase, or to none', async () => {
    // A request not relayed to a phase cannot reach it, so `vat build
    // --verbose` would silently produce the collapsed report.
    await invokeAll(selectBuildPhases(undefined, true, true));
    expect(runSkillsBuildPhase).toHaveBeenCalledWith(undefined, { verbose: true });
    expect(runClaudePluginBuildPhase).toHaveBeenCalledWith({ verbose: true });

    await invokeAll(selectBuildPhases(undefined, true, false));
    expect(runSkillsBuildPhase).toHaveBeenCalledWith(undefined, { verbose: false });
    expect(runClaudePluginBuildPhase).toHaveBeenCalledWith({ verbose: false });
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
  it('is a no-op when --only was not passed', async () => {
    const { stderr, exited } = await captureRetiredOnly(undefined);

    expect(stderr).toBe('');
    expect(exited).toBeUndefined();
  });

  it('fails with exit 1 when --only was passed', async () => {
    // Exit 1, not 0: a CI gate that was failing on a bad --only must keep
    // failing across the removal rather than flip to green.
    expect((await captureRetiredOnly('skills')).exited).toBe(1);
  });

  /**
   * The whole point of declaring a retired flag is the diagnosis. Commander's
   * bare `unknown option '--only'` names the flag and nothing else — the reader
   * cannot tell a typo from a removal, and has no way to learn what replaced
   * it. Each assertion below is one thing that error could not say.
   */
  it('names the removal, the command, the evidence, and where --only still works', async () => {
    const { stderr } = await captureRetiredOnly('skills');

    expect(stderr).toContain("'--only' was removed");
    expect(stderr).toContain('vat validate');
    expect(stderr).toContain('~35s');
    expect(stderr).toContain('vat build --only');
  });
});

describe('toPublishedIssue', () => {
  // The archived YAML is what a CI consumer parses; stderr is not. A finding that
  // reaches the document without its anchor names no file at all — the same defect
  // `vat skills build` was fixed for one command over, reproduced here by a
  // `PublishedIssue` shape that declared only {severity, code, message, fix}.
  it('carries the whole anchor into the document', () => {
    expect(toPublishedIssue({
      code: 'PACKAGED_AGENT_INSTRUCTION_FILE',
      severity: 'warning',
      message: 'A repo-internal agent-instruction file is packaged in this bundle.',
      location: 'dist/skills/demo/CLAUDE.md',
      line: 3,
      fix: 'Remove it from the bundle.',
      reference: 'docs/validation-codes.md',
    })).toEqual({
      code: 'PACKAGED_AGENT_INSTRUCTION_FILE',
      severity: 'warning',
      message: 'A repo-internal agent-instruction file is packaged in this bundle.',
      location: 'dist/skills/demo/CLAUDE.md',
      line: 3,
      fix: 'Remove it from the bundle.',
      reference: 'docs/validation-codes.md',
    });
  });

  it('omits the optional keys entirely rather than publishing them as null', () => {
    // `exactOptionalPropertyTypes` distinguishes absent from explicit-undefined,
    // and `yaml.stringify` renders the latter as `location: null` — a claim the
    // finding never made.
    const published = toPublishedIssue({
      code: 'SKILL_MISSING_DESCRIPTION',
      severity: 'error',
      message: 'No description.',
    });

    expect(Object.keys(published).toSorted((a, b) => a.localeCompare(b)))
      .toEqual(['code', 'fix', 'message', 'severity']);
    expect(published.fix).toBe('');
  });
});
