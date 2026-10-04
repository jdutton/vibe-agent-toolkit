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
import { ExitCode, exitCodeForReport } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { selectBuildPhases } from '../../src/commands/build.js';
import { PACKAGED_CONTENT_REPORT_SCHEMA } from '../../src/commands/orchestrator-schema.js';
import {
  decidePhaseSelection,
  rejectRetiredOnly,
  type Phase,
  type PhaseSelection,
} from '../../src/commands/phase-utils.js';
import { selectValidateSurfaces } from '../../src/commands/validate.js';
import {
  buildPackagedContentPhase,
  formatVerifyAnnouncement,
  runFilesConfigDestsPhase,
  selectVerifyPhases,
} from '../../src/commands/verify.js';
import { reportShapeFor } from '../../src/report-schemas.js';
import { fakePluginLocalIndex } from '../helpers/plugin-local-fixture.js';
import { silentLogger } from '../test-doubles.js';

/**
 * The three phase entry points a selection can bind, stubbed.
 *
 * A phase used to carry an argv array, so "did this phase get `--verbose`" was
 * answerable by reading `phase.args`. It carries a bound closure now, so the
 * only honest way to ask is to RUN it and see what the entry point was called
 * with — which is also the thing that actually matters. A test that inspected a
 * serialized argv could pass while the option never reached the function.
 */
/** What every stubbed phase returns: a completed run over one thing. Hoisted, since `vi.mock` is. */
const { STUB_REPORT } = vi.hoisted(() => ({
  STUB_REPORT: { status: 'ok', examined: 1, findings: [], summary: { errors: 0, warnings: 0, info: 0 }, gate: { strict: false }, data: null },
}));

