/**
 * Regression tests: a project whose skills come from `skills.include` discovery
 * and NOT from `skills.config` must not silently emit an empty manifest.
 *
 * 🪤 Found by running the command rather than by reading it. Driving
 * `vat ard emit` against a project with `skills.include: [skills/*\/SKILL.md]`
 * and no `skills.config` printed **"Wrote 0 ARD entries"** and exited **0**,
 * leaving a manifest of `{"entries": []}` on disk. Nothing said why.
 *
 * That matters more here than a normal empty result, because `skills.config` is
 * OPTIONAL in VAT — glob discovery is the ordinary way to declare skills, and
 * this repo's own config uses it. So the headline use case ("announce the
 * skills I publish") produced nothing, silently, for the common shape.
 *
 * The fix reuses the mechanism that already existed for a surface VAT will not
 * type: a `skipped` entry with an actionable reason, which the command prints to
 * stderr. Exit stays 0 — nothing failed — but the run stops being quiet about
 * having advertised nothing.
 */
import type { ProjectConfig } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { collectArdSurfaces } from '../src/commands/ard/surfaces.js';

/** No package version to stamp; irrelevant to which surfaces are collected. */
const NO_DEFAULTS = {} as const;

/** The discovery glob every fixture below declares. */
const SKILL_GLOB = 'skills/*/SKILL.md';

const ARD: ProjectConfig['ard'] = {
  publisher: 'example.com',
  baseUrl: 'https://example.com',
};

/** Skills declared only by discovery glob — no `skills.config` at all. */
const DISCOVERY_ONLY: ProjectConfig = {
  version: 1,
  skills: { include: [SKILL_GLOB] },
  ard: ARD,
};

/** `skills.config` present but empty, which is the same silence by a other route. */
const EMPTY_CONFIG: ProjectConfig = {
  version: 1,
  skills: { include: [SKILL_GLOB], config: {} },
  ard: ARD,
};

describe('ARD surface collection when skills are discovered, not configured', () => {
  it('reports the gap instead of emitting nothing quietly', () => {
    const { surfaces, skipped } = collectArdSurfaces(DISCOVERY_ONLY, NO_DEFAULTS);

    expect(surfaces).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.kind).toBe('skill');
  });

  it('names `skills.config` in the reason, so the fix needs no docs lookup', () => {
    const { skipped } = collectArdSurfaces(DISCOVERY_ONLY, NO_DEFAULTS);

    expect(skipped[0]?.reason).toContain('skills.config');
  });

  it('treats an empty `skills.config` the same as an absent one', () => {
    const { surfaces, skipped } = collectArdSurfaces(EMPTY_CONFIG, NO_DEFAULTS);

    expect(surfaces).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toContain('skills.config');
  });

  it('says nothing when the project declares no skills at all', () => {
    // Absence of a `skills` block is not a gap — there is nothing to advertise
    // and no mistake to point at. Warning here would train people to ignore it.
    const { surfaces, skipped } = collectArdSurfaces({ version: 1, ard: ARD }, NO_DEFAULTS);

    expect(surfaces).toHaveLength(0);
    expect(skipped.filter((s) => s.kind === 'skill')).toHaveLength(0);
  });

  it('says nothing once a skill IS configured — the guard must not cry wolf', () => {
    const configured: ProjectConfig = {
      version: 1,
      skills: { include: [SKILL_GLOB], config: { expenses: {} } },
      ard: ARD,
    };

    const { surfaces, skipped } = collectArdSurfaces(configured, NO_DEFAULTS);

    expect(surfaces).toHaveLength(1);
    expect(skipped.filter((s) => s.kind === 'skill')).toHaveLength(0);
  });
});
