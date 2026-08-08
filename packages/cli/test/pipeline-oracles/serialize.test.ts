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
    targetInsideRoot: null,
    aliasesEnumeratedPath: false,
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
    // `symlinkResolves` and `targetInsideRoot` are null for a non-symlink.
    // Printing `false` would claim the link is broken and that its target
    // escapes the root; printing `-` says the question does not apply.
    //
    // Asserted as a WHOLE line rather than a prefix: a prefix assertion keeps
    // passing when a column is appended, so it silently stops covering every
    // column to its right. That is exactly how this test's sibling below came
    // to pass while no longer checking the field it is named for.
    const rendered = renderEnumerationSnapshot(snapshot([row('plain.md')]));
    expect(rendered.split('\n')).toContain('0\tplain.md\ttrue\tfalse\tfalse\tfalse\t-\t-\tfalse\tk1.markdown.plain.md');
  });

  it('renders a missing content key as - rather than omitting the column', () => {
    const rendered = renderEnumerationSnapshot(snapshot([row('gone.md', { contentKey: null, exists: false })]));
    expect(rendered.split('\n')).toContain('0\tgone.md\tfalse\tfalse\tfalse\tfalse\t-\t-\tfalse\t-');
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
        links: [
          { ordinal: 0, href: './x.md', text: 'x', type: 'local_file', line: 3, nodeType: 'link', resolvedId: null },
        ],
        headings: [{ ordinal: 0, level: 1, text: 'Title', slug: 'title', line: 1 }],
        frontmatterSource: 'title: T\nvalue: .inf',
        frontmatterFields: [
          { key: 'title', typeName: 'string', valueDigest: 'aaaaaaaaaaaa' },
          { key: 'value', typeName: 'number', valueDigest: 'bbbbbbbbbbbb' },
        ],
        anchors: ['top'],
        decodedLength: 42,
        conditions: [{ code: 'PARSE_ODDITY', message: 'something\nmultiline', line: 2 }],
        optionalArrays: [
          { field: 'anchors', state: 'present' },
          { field: 'parseErrors', state: 'absent' },
          { field: 'unresolvedReferences', state: 'empty' },
        ],
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
    expect(rendered).toContain('  0\tlocal_file\tlink\tline=3\tresolvedId=-\thref=./x.md\ttext=x');
    expect(rendered).toContain('  0\th1\tslug=title\tline=1\ttext=Title');
  });

  it('shows a resolvedId, which on a fresh parse should always be absent', () => {
    // `resolvedId` is the one field of a parsed link that production code
    // mutates in place after parsing (skill-packager stamps it while bundling,
    // and skips links that already carry one). A non-null value in a snapshot
    // taken straight off a parse means something wrote to a result this oracle
    // assumed was pristine — which is exactly how a shared cached ParseResult
    // would leak one skill's bundling decision into another's.
    const stamped = renderParseFactSnapshot({
      ...facts,
      rows: facts.rows.map((entry) => ({
        ...entry,
        links: entry.links.map((link) => ({ ...link, resolvedId: 'leaked-from-another-skill' })),
      })),
    });
    expect(stamped).toContain('resolvedId=leaked-from-another-skill');
    expect(stamped).not.toBe(renderParseFactSnapshot(facts));
  });

  it('renders absent frontmatter as - rather than as an empty block', () => {
    const withoutFrontmatter: ParseFactSnapshot = {
      ...facts,
      rows: facts.rows.map((entry) => ({ ...entry, frontmatterSource: null })),
    };
    expect(renderParseFactSnapshot(withoutFrontmatter)).toContain('frontmatterSource: -');
  });

  it('records frontmatter value SHAPES, which is what a lossy round-trip changes', () => {
    // The source block is re-derived from the document text and is therefore
    // identical whether a parse was cached or fresh. The shapes are not: a
    // YAML->JSON round-trip turns `.inf` from a number into null.
    const rendered = renderParseFactSnapshot(facts);
    expect(rendered).toContain('frontmatterFields: 2');
    expect(rendered).toContain('  value\tnumber\t');

    const roundTripped: ParseFactSnapshot = {
      ...facts,
      rows: facts.rows.map((entry) => ({
        ...entry,
        frontmatterFields: [
          { key: 'title', typeName: 'string', valueDigest: 'aaaaaaaaaaaa' },
          { key: 'value', typeName: 'null', valueDigest: 'cccccccccccc' },
        ],
      })),
    };
    expect(renderParseFactSnapshot(roundTripped)).not.toBe(rendered);
  });

  it('records frontmatter VALUES too, so same-shape documents stay distinguishable', () => {
    // Shape alone cannot separate two SKILL.md files: both are
    // {name: string, description: string}. A cache serving one skill's parse
    // for another would move nothing without the digest.
    const otherValues: ParseFactSnapshot = {
      ...facts,
      rows: facts.rows.map((entry) => ({
        ...entry,
        frontmatterFields: (entry.frontmatterFields ?? []).map((field) => ({
          ...field,
          valueDigest: `${field.valueDigest.slice(0, 11)}X`,
        })),
      })),
    };
    expect(renderParseFactSnapshot(otherValues)).not.toBe(renderParseFactSnapshot(facts));
  });

  it('does not let two different lists render to the same line', () => {
    // The regression this replaces: joining on ', ' made ["p, q"] and
    // ["p","q"] byte-identical, and `id="p, q"` survives both parsers verbatim.
    const oneCommaAnchor = renderParseFactSnapshot({
      ...facts,
      rows: facts.rows.map((entry) => ({ ...entry, anchors: ['p, q'] })),
    });
    const twoAnchors = renderParseFactSnapshot({
      ...facts,
      rows: facts.rows.map((entry) => ({ ...entry, anchors: ['p', 'q'] })),
    });
    expect(oneCommaAnchor).not.toBe(twoAnchors);
    expect(oneCommaAnchor).toContain('anchors: 1');
    expect(twoAnchors).toContain('anchors: 2');
  });

  it('escapes a tab inside an href, which would otherwise forge a column', () => {
    const rendered = renderParseFactSnapshot({
      ...facts,
      rows: facts.rows.map((entry) => ({
        ...entry,
        links: entry.links.map((link) => ({ ...link, href: 'a\tb' })),
      })),
    });
    expect(rendered).toContain(String.raw`href=a\tb`);
  });

  it('separates the presence state of optional arrays from their contents', () => {
    // `conditions` folds parseErrors and unresolvedReferences through `?? []`,
    // so absent and empty collapse there. The contract distinguishes them.
    expect(renderParseFactSnapshot(facts)).toContain(
      'optionalArrays: anchors=present parseErrors=absent unresolvedReferences=empty',
    );
  });

  it('keeps an ABSENT optional list distinct from a present empty one', () => {
    // A layer that normalises undefined into [] is a contract change, so `-`
    // and `0` must not collapse. Note this is defensive for `anchors`
    // specifically — both parsers spread that key conditionally, so a
    // present-but-empty anchors list is unreachable from a real parse. The
    // states that DO occur are carried in `optionalArrays`.
    const absent = renderParseFactSnapshot({
      ...facts,
      rows: facts.rows.map((entry) => ({ ...entry, anchors: null })),
    });
    const empty = renderParseFactSnapshot({
      ...facts,
      rows: facts.rows.map((entry) => ({ ...entry, anchors: [] })),
    });
    expect(absent).toContain('anchors: -');
    expect(empty).toContain('anchors: 0');
    expect(absent).not.toBe(empty);
  });

  it('carries a byte length and a decoded length, which diverge on malformed UTF-8', () => {
    // The pair is the point. `sizeBytes` is stat().size; `decodedLength` comes
    // from the decoded string. Decoding is many-to-one on invalid input, so
    // these two move independently exactly where content-addressing is hardest
    // — and the content key is computed over the bytes for that reason.
    const rendered = renderParseFactSnapshot(facts);
    expect(rendered).toContain('sizeBytes: 42');
    expect(rendered).toContain('decodedLength: 42');

    const lossyDecode = renderParseFactSnapshot({
      ...facts,
      rows: facts.rows.map((entry) => ({ ...entry, decodedLength: 40 })),
    });
    expect(lossyDecode).not.toBe(rendered);
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
