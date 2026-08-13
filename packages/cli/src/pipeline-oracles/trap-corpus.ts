/**
 * The trap corpus — a small tree in which every file exists to make one
 * specific defect observable.
 *
 * VAT's committed fixtures could not do this job. Two holes in particular:
 *
 * - **Every VAT fixture is a git repository.** That masked a defect worth 88%
 *   of one command's runtime, because the defect *cannot fire inside a repo*:
 *   `crawlDirectory` answers from `git ls-files` when there is a git root and
 *   from a recursive walk when there is not, and those are different code
 *   paths with different orderings, different ignore semantics and different
 *   symlink handling. {@link materializeTrapCorpus} therefore defaults to **no
 *   git**, and initializing one is an explicit opt-in.
 * - **All 13 of VAT's dogfood skills bundle exactly zero files** — source and
 *   built both report `fileCount: 1, maxLinkDepth: 0`. See
 *   {@link BUNDLING_SKILL_FILES} for the fixture that fixes that, and the
 *   integration test that uses it.
 *
 * The corpus is built from code rather than shipped as an archive on purpose:
 * symlinks do not survive a ZIP round-trip reliably across platforms, and the
 * ones here are load-bearing. Building from code also lets the corpus *ask*
 * whether this host can make symlinks at all rather than assume it.
 */

import { symlinkSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safeExecResult, safePath } from '@vibe-agent-toolkit/utils';

/** A regular file in the corpus: forward-slashed relative path → contents. */
export type CorpusFiles = Readonly<Record<string, string>>;

/** A symlink in the corpus. */
export interface CorpusSymlink {
  /** Forward-slashed relative path of the link itself. */
  path: string;
  /** The link's target, exactly as it should be stored (usually relative). */
  target: string;
  /**
   * Windows link type. Ignored on every other platform.
   *
   * Node auto-detects when this is omitted, but only by looking at a target
   * that already exists — and a directory link is created before its target on
   * a tree written in sorted order. State it for directory links.
   */
  type?: 'dir' | 'file';
}

/** What a materialized corpus turned out to support on this host. */
export interface MaterializedCorpus {
  /** Absolute root the corpus was written to. */
  root: string;
  /** True when the symlink entries were actually created. */
  symlinksCreated: boolean;
  /** True when `git init` + an initial commit ran. */
  gitInitialized: boolean;
}

/**
 * Regular files. Each entry names the defect it makes observable — if a file
 * here stops earning that sentence, delete it rather than letting the corpus
 * grow into scenery.
 */
