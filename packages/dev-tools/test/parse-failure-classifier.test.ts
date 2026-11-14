/**
 * Every per-file parse catch in `src` asks the one classifier, never the
 * blocklist, and never swallows.
 *
 * Whose fault a parse failure is has one answer, `classifyParseFailure` in
 * `packages/resources/src/parse-failure.ts`: an ALLOWLIST (a per-run refusal,
 * the parser's own throw over the bytes, a read the OS refused) that rethrows
 * everything else. Two shapes defeated it, and this file holds both:
 *
 * 1. **A blocklist of one.** A catch that rethrows only `isParserUnavailable(…)`
 *    and files the rest as a finding: every other VAT defect — a decode defect,
 *    an unbranded worker failure — became a finding about an innocent file, and
 *    on the inventory lane a row `vat audit` dropped at exit 0. Five lanes
 *    carried that guard at once. So no `src` file but the predicate's own module
 *    calls `isParserUnavailable`.
 * 2. **A catch-all.** A `try` around a parse-route entry ({@link PARSE_ENTRIES})
 *    whose `catch` neither classifies ({@link CLASSIFIERS}) nor throws anything:
 *    `vat audit`'s two compat lanes reported a broken install as a plugin "that
 *    could not be analyzed" and finished.
 *
 * ⚠️ What the second arm cannot see, stated rather than hidden: it reads one
 * `try` at a time, so it judges only a catch whose `try` block CALLS an entry
 * directly. A catch around a function that reaches the parse route further down
 * — `scanFile` in the compatibility analyzer, the registry crawl in the
 * inventory's link walk — is invisible to it; following calls needs a call
 * graph, which a textual enforcer does not have. Those catches are held by
 * their own behaviour tests. Nor does it judge the SHAPE of a catch that
 * throws: `if (pred(e)) throw e` passes like `if (!pred(e)) throw e`, so the
 * first arm, not this one, is what keeps the blocklist out.
 *
 * The detector reads the AST: a mention in a comment is not a call.
 */

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { packageSources } from './package-sources.js';

/** The module that defines the predicate. */
const DEFINITION = 'packages/resources/src/parse-cache.ts';

/** The blocklist predicate no catch may guard with. */
const PREDICATE = 'isParserUnavailable';

/**
 * The parse route's entry points, by callee name: each reaches the worker pool,
 * so each can reject with a VAT defect. `parse` counts only on a receiver named
 * like a dispatcher or a pool — `JSON.parse` is not the route.
 */
const PARSE_ENTRIES: ReadonlySet<string> = new Set([
  'parseFileCached',
  'parseContentCached',
  'parseFrontmatter',
  'analyzeCompatibility',
  'checkSettingsCompatibility',
  'addResource',
  'parse',
]);

/** A receiver the bare `parse` entry counts on. */
const PARSE_RECEIVER = /dispatcher|pool/i;

/**
 * What a catch may call to decide whose a failure is: the classifiers, and the
 * refusal readers that answer only for a per-run refusal (the caller rethrows
 * the rest — the catch must then throw, which it does).
 */
const CLASSIFIERS: ReadonlySet<string> = new Set([
  'classifyParseFailure',
  'classifyCompatibilityFailure',
  'isPerRunParseRefusal',
  'isParserThrewError',
  'parseRefusalIssue',
  'parseRefusedEntryFor',
]);

