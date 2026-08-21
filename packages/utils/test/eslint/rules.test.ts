/**
 * Tests for the rules in packages/utils/eslint/rules/.
 *
 * Each rule contributes one row to SUITES below. Adding a new rule means
 * a new RuleCases constant plus a one-line row — keeps RuleTester
 * scaffolding in exactly one place.
 */

import * as tsParser from '@typescript-eslint/parser';
import { Linter, type Rule } from 'eslint';
import { describe, expect, it } from 'vitest';

import {
  loadLocalRule,
  loadLocalRuleModule,
  type RuleCases,
  ruleTester,
} from './rule-test-harness.js';

const NO_URL_PATHNAME_FOR_FS_CASES: RuleCases = {
  valid: [
    { code: "import { fileURLToPath } from 'node:url'; const p = fileURLToPath(new URL('../x', import.meta.url));" },
    { code: "const p = new URL('http://example.com').pathname;" },
    { code: 'const p = someUrl.pathname;' },
    { code: "const u = new URL('../x', import.meta.url); const s = u.href;" },
  ],
  invalid: [
    { code: 'const p = new URL(rel, import.meta.url).pathname;', errors: [{ messageId: 'useFileURLToPath' }] },
    { code: "const p = new URL('../fixtures/x.yaml', import.meta.url).pathname;", errors: [{ messageId: 'useFileURLToPath' }] },
    { code: 'const p = new URL(`../fixtures/${name}.yaml`, import.meta.url).pathname;', errors: [{ messageId: 'useFileURLToPath' }] },
  ],
};

const NO_BARE_DYNAMIC_IMPORT_PATH_CASES: RuleCases = {
  valid: [
    { code: "await import('./relative.js');" },
    { code: "await import('../sibling.js');" },
    { code: "await import('some-pkg');" },
    { code: "await import('@scope/pkg');" },
    { code: "import { pathToFileURL } from 'node:url'; const p = '/abs'; await import(pathToFileURL(p).href);" },
    { code: 'const spec = "./x.js"; await import(spec);' },
  ],
  invalid: [
    { code: "await import('/Users/foo/x.js');", errors: [{ messageId: 'useFileUrl' }] },
    { code: String.raw`await import('C:\\x.js');`, errors: [{ messageId: 'useFileUrl' }] },
    { code: "import path from 'node:path'; await import(path.join(dir, 'x.js'));", errors: [{ messageId: 'useFileUrl' }] },
    { code: "import path from 'node:path'; await import(path.resolve('x'));", errors: [{ messageId: 'useFileUrl' }] },
    { code: "import { join } from 'node:path'; await import(join(dir, 'x.js'));", errors: [{ messageId: 'useFileUrl' }] },
    { code: 'const absPath = "/x"; await import(absPath);', errors: [{ messageId: 'useFileUrl' }] },
    { code: 'const configFile = "/x"; await import(configFile);', errors: [{ messageId: 'useFileUrl' }] },
    { code: "import { join } from 'node:path'; await import(`${join(dir, 'x.js')}`);", errors: [{ messageId: 'useFileUrl' }] },
  ],
};

const NO_FILE_URL_STRING_CONCAT_CASES: RuleCases = {
  valid: [
    { code: "import { pathToFileURL } from 'node:url'; const u = pathToFileURL(process.argv[1]).href;" },
    { code: "if (path.startsWith('file://')) {}" },
    { code: "const u = 'file://example.com';" },
    { code: "const u = `file://example.com`;" },
    { code: "new URL('file:///abs/path');" },
    { code: "const s = 'hello' + name;" },
  ],
  invalid: [
    { code: 'const u = `file://${process.argv[1]}`;', errors: [{ messageId: 'useFileUrlBuilder' }] },
    { code: "if (import.meta.url === `file://${process.argv[1]}`) {}", errors: [{ messageId: 'useFileUrlBuilder' }] },
    { code: "const u = 'file://' + somePath;", errors: [{ messageId: 'useFileUrlBuilder' }] },
    { code: "const u = somePath + 'file://abc';", errors: [{ messageId: 'useFileUrlBuilder' }] },
    { code: 'const u = `file:///${drive}/${rest}`;', errors: [{ messageId: 'useFileUrlBuilder' }] },
  ],
};

const PREFER_STARTSWITH_OVER_REGEX_CASES: RuleCases = {
  valid: [
    // unicorn would catch these, but our rule treats them as redundant — both are fine.
    { code: "const s = 'x'; if (s.startsWith('file://')) {}" },
    // Patterns with regex metacharacters — must NOT flag (cannot safely flatten).
    { code: String.raw`const s = 'x'; if (/^https?:\/\//.test(s)) {}` },
    { code: "const s = 'x'; if (/^[a-z]+/.test(s)) {}" },
    // Unescaped `.` is "any character" — flattening it would change what matches.
    { code: "const s = 'x'; if (/.txt$/.test(s)) {}" },
    { code: "const s = 'x'; if (/^foo|bar/.test(s)) {}" },
    // Flags i/m make literal conversion unsafe — must not flag.
    { code: "const s = 'x'; if (/^foo/i.test(s)) {}" },
    // Escapes that MEAN something other than the next character — a class, an
    // assertion, a code point — stay unflattenable.
    { code: String.raw`const s = 'x'; if (/^\d+/.test(s)) {}` },
    { code: String.raw`const s = 'x'; if (/^\w/.test(s)) {}` },
    { code: String.raw`const s = 'x'; if (/^\bword/.test(s)) {}` },
    { code: String.raw`const s = 'x'; if (/^\cA/.test(s)) {}` },
    { code: String.raw`const s = 'x'; if (/^\x41/.test(s)) {}` },
    { code: String.raw`const s = 'x'; if (/^\p{Lu}/u.test(s)) {}` },
    // A control character would go straight into the suggested startsWith('…').
    { code: String.raw`const s = 'x'; if (/^\tab/.test(s)) {}` },
    // No anchor — not a prefix/suffix check.
    { code: "const s = 'x'; if (/foo/.test(s)) {}" },
    // An escaped `$` at the end is a LITERAL dollar sign, not an anchor —
    // there is no end-of-string check to flatten, so this must not flag.
    { code: String.raw`const s = 'x'; if (/price\$/.test(s)) {}` },
    // Method calls that aren't .test() — must not flag.
    { code: "const s = 'x'; const m = /^foo/.exec(s);" },
    // A const that does not hold a regex literal, and one reassigned after
    // declaration: nothing here proves what `.test()` runs against.
    { code: "const RE = makeRegex(); const s = 'x'; if (RE.test(s)) {}" },
    { code: "let RE = /^a/; RE = /^[b]/; const s = 'x'; if (RE.test(s)) {}" },
    { code: "const s = 'x'; if (someObject.pattern.test(s)) {}" },
    // Resolution must respect the same metachar/flag limits as the inline form.
    { code: String.raw`const RE = /^https?:\/\//; const s = 'x'; if (RE.test(s)) {}` },
    { code: "const RE = /^foo/i; const s = 'x'; if (RE.test(s)) {}" },
  ],
  invalid: [
    { code: String.raw`const s = 'x'; if (/^file:\/\//.test(s)) {}`, errors: [{ messageId: 'preferStartsWith' }] },
    { code: String.raw`const s = 'x'; if (/^ssh:\/\//.test(s)) {}`, errors: [{ messageId: 'preferStartsWith' }] },
    { code: "const s = 'x'; if (/^foo/.test(s)) {}", errors: [{ messageId: 'preferStartsWith' }] },
    { code: "const s = 'x'; if (/bar$/.test(s)) {}", errors: [{ messageId: 'preferEndsWith' }] },
    // BACKSLASH-PARITY at the trailing anchor. `/\\$/`'s pattern is the
    // 3-char string `\\$` — an escaped backslash (`\\`) followed by an
    // UNESCAPED `$` anchor. Looking only at the literal last two characters
    // (`\$`) misreads this as an escaped dollar and skips it; the fix counts
    // the run of backslashes immediately before `$` and checks its parity.
    { code: String.raw`const s = 'x'; if (/\\$/.test(s)) {}`, errors: [{ messageId: 'preferEndsWith' }] },
    { code: "const s = 'x'; if (/^abc-def/.test(s)) {}", errors: [{ messageId: 'preferStartsWith' }] },
    // ESCAPED NON-SPECIAL CHARACTER. `\*` is an unambiguous literal asterisk,
    // and accepting only `\/` skipped it — an adopter's SonarCloud raised the
    // MAJOR S6557 this rule exists to shift left, on code the rule reported
    // green. Every escape below denotes exactly the character it protects.
    { code: String.raw`const s = 'x'; if (/^\*glob/.test(s)) {}`, errors: [{ messageId: 'preferStartsWith' }] },
    { code: String.raw`const s = 'x'; if (/^\.hidden/.test(s)) {}`, errors: [{ messageId: 'preferStartsWith' }] },
    // Was pinned as VALID with the note "contains `.` metachar". It does not —
    // the `.` is escaped, and `/\.txt$/.test(s)` is `s.endsWith('.txt')` exactly.
    { code: String.raw`const s = 'x'; if (/\.txt$/.test(s)) {}`, errors: [{ messageId: 'preferEndsWith' }] },
    { code: String.raw`const s = 'x'; if (/^\$ref/.test(s)) {}`, errors: [{ messageId: 'preferStartsWith' }] },
    { code: String.raw`const s = 'x'; if (/^\(paren/.test(s)) {}`, errors: [{ messageId: 'preferStartsWith' }] },
    { code: String.raw`const s = 'x'; if (/\+plus$/.test(s)) {}`, errors: [{ messageId: 'preferEndsWith' }] },
    // REGEX HELD IN A CONST — the normal way to hoist a hot regex, and the
    // shape the rule was blind to because it examined only inline literals.
    { code: "const RE = /^literal/; const s = 'x'; if (RE.test(s)) {}", errors: [{ messageId: 'preferStartsWith' }] },
    { code: "const RE = /suffix$/; const s = 'x'; if (RE.test(s)) {}", errors: [{ messageId: 'preferEndsWith' }] },
    {
      code: String.raw`const RE = /^file:\/\//; function f(s) { return RE.test(s); }`,
      errors: [{ messageId: 'preferStartsWith' }],
    },
  ],
};

interface RuleSuite {
  name: string;
  cases: RuleCases;
}

/**
 * `no-path-join` / `no-path-resolve` / `no-path-relative` share one factory, so
 * they share one case table. The load-bearing legs are the last three invalid
 * cases: a DECOY file whose basename matches an exempt implementation file but
 * whose directory does not. The factory used to exempt via
 * `filename.includes('path-utils.ts')`, so every decoy linted clean — the exact
 * bug that let a private `tools/hooks/path-utils.ts` ship raw path calls in a
 * consumer repo running a fork of these rules.
 *
 * Exemptions are a RULE OPTION, not a built-in list: the file implementing the
 * safe wrapper is repo-specific, so a shipped default would hand every other
 * repo a hole at that path. The last two invalid legs are the regression guard
 * for that — with no options, nothing is exempt.
 */
/**
 * The autofix targets the NARROW subpath that owns `safePath`, not the barrel.
 *
 * The rules used to write `@vibe-agent-toolkit/utils` here while the README
 * table shipped in the same tarball told adopters the replacement lived on
 * `/path` — so the release whose entire purpose was narrow subpaths shipped lint
 * rules that mechanically rewrote code away from them. An adopter running the
 * pack over 4,670 files reported 4,719 such sites.
 */
const SAFE_PATH_MODULE = '@vibe-agent-toolkit/utils/path';
const SAFE_FS_MODULE = '@vibe-agent-toolkit/utils/fs';
const BARREL = '@vibe-agent-toolkit/utils';
const SAFE_IMPORT = `import { safePath } from '${SAFE_PATH_MODULE}';`;
const PATH_NAMESPACE_IMPORT = "import path from 'node:path';";
const LINTED_FILE = 'packages/cli/src/example.ts';

/** The seam this rule points at, and the file that implements it. */
const TEXT_SEAM = '@vibe-agent-toolkit/resources';
const TEXT_SEAM_IMPL = 'packages/resources/src/text-content.ts';
const TEXT_DECODE_OPTIONS = [{ safeModule: TEXT_SEAM, exemptFiles: [TEXT_SEAM_IMPL] }];

/** The archetypal offending decode, reused as both the invalid and the exempt case. */
const BUFFER_UTF8_DECODE = "const t = buf.toString('utf-8');";

/**
 * `no-raw-text-decode`.
 *
 * The valid half is where this rule earns its keep or loses it: a decoder guard
 * that also fires on `n.toString(16)` and `buf.toString('base64')` would be
 * disabled by the first person it inconvenienced. Every one of those is pinned.
 */
