/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
/**
 * The anchor contract, enforced against LIVE validator output.
 *
 * `ValidationIssue` promises four independent anchors — `location` (a
 * project-relative POSIX path), `line`, `field`, `link`. Nothing enforces that
 * at runtime: `ValidationIssueSchema` is never `.parse()`d on real validator
 * output, so a producer that packs `":24"` or `":frontmatter.description"` into
 * `location`, or emits an absolute path, ships silently.
 *
 * This suite is that enforcement. It drives the two skills-lane entry points
 * over one fixture rich enough to fire every historical convention, then
 * asserts the contract over EVERY issue produced — not over a named subset, so
 * a NEW producer with a new convention is caught the day it lands.
 */
import * as fs from 'node:fs';

import { ValidationIssueSchema, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { GitTracker, isAbsoluteAnyPlatform, mkdirSyncReal, normalizedTmpdir, safeExecSync, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateSkillForPackaging } from '../../src/validators/packaging-validator.js';
import { validateSkill } from '../../src/validators/skill-validator.js';

/**
 * A skill that trips as many distinct producers as one file can: a
 * non-kebab name, an over-long description carrying a cross-skill token the
 * frontmatter never declares, an unknown frontmatter field, a broken link, a
 * link to a real-but-gitignored file, a link that escapes the skill directory,
 * an absolute-path capability marker, and an unreferenced sibling doc.
 */
const SKILL_MD = `---
name: Anchor_Contract_Fixture
description: ${'Use this when validating anchors. '.repeat(30)}Run the vat-audit skill first.
unknownField: surprise
---

# Anchor Contract Fixture

Run \`/usr/local/bin/some-tool --check\` before starting.

See [the missing doc](./refs/does-not-exist.md).
See [the ignored doc](./ignored/leaked.md).
See [the escaping doc](../outside/escape.md).
See [the real doc](./refs/real.md).
`;

const MISSING_HREF = './refs/does-not-exist.md';
const IGNORED_HREF = './ignored/leaked.md';

let tempDir: string;
let skillDir: string;
let skillPath: string;
let issues: ValidationIssue[];

beforeAll(async () => {
  tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-anchor-contract-'));
  // A project root that is NOT the skill dir, so a producer that relativizes
  // against the wrong base produces a visibly wrong answer rather than a
  // coincidentally-correct one.
  skillDir = safePath.join(tempDir, 'skills', 'anchor-fixture');
  mkdirSyncReal(safePath.join(skillDir, 'refs'), { recursive: true });
  mkdirSyncReal(safePath.join(skillDir, 'ignored'), { recursive: true });
  mkdirSyncReal(safePath.join(tempDir, 'outside'), { recursive: true });

  fs.writeFileSync(safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n');
  fs.writeFileSync(safePath.join(tempDir, 'outside', 'escape.md'), '# Escape\n');
  fs.writeFileSync(safePath.join(skillDir, 'refs', 'real.md'), '# Real\n');
  fs.writeFileSync(safePath.join(skillDir, 'refs', 'orphan.md'), '# Orphan\n');
  // Exists on disk AND is gitignored — the genuine leak signal, and the
  // control that keeps the missing-target assertion below honest: the two
  // links must reach two DIFFERENT codes.
  fs.writeFileSync(safePath.join(skillDir, 'ignored', 'leaked.md'), '# Leaked\n');
  fs.writeFileSync(safePath.join(tempDir, '.gitignore'), 'skills/anchor-fixture/ignored/\n');
  skillPath = safePath.join(skillDir, 'SKILL.md');
  fs.writeFileSync(skillPath, SKILL_MD);

  // A REAL git repository. Without one, `git ls-files` returns null, the file
  // crawler silently falls back to a glob walk, and every gitignore-dependent
  // branch in the skills lane goes untested — the fixture could only ever
  // exercise the non-repo path. With one but WITHOUT a commit, `git ls-files`
  // returns empty and the registry is empty, so no link issue is produced at
  // all. Both halves are required for this gate to see anything.
  safeExecSync('git', ['init', '-q', '-b', 'main'], { cwd: tempDir });
  safeExecSync('git', ['config', 'user.email', 'test@test'], { cwd: tempDir });
  safeExecSync('git', ['config', 'user.name', 'test'], { cwd: tempDir });
  safeExecSync('git', ['add', '-A'], { cwd: tempDir });
  safeExecSync('git', ['commit', '-q', '-m', 'init'], { cwd: tempDir });

  // Drive the packaging lane the way `vat audit` does — with a pre-populated
  // GitTracker. The tracker's active set is the O(1) ignore oracle in real
  // runs, so a gate that omits it never exercises the oracle that ships.
  const gitTracker = new GitTracker(tempDir);
  await gitTracker.initialize();

  const validated = await validateSkill({ skillPath, checkUnreferencedFiles: true });
  const packaged = await validateSkillForPackaging(skillPath, undefined, 'source', {
    gitTracker,
    locationRoot: tempDir,
  });
  issues = [...validated.issues, ...packaged.allErrors];
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Render an issue compactly so a contract failure names the offender. */
function describeIssue(i: ValidationIssue): string {
  return `${i.code} location=${JSON.stringify(i.location)} line=${String(i.line)} field=${JSON.stringify(i.field)}`;
}

describe('ValidationIssue anchor contract (skills lane)', () => {
  it('produces issues at all (guards against a silently empty fixture)', () => {
    expect(issues.length).toBeGreaterThan(5);
  });

  it('never emits an absolute location', () => {
    const absolute = issues.filter((i) => i.location !== undefined && isAbsoluteAnyPlatform(i.location));
    expect(absolute.map(describeIssue)).toEqual([]);
  });

  it('never emits a backslash in location', () => {
    const backslashed = issues.filter((i) => i.location?.includes('\\'));
    expect(backslashed.map(describeIssue)).toEqual([]);
  });

  it('never packs a line number or a field path into location with a colon', () => {
    // A drive letter is already excluded by the absolute-path assertion, so any
    // remaining colon is a packed suffix.
    const packed = issues.filter((i) => i.location?.includes(':'));
    expect(packed.map(describeIssue)).toEqual([]);
  });

  it('emits every location as a path that exists under the project root', () => {
    const dangling = issues.filter((i) => {
      if (i.location === undefined) return false;
      return !fs.existsSync(safePath.join(tempDir, i.location));
    });
    expect(dangling.map(describeIssue)).toEqual([]);
  });

  it('satisfies ValidationIssueSchema for every emitted issue', () => {
    const rejected = issues
      .map((i) => ({ issue: i, parsed: ValidationIssueSchema.safeParse(i) }))
      .filter((r) => !r.parsed.success)
      .map((r) => describeIssue(r.issue));
    expect(rejected).toEqual([]);
  });

  it('routes document-internal pointers to `field`, not `location`', () => {
    const frontmatterIssues = issues.filter((i) => i.field?.startsWith('frontmatter'));
    expect(frontmatterIssues.length).toBeGreaterThan(0);
    for (const i of frontmatterIssues) {
      expect(i.location, describeIssue(i)).toBe('skills/anchor-fixture/SKILL.md');
    }
  });

  it('carries line numbers in `line`, and only for file-anchored issues', () => {
    const withLine = issues.filter((i) => i.line !== undefined);
    expect(withLine.length).toBeGreaterThan(0);
    for (const i of withLine) {
      expect(i.location, describeIssue(i)).toBeDefined();
    }
  });

  it('anchors a broken link to the file containing it, and names the target in `link`', () => {
    // The regression this pins: `location` used to be the link TARGET, which for
    // a missing target names a file that does not exist.
    const broken = issues.filter((i) => i.code === 'LINK_INTEGRITY_BROKEN' || i.code === 'LINK_MISSING_TARGET');
    expect(broken.length).toBeGreaterThan(0);
    for (const i of broken) {
      expect(i.location, describeIssue(i)).toBe('skills/anchor-fixture/SKILL.md');
      expect(i.link, describeIssue(i)).toBeDefined();
    }
    expect(broken.map((i) => i.link)).toContain(MISSING_HREF);
  });

  it('names the right cause: a missing target is broken, only an existing target leaks', () => {
    // Inside a real repo the ignore oracle is the GitTracker active set, and a
    // path that does not exist is trivially absent from it. Checking ignore
    // before existence therefore reported EVERY broken link as
    // LINK_TO_GITIGNORED_FILE — an accusation about a file that isn't there.
    const codeFor = (href: string): string[] =>
      issues.filter((i) => i.link === href).map((i) => i.code);

    expect(codeFor(MISSING_HREF)).toContain('LINK_MISSING_TARGET');
    expect(codeFor(MISSING_HREF)).not.toContain('LINK_TO_GITIGNORED_FILE');

    // The control: a target that DOES exist and IS gitignored still leaks.
    expect(codeFor(IGNORED_HREF)).toContain('LINK_TO_GITIGNORED_FILE');
    expect(codeFor(IGNORED_HREF)).not.toContain('LINK_MISSING_TARGET');
  });
});
