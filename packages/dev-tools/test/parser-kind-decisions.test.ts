/**
 * No shipping `src` file decides a parser kind on its own unless it is on a
 * reviewed list: the projection router (`packages/resources/src/projection/router.ts`)
 * is the one decision.
 *
 * The import boundary (`parser-kind-router-boundary.test.ts`) holds who may
 * compose the two `mime-type.ts` tables. This test holds the other ways a site
 * can decide a kind without importing either table:
 *
 * 1. **A kind literal.** Any `'markdown'` or `'html'` string literal in a value
 *    position: a call argument, `const k = 'markdown'`, a ternary arm,
 *    `{ kind: 'markdown' }`, a comparison. A literal in a type position (a
 *    `ParserKind` declaration, an annotation, a `satisfies` type) decides
 *    nothing at run time and is not counted. Every file holding one is in
 *    {@link KIND_LITERAL_SITES} at its exact count.
 * 2. **The contract constant.** `MARKDOWN_BY_CONTRACT` is for a document a
 *    contract makes markdown (a `SKILL.md`, a Claude Code skill, agent or command
 *    file, an OKF document, a frontmatter block). Every file using it is in
 *    {@link CONTRACT_SITES} at its exact count, so a decision the path makes
 *    cannot be relabelled a contract. It is never aliased or re-bound
 *    (`import { MARKDOWN_BY_CONTRACT as M }`, `const K = MARKDOWN_BY_CONTRACT`):
 *    a use through another name would escape the count, so either form fails.
 * 3. **An extension literal.** A string literal naming an extension the router
 *    hands to a document parser (`'.md'`, `'.HTML'`), its dotless spelling
 *    (`ext === 'md'`), a template part that is one (`` `${stem}.md` ``), or a
 *    regex literal that matches one, is how a hand-written `endsWith` routing
 *    starts. The set is derived from the router itself, never hand-kept. A
 *    dotless spelling that is also a kind (`'html'`, `'markdown'`) is counted
 *    once, as a kind literal. Every file holding one is in
 *    {@link EXTENSION_SITES} at its exact count.
 *
 * Every list is asserted both ways: a file found and not listed (or at another
 * count) fails, and a listed file holding none fails. Sites whose reason is
 * {@link PRE_EXISTING} are the hand-written decisions recorded in
 * `docs/contributing/known-defects.md` ("parser-kind decisions outside the
 * router"): moving them onto the router changes what they decide.
 *
 * The private packages (`dev-tools`, `lab`) are out of scope: they ship to no user.
 */

import { type DocumentParserKind, parserKindForPath } from '@vibe-agent-toolkit/resources';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { packageSources } from './package-sources.js';
import { nodesOf, shippingImporters, sourceOf } from './typescript-ast.js';

/** The document parser kinds, bound to the type: a kind added there and not here fails to compile. */
const KIND_SET = { markdown: true, html: true } as const satisfies Record<DocumentParserKind, true>;
const KINDS: readonly string[] = Object.keys(KIND_SET);

/** The one module that may spell a kind or a routed extension. */
const ROUTER = 'packages/resources/src/projection/router.ts';

/** The table the router composes: it owns the kind and extension spellings. */
const MIME_TABLE = 'packages/resources/src/mime-type.ts';

/** The constant a contract-fixed kind is spelled with. */
const CONTRACT_CONSTANT = 'MARKDOWN_BY_CONTRACT';

/** The reason every pre-existing hand-written decision carries. */
const PRE_EXISTING = 'pre-existing extension decision; moving it onto the router changes behaviour, see known-defects';

/** A reviewed file: how many of the detector's finds it holds, and why each is allowed. */
interface ReviewedSite {
  readonly count: number;
  readonly reason: string;
}