const NO_RAW_TEXT_DECODE_CASES: RuleCases = {
  valid: [
    // The seam itself.
    { code: "const d = new TextDecoder('utf-8');", filename: TEXT_SEAM_IMPL, options: TEXT_DECODE_OPTIONS },
    { code: BUFFER_UTF8_DECODE, filename: TEXT_SEAM_IMPL, options: TEXT_DECODE_OPTIONS },
    // Binary-to-text codecs are not character encodings.
    { code: "const b = buf.toString('base64');", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: "const b = buf.toString('base64url');", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: "const h = buf.toString('hex');", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: "const h = buf.toString('HEX');", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: "const raw = await readFile(p, 'hex');", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: "const raw = readFileSync(p, { encoding: 'base64' });", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    // Not encodings at all.
    { code: 'const s = n.toString(16);', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: 'const s = value.toString();', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: 'const s = big.toString(radix);', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    // Reads that ask for bytes.
    { code: 'const bytes = await readFile(p);', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: 'const bytes = readFileSync(p, { encoding: null });', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: 'const bytes = await fsModule.readFile(p);', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    // A callback-style read: the same SHAPE as an encoding argument, and the
    // reason a non-literal second argument is deliberately not reported.
    { code: 'readFile(p, done);', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    // The seam's own API.
    { code: 'const { text } = decodeTextContent(bytes);', filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    // A writer, not a reader. `update(s, 'utf-8')` ENCODES a string to bytes.
    { code: "createHash('sha256').update(content, 'utf-8');", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
    { code: "await writeFile(p, text, 'utf-8');", filename: LINTED_FILE, options: TEXT_DECODE_OPTIONS },
  ],
  invalid: [
    {
      code: BUFFER_UTF8_DECODE,
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'bufferTextDecode' }],
    },
    {
      code: "const t = Buffer.concat(chunks).toString('utf8');",
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'bufferTextDecode' }],
    },
    // An encoding nobody put on a list: the exclusion test fails CLOSED.
    {
      code: "const t = buf.toString('windows-1252');",
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'bufferTextDecode' }],
    },
    {
      code: 'const t = buf.toString(`latin1`);',
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'bufferTextDecode' }],
    },
    {
      code: 'const d = new TextDecoder();',
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'textDecoderConstruct' }],
    },
    {
      code: "const t = new TextDecoder('utf-16be').decode(bytes);",
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'textDecoderConstruct' }],
    },
    {
      code: "const t = await readFile(p, 'utf-8');",
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'fsReadTextEncoding' }],
    },
    {
      code: "const t = readFileSync(p, 'utf8');",
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'fsReadTextEncoding' }],
    },
    {
      code: "const t = await fs.promises.readFile(p, { encoding: 'utf-8' });",
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'fsReadTextEncoding' }],
    },
    // An INJECTED fs module is still an fs read — the rule keys on the method
    // name, not on whether the receiver is literally `fs`.
    {
      code: "const t = await fsModule.readFile(p, 'utf-8');",
      filename: LINTED_FILE,
      options: TEXT_DECODE_OPTIONS,
      errors: [{ messageId: 'fsReadTextEncoding' }],
    },
    // An unanchored exemption is reported even where the code is clean, and the
    // exemption itself does NOT take effect from a bare basename.
    {
      code: BUFFER_UTF8_DECODE,
      filename: 'packages/somewhere/else/text-content.ts',
      options: [{ safeModule: TEXT_SEAM, exemptFiles: ['text-content.ts'] }],
      errors: [{ messageId: 'unanchoredExemptFile' }],
    },
  ],
};

const PATH_CORE_IMPL = 'packages/utils/src/path-core.ts';
const PATH_UTILS_IMPL = 'packages/utils/src/path-utils.ts';
const PATH_UTILS_SPEC = 'packages/utils/test/path-utils.test.ts';

/** The exempt-file list VAT itself passes for the three `safePath` rules. */
const PATH_EXEMPT_OPTIONS = [
  { exemptFiles: [PATH_CORE_IMPL, PATH_UTILS_IMPL, PATH_UTILS_SPEC] },
];

function pathFunctionRuleCases(fn: 'join' | 'relative' | 'resolve'): RuleCases {
  const unsafeMemberCode = `import path from 'node:path'; const p = path.${fn}(a, b);`;
  const unsafeMemberOutput = `import path from 'node:path';\n${SAFE_IMPORT} const p = safePath.${fn}(a, b);`;
  const errors = [{ messageId: 'noUnsafePathFn' }];
  const options = PATH_EXEMPT_OPTIONS;
  const decoy = (filename: string) => ({
    code: unsafeMemberCode, filename, options, output: unsafeMemberOutput, errors,
  });

  return {
    valid: [
      // The safe call is never flagged.
      { code: `${SAFE_IMPORT} const p = safePath.${fn}(a, b);`, filename: LINTED_FILE, options },
      // …including when it was reached through the barrel.
      {
        code: `import { safePath } from '${BARREL}'; const p = safePath.${fn}(a, b);`,
        filename: LINTED_FILE,
        options,
      },
      // A same-named function from somewhere else is not ours. The repair leg
      // keys on the name being UNBOUND, so binding it — by import, declaration,
      // or parameter — is what keeps it from flagging every `join()` in the
      // ecosystem.
      //
      // EVERY case below puts the call in a DIFFERENT scope from the binding,
      // on purpose. The first draft of these fixtures called at the same level
      // as the binding, which meant `isIdentifierBound`'s walk up `scope.upper`
      // never executed — an adversarial run deleted the entire walk and this
      // suite stayed green while the mutant rewrote lodash's `join` into
      // `safePath.join`. A scope-aware rule needs a scope-crossing fixture.
      {
        code: `${SAFE_IMPORT}\nimport { ${fn} } from 'lodash';\nfunction f(a, b) { return ${fn}(a, b); }`,
        filename: LINTED_FILE,
        options,
      },
      {
        code: `${SAFE_IMPORT}\nfunction ${fn}(x) { return x; }\nfunction f(a) { return ${fn}(a); }`,
        filename: LINTED_FILE,
        options,
      },
      {
        code: `${SAFE_IMPORT}\nexport const run = (${fn}) => () => ${fn}(a, b);`,
        filename: LINTED_FILE,
        options,
      },
      // Without `safePath` in scope the repair leg must not fire AT ALL — this
      // is the gate that keeps ambient globals safe. ESLint scope analysis
      // cannot see a `globals.d.ts`, an `@types` package, or a bundler-injected
      // global, and `resolve`/`relative` are entirely plausible as those.
      { code: `const p = ${fn}(a, b);`, filename: LINTED_FILE, options },
      // …and `safePath` merely BEING bound is not the licence either. A sibling
      // rule in this pack supplies that binding for free: `no-path-resolve`
      // rewrites a `path.resolve(...)` and imports `safePath`, which flips
      // `safePathBoundInSource` for the `join` instance too. What the repair leg
      // needs is evidence that THIS function is mid-migration in THIS file — a
      // `safePath.<fn>(...)` call already in the source. `joinUnderRoot` is a real
      // `safePath` member and is deliberately not one of them.
      //
      // 'a sibling rule binding safePath does not arm the repair leg' below runs
      // the same hazard end to end, through two rules and a real `--fix` sweep.
      {
        code: [
          SAFE_IMPORT,
          'export const root = safePath.joinUnderRoot(base, name);',
          `export const p = ${fn}(a, b);`,
        ].join('\n'),
        filename: LINTED_FILE,
        options,
      },
      // A TYPE-ONLY specifier is not a call site. Tracking it made the fixer
      // DELETE it, and because `typeof join` is a TYPE reference, `no-undef` —
      // and so the fixpoint suite below — cannot see the damage.
      //
      // The call has to be here for this fixture to mean anything: with no call
      // there is no report either way, and the case passes under a rule that
      // tracks type specifiers just as happily as one that skips them.
      {
        code: [
          `import { type ${fn} } from 'node:path';`,
          `export type T = typeof ${fn};`,
          `export const p = ${fn}(a, b);`,
        ].join('\n'),
        filename: LINTED_FILE,
        options,
        languageOptions: { parser: tsParser },
      },
      // Files the CONSUMING config declared exempt, by their repo-relative paths.
      { code: unsafeMemberCode, filename: PATH_CORE_IMPL, options },
      { code: unsafeMemberCode, filename: `/Users/dev/vat/${PATH_UTILS_IMPL}`, options },
      { code: unsafeMemberCode, filename: PATH_UTILS_SPEC, options },
      // Same exemption, spelled with Windows separators.
      { code: unsafeMemberCode, filename: String.raw`C:\dev\vat\packages\utils\src\path-core.ts`, options },
    ],
    invalid: [
      // Fires on the unsafe member call and the unsafe named import.
      { code: unsafeMemberCode, filename: LINTED_FILE, options, output: unsafeMemberOutput, errors },
      {
        code: `import { ${fn} } from 'node:path'; const p = ${fn}(a, b);`,
        filename: LINTED_FILE,
        options,
        output: `\n${SAFE_IMPORT} const p = safePath.${fn}(a, b);`,
        errors,
      },
      // THREE call sites, ONE pass. RuleTester applies exactly one round of
      // fixes, so `output` here is the whole property: every call rewritten and
      // the import surgery done, with nothing discarded for overlapping.
      //
      // Every fixture above has a single call site, and a single-call-site
      // fixture CANNOT reproduce the defect this guards — the fix that edits
      // both the import and its call spans the gap between them, so the second
      // and third reports' ranges nested inside the first and ESLint dropped
      // them. The specifier went away, the calls did not, and the next pass had
      // nothing left to key on. See `buildFix` in the factory.
      {
        code: [
          `import { ${fn} } from 'node:path';`,
          `const a1 = ${fn}(a, b);`,
          `const a2 = ${fn}(c, d);`,
          `const a3 = ${fn}(e, f);`,
        ].join('\n'),
        filename: LINTED_FILE,
        options,
        output: [
          '',
          SAFE_IMPORT,
          `const a1 = safePath.${fn}(a, b);`,
          `const a2 = safePath.${fn}(c, d);`,
          `const a3 = safePath.${fn}(e, f);`,
        ].join('\n'),
        errors: [errors[0], errors[0], errors[0]],
      },
      // Same shape through the namespace import, which removes no specifier —
      // the import INSERT alone is enough to span the file and starve the rest.
      {
        code: [
          PATH_NAMESPACE_IMPORT,
          `const a1 = path.${fn}(a, b);`,
          `const a2 = path.${fn}(c, d);`,
        ].join('\n'),
        filename: LINTED_FILE,
        options,
        output: [
          PATH_NAMESPACE_IMPORT,
          SAFE_IMPORT,
          `const a1 = safePath.${fn}(a, b);`,
          `const a2 = safePath.${fn}(c, d);`,
        ].join('\n'),
        errors: [errors[0], errors[0]],
      },
      // BARE, UNBOUND call in a file that ALREADY has `safePath` — what a
      // half-applied fix leaves behind. Detection used to require having seen
      // the `node:path` specifier, so once a fix removed it the rule fell
      // silent and `--fix` declared victory over source that no longer
      // compiles. Recognising this shape is what makes a second `--fix` finish
      // the job.
      //
      // The `safePath`-in-scope precondition is the whole difference between a
      // repair leg and a second, worse detector: see the `declare global` and
      // ambient-global valid cases below for what firing without it costs.
      {
        code: `${SAFE_IMPORT}\nconst p = ${fn}(a, b);\nconst q = safePath.${fn}(c, d);`,
        filename: LINTED_FILE,
        options,
        output: `${SAFE_IMPORT}\nconst p = safePath.${fn}(a, b);\nconst q = safePath.${fn}(c, d);`,
        errors,
      },
      // ALIASED specifier: rewrite the unbound `join(`, and KEEP the alias.
      //
      // `pathJoin(...)` is never the callee this rule matches, so tracking the
      // specifier bought nothing — and cost the whole import. An unrelated
      // unbound `join(` elsewhere in the file classified as "named", and the
      // fixer removed the ALIAS, breaking every working `pathJoin` call site.
      // The pinned output below is the proof the alias survives.
      //
      // The last line carries the repair leg's evidence, and this fixture is why
      // it has to be spelled out rather than assumed: the bare `join(c, d)` here
      // is UNBOUND and `safePath` IS in scope, which is the exact shape an
      // ambient global takes — the comment above has always called it
      // "unrelated". Without a `safePath.${fn}(...)` in the file it now goes
      // unreported, and the alias guard would have gone with it. The mutation the
      // guard exists to catch still fails here: track the aliased specifier and
      // `join(c, d)` classifies as NAMED, which removes the alias and breaks the
      // pinned `aliased(a, b)` line.
      {
        code: [
          SAFE_IMPORT,
          `import { ${fn} as aliased } from 'node:path';`,
          'export const p = aliased(a, b);',
          `export const q = ${fn}(c, d);`,
          `export const r = safePath.${fn}(e, f);`,
        ].join('\n'),
        filename: LINTED_FILE,
        options,
        output: [
          SAFE_IMPORT,
          `import { ${fn} as aliased } from 'node:path';`,
          'export const p = aliased(a, b);',
          `export const q = safePath.${fn}(c, d);`,
          `export const r = safePath.${fn}(e, f);`,
        ].join('\n'),
        errors,
      },
      // RE-EXPORTED specifier: rewrite the call, but KEEP the import.
      //
      // Removing it left `export { join }` naming nothing, and the fixed file
      // did not PARSE — `Export 'join' is not defined`. Output that cannot be
      // parsed is the worst result an autofix can produce, strictly worse than
      // leaving a finding on screen, so the specifier stays and the residual is
      // a lint message a human can read.
      {
        code: `import { ${fn} } from 'node:path';\nexport { ${fn} };\nconst p = ${fn}(a, b);`,
        filename: LINTED_FILE,
        options,
        output: `import { ${fn} } from 'node:path';\n${SAFE_IMPORT}\nexport { ${fn} };\nconst p = safePath.${fn}(a, b);`,
        errors,
      },
      // ORPHANED `safePath.join(...)` — the OTHER half of the repair, and the
      // reason the file above can ever recover.
      //
      // ESLint runs `fix()` before the `eslint-disable` filter, so a suppressed
      // report on the first call site consumes the once-per-file import edit
      // and then discards it. Every other call becomes `safePath.join`, nothing
      // imports `safePath`, and no report is left to carry the import on any
      // later pass. An adversarial run produced exactly that as a STABLE
      // fixpoint — `--fix` twice more changed nothing — against a docstring
      // that claimed the state was transient. This leg is what makes the claim
      // true.
      {
        code: `const p = safePath.${fn}(a, b);`,
        filename: LINTED_FILE,
        options,
        output: `${SAFE_IMPORT}\nconst p = safePath.${fn}(a, b);`,
        errors,
      },
      // DECOY basenames — same file name, different directory. MUST still fire.
      decoy('tools/hooks/path-utils.ts'),
      decoy('packages/other/src/path-core.ts'),
      decoy('packages/cli/src/my-path-utils.ts'),
      // UNCONFIGURED: the paths that used to be hardcoded into the factory are
      // exempt only because the config above named them. With no options they
      // are ordinary files and MUST fire — otherwise publishing this pack would
      // ship VAT's layout as a silent hole in every adopter's repo.
      { code: unsafeMemberCode, filename: PATH_CORE_IMPL, output: unsafeMemberOutput, errors },
      { code: unsafeMemberCode, filename: PATH_UTILS_IMPL, output: unsafeMemberOutput, errors },
      // ALREADY BOUND: the file reaches `safePath` through the BARREL. Rewrite
      // the call, but do NOT add an import — a second `safePath` binding is
      // `SyntaxError: Identifier 'safePath' has already been declared`, so the
      // autofix would emit code that cannot parse. Latent while the fix target
      // WAS the barrel; live the moment it became `/path`, for exactly the
      // population being migrated.
      {
        code: `import { safePath } from '${BARREL}';\nimport path from 'node:path';\nconst p = path.${fn}(a, b);`,
        filename: LINTED_FILE,
        options,
        output: `import { safePath } from '${BARREL}';\nimport path from 'node:path';\nconst p = safePath.${fn}(a, b);`,
        errors,
      },
      // Same conflict from a plain top-level declaration, which no
      // import-scanning check would have seen.
      {
        code: `const safePath = makeIt();\nimport path from 'node:path';\nconst p = path.${fn}(a, b);`,
        filename: LINTED_FILE,
        options,
        output: `const safePath = makeIt();\nimport path from 'node:path';\nconst p = safePath.${fn}(a, b);`,
        errors,
      },
    ],
  };
}

