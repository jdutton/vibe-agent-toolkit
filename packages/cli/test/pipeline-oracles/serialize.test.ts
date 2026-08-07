/**
 * Unit tests for the snapshot renderers and the pure helpers around them.
 *
 * The renderers carry one load-bearing property: the enumeration renderer must
 * never reorder. Everything downstream — the goldens, the drift gate, the whole
 * argument that a restructure preserved each lane's population — rests on it.
 */

import { describe, expect, it } from 'vitest';

import { extractFrontmatterSource } from '../../src/pipeline-oracles/parse-fact-snapshot.js';
import { relativize } from '../../src/pipeline-oracles/path-facts.js';
import {
  renderEnumerationSnapshot,
  renderEnumerationSnapshotUnordered,
  renderParseFactSnapshot,
} from '../../src/pipeline-oracles/serialize.js';
import type { EnumerationRow, EnumerationSnapshot, ParseFactSnapshot } from '../../src/pipeline-oracles/types.js';

/** A row with sensible defaults, so a test states only what it is about. */
function row(path: string, overrides: Partial<EnumerationRow> = {}): EnumerationRow {
  return {
    path,
    contentKey: `k1.markdown.${path}`,
    exists: true,
    isDirectory: false,
    gitignored: false,
    isSymlink: false,
    symlinkResolves: null,
    ...overrides,
  };
}

/** A snapshot with the given rows and nothing else going on. */
function snapshot(rows: EnumerationRow[], overrides: Partial<EnumerationSnapshot> = {}): EnumerationSnapshot {
  return {
    laneId: 'resources',
    corpus: 'test',
    route: 'git-ls-files',
    gitAvailable: true,
    enumerated: rows,
    admitted: rows.map((entry) => entry.path),
    collisions: [],
    restatementDrift: [],
    ...overrides,
  };
}

describe('renderEnumerationSnapshot', () => {
  it('preserves arrival order exactly — never sorts', () => {
    // The whole point. `addResources` is first-added-wins, so a sorted
    // rendering would hide a reordering that changes which colliding file
    // survives, which is the single most consequential thing a restructure can
    // silently do.
    const rendered = renderEnumerationSnapshot(snapshot([row('zebra.md'), row('alpha.md'), row('middle.md')]));
    const ordinals = rendered
      .split('\n')
      .filter((line) => /^\d+\t/.test(line) && line.includes('.md'))
      .slice(0, 3);
    expect(ordinals[0]).toContain('zebra.md');
    expect(ordinals[1]).toContain('alpha.md');
    expect(ordinals[2]).toContain('middle.md');
  });

  it('numbers rows so a diff names the position that moved', () => {
    const rendered = renderEnumerationSnapshot(snapshot([row('a.md'), row('b.md')]));
    expect(rendered).toContain('0\ta.md');
    expect(rendered).toContain('1\tb.md');
  });

  it('renders an unanswered column as - rather than as false', () => {
    // `symlinkResolves` is null for a non-symlink. Printing `false` would claim
    // the link is broken; printing `-` says the question does not apply.
    const rendered = renderEnumerationSnapshot(snapshot([row('plain.md')]));
    expect(rendered).toMatch(/plain\.md\ttrue\tfalse\tfalse\tfalse\t-\t/);
  });

  it('renders a missing content key as - rather than omitting the column', () => {
    const rendered = renderEnumerationSnapshot(snapshot([row('gone.md', { contentKey: null, exists: false })]));
    expect(rendered).toContain('gone.md\tfalse\tfalse\tfalse\tfalse\t-\t-');
  });

  it('surfaces a build error on its own line', () => {
    const rendered = renderEnumerationSnapshot(
      snapshot([row('a.md')], { admitted: [], buildError: 'Error: ENOENT: no such file' }),
    );
    expect(rendered).toContain('buildError: Error: ENOENT: no such file');
  });

  it('renders no build error as -', () => {
    expect(renderEnumerationSnapshot(snapshot([row('a.md')]))).toContain('buildError: -');
  });

  it('names the winner and the loser of a collision', () => {
    const rendered = renderEnumerationSnapshot(
      snapshot([row('a/b-c.md'), row('a-b/c.md')], {
        collisions: [{ id: 'a-b-c-md', existingPath: 'a/b-c.md', conflictingPath: 'a-b/c.md' }],
      }),
    );
    expect(rendered).toContain('a-b-c-md\twon=a/b-c.md\tdropped=a-b/c.md');
  });

  it('ends with a newline, so a golden diff has no phantom last-line change', () => {
    expect(renderEnumerationSnapshot(snapshot([row('a.md')]))).toMatch(/\n$/);
  });

  it('uses LF only, so a Windows host produces the same golden as a Unix one', () => {
    expect(renderEnumerationSnapshot(snapshot([row('a.md')]))).not.toContain('\r');
  });
});