/** Reviewed files whose kind literals are allowed, at their exact count. */
const KIND_LITERAL_SITES: ReadonlyMap<string, ReviewedSite> = new Map([
  ['packages/agent-skills/src/post-build-checks.ts', { count: 1, reason: PRE_EXISTING }],
  ['packages/agent-skills/src/skill-text-lane.ts', { count: 1, reason: PRE_EXISTING }],
  ['packages/agent-skills/src/validators/packaging-validator.ts', { count: 1, reason: PRE_EXISTING }],
  ['packages/agent-skills/src/validators/referenced-path-missing.ts', { count: 1, reason: PRE_EXISTING }],
  ['packages/agent-skills/src/walk-link-graph.ts', { count: 1, reason: 'compares the router answer it was given' }],
  ['packages/claude-marketplace/src/compatibility-analyzer.ts', { count: 1, reason: PRE_EXISTING }],
  ['packages/claude-marketplace/src/scanners/python-stdlib-modules.generated.ts', { count: 1, reason: 'the Python html module name, not a parser kind' }],
  ['packages/discovery/src/detectors/format-detector.ts', { count: 1, reason: 'discovery file-format label, not a parse' }],
  ['packages/resources/src/content-key.ts', { count: 2, reason: 'the parser-kind vocabulary a content key carries' }],
  ['packages/resources/src/parse-cache.ts', { count: 1, reason: 'compares a stored kind with the facts it filed' }],
  ['packages/resources/src/parse-pool.ts', { count: 1, reason: 'labels a parser-unavailable error with no job, not a parse' }],
  ['packages/resources/src/parse-timing.ts', { count: 2, reason: 'names each parser the timing probe loads' }],
  ['packages/resources/src/testing/blob-writer-contract.ts', { count: 1, reason: 'the one kind the blob-writer contract mints its test keys under' }],
  ['packages/resources/src/parser-loader.ts', { count: 1, reason: 'loads the parser for a kind already decided' }],
  ['packages/resources/src/projection/blob-population.ts', { count: 1, reason: 'compares a content key kind already decided' }],
  ['packages/resources/src/projection/blob-resource-facts.ts', { count: 2, reason: 'compares a content key kind already decided' }],
  ['packages/resources/src/projection/claude-memory.ts', { count: 2, reason: 'a marked token type, not a parser kind' }],
  ['packages/resources/src/remark-parser.ts', { count: 2, reason: 'an mdast node type, not a parser kind' }],
  ['packages/resources/src/types/resources.ts', { count: 1, reason: 'the ResourceType enum label, not a parse' }],
]);

/** The files a contract makes markdown in, allowed {@link CONTRACT_CONSTANT}, at their exact count. */
const CONTRACT_SITES: ReadonlyMap<string, ReviewedSite> = new Map([
  ['packages/agent-skills/src/parsers/frontmatter-parser.ts', { count: 1, reason: 'a frontmatter block cut out of a document' }],
  ['packages/agent-skills/src/skill-identity.ts', { count: 1, reason: 'a SKILL.md' }],
  ['packages/agent-skills/src/skill-packager.ts', { count: 1, reason: 'a SKILL.md' }],
  ['packages/agent-skills/src/skill-text-lane.ts', { count: 4, reason: 'a SKILL.md; the raw UTF-8 text the linked-file and implicit-reference scans run over' }],
  ['packages/claude-marketplace/src/inventory/extract-skill.ts', { count: 1, reason: 'a SKILL.md' }],
  ['packages/claude-marketplace/src/settings/settings-compat-checker.ts', { count: 1, reason: 'a SKILL.md' }],
  ['packages/cli/src/commands/skills/skill-discovery.ts', { count: 1, reason: 'a SKILL.md' }],
  ['packages/resources/src/okf/validate.ts', { count: 1, reason: 'an OKF document, markdown by the format spec' }],
]);