/**
 * A bare-basename `exemptFiles` entry exempts that filename EVERYWHERE.
 *
 * ESLint reports absolute filenames, so the matcher's `endsWith('/' + target)`
 * leg fires for every `path-utils.ts` in the tree — the same repo-wide hole the
 * anchoring rewrite closed, reopened one config entry at a time. Reported
 * through the lint channel rather than as a schema `pattern`, because the schema
 * sees the RAW string and `./path-utils.ts` contains a `/` while normalizing to
 * exactly the same hole.
 */
/**
 * `safeModule` — point the fixer at the CONSUMING repo's re-export seam.
 *
 * The narrow-subpath defaults are right only for a repo importing this package
 * directly. An adopter measured what they cost everyone else: of the 61 packages
 * in their workspace that would receive a new import, **52 (620 files) do not
 * declare `@vibe-agent-toolkit/utils`**. Under pnpm's isolated `node_modules`
 * that import does not degrade, it fails to resolve — so the autofix is only as
 * good as its ability to name a specifier that resolves where the fix lands.
 * Across their top 25 affected packages the default resolved in 0; their seam
 * resolved in 24.
 *
 * PER-RULE, because a seam need not split its symbols the way this package does:
 * theirs carries `normalizedTmpdir` but not `safePath`, so `no-os-tmpdir` and
 * `no-path-join` need different targets — what one shared key cannot express.
 */
const SEAM = '@acme/dev-tools/path-utils';

/**
 * Named because each now heads three suites — its own cases, the `safeModule`
 * cases, and the unanchored-`exemptFiles` cases. One rule per code path:
 * `no-path-join` stands for `path-function-rule-factory`, `no-os-tmpdir` for
 * `eslint-rule-factory`.
 */
/**
 * Rule names, named once. Several tables below enumerate the same rules from
 * different angles (fixpoint, suppression, `safeModule`), and a rule renamed in
 * one table and not another is a silently skipped suite, not a failure.
 */
const RULE = {
  join: 'no-path-join',
  resolve: 'no-path-resolve',
  relative: 'no-path-relative',
  tmpdir: 'no-os-tmpdir',
  mkdir: 'no-fs-mkdirSync',
  realpath: 'no-fs-realpathSync',
  execSync: 'no-child-process-execSync',
  cp: 'no-fs-promises-cp',
  normalize: 'no-manual-path-normalize',
} as const;

const NODE_FS = 'node:fs';
/** The path module AS IT APPEARS IN SOURCE, quotes and all — several suites assert on
 * whether the import survived a fix, and that is a substring check against the output. */
const QUOTED_NODE_PATH = "'node:path'";
const NODE_CHILD_PROCESS = 'node:child_process';

/** `import { name } from 'module';` — spelled once, so the tables stay readable. */
function namedImport(name: string, module: string): string {
  return `import { ${name} } from '${module}';`;
}

const PATH_FACTORY_RULE = RULE.join;
const CALL_FACTORY_RULE = RULE.tmpdir;

/**
 * @param unsafeCode - The shape that must report.
 * @param fixedCode - What ONE `--fix` pass produces from it.
 * @param errors - The expected reports.
 * @param settledCode - The shape that must NOT report, when it differs from
 *   `fixedCode`. One pass rewrites the call and leaves the now-unused `node:*`
 *   binding for the pass after — so for the rules that migrate a NAMESPACE
 *   member, the one-pass output is a legitimate finding (`deadUnsafeImport`) and
 *   cannot double as the valid fixture. Conflating the two is how a suite ends
 *   up asserting that a half-finished fix is the finished state.
 */
function safeModuleCases(
  unsafeCode: string,
  fixedCode: string,
  errors: object[],
  settledCode: string = fixedCode,
): RuleCases {
  return {
    valid: [
      // Already importing from the configured seam — nothing to add.
      { code: settledCode, filename: LINTED_FILE, options: [{ safeModule: SEAM }] },
    ],
    invalid: [
      {
        code: unsafeCode,
        filename: LINTED_FILE,
        options: [{ safeModule: SEAM }],
        output: fixedCode,
        errors,
      },
    ],
  };
}

const UNANCHORED_ERROR = [{ messageId: 'unanchoredExemptFile' }];

function unanchoredExemptCases(unsafeCode: string, safeCode: string): RuleCases {
  return {
    valid: [
      // Properly anchored: no advisory.
      { code: safeCode, filename: LINTED_FILE, options: [{ exemptFiles: [PATH_UTILS_IMPL] }] },
      // No option at all: nothing to advise about.
      { code: safeCode, filename: LINTED_FILE },
      // Windows-spelled but still anchored.
      {
        code: safeCode,
        filename: LINTED_FILE,
        options: [{ exemptFiles: [String.raw`packages\utils\src\path-utils.ts`] }],
      },
    ],
    invalid: [
      // Fires on a file the entry does NOT match…
      { code: safeCode, filename: LINTED_FILE, options: [{ exemptFiles: ['path-utils.ts'] }], errors: UNANCHORED_ERROR },
      // …and on the file it DOES match, which is exempt only because of it.
      { code: unsafeCode, filename: PATH_UTILS_IMPL, options: [{ exemptFiles: ['path-utils.ts'] }], errors: UNANCHORED_ERROR },
      // `./x` normalizes to the same hole — the spelling a schema `pattern`
      // would have waved through.
      { code: safeCode, filename: LINTED_FILE, options: [{ exemptFiles: ['./path-utils.ts'] }], errors: UNANCHORED_ERROR },
    ],
  };
}