describe('renderEnumerationSnapshotUnordered', () => {
  it('sorts, and says in the header that it did', () => {
    // For the walk route only, where readdir order is a property of the
    // filesystem and therefore not portable across CI hosts.
    const rendered = renderEnumerationSnapshotUnordered(
      snapshot([row('zebra.md'), row('alpha.md')], { route: 'walk' }),
    );
    expect(rendered).toContain('SORTED BY PATH');
    const rows = rendered.split('\n').filter((line) => /^\d+\t\w/.test(line));
    expect(rows[0]).toContain('alpha.md');
    expect(rows[1]).toContain('zebra.md');
  });

  it('does not mutate the snapshot it was given', () => {
    const original = snapshot([row('zebra.md'), row('alpha.md')], { route: 'walk' });
    renderEnumerationSnapshotUnordered(original);
    expect(original.enumerated.map((entry) => entry.path)).toEqual(['zebra.md', 'alpha.md']);
  });
});

describe('renderParseFactSnapshot', () => {
  const facts: ParseFactSnapshot = {
    corpus: 'test',
    rows: [
      {
        contentKey: 'k1.markdown.aaa',
        parserKind: 'markdown',
        sizeBytes: 42,
        estimatedTokenCount: 11,
        links: [{ ordinal: 0, href: './x.md', text: 'x', type: 'local_file', line: 3, nodeType: 'link' }],
        headings: [{ ordinal: 0, level: 1, text: 'Title', slug: 'title', line: 1 }],
        frontmatterSource: 'title: T\nvalue: .inf',
        conditions: [{ code: 'PARSE_ODDITY', message: 'something\nmultiline', line: 2 }],
      },
    ],
    pathsByKey: { 'k1.markdown.aaa': ['one.md', 'two.md'] },
  };

  it('lists every path that shares a key — two paths under one key is the point', () => {
    expect(renderParseFactSnapshot(facts)).toContain('paths: one.md, two.md');
  });

  it('keeps every fact on one line so the golden stays line-diffable', () => {
    const rendered = renderParseFactSnapshot(facts);
    expect(rendered).toContain(String.raw`frontmatterSource: title: T\nvalue: .inf`);
    expect(rendered).toContain(String.raw`something\nmultiline`);
  });

  it('carries link and heading ordinals, not just their contents', () => {
    // "link 7 moved" and "a link changed target" are different findings; an
    // href alone cannot distinguish them in a document that links one target
    // more than once.
    const rendered = renderParseFactSnapshot(facts);
    expect(rendered).toContain('  0\tlocal_file\tlink\tline=3\thref=./x.md\ttext=x');
    expect(rendered).toContain('  0\th1\tslug=title\tline=1\ttext=Title');
  });

  it('renders absent frontmatter as - rather than as an empty block', () => {
    const withoutFrontmatter: ParseFactSnapshot = {
      ...facts,
      rows: facts.rows.map((entry) => ({ ...entry, frontmatterSource: null })),
    };
    expect(renderParseFactSnapshot(withoutFrontmatter)).toContain('frontmatterSource: -');
  });
});

describe('extractFrontmatterSource', () => {
  it('returns the block body verbatim, delimiters excluded', () => {
    expect(extractFrontmatterSource('---\ntitle: T\n---\n\n# Doc\n')).toBe('title: T');
  });

  it('preserves values a YAML→JSON round-trip would destroy', () => {
    // `.inf` becomes Infinity becomes null; `.nan` the same; `!!binary` becomes
    // a Buffer envelope. Keeping the source keeps all three intact.
    const source = extractFrontmatterSource('---\na: .inf\nb: .nan\nc: !!binary aGk=\n---\n\ntext\n');
    expect(source).toBe('a: .inf\nb: .nan\nc: !!binary aGk=');
  });

  it('handles CRLF delimiters', () => {
    expect(extractFrontmatterSource('---\r\ntitle: T\r\n---\r\n\r\n# Doc\r\n')).toBe('title: T');
  });

  it('returns null when there is no frontmatter', () => {
    expect(extractFrontmatterSource('# Just a heading\n')).toBeNull();
  });

  it('ignores a --- fence that is not at the start of the document', () => {
    expect(extractFrontmatterSource('# Doc\n\n---\ntitle: T\n---\n')).toBeNull();
  });

  it('returns an empty body for an empty block rather than null', () => {
    expect(extractFrontmatterSource('---\n\n---\n\n# Doc\n')).toBe('');
  });
});

describe('relativize', () => {
  it('renders a path under the root as forward-slashed and relative', () => {
    expect(relativize('/corpus/docs/guide.md', '/corpus')).toBe('docs/guide.md');
  });

  it('renders the root itself as .', () => {
    expect(relativize('/corpus', '/corpus')).toBe('.');
  });

  it('keeps an outside-the-root path visible rather than silently dropping it', () => {
    // A link target that escapes the corpus is a real finding — `outside-project`
    // is one of the classifications the skills walker makes — so it must render,
    // not vanish.
    expect(relativize('/elsewhere/x.md', '/corpus')).toBe('../elsewhere/x.md');
  });
});
