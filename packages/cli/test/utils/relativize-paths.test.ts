/**
 * Re-basing report `path` values onto the run's single stated root.
 *
 * The helper under test is the ONE place a report answers "relative to what?"
 * for a `path`. It has to handle nested carriers too: a report entry that owns
 * a list of sub-entries (audit's `files[].linkedFiles[]`) publishes paths in
 * the same document and under the same contract, so a top-level-only rewrite
 * ships one document in two coordinate systems.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { relativizePath, relativizePathEntries } from '../../src/utils/relativize-paths.js';

/**
 * Synthetic absolute paths, resolved rather than written as literals — on
 * Windows a driveless literal and a resolved path disagree, and
 * `safePath.relative` between them returns a drive-absolute string instead of
 * a subtree-relative one. See commit 6a7b98b3.
 */
const ROOT = safePath.resolve('/report-root');
const SKILL = safePath.resolve('/report-root/skills/alpha/SKILL.md');
const LINKED = safePath.resolve('/report-root/skills/alpha/resources/guide.md');

/** The expected re-based forms, named so the assertions do not repeat literals. */
const SKILL_REL = 'skills/alpha/SKILL.md';
const LINKED_REL = 'skills/alpha/resources/guide.md';

describe('relativizePath', () => {
  it('re-bases an absolute path onto the root as a forward-slashed relative path', () => {
    expect(relativizePath(SKILL, ROOT)).toBe(SKILL_REL);
  });

  it('spells the root itself as "." rather than the empty string', () => {
    // Pointing a report AT a single resource makes that resource the root. An
    // empty path is a value every consumer has to special-case, and
    // `join(root, '')` does not round-trip the way `join(root, '.')` does.
    expect(relativizePath(ROOT, ROOT)).toBe('.');
  });
});

describe('relativizePathEntries', () => {
  it('re-bases every entry path and leaves the other fields untouched', () => {
    const entries = [{ path: SKILL, type: 'agent-skill', issues: [] }];

    const out = relativizePathEntries(entries, ROOT);

    expect(out).toEqual([{ path: SKILL_REL, type: 'agent-skill', issues: [] }]);
  });

  it('does not mutate the entries it was handed', () => {
    const entries = [{ path: SKILL }];

    relativizePathEntries(entries, ROOT);

    expect(entries[0]?.path).toBe(SKILL);
  });

  it('re-bases paths inside a named nested carrier', () => {
    const entries = [
      { path: SKILL, linkedFiles: [{ path: LINKED, lineCount: 3 }] },
    ];

    const out = relativizePathEntries(entries, ROOT, ['linkedFiles']);

    expect(out[0]?.linkedFiles?.[0]).toEqual({
      path: LINKED_REL,
      lineCount: 3,
    });
  });

  it('leaves a nested carrier alone when its key is not declared', () => {
    // Opt-in, never inferred: relativizing is not idempotent (an already
    // relative value would be resolved against cwd), so the caller names the
    // carriers it owns rather than the helper guessing from the shape.
    const entries = [{ path: SKILL, linkedFiles: [{ path: LINKED }] }];

    const out = relativizePathEntries(entries, ROOT);

    expect(out[0]?.linkedFiles?.[0]?.path).toBe(LINKED);
  });

  it('recurses through a declared carrier at every depth', () => {
    const entries = [
      { path: SKILL, linkedFiles: [{ path: LINKED, linkedFiles: [{ path: SKILL }] }] },
    ];

    const out = relativizePathEntries(entries, ROOT, ['linkedFiles']);

    expect(out[0]?.linkedFiles?.[0]?.linkedFiles?.[0]?.path).toBe(SKILL_REL);
  });

  it('tolerates a declared carrier key that is absent or not an array', () => {
    const entries = [{ path: SKILL }, { path: SKILL, linkedFiles: undefined }];

    expect(() => relativizePathEntries(entries, ROOT, ['linkedFiles'])).not.toThrow();
  });
});