const NO_UNSAFE_ROOT_JOIN_CASES: RuleCases = {
  valid: [
    // joinUnderRoot — already the safe call, not flagged
    { code: 'safePath.joinUnderRoot(harnessRoot, name);' },
    // First arg does NOT end in 'root' — not a security root join, not flagged
    { code: 'safePath.join(baseDir, name);' },
    { code: 'safePath.join(pluginDir, name);' },
    { code: 'safePath.resolve(outputDir, name);' },
    // Non-safePath member expression — not our rule
    { code: "path.join(harnessRoot, 'sub');"},
    // safePath.relative is not join/resolve — not flagged
    { code: "safePath.relative(harnessRoot, dest);" },
    // No arguments — not flagged
    { code: "safePath.join();" },
  ],
  invalid: [
    {
      code: 'safePath.join(harnessRoot, name);',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
    {
      code: 'safePath.join(stagedRoot, "subdir");',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
    {
      code: 'safePath.join(pluginRoot, stagedDirName(item));',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
    {
      code: 'safePath.resolve(harnessRoot, segment);',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
    {
      // Mixed-case 'Root' suffix
      code: 'safePath.join(outputROOT, "child");',
      errors: [{ messageId: 'useJoinUnderRoot' }],
    },
  ],
};

const REQUIRE_JUSTIFIED_SKIP_CASES: RuleCases = {
  valid: [
    // Conditional gates are a platform/environment condition, not a coverage claim.
    { code: "it.skipIf(process.platform === 'win32')('x', () => {});" },
    { code: 'describe.skipIf(!apiKey)("x", () => {});' },
    { code: 'it.runIf(hasPlugins)("x", () => {});' },
    { code: 'describe.runIf(cond)("x", () => {});' },
    // Runtime context skip (vitest `ctx.skip(...)`) — a condition evaluated at run time.
    { code: 'ctx.skip(message);' },
    { code: 'this.skip();' },
    // Ternary gates. Both shapes are live in this repo (corpus-scan.system.test.ts
    // and llm-regression.test.ts) and are skipIf() spelled by hand — a condition,
    // not a coverage claim. The rule's first draft flagged both; it was wrong.
    { code: "(NET ? describe : describe.skip)('x', () => {});" },
    { code: 'const gate = shouldRun ? describe : describe.skip;' },
    { code: "(cond ? it : it.skip)('x', () => {});" },
    { code: 'const gate = cond ? describe.skip : describe;' },
    // Aliasing a runner that is NOT disabled is not a skip.
    { code: 'const runner = describe;' },
    // Ordinary tests and real assertions.
    { code: 'it("x", () => { expect(a).toBe(b); });' },
    { code: 'test("x", async () => { await run(); expect(a).toBe(b); });' },
    // An empty `describe` claims no case of its own — only `it`/`test` do.
    { code: 'describe("x", () => {});' },
    { code: 'expect(result).toBe(true);' },
    { code: 'expect(true).toBe(result);' },
    { code: 'expect(1).toHaveLength(n);' },
    { code: 'expect(value).toBeTruthy();' },
    { code: 'expect.assertions(2);' },
    { code: 'expect(items[0]).toBe("a");' },
    // Non-literal operands — the comparison depends on the code under test.
    { code: 'expect(a === b).toBe(true);' },
    { code: 'expect(result.length > 0).toBe(true);' },
    // Only one side is a known-empty collection — the other is the subject.
    { code: 'expect(result).toEqual([]);' },
    { code: 'expect([]).toEqual(result);' },
    { code: 'expect(result).toEqual({});' },
    // `assert` on a runtime value, and the deliberate always-fail guard.
    { code: 'assert(value);' },
    { code: "assert(false, 'unreachable');" },
    { code: 'assert(items.length > 0);' },
    // `expect.soft` behaves like `expect` — same subject rules apply.
    { code: 'expect.soft(result).toBe(true);' },
    // A deeper chain that does not bottom out at a test-runner global.
    { code: "myLib.test.skip('x', () => {});" },
    { code: "helpers.it['skip']('x', () => {});" },
    { code: "test.concurrent('x', () => { expect(a).toBe(b); });" },
    // Computed access with a non-literal key — unknowable, so not flagged.
    { code: "it[name]('x', () => {});" },
    { code: "obj['skip']('x');" },
    // Justified skips — annotation directly above the call.
    { code: "// SKIP(#163): blocked on extractor work\nit.skip('x', () => {});" },
    { code: "// SKIP(#42): needs a fixture that can distinguish the two lanes\nit.todo('x');" },
    { code: "/* SKIP(#7): flaky under bun, tracked upstream */\ndescribe.skip('x', () => {});" },
    // Justified skip — trailing annotation on the same line.
    { code: "it.todo('x'); // SKIP(#99): waiting on the extractor" },
    // Justified tautology.
    { code: '// SKIP(#12): asserts the matcher itself, not the subject\nexpect(true).toBe(true);' },
  ],
  invalid: [
    { code: "it.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "test.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "describe.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "suite.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "it.todo('x');", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "test.todo('x');", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "it.skip.each([1])('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "xit('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "xdescribe('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "xtest('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    // A vague comment is NOT a justification — the grammar is deliberately narrow.
    { code: "// fix this later\nit.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "// skip(#12): lowercase does not match\nit.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "// SKIP(#12)\nit.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "// SKIP(#12):\nit.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "// SKIP(): no issue number\nit.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    // Only the `SKIP` keyword is accepted. The obvious alternative keyword is banned
    // repo-wide by another sonarjs rule, so a grammar built on it would be unusable.
    { code: "// TODO(#12): wrong keyword\nit.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    // An annotation two lines above is out of range.
    { code: "// SKIP(#12): too far away\n\nit.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    // Tautological assertions — literal subject, literal (or absent) matcher argument.
    { code: 'expect(true).toBe(true);', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(true).toBe(false);', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(1).toBe(1);', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: "expect('a').toEqual('a');", errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(true).toBeTruthy();', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(true).not.toBe(false);', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(-1).toBe(-1);', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(`abc`).toBe("abc");', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(null).toBeNull();', errors: [{ messageId: 'tautologicalAssertion' }] },
    // Aliasing an unconditional skip — one deleted ternary away from the valid
    // gate above, and invisible to the call-site check.
    { code: 'const gate = describe.skip;', errors: [{ messageId: 'unconditionalSkip' }] },
    { code: 'let gate; gate = it.skip;', errors: [{ messageId: 'unconditionalSkip' }] },
    // Always-true expressions that are not `Literal` nodes.
    { code: 'expect(1 === 1).toBe(true);', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect(2 > 1).toBeTruthy();', errors: [{ messageId: 'tautologicalAssertion' }] },
    // Empty-collection self-comparison.
    { code: 'expect([]).toEqual([]);', errors: [{ messageId: 'tautologicalAssertion' }] },
    { code: 'expect({}).toEqual({});', errors: [{ messageId: 'tautologicalAssertion' }] },
    // `assert(true)` never fails.
    { code: 'assert(true);', errors: [{ messageId: 'tautologicalAssertion' }] },
    // `expect.soft` is still an expect.
    { code: 'expect.soft(true).toBe(true);', errors: [{ messageId: 'tautologicalAssertion' }] },
    // Deeper member chains that still bottom out at a test-runner global.
    { code: "test.concurrent.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    { code: "test.sequential.skip('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    // Computed access spelling the same disabling member.
    { code: "it['skip']('x', () => {});", errors: [{ messageId: 'unconditionalSkip' }] },
    // A test with no body asserts nothing while reporting as PASSING.
    { code: "it('x', () => {});", errors: [{ messageId: 'emptyTestBody' }] },
    { code: "test('x', async () => {});", errors: [{ messageId: 'emptyTestBody' }] },
  ],
};

/**
 * `no-os-tmpdir` / `no-fs-mkdirSync` / `no-fs-realpathSync` /
 * `no-child-process-execSync` share the OTHER factory, which had the same
 * substring-exemption bug (`filename.includes('path-utils.ts')`). Same decoy
 * discipline applies: a same-named file in a different directory must fire.
 */
interface UnsafeCallRuleSpec {
  unsafeFn: string;
  unsafeModule: string;
  safeFn: string;
  /** The NARROW subpath that owns `safeFn` — never the barrel. */
  safeModule: string;
  exemptPath: string;
}

function unsafeCallRuleCases(
  { unsafeFn, unsafeModule, safeFn, safeModule, exemptPath }: UnsafeCallRuleSpec,
): RuleCases {
  const unsafeCode = `import { ${unsafeFn} } from '${unsafeModule}';\nconst r = ${unsafeFn}(x);`;
  // The new import takes the removed one's LINE. It used to be welded onto
  // whatever followed, because the fixer inserted after `body[0]` with a
  // trailing newline regardless of what `body[0]` was — visible here only as a
  // moved `\n`, and visible in a file whose first statement is not an import as
  // `const os = {…};import { normalizedTmpdir } from '…';` on one line.
  const output = `\nimport { ${safeFn} } from '${safeModule}';\nconst r = ${safeFn}(x);`;
  const errors = [{ messageId: 'noUnsafeOperation' }];
  const options = [{ exemptFiles: [exemptPath] }];
  const decoy = (filename: string) => ({ code: unsafeCode, filename, options, output, errors });
  const exemptBasename = exemptPath.slice(exemptPath.lastIndexOf('/') + 1);

  return {
    valid: [
      {
        code: `import { ${safeFn} } from '${safeModule}';\nconst r = ${safeFn}(x);`,
        filename: LINTED_FILE,
        options,
      },
      { code: unsafeCode, filename: exemptPath, options },
      { code: unsafeCode, filename: `/Users/dev/vat/${exemptPath}`, options },
      // A same-named method on an unrelated object is not this module's call.
      // The member branch used to match on the property name ALONE, so any
      // `env.tmpdir()` was an `os.tmpdir()` finding. That was survivable while
      // the fixer rewrote only the property — `env.normalizedTmpdir()` does not
      // compile, so the false positive announced itself. Replacing the whole
      // callee turned it into `normalizedTmpdir()`, which compiles, type-checks
      // and passes `no-undef` while silently calling a different function with
      // the receiver thrown away. A false positive that produces WORKING code
      // is the more dangerous kind, so the receiver is now checked.
      {
        code: `const env = { ${unsafeFn}: () => 'x' };\nexport const r = env.${unsafeFn}();`,
        filename: LINTED_FILE,
        options,
      },
      {
        code: `interface Env { ${unsafeFn}(): string }\nexport function pick(env: Env) { return env.${unsafeFn}(); }`,
        filename: LINTED_FILE,
        options,
        languageOptions: { parser: tsParser },
      },
    ],
    invalid: [
      { code: unsafeCode, filename: LINTED_FILE, options, output, errors },
      // DECOY basenames — the shape that shipped raw tmpdir()/realpathSync()
      // past a fork of this rule pack in a consumer repo.
      decoy(`tools/hooks/${exemptBasename}`),
      decoy(`packages/other/src/${exemptBasename}`),
      // UNCONFIGURED — with no `exemptFiles` option nothing is exempt, including
      // the path this factory used to hardcode. See pathFunctionRuleCases above.
      { code: unsafeCode, filename: exemptPath, output, errors },
      // ALREADY BOUND through the BARREL — rewrite the call, add no import. A
      // second binding of `safeFn` is a SyntaxError, not a redundant import.
      {
        code: `import { ${safeFn} } from '${BARREL}';\nimport { ${unsafeFn} } from '${unsafeModule}';\nconst r = ${unsafeFn}(x);`,
        filename: LINTED_FILE,
        options,
        output: `import { ${safeFn} } from '${BARREL}';\n\nconst r = ${safeFn}(x);`,
        errors,
      },
    ],
  };
}

/**
 * `no-unix-shell-commands` exempts test files, because the tests for the detector
 * necessarily name the banned commands. That exemption was
 * `filename.includes('.test.ts')`, which is a CATEGORY check written as an
 * unanchored substring: it also exempted `example.test.ts.bak`, a `.test.ts`
 * directory, and (really, in this repo) `tsconfig.test.json` via `.test.js`.
 * The valid legs prove genuine test files are STILL exempt — without them the
 * rule could be "fixed" by exempting nothing and this suite would stay green.
 */
const UNIX_CMD_CODE = "safeExecSync('tar', ['xzf', archive]);";
const UNIX_TEST_FILE = 'packages/utils/test/eslint/example.test.ts';
const NO_UNIX_SHELL_COMMANDS_CASES: RuleCases = {
  valid: [
    { code: "safeExecSync('node', [script]);", filename: LINTED_FILE },
    { code: UNIX_CMD_CODE, filename: UNIX_TEST_FILE },
    { code: UNIX_CMD_CODE, filename: `/Users/dev/vat/${UNIX_TEST_FILE}` },
    { code: UNIX_CMD_CODE, filename: String.raw`C:\dev\vat\packages\utils\test\eslint\example.test.ts` },
  ],
  invalid: [
    { code: UNIX_CMD_CODE, filename: LINTED_FILE, errors: [{ messageId: 'noUnixCommand' }] },
    { code: "execSync('tar xzf x.tgz');", filename: LINTED_FILE, errors: [{ messageId: 'noUnixCommand' }] },
    // DECOYS — every one of these linted clean under the substring exemption.
    { code: UNIX_CMD_CODE, filename: 'packages/cli/src/example.test.ts.bak', errors: [{ messageId: 'noUnixCommand' }] },
    { code: UNIX_CMD_CODE, filename: 'packages/cli/src/.test.ts-helpers/impl.ts', errors: [{ messageId: 'noUnixCommand' }] },
  ],
};

/**
 * `no-bare-symlink-in-tests` fires only INSIDE test files (`isTestFile`) — the
 * opposite polarity of `no-unix-shell-commands` above: a bare `symlinkSync()`
 * is unremarkable in production code (there is no capability wrapper to route
 * it through there) and only a Windows landmine inside a test that skipped the
 * probe. No auto-fix: the replacement needs a capability token threaded from a
 * probe call, a placement judgment a mechanical fixer cannot make.
 *
 * The exempt path deliberately ends in `.test.ts` (a real backlog entry, not
 * the implementation file) so the anchoring decoy below actually exercises
 * `exempt-path-matcher.cjs` rather than being filtered out by `isTestFile`
 * first for an unrelated reason.
 */
const SYMLINK_TEST_FILE = 'packages/cli/test/example.test.ts';
const SYMLINK_EXEMPT = 'packages/resources/test/resolve-local-href.test.ts';
const SYMLINK_SYNC_NAMED = "import { symlinkSync } from 'node:fs';\nsymlinkSync(a, b);";
const SYMLINK_SYNC_MEMBER = "import fs from 'node:fs';\nfs.symlinkSync(a, b);";
const SYMLINK_ASYNC_MEMBER = "import fs from 'node:fs/promises';\nawait fs.symlink(a, b);";
const SYMLINK_ASYNC_NAMED = "import { symlink } from 'node:fs/promises';\nawait symlink(a, b);";
const SYMLINK_ASYNC_CHAINED_MEMBER = "import fs from 'node:fs';\nawait fs.promises.symlink(a, b);";
const NO_BARE_SYMLINK_CASES: RuleCases = {
  valid: [
    { code: SYMLINK_SYNC_NAMED, filename: SYMLINK_EXEMPT, options: [{ exemptFiles: [SYMLINK_EXEMPT] }] },
    { code: SYMLINK_SYNC_NAMED, filename: `/Users/dev/vat/${SYMLINK_EXEMPT}`, options: [{ exemptFiles: [SYMLINK_EXEMPT] }] },
    // A same-named method on an unrelated receiver is not this module's call.
    {
      code: "const env = { symlinkSync: () => {} };\nenv.symlinkSync();",
      filename: SYMLINK_TEST_FILE,
      options: [{ exemptFiles: [SYMLINK_EXEMPT] }],
    },
  ],
  invalid: [
    { code: SYMLINK_SYNC_NAMED, filename: SYMLINK_TEST_FILE, options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'noBareSymlink' }] },
    { code: SYMLINK_SYNC_MEMBER, filename: SYMLINK_TEST_FILE, options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'noBareSymlink' }] },
    { code: SYMLINK_ASYNC_MEMBER, filename: SYMLINK_TEST_FILE, options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'noBareSymlink' }] },
    { code: SYMLINK_ASYNC_NAMED, filename: SYMLINK_TEST_FILE, options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'noBareSymlink' }] },
    { code: SYMLINK_ASYNC_CHAINED_MEMBER, filename: SYMLINK_TEST_FILE, options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'noBareSymlink' }] },
    // DECOY — same basename as the exempt entry, different directory: must still fire.
    { code: SYMLINK_SYNC_NAMED, filename: 'packages/other/test/resolve-local-href.test.ts', options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'noBareSymlink' }] },
    // Shipped code is covered too, with the OTHER message. It cannot `skip()`,
    // and `createSymlink()` lives on the `utils/testing` subpath, so pointing
    // production code at a test helper would be worse advice than the bare
    // call — hence a distinct messageId rather than a reworded one.
    // Asserting the id, not just "it errors", is what stops the two remedies
    // silently collapsing into one.
    { code: SYMLINK_SYNC_NAMED, filename: LINTED_FILE, options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'unguardedSymlink' }] },
    { code: SYMLINK_ASYNC_MEMBER, filename: LINTED_FILE, options: [{ exemptFiles: [SYMLINK_EXEMPT] }], errors: [{ messageId: 'unguardedSymlink' }] },
    // UNCONFIGURED — with no `exemptFiles` option nothing is exempt, including the backlog path.
    { code: SYMLINK_SYNC_NAMED, filename: SYMLINK_EXEMPT, errors: [{ messageId: 'noBareSymlink' }] },
  ],
};

