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

import { safePath } from '@vibe-agent-toolkit/utils';
import { installFaultFs, setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { updateSkillTestConfig } from '../../src/commands/skill/test/configure.js';
import { refusalCodeOf } from '../../src/utils/command-refusal.js';

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

/** Declare `name` under `dir`, where {@link SKILLS_BLOCK}'s include discovers it — configure refuses an undeclared skill. */
function writeSkill(dir: string, name: string): void {
  fs.mkdirSync(safePath.join(dir, 'skills', name), { recursive: true });
  fs.writeFileSync(
    safePath.join(dir, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: A skill whose test block a test configures.\n---\n\n# ${name}\n`,
  );
}

/** Write a config file into `dir` and return its path. */
function writeConfig(dir: string, content: string | Buffer): string {
  const configPath = safePath.join(dir, CONFIG_FILENAME);
  fs.writeFileSync(configPath, content);
  return configPath;
}

/** What `updateSkillTestConfig` rejects with for `configPath`, on the config's side for this run. */
function refusalFrom(configPath: string, configSide: 'source' | 'destination'): Promise<unknown> {
  return updateSkillTestConfig(configPath, 'my-skill', { maxTurns: 20 }, () => {}, configSide).then(
    () => undefined,
    (error: unknown) => error,
  );
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
    writeSkill(tempDir, 'my-skill');
    const configPath = writeConfig(
      tempDir,
      `resources:\n  metadata:\n    frontmatter: true\n${SKILLS_BLOCK}`,
    );
    const warnings: string[] = [];

    const updated = await updateSkillTestConfig(
      configPath,
      'my-skill',
      { maxTurns: 20 },
      (m) => warnings.push(m),
      'destination',
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
    const configPath = writeConfig(tempDir, 'skills:\n  include: not-an-array\n');
    const warnings: string[] = [];

    await expect(
      updateSkillTestConfig(configPath, 'my-skill', { maxTurns: 20 }, (m) => warnings.push(m), 'destination'),
    ).rejects.toThrow(/Expected array/);
    expect(warnings).toEqual([]);

    // And the message is the shared formatter's, which names the file. A bare
    // `.rejects.toThrow()` would pass on the JSON blob this lane used to print,
    // which is how the defect survived.
    let failure = '';
    try {
      await updateSkillTestConfig(configPath, 'my-skill', { maxTurns: 20 }, () => {}, 'destination');
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
    const source = `${SKILLS_BLOCK}  config:\n    my-skill:\n      publish: true\n`;
    writeSkill(tempDir, 'my-skill');
    const configPath = writeConfig(tempDir, Buffer.from(`${BOM}${source}`, 'utf16le'));

    const updated = await updateSkillTestConfig(configPath, 'my-skill', { maxTurns: 20 }, () => {}, 'destination');

    // The original content survived the round trip...
    expect(updated).toContain('publish: true');
    // ...and nothing that would be written back carries the interleaved NULs.
    expect(updated).not.toContain(NUL);
    expect(updated).toContain('maxTurns: 20');
  });

  it('refuses a skill the config does not declare as USAGE_INVALID, naming it and the declared ones', async () => {
    // A typo used to be written as `skills.config.<typo>.test`, exit 0, and only
    // the next `vat skill test run <typo>` refused it.
    writeSkill(tempDir, 'my-skill');
    const configPath = writeConfig(tempDir, SKILLS_BLOCK);

    const failure = await updateSkillTestConfig(configPath, 'my-skil', { maxTurns: 5 }, () => {}, 'destination').then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusalCodeOf(failure)).toBe('USAGE_INVALID');
    expect(String((failure as Error).message)).toContain("'my-skil'");
    expect(String((failure as Error).message)).toContain('my-skill');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(SKILLS_BLOCK);
  });

  it('refuses a config the OS will not read RUN_INCOMPLETE, through the shared config read: it is the file this verb writes', async () => {
    // A directory where the file should be: EISDIR on every platform, so no
    // CANNOT_DENY_READS skip. The config is this verb's destination (it edits
    // it in place), so a read the OS refuses is the run not finishing.
    const configPath = safePath.join(tempDir, CONFIG_FILENAME);
    fs.mkdirSync(configPath);

    const failure = await refusalFrom(configPath, 'destination');
    expect(failure).toMatchObject({ code: 'FS_FAULT', side: 'destination', origin: 'config', faultClass: 'wrong-type' });
    expect(refusalCodeOf(failure)).toBe('RUN_INCOMPLETE');
  });

  it('refuses a project with no config CONFIG_INVALID, carrying the classified absence of the config it edits', async () => {
    const configPath = safePath.join(tempDir, CONFIG_FILENAME);

    const failure = await refusalFrom(configPath, 'destination');
    expect(refusalCodeOf(failure)).toBe('CONFIG_INVALID');
    expect((failure as { cause?: unknown }).cause).toMatchObject({ code: 'FS_FAULT', side: 'destination', faultClass: 'absent', path: configPath });
  });

  it('classifies a presence check the OS refuses on the config\'s side for this run, never as "no config"', async () => {
    // Injected, never provoked: no real path makes every host refuse the `stat` — a name too long for
    // the host is ENAMETOOLONG on POSIX and plain ENOENT on Windows, which IS "no config" there.
    const configPath = safePath.join(tempDir, CONFIG_FILENAME);
    const session = installFaultFs({ within: tempDir, faults: [{ op: 'stat', path: (path) => path === configPath, errno: 'ENAMETOOLONG' }] });

    let failure: unknown;
    try {
      failure = await refusalFrom(configPath, 'destination');
    } finally {
      session.restore();
    }
    expect(session.fired.map((call) => call.op)).toEqual(['stat']);
    expect(failure).toMatchObject({ code: 'FS_FAULT', side: 'destination', faultClass: 'wrong-type' });
    expect(refusalCodeOf(failure)).toBe('RUN_INCOMPLETE');
  });

  it('refuses it INPUT_UNREADABLE under --print, which writes nothing: the config is then only read', async () => {
    const configPath = safePath.join(tempDir, CONFIG_FILENAME);
    fs.mkdirSync(configPath);

    const failure = await refusalFrom(configPath, 'source');
    expect(failure).toMatchObject({ code: 'FS_FAULT', side: 'source', origin: 'config', faultClass: 'wrong-type' });
    expect(refusalCodeOf(failure)).toBe('INPUT_UNREADABLE');
  });
});