vi.mock('../../src/commands/resources/validate.js', () => ({
  runResourcesValidatePhase: vi.fn(() => Promise.resolve({ report: STUB_REPORT })),
}));
vi.mock('../../src/commands/skills/validate.js', () => ({
  runSkillsValidatePhase: vi.fn(() => Promise.resolve({ report: STUB_REPORT })),
}));
vi.mock('../../src/commands/claude/marketplace/validate.js', () => ({
  runMarketplaceValidatePhase: vi.fn(() => Promise.resolve({ report: STUB_REPORT })),
}));
vi.mock('../../src/commands/skills/build.js', () => ({
  runSkillsBuildPhase: vi.fn(() => Promise.resolve({ report: STUB_REPORT })),
}));
vi.mock('../../src/commands/claude/plugin/build.js', () => ({
  runClaudePluginBuildPhase: vi.fn(() => Promise.resolve({ report: STUB_REPORT })),
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

/** Run `rejectRetiredOnly`, returning the refusal it threw — or `undefined` when it threw none. */
function retiredOnlyRefusal(only: string | undefined): { refusal: string; message: string } | undefined {
  try {
    rejectRetiredOnly(only, 'vat validate', 35);
    return undefined;
  } catch (error) {
    return error as { refusal: string; message: string };
  }
}

const SKILL_GLOB = '**/SKILL.md';

const CONFIG_RESOURCES_ONLY = { resources: {} } as unknown as ProjectConfig;
const CONFIG_SKILLS_ONLY = { skills: { include: [SKILL_GLOB] } } as unknown as ProjectConfig;
const CONFIG_BOTH = {
  resources: {},
  skills: { include: [SKILL_GLOB] },
} as unknown as ProjectConfig;
const CONFIG_EMPTY = {} as unknown as ProjectConfig;
/** What a config that exists but does not parse hands back to the orchestrator. */
const BROKEN_CONFIG_ERROR = 'Failed to load config: bad yaml';
const CONFIG_MARKETPLACE = {
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

/**
 * Every delegated phase is held to its OWN verb's registered report schema.
 *
 * The orchestrator's schema carries a phase's `data` as `unknown`; what keeps
 * that data honest is `runPhase` parsing each report against `phase.schema`.
 * So the binding is the contract: a phase wired to the wrong schema, or to a
 * permissive one, would fold data its verb does not describe.
 */
describe('each delegated phase names its verb\'s registered schema', () => {
  const REGISTERED: Record<string, string> = {
    resources: 'resources validate',
    skills: 'skills validate',
    'marketplace:test-tools': 'claude marketplace validate',
  };

  it.each([
    ['vat verify', () => selectVerifyPhases({ ...CONFIG_BOTH, claude: CONFIG_MARKETPLACE.claude } as ProjectConfig)],
    ['vat validate', () => selectValidateSurfaces(CONFIG_BOTH)],
  ])('%s', (_label, select) => {
    const phases = runPhases(select());
    expect(phases.length).toBeGreaterThan(0);
    for (const phase of phases) {
      const verb = REGISTERED[phase.name];
      if (verb === undefined) throw new Error(`no registered verb expected for phase '${phase.name}'`);
      expect(phase.schema, phase.name).toBe(reportShapeFor(verb).schema);
    }
  });

  it('vat build', () => {
    const [skills, claude] = runPhases(selectBuildPhases(undefined, true));
    expect(skills?.schema).toBe(reportShapeFor('skills build').schema);
    expect(claude?.schema).toBe(reportShapeFor('claude plugin build').schema);
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

    expect(selection).toEqual({ kind: 'fail', code: 'CONFIG_INVALID', message: BROKEN_CONFIG_ERROR });
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
    // `runFilesConfigDestsPhase` has no `files:` entry to resolve and
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
    // `runFilesConfigDestsPhase` re-reads the same broken file and yields nothing.
    expect(formatVerifyAnnouncement(['resources', 'skills'], undefined)).toBe(
      '🔍 vat verify (phases: resources → skills)',
    );
  });
});

describe('runFilesConfigDestsPhase', () => {
  it('reports nothing for a project with no skills: block', () => {
    // Load-bearing for the announcement above. Dropping `files-config-dests`
    // from a no-`skills:` run changes the announced phase list and never the
    // findings: both `defaults.files` and `config.<skill>.files` live under
    // `skills:`, so the merged files config is empty for every candidate and
    // the scan has nothing to resolve. Without this, "the executed set is
    // unchanged" would be an argument rather than a check.
    const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-verify-no-skills-'));
    try {
      writeFileSync(
        safePath.join(dir, 'vibe-agent-toolkit.config.yaml'),
        'resources:\n  include: ["docs/**/*.md"]\n',
      );

      // `[]` is what the command itself passes here: with no `skills:` block
      // there is nothing to discover, so this is the real input, not a stub.
      const { report } = runFilesConfigDestsPhase(dir, [], fakePluginLocalIndex([]), new Map(), silentLogger);
      expect([report.examined, report.findings]).toEqual([0, []]);
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
  it('is a no-op when --only was not passed', () => {
    expect(retiredOnlyRefusal(undefined)).toBeUndefined();
  });

  it('refuses the run as USAGE_INVALID when --only was passed', () => {
    // A flag the command no longer has is a usage mistake (exit 2), not a
    // finding — and a CI gate that was failing on a bad --only keeps failing.
    expect(retiredOnlyRefusal('skills')?.refusal).toBe('USAGE_INVALID');
  });

  /**
   * The whole point of declaring a retired flag is the diagnosis. Commander's
   * bare `unknown option '--only'` names the flag and nothing else — the reader
   * cannot tell a typo from a removal, and has no way to learn what replaced
   * it. Each assertion below is one thing that error could not say.
   */
  it('names the removal, the command, the evidence, and where --only still works', () => {
    const message = retiredOnlyRefusal('skills')?.message ?? '';

    expect(message).toContain("'--only' was removed");
    expect(message).toContain('vat validate');
    expect(message).toContain('~35s');
    expect(message).toContain('vat build --only');
  });
});

/** The one code the packaged-content phase emits of its own accord. */
const PACKAGED_CODE = 'PACKAGED_AGENT_INSTRUCTION_FILE';
/** Where such a finding lands in a built bundle. */
const PACKAGED_LOCATION = 'dist/skills/demo/CLAUDE.md';

/**
 * The `packaged-content` phase must never report `ok` over zero bundles.
 *
 * The phase is pushed unconditionally whenever `skills:` exists, and it feeds
 * the real exit code. `discoverSkillsFromConfig` returning `[]` on a typo'd
 * glob — or `dist/` simply not having been built — gave it nothing to crawl,
 * and nothing crawled was zero findings was a pass, with no count in the
 * document to say so. The phase publishes the count as `examined` and refuses a
 * zero itself, ONE non-overridable `RESOURCE_CHECK_BROKEN` at `error`.
 */
describe('buildPackagedContentPhase — a phase over zero bundles is not a verdict', () => {
  const RUN_INTEGRITY_CODE = 'RESOURCE_CHECK_BROKEN';

  it('refuses zero bundles as error with ONE run-integrity finding', () => {
    // 🔑 The reproduced case. Delete the guard and this reds: no issue, so the
    // status collapses to `success` beside a count nobody published.
    const phase = buildPackagedContentPhase({ bundlesInspected: 0, bundlesExpected: 0, bundlesInPlace: 0, bundlesMissing: [], issues: [] });

    expect(phase.name).toBe('packaged-content');
    expect(phase.report.status).toBe('findings');
    expect(exitCodeForReport(phase.report)).toBe(ExitCode.FINDINGS);
    expect(phase.report.examined).toBe(0);
    expect(phase.report.summary).toEqual({ errors: 1, warnings: 0, info: 0 });
    expect(phase.report.findings.map((i) => [i.code, i.severity])).toEqual([[RUN_INTEGRITY_CODE, 'error']]);
    expect(phase.report.findings[0]?.message).toContain('vat build');
    expect(phase.report.findings[0]?.message).toContain('skills.include');
  });

  it('publishes the count and stays silent once a bundle was inspected', () => {
    // 🔑 The over-correction guard.
    const phase = buildPackagedContentPhase({ bundlesInspected: 2, bundlesExpected: 2, bundlesInPlace: 0, bundlesMissing: [], issues: [] });

    expect(phase.report.status).toBe('ok');
    expect(phase.report.examined).toBe(2);
    expect(phase.report.findings).toEqual([]);
    // What it crawled is `examined`; `data` is only what it should have found —
    // exactly what the phase's published schema describes, strictly.
    expect(phase.report.data).toEqual({ bundlesExpected: 2, bundlesInPlace: 0, bundlesMissing: [] });
    expect(() => PACKAGED_CONTENT_REPORT_SCHEMA.parse(phase.report)).not.toThrow();
  });

  it('carries real findings through unchanged, count beside them', () => {
    const phase = buildPackagedContentPhase({
      bundlesInspected: 1,
      bundlesExpected: 1,
      bundlesInPlace: 0,
      bundlesMissing: [],
      issues: [{
        code: PACKAGED_CODE,
        severity: 'warning',
        message: 'shipped',
        location: PACKAGED_LOCATION,
      }],
    });

    expect(phase.report.status).toBe('findings');
    expect(exitCodeForReport(phase.report)).toBe(ExitCode.OK);
    expect(phase.report.examined).toBe(1);
    expect(phase.report.findings).toEqual([{
      code: PACKAGED_CODE,
      severity: 'warning',
      message: 'shipped',
      location: PACKAGED_LOCATION,
    }]);
  });
});
