/**
 * `CLAUDE_RULE_LINK_UNCHECKED` END TO END, from real symlinks on disk: the
 * extent's own code decides which sentence the finding carries.
 *
 * ⚠️ `projection-builtin-checks.test.ts` hands the check hand-built rows, which
 * is what keeps the predicate and its producer independently falsifiable. That
 * is exactly why this one exists: the codes there are strings a fixture can
 * assert against itself forever while `filesystem-extent.ts` emits something
 * else. Here nothing is hand-built — real links are planted, the contributor
 * classifies them, and the check reads whatever it actually wrote. Integration
 * tier because planting and walking a tree does not fit the unit budget.
 */

import { createSymlink, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CLAUDE_RULE_LINK_UNCHECKED_CHECK } from '../../src/projection/builtin-checks.js';
import { FilesystemExtentContributor } from '../../src/projection/contributors/filesystem-extent.js';
import { FilesystemCrawlSource } from '../../src/projection/crawl-source.js';
import type { ValidationIssue } from '../../src/schemas/validation-result.js';
import { plantSymlinkFixture, removeSymlinkFixture } from '../helpers/symlink-fixture.js';
import { buildExtentContribution } from '../test-helpers.js';

describe.skipIf(!symlinkCapability())('the linked-rules arms, from a planted tree', () => {
  const INSIDE_LINK = '.claude/rules/inside.md';
  const OUTSIDE_LINK = '.claude/rules/outside.md';
  /** Named only by the out-of-root link's target text — it must reach no message. */
  const OUTSIDE_NAME = 'vat-builtin-outside-rules.md';
  /** Dangles in-root. */
  const DANGLING_LINK = '.claude/rules/dangling.md';
  /** Lexically in-root (`hop.md`), but `hop.md` is itself a link that leaves the root. */
  const CHAIN_LINK = '.claude/rules/chain.md';
  let root: string | undefined;
  let away: string | undefined;
  let issues: readonly ValidationIssue[] = [];
  const at = (location: string): ValidationIssue | undefined =>
    issues.find((issue) => issue.location === location);

  beforeAll(async () => {
    root = plantSymlinkFixture({
      prefix: 'vat-builtin-rules-link-',
      files: ['shared/rule.md'],
      links: [
        { path: INSIDE_LINK, target: '../../shared/rule.md' },
        // Enough `..` to leave any temp root, however deep the host puts it.
        { path: OUTSIDE_LINK, target: `${'../'.repeat(24)}${OUTSIDE_NAME}` },
        { path: DANGLING_LINK, target: '../../nope/missing.md' },
        { path: CHAIN_LINK, target: '../../hop.md' },
      ],
    }).root;
    away = plantSymlinkFixture({ prefix: 'vat-builtin-rules-away-', files: ['a.md'], links: [] }).root;
    const capability = symlinkCapability();
    if (capability === null) throw new Error('unreachable — the suite is skipped without the capability');
    createSymlink(capability, `${away}/a.md`, safePath.join(root, 'hop.md'));
    const { contribution } = await buildExtentContribution(
      root,
      new FilesystemExtentContributor((at) => new FilesystemCrawlSource(at)),
    );
    issues = CLAUDE_RULE_LINK_UNCHECKED_CHECK.run({
      claudeRulePatterns: [],
      resourceRealizations: [],
      resourceTags: [],
      blobs: [],
      realizationConditions: contribution.conditions,
    });
  });

  afterAll(() => {
    removeSymlinkFixture(root);
    removeSymlinkFixture(away);
  });

  it('⭐ the links draw the sentence their HOST resolution earns', () => {
    // Positive control: every rules link is reported at all.
    expect(issues.map((issue) => issue.location).sort((a, b) => (a ?? '').localeCompare(b ?? '')))
      .toStrictEqual([CHAIN_LINK, DANGLING_LINK, INSIDE_LINK, OUTSIDE_LINK]);

    expect(at(INSIDE_LINK)?.message).toContain('it is in force and unchecked');
    expect(at(OUTSIDE_LINK)?.message).toContain('target resolves outside the project root');
    expect(at(OUTSIDE_LINK)?.message).toContain('in force nowhere');
    // ⭐ Lexically in-root, physically out: Claude Code skips it, so "in force"
    // was the one wrong sentence available.
    expect(at(CHAIN_LINK)?.message).toContain('in force nowhere');
    expect(at(CHAIN_LINK)?.message).not.toContain('it is in force and unchecked');
    expect(at(DANGLING_LINK)?.message).toContain('Claude Code loads nothing through it');
    expect(at(DANGLING_LINK)?.message).not.toContain('it is in force and unchecked');
  });

  it('names neither the out-of-root target nor the fixture root', () => {
    for (const issue of issues) {
      expect(issue.message, issue.location).not.toContain(OUTSIDE_NAME);
      expect(issue.message, issue.location).not.toContain(root ?? '<unplanted>');
      expect(issue.message, issue.location).not.toContain(away ?? '<unplanted>');
    }
  });
});