const SUITES: readonly RuleSuite[] = [
  { name: 'no-raw-text-decode', cases: NO_RAW_TEXT_DECODE_CASES },
  { name: 'no-url-pathname-for-fs', cases: NO_URL_PATHNAME_FOR_FS_CASES },
  { name: 'no-bare-dynamic-import-path', cases: NO_BARE_DYNAMIC_IMPORT_PATH_CASES },
  { name: 'no-file-url-string-concat', cases: NO_FILE_URL_STRING_CONCAT_CASES },
  { name: 'prefer-startswith-over-regex', cases: PREFER_STARTSWITH_OVER_REGEX_CASES },
  { name: 'no-unsafe-root-join', cases: NO_UNSAFE_ROOT_JOIN_CASES },
  { name: 'require-justified-skip', cases: REQUIRE_JUSTIFIED_SKIP_CASES },
  { name: 'no-unix-shell-commands', cases: NO_UNIX_SHELL_COMMANDS_CASES },
  { name: 'no-bare-symlink-in-tests', cases: NO_BARE_SYMLINK_CASES },
  { name: PATH_FACTORY_RULE, cases: pathFunctionRuleCases('join') },
  { name: RULE.resolve, cases: pathFunctionRuleCases('resolve') },
  { name: RULE.relative, cases: pathFunctionRuleCases('relative') },
  {
    name: CALL_FACTORY_RULE,
    cases: unsafeCallRuleCases({
      unsafeFn: 'tmpdir', unsafeModule: 'node:os', safeFn: 'normalizedTmpdir',
      safeModule: SAFE_FS_MODULE, exemptPath: PATH_UTILS_IMPL,
    }),
  },
  {
    name: 'no-fs-mkdirSync',
    cases: unsafeCallRuleCases({
      unsafeFn: 'mkdirSync', unsafeModule: 'node:fs', safeFn: 'mkdirSyncReal',
      safeModule: SAFE_FS_MODULE, exemptPath: PATH_UTILS_IMPL,
    }),
  },
  {
    name: 'no-fs-realpathSync',
    cases: unsafeCallRuleCases({
      unsafeFn: 'realpathSync', unsafeModule: 'node:fs', safeFn: 'normalizePath',
      safeModule: SAFE_FS_MODULE, exemptPath: PATH_UTILS_IMPL,
    }),
  },
  {
    name: 'no-child-process-execSync',
    cases: unsafeCallRuleCases({
      unsafeFn: 'execSync',
      unsafeModule: NODE_CHILD_PROCESS,
      safeFn: 'safeExecSync',
      safeModule: '@vibe-agent-toolkit/utils/process',
      exemptPath: 'packages/utils/src/safe-exec.ts',
    }),
  },
  // `safeModule`, once per code path that WRITES an import: the two factories
  // and `no-manual-path-normalize`, which has its own fixer.
  {
    name: PATH_FACTORY_RULE,
    cases: safeModuleCases(
      "import path from 'node:path';\nconst p = path.join(a, b);",
      `import path from 'node:path';\nimport { safePath } from '${SEAM}';\nconst p = safePath.join(a, b);`,
      [{ messageId: 'noUnsafePathFn' }],
      // Pass 2 takes the orphaned `path` binding with it; THIS is settled.
      `import { safePath } from '${SEAM}';\nconst p = safePath.join(a, b);`,
    ),
  },
  {
    name: CALL_FACTORY_RULE,
    cases: safeModuleCases(
      "import { tmpdir } from 'node:os';\nconst r = tmpdir();",
      `\nimport { normalizedTmpdir } from '${SEAM}';\nconst r = normalizedTmpdir();`,
      [{ messageId: 'noUnsafeOperation' }],
    ),
  },
  {
    name: 'no-manual-path-normalize',
    cases: (() => {
      const cases = safeModuleCases(
        "const n = p.split(path.sep).join('/');",
        `import { toForwardSlash } from '${SEAM}';\nconst n = toForwardSlash(p);`,
        [{ messageId: 'useToForwardSlash' }],
      );
      return {
        ...cases,
        valid: [
          ...cases.valid,
          // Splitting on a TWO-backslash SEQUENCE — source literal
          // String.raw`'\\\\'`, decoded value: two backslash characters —
          // is a different, rarer operation (e.g. collapsing a UNC path's
          // leading double-backslash server prefix) than splitting on
          // path.sep. toForwardSlash() is not equivalent to it, so this must
          // NOT be treated as the path.sep-style split the rule autofixes —
          // it stays valid (unflagged).
          { code: String.raw`const n = p.split('\\\\').join('/');`, filename: LINTED_FILE },
        ],
      };
    })(),
  },
  // The unanchored-`exemptFiles` advisory, once per factory: `no-path-join`
  // covers `path-function-rule-factory`, `no-os-tmpdir` the other one.
  {
    name: PATH_FACTORY_RULE,
    cases: unanchoredExemptCases(
      "import path from 'node:path'; const p = path.join(a, b);",
      `${SAFE_IMPORT} const p = safePath.join(a, b);`,
    ),
  },
  {
    name: CALL_FACTORY_RULE,
    cases: unanchoredExemptCases(
      "import { tmpdir } from 'node:os';\nconst r = tmpdir();",
      `import { normalizedTmpdir } from '${SAFE_FS_MODULE}';\nconst r = normalizedTmpdir();`,
    ),
  },
];

/** Shared title for the `ruleTester.run(...)` leg every rule suite below has. */
const RULE_TESTER_CASES = 'passes RuleTester cases';

describe.each(SUITES)('$name', ({ name, cases }) => {
  const rule = loadLocalRule(`${name}.cjs`);

  it('is registered with a valid schema', () => {
    expect(rule.meta?.type).toBe('problem');
  });

  it(RULE_TESTER_CASES, () => {
    expect(() => { ruleTester.run(name, rule, cases); }).not.toThrow();
  });
});

/**
 * `no-command-direct-factory` builds rules rather than being one, so it needs its
 * own suite. Its `exemptPackage` had the DIRECTORY flavor of the substring bug:
 * `filename.includes('packages/git/')` also exempted `vendor/copy-packages/git/`
 * and `tools/my-packages/git/` — any directory whose name merely ENDS WITH the
 * exempt one. Those are the load-bearing invalid legs below.
 */
describe('no-command-direct-factory', () => {
  type CommandRuleConfig = {
    command: string;
    packageName: string;
    availableFunctions: string[];
    exemptPackage?: string;
  };
  const createNoCommandDirectRule =
    loadLocalRuleModule<(config: CommandRuleConfig) => Rule.RuleModule>('no-command-direct-factory.cjs');

  const rule = createNoCommandDirectRule({
    command: 'git',
    packageName: '@vibe-agent-toolkit/git',
    availableFunctions: ['executeGitCommand()'],
    exemptPackage: 'packages/git/',
  });
  // Deliberately the pattern this rule EXISTS to catch. It is a fixture, not a
  // call site: a bulk migration that "fixes" it silently disarms the rule's
  // entire invalid[] leg, which then passes by finding nothing to report.
  const gitCode = "safeExecSync('git', ['status']);";
  const errors = [{ messageId: 'noGitDirect' }];

  it(RULE_TESTER_CASES, () => {
    expect(() => {
      ruleTester.run('no-git-commands-direct', rule, {
        valid: [
          { code: "safeExecSync('node', [script]);", filename: LINTED_FILE },
          { code: gitCode, filename: 'packages/git/src/index.ts' },
          { code: gitCode, filename: '/Users/dev/vat/packages/git/src/index.ts' },
          { code: gitCode, filename: String.raw`C:\dev\vat\packages\git\src\index.ts` },
        ],
        invalid: [
          { code: gitCode, filename: LINTED_FILE, errors },
          { code: "execSync('git status');", filename: LINTED_FILE, errors },
          // DECOY directories — exempted by the old substring check.
          { code: gitCode, filename: 'vendor/copy-packages/git/src/index.ts', errors },
          { code: gitCode, filename: 'tools/my-packages/git/exec.ts', errors },
        ],
      });
    }).not.toThrow();
  });
});

/**
 * A message placeholder and the schema that fills it must not drift apart.
 *
 * `{{safeModule}}` is only ever substituted because the rule read the option and
 * passed it as report `data`. A rule that interpolates it WITHOUT declaring the
 * option in `meta.schema` cannot be pointed at a consumer's seam — its advice
 * would keep naming this package's subpath while the fixers around it wrote the
 * consumer's, which is the same fixer/docs divergence that made the autofix
 * target a blocker in the first place.
 *
 * Declaring the option is only half of it. The other half — that the rule
 * actually passes `safeModule` as report `data` — cannot be seen structurally:
 * a rule may declare the option, read it, and still omit it from a single
 * `context.report` call, at which point ESLint renders the literal
 * `{{safeModule}}` into the message a developer reads. So the second suite
 * below RENDERS every one of these rules and asserts no placeholder survives.
 *
 * The set of rules is pinned by MEMBERSHIP, not by count: each one must have a
 * snippet here that provokes it. Seven of the twenty-two have no RuleTester
 * suite at all, so a check that merely counted would let exactly those drift.
 */
const PATH_IMPORT = "import path from 'node:path';\n";

/** One snippet per rule that interpolates `{{safeModule}}`, chosen to provoke it. */
const SAFE_MODULE_RULE_TRIGGERS: Record<string, string> = {
  'no-path-join': `${PATH_IMPORT}const p = path.join(a, b);`,
  'no-path-resolve': `${PATH_IMPORT}const p = path.resolve(a, b);`,
  'no-path-relative': `${PATH_IMPORT}const p = path.relative(a, b);`,
  'no-path-sep-in-strings': `${PATH_IMPORT}const s = 'a' + path.sep + 'b';`,
  // Reports path calls in ARGUMENT position, not receiver position.
  'no-path-operations-in-comparisons': `${PATH_IMPORT}const y = base.startsWith(path.relative(a, b));`,
  'no-manual-path-normalize': "const n = p.split(path.sep).join('/');",
  'no-hardcoded-path-split': "const parts = p.split('/');",
  'no-path-startswith': "const x = filePath.startsWith('/a');",
  'no-os-tmpdir': "import { tmpdir } from 'node:os';\nconst t = tmpdir();",
  'no-fs-mkdirSync': "import { mkdirSync } from 'node:fs';\nmkdirSync(d, { recursive: true });",
  'no-fs-realpathSync': "import { realpathSync } from 'node:fs';\nconst r = realpathSync(p);",
  'no-fs-promises-cp': "import { cp } from 'node:fs/promises';\nawait cp(a, b);",
  [RULE.execSync]: `${namedImport('execSync', NODE_CHILD_PROCESS)}\nexecSync('ls');`,
  'no-url-pathname-for-fs': "const p = new URL('../fixtures/x.yaml', import.meta.url).pathname;",
  'no-bare-dynamic-import-path': 'const m = await import(configPath);',
  'no-raw-text-decode': BUFFER_UTF8_DECODE,
};

describe('every {{safeModule}} placeholder is backed by the option that fills it', () => {
  const plugin = loadLocalRuleModule<{
    rules: Record<string, Rule.RuleModule>;
  }>('../index.cjs');

  const rulesUsingPlaceholder = Object.entries(plugin.rules).filter(([, rule]) =>
    Object.values(rule.meta?.messages ?? {}).some((message) => message.includes('{{safeModule}}')),
  );

  it('exercises exactly the rules that use it (guards against a vacuous pass)', () => {
    // Membership, not cardinality: an unchanged count can mask changed occupants.
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect(rulesUsingPlaceholder.map(([name]) => name).sort(byName)).toStrictEqual(
      Object.keys(SAFE_MODULE_RULE_TRIGGERS).sort(byName),
    );
  });

  it.each(rulesUsingPlaceholder)('%s declares the safeModule option', (_name, rule) => {
    const schema = rule.meta?.schema;
    expect(Array.isArray(schema)).toBe(true);
    const [options] = schema as [{ properties?: Record<string, unknown> }];
    expect(options.properties).toHaveProperty('safeModule');
  });

  it.each(rulesUsingPlaceholder)('%s renders the configured module, not the placeholder', (name, rule) => {
    const messages = new Linter().verify(
      SAFE_MODULE_RULE_TRIGGERS[name] ?? '',
      [
        {
          files: ['**/*.ts'],
          plugins: { local: { rules: { [name]: rule } } },
          rules: { [`local/${name}`]: ['error', { safeModule: SEAM }] },
          languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
        },
      ],
      { filename: LINTED_FILE },
    );

    // A snippet that stopped provoking its rule would make the assertions below
    // vacuously true, so require a report before inspecting one.
    expect(messages.length).toBeGreaterThan(0);
    for (const { message } of messages) {
      expect(message).not.toContain('{{');
      expect(message).toContain(SEAM);
    }
  });
});

