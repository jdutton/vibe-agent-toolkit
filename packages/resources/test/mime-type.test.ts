import { describe, expect, it } from 'vitest';

import { mimeTypeForPath, parserKindForMimeType } from '../src/mime-type.js';

// Spelled out here rather than imported from the module under test: an imported
// constant would make every assertion tautological — the test would still pass if
// the table's value changed. These literals are the pin.
const MD = 'text/markdown';
const HTML = 'text/html';
const PLAIN = 'text/plain';
const TS = 'text/x-typescript';
const JS = 'text/javascript';
const CSV = 'text/csv';
const YAML = 'application/yaml';
const JSON_TYPE = 'application/json';
const UNKNOWN_PATH = 'jobs/nightly.fraud-ingest-job';

describe('mimeTypeForPath — the three markdown-producing routes', () => {
  it.each([
    { filePath: 'docs/guide.md', mime: MD },
    { filePath: 'docs/guide.markdown', mime: MD },
    { filePath: 'notes/scratch.txt', mime: PLAIN },
    { filePath: 'README', mime: PLAIN },
  ])('$filePath -> $mime -> markdown parser', ({ filePath, mime }) => {
    expect(mimeTypeForPath(filePath)).toBe(mime);
    expect(parserKindForMimeType(mimeTypeForPath(filePath))).toBe('markdown');
  });

  it.each([
    { filePath: 'page.html', mime: HTML },
    { filePath: 'page.htm', mime: HTML },
  ])('$filePath -> $mime -> html parser', ({ filePath, mime }) => {
    expect(mimeTypeForPath(filePath)).toBe(mime);
    expect(parserKindForMimeType(mimeTypeForPath(filePath))).toBe('html');
  });
});

describe('mimeTypeForPath — basename rule fires ONLY on an extensionless path', () => {
  // PINNED: the extension route wins. `README.md` is a markdown document, not a
  // `text/plain` well-known — a precedence inversion here would silently stop
  // every repo's README from being parsed.
  it('README.md resolves via the EXTENSION table, not the basename table', () => {
    expect(mimeTypeForPath('README.md')).toBe(MD);
    expect(mimeTypeForPath('docs/CHANGELOG.md')).toBe(MD);
    expect(mimeTypeForPath('LICENSE.txt')).toBe(PLAIN); // via .txt, not via LICENSE
    expect(mimeTypeForPath('NOTICE.html')).toBe(HTML);
  });

  it.each(['README', 'CHANGELOG', 'LICENSE', 'LICENCE', 'CONTRIBUTING', 'NOTICE', 'AUTHORS', 'COPYING'])(
    'extensionless %s is text/plain',
    (name) => {
      expect(mimeTypeForPath(name)).toBe(PLAIN);
      expect(mimeTypeForPath(`sub/dir/${name}`)).toBe(PLAIN);
    },
  );

  // PINNED: basename matching is CASE-INSENSITIVE. The conventional spelling is
  // all-caps, but `readme`, `Readme` and `License` are all common in the wild and
  // all mean the same document. Nothing in the well-known set has a case-distinct
  // sibling that means something else, so there is no ambiguity to preserve.
  it.each(['readme', 'Readme', 'ReAdMe', 'license', 'Contributing', 'authors'])(
    'accepts the non-canonical casing %s',
    (name) => {
      expect(mimeTypeForPath(name)).toBe(PLAIN);
    },
  );

  it('does not match a well-known name that is only a prefix or suffix', () => {
    expect(mimeTypeForPath('READMEISH')).toBeNull();
    expect(mimeTypeForPath('MY-README')).toBeNull();
    expect(mimeTypeForPath('Makefile')).toBeNull();
  });
});

describe('mimeTypeForPath — dotfiles', () => {
  // PINNED: a leading dot is part of the NAME, not an extension separator —
  // Node's `path.extname('.gitignore')` is `''` and we match that exactly rather
  // than inventing a second rule. So `.gitignore` is an EXTENSIONLESS path, falls
  // to the basename table, is not a well-known there, and resolves to null.
  // Typing it `text/plain` would be worse than null: text/plain routes to the
  // markdown parser, and a dotfile is config, not prose.
  it('.gitignore has no extension and is not a well-known basename -> null', () => {
    expect(mimeTypeForPath('.gitignore')).toBeNull();
    expect(mimeTypeForPath('repo/.gitignore')).toBeNull();
    expect(mimeTypeForPath('.npmrc')).toBeNull();
    expect(parserKindForMimeType(mimeTypeForPath('.gitignore'))).toBeNull();
  });

  it('a dotfile that DOES carry an extension resolves on that extension', () => {
    expect(mimeTypeForPath('.eslintrc.json')).toBe(JSON_TYPE);
    expect(mimeTypeForPath('.prettierrc.yaml')).toBe(YAML);
  });

  // The discriminating case. `.gitignore` alone cannot prove the leading-dot rule
  // is implemented — it resolves to null whether the dot is treated as a separator
  // or not, because no extension table entry is spelled `.gitignore`. A file named
  // exactly `.md` is the only shape where the two readings disagree: as a name it
  // is null, as an extension it would be markdown. Mutating `dot > 0` to `dot >= 0`
  // leaves every other test in this file green and kills only these.
  it.each(['.md', '.json', '.css', '.txt'])(
    'a file named exactly %s is a NAME, not an extension, and stays null',
    (name) => {
      expect(mimeTypeForPath(name)).toBeNull();
      expect(mimeTypeForPath(`repo/${name}`)).toBeNull();
    },
  );
});