/** A callee's name: `f` for `f(…)` and for `x.f(…)`, else undefined. */
function calleeName(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** A src file with a classified catch around the parse route: the non-vacuity witness. */
const AUDIT_COMMAND = 'packages/cli/src/commands/audit.ts';

/** Every AST built so far, by its source text: both arms read the same tree. */
const parsed = new Map<string, ts.SourceFile>();

/** `body` as a TypeScript AST, parents set so a node can print its own text. */
function sourceOf(body: string): ts.SourceFile {
  let source = parsed.get(body);
  if (source === undefined) {
    source = ts.createSourceFile('module.ts', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    parsed.set(body, source);
  }
  return source;
}

/**
 * Whether `body` can hold an identifier named any of `names`. An identifier's
 * text is in its source verbatim unless it is spelled with a unicode escape, so
 * a source with neither a name nor a `\u` cannot, and need not be parsed.
 */
function mayName(body: string, names: Iterable<string>): boolean {
  if (body.includes(String.raw`\u`)) return true;
  for (const name of names) if (body.includes(name)) return true;
  return false;
}

/** Whether any node under `root` satisfies `test`. */
function some(root: ts.Node, test: (node: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (test(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Whether `node` is a call whose callee is in `names`. */
function isCallTo(node: ts.Node, names: ReadonlySet<string>): boolean {
  return ts.isCallExpression(node) && names.has(calleeName(node.expression) ?? '');
}

/** Whether `node` is a call to the parse route ({@link PARSE_ENTRIES}). */
function isParseEntryCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const name = calleeName(node.expression);
  if (name === undefined || !PARSE_ENTRIES.has(name)) return false;
  if (name !== 'parse') return true;
  return ts.isPropertyAccessExpression(node.expression) && PARSE_RECEIVER.test(node.expression.expression.getText());
}

/**
 * Whether `body` calls {@link PREDICATE}, bare or as a member.
 *
 * @param body - A TypeScript source
 * @returns True for any call whose callee is named the predicate
 */
function callsPredicate(body: string): boolean {
  if (!mayName(body, [PREDICATE])) return false;
  return some(sourceOf(body), (node) => ts.isCallExpression(node) && calleeName(node.expression) === PREDICATE);
}

/**
 * The 1-based lines of every `try` in `body` that calls the parse route
 * directly and whose `catch` neither classifies nor throws.
 *
 * @param body - A TypeScript source
 * @returns The swallowing catches' `try` lines
 */
function swallowingCatches(body: string): number[] {
  if (!mayName(body, ['catch']) || !mayName(body, PARSE_ENTRIES)) return [];
  const source = sourceOf(body);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node) && node.catchClause !== undefined && some(node.tryBlock, isParseEntryCall)) {
      const block = node.catchClause.block;
      const decides = some(block, (inner) => isCallTo(inner, CLASSIFIERS)) || some(block, ts.isThrowStatement);
      if (!decides) lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

describe('the parse-failure classifier', () => {
  it('sees a guard in a catch, and not a mention in a comment', () => {
    expect(callsPredicate('try { f(); } catch (e) { if (isParserUnavailable(e)) throw e; }')).toBe(true);
    expect(callsPredicate('try { f(); } catch (e) { if (r.isParserUnavailable(e)) throw e; }')).toBe(true);
    expect(callsPredicate('// `isParserUnavailable(error)` once guarded here\nclassifyParseFailure(e);')).toBe(false);
    // The same call spelled with a unicode escape: the text prefilter cannot see the name.
    expect(callsPredicate(String.raw`i\u0073ParserUnavailable(e)`)).toBe(true);
  });

  it('is the only guard a src catch uses: no file but the definition calls isParserUnavailable', () => {
    const offenders = [...packageSources()]
      .filter(([file, body]) => file !== DEFINITION && callsPredicate(body))
      .map(([file]) => file);

    expect(offenders).toEqual([]);
  });

  it('still finds the predicate at its definition — the scan is not reading an empty tree', () => {
    expect(packageSources().get(DEFINITION)).toContain(`export function ${PREDICATE}(`);
  });
});

describe('a catch around the parse route', () => {
  it('is a swallow when it neither classifies nor throws, and only then', () => {
    expect(swallowingCatches('try { await analyzeCompatibility(d, r, x); } catch (e) { log(e); }')).toEqual([1]);
    expect(swallowingCatches('try { await dispatcher.parse(k); } catch { return null; }')).toEqual([1]);
    expect(swallowingCatches('try { await analyzeCompatibility(d, r, x); } catch (e) { classifyCompatibilityFailure(e); log(e); }')).toEqual([]);
    expect(swallowingCatches('try { await parseFileCached(p); } catch (e) { if (!isPerRunParseRefusal(e)) throw e; }')).toEqual([]);
    expect(swallowingCatches('try { JSON.parse(s); } catch { return null; }')).toEqual([]);
  });

  it('never swallows in src: every one classifies or rethrows', () => {
    const offenders = [...packageSources()].flatMap(([file, body]) => swallowingCatches(body).map((line) => `${file}:${String(line)}`));

    expect(offenders).toEqual([]);
  });

  it('judges real catches — the scan is not vacuous', () => {
    const judged = [...packageSources()].filter(([, body]) => body.includes('classifyCompatibilityFailure(')).map(([file]) => file);

    expect(judged).toContain(AUDIT_COMMAND);
  });

  it('parses a real catch around the parse route — the prefilter does not skip it', () => {
    const body = packageSources().get(AUDIT_COMMAND) ?? '';
    expect(body).toContain('classifyCompatibilityFailure(');

    parsed.delete(body);
    swallowingCatches(body);

    expect(parsed.has(body)).toBe(true);
  });
});
