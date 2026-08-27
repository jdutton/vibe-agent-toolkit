/**
 * Tripwires for MIME-based parser routing.
 *
 * VAT used to hand every non-`.html` file to remark. What that cost, measured on
 * one adopter tree: **64.7%** of all `blob_references` rows came from files that
 * are not markdown, **100%** of dangling-reference warnings did, and **40%** of
 * all `blob_sections` rows were `#` comments in `.tf` / `.py` / `.yaml` read as
 * ATX headings. A JSON-Schema `pattern` of `"^[a-z][a-z0-9-]*$"` is two adjacent
 * bracket groups, which CommonMark reads as a full reference link — that single
 * shape is the mechanism behind all 230 `UNRESOLVED_REFERENCE` warnings, 42 of
 * them inside `pattern` values.
 *
 * Routing now asks `mime-type.ts` what a file IS, and only a type meaning prose
 * or markup reaches a parser. Every assertion below fails if that else-branch
 * comes back.
 *
 * ## The constraint that decides whether the change is CORRECT
 *
 * Route away from the **parser**, never from the **lexer**. `findLexicalReferences`
 * reads raw source and needs no AST; roughly **46,600 of 51,783** reference rows
 * on this repo come from it, and they are what makes a skill's bundled scripts
 * closure members at all. A change that silences remark by also silencing the
 * lexer would satisfy every "no markdown-link" assertion here and be wrong. That
 * is why the lexer tripwires are as heavily pinned as the parser ones.
 *
 * ## Why the fixtures all carry a marker line
 *
 * ⚠️ Blobs are **content-addressed and path-independent**. Two fixture files with
 * identical bytes are ONE blob with ONE row set, and a lookup by path attributes
 * that set to whichever path it finds first. An earlier experiment wrote
 * byte-identical `.ts`/`.md` twins, saw 0 rows for every `.ts` and 1 for every
 * `.md`, and nearly reported "extension gates reference extraction" — it had
 * measured one blob. Every fixture below therefore opens with a line naming
 * itself, so no two share bytes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parserKindForPath } from '../src/content-key.js';
import type { Projection } from '../src/projection/projection.js';
import type { BlobReferenceRow, BlobRow, BlobSectionRow } from '../src/schemas/projection-blobs.js';

import { conditionsWithCode, populateFixtureRoot } from './blob-fixture-population.js';
import { setupSubdirTestSuite, writeCorpusFiles, type CorpusFile } from './test-helpers.js';

/** The AST form only a markdown parse can produce. Its absence is the headline pin. */
const MARKDOWN_LINK = 'markdown-link';

/** The AST form only an HTML parse can produce. */
const HTML_LINK = 'html-link';

/** Lexer forms — raw-source products, which must survive the routing change. */
const BARE_TOKEN = 'bare-token';
const AT_PREFIXED = 'at-prefixed';
const ENV_ANCHORED = 'env-anchored';

/** The condition code the two-adjacent-bracket-groups defect produced by the thousand. */
const UNRESOLVED_REFERENCE = 'UNRESOLVED_REFERENCE';

/** The bracket pair at the centre of the whole change: text `[a-z]`, label `[a-z0-9-]`. */
const SLUG_REGEX_LINE = 'const SLUG = /^[a-z][a-z0-9-]*$/;';

/** The label CommonMark reads out of {@link SLUG_REGEX_LINE} when it parses one. */
const SLUG_REGEX_LABEL = 'a-z0-9-';

const INLINE_LINK_TS = 'src/inline-link.ts';
const SLUG_PATTERN_TS = 'src/slug-pattern.ts';
const LEXER_FORMS_TS = 'src/lexer-forms.ts';
const MAIN_TF = 'infra/main.tf';
const PROBE_PY = 'tools/probe.py';
const FLOW_MMD = 'docs/flow.mmd';
const SETTINGS_YAML = 'config/settings.yaml';
const SLUG_PATTERN_MD = 'docs/slug-pattern.md';
const FRONT_MD = 'docs/front.md';
const README_BARE = 'README';
const README_TXT = 'README.txt';
const README_MD = 'README.md';
const PAGE_HTML = 'page.html';

/** The three prose routes, which must ALL still reach remark. */
const PROSE_ROUTES = [README_BARE, README_TXT, README_MD] as const;

/** The tokens {@link LEXER_FORMS_TS} plants, one per lexical form. */
const AT_TOKEN = '@docs/guide.md';
const BARE_TOKEN_TEXT = './sibling.js';
const ENV_TOKEN = '${CLAUDE_PLUGIN_ROOT}/x.md';