describe('mimeTypeForPath — typed but not parseable', () => {
  // The entire point of the module: we can say what these files ARE without
  // pretending a document parser should be run over them. Both halves asserted.
  it.each([
    { filePath: 'src/index.ts', mime: TS },
    { filePath: 'src/index.mts', mime: TS },
    { filePath: 'src/index.cts', mime: TS },
    { filePath: 'src/index.js', mime: JS },
    { filePath: 'src/index.mjs', mime: JS },
    { filePath: 'src/index.cjs', mime: JS },
    { filePath: 'package.json', mime: JSON_TYPE },
    { filePath: 'events.jsonl', mime: 'application/x-ndjson' },
    { filePath: 'config.yaml', mime: YAML },
    { filePath: 'config.yml', mime: YAML },
    { filePath: 'Cargo.toml', mime: 'application/toml' },
    { filePath: 'data/rows.csv', mime: CSV },
    { filePath: 'data/rows.tsv', mime: 'text/tab-separated-values' },
    { filePath: 'pom.xml', mime: 'application/xml' },
    { filePath: 'logo.svg', mime: 'image/svg+xml' },
    { filePath: 'site.css', mime: 'text/css' },
    { filePath: 'site.scss', mime: 'text/x-scss' },
    { filePath: 'schema.sql', mime: 'application/sql' },
    { filePath: 'script.py', mime: 'text/x-python' },
    { filePath: 'run.sh', mime: 'application/x-sh' },
    { filePath: 'run.ps1', mime: 'application/x-powershell' },
    { filePath: 'api.graphql', mime: 'application/graphql' },
    { filePath: 'main.tf', mime: 'text/x-hcl' },
    { filePath: 'vars.hcl', mime: 'text/x-hcl' },
    { filePath: 'bun.lock', mime: 'text/x-lockfile' },
    { filePath: 'Program.cs', mime: 'text/x-csharp' },
    { filePath: 'thing.test.ts.snap', mime: 'text/x-snapshot' },
  ])('$filePath is $mime and routes to NO document parser', ({ filePath, mime }) => {
    expect(mimeTypeForPath(filePath)).toBe(mime);
    expect(parserKindForMimeType(mimeTypeForPath(filePath))).toBeNull();
  });

  // A lockfile is text, but it is not PROSE. Typing it text/plain would route it
  // to the markdown parser via the text/plain rule — pinned so a future
  // "simplification" of the table cannot quietly do that.
  it('a lockfile is not text/plain, because text/plain means prose here', () => {
    expect(mimeTypeForPath('bun.lock')).not.toBe(PLAIN);
  });
});

describe('mimeTypeForPath — unknown means null, never octet-stream', () => {
  it('an unrecognized extension yields null MIME and null parser kind', () => {
    expect(mimeTypeForPath(UNKNOWN_PATH)).toBeNull();
    expect(mimeTypeForPath(UNKNOWN_PATH)).not.toBe('application/octet-stream');
    expect(parserKindForMimeType(mimeTypeForPath(UNKNOWN_PATH))).toBeNull();
  });

  it('an empty path and a trailing-dot path are unknown, not a crash', () => {
    expect(mimeTypeForPath('')).toBeNull();
    expect(mimeTypeForPath('weird.')).toBeNull();
  });
});

describe('mimeTypeForPath — extension casing and multiple dots', () => {
  it.each([
    { filePath: 'READ.MD', mime: MD },
    { filePath: 'index.HTML', mime: HTML },
    { filePath: 'index.HtM', mime: HTML },
    { filePath: 'DATA.CSV', mime: CSV },
  ])('extension match is case-insensitive: $filePath -> $mime', ({ filePath, mime }) => {
    expect(mimeTypeForPath(filePath)).toBe(mime);
  });

  // Pinned to match `parserKindForPath` in content-key.ts, whose own test already
  // pins this: only the LAST extension decides.
  it('only the last extension counts', () => {
    expect(mimeTypeForPath('x.html.md')).toBe(MD);
    expect(mimeTypeForPath('x.md.html')).toBe(HTML);
    expect(mimeTypeForPath('archive.tar.gz')).toBeNull();
  });
});

