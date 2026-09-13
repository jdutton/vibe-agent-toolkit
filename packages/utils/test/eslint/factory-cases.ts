/**
 * Case-table builders shared by every rule built on one of the two factories
 * (`eslint-rule-factory.cjs`, and the function table inside `no-raw-node-path`).
 *
 * Each builder pins one property the factories share — the `safeModule`
 * option, the unanchored-`exemptFiles` advisory, the decoy-basename exemption
 * discipline — so a rule that shares the code path shares the assertion.
 */

import { BARREL, LINTED_FILE, PATH_UTILS_IMPL, SEAM } from './fixtures.js';
import type { RuleCases } from './rule-tester.js';

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
export function safeModuleCases(
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
export function unanchoredExemptCases(unsafeCode: string, safeCode: string): RuleCases {
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

/**
 * `no-os-tmpdir` / `no-fs-mkdirSync` / `no-fs-realpathSync` /
 * `no-child-process-execSync` / `no-fs-promises-cp` share `eslint-rule-factory`,
 * which had the same substring-exemption bug (`filename.includes('path-utils.ts')`)
 * as the path rules. Same decoy discipline applies: a same-named file in a
 * different directory must fire.
 */
export interface UnsafeCallRuleSpec {
  unsafeFn: string;
  unsafeModule: string;
  safeFn: string;
  /** The NARROW subpath that owns `safeFn` — never the barrel. */
  safeModule: string;
  exemptPath: string;
}

export function unsafeCallRuleCases(
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
      },
    ],
    invalid: [
      { code: unsafeCode, filename: LINTED_FILE, options, output, errors },
      // DECOY basenames — the shape that shipped raw tmpdir()/realpathSync()
      // past a fork of this rule pack in a consumer repo.
      decoy(`tools/hooks/${exemptBasename}`),
      decoy(`packages/other/src/${exemptBasename}`),
      // UNCONFIGURED — with no `exemptFiles` option nothing is exempt, including
      // the path this factory used to hardcode.
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