export const TRAP_CORPUS_FILES: CorpusFiles = Object.freeze({
  // Ordinary root document with links out, so every lane has something to find.
  'README.md': [
    '# Trap corpus',
    '',
    'A [guide](docs/guide.md), a [page](docs/page.html) and a [missing file](docs/nowhere.md).',
    '',
  ].join('\n'),

  // Frontmatter + headings + anchors: the ordinary parse-fact case.
  'docs/guide.md': [
    '---',
    'title: Guide',
    'description: An ordinary document, so the snapshot has a baseline to be unlike.',
    '---',
    '',
    '# Guide',
    '',
    'See [the sibling](sibling.md) and [back up](../README.md).',
    '',
    '## Nested heading',
    '',
    '## Nested heading',
    '',
    'Two identical headings, because slug disambiguation is a parse fact and a',
    'silent renumbering of it would move every cross-file anchor.',
    '',
  ].join('\n'),

  'docs/sibling.md': '# Sibling\n\nNothing special. Exists so a link resolves.\n',

  // Case: a link to `case.md` against a file named `Case.md` resolves on macOS
  // and Windows and breaks on Linux. The filename-case check is one of the
  // three that turn on a filesystem fact; its listing is now materialised in
  // pass 1′ (`fillSiblingNames`) and read from that table by the judge, so this
  // row exercises the fill/judge pair rather than a listing taken mid-judgement.
  'docs/Case.md': '# Case\n\nReferenced with the wrong case from links/to-case.md.\n',
  'links/to-case.md': '# Wrong case\n\n[Case](../docs/case.md)\n',

  // HTML: a member of the corpus that is NOT routable. Three lanes crawl
  // markdown only, two crawl markdown+HTML, and they observably disagree here.
  'docs/page.html': [
    '<!doctype html>',
    '<html><head><title>Page</title></head>',
    '<body><h1 id="top">Page</h1><a href="guide.md">guide</a></body></html>',
    '',
  ].join('\n'),
  'docs/page.htm': '<html><body><a href="sibling.md">sibling</a></body></html>\n',

  // Fragment targets declared from MARKDOWN, via raw HTML. Without this the
  // `anchors` parse fact is exercised on the HTML parser only, and markdown's
  // path through `extractHtmlAnchors` — a different function, with a different
  // rule — has no coverage at all.
  //
  // The two spellings are the point. Markdown case-folds fragments, so both
  // `id="Mixed-Case"` and `name="ALSO"` are recorded lowercased, while the HTML
  // parser records ids verbatim. That fold is the kind of normalisation a parse
  // layer can drop without changing a single link, heading or byte count, and
  // `docs/page.html#top` cannot show it because `top` is already lowercase.
  'docs/anchored.md': [
    '# Anchored',
    '',
    '<a id="Mixed-Case"></a>',
    '',
    '## Section',
    '',
    '<a name="ALSO"></a>',
    '',
    'Linked from [links/to-anchor.md](../links/to-anchor.md).',
    '',
  ].join('\n'),
  'links/to-anchor.md': '# To an anchor\n\n[mixed](../docs/anchored.md#mixed-case)\n',

  // Every `LinkType` the classifier can return, and every `LinkNodeType`.
  //
  // Without this the corpus exercised `local_file` on 12 of 12 links and
  // `nodeType: 'link'` on all but the HTML ones — so `classifyLink`, a
  // seven-outcome function, was pinned on one branch, and both of
  // `extractLinks`' reference-style branches (`linkReference` and `definition`)
  // were entirely unexercised. A parse layer that dropped definition rows
  // altogether would not have moved a single golden line.
  //
  // Note `../docs/` keeps its trailing slash deliberately: `links/to-dir.md`
  // links `../docs` without one and is classified `local_file`, so the
  // `local_directory` branch was missed by the very file whose comment claims
  // to cover directories.
  'links/every-type.md': [
    '# Every link type',
    '',
    'A [local file](../docs/sibling.md), a [local directory](../docs/), a',
    '[same-document anchor](#every-link-type), an [external](https://example.invalid/x),',
    'an [email](mailto:nobody@example.invalid), and an unsupported',
    '[scheme](vatscheme://opaque).',
    '',
    // `embedded` is a data:/blob: URI, NOT a markdown image — `extractLinks`
    // visits `link`, `linkReference` and `definition` nodes and never `image`,
    // so `![alt](x.png)` yields no link at all. The image below is kept as the
    // negative control for that: it must contribute nothing to `links`.
    '[embedded](data:text/plain;base64,aGk=)',
    '',
    '![an image, which is deliberately not extracted](../docs/diagram.png)',
    '',
    'Reference-style [usage][ref] and a collapsed [ref][].',
    '',
    '[ref]: ../docs/guide.md',
    '',
  ].join('\n'),

  // ⭐ Link ordering is by node KIND, not by document position — all `link`s,
  // then all `linkReference`s, then all `definition`s — and the goldens pin
  // ordinals. A collapse of the parse into a single document-order traversal
  // emits `[definition, link, linkReference, …]` instead, which is a silent
  // renumbering of every link ordinal in the corpus.
  //
  // The definition FIRST is the whole point: `links/every-type.md` declares its
  // one definition last, so on that file document order and kind order agree
  // and a document-order collapse looks identical. This file is the only place
  // in the corpus where the two orders disagree.
  'parse/interleaved-kinds.md': [
    '# Interleaved',
    '',
    '[def-first]: https://example.invalid/first',
    '',
    'An inline [alpha](./a.md) then a reference [beta][def-first] then more.',
    '',
    '[def-second]: ./second.md',
    '',
    'Another inline [gamma](./g.md) and a second reference [delta][def-second].',
    '',
  ].join('\n'),

  // Pins the CommonMark first-wins contract for a label declared twice: the
  // `linkReference` resolves to the FIRST definition (`./first-wins.md`), not
  // the last. This used to pin a real defect (last-wins), fixed by making
  // `collectNode`'s `definition` case only `.set()` when the identifier is
  // not already present — see the `AstWalkState.definitions` docblock in
  // `packages/resources/src/link-parser.ts`.
  'parse/duplicate-definition.md': [
    '# Duplicate definition label',
    '',
    'A [ref][dup] pointing at a twice-declared label.',
    '',
    '[dup]: ./first-wins.md',
    '[dup]: ./last-wins.md',
    '',
  ].join('\n'),

  // Links nested inside other links. `extractLinks` visits `link`,
  // `linkReference` and `definition` nodes wherever they occur, so an inner
  // link inside an outer one is a second row and an image reference inside a
  // link is not a row at all. A traversal that stopped descending at the first
  // match — the obvious way to write a collapsed walk — would drop the inner.
  'parse/nested-links.md': [
    '# Nested',
    '',
    '[![badge][img-ref]](https://example.invalid/click)',
    '',
    '[Outer text with [inner](./inner.md) inside][outer-ref]',
    '',
    '[img-ref]: ./badge.png',
    '[outer-ref]: ./outer.md',
    '',
  ].join('\n'),

  // Fragment anchors across several nodes, with decoys. `docs/anchored.md`
  // pins the case-fold on two well-separated anchors; this pins the parts that
  // one cannot: two anchors in ONE node, an anchor inline in a paragraph, the
  // same id declared twice, and — the decoys — an anchor inside a fenced code
  // block and one inside an inline code span, neither of which is a fragment
  // target any renderer would honour.
  'parse/html-anchors.md': [
    '# HTML anchors',
    '',
    '<a id="First"></a>',
    '',
    '## A heading',
    '',
    '<span name=\'Second\'></span><a id="Third">x</a>',
    '',
    '<a id="First"></a>',
    '',
    'Inline <a id="Fourth">y</a> anchor in a paragraph.',
    '',
    '```html',
    '<a id="NeverIndexed"></a>',
    '```',
    '',
    'An `<a id="AlsoNever">` inline code span.',
    '',
  ].join('\n'),

  // The false-positive side of unresolved references. `broken/dangling-
  // reference.md` supplies one genuine dangling label; every line below is
  // bracket-shaped text that must NOT be reported — a reference inside a fenced
  // block, a query string, an API signature with optional arguments, and a
  // numeric citation. `collectMaskFacts` computes masked ranges and defined
  // labels in one walk, and a masking regression is silent: it does not throw,
  // it just starts reporting prose.
  'parse/masked-references.md': [
    '# Masked references',
    '',
    'A genuine [dangling][no-such-label] reference.',
    '',
    '```',
    '[masked][also-no-such]',
    '```',
    '',
    'A query param in a URL: [q](https://example.invalid/?filter[status][eq]=1)',
    '',
    'An API signature: needle.get(url[, options][, callback])',
    '',
    'Numeric citation[3][4] in prose.',
    '',
  ].join('\n'),

  // Links in containers the corpus otherwise never puts one in — a list item, a
  // block quote, a table cell — plus an autolink and a redefinition of a label
  // used earlier in the document. Every link row in the rest of the corpus is
  // in a bare paragraph, so a traversal that never descends into `list`,
  // `blockquote` or `table` children would lose these and nothing else.
  'parse/kitchen-sink.md': [
    '---',
    'title: kitchen sink',
    '---',
    '',
    '# Top <a id="TopAnchor"></a>',
    '',
    '[early-ref]: ./early.md',
    '',
    'Paragraph with [inline](./one.md), a [reference][early-ref], and an autolink',
    '<https://example.invalid/auto>.',
    '',
    '## Same heading',
    '',
    '<a id="Mid"></a>',
    '',
    '### Same heading',
    '',
    '- list item with [nested inline](./two.md) and [nested ref][late-ref]',
    '- another with `[code][notalink]`',
    '',
    '> quote with [quoted](./three.md)',
    '',
    '| col |',
    '| --- |',
    '| [table link](./four.md) |',
    '',
    '## Same heading',
    '',
    '[late-ref]: ./late.md',
    '',
  ].join('\n'),

  // Slug disambiguation ACROSS heading levels. `docs/guide.md` repeats one text
  // at one level; the counter that suffixes `-1`, `-2` … is keyed on the text
  // alone, so a level-aware regression is invisible there and visible here.
  'parse/repeated-headings.md': ['# Same', '', '## Same', '', '### Same', '', '## Same', '', '# Same', ''].join('\n'),

  // Frontmatter delimiters with NOTHING between them. Distinct from
  // `docs/empty-frontmatter.md`, which contains an explicit `{}`: this is the
  // shape a YAML parser may answer with `null`, `{}` or a parse error, and
  // which of the three decides whether the row reports `frontmatterFields: -`
  // (absent) or `0` (present and empty).
  'parse/frontmatter-delimited-empty.md': '---\n---\n\n# Body only\n',

  // ⭐ The four fixtures below close a measured coverage hole: before them,
  // 36 of the corpus's 37 blobs rendered `lexicalReferences: -`, and the one
  // that did not (`docs/Case.md`) is a `bare-token` with `slashCount: 1`,
  // `leadingAt: false`, `variableExpansion: null`, `inCodeSpan: false` and
  // `inFence: false`. So a mutation that zeroed `leadingAt`, forced
  // `syntacticForm` to `bare-token`, dropped variable-expansion detection
  // outright, or stopped annotating code context could not have moved a single
  // golden line — the lexer's most load-bearing columns were pinned on their
  // default values only.

  // `at-prefixed`, outside any code context: the Claude Code import shape, and
  // the only place `leadingAt: true` is observable.
  'parse/lexical-at-import.md': [
    '# At-prefixed import',
    '',
    'Read @docs/setup.md before acting.',
    '',
  ].join('\n'),

  // ⭐ The SAME token in both code contexts. Anthropic documents that import
  // parsing skips code spans and fenced blocks, so `inCodeSpan`/`inFence`
  // decide whether an `@` token is an import at all — and the lexer records
  // them rather than dropping the token, precisely so a query can be
  // second-guessed. Identical `raw` across all three rows in this corpus is
  // deliberate: only the two context columns distinguish them, so nothing else
  // can accidentally carry the assertion.
  'parse/lexical-code-context.md': [
    '# Code context',
    '',
    'Inline `@docs/setup.md` in a span.',
    '',
    '```text',
    '@docs/setup.md',
    '```',
    '',
  ].join('\n'),

  // `env-anchored` in two of the four expansion syntaxes — the precedence rule
  // (`env-anchored` beats a leading `@`) and the `percent` branch that a POSIX
  // -only corpus never reaches. `%APPDATA%\x` also pins `hasExtension: false`
  // on a token that a naive "contains a dot" test would call true.
  'parse/lexical-env-anchored.md': [
    '# Env anchored',
    '',
    'Run ${CLAUDE_PLUGIN_ROOT}/scripts/run.mjs and read %APPDATA%\\x too.',
    '',
  ].join('\n'),

  // `bare-token` with TWO slashes. `docs/Case.md`'s incidental token has one,
  // so `slashCount` was pinned to a value a hardcoded `1` would satisfy.
  'parse/lexical-bare-token.md': [
    '# Bare token',
    '',
    'Consult docs/guides/setup.md in prose.',
    '',
  ].join('\n'),

  // A row with MORE THAN ONE condition. Every other multi-condition path in the
  // corpus tops out at one, so `collectConditions`' three-key sort comparator
  // (code, then line, then message) never actually executed.
  'broken/two-conditions.md': [
    '---',
    'title: [unclosed',
    '---',
    '',
    '# Two conditions',
    '',
    'A dangling [reference][nowhere] alongside the invalid YAML above.',
    '',
  ].join('\n'),

  // Heading depth past h2. `buildHeadingTree`'s multi-level pop branch — the one
  // that closes several open levels at once — needs a drop of more than one
  // level to run, which h1/h2 alone can never produce.
  'docs/deep-headings.md': [
    '# Level one',
    '',
    '## Level two',
    '',
    '### Level three',
    '',
    '#### Level four',
    '',
    '##### Level five',
    '',
    '###### Level six',
    '',
    '## Back to two',
    '',
    'The jump from h6 to h2 is the multi-pop.',
    '',
  ].join('\n'),

  // ⭐ TWO PATHS, ONE CONTENT KEY — the case a content-addressed cache exists
  // for, and the case the corpus could not previously produce at all. Byte-
  // identical files at different paths: same key, one parse, two `paths:`
  // entries on the row.
  //
  // These also make the oracle's dedup skip observable. It parses the first
  // arrival and `continue`s on the second, which means "same key implies same
  // facts" is IMPLEMENTED inside the instrument built to verify it. With two
  // such paths present, removing the skip is a one-line experiment rather than
  // a corpus-authoring exercise.
  'twins/left/same.md': '# Twin\n\nByte-identical to its sibling, at a different path.\n',
  'twins/right/same.md': '# Twin\n\nByte-identical to its sibling, at a different path.\n',

  // Frontmatter present but EMPTY (`{}` after parsing). Distinct from absent,
  // and the only way to reach `frontmatterFields: 0`.
  'docs/empty-frontmatter.md': '---\n{}\n---\n\n# Empty frontmatter\n',

  // Frontmatter value shapes the `typeName` column had no coverage for:
  // boolean, null, Array and Object, taking it from three observed shapes to
  // seven.
  //
  // `when:` is here as a MEASUREMENT, and it came back `string`, not `Date` —
  // this project's `yaml` configuration does not construct Date objects for
  // unquoted ISO timestamps. Worth pinning precisely because the reasoning for
  // recording shapes cites `Date` as a case a JSON round-trip would change; on
  // this parser that particular transition cannot occur, and the golden now
  // says so instead of leaving it assumed.
  'docs/frontmatter-shapes.md': [
    '---',
    'when: 2020-01-02T03:04:05Z',
    'flag: true',
    'nothing: null',
    'list:',
    '  - one',
    '  - two',
    'nested:',
    '  inner: value',
    '---',
    '',
    '# Frontmatter shapes',
    '',
  ].join('\n'),

  // The empty-file parser-discriminator collision. Identical bytes; git keys
  // both as e69de29…; the parse results are not the same. A bytes-only content
  // key would serve one for the other.
  'empty.md': '',
  'empty.html': '',

  // Duplicate resource id. `generateIdFromPath` slugifies the whole
  // corpus-relative path, mapping BOTH `/` and `-` to `-`, so these two
  // distinct files both claim `dup-hyphen-note-md`. `addResources` is
  // first-added-wins, so WHICH one gets validated, bundled and rewritten is
  // decided by enumeration order — the single most order-sensitive behaviour in
  // the pipeline, and the reason no snapshot here may ever be sorted.
  //
  // Note this collides via the PATH, not via a frontmatter `id:` field: the
  // frontmatter route only applies when the registry was constructed with an
  // `idField`, which none of the five lanes does. Both files carry an `id:` key
  // anyway, so the day a lane starts honouring one, this fixture notices.
  'dup-hyphen/note.md': '---\nid: shared-note\n---\n\n# Note under dup-hyphen/\n',
  'dup/hyphen-note.md': '---\nid: shared-note\n---\n\n# Note under dup/\n',

  // Link targets that are not files: a directory, and a path that is absent.
  // Both are `exists`/`isDirectory` questions about paths outside the
  // enumeration, which is the population the attribute columns exist for.
  'links/to-dir.md': '# To a directory\n\n[docs](../docs)\n',
  'links/to-missing.md': '# To nothing\n\n[gone](../docs/nowhere.md)\n',

  // Only meaningful once git is initialized: the target is gitignored, which
  // `git ls-files` can never return, so it can only ever be a link-target fact.
  'links/to-ignored.md': '# To an ignored file\n\n[secret](../ignored/secret.md)\n',
  'ignored/secret.md': '# Secret\n\nGitignored when this corpus is initialized as a repo.\n',
  '.gitignore': 'ignored/\n',

  // Invalid YAML frontmatter: a parse-time condition, not an exception.
  'broken/bad-frontmatter.md': '---\ntitle: [unclosed\n---\n\n# Broken\n',

  // The YAML→JSON round-trip trap, in one file. `.inf` and `.nan` survive a
  // YAML parse and become `null` through JSON; `!!binary` becomes a Buffer
  // envelope. Caching the parsed OBJECT would make a cold run and a warm run
  // report different validation issues for this document.
  'broken/exotic-frontmatter.md': [
    '---',
    'ceiling: .inf',
    'undefined_value: .nan',
    'payload: !!binary |',
    '  aGVsbG8=',
    '---',
    '',
    '# Exotic frontmatter',
    '',
  ].join('\n'),

  // Reference-style link with no definition: degrades to literal text at parse
  // time, so it is invisible to any AST visitor and only a raw-source scan sees
  // it. A condition row, not a link row.
  'broken/dangling-reference.md': '# Dangling\n\nSee [the docs][nowhere].\n',

  // Malformed HTML: well-formedness diagnostics are a parse fact for the HTML
  // parser and undefined for the markdown one.
  'broken/malformed.html': '<html><body><p>unclosed<div></body>\n',
});

