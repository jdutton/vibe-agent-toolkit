import { describe, expect, it } from 'vitest';

import { CLAUDE_MD_TAG } from '../src/projection/agentic-tags.js';
import { ancestorDirectories, claudeAncestry } from '../src/projection/claude-context-ancestry.js';
import type { ResourceTagRow } from '../src/schemas/projection-resources.js';

import { queryRealization, queryTag } from './helpers/context-query-rows.js';

/** The query directory most fixtures below walk to. */
const CLI_DIR = 'packages/cli';

/** `CLI_DIR`'s own `CLAUDE.md`, the fixture path several assertions share. */
const CLI_CLAUDE_MD = `${CLI_DIR}/CLAUDE.md`;

/** The root's second project location, the fixture path several assertions share. */
const ROOT_DOT_CLAUDE_CLAUDE_MD = '.claude/CLAUDE.md';

/** The boolean-presence `claude-md` tag the ancestry walk reads membership from. */
function claudeMdTag(path: string): ResourceTagRow {
  return queryTag(path, CLAUDE_MD_TAG, null);
}

function fixture(paths: readonly string[]) {
  return {
    realizations: paths.map(queryRealization),
    tags: paths.map(claudeMdTag),
  };
}

describe('ancestorDirectories', () => {
  it('runs root-down, corpus root first, query directory last', () => {
    expect(ancestorDirectories(`${CLI_DIR}/src`)).toEqual([
      '', 'packages', CLI_DIR, `${CLI_DIR}/src`,
    ]);
  });

  it('is the corpus root alone at the corpus root', () => {
    expect(ancestorDirectories('')).toEqual(['']);
  });
});

describe('claudeAncestry', () => {
  it('orders root-down, which is the reverse of the stored schema\'s wording', () => {
    const { realizations, tags } = fixture(['CLAUDE.md', 'packages/CLAUDE.md', CLI_CLAUDE_MD]);

    expect(claudeAncestry(realizations, tags, CLI_DIR).map((e) => e.path))
      .toEqual(['CLAUDE.md', 'packages/CLAUDE.md', CLI_CLAUDE_MD]);
  });

  it('appends CLAUDE.local.md AFTER CLAUDE.md within one directory', () => {
    const { realizations, tags } = fixture(['docs/CLAUDE.local.md', 'docs/CLAUDE.md']);

    expect(claudeAncestry(realizations, tags, 'docs').map((e) => e.path))
      .toEqual(['docs/CLAUDE.md', 'docs/CLAUDE.local.md']);
  });

  it('honours .claude/CLAUDE.md at the corpus root, between CLAUDE.md and CLAUDE.local.md', () => {
    const { realizations, tags } = fixture(['CLAUDE.md', ROOT_DOT_CLAUDE_CLAUDE_MD, 'CLAUDE.local.md']);

    expect(claudeAncestry(realizations, tags, 'docs').map((e) => e.path))
      .toEqual(['CLAUDE.md', ROOT_DOT_CLAUDE_CLAUDE_MD, 'CLAUDE.local.md']);
  });

  it('does NOT admit a nested .claude/CLAUDE.md as an ancestor of its sibling tree', () => {
    const { realizations, tags } = fixture([`${CLI_DIR}/.claude/CLAUDE.md`]);

    // dir is `packages/cli/.claude`, which is not an ancestor of `packages/cli`.
    expect(claudeAncestry(realizations, tags, CLI_DIR)).toEqual([]);
  });

  it('stops at the corpus root and never leaves it', () => {
    const { realizations, tags } = fixture(['CLAUDE.md']);

    expect(claudeAncestry(realizations, tags, '').map((e) => e.path)).toEqual(['CLAUDE.md']);
  });

  it('ignores a CLAUDE.md in a sibling branch', () => {
    const { realizations, tags } = fixture(['packages/rag/CLAUDE.md', CLI_CLAUDE_MD]);

    expect(claudeAncestry(realizations, tags, CLI_DIR).map((e) => e.path))
      .toEqual([CLI_CLAUDE_MD]);
  });

  it('reads membership from the shipped claude-md tag, not from a second glob', () => {
    const realizations = [queryRealization(CLI_CLAUDE_MD)];

    // Untagged: the classifier is the single vocabulary, so an untagged path is
    // not a CLAUDE.md however it is spelled.
    expect(claudeAncestry(realizations, [], CLI_DIR)).toEqual([]);
  });

  it('admits the root .claude/CLAUDE.md ONCE for a query inside .claude itself', () => {
    const { realizations, tags } = fixture(['CLAUDE.md', ROOT_DOT_CLAUDE_CLAUDE_MD]);

    // Reachable twice: the corpus-root special case fires at dir === '',
    // and the directory loop fires again at dir === '.claude'.
    const chain = claudeAncestry(realizations, tags, '.claude');
    const dotClaude = chain.filter((entry) => entry.path === ROOT_DOT_CLAUDE_CLAUDE_MD);

    expect(dotClaude).toHaveLength(1);
  });
});