/**
 * `--fix` must not leave behind a reference to something it just un-imported.
 *
 * This is the property an adopter measured on a real sweep, and it is not the
 * property any fixture above asserts. RuleTester applies exactly ONE pass and
 * compares a string; this runs `--fix` to its fixpoint and then asks the
 * compiler's question — is every identifier in the result actually bound?
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
const REWRITE_SITES = 4;

/** `[rule, importLine, callExpression]` — a source is synthesized per row. */
const MULTI_SITE_REWRITES: Array<[string, string, string]> = [
  [RULE.join, namedImport('join', 'node:path'), 'join(a, b)'],
  [RULE.resolve, namedImport('resolve', 'node:path'), 'resolve(a, b)'],
  [RULE.relative, namedImport('relative', 'node:path'), 'relative(a, b)'],
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

describe('autofix leaves no dangling reference', () => {
  const plugin = loadLocalRuleModule<{ rules: Record<string, Rule.RuleModule> }>('../index.cjs');
  const languageOptions = { ecmaVersion: 2024, sourceType: 'module' } as const;

  /** Bindings, not strings: `no-undef` answers the question `tsc` would. */
  const unboundIn = (code: string): string[] =>
    new Linter()
      .verify(code, [{ files: ['**/*.ts'], rules: { 'no-undef': 'error' }, languageOptions }], {
        filename: LINTED_FILE,
      })
      .map(({ message }) => message);

  it('covers every fixable rule in the pack', () => {
    // Membership, not cardinality — a rule added to the pack without a row here
    // is a rule whose fixer nobody runs to a fixpoint.
    const byName = (a: string, b: string): number => a.localeCompare(b);
    // `!= null`, NOT `=== 'code'`. ESLint accepts `fixable: 'whitespace'` for a
    // rule that rewrites callees and inserts imports — verified by running one —
    // so keying on `'code'` leaves a rule that is fully fixable, absent from
    // this list, and absent from MULTI_SITE_REWRITES. `toStrictEqual` passes on
    // two matching omissions, which is the shape of a gate that measures
    // nothing. (Omitting `fixable` entirely is NOT a hole: ESLint throws.)
    const fixable = Object.entries(plugin.rules)
      .filter(([, rule]) => rule.meta?.fixable != null)
      .map(([name]) => name);
    expect(MULTI_SITE_REWRITES.map(([name]) => name).sort(byName)).toStrictEqual(
      [...fixable].sort(byName),
    );
  });

  /**
   * A dangling MEMBER, which the `no-undef` check above is blind to.
   *
   * `no-os-tmpdir` is the one rule with `checkMemberExpression`, and its fixer
   * rewrote only the property — turning `os.tmpdir()` into
   * `os.normalizedTmpdir()`, a method that does not exist on the `node:os`
   * namespace. The replacement is a free function from this package, and the
   * fixer imported it correctly; it just left the call reaching for it through
   * the wrong object.
   *
   * Same silent shape as the overlap defect: the rule stops reporting (there is
   * no `tmpdir` left to see), so lint goes green over code that throws
   * `TypeError` at every fixed call site. `no-undef` sees a bound `os` and a
   * property access and has nothing to say. Only `tsc` catches it — which is
   * why an adopter's dangling-REFERENCE audit across all nine rewritable
   * symbols came back clean on this rule.
   */
  it('no-os-tmpdir rewrites os.tmpdir() to a free call, not a method on the namespace', () => {
    const config = [
      {
        files: ['**/*.ts'],
        plugins: { local: { rules: { 'no-os-tmpdir': plugin.rules['no-os-tmpdir'] as Rule.RuleModule } } },
        rules: { 'local/no-os-tmpdir': 'error' as const },
        languageOptions,
      },
    ];
    const source = "import os from 'node:os';\nconst t0 = os.tmpdir();\nconst t1 = os.tmpdir();";

    expect(new Linter().verify(source, config, { filename: LINTED_FILE })).toHaveLength(2);

    const { output } = new Linter().verifyAndFix(source, config, { filename: LINTED_FILE });
    expect(output).not.toMatch(/\bos\s*\.\s*normalizedTmpdir\b/);
    expect(output.match(/(?<![.\w])normalizedTmpdir\(\)/g)).toHaveLength(2);
    expect(new Linter().verify(output, config, { filename: LINTED_FILE })).toStrictEqual([]);
  });

  it.each(MULTI_SITE_REWRITES)('%s', (name, importLine, call) => {
    const source = multiSiteSource(importLine, call);
    const config = [
      {
        files: ['**/*.ts'],
        plugins: { local: { rules: { [name]: plugin.rules[name] as Rule.RuleModule } } },
        rules: { [`local/${name}`]: 'error' as const },
        languageOptions,
      },
    ];

    // Negative control: a source that stopped provoking the rule would make
    // every assertion below vacuously true.
    const before = new Linter().verify(source, config, { filename: LINTED_FILE });
    expect(before).toHaveLength(REWRITE_SITES);
    expect(unboundIn(source)).toStrictEqual([]);

    const { output, fixed } = new Linter().verifyAndFix(source, config, { filename: LINTED_FILE });
    expect(fixed).toBe(true);

    // The defect, stated exactly: `--fix` settles, reports nothing further, and
    // the code it settled on references an identifier that is no longer bound.
    expect(unboundIn(output)).toStrictEqual([]);
    expect(new Linter().verify(output, config, { filename: LINTED_FILE })).toStrictEqual([]);
  });
});

/**
 * `prefer-startswith-over-regex` emits SOURCE, so its message IS the deliverable.
 *
 * The rule has no fixer: nothing downstream re-escapes what it prints, and a
 * developer applies the advice by hand. So the literal it names must (a) parse
 * as a JS string and (b) denote exactly the characters the regex matches.
 * Neither held, and no fixture covered either.
 */
const PREFIX_ADVICE = /startsWith\((.*)\)` over/;
const SUFFIX_ADVICE = /endsWith\((.*)\)` over/;

/** The literal the message tells a developer to write, decoded as JS would. */
function advisedLiteral(message: string | undefined): string {
  const text = message ?? '';
  const match = PREFIX_ADVICE.exec(text) ?? SUFFIX_ADVICE.exec(text);
  if (!match?.[1]) {
    throw new Error(`no advice found in: ${text}`);
  }
  // `JSON.parse` accepts exactly the escapes a JS string literal does for the
  // shapes this rule emits — and THROWS on the un-escaped text it used to
  // produce, which is the point.
  return JSON.parse(match[1]) as string;
}

describe('prefer-startswith-over-regex advice is valid, faithful JavaScript', () => {
  const rule = loadLocalRule('prefer-startswith-over-regex.cjs');
  const lint = (code: string): string[] =>
    new Linter()
      .verify(
        code,
        [
          {
            files: ['**/*.ts'],
            plugins: { local: { rules: { r: rule } } },
            rules: { 'local/r': 'error' },
            languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
          },
        ],
        { filename: LINTED_FILE },
      )
      .map(({ message }) => message);

  /**
   * `[source, the characters the regex actually matches]`.
   *
   * Every row turns on a backslash or a quote — the two things that mean one
   * thing to a regex and another to a JS string literal. `/^C:\\Users/` matches
   * `C:\Users`; the rule printed `startsWith('C:\Users')`, which JavaScript
   * reads back as `"C:Users"`. The UNC row is the one that bites in production:
   * `startsWith('\\')` is ONE backslash, so a `\\`-prefix check silently
   * becomes true for every single-backslash path.
   */
  const FAITHFUL_ADVICE: Array<[string, string]> = [
    [String.raw`/^C:\\Users/`, String.raw`C:\Users`],
    [String.raw`/^\\\\/`, '\\\\'],
    [String.raw`/^a\\nb/`, String.raw`a\nb`],
    [String.raw`/^a\\x41/`, String.raw`a\x41`],
    [String.raw`/\\nb$/`, String.raw`\nb`],
    ["/^don't/", "don't"],
    [String.raw`/^don\'t/`, "don't"],
    [String.raw`/^\*glob/`, '*glob'],
    [String.raw`/^file:\/\//`, 'file://'],
  ];

  it.each(FAITHFUL_ADVICE)('%s advises the exact characters it matches', (source, expected) => {
    const messages = lint(`export const f = (s) => ${source}.test(s);`);
    expect(messages).toHaveLength(1);
    // Parses as JS…
    const advised = advisedLiteral(messages[0]);
    // …and denotes the same characters the regex does.
    expect(advised).toBe(expected);
  });

  it.each(FAITHFUL_ADVICE)('%s advice agrees with the regex on real strings', (source, expected) => {
    // `source` is a fixture literal declared in FAITHFUL_ADVICE above; rebuilding it here is what
    // lets one row drive both the lint fixture and the semantics check, so the two cannot drift
    // apart. (The directive must sit on the line immediately before the call — a run of `//`
    // comments is a run of separate comments, so a directive above them targets only the next
    // comment line and is silently unused.)
    // eslint-disable-next-line security/detect-non-literal-regexp -- fixture literal, never input
    const regex = new RegExp(source.slice(1, source.lastIndexOf('/')));
    const atStart = regex.source.startsWith('^');
    const probes = [expected, `${expected}TAIL`, `HEAD${expected}`, expected.slice(1), '', 'unrelated'];
    for (const probe of probes) {
      const viaAdvice = atStart ? probe.startsWith(expected) : probe.endsWith(expected);
      expect({ probe, matched: regex.test(probe) }).toStrictEqual({ probe, matched: viaAdvice });
    }
  });

  /**
   * `g`/`y` make `.test()` stateful through `lastIndex`. A regex LITERAL is
   * rebuilt on every evaluation so its cursor is always 0; a hoisted `const` is
   * one object that remembers. Resolving through a binding is therefore exactly
   * what makes the advice wrong — and exactly what this rule newly does.
   */
  it.each(['g', 'y', 'gy'])('stays silent on a const-held regex with the %s flag', (flags) => {
    expect(lint(`const RE = /^abc/${flags};\nexport const f = (s) => RE.test(s);`)).toStrictEqual([]);
  });

  it('demonstrates the divergence the g-flag guard prevents', () => {
    const held = /^abc/g;
    expect([1, 2, 3, 4].map(() => held.test('abcdef'))).toStrictEqual([true, false, true, false]);
    expect([1, 2, 3, 4].map(() => 'abcdef'.startsWith('abc'))).toStrictEqual([true, true, true, true]);
  });

  it('still fires on an INLINE regex with g — the literal is rebuilt, so lastIndex is always 0', () => {
    expect(lint('export const f = (s) => /^abc/g.test(s);')).toHaveLength(1);
    // The regex literal below is the SUBJECT, not a style slip. `--fix` rewrote
    // it to `'abcdef'.startsWith('abc')` — via this very rule and unicorn's —
    // which left the assertion comparing `startsWith` to `startsWith` and
    // passing vacuously. Exactly the class of defect this file exists to catch,
    // committed against the file itself.
    /* eslint-disable local/prefer-startswith-over-regex, unicorn/prefer-string-starts-ends-with -- the inline literal IS the assertion */
    expect([1, 2, 3, 4].map(() => /^abc/g.test('abcdef'))).toStrictEqual([true, true, true, true]);
    /* eslint-enable local/prefer-startswith-over-regex, unicorn/prefer-string-starts-ends-with */
  });

  it('renders the flags, so a reader can see what the advice rests on', () => {
    expect(lint('export const f = (s) => /^abc/s.test(s);')[0]).toContain('/^abc/s.test(');
  });

  it('needs exactly one argument', () => {
    expect(lint('export const f = () => /^abc/.test();')).toStrictEqual([]);
    expect(lint('export const f = (s) => /^abc/.test(s, 1);')).toStrictEqual([]);
  });

  /**
   * MEMBERSHIP of the bail class, pinned character by character.
   *
   * An adversarial run dropped 12 of the 22 characters and this suite stayed
   * green — only 7 were named by any fixture. Under that mutant `/^\sfoo/`
   * advised `startsWith('sfoo')`. Both directions are asserted here, so neither
   * a narrowing nor a widening can pass unremarked.
   */
  const MEANINGFUL = [...'0123456789BDPSWbcdfknprstuvwx'];
  const IDENTITY = [...'AaEeGgHhIiJjLlMmOoQqRrTtYyZz'].filter((char) => !MEANINGFUL.includes(char));

  it.each(MEANINGFUL)(String.raw`\%s means something other than the character, so it bails`, (char) => {
    expect(lint(`export const f = (s) => /^\\${char}tail/.test(s);`)).toStrictEqual([]);
  });

  it.each(IDENTITY)(String.raw`\%s is an identity escape, so it flattens`, (char) => {
    const messages = lint(`export const f = (s) => /^\\${char}tail/.test(s);`);
    expect(messages).toHaveLength(1);
    expect(advisedLiteral(messages[0])).toBe(`${char}tail`);
  });
});

/**
 * A SUPPRESSED report still consumes the once-per-file import edit.
 *
 * ESLint runs a rule's `fix()` before the `eslint-disable` filter discards the
 * problem, so `buildFix`'s "emit the shared edits once" guard is spent by a
 * report that is then thrown away. Every other call site is rewritten to
 * `safePath.join(...)`, nothing imports `safePath`, and — until the repair leg
 * existed — no report survived to carry the import on any later pass.
 *
 * An adversarial run measured that as a STABLE fixpoint: `--fix` twice more
 * changed nothing, lint reported zero problems, and the file did not compile.
 * The docstring at the time claimed the state was transient. It was not. This
 * test is the claim, executed rather than asserted.
 */
describe('a suppressed first report does not strand the file', () => {
  const languageOptions = { ecmaVersion: 2024, sourceType: 'module' } as const;
  const config = (name: string) => [
    {
      files: ['**/*.ts'],
      plugins: {
        local: {
          rules: { [name]: loadLocalRule(`${name}.cjs`) },
        },
      },
      rules: { [`local/${name}`]: 'error' as const },
      languageOptions,
    },
  ];

  /**
   * The rule must still be DEFINED here even though it is switched off — an
   * `eslint-disable` naming a rule the config does not know reports "Definition
   * for rule … was not found", and that lands in the same message list as the
   * `no-undef` findings this is reading. The first draft of this helper omitted
   * it and produced a failure that looked exactly like a dangling identifier.
   */
  const unboundIn = (name: string, code: string): string[] =>
    new Linter()
      .verify(
        code,
        [
          {
            files: ['**/*.ts'],
            plugins: { local: { rules: { [name]: loadLocalRule(`${name}.cjs`) } } },
            rules: { 'no-undef': 'error', [`local/${name}`]: 'off' },
            // With the rule switched off its disable directive becomes
            // "unused", and ESLint 9 warns about that by default — into the
            // same message list this is reading for dangling identifiers.
            linterOptions: { reportUnusedDisableDirectives: 'off' },
            languageOptions,
          },
        ],
        { filename: LINTED_FILE },
      )
      .map(({ message }) => message);

  it.each([
    [RULE.join, 'join'],
    [RULE.resolve, 'resolve'],
    [RULE.relative, 'relative'],
  ])('%s converges to compiling source with the first call site disabled', (name, fn) => {
    const source = [
      `import { ${fn} } from 'node:path';`,
      `// eslint-disable-next-line local/${name}`,
      `export const a = ${fn}('1', '2');`,
      `export const b = ${fn}('3', '4');`,
      `export const c = ${fn}('5', '6');`,
    ].join('\n');
    const cfg = config(name);

    // Negative control: the disable really does suppress one of four reports.
    expect(new Linter().verify(source, cfg, { filename: LINTED_FILE })).toHaveLength(2);
    expect(unboundIn(name, source)).toStrictEqual([]);

    const { output } = new Linter().verifyAndFix(source, cfg, { filename: LINTED_FILE });

    // The whole point: no dangling `safePath`, and no dangling `join`.
    expect(unboundIn(name, output)).toStrictEqual([]);
    // The suppressed call is left ALONE — it still reads `join(...)`, which is
    // why the `node:path` specifier must survive alongside it.
    expect(output).toContain(`export const a = ${fn}('1', '2');`);
    expect(output).toContain(`import { ${fn} } from 'node:path';`);
    expect(output).toContain(`export const b = safePath.${fn}('3', '4');`);
  });

  it('recovers a file that a partial fix already stranded', () => {
    // Exactly the broken output the old code produced and then declared clean.
    const stranded = [
      "import { join } from 'node:path';",
      "export const a = join('1', '2');",
      "export const b = safePath.join('3', '4');",
    ].join('\n');
    const cfg = config(RULE.join);

    expect(unboundIn(RULE.join, stranded)).toStrictEqual(["'safePath' is not defined."]);

    const { output } = new Linter().verifyAndFix(stranded, cfg, { filename: LINTED_FILE });
    expect(unboundIn(RULE.join, output)).toStrictEqual([]);
    expect(new Linter().verify(output, cfg, { filename: LINTED_FILE })).toStrictEqual([]);
  });
});

/**
 * `safePath` being bound is a fact about the FILE, not about this function.
 *
 * The bare-call repair leg finishes a file a partial `--fix` left half-migrated,
 * and its gate used to be "`unsafeFn` is unbound in scope AND `safePath` is bound
 * somewhere in the source". Neither half is specific to `unsafeFn`, and the
 * second is supplied for free by a SIBLING rule: `no-path-resolve` rewrites a
 * `path.resolve(...)` and imports `safePath`, so on the next `--fix` pass
 * `no-path-join` sees a file with `safePath` bound and a bare, unbound
 * `join(...)` — which, as the factory's own comment conceded, is not reliably our
 * `join`. ESLint scope analysis cannot see a `declare global`, a `globals.d.ts`,
 * an `@types` package, or a bundler-injected global.
 *
 * Measured before the fix, with both rules enabled over the source below: the
 * ambient `join('hello', 'world')` came back as `safePath.join('hello', 'world')`
 * — a published autofixer silently redirecting a call to a different function.
 *
 * The gate is now positive evidence that THIS function is mid-migration in THIS
 * file. Every real strand carries that evidence: the specifier removal ships in
 * the same all-or-nothing merged fix as the callee rewrite that produced it, so a
 * file cannot lose its `node:path` specifier without gaining a
 * `safePath.<fn>(...)` call. The second case below is that claim, executed.
 */
describe('a sibling rule binding safePath does not arm the repair leg', () => {
  const languageOptions = { ecmaVersion: 2024, sourceType: 'module' } as const;
  const pathRules = {
    [RULE.join]: loadLocalRule(`${RULE.join}.cjs`),
    [RULE.resolve]: loadLocalRule(`${RULE.resolve}.cjs`),
  };
  const cfgFor = (enabled: string[]): Linter.Config[] => [
    {
      files: ['**/*.ts'],
      plugins: { local: { rules: pathRules } },
      rules: Object.fromEntries(enabled.map((id) => [`local/${id}`, 'error'])),
      languageOptions,
    },
  ];

  /** An ambient global from a `globals.d.ts` this linter cannot see. */
  const AMBIENT = "export const banner = join('hello', 'world');";

  it('leaves an unrelated ambient global alone while the sibling migrates', () => {
    const source = [PATH_NAMESPACE_IMPORT, AMBIENT, 'export const p = path.resolve(a, b);'].join('\n');
    const cfg = cfgFor([RULE.join, RULE.resolve]);

    // Negative control: on the source as written only the SIBLING reports. The
    // hazard is reachable only across passes, once its fix has bound safePath.
    expect(
      new Linter().verify(source, cfg, { filename: LINTED_FILE }).map(({ ruleId }) => ruleId),
    ).toStrictEqual([`local/${RULE.resolve}`]);

    const { output } = new Linter().verifyAndFix(source, cfg, { filename: LINTED_FILE });

    // The sibling really did migrate — without this, the assertions below would
    // pass just as happily on a file nothing ever touched.
    expect(output).toContain('safePath.resolve(a, b)');
    expect(output).toContain(AMBIENT);
    expect(output).not.toContain('safePath.join(');
  });

  it("still finishes what an editor's single-fix left half-migrated", () => {
    const source = [
      namedImport('join', 'node:path'),
      "export const a = join('1', '2');",
      "export const b = join('3', '4');",
    ].join('\n');
    const cfg = cfgFor([RULE.join]);

    // An editor's "fix this problem" applies ONE report's fix. The first
    // report's is the self-sufficient one — it rewrites its own callee, inserts
    // the `safePath` import AND removes the `node:path` specifier — which strands
    // every other call site as a bare, unbound `join(...)`.
    const fix = new Linter().verify(source, cfg, { filename: LINTED_FILE })[0]?.fix;
    if (!fix) {
      throw new Error('the first report carries no fix; this fixture no longer builds a strand');
    }
    const stranded = source.slice(0, fix.range[0]) + fix.text + source.slice(fix.range[1]);
    // The strand, and the evidence that comes with it, spelled out rather than
    // assumed: no `node:path` left, a bare `join`, and a migrated sibling call.
    expect(stranded).not.toContain("from 'node:path'");
    expect(stranded).toContain("export const b = join('3', '4');");
    expect(stranded).toContain("export const a = safePath.join('1', '2');");

    const { output } = new Linter().verifyAndFix(stranded, cfg, { filename: LINTED_FILE });
    expect(output).toContain("export const b = safePath.join('3', '4');");
    expect(new Linter().verify(output, cfg, { filename: LINTED_FILE })).toStrictEqual([]);
  });
});

/**
 * The same suppression hazard, across every OTHER import-inserting rule.
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
  const languageOptions = { ecmaVersion: 2024, sourceType: 'module' } as const;

  it.each(SUPPRESSION_CASES)('%s', (name, importLine, call) => {
    const rule = loadLocalRule(`${name}.cjs`);
    const source = [
      importLine,
      `// eslint-disable-next-line local/${name}`,
      `export const a = ${call};`,
      `export const b = ${call};`,
      `export const c = ${call};`,
    ]
      .filter(Boolean)
      .join('\n');

    const base = { files: ['**/*.ts'], plugins: { local: { rules: { [name]: rule } } }, languageOptions };
    const cfg = [{ ...base, rules: { [`local/${name}`]: 'error' as const } }];
    const undefCfg = [
      {
        ...base,
        rules: { 'no-undef': 'error' as const, [`local/${name}`]: 'off' as const },
        linterOptions: { reportUnusedDisableDirectives: 'off' as const },
      },
    ];
    const unbound = (code: string): string[] =>
      new Linter().verify(code, undefCfg, { filename: LINTED_FILE }).map(({ message }) => message);

    // Negative control: one of three reports really is suppressed.
    expect(new Linter().verify(source, cfg, { filename: LINTED_FILE })).toHaveLength(2);
    expect(unbound(source)).toStrictEqual([]);

    const { output } = new Linter().verifyAndFix(source, cfg, { filename: LINTED_FILE });
    expect(unbound(output)).toStrictEqual([]);
    // The suppressed call is untouched, so whatever it needs must survive.
    expect(output).toContain(`export const a = ${call};`);
  });
});