/**
 * Symlinks. Created only when the host permits it — see
 * {@link MaterializedCorpus.symlinksCreated}.
 *
 * The two `link.md` entries store the **same target string** in different
 * directories and resolve to different bytes. Git records a symlink as a blob
 * containing that target string (mode 120000), so both share a blob SHA —
 * measured. Any cache keyed on the git blob would serve one document's parse
 * for the other. That is the whole reason keys are computed on read.
 */
export const TRAP_CORPUS_SYMLINKS: readonly CorpusSymlink[] = Object.freeze([
  { path: 'symlinks/a/link.md', target: 'target.md' },
  { path: 'symlinks/b/link.md', target: 'target.md' },
]);

/**
 * A symlink that resolves to nothing.
 *
 * Kept OUT of the default corpus because in a git-initialized tree it does not
 * produce a finding — it produces an **unhandled `ENOENT` that terminates the
 * command**. `git ls-files` returns a mode-120000 entry like any other path,
 * `crawlDirectory`'s git branch does no symlink filtering (so `followSymlinks:
 * false` is honoured on the walk route and silently ignored on the git route),
 * and `addResources` catches only `DuplicateResourceIdError`, so the read error
 * escapes `registry.crawl` and the process dies with a raw stack trace.
 *
 * The same tree with no `.git` is fine, because the walk route never enumerates
 * a symlink at all. One variable, opposite outcomes — which is why this is an
 * opt-in: including it by default would make every other snapshot on the git
 * route unobtainable.
 */