/** Reviewed files whose routed-extension literals are allowed, at their exact count. */
const EXTENSION_SITES: ReadonlyMap<string, ReviewedSite> = new Map([
  ['packages/agent-skills/src/content-type-routing.ts', { count: 1, reason: 'bundle subdirectory a packaged file lands in, not its parser' }],
  ['packages/agent-skills/src/post-build-checks.ts', { count: 12, reason: PRE_EXISTING }],
  ['packages/agent-skills/src/skill-packager.ts', { count: 4, reason: `${PRE_EXISTING}; one strips .md from a SKILL file name` }],
  ['packages/agent-skills/src/skill-text-lane.ts', { count: 1, reason: 'strips .md from a SKILL file name' }],
  ['packages/agent-skills/src/validators/packaging-validator.ts', { count: 2, reason: PRE_EXISTING }],
  ['packages/agent-skills/src/validators/skill-validator.ts', { count: 1, reason: PRE_EXISTING }],
  ['packages/claude-marketplace/src/compatibility-analyzer.ts', { count: 1, reason: PRE_EXISTING }],
  ['packages/claude-marketplace/src/inventory/extract-plugin.ts', { count: 1, reason: 'the Claude Code agent and command file set' }],
  ['packages/cli/src/commands/claude/org/skills.ts', { count: 2, reason: 'the skill documents of an uploaded skill archive, markdown by contract' }],
  ['packages/cli/src/commands/skill/review.ts', { count: 1, reason: 'refuses a non-SKILL argument to vat skill review' }],
  ['packages/cli/src/qa-snapshot/capture.ts', { count: 1, reason: 'names a snapshot artifact it writes, not a parse' }],
  ['packages/cli/src/utils/help-loader.ts', { count: 1, reason: 'names the CLI help doc it loads, not a parse' }],
  ['packages/cli/src/utils/validate-help-files.ts', { count: 1, reason: 'lists the CLI help docs it ships' }],
  ['packages/discovery/src/detectors/format-detector.ts', { count: 1, reason: 'discovery file-format label, not a parse' }],
  ['packages/resource-compiler/src/compiler/markdown-compiler.ts', { count: 1, reason: 'strips .md to name a compiled module' }],
  ['packages/resource-compiler/src/language-service/utils.ts', { count: 3, reason: 'TypeScript import specifiers of compiled .md modules' }],
  ['packages/resource-compiler/src/transformer/import-detector.ts', { count: 1, reason: 'TypeScript import specifiers of compiled .md modules' }],
  ['packages/resources/src/content-transform.ts', { count: 3, reason: 'output-labelling table, not a parse' }],
  ['packages/resources/src/link-classify.ts', { count: 1, reason: 'classifies an href as a local file, not a parse' }],
  ['packages/resources/src/link-validator.ts', { count: 1, reason: PRE_EXISTING }],
  ['packages/resources/src/okf/discovery.ts', { count: 1, reason: 'OKF documents are .md by the format spec' }],
  ['packages/resources/src/projection/agentic-tags.ts', { count: 3, reason: 'Claude Code harness file names, as the harness spells them' }],
  ['packages/resources/src/projection/builtin-checks.ts', { count: 1, reason: 'Claude Code rules file name, as the harness spells it' }],
  ['packages/resources/src/projection/harness/claude-code-entry-names.ts', { count: 1, reason: 'Claude Code rules file extension, as the harness spells it' }],
  ['packages/resources/src/projection/harness/claude-code.ts', { count: 4, reason: 'the harness memory-file extension list, transcribed' }],
  ['packages/utils/src/testing/archive-fixtures.ts', { count: 3, reason: 'names hostile archive entries a fixture plants, not a parse' }],
]);

/**
 * A text pre-check: every routed extension (`.md`, `.markdown`, `.html`, `.htm`,
 * `.txt`) contains one of these, so a file matching none holds no routed literal
 * and its parse is skipped. A detector self-test holds every extension the MIME
 * table routes against it.
 */
const MAY_SPELL_ROUTED_EXTENSION = /md|markdown|htm|txt/i;

/** Whether `text` is an extension the router hands to a document parser. */
function isRoutedExtension(text: string): boolean {
  return /^\.[a-z0-9]+$/i.test(text) && parserKindForPath(`x${text}`) !== 'none';
}