describe('mimeTypeForPath — Windows-style paths', () => {
  // CI runs on Windows. A backslash-separated path must yield the same answer as
  // its forward-slash twin, including for the extensionless basename rule where a
  // naive POSIX basename() would hand back the whole `C:\...\README` string.
  it.each([
    { filePath: String.raw`C:\repo\docs\guide.md`, mime: MD },
    { filePath: String.raw`C:\repo\README`, mime: PLAIN },
    { filePath: String.raw`C:\repo\README.md`, mime: MD },
    { filePath: String.raw`C:\repo\.gitignore`, mime: null },
    { filePath: String.raw`repo\src\index.ts`, mime: TS },
  ])('$filePath -> $mime', ({ filePath, mime }) => {
    expect(mimeTypeForPath(filePath)).toBe(mime);
  });
});

describe('parserKindForMimeType', () => {
  it.each([
    { mime: MD, kind: 'markdown' },
    { mime: HTML, kind: 'html' },
    // text/plain is PROSE. CommonMark degrades gracefully on it — a plain-text
    // file parsed as markdown yields paragraphs, which is the right answer — so
    // README and .txt reach the same lane as .md rather than being dropped.
    { mime: PLAIN, kind: 'markdown' },
  ])('$mime -> $kind', ({ mime, kind }) => {
    expect(parserKindForMimeType(mime)).toBe(kind);
  });

  it.each([JSON_TYPE, TS, CSV, 'image/svg+xml', 'application/octet-stream', ''])(
    'does not run a document parser for %s',
    (mime) => {
      expect(parserKindForMimeType(mime)).toBeNull();
    },
  );

  it('null in, null out — an untyped file gets no parser', () => {
    expect(parserKindForMimeType(null)).toBeNull();
  });
});

/**
 * A declared MIME type is adopter-authored prose, not a value this module produced.
 *
 * 🚨 The lookup used to be a byte-exact `Map.get` on it, so
 * `text/markdown; charset=utf-8` — an entirely ordinary spelling, and the one a
 * `Content-Type` header uses — routed to no parser at all. That is not a loud
 * failure: `resource-registry.ts › parserKindFor` turns `null` into
 * `NO_PARSER_KIND`, so EVERY file in the declaring collection is silently skipped
 * and the run exits 0 claiming to have looked.
 *
 * The rows below are the MECHANISM, not the one spelling in the report: a
 * parameter, several parameters, a quoted parameter value, OWS either side of the
 * `;`, surrounding whitespace, and case — RFC 9110 §8.3.1 makes type and subtype
 * case-insensitive, and parameters are `;`-delimited and never part of the type.
 */
describe('parserKindForMimeType — a declared type carries parameters and any case', () => {
  it.each([
    // The spelling in the defect report.
    { mime: 'text/markdown; charset=utf-8', kind: 'markdown' },
    // No OWS after the delimiter — equally legal, and a different code path for
    // anything that split on '; ' rather than on ';'.
    { mime: 'text/markdown;charset=utf-8', kind: 'markdown' },
    // More than one parameter, so a fix stripping only the LAST one fails here.
    { mime: 'text/markdown; charset=utf-8; variant=GFM', kind: 'markdown' },
    // A quoted parameter value containing the delimiter itself. Splitting at the
    // FIRST ';' is right whatever the value holds — the type is already complete.
    { mime: 'text/markdown; note=";"', kind: 'markdown' },
    // Case: RFC 9110 §8.3.1. All three of these name the same type.
    { mime: 'TEXT/MARKDOWN', kind: 'markdown' },
    { mime: 'Text/Markdown', kind: 'markdown' },
    { mime: 'TEXT/MARKDOWN; CHARSET=UTF-8', kind: 'markdown' },
    // Leading/trailing whitespace, which a hand-edited YAML value picks up.
    { mime: '  text/markdown  ', kind: 'markdown' },
    { mime: 'text/markdown ; charset=utf-8', kind: 'markdown' },
    // The other two routing types get the same treatment — the normalization is
    // in the lookup, not a special case carved for markdown.
    { mime: 'text/html; charset=iso-8859-1', kind: 'html' },
    { mime: 'TEXT/HTML', kind: 'html' },
    { mime: 'text/plain; charset=us-ascii', kind: 'markdown' },
  ])('$mime -> $kind', ({ mime, kind }) => {
    expect(parserKindForMimeType(mime)).toBe(kind);
  });

  it.each([
    // A `+suffix` type, parameterised. Normalizing must not start matching it:
    // `image/svg+xml` routes to no document parser with or without parameters.
    'image/svg+xml; charset=utf-8',
    'IMAGE/SVG+XML',
    'application/json; charset=utf-8',
    // Not a prefix match. `text/markdownish` is a different type, and stripping
    // parameters must not turn the lookup into a `startsWith`.
    'text/markdownish',
    'text/markdown-extra',
    // Degenerate spellings, which must stay null rather than resolve to the empty
    // key or throw.
    ';',
    '; charset=utf-8',
    '   ',
  ])('does not run a document parser for %s', (mime) => {
    expect(parserKindForMimeType(mime)).toBeNull();
  });
});