export const DANGLING_SYMLINK: CorpusSymlink = Object.freeze({
  path: 'symlinks/dangling.md',
  target: 'nowhere.md',
});

/**
 * A directory symlink that re-enters its own ancestor.
 *
 * `symlinks/loop/self -> ..` resolves to `symlinks/`, so a walk that follows it
 * descends `symlinks/loop/self/loop/self/…` forever. Before `crawlDirectory`
 * kept a visited-realpath set this did not hang: it enumerated every file under
 * `symlinks/` once per nesting level until the **kernel** refused to resolve
 * further links, a limit that is 32 on macOS and 40 on Linux — so the row count
 * was a property of the operating system, and the walk terminated inside the
 * `catch` that exists to skip BROKEN symlinks, reporting nothing.
 *
 * Opt-in: it is meaningless with `followSymlinks: false`, which is every
 * existing golden, and including it by default would move all of them.
 */
export const DIRECTORY_LOOP_SYMLINK: CorpusSymlink = Object.freeze({
  path: 'symlinks/loop/self',
  target: '..',
  type: 'dir' as const,
});

/**
 * A file symlink whose target lies outside the corpus root.
 *
 * The third hazard the `followSymlinks` boolean collapses: not membership and
 * not looping, but a link that widens the corpus to somewhere nobody pointed
 * the command at. It matters most for `vat audit`, which runs over third-party
 * plugin trees.
 *
 * Deliberately a FILE link. An escaping *directory* link would make a following
 * walk enumerate the parent tree — for a corpus under `mkdtemp`, all of the
 * system temp directory — and the visited-realpath guard does not prevent that:
 * it bounds re-entry, not reach.
 *
 * Opt-in, and it writes {@link ESCAPE_TARGET_BASENAME} into the corpus root's
 * PARENT, so materialize the corpus into a subdirectory of a temp dir rather
 * than into the temp dir itself.
 */