/**
 * The extensions a regex literal's `\.` alternatives spell, `html?` expanded to
 * both spellings: enough to see `/\.html?$/i` and `/\.(md|markdown)$/`.
 */
function regexExtensions(pattern: string): string[] {
  const found: string[] = [];
  for (const match of pattern.matchAll(/\\\.\(?(?:\?:)?([a-z0-9?|]+)/gi)) {
    for (const alternative of (match[1] ?? '').split('|')) {
      const stem = alternative.replace(/\?$/, '');
      found.push(`.${stem}`);
      if (alternative.endsWith('?')) found.push(`.${stem.slice(0, -1)}`);
    }
  }
  return found;
}

/** Every node of `body` outside a type position: a literal type's subtree is never visited. */
function valueNodesOf(body: string): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isLiteralTypeNode(node)) return;
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(body));
  return nodes;
}

/** The kind literals `body` holds in value positions. */
function kindLiterals(body: string): string[] {
  // A literal's text is spelled in the source, so a file naming no kind holds none: skip its walk.
  if (!KINDS.some((kind) => body.includes(kind))) return [];
  return valueNodesOf(body)
    .filter((node): node is ts.StringLiteralLike => ts.isStringLiteralLike(node))
    .map((node) => node.text)
    .filter((text) => KINDS.includes(text));
}

/** The uses of {@link CONTRACT_CONSTANT} in `body`: every reference, never an import or export specifier. */
function contractUses(body: string): string[] {
  if (!body.includes(CONTRACT_CONSTANT)) return [];
  const nodes = nodesOf(sourceOf(body));
  const specifierNames = new Set<ts.Node>(
    nodes
      .filter((node): node is ts.ImportSpecifier | ts.ExportSpecifier => ts.isImportSpecifier(node) || ts.isExportSpecifier(node))
      .flatMap((node) => [node.name, ...(node.propertyName === undefined ? [] : [node.propertyName])]),
  );
  return nodes
    .filter((node): node is ts.Identifier => ts.isIdentifier(node) && node.text === CONTRACT_CONSTANT && !specifierNames.has(node))
    .map((node) => node.text);
}

/**
 * The ways `body` reaches {@link CONTRACT_CONSTANT} under another name: an
 * aliased import or export, a destructured alias, or a binding or assignment
 * whose value is the bare constant. Each would let a use escape {@link contractUses}.
 */
function contractRebindings(body: string): string[] {
  if (!body.includes(CONTRACT_CONSTANT)) return [];
  const source = sourceOf(body);
  return nodesOf(source).flatMap((node) => {
    if ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node) || ts.isBindingElement(node)) && node.propertyName !== undefined) {
      const from = node.propertyName.getText(source);
      const to = node.name.getText(source);
      return from === CONTRACT_CONSTANT && to !== CONTRACT_CONSTANT ? [`${from} as ${to}`] : [];
    }
    return namesContractConstant(boundValueOf(node)) ? [node.getText(source)] : [];
  });
}

/** The value a declaration binds or an assignment stores; `undefined` for any other node. */
function boundValueOf(node: ts.Node): ts.Expression | undefined {
  if (ts.isVariableDeclaration(node)) return node.initializer;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return node.right;
  return undefined;
}

/** Whether `value` is the bare constant, by its own name or as a namespace member. */
function namesContractConstant(value: ts.Expression | undefined): boolean {
  if (value === undefined) return false;
  if (ts.isIdentifier(value)) return value.text === CONTRACT_CONSTANT;
  return ts.isPropertyAccessExpression(value) && value.name.text === CONTRACT_CONSTANT;
}

/** Whether `text` is a routed extension spelled without its dot (`'md'`), and not a kind, which the kind list counts. */
function isDotlessRoutedExtension(text: string): boolean {
  return !KINDS.includes(text) && isRoutedExtension(`.${text}`);
}

