/**
 * `vat skill test configure` reads config through the SAME reader as everything
 * else, and decodes the file before rewriting it.
 *
 * 🚨 Why this file exists. Two behaviours landed to end one adopter's blocker —
 * an unrecognized key warns instead of refusing, and the refusal message is
 * prose naming the file rather than `ZodError.message`'s JSON dump of the issue
 * array. Both were fixed in `cli/utils/config-loader.ts` and
 * `resources/config-parser.ts`, and the module docstring that recorded the work
 * said there were "two config readers in the toolkit".
 *
 * There were three. This command called `ProjectConfigSchema.safeParse` directly
 * and interpolated `validation.error.message`, so it went on reproducing BOTH
 * defects: `vat skill test configure my-skill --max-turns 20` exited 1 with a raw
 * JSON array — no file named, no remedy — because the config carried a stale
 * `resources.metadata`, a section this command never reads. The count in a
 * docstring is not a mechanism; these assertions are.
 *
 * ⚠️ The tests drive `updateSkillTestConfig`, not the Commander action, and that
 * is deliberate rather than convenient: the defective code sat between a
 * `process.cwd()` walk-up and a `writeFileSync`, and reaching it through the
 * command means `process.chdir`, which the Unix unit pool (threads) cannot do at
 * all. Untestable-by-shape is how both defects shipped green.
 */

import * as fs from 'node:fs';

import { setupSyncTempDirSuite, safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { updateSkillTestConfig } from '../../src/commands/skill/test/configure.js';

const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

/**
 * The byte-order mark PowerShell 5.1 prepends to the UTF-16LE files it writes.
 *
 * Built with `String.fromCodePoint`, never typed as a `\u` escape: an escape
 * typed into a source file is normalized into a real control byte on the way in,
 * which makes the file read as binary to `grep` and is invisible in review. See
 * `.claude/rules/tests-that-prove-nothing.md`.
 */
const BOM = String.fromCodePoint(0xfe_ff);

/** What a utf-8 read of a UTF-16LE file interleaves through every character. */
const NUL = String.fromCodePoint(0);

/** `skills:` is only valid alongside an `include:`, so every fixture carries one. */
const SKILLS_BLOCK = 'skills:\n  include:\n    - "skills/**/SKILL.md"\n';

/** Write a config file into `dir` and return its path. */
function writeConfig(dir: string, content: string | Buffer): string {
  const configPath = safePath.join(dir, CONFIG_FILENAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
  fs.writeFileSync(configPath, content);
  return configPath;
}

describe('updateSkillTestConfig (the third config reader)', () => {
  const suite = setupSyncTempDirSuite('vat-skill-test-configure');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('WARNS about an unknown key and still writes the change', async () => {
    // The adopter's exact shape: a key VAT removed and had been silently
    // discarding for releases, in a section this command does not read.
    const configPath = writeConfig(
      tempDir,
      `version: 1\nresources:\n  metadata:\n    frontmatter: true\n${SKILLS_BLOCK}`,
    );
    const warnings: string[] = [];

    const updated = await updateSkillTestConfig(
      configPath,
      'my-skill',
      { maxTurns: 20 },
      (m) => warnings.push(m),
    );

    // It did not refuse: the knob the operator typed is in the output.
    expect(updated).toContain('maxTurns: 20');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('metadata');
    expect(warnings[0]).toContain(configPath);
    // The regression guard against the OTHER defect: `ZodError.message` is the
    // issue array, serialized.
    expect(warnings[0]).not.toContain('"code":');
  });

  it('still REFUSES a config it would misread, in words rather than a JSON dump', async () => {
    // The boundary the downgrade must not cross — a wrong type means VAT would
    // act on a config it misunderstood.
    const configPath = writeConfig(tempDir, 'version: 1\nskills:\n  include: not-an-array\n');
    const warnings: string[] = [];

    await expect(
      updateSkillTestConfig(configPath, 'my-skill', { maxTurns: 20 }, (m) => warnings.push(m)),
    ).rejects.toThrow(/Expected array/);
    expect(warnings).toEqual([]);

    // And the message is the shared formatter's, which names the file. A bare
    // `.rejects.toThrow()` would pass on the JSON blob this lane used to print,
    // which is how the defect survived.
    let failure = '';
    try {
      await updateSkillTestConfig(configPath, 'my-skill', { maxTurns: 20 }, () => {});
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    expect(failure).toContain(configPath);
    expect(failure).not.toContain('"code":');
  });

  it('decodes a UTF-16LE config instead of rewriting it as mojibake', async () => {
    // The case `readTextContent` exists for — PowerShell 5.1 writes UTF-16LE by
    // default. This command READS the config and WRITES it straight back, so
    // `readFileSync(path, 'utf-8')` did not merely misreport it: the mojibake was
    // what got serialized over the adopter's own file.
    const source = `version: 1\n${SKILLS_BLOCK}  config:\n    my-skill:\n      publish: true\n`;
    const configPath = writeConfig(tempDir, Buffer.from(`${BOM}${source}`, 'utf16le'));

    const updated = await updateSkillTestConfig(configPath, 'my-skill', { maxTurns: 20 }, () => {});

    // The original content survived the round trip...
    expect(updated).toContain('publish: true');
    // ...and nothing that would be written back carries the interleaved NULs.
    expect(updated).not.toContain(NUL);
    expect(updated).toContain('maxTurns: 20');
  });
});
