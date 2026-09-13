/**
 * `--fix` must not leave behind a reference to something it just un-imported,
 * and must not leave behind the binding it just orphaned.
 *
 * These are the properties an adopter measured on a real sweep, and they are
 * not properties any RuleTester fixture asserts. RuleTester applies exactly ONE
 * pass and compares a string; this runs `--fix` to its fixpoint and then asks
 * the compiler's question — is every identifier in the result actually bound,
 * and is every import still referenced?
 *
 * Their numbers, over ~4,900 sites: **146 files left with a dangling
 * reference** (140 on `join`, 16 on `resolve`), worst single file 75 unrewritten
 * call sites. The mechanism was ESLint's fix merging — a `fix()` that edits both
 * the import and its own call site yields ONE range spanning `min..max`, so with
 * N call sites you get N nested ranges and ESLint keeps one. The rule then went
 * quiet, because the specifier its detection keyed on was the thing that had
 * just been removed. A stable fixpoint over source that does not compile, and a
 * clean exit code. You find out at `tsc`, after the sweep.
 *
 * Every rule here rewrites a call AND edits imports, which is the whole
 * population that can express the bug — including the ones that never showed it
 * in the adopter's tree, where no file happened to call them twice.
 */

import * as tsParser from '@typescript-eslint/parser';
import type { Rule } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
  namedImport,
  NODE_CHILD_PROCESS,
  NODE_FS,
  NODE_PATH,
  PATH_NAMESPACE_IMPORT,
  QUOTED_NODE_PATH,
  RULE,
  SAFE_FS_MODULE,
  SAFE_IMPORT,
  SAFE_PATH_MODULE,
  WRAPPED_PATH_FUNCTIONS,
} from './fixtures.js';
import { fix, lint, localRulesConfig, ruleConfig, unboundIn, unusedIn } from './linter-harness.js';
import { loadLocalRule, loadLocalRuleModule } from './rule-tester.js';

const PLUGIN_ENTRY = '../index.cjs';
const REWRITE_SITES = 4;

/** `[rule, importLine, callExpression]` — a source is synthesized per row. */
const MULTI_SITE_REWRITES: Array<[string, string, string]> = [
  ...WRAPPED_PATH_FUNCTIONS.map((fn): [string, string, string] => [RULE.rawPath, namedImport(fn, NODE_PATH), `${fn}(a, b)`]),
  [RULE.tmpdir, namedImport('tmpdir', 'node:os'), 'tmpdir()'],
  [RULE.mkdir, namedImport('mkdirSync', NODE_FS), 'mkdirSync(a)'],
  [RULE.realpath, namedImport('realpathSync', NODE_FS), 'realpathSync(a)'],
  [RULE.execSync, namedImport('execSync', NODE_CHILD_PROCESS), 'execSync(a)'],
  [RULE.cp, namedImport('cp', 'node:fs/promises'), 'cp(a, b)'],
  // No import to remove — the import INSERT alone spans the file.
  [RULE.normalize, '', String.raw`a.split('\\').join('/')`],
];

function multiSiteSource(importLine: string, call: string): string {
  const calls = Array.from({ length: REWRITE_SITES }, (_, i) => `const r${i} = ${call};`);
  return [importLine, "const a = 'a';", "const b = 'b';", ...calls].filter(Boolean).join('\n');
}

const byName = (a: string, b: string): number => a.localeCompare(b);