/** The routed-extension literals in `body`: string, dotless, template and regex literals. */
function extensionLiterals(body: string): string[] {
  if (!MAY_SPELL_ROUTED_EXTENSION.test(body)) return [];
  return nodesOf(sourceOf(body)).flatMap((node) => {
    if (ts.isStringLiteralLike(node)) {
      return isRoutedExtension(node.text) || isDotlessRoutedExtension(node.text) ? [node.text] : [];
    }
    if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      return isRoutedExtension(node.text) ? [node.text] : [];
    }
    if (ts.isRegularExpressionLiteral(node)) {
      return regexExtensions(node.text).some((ext) => isRoutedExtension(ext)) ? [node.text] : [];
    }
    return [];
  });
}

/**
 * The files where what was found and what was reviewed disagree, both ways: a
 * found file not listed or at another count, and a listed file holding none.
 *
 * @param found - Each file a detector found something in, with what it found
 * @param reviewed - The reviewed list
 * @returns One line per disagreement; empty when the two agree
 */
function disagreements(found: ReadonlyMap<string, string[]>, reviewed: ReadonlyMap<string, ReviewedSite>): string[] {
  const unreviewed = [...found]
    .filter(([file, hits]) => reviewed.get(file)?.count !== hits.length)
    .map(([file, hits]) => `${file} (${hits.length}, reviewed ${reviewed.get(file)?.count ?? 0}) -> ${hits.join(', ')}`);
  const stale = [...reviewed.keys()].filter((file) => !found.has(file)).map((file) => `${file} is listed but holds none`);
  return [...unreviewed, ...stale];
}

/** A detector's finds across the shipping tree, the owning modules excluded. */
function shippingFinds(detect: (body: string) => string[], owners: readonly string[]): Map<string, string[]> {
  return new Map([...shippingImporters(detect).importers].filter(([file]) => !owners.includes(file)));
}

describe('only the router decides a parser kind', () => {
  it('every kind literal outside the router is a reviewed site, at its reviewed count, and every reviewed site holds one', () => {
    expect(disagreements(shippingFinds(kindLiterals, [ROUTER, MIME_TABLE]), KIND_LITERAL_SITES)).toEqual([]);
  });

  it('MARKDOWN_BY_CONTRACT is used only at the reviewed contract sites, at their counts, and each still uses it', () => {
    expect(disagreements(shippingFinds(contractUses, [ROUTER]), CONTRACT_SITES)).toEqual([]);
  });

  it('MARKDOWN_BY_CONTRACT is never aliased or re-bound, so every use is counted under its own name', () => {
    expect(Object.fromEntries(shippingFinds(contractRebindings, [ROUTER]))).toEqual({});
  });

  it('every routed-extension literal outside the router is a reviewed site, at its reviewed count, and every reviewed site holds one', () => {
    expect(disagreements(shippingFinds(extensionLiterals, [ROUTER, MIME_TABLE]), EXTENSION_SITES)).toEqual([]);
  });
});