const CORPUS: readonly CorpusFile[] = [
  // ── Item 1: the headline. A markdown link inside a string literal.
  {
    path: INLINE_LINK_TS,
    content: [
      '// fixture inline-link: a markdown link trapped in a TypeScript string',
      'export const s = "[notreally](alink)";',
      '',
    ].join('\n'),
  },

  // ── Item 7: the regex. Two adjacent bracket groups, in real source.
  {
    path: SLUG_PATTERN_TS,
    content: [
      '// fixture slug-pattern: a character-class pair that CommonMark reads as a link',
      `export ${SLUG_REGEX_LINE}`,
      '',
    ].join('\n'),
  },

  // ── Item 3: one token per lexical form, in a file no parser reads.
  // The marker line deliberately contains no slash-and-extension token, so the
  // row count below is exactly the three forms and not four.
  {
    path: LEXER_FORMS_TS,
    content: [
      '// fixture lexer-forms: three raw-source token shapes, zero AST',
      `// see ${AT_TOKEN} for details`,
      `import { x } from '${BARE_TOKEN_TEXT}';`,
      `// template at ${ENV_TOKEN}`,
      'export const y = x;',
      '',
    ].join('\n'),
  },

  // ── Item 5: `#` comments that were 40% of all blob_sections rows.
  {
    path: MAIN_TF,
    content: [
      '# fixture main.tf: a Terraform comment, not an ATX heading',
      '## and a second one, which would have been a nested section',
      'resource "null_resource" "noop" {}',
      '',
    ].join('\n'),
  },
  {
    path: PROBE_PY,
    content: [
      '# fixture probe.py: a Python comment, not an ATX heading',
      '## nor is this one',
      'VALUE = 1',
      '',
    ].join('\n'),
  },

  // ── Item 6: files opening with `---`. 21 of 22 Mermaid files in the adopter
  // repo were having their diagram directives parsed as YAML frontmatter.
  {
    path: FLOW_MMD,
    content: ['---', 'title: fixture flow.mmd', '---', 'graph TD', '  A --> B', ''].join('\n'),
  },
  {
    path: SETTINGS_YAML,
    content: ['---', 'name: fixture settings.yaml', '---', 'value: 1', ''].join('\n'),
  },

  // ── The differential controls. Same shapes, real markdown, distinct bytes.
  {
    path: SLUG_PATTERN_MD,
    content: ['# fixture slug-pattern.md', '', SLUG_REGEX_LINE, ''].join('\n'),
  },
  {
    path: FRONT_MD,
    content: ['---', 'title: fixture front.md', '---', '', 'Body text.', ''].join('\n'),
  },

  // ── Item 8: the half people assume broke. All three route to markdown.
  { path: README_BARE, content: '# fixture README, no extension\n\nSee [x](y).\n' },
  { path: README_TXT, content: '# fixture README.txt\n\nSee [x](y).\n' },
  { path: README_MD, content: '# fixture README.md\n\nSee [x](y).\n' },

  // ── Item 9: HTML keeps its own parser.
  { path: PAGE_HTML, content: '<!-- fixture page.html -->\n<p><a href="./b.md">b</a></p>\n' },
];

const DIRECTORIES = ['src', 'infra', 'tools', 'docs', 'config'] as const;

/** Everything one path's blob says, gathered by content key rather than by path. */
interface BlobFacts {
  /** `<parserKind>.<sha256>` — the prefix IS the routing decision, recorded per blob. */
  key: string;
  row: BlobRow | undefined;
  references: readonly BlobReferenceRow[];
  sections: readonly BlobSectionRow[];
}

const suite = setupSubdirTestSuite('parser-routing-tripwires-');

/**
 * The one population every test below reads.
 *
 * Populated once rather than per test: the corpus is static and every assertion
 * is read-only, and a second population would only be a second chance for two
 * tests to disagree about which run they are describing.
 */
let projection: Projection;

/**
 * Look one path's blob up through its content key.
 *
 * Two steps on purpose. `resource_realizations` is the only table that knows
 * paths; every blob-keyed table joins on the key. Going through it is also what
 * makes the routing decision *visible* — see {@link BlobFacts.key}.
 *
 * @param path - Root-relative fixture path
 * @returns Its key and every blob-keyed row filed under that key
 */
function blobAt(path: string): BlobFacts {
  const key = projection.resourceRealizations.find((row) => row.path === path)?.contentKey ?? '';
  return {
    key,
    row: projection.blobs.find((blob) => blob.contentKey === key),
    references: projection.blobReferences.filter((row) => row.blob === key),
    sections: projection.blobSections.filter((row) => row.blob === key),
  };
}

