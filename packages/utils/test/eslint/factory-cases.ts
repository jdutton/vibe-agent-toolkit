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
 * `no-child-process-execSync` share `eslint-rule-factory`,
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
  /**
   * `'fix'`: an autofix swaps the callee and keeps the arguments.
   * `{ appendArgument }`: the safe call needs an argument the rule cannot know
   * (`normalizePath`'s `{ within }`), so the rewrite is a SUGGESTION that appends
   * this placeholder — never an autofix, which would emit a call that does not
   * compile or, worse, one that compiles with a guessed value.
   * `{ autofixAsStatement }`: the safe call takes the same arguments but RETURNS
   * something else (`mkdirSyncReal`'s real path vs `mkdirSync`'s first-created
   * directory), so only a call whose result is discarded is autofixed; any other
   * is a suggestion.
   */
  rewrite: 'fix' | { readonly appendArgument: string } | { readonly autofixAsStatement: true };
}

export function unsafeCallRuleCases(
  { unsafeFn, unsafeModule, safeFn, safeModule, exemptPath, rewrite }: UnsafeCallRuleSpec,
): RuleCases {
  const extra = typeof rewrite === 'object' && 'appendArgument' in rewrite ? `, ${rewrite.appendArgument}` : '';
  /** Whether a call in VALUE position (`const r = …`) is autofixed rather than only suggested. */
  const valueCallAutofixed = rewrite === 'fix';
  const unsafeImport = `import { ${unsafeFn} } from '${unsafeModule}';`;
  const safeImport = `import { ${safeFn} } from '${safeModule}';`;
  const unsafeCode = `${unsafeImport}\nconst r = ${unsafeFn}(x);`;
  // The new import takes the removed one's LINE. It used to be welded onto
  // whatever followed, because the fixer inserted after `body[0]` with a
  // trailing newline regardless of what `body[0]` was — visible here only as a
  // moved `\n`, and visible in a file whose first statement is not an import as
  // `const os = {…};import { normalizedTmpdir } from '…';` on one line.
  const output = `\n${safeImport}\nconst r = ${safeFn}(x${extra});`;
  // A SUGGESTION never removes the unsafe import: it is applied alone, from an
  // editor, and the binding may still back a call no suggestion was taken for.
  // The dead-import leg removes it on a later pass once nothing references it.
  const suggestedOutput = `${unsafeImport}\n${safeImport}\nconst r = ${safeFn}(x${extra});`;
  const errors = [{ messageId: 'noUnsafeOperation' }];
  const options = [{ exemptFiles: [exemptPath] }];
  /** What ONE report's rewrite produces: an autofix `output`, or the suggestion's text. */
  const rewritten = (fixedCode: string, suggestedCode: string): { output?: string; errors: object[] } =>
    valueCallAutofixed
      ? { output: fixedCode, errors }
      : { errors: [{ messageId: 'noUnsafeOperation', suggestions: [{ messageId: 'useSafeCall', output: suggestedCode }] }] };
  const decoy = (filename: string) => ({ code: unsafeCode, filename, options, ...rewritten(output, suggestedOutput) });
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
      { code: unsafeCode, filename: LINTED_FILE, options, ...rewritten(output, suggestedOutput) },
      // DECOY basenames — the shape that shipped raw tmpdir()/realpathSync()
      // past a fork of this rule pack in a consumer repo.
      decoy(`tools/hooks/${exemptBasename}`),
      decoy(`packages/other/src/${exemptBasename}`),
      // UNCONFIGURED — with no `exemptFiles` option nothing is exempt, including
      // the path this factory used to hardcode.
      { code: unsafeCode, filename: exemptPath, ...rewritten(output, suggestedOutput) },
      // ALREADY BOUND through the BARREL — rewrite the call, add no import. A
      // second binding of `safeFn` is a SyntaxError, not a redundant import.
      {
        code: `import { ${safeFn} } from '${BARREL}';\nimport { ${unsafeFn} } from '${unsafeModule}';\nconst r = ${unsafeFn}(x);`,
        filename: LINTED_FILE,
        options,
        ...rewritten(
          `import { ${safeFn} } from '${BARREL}';\n\nconst r = ${safeFn}(x${extra});`,
          `import { ${safeFn} } from '${BARREL}';\n${unsafeImport}\nconst r = ${safeFn}(x${extra});`,
        ),
      },
      ...(typeof rewrite === 'object' && 'autofixAsStatement' in rewrite
        ? statementOnlyAutofixCases(unsafeFn, safeFn, unsafeImport, safeImport, options)
        : []),
      // A suggestion appends ONE argument to a ONE-argument call. With more,
      // the rest are the unsafe function's own (`realpathSync(p, 'utf8')`) and
      // mean nothing to the safe one, so the call is reported with no rewrite.
      ...(typeof rewrite === 'object' && 'appendArgument' in rewrite
        ? [{
            code: `import { ${unsafeFn} } from '${unsafeModule}';\nconst r = ${unsafeFn}(x, y);`,
            filename: LINTED_FILE,
            options,
            errors: [{ messageId: 'noUnsafeOperation', suggestions: [] }],
          }]
        : []),
    ],
  };
}

/**
 * The `{ autofixAsStatement }` mode's own cases: a discarded result is autofixed,
 * and the unsafe import is removed only when no call it backs was left as a
 * suggestion — removing it beside a value-position call strands that call.
 */
function statementOnlyAutofixCases(
  unsafeFn: string,
  safeFn: string,
  unsafeImport: string,
  safeImport: string,
  options: object[],
): object[] {
  return [
    // Result discarded: the swap cannot change behaviour, so it is an autofix.
    {
      code: `${unsafeImport}\n${unsafeFn}(x);`,
      filename: LINTED_FILE,
      options,
      output: `\n${safeImport}\n${safeFn}(x);`,
      errors: [{ messageId: 'noUnsafeOperation' }],
    },
    // One of each: the statement is autofixed, the value call only suggested,
    // and the import stays because the value call still needs it.
    {
      code: `${unsafeImport}\n${unsafeFn}(a);\nconst r = ${unsafeFn}(b);`,
      filename: LINTED_FILE,
      options,
      output: `${unsafeImport}\n${safeImport}\n${safeFn}(a);\nconst r = ${unsafeFn}(b);`,
      errors: [
        { messageId: 'noUnsafeOperation', suggestions: [] },
        {
          messageId: 'noUnsafeOperation',
          suggestions: [{
            messageId: 'useSafeCall',
            output: `${unsafeImport}\n${safeImport}\n${unsafeFn}(a);\nconst r = ${safeFn}(b);`,
          }],
        },
      ],
    },
  ];
}
