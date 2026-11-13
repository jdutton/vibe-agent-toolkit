/**
 * `no-stdout-outside-writer` — under a command directory, stdout is written by
 * the one document writer and nothing else. The helpers are flagged by NAME as
 * well as the raw primitives: a rule that saw only `process.stdout.write` was
 * blind to every command writing through `writeStdoutSync`.
 */

import { describe, expect, it } from 'vitest';

import { RULE_TESTER_CASES, type RuleCases, expectRulePasses, loadLocalRule, ruleTester } from '../rule-tester.js';

const RULE = 'no-stdout-outside-writer';
const COMMAND_FILE = '/repo/packages/cli/src/commands/a.ts';
const WRITER_FILE = '/repo/packages/cli/src/utils/document-writer.ts';
const PATHS = ['packages/cli/src/commands/'];
const OPTIONS = [{ paths: PATHS }];

const CASES: RuleCases = {
  valid: [
    // Outside `paths` — the writer itself is where stdout is written.
    { code: "process.stdout.write('x');", filename: WRITER_FILE, options: OPTIONS },
    { code: 'console.log(1);', filename: WRITER_FILE, options: OPTIONS },
    { code: 'writeStdoutSync(t);', filename: WRITER_FILE, options: OPTIONS },
    // stderr is the human channel and is not this rule's business.
    { code: 'console.error(1);', filename: COMMAND_FILE, options: OPTIONS },
    { code: 'console.warn(1);', filename: COMMAND_FILE, options: OPTIONS },
    { code: "process.stderr.write('x');", filename: COMMAND_FILE, options: OPTIONS },
    // The writer's own entry points are the sanctioned route.
    { code: "endWithReport('okf validate', report, format);", filename: COMMAND_FILE, options: OPTIONS },
    // A method that merely shares a name is not the helper.
    { code: 'logger.log(1);', filename: COMMAND_FILE, options: OPTIONS },
    // A test file is not a command.
    { code: 'console.log(1);', filename: '/repo/packages/cli/src/commands/a.test.ts', options: OPTIONS },
  ],
  invalid: [
    { code: "process.stdout.write('x');", filename: COMMAND_FILE, options: OPTIONS, errors: [{ messageId: 'stdoutOutsideWriter' }] },
    { code: 'console.log(1);', filename: COMMAND_FILE, options: OPTIONS, errors: [{ messageId: 'stdoutOutsideWriter' }] },
    { code: 'console.info(1);', filename: COMMAND_FILE, options: OPTIONS, errors: [{ messageId: 'stdoutOutsideWriter' }] },
    { code: 'console.table(rows);', filename: COMMAND_FILE, options: OPTIONS, errors: [{ messageId: 'stdoutOutsideWriter' }] },
    { code: 'writeStdoutSync(t);', filename: COMMAND_FILE, options: OPTIONS, errors: [{ messageId: 'stdoutOutsideWriter' }] },
    { code: 'output.writeStdoutSync(t);', filename: COMMAND_FILE, options: OPTIONS, errors: [{ messageId: 'stdoutOutsideWriter' }] },
    { code: 'writeAllSync(w, b);', filename: COMMAND_FILE, options: OPTIONS, errors: [{ messageId: 'stdoutOutsideWriter' }] },
    // Imported to be handed on rather than called: the file still writes stdout through it.
    {
      code: "import { writeStdoutSync } from '../utils/output.js';\nrender(result, writeStdoutSync);",
      filename: COMMAND_FILE,
      options: OPTIONS,
      errors: [{ messageId: 'stdoutOutsideWriter' }],
    },
  ],
};

describe(RULE, () => {
  it(RULE_TESTER_CASES, () => {
    expectRulePasses(RULE, CASES);
  });

  it('refuses an `allowFiles` exemption list — no command writes its own stdout', () => {
    expect(() => {
      ruleTester.run(RULE, loadLocalRule(`${RULE}.cjs`), {
        valid: [{ code: "endWithReport('okf validate', report, format);", filename: COMMAND_FILE, options: [{ paths: PATHS, allowFiles: [] }] }],
        invalid: [],
      });
    }).toThrow(/additional properties/i);
  });
});