/**
 * The syntactic forms one path's references carry, in row order.
 *
 * @param path - Root-relative fixture path
 * @returns Every `syntacticForm`, duplicates kept — a form appearing twice is a
 *   different fact from a form appearing once
 */
function formsAt(path: string): readonly string[] {
  return blobAt(path).references.map((row) => row.syntacticForm);
}

describe('MIME parser routing', () => {
  beforeAll(async () => {
    await suite.beforeAll();
    await suite.beforeEach();
    await writeCorpusFiles(suite.tempDir, DIRECTORIES, CORPUS);
    projection = (await populateFixtureRoot(suite.tempDir)).projection;
  });
  afterAll(suite.afterAll);

  it('does not read a markdown link out of a TypeScript string literal', () => {
    // 🚩 THE HEADLINE. `const s = "[notreally](alink)";` is a string, not a link.
    // Under the old else-branch this produced a `markdown-link` row pointing at a
    // file named `alink`, and rows of exactly this provenance were 64.7% of the
    // reference table on the measured adopter tree.
    expect(formsAt(INLINE_LINK_TS)).not.toContain(MARKDOWN_LINK);
    // Stronger, and the assertion that actually catches a partial revert: NO row
    // of AST provenance at all. `not.toContain` on one form would still pass if
    // the parser came back emitting `markdown-link-reference` or `html-link`.
    expect(blobAt(INLINE_LINK_TS).row?.linkCount).toBe(0);
  });

  it('does not route source, data or config files to the markdown parser', () => {
    // Named for the six extensions that were the bulk of the misrouting: 5,329
    // `.ts` and 713 `.json` files on one tree. Asserted as a filter rather than a
    // per-path table so a single failure names every extension that regressed.
    const routed = ['x.ts', 'x.json', 'x.csv', 'x.tf', 'x.yaml', 'x.py'].map(
      (path) => [path, parserKindForPath(path)] as const,
    );

    expect(routed.filter(([, kind]) => kind === 'markdown')).toEqual([]);
    expect(routed.filter(([, kind]) => kind !== 'none')).toEqual([]);
  });

  it('still lexes a source file, so a skill keeps its bundled scripts', () => {
    // 🔑 The constraint that decides correctness. `findLexicalReferences` reads
    // RAW SOURCE and never needed an AST; ~46,600 of this repo's 51,783 reference
    // rows come from it, and they are the edges that pull a skill's scripts into
    // its closure. Routing away from the parser must not route away from this.
    const found = blobAt(LEXER_FORMS_TS).references.map((row) => [row.syntacticForm, row.rawRef, row.line]);

    expect(found).toEqual([
      [AT_PREFIXED, AT_TOKEN, 2],
      [BARE_TOKEN, BARE_TOKEN_TEXT, 3],
      [ENV_ANCHORED, ENV_TOKEN, 4],
    ]);
  });

  it('gives every lexed token offsets that index the source it came from', () => {
    // Offsets are what lets a rewriter replace exactly the token. Derived from
    // the fixture by lookup rather than hand-counted, so an edit to the fixture
    // cannot leave a stale number silently pointing at the wrong characters.
    const content = CORPUS.find((file) => file.path === LEXER_FORMS_TS)?.content ?? '';
    const { references } = blobAt(LEXER_FORMS_TS);

    expect(references.map((row) => content.slice(row.startOffset, row.endOffset)))
      .toEqual(references.map((row) => row.rawRef));
    expect(references.map((row) => row.startOffset))
      .toEqual([AT_TOKEN, BARE_TOKEN_TEXT, ENV_TOKEN].map((token) => content.indexOf(token)));
  });

  it('gives a blob no parser reads a real token estimate rather than no row at all', () => {
    // Without a `blobs` row there is no `tokenEstimate`; `whatLoadsAt` then
    // reports `tokens: null` and the context lane reports `'unknown-size'` — a
    // live accounting hole the moment a CLAUDE.md imports a `.ts` file. `none` is
    // a third SHAPE, not a fourth refusal.
    for (const path of [INLINE_LINK_TS, SLUG_PATTERN_TS, MAIN_TF, PROBE_PY, FLOW_MMD, SETTINGS_YAML]) {
      const { key, row } = blobAt(path);
      expect(key.startsWith('none.'), path).toBe(true);
      expect(row?.tokenEstimate ?? 0, path).toBeGreaterThan(0);
      expect(row?.wordCount ?? 0, path).toBeGreaterThan(0);
    }
  });

  it('does not read a `#` comment in Terraform or Python as an ATX heading', () => {
    // 40% of every `blob_sections` row on the adopter tree was this: `#` comments
    // in `.tf` / `.py` / `.yaml` becoming sections, complete with slugs and byte
    // spans, in files that have no sections.
    for (const path of [MAIN_TF, PROBE_PY]) {
      const { row, sections } = blobAt(path);
      expect(row?.headingCount, path).toBe(0);
      expect(row?.sectionCount, path).toBe(0);
      expect(sections, path).toEqual([]);
    }
  });

  it('does not parse frontmatter out of a Mermaid diagram or a YAML document', () => {
    // 21 of 22 Mermaid files in the adopter repo had their leading `---` block
    // parsed as frontmatter, so a diagram directive arrived in the projection as
    // document metadata. `unparsedFacts` omits the frontmatter trio entirely.
    for (const path of [FLOW_MMD, SETTINGS_YAML]) {
      const { row } = blobAt(path);
      expect(row?.frontmatter, path).toBeNull();
      expect(row?.frontmatterError, path).toBeNull();
    }
    // The control: a real markdown document still gets its frontmatter, so the
    // two assertions above are about the ROUTE and not about frontmatter dying.
    expect(blobAt(FRONT_MD).row?.frontmatter).toEqual({ title: 'fixture front.md' });
  });

  it('does not warn about a dangling reference invented from a regular expression', () => {
    // The single most persuasive case. `/^[a-z][a-z0-9-]*$/` is text `[a-z]`
    // followed by label `[a-z0-9-]` — a full CommonMark reference link with no
    // definition. That shape produced ALL 230 `UNRESOLVED_REFERENCE` warnings on
    // the adopter tree, 42 of them inside JSON-Schema `pattern` values.
    const dangling = conditionsWithCode(projection, UNRESOLVED_REFERENCE);

    expect(dangling.map((row) => row.blob)).not.toContain(blobAt(SLUG_PATTERN_TS).key);
    // The control, and the reason this test cannot pass vacuously: the SAME
    // bracket pair in a file that really is markdown still warns. Without it, a
    // detector that had simply stopped working would satisfy the line above.
    expect(dangling.map((row) => [row.blob, row.message]))
      .toEqual([[blobAt(SLUG_PATTERN_MD).key, SLUG_REGEX_LABEL]]);
  });

  it('still parses prose at README, README.txt and README.md alike', () => {
    // The half people will assume broke. Three different routes reach remark —
    // the extensionless basename table, `.txt` → `text/plain`, and `.md` →
    // `text/markdown` — and dropping any one of them would quietly stop parsing
    // a file that every repository carries.
    for (const path of PROSE_ROUTES) {
      expect(blobAt(path).key.startsWith('markdown.'), path).toBe(true);
      expect(formsAt(path), path).toContain(MARKDOWN_LINK);
      expect(blobAt(path).row?.headingCount, path).toBe(1);
    }
  });

  it('keys every blob the way parserKindForPath would, absent a declared override', () => {
    // ⚠️ There are TWO routing lanes and they are not the same call.
    // `parserKindForPath` (path text → kind) is what `resource-registry.ts`,
    // `walk-link-graph.ts` and `parse-fact-snapshot.ts` ask. The projection asks
    // `parserKindForMimeType(row.mime)` instead — deliberately, because a
    // collection may DECLARE `text/markdown` for a `.ts` file and that
    // declaration must reach the parser and not merely the column
    // (`realizations.ts`, `keyOrState`).
    //
    // The consequence, found by flipping `parserKindForPath` to `'markdown'` and
    // watching this whole file stay green but for one test: nothing else here can
    // see that function change. This is the pin that binds the lanes — no fixture
    // below declares an override, so on this corpus the two must agree exactly,
    // and a change to either alone reds.
    const keyed = projection.resourceRealizations.filter((row) => row.contentKey !== null);
    const disagreements = keyed.filter(
      (row) => row.contentKey?.split('.')[0] !== parserKindForPath(row.path),
    );

    expect(disagreements.map((row) => [row.path, row.mime, row.contentKey])).toEqual([]);
    // Not vacuous: the corpus really does exercise all three kinds.
    expect(new Set(keyed.map((row) => row.contentKey?.split('.')[0]))).toEqual(
      new Set(['markdown', 'html', 'none']),
    );
  });

  it('still routes .html to the HTML parser and not to markdown', () => {
    // `html-link` is an AST form no markdown parse and no lexer can emit, so its
    // presence names the parser that ran.
    expect(blobAt(PAGE_HTML).key.startsWith('html.')).toBe(true);
    expect(formsAt(PAGE_HTML)).toContain(HTML_LINK);
    expect(formsAt(PAGE_HTML)).not.toContain(MARKDOWN_LINK);
  });
});