describe('autofix leaves no dangling reference', () => {
  const plugin = loadLocalRuleModule<{ rules: Record<string, Rule.RuleModule> }>(PLUGIN_ENTRY);

  it('covers every fixable rule in the pack', () => {
    // Membership, not cardinality — a rule added to the pack without a row here
    // is a rule whose fixer nobody runs to a fixpoint.
    //
    // `!= null`, NOT `=== 'code'`. ESLint accepts `fixable: 'whitespace'` for a
    // rule that rewrites callees and inserts imports — verified by running one —
    // so keying on `'code'` leaves a rule that is fully fixable, absent from
    // this list, and absent from MULTI_SITE_REWRITES. `toStrictEqual` passes on
    // two matching omissions, which is the shape of a gate that measures
    // nothing. (Omitting `fixable` entirely is NOT a hole: ESLint throws.)
    const fixable = Object.entries(plugin.rules)
      .filter(([, rule]) => rule.meta?.fixable != null)
      .map(([name]) => name);
    expect([...new Set(MULTI_SITE_REWRITES.map(([name]) => name))].sort(byName)).toStrictEqual(
      [...fixable].sort(byName),
    );
  });

  it.each(MULTI_SITE_REWRITES)('%s (%s)', (name, importLine, call) => {
    const source = multiSiteSource(importLine, call);
    const config = ruleConfig(name);

    // Negative control: a source that stopped provoking the rule would make
    // every assertion below vacuously true.
    expect(lint(source, config)).toHaveLength(REWRITE_SITES);
    expect(unboundIn(source)).toStrictEqual([]);

    const { output, fixed } = fix(source, config);
    expect(fixed).toBe(true);

    // The defect, stated exactly: `--fix` settles, reports nothing further, and
    // the code it settled on references an identifier that is no longer bound.
    expect(unboundIn(output)).toStrictEqual([]);
    expect(lint(output, config)).toStrictEqual([]);
  });
});

/**
 * A SUPPRESSED report still consumes a once-per-file import edit, across every
 * import-inserting rule that is not `no-raw-node-path` (which has its own leg
 * in its suite).
 *
 * These rules do not key detection on the import, so they recover across passes
 * on their own — but only because no `fix()` latches a once-per-file flag. This
 * suite is what stops one being re-introduced: a latch here has no repair leg
 * behind it, and the file would simply stay broken.
 */
const SUPPRESSION_CASES: Array<[string, string, string]> = [
  [RULE.tmpdir, namedImport('tmpdir', 'node:os'), 'tmpdir()'],
  [RULE.mkdir, namedImport('mkdirSync', NODE_FS), "mkdirSync('/d')"],
  [RULE.realpath, namedImport('realpathSync', NODE_FS), "realpathSync('/p')"],
  [RULE.execSync, namedImport('execSync', NODE_CHILD_PROCESS), "execSync('ls')"],
  [RULE.cp, namedImport('cp', 'node:fs/promises'), "cp('a', 'b')"],
  [RULE.normalize, '', String.raw`'x'.split('\\').join('/')`],
];

describe('a suppressed first report strands no other rule either', () => {
  it.each(SUPPRESSION_CASES)('%s', (name, importLine, call) => {
    const source = [
      importLine,
      `// eslint-disable-next-line local/${name}`,
      `export const a = ${call};`,
      `export const b = ${call};`,
      `export const c = ${call};`,
    ]
      .filter(Boolean)
      .join('\n');
    const cfg = ruleConfig(name);
    const defined = { [name]: loadLocalRule(`${name}.cjs`) };

    // Negative control: one of three reports really is suppressed.
    expect(lint(source, cfg)).toHaveLength(2);
    expect(unboundIn(source, defined)).toStrictEqual([]);

    const { output } = fix(source, cfg);
    expect(unboundIn(output, defined)).toStrictEqual([]);
    // The suppressed call is untouched, so whatever it needs must survive.
    expect(output).toContain(`export const a = ${call};`);
  });
});

/**
 * The binding the fixer itself orphaned.
 *
 * The adopter's gate, restated as an assertion. Their repo lints at
 * `--max-warnings=0`. After `--fix` converged over ~5,100 sites, **536 errors
 * survived across 232 files** — every one of them the same class, the now-unused
 * `node:path` binding, split 289 `no-unused-vars` / 247 `sonarjs/unused-import`.
 * So the fixed output did not lint clean, and the migration was not complete.
 * Core `no-unused-vars` is the same question in one rule, and it is the only
 * assertion here that would have caught it: the `no-undef` fixpoint check above
 * is blind, because a dead import leaves nothing DANGLING — it leaves something
 * SPARE.
 *
 * Neither ecosystem rule can fix this for us: `@typescript-eslint/no-unused-vars`
 * declares `meta.fixable: 'code'` and yet emits only a SUGGESTION for an unused
 * import, and `--fix` never applies suggestions. Verified with both rules
 * enabled in a single `verifyAndFix`; the import survived.
 */