/**
 * The binding the fixer itself orphaned, and the binding forms it can see.
 *
 * Both suites below close gaps an adopter measured on the rc.2 tarball, over
 * 4,963 tracked source files. They share one config helper because the two are
 * the same rule invocation seen from two ends: what the fixer LEAVES BEHIND, and
 * what it can RECOGNISE in the first place.
 */
describe('bindings the fixer consumes and the bindings it can see', () => {
  const languageOptions = { ecmaVersion: 2024, sourceType: 'module' } as const;

  const configFor = (name: string, options?: object) => [
    {
      files: ['**/*.ts'],
      plugins: { local: { rules: { [name]: loadLocalRule(`${name}.cjs`) } } },
      rules: { [`local/${name}`]: (options ? ['error', options] : 'error') as 'error' },
      languageOptions,
    },
  ];

  const lint = (name: string, code: string): Linter.LintMessage[] =>
    new Linter().verify(code, configFor(name), { filename: LINTED_FILE });

  const fix = (name: string, code: string): string =>
    new Linter().verifyAndFix(code, configFor(name), { filename: LINTED_FILE }).output;

  /**
   * The adopter's gate, restated as an assertion.
   *
   * Their repo lints at `--max-warnings=0`. After `--fix` converged over ~5,100
   * sites, **536 errors survived across 232 files** — every one of them the same
   * class, the now-unused `node:path` binding, split 289 `no-unused-vars` /
   * 247 `sonarjs/unused-import`. So the fixed output did not lint clean, and the
   * migration was not complete. Core `no-unused-vars` is the same question in
   * one rule, and it is the only assertion here that would have caught it: the
   * `no-undef` fixpoint check above is blind, because a dead import leaves
   * nothing DANGLING — it leaves something SPARE.
   *
   * Neither ecosystem rule can fix this for us: `@typescript-eslint/no-unused-vars`
   * declares `meta.fixable: 'code'` and yet emits only a SUGGESTION for an unused
   * import, and `--fix` never applies suggestions. Verified with both rules
   * enabled in a single `verifyAndFix`; the import survived.
   */
  const unusedIn = (code: string): string[] =>
    new Linter()
      .verify(code, [{ files: ['**/*.ts'], rules: { 'no-unused-vars': 'error' }, languageOptions }], {
        filename: LINTED_FILE,
      })
      .map(({ message }) => message);

  const DEFAULT_IMPORT = 'default import';
  const NAMESPACE_IMPORT = 'namespace import';

  describe('--fix removes the import binding it just orphaned', () => {
    /** `[rule, label, source]` — every source is fully migrated by one pass. */
    const DEAD_AFTER_FIX: Array<[string, string, string]> = [
      [RULE.join, DEFAULT_IMPORT, `${PATH_NAMESPACE_IMPORT}\nexport const p = path.join('a', 'b');`],
      [RULE.join, NAMESPACE_IMPORT, "import * as path from 'node:path';\nexport const p = path.join('a', 'b');"],
      [RULE.resolve, DEFAULT_IMPORT, `${PATH_NAMESPACE_IMPORT}\nexport const p = path.resolve('a', 'b');`],
      [RULE.relative, DEFAULT_IMPORT, `${PATH_NAMESPACE_IMPORT}\nexport const p = path.relative('a', 'b');`],
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
      // Negative controls: the source must provoke the rule, and must not
      // already be carrying the very finding this test looks for afterwards.
      expect(lint(name, source).length).toBeGreaterThan(0);
      expect(unusedIn(source)).toStrictEqual([]);

      const output = fix(name, source);

      expect(unusedIn(output)).toStrictEqual([]);
      expect(output).not.toMatch(/from 'node:(path|os)'/);
      // …and the fixpoint still holds: nothing left to report.
      expect(lint(name, output)).toStrictEqual([]);
    });

    /**
     * `[rule, label, source]` — every source ends the pass with a `node:*`
     * import that must SURVIVE. Each row disables a different guard.
     */
    const IMPORT_MUST_SURVIVE: Array<[string, string, string]> = [
      // Only the all-members-migrated case is dead. This is the case the
      // adopter confirmed already worked, kept here so a wider "just delete it"
      // cannot pass.
      [
        RULE.join,
        'another member still uses the binding',
        `${PATH_NAMESPACE_IMPORT}\nexport const p = path.join('a', 'b');\nexport const d = path.dirname(p);`,
      ],
      // A bare side-effect import declares no bindings, so "every binding is
      // dead" is vacuously true. Deleting it is an edit nobody asked for, and
      // `node:path`'s freedom from side effects is not the point — the author's
      // intent is unreadable.
      [RULE.join, 'bare side-effect import', `import 'node:path';\n${SAFE_IMPORT}\nexport const p = safePath.join('a', 'b');`],
      // EVERY binding must be dead, not merely one of them. A single-specifier
      // fixture cannot tell `every` from `some` — both answer the same for one
      // variable — so the declaration here has to carry two.
      [
        RULE.join,
        'a second specifier on the same declaration is still live',
        "import path, { sep } from 'node:path';\nexport const p = path.join('a', 'b');\nexport const s = sep;",
      ],
      // The gate that keeps this a REPAIR leg rather than a general
      // unused-import rule: with nothing from the safe module in scope, this
      // fixer never ran here, so the dead import is somebody else's business.
      [RULE.join, 'file was never migrated', `${PATH_NAMESPACE_IMPORT}\nexport const x = 1;`],
      // …and "the safe symbol is bound" is NOT on its own evidence that THIS
      // rule migrated anything. `safePath` reaches scope for plenty of reasons
      // that have nothing to do with a `path.join()` this fixer consumed, and a
      // `node:path` import that was ALREADY dead before the pack ever ran is not
      // something this rule orphaned. Reporting it as one is a false causal
      // claim, and removing it is precisely the general unused-import rule the
      // module docstring declines to be.
      [
        RULE.join,
        'the safe symbol is bound but nothing in the file calls it',
        `${SAFE_IMPORT}\n${PATH_NAMESPACE_IMPORT}\nexport const x = safePath;`,
      ],
      // The same gap one step subtler: the file really was migrated, but by a
      // SIBLING rule. `no-path-join` rewrote nothing here, so whatever happened
      // to this import is not its finding to make. Declining strands nothing —
      // the rule that DID the rewrite still reaches the same declaration, which
      // the single-member convergence test below pins with the whole pack on.
      [
        RULE.join,
        'only a sibling rule replacement is in use',
        `${SAFE_IMPORT}\n${PATH_NAMESPACE_IMPORT}\nexport const p = safePath.resolve('a', 'b');`,
      ],
    ];

    it.each(IMPORT_MUST_SURVIVE)('%s keeps the import when %s', (name, _label, source) => {
      const output = fix(name, source);
      expect(output).toContain(QUOTED_NODE_PATH);
      expect(lint(name, output)).toStrictEqual([]);
    });

    /**
     * The same gate, through the other two callers of the shared helper.
     *
     * `dead-import.cjs` is reached from three factories, and a gate living in
     * the helper is only as good as the evidence each caller computes for it.
     * The three spell "did I rewrite anything here?" three different ways —
     * `safePath.join(…)` is a member call, `normalizedTmpdir()` a free one, and
     * `toForwardSlash(…)` belongs to a rule that never tracked the path import
     * at all — so a table covering only the path factory would leave two of the
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
      expect(lint(name, source)).toStrictEqual([]);
      expect(fix(name, source)).toContain(`'${module}'`);
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
      const config = [
        {
          files: ['**/*.ts'],
          plugins: { local: { rules: { [RULE.join]: loadLocalRule(`${RULE.join}.cjs`) } } },
          rules: { [`local/${RULE.join}`]: 'error' as const },
          languageOptions: { parser: tsParser },
        },
      ];
      const { output } = new Linter().verifyAndFix(source, config, { filename: LINTED_FILE });
      expect(output).toContain(typeImport);
    });
  });

  /**
   * How the unsafe namespace got bound.
   *
   * rc.1 matched ANY receiver, so it "detected" these shapes only as a side
   * effect of the defect that also produced `os.normalizedTmpdir()` — and it
   * reported `const os = { tmpdir(){} }` and `env.tmpdir()` as findings it would
   * have rewritten into a call on the wrong function. rc.2 checks the receiver
   * and correctly rejects both, but only recognised a static `import`. Whole-
   * callee replacement is safe however the binding was made, so the two other
   * binding forms belong in the same set — and the false positives must stay
   * rejected, which is what the negative rows below pin.
   */
  describe('a namespace bound by require() or a dynamic import is still a namespace', () => {
    const DYNAMIC = "export async function f() {\n  const os = await import('node:os');\n  return os.tmpdir();\n}";
    const REQUIRED = "const os = require('node:os');\nexport function f() { return os.tmpdir(); }";

    it.each([
      ['await import()', DYNAMIC],
      ['require()', REQUIRED],
    ])('%s is reported and rewritten to a free call', (_label, source) => {
      expect(lint(RULE.tmpdir, source)).toHaveLength(1);

      const output = fix(RULE.tmpdir, source);
      // The defect the receiver check exists to prevent: a member call on a
      // namespace that has no such member. It compiles and it throws.
      expect(output).not.toMatch(/\bos\s*\.\s*normalizedTmpdir\b/);
      expect(output).toMatch(/(?<![.\w])normalizedTmpdir\(\)/);
      expect(lint(RULE.tmpdir, output)).toStrictEqual([]);
    });

    it.each([
      ['an unrelated object literal', "const os = { tmpdir: () => '/t' };\nexport function f() { return os.tmpdir(); }"],
      ['the same method on another receiver', "const env = { tmpdir: () => '/t' };\nexport function f() { return env.tmpdir(); }"],
      [
        'a dynamic import of a different module',
        "export async function f() {\n  const os = await import('node:util');\n  return os.tmpdir();\n}",
      ],
      ['a require() of a different module', "const os = require('node:util');\nexport function f() { return os.tmpdir(); }"],
      // Not every one-argument call that is handed a module name IS `require`.
      // Without the callee-name check this reports, and the fix would rewrite a
      // call on somebody else's object into a free function.
      ['a call that merely looks like require()', "const os = notRequire('node:os');\nexport function f() { return os.tmpdir(); }"],
    ])('%s is not a finding', (_label, source) => {
      expect(lint(RULE.tmpdir, source)).toStrictEqual([]);
    });
  });

  /**
   * The gate stays readable from the SOURCE, never from a flag `fix()` can flip.
   *
   * ESLint runs a rule's `fix()` for a suppressed problem BEFORE the
   * `eslint-disable` filter discards it. So any mutable "have I added the safe
   * import?" flag is already `true` — and lying — by the time `Program:exit`
   * runs, and a dead-import leg reading it would delete an import in a file
   * nothing was actually migrated in. Both factories therefore snapshot the
   * answer at `create()` time; these are the fixtures that tell the two apart.
   *
   * Two imports of the same module, deliberately. The suppressed call keeps its
   * OWN binding referenced, so a single-import file cannot express the state
   * this guards — a live report whose `fix()` flips the flag, and a dead binding
   * sitting beside it in the same pass. The second (unused) import supplies it.
   */
  it.each([
    [
      RULE.join,
      [
        "import legacy from 'path';",
        PATH_NAMESPACE_IMPORT,
        `// eslint-disable-next-line local/${RULE.join}`,
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
    // The rule's only report is suppressed, so nothing at all is left — in
    // particular not a `deadUnsafeImport` that the discarded report enabled.
    expect(lint(name, source)).toStrictEqual([]);
    expect(fix(name, source)).toBe(source);
  });

  /**
   * The configuration an adopter actually runs: the whole pack at once.
   *
   * Every rule above is tested in isolation, and isolation is precisely where
   * this cannot go wrong. Three rules migrating three members of ONE import all
   * reach the same dead declaration on the same pass and all emit a removal over
   * the same range — so the question is whether ESLint's overlap handling
   * converges or starves, and no single-rule fixture asks it.
   */
  /**
   * The same pack, on a file that exercises only ONE of its members.
   *
   * The two rules with nothing to rewrite here must not report the import —
   * they orphaned nothing — and the one that did must still remove it. Run the
   * rules in isolation and this cannot fail either way; only the whole pack on
   * one file asks whether a per-rule gate strands the declaration that no rule
   * claims, which is the failure mode of narrowing the dead-import leg at all.
   */
  it('a rule that rewrote nothing leaves the removal to the one that did', () => {
    const source = [PATH_NAMESPACE_IMPORT, "export const b = path.resolve('c');"].join('\n');
    const names = [RULE.join, RULE.resolve, RULE.relative];
    const config = [
      {
        files: ['**/*.ts'],
        plugins: {
          local: { rules: Object.fromEntries(names.map((name) => [name, loadLocalRule(`${name}.cjs`)])) },
        },
        rules: Object.fromEntries(names.map((name) => [`local/${name}`, 'error' as const])),
        languageOptions,
      },
    ];

    // Negative control: exactly one rule has anything to say about this file.
    expect(new Linter().verify(source, config, { filename: LINTED_FILE })).toHaveLength(1);

    const { output } = new Linter().verifyAndFix(source, config, { filename: LINTED_FILE });

    expect(new Linter().verify(output, config, { filename: LINTED_FILE })).toStrictEqual([]);
    expect(unusedIn(output)).toStrictEqual([]);
    expect(output).not.toContain(QUOTED_NODE_PATH);
    expect(output).toContain('safePath.resolve(');
  });

  it('the three safePath rules together converge on one import in a single pass', () => {
    const source = [
      PATH_NAMESPACE_IMPORT,
      "export const a = path.join('a', 'b');",
      "export const b = path.resolve('c');",
      "export const c = path.relative('d', 'e');",
    ].join('\n');
    const names = [RULE.join, RULE.resolve, RULE.relative];
    const config = [
      {
        files: ['**/*.ts'],
        plugins: {
          local: { rules: Object.fromEntries(names.map((name) => [name, loadLocalRule(`${name}.cjs`)])) },
        },
        rules: Object.fromEntries(names.map((name) => [`local/${name}`, 'error' as const])),
        languageOptions,
      },
    ];

    expect(new Linter().verify(source, config, { filename: LINTED_FILE })).toHaveLength(names.length);

    const { output } = new Linter().verifyAndFix(source, config, { filename: LINTED_FILE });

    expect(new Linter().verify(output, config, { filename: LINTED_FILE })).toStrictEqual([]);
    expect(unusedIn(output)).toStrictEqual([]);
    expect(output).not.toContain(QUOTED_NODE_PATH);
    for (const fn of ['join', 'resolve', 'relative']) {
      expect(output).toContain(`safePath.${fn}(`);
    }
  });
});