export const ESCAPING_SYMLINK: CorpusSymlink = Object.freeze({
  path: 'symlinks/escape.md',
  target: '../../outside.md',
});

/** Basename of the file {@link ESCAPING_SYMLINK} points at, in the root's parent. */
export const ESCAPE_TARGET_BASENAME = 'outside.md';

/** Files the symlink entries point at. Split out so they exist first. */
const SYMLINK_TARGETS: CorpusFiles = Object.freeze({
  'symlinks/a/target.md': '# A\n\nDistinct bytes from B.\n',
  'symlinks/b/target.md': '# B\n\nDistinct bytes from A, behind an identical link target string.\n',
});

/**
 * A skill that actually bundles a file, reachable by one relative link.
 *
 * This is what none of VAT's 13 dogfood skills provide. Without it, the source
 * lane and the built lane report the same `fileCount: 1, maxLinkDepth: 0`
 * whether the link graph works or is structurally empty — so nothing committed
 * can tell a working bundle from a broken one.
 */
export const BUNDLING_SKILL_FILES: CorpusFiles = Object.freeze({
  'skills/bundling-skill/SKILL.md': [
    '---',
    'name: bundling-skill',
    'description: Use when exercising the built lane\'s link graph — bundles one file reachable by a relative link.',
    '---',
    '',
    '# Bundling skill',
    '',
    'Consult the [reference](reference.md) before acting.',
    '',
  ].join('\n'),
  'skills/bundling-skill/reference.md': [
    '# Reference',
    '',
    'Bundled by traversal, not by declaration. Its bytes must be read by the',
    'built lane as well as the source lane; today they are not.',
    '',
  ].join('\n'),
});