describe('the parser-decision detectors', () => {
  it('see a kind literal in every value position, and none in a type position', () => {
    const body = [
      "await parseFileCached(p, 'markdown', route);",
      "const k = 'html';",
      "const t = isHtml ? 'html' : 'markdown';",
      "const o = { kind: 'markdown' };",
      "if (kind === 'html') {}",
      "type Kind = 'markdown' | 'html';",
      "let v: 'markdown' = x;",
      "const c = 'markdown' satisfies 'markdown' | 'html';",
      'await parseFileCached(p, MARKDOWN_BY_CONTRACT, route);',
      "// parseFileCached(p, 'markdown')",
    ].join('\n');
    expect(kindLiterals(body)).toEqual(['markdown', 'html', 'html', 'markdown', 'markdown', 'html', 'markdown']);
  });

  it('see every use of the contract constant, and not its import or export', () => {
    const body = [
      "import { MARKDOWN_BY_CONTRACT } from '@vibe-agent-toolkit/resources';",
      "export { MARKDOWN_BY_CONTRACT as M } from './router.js';",
      'await read(p, MARKDOWN_BY_CONTRACT);',
      'const k = MARKDOWN_BY_CONTRACT;',
    ].join('\n');
    expect(contractUses(body)).toEqual([CONTRACT_CONSTANT, CONTRACT_CONSTANT]);
  });

  it('see every alias and re-binding of the contract constant, and not a plain import, re-export or use', () => {
    const body = [
      "import { MARKDOWN_BY_CONTRACT as M } from '@vibe-agent-toolkit/resources';",
      "export { MARKDOWN_BY_CONTRACT as N } from './router.js';",
      'const K = MARKDOWN_BY_CONTRACT;',
      'const R = resources.MARKDOWN_BY_CONTRACT;',
      'const { MARKDOWN_BY_CONTRACT: D } = resources;',
      'k = MARKDOWN_BY_CONTRACT;',
      "import { MARKDOWN_BY_CONTRACT } from '@vibe-agent-toolkit/resources';",
      "export { MARKDOWN_BY_CONTRACT } from './router.js';",
      'await read(p, MARKDOWN_BY_CONTRACT);',
      'const o = { kind: MARKDOWN_BY_CONTRACT };',
    ].join('\n');
    expect(contractRebindings(body)).toEqual([
      'MARKDOWN_BY_CONTRACT as M',
      'MARKDOWN_BY_CONTRACT as N',
      'K = MARKDOWN_BY_CONTRACT',
      'R = resources.MARKDOWN_BY_CONTRACT',
      'MARKDOWN_BY_CONTRACT as D',
      'k = MARKDOWN_BY_CONTRACT',
    ]);
  });

  it('see extension literals of any case and regex literals, and no unrouted one', () => {
    const body = [
      "if (p.endsWith('.md') || p.endsWith('.HTML')) {}",
      "const s = new Set(['.markdown', '.py', '.json']);",
      String.raw`const r = /\.html?$/i; const q = /\.(?:md|txt)$/; const z = /\.py$/;`,
      "// p.endsWith('.htm')",
      'const f = `${stem}.md`; const g = `${dir}/${stem}.HTM`; const h = `${stem}.py`; const n = `${dir}/SKILL.md`;',
      "if (ext === 'md' || ext === 'txt' || ext === 'py' || ext === 'html') {}",
    ].join('\n');
    expect(extensionLiterals(body)).toEqual([
      '.md',
      '.HTML',
      '.markdown',
      String.raw`/\.html?$/i`,
      String.raw`/\.(?:md|txt)$/`,
      '.md',
      '.HTM',
      'md',
      'txt',
    ]);
  });

  it('skip only files that cannot spell a routed extension: every one the MIME table routes passes the pre-check', () => {
    const table = packageSources().get(MIME_TABLE) ?? '';
    const routed = [...table.matchAll(/'(\.[a-z0-9]+)'/gi)].map((match) => match[1] ?? '').filter((ext) => isRoutedExtension(ext));
    expect(routed.length).toBeGreaterThanOrEqual(5);
    expect(routed.filter((ext) => !MAY_SPELL_ROUTED_EXTENSION.test(ext))).toEqual([]);
  });

  it('hold a reviewed list both ways', () => {
    const reviewed = new Map([['a.ts', { count: 1, reason: 'r' }], ['b.ts', { count: 2, reason: 'r' }]]);
    expect(disagreements(new Map([['a.ts', ['x']], ['b.ts', ['x', 'y']]]), reviewed)).toEqual([]);
    expect(disagreements(new Map([['a.ts', ['x']], ['b.ts', ['x', 'y']], ['c.ts', ['z']]]), reviewed)).toEqual(['c.ts (1, reviewed 0) -> z']);
    expect(disagreements(new Map([['a.ts', ['x', 'x']], ['b.ts', ['x', 'y']]]), reviewed)).toEqual(['a.ts (2, reviewed 1) -> x, x']);
    expect(disagreements(new Map([['a.ts', ['x']]]), reviewed)).toEqual(['b.ts is listed but holds none']);
  });
});
