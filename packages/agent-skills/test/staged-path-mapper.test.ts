/**
 * `stagedPathMapper` / `reanchorStagedResult`: every path a package result publishes,
 * written into a plan's staged tree, re-anchored onto where the swap landed it — the
 * packager's own plan, `vat skills build`'s, and `vat claude plugin build`'s.
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { reanchorStagedResult, stagedPathMapper, type PackageSkillResult } from '../src/skill-packager.js';
import type { PackagingValidationResult } from '../src/validators/packaging-validator.js';

const ROOT = '/project';
/** A staged tree with its random suffix spelled out, so the mapper is real. */
const STAGED = `${ROOT}/dist/.skills.vat-staged-abc123`;
const DEST = `${ROOT}/dist/skills`;
const mapPath = stagedPathMapper(ROOT, STAGED, DEST);

function resultWith(overrides: Partial<PackageSkillResult>): PackageSkillResult {
  return {
    outputPath: `${STAGED}/demo`,
    skill: { name: 'demo' },
    files: { root: 'SKILL.md', dependencies: [] },
    hasErrors: false,
    residue: [],
    ...overrides,
  };
}

const stagedIssue = (location: string): ValidationIssue => ({
  code: 'PACKAGED_BROKEN_LINK',
  severity: 'error',
  message: 'A packaged link resolves to nothing.',
  location,
});

describe('stagedPathMapper', () => {
  it('maps the absolute and the root-relative spelling of a staged path, each to its own spelling', () => {
    expect(mapPath(`${STAGED}/demo/SKILL.md`)).toBe(`${DEST}/demo/SKILL.md`);
    expect(mapPath('dist/.skills.vat-staged-abc123/demo/SKILL.md')).toBe('dist/skills/demo/SKILL.md');
    expect(mapPath(STAGED)).toBe(DEST);
  });

  it('never rewrites the parked sibling whose name only starts with the staged tree\'s', () => {
    expect(mapPath(`${STAGED}.previous/demo/SKILL.md`)).toBe(`${STAGED}.previous/demo/SKILL.md`);
  });
});

describe('reanchorStagedResult - BOTH post-build channels are re-anchored', () => {
  it('re-anchors the output and a location on the postBuildIssues channel', () => {
    const result = reanchorStagedResult(
      resultWith({ postBuildIssues: [stagedIssue('dist/.skills.vat-staged-abc123/demo/pack/b.md')] }),
      mapPath,
    );

    expect(result.outputPath).toBe(`${DEST}/demo`);
    expect(result.postBuildIssues?.[0]?.location).toBe('dist/skills/demo/pack/b.md');
  });

  it('re-anchors a location on the postBuildValidation channel', () => {
    const result = reanchorStagedResult(
      resultWith({
        postBuildValidation: {
          allErrors: [stagedIssue('dist/.skills.vat-staged-abc123/demo/SKILL.md')],
        } as PackagingValidationResult,
      }),
      mapPath,
    );

    expect(result.postBuildValidation?.allErrors[0]?.location).toBe('dist/skills/demo/SKILL.md');
  });

  it('leaves a location that names no staged path alone', () => {
    const result = reanchorStagedResult(
      resultWith({ postBuildIssues: [stagedIssue('resources/skills/demo/extra/CLAUDE.md')] }),
      mapPath,
    );

    expect(result.postBuildIssues?.[0]?.location).toBe('resources/skills/demo/extra/CLAUDE.md');
  });
});