/** Options for {@link materializeTrapCorpus}. */
export interface MaterializeOptions {
  /**
   * Run `git init` and commit everything (default `false`).
   *
   * Leaving this off is the point of the fixture. Turn it on to get the *other*
   * crawl route — `git ls-files`, whose output is git-sorted and therefore the
   * only route whose ordering is portable across hosts.
   */
  initGit?: boolean;
  /** Skip symlink creation even where the host supports it. */
  skipSymlinks?: boolean;
  /** Also write {@link BUNDLING_SKILL_FILES} (default `false`). */
  includeBundlingSkill?: boolean;
  /**
   * Also create {@link DANGLING_SYMLINK} (default `false`).
   *
   * ⚠️ This comment used to say that combined with `initGit` it makes every
   * resource lane **throw**, and that was true until `RESOURCE_UNREADABLE`
   * landed. It is now wrong: the lane runs to completion and the dangling
   * entry is *enumerated but not admitted*, reported as a finding rather than
   * terminating the command. `enumeration-symlink-divergence.integration.test.ts`
   * pins exactly that (`expect(onGit.buildError).toBeUndefined()`).
   *
   * The flag still earns its place, for the surviving reason: it is the only
   * fixture that produces a path present on the `git ls-files` route and
   * absent from the admitted set, which is the population gap the finding
   * accounts for. Do not reach for it expecting a `buildError`.
   */
  includeDanglingSymlink?: boolean;
  /**
   * Also create {@link DIRECTORY_LOOP_SYMLINK} and {@link ESCAPING_SYMLINK}
   * (default `false`) — the two cases only a symlink-following crawl can see.
   *
   * ⚠️ Writes {@link ESCAPE_TARGET_BASENAME} into the corpus root's PARENT, so
   * materialize into a subdirectory of a temp dir, never into the temp dir
   * itself.
   */
  includeSymlinkHazards?: boolean;
}

