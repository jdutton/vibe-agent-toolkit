/**
 * Unit tests for `--only` phase/surface selection across the three top-level
 * orchestrators (`vat build`, `vat verify`, `vat validate`).
 *
 * Two defects these pin:
 *
 *  1. **`vat verify --only <unconfigured surface>` silently passed.** It pushed
 *     `resources` and `skills` without ever consulting the config, so
 *     `vat verify --only skills` in a project with no `skills:` block exited 0
 *     while `vat validate --only skills` on the same project exited 1. A CI gate
 *     pinned to `vat verify --only skills` therefore stayed green forever the
 *     moment the config key was renamed.
 *
 *  2. **An unroutable `--only` threw outside the try block.** The user got a raw
 *     Node stack trace, zero bytes of stdout, and an exit 1 masquerading as
 *     "validation errors". `vat build`'s message was self-refuting on top of
 *     that: "Unknown phase: claude. Valid phases: skills, claude."
 *
 * Selection is pure — (only, config) in, a decision out — so it is stated here
 * rather than through a subprocess.
 */

import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { selectBuildPhases } from '../../src/commands/build.js';
import { type PhaseSelection } from '../../src/commands/phase-utils.js';
import { selectValidateSurfaces } from '../../src/commands/validate.js';
import { selectVerifyPhases } from '../../src/commands/verify.js';

/** Narrow to the `run` arm, failing loudly (not silently passing) otherwise. */
function phaseNames(selection: PhaseSelection): string[] {
  if (selection.kind !== 'run') {
    throw new Error(`Expected a 'run' selection, got '${selection.kind}': ${JSON.stringify(selection)}`);
  }
  return selection.phases.map((p) => p.name);
}

/** The message of a `fail` arm, failing loudly if the selection was not a failure. */
function failMessage(selection: PhaseSelection): string {
  if (selection.kind !== 'fail') {
    throw new Error(`Expected a 'fail' selection, got '${selection.kind}': ${JSON.stringify(selection)}`);
  }
  return selection.message;
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
const CONFIG_MARKETPLACE = {
  version: 1,
  skills: { include: [SKILL_GLOB] },
  claude: { marketplaces: { 'test-tools': {} } },
} as unknown as ProjectConfig;

describe('selectVerifyPhases', () => {
  it('runs only the surfaces the config declares', () => {
    expect(phaseNames(selectVerifyPhases(undefined, CONFIG_RESOURCES_ONLY))).toEqual(['resources']);
    expect(phaseNames(selectVerifyPhases(undefined, CONFIG_SKILLS_ONLY))).toEqual(['skills']);
    expect(phaseNames(selectVerifyPhases(undefined, CONFIG_BOTH))).toEqual(['resources', 'skills']);
  });

  it('fails --only for a recognized phase that is not configured', () => {
    // The headline incoherence: this used to be a silent exit-0 pass while
    // `vat validate --only skills` on the same project exited 1.
    expect(failMessage(selectVerifyPhases('skills', CONFIG_RESOURCES_ONLY))).toContain(
      "Phase 'skills' is not configured",
    );
    expect(failMessage(selectVerifyPhases('resources', CONFIG_SKILLS_ONLY))).toContain(
      "Phase 'resources' is not configured",
    );
  });

  it('fails --only for an unrecognized phase name', () => {
    const message = failMessage(selectVerifyPhases('bogus', CONFIG_BOTH));

    expect(message).toContain('Unknown phase: bogus');
    expect(message).toContain('resources, skills, marketplace, consistency');
  });

  it('fails --only marketplace when no marketplaces are configured', () => {
    expect(failMessage(selectVerifyPhases('marketplace', CONFIG_SKILLS_ONLY))).toContain(
      "Phase 'marketplace' is not configured",
    );
  });

  it('includes one subprocess phase per configured marketplace', () => {
    expect(phaseNames(selectVerifyPhases('marketplace', CONFIG_MARKETPLACE))).toEqual([
      'marketplace:test-tools',
    ]);
  });

  it('accepts --only consistency with an empty subprocess phase list', () => {
    // consistency runs in-process; an empty subprocess list is not an error.
    expect(phaseNames(selectVerifyPhases('consistency', CONFIG_SKILLS_ONLY))).toEqual([]);
  });

  it('is a warned no-op when nothing at all is configured', () => {
    const selection = selectVerifyPhases(undefined, CONFIG_EMPTY);

    expect(selection.kind).toBe('noop');
  });

  it('still runs the requested phase when the config could not be read', () => {
    // A broken config is not "the surface is unconfigured" — we do not know what
    // it declares. Run the child and let IT report the config error (exit 2),
    // rather than answering an unknown with a confident "not configured".
    expect(phaseNames(selectVerifyPhases('resources', undefined, 'Failed to load config: bad yaml'))).toEqual([
      'resources',
    ]);
  });

  it('fails with the config error when a broken config makes the request unanswerable', () => {
    expect(failMessage(selectVerifyPhases('marketplace', undefined, 'Failed to load config: bad yaml'))).toContain(
      'Failed to load config',
    );
  });
});

describe('selectBuildPhases', () => {
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
    expect(phaseNames(selectValidateSurfaces(undefined, CONFIG_BOTH))).toEqual(['resources', 'skills']);
    expect(phaseNames(selectValidateSurfaces(undefined, CONFIG_RESOURCES_ONLY))).toEqual(['resources']);
  });

  it('fails --only for an unconfigured or unrecognized surface', () => {
    expect(failMessage(selectValidateSurfaces('skills', CONFIG_RESOURCES_ONLY))).toContain(
      "Surface 'skills' is not configured",
    );
    expect(failMessage(selectValidateSurfaces('bogus', CONFIG_BOTH))).toContain('Unknown surface: bogus');
  });

  it('is a warned no-op when nothing at all is configured', () => {
    expect(selectValidateSurfaces(undefined, CONFIG_EMPTY).kind).toBe('noop');
  });
});