describe('--fix removes the import binding it just orphaned', () => {
  const DEFAULT_IMPORT = 'default import';
  const NAMESPACE_IMPORT = 'namespace import';

  /** `[rule, label, source]` — every source is fully migrated by one pass. */
  const DEAD_AFTER_FIX: Array<[string, string, string]> = [
    [RULE.rawPath, DEFAULT_IMPORT, `${PATH_NAMESPACE_IMPORT}\nexport const p = path.join('a', 'b');`],
    [RULE.rawPath, NAMESPACE_IMPORT, "import * as path from 'node:path';\nexport const p = path.join('a', 'b');"],
    [RULE.rawPath, 'resolve', `${PATH_NAMESPACE_IMPORT}\nexport const p = path.resolve('a', 'b');`],
    [RULE.rawPath, 'relative', `${PATH_NAMESPACE_IMPORT}\nexport const p = path.relative('a', 'b');`],
    [RULE.tmpdir, DEFAULT_IMPORT, "import os from 'node:os';\nexport const t = os.tmpdir();"],
    [RULE.tmpdir, NAMESPACE_IMPORT, "import * as os from 'node:os';\nexport const t = os.tmpdir();"],
    // `path.sep` is a member reference like any other, and `toForwardSlash`
    // consumes the last one. This rule never tracked the path import at all.
    [
      RULE.normalize,
      'path.sep consumed by toForwardSlash',
      `${PATH_NAMESPACE_IMPORT}\nconst raw = 'a\\\\b';\nexport const n = raw.split(path.sep).join('/');`,
    ],
  ];

  it.each(DEAD_AFTER_FIX)('%s (%s)', (name, _label, source) => {
    const cfg = ruleConfig(name);
    // Negative controls: the source must provoke the rule, and must not
    // already be carrying the very finding this test looks for afterwards.
    expect(lint(source, cfg).length).toBeGreaterThan(0);
    expect(unusedIn(source)).toStrictEqual([]);

    const { output } = fix(source, cfg);

    expect(unusedIn(output)).toStrictEqual([]);
    expect(output).not.toMatch(/from 'node:(path|os)'/);
    // …and the fixpoint still holds: nothing left to report.
    expect(lint(output, cfg)).toStrictEqual([]);
  });

  /**
   * `[label, source]` — every source ends the pass with a `node:path` import
   * that must SURVIVE `no-raw-node-path`. Each row disables a different guard.
   */
  const IMPORT_MUST_SURVIVE: Array<[string, string]> = [
    // Only the all-members-migrated case is dead. This is the case the
    // adopter confirmed already worked, kept here so a wider "just delete it"
    // cannot pass.
    [
      'another member still uses the binding',
      `${PATH_NAMESPACE_IMPORT}\nexport const p = path.join('a', 'b');\nexport const d = path.dirname(p);`,
    ],
    // A bare side-effect import declares no bindings, so "every binding is
    // dead" is vacuously true. Deleting it is an edit nobody asked for, and
    // `node:path`'s freedom from side effects is not the point — the author's
    // intent is unreadable.
    ['bare side-effect import', `import 'node:path';\n${SAFE_IMPORT}\nexport const p = safePath.join('a', 'b');`],
    // EVERY binding must be dead, not merely one of them. A single-specifier
    // fixture cannot tell `every` from `some` — both answer the same for one
    // variable — so the declaration here has to carry two.
    [
      'a second specifier on the same declaration is still live',
      "import path, { sep } from 'node:path';\nexport const p = path.join('a', 'b');\nexport const s = sep;",
    ],
    // The gate that keeps this a REPAIR leg rather than a general
    // unused-import rule: with nothing from the safe module in scope, this
    // fixer never ran here, so the dead import is somebody else's business.
    ['file was never migrated', `${PATH_NAMESPACE_IMPORT}\nexport const x = 1;`],
    // …and "the safe symbol is bound" is NOT on its own evidence that THIS
    // rule migrated anything. `safePath` reaches scope for plenty of reasons
    // that have nothing to do with a `path.join()` this fixer consumed, and a
    // `node:path` import that was ALREADY dead before the pack ever ran is not
    // something this rule orphaned. Reporting it as one is a false causal
    // claim, and removing it is precisely the general unused-import rule the
    // module docstring declines to be.
    [
      'the safe symbol is bound but nothing in the file calls it',
      `${SAFE_IMPORT}\n${PATH_NAMESPACE_IMPORT}\nexport const x = safePath;`,
    ],
    // A `safePath` member the table does NOT wrap. `joinUnderRoot` is a real
    // member, so this is the shape of "the file was migrated by something
    // else"; with `functions: ['join']` the same holds for `safePath.resolve`.
    [
      'only an unwrapped safePath member is in use',
      `${SAFE_IMPORT}\n${PATH_NAMESPACE_IMPORT}\nexport const p = safePath.joinUnderRoot('a', 'b');`,
    ],
  ];

  it.each(IMPORT_MUST_SURVIVE)('keeps the import when %s', (_label, source) => {
    const cfg = ruleConfig(RULE.rawPath);
    const output = fix(source, cfg).output;
    expect(output).toContain(QUOTED_NODE_PATH);
    expect(lint(output, cfg)).toStrictEqual([]);
  });

  it('keeps the import when only a function OUTSIDE the configured table was migrated', () => {
    // `no-raw-node-path` narrowed to `join` rewrote nothing here — the
    // `safePath.resolve` came from somewhere else — so whatever happened to
    // this import is not its finding to make.
    const source = `${SAFE_IMPORT}\n${PATH_NAMESPACE_IMPORT}\nexport const p = safePath.resolve('a', 'b');`;
    const cfg = ruleConfig(RULE.rawPath, { functions: ['join'] });
    expect(lint(source, cfg)).toStrictEqual([]);
    expect(fix(source, cfg).output).toContain(QUOTED_NODE_PATH);
  });

  /**
   * The same gate, through the other two callers of the shared helper.
   *
   * `dead-import.cjs` is reached from three rule implementations, and a gate
   * living in the helper is only as good as the evidence each caller computes
   * for it. The three spell "did I rewrite anything here?" three different
   * ways — `safePath.join(…)` is a member call, `normalizedTmpdir()` a free one,
   * and `toForwardSlash(…)` belongs to a rule that never tracked the path import
   * at all — so a table covering only the path rule would leave two of the
   * three untested against exactly the coincidence this closes.
   */
  it.each([
    [
      RULE.tmpdir,
      'node:os',
      `import { normalizedTmpdir } from '${SAFE_FS_MODULE}';\nimport os from 'node:os';\nexport const x = normalizedTmpdir;`,
    ],
    [
      RULE.normalize,
      'node:path',
      `import { toForwardSlash } from '${SAFE_PATH_MODULE}';\n${PATH_NAMESPACE_IMPORT}\nexport const x = toForwardSlash;`,
    ],
  ])('%s keeps a dead %s import when its own replacement is never called', (name, module, source) => {
    const cfg = ruleConfig(name);
    expect(lint(source, cfg)).toStrictEqual([]);
    expect(fix(source, cfg).output).toContain(`'${module}'`);
  });

  /**
   * Type-only specifiers, which have no references by construction.
   *
   * A `type` binding exists only for the type checker, so scope analysis
   * reports zero references for one that IS used — `no-undef` and
   * `no-unused-vars` are equally blind to the damage, because the reference it
   * breaks is a TYPE reference. Round 2 learned this by deleting them.
   */
  it.each([
    ['declaration-level', "import type { PlatformPath } from 'node:path';"],
    ['specifier-level', "import { type PlatformPath } from 'node:path';"],
  ])('%s type-only imports are never removed', (_label, typeImport) => {
    const source = [SAFE_IMPORT, typeImport, "export const p = safePath.join('a', 'b');"].join('\n');
    // The linter harness parses with espree; a type-only import needs the TS parser.
    const config = ruleConfig(RULE.rawPath).map((block) => ({
      ...block,
      languageOptions: { parser: tsParser },
    }));
    expect(fix(source, config).output).toContain(typeImport);
  });

  /**
   * The gate stays readable from the SOURCE, never from a flag `fix()` can flip.
   *
   * ESLint runs a rule's `fix()` for a suppressed problem BEFORE the
   * `eslint-disable` filter discards it. So any mutable "have I added the safe
   * import?" flag is already `true` — and lying — by the time `Program:exit`
   * runs, and a dead-import leg reading it would delete an import in a file
   * nothing was actually migrated in. Both implementations therefore snapshot
   * the answer at `create()` time; these are the fixtures that tell the two apart.
   *
   * Two imports of the same module, deliberately. The suppressed call keeps its
   * OWN binding referenced, so a single-import file cannot express the state
   * this guards — a live report whose `fix()` flips the flag, and a dead binding
   * sitting beside it in the same pass. The second (unused) import supplies it.
   */
  it.each([
    [
      RULE.rawPath,
      [
        "import legacy from 'path';",
        PATH_NAMESPACE_IMPORT,
        `// eslint-disable-next-line local/${RULE.rawPath}`,
        "export const a = path.join('1', '2');",
      ].join('\n'),
    ],
    [
      RULE.tmpdir,
      [
        "import legacy from 'os';",
        "import os from 'node:os';",
        `// eslint-disable-next-line local/${RULE.tmpdir}`,
        'export const a = os.tmpdir();',
      ].join('\n'),
    ],
  ])('%s: a suppressed report cannot arm the dead-import leg', (name, source) => {
    const cfg = ruleConfig(name);
    // The rule's only report is suppressed, so nothing at all is left — in
    // particular not a `deadUnsafeImport` that the discarded report enabled.
    expect(lint(source, cfg)).toStrictEqual([]);
    expect(fix(source, cfg).output).toBe(source);
  });

  /**
   * The configuration an adopter actually runs: the whole table at once.
   *
   * Three functions migrating three members of ONE import all reach the same
   * dead declaration on the same pass. With one rule that is one removal; the
   * question is whether the fixpoint converges on ONE inserted import, and no
   * single-function fixture asks it. `[label, functions used, sites]`.
   */
  it.each([
    ['one wrapped function leaves nothing behind', ['resolve'] as const],
    ['all three wrapped functions converge on one import', WRAPPED_PATH_FUNCTIONS],
  ])('%s', (_label, fns) => {
    const source = [PATH_NAMESPACE_IMPORT, ...fns.map((fn) => `export const ${fn}d = path.${fn}('a', 'b');`)].join('\n');
    const cfg = ruleConfig(RULE.rawPath);

    // Negative control: exactly one report per wrapped call.
    expect(lint(source, cfg)).toHaveLength(fns.length);

    const { output } = fix(source, cfg);

    expect(lint(output, cfg)).toStrictEqual([]);
    expect(unusedIn(output)).toStrictEqual([]);
    expect(output).not.toContain(QUOTED_NODE_PATH);
    expect(output.match(/import \{ safePath \}/g)).toHaveLength(1);
    for (const fn of fns) {
      expect(output).toContain(`safePath.${fn}(`);
    }
  });

  it('the whole pack on one file converges with no rule stranding another', () => {
    // Every import-editing rule enabled together, over a file using each.
    const names = [RULE.rawPath, RULE.tmpdir, RULE.normalize];
    const cfg = localRulesConfig(Object.fromEntries(names.map((name) => [name, loadLocalRule(`${name}.cjs`)])));
    const source = [
      PATH_NAMESPACE_IMPORT,
      "import os from 'node:os';",
      "export const a = path.join(os.tmpdir(), 'b');",
      "export const n = a.split(path.sep).join('/');",
    ].join('\n');

    expect(lint(source, cfg).length).toBeGreaterThan(0);
    const { output } = fix(source, cfg);
    expect(lint(output, cfg)).toStrictEqual([]);
    expect(unusedIn(output)).toStrictEqual([]);
    expect(unboundIn(output)).toStrictEqual([]);
  });
});