/**
 * Write the trap corpus into an existing empty directory.
 *
 * @param root - Absolute path to write into; created if absent
 * @param options - Git initialization and symlink opt-outs
 * @returns What actually got built on this host
 */
export function materializeTrapCorpus(
  root: string,
  options: MaterializeOptions = {},
): MaterializedCorpus {
  const absoluteRoot = safePath.resolve(root);
  const files: CorpusFiles = {
    ...TRAP_CORPUS_FILES,
    ...SYMLINK_TARGETS,
    ...(options.includeBundlingSkill === true ? BUNDLING_SKILL_FILES : {}),
  };

  // Sorted, so the tree is written in the same order on every host. That does
  // not make the CRAWL order portable — `readdirSync` answers from the
  // filesystem, not from creation order — but it removes one variable.
  for (const relativePath of Object.keys(files).sort((a, b) => a.localeCompare(b))) {
    const absolutePath = safePath.join(absoluteRoot, relativePath);
    mkdirSyncReal(safePath.resolve(absolutePath, '..'), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- paths come from the frozen literal above
    writeFileSync(absolutePath, files[relativePath] ?? '', 'utf-8');
  }

  if (options.includeSymlinkHazards === true) {
    // The escape target lives OUTSIDE the corpus, which is the whole point of
    // that fixture — written here rather than in the files loop above, which
    // only ever writes under the root.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- basename is a frozen literal; parent derived from the caller's root
    writeFileSync(
      safePath.join(safePath.resolve(absoluteRoot, '..'), ESCAPE_TARGET_BASENAME),
      '# Outside\n\nReached only by a symlink that escapes the corpus root.\n',
      'utf-8',
    );
  }

  const links = [
    ...TRAP_CORPUS_SYMLINKS,
    ...(options.includeDanglingSymlink === true ? [DANGLING_SYMLINK] : []),
    ...(options.includeSymlinkHazards === true ? [DIRECTORY_LOOP_SYMLINK, ESCAPING_SYMLINK] : []),
  ];
  const symlinksCreated = options.skipSymlinks === true ? false : writeSymlinks(absoluteRoot, links);
  const gitInitialized = options.initGit === true ? initGit(absoluteRoot) : false;

  return { root: absoluteRoot, symlinksCreated, gitInitialized };
}

/**
 * Create the symlink entries, reporting whether the host allowed it.
 *
 * All-or-nothing on purpose: a corpus with some of its symlinks is a corpus
 * whose golden matches neither the symlink-capable nor the symlink-incapable
 * one, and debugging that costs more than the coverage is worth.
 *
 * @param root - Absolute corpus root
 * @param links - The links to create
 * @returns True when every symlink was created
 */
function writeSymlinks(root: string, links: readonly CorpusSymlink[]): boolean {
  try {
    for (const link of links) {
      const absolutePath = safePath.join(root, link.path);
      mkdirSyncReal(safePath.resolve(absolutePath, '..'), { recursive: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- target and path both come from the frozen literals above
      symlinkSync(link.target, absolutePath, link.type);
    }
    return true;
  } catch {
    // Windows without Developer Mode or SeCreateSymbolicLinkPrivilege.
    return false;
  }
}

/**
 * Initialize a repository and commit the corpus.
 *
 * Identity and hooks are pinned inline so this works on a CI agent with no
 * global git config, and so a developer's `commit.gpgsign` or `core.hooksPath`
 * cannot make the fixture hang.
 *
 * @param root - Absolute corpus root
 * @returns True when the commit landed
 */
function initGit(root: string): boolean {
  const run = (args: string[]): boolean =>
    safeExecResult('git', args, { cwd: root, stdio: 'ignore', timeout: 30_000 }).success;

  return (
    run(['init', '--quiet', '--initial-branch=main']) &&
    run(['config', 'user.email', 'oracle@example.invalid']) &&
    run(['config', 'user.name', 'Pipeline Oracle']) &&
    run(['config', 'commit.gpgsign', 'false']) &&
    run(['config', 'core.hooksPath', '/dev/null']) &&
    run(['add', '--all']) &&
    run(['commit', '--quiet', '--no-verify', '-m', 'trap corpus'])
  );
}