/**
 * The shared dead-import helper, exercised directly on its own module list.
 *
 * Every rule wired to it today pre-filters to its own module before handing a
 * declaration over, so the allow-list inside the helper is unreachable through
 * any of them — and an untested unreachable guard is exactly the one a future
 * rule discovers the hard way. This calls the helper with declarations the
 * production callers never pass it.
 */
describe('reportDeadUnsafeImports only ever removes a listed module', () => {
  const { reportDeadUnsafeImports } = loadLocalRuleModule<{
    reportDeadUnsafeImports: (
      context: unknown,
      sourceCode: unknown,
      importNodes: unknown[],
      safeBoundInSource: boolean,
      replacementCalled: boolean,
    ) => void;
  }>('dead-import.cjs');

  /** Hands the helper EVERY import declaration in the file, unfiltered. */
  const unfilteredRule = {
    meta: {
      type: 'problem' as const,
      fixable: 'code' as const,
      schema: [],
      messages: {
        deadUnsafeImport: "'{{local}}' from '{{module}}'",
      },
    },
    create(context: Rule.RuleContext): Rule.RuleListener {
      const { sourceCode } = context;
      return {
        'Program:exit'() {
          reportDeadUnsafeImports(
            context,
            sourceCode,
            sourceCode.ast.body.filter((node) => node.type === 'ImportDeclaration'),
            true,
            true,
          );
        },
      };
    },
  };

  const removedFrom = (code: string): string =>
    new Linter().verifyAndFix(
      code,
      [
        {
          files: ['**/*.ts'],
          plugins: { local: { rules: { r: unfilteredRule as Rule.RuleModule } } },
          rules: { 'local/r': 'error' },
          languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
        },
      ],
      { filename: LINTED_FILE },
    ).output;

  it.each([
    ['node:path', true],
    ['path', true],
    ['node:child_process', true],
    // Side-effect-free-ness is decided at authoring time for a CLOSED list, and
    // these are not on it. A builtin nobody wired up is still not ours to delete,
    // and a userland module may run anything at import time.
    ['node:crypto', false],
    ['react', false],
    ['./local-module.js', false],
  ])('%s removable=%s', (module, removable) => {
    const source = `import dead from '${module}';\nexport const x = 1;`;
    expect(removedFrom(source).includes(`'${module}'`)).toBe(!removable);
  });
});

/**
 * `no-self-package-import` is told which package it is inside, via a required
 * `packageName` option — it reads no files, because every module on the `./eslint`
 * subpath must require nothing at all (`subpath-purity.test.ts`). That also makes
 * these cases independent of the working directory the suite runs from.
 *
 * The load-bearing case is `selfImportOfTheShippedDefect`: the exact import that
 * reddened CI on both ubuntu and windows at `0e8b74f9`. A guard nobody has
 * watched fire on the real defect is an assumption, not a guard.
 *
 * The other one worth naming is the `rag` / `rag-lancedb` leg. Matching a
 * self-reference with `startsWith(packageName)` alone would report
 * `@vibe-agent-toolkit/rag-lancedb` as a self-import of `@vibe-agent-toolkit/rag`
 * — the same unanchored-prefix bug the exempt-path matchers were written to kill.
 */
describe('no-self-package-import', () => {
  const rule = loadLocalRule('no-self-package-import.cjs');
  const AGENT_RUNTIME = [{ packageName: '@vibe-agent-toolkit/agent-runtime' }];

  it('is registered with a valid schema', () => {
    expect(rule.meta?.type).toBe('problem');
  });

  it(RULE_TESTER_CASES, () => {
    const withTs = <T extends object>(cases: T[]): T[] =>
      cases.map((testCase) => ({ ...testCase, languageOptions: { parser: tsParser } }));

    expect(() => {
      ruleTester.run('no-self-package-import', rule, {
        valid: withTs([
          {
            name: 'the relative import that replaced the defect',
            options: AGENT_RUNTIME,
            code: "import type { SessionStore } from './types.js';",
          },
          {
            name: 'a genuinely different package',
            options: AGENT_RUNTIME,
            code: "import { safePath } from '@vibe-agent-toolkit/utils';",
          },
          {
            name: 'a sibling whose name merely EXTENDS this one',
            options: [{ packageName: '@vibe-agent-toolkit/rag' }],
            code: "import { connect } from '@vibe-agent-toolkit/rag-lancedb';",
          },
          {
            name: 'a node builtin',
            options: AGENT_RUNTIME,
            code: "import { readFile } from 'node:fs/promises';",
          },
        ]),
        invalid: withTs([
          {
            name: 'selfImportOfTheShippedDefect',
            options: AGENT_RUNTIME,
            code: "import type { SessionStore } from '@vibe-agent-toolkit/agent-runtime';",
            errors: [{ messageId: 'useRelativeImport' }],
          },
          {
            name: 'a declared subpath of the same package',
            options: AGENT_RUNTIME,
            code: "import { makeSession } from '@vibe-agent-toolkit/agent-runtime/session/test-helpers';",
            errors: [{ messageId: 'useRelativeImport' }],
          },
          {
            name: 'a barrel re-exporting through its own name',
            options: AGENT_RUNTIME,
            code: "export * from '@vibe-agent-toolkit/agent-runtime';",
            errors: [{ messageId: 'useRelativeImport' }],
          },
          {
            name: 'a named re-export through its own name',
            options: AGENT_RUNTIME,
            code: "export { SessionNotFoundError } from '@vibe-agent-toolkit/agent-runtime';",
            errors: [{ messageId: 'useRelativeImport' }],
          },
          {
            name: 'a dynamic import',
            options: AGENT_RUNTIME,
            code: "const m = await import('@vibe-agent-toolkit/agent-runtime');",
            errors: [{ messageId: 'useRelativeImport' }],
          },
          {
            name: 'an import() in TYPE position, which no other visitor reaches',
            options: AGENT_RUNTIME,
            code: "type S = import('@vibe-agent-toolkit/agent-runtime').SessionStore;",
            errors: [{ messageId: 'useRelativeImport' }],
          },
          {
            name: 'a require() call',
            options: AGENT_RUNTIME,
            code: "const m = require('@vibe-agent-toolkit/agent-runtime');",
            errors: [{ messageId: 'useRelativeImport' }],
          },
        ]),
      });
    }).not.toThrow();
  });
});
