/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
/* eslint-disable sonarjs/file-permissions -- `chmod 000` on a throwaway temp config IS the
   fixture: the EACCES case below exists to prove the scan asks the filesystem question, and there
   is no way to produce a genuinely unreadable file without making one. Same rationale, same
   temp-directory scope, as `audit-unreadable-path.integration.test.ts`. */

/**
 * Integration test: an UNLOADABLE governing config degrades the scan, it does
 * not destroy it — and says so on BOTH channels.
 *
 * 🚨 This file exists because `vat audit`'s two skill-validation lanes carried
 * two different policies for the same input. `validateSingleSkill` wrapped the
 * config resolution in a try/catch whose comment reads "audit is a bulk linter
 * … rather than aborting the scan" — while sitting on the lane that does no
 * bulk scanning. `handleFileEntry`, the lane the directory scan and `--user`
 * actually reach (677 of 851 skills on a real `--user` run), called the same
 * resolver unguarded.
 *
 * So one typo in one nested `vibe-agent-toolkit.config.yaml` aborted the WHOLE
 * tree — exit 2, zero skills audited, no findings at all — while pointing the
 * same command at the same SKILL.md under that same config exited 0 and
 * reported it as passing. Same tree, same skill, two verdicts, decided only by
 * whether the argument was a file or its parent directory.
 *
 * The policy these tests pin is the one `SCAN_PATH_UNREADABLE` was written to
 * enforce and states in its own docstring: degrading beats destroying, and
 * silence is not the alternative. A scan that quietly skipped the config would
 * be the same failure shape as a detector that silently disables itself, so the
 * warning is asserted as hard as the exit code.
 *
 * ⚠️ **Three fixtures, and the reason is that ONE could not see the defects.**
 * The original fixture was a bare directory carrying a Zod failure, which routes
 * through `handleFileEntry` — the one lane that already deduped. So:
 *
 * - `pluginDir` adds `.claude-plugin/plugin.json`, routing the same tree through
 *   `validatePluginSkillsViaInventory` → `validateSingleSkill`, which minted a
 *   `new Set()` per call. A 40-skill plugin printed 40 identical warnings while
 *   the bare-directory assertion below stayed green.
 * - `yamlDir` carries a YAML SYNTAX error rather than a schema failure, because
 *   the audit dedupe key used to be `err.message` under a comment claiming it
 *   "names the offending config path". That is true only of a Zod failure;
 *   `YAMLParseError.message` carries no filename, so two projects with the same
 *   copy-pasted broken config collapsed to one warning naming neither.
 */

import fs from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAuditCli } from '../test-helpers.js';

let tempDir: string;
let pluginDir: string;
let yamlDir: string;
let skillPath: string;

/**
 * A config VAT can read but not accept: a real key holding the WRONG TYPE.
 *
 * ⚠️ Not an unknown key. An unrecognized key is deliberately no longer fatal —
 * `parseConfigAllowingUnknownKeys` warns and drops it — so a fixture built that
 * way would load cleanly and this file would exercise nothing. A wrong type is
 * the case that still refuses, because it means VAT would otherwise act on a
 * config it misread.
 */
const UNLOADABLE_CONFIG = 'version: 1\nresources:\n  exclude: not-an-array\n';

/**
 * A config VAT cannot even PARSE. The failure comes out of `yaml.parse`, so the
 * message names no file at all — which is the whole point of this fixture.
 */
const UNPARSEABLE_CONFIG = 'version: 1\nresources:\n  exclude: [unclosed\n';

const PLUGIN_MANIFEST = JSON.stringify({
  name: 'demo-plugin',
  description: 'A plugin whose governing config cannot be loaded.',
  version: '0.0.1',
});

const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

function writeSkill(dir: string, name: string): string {
  mkdirSyncReal(dir, { recursive: true });
  const target = safePath.join(dir, 'SKILL.md');
  fs.writeFileSync(
    target,
    `---\nname: ${name}\ndescription: A fixture skill governed by a config that cannot be loaded.\n---\n\n# ${name}\n\nBody text.\n`,
  );
  return target;
}

/** A tree with a broken config at its root and two skills under it. */
function buildFixture(prefix: string, configText: string, asPlugin: boolean): string {
  const dir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), prefix));
  fs.writeFileSync(safePath.join(dir, CONFIG_FILENAME), configText);
  // TWO skills under the SAME config, so the warning's once-per-config
  // behaviour is observable. A per-skill warning would be 851 lines on a real
  // `--user` run, which is its own way of making the message unreadable.
  writeSkill(safePath.join(dir, 'skills', 'demo'), 'demo');
  writeSkill(safePath.join(dir, 'skills', 'demo-two'), 'demo-two');
  if (asPlugin) {
    mkdirSyncReal(safePath.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(safePath.join(dir, '.claude-plugin', 'plugin.json'), PLUGIN_MANIFEST);
  }
  return dir;
}

beforeAll(() => {
  tempDir = buildFixture('vat-unloadable-cfg-', UNLOADABLE_CONFIG, false);
  skillPath = safePath.join(tempDir, 'skills', 'demo', 'SKILL.md');
  pluginDir = buildFixture('vat-unloadable-cfg-plugin-', UNLOADABLE_CONFIG, true);
  yamlDir = buildFixture('vat-unparseable-cfg-', UNPARSEABLE_CONFIG, false);
});

afterAll(() => {
  for (const dir of [tempDir, pluginDir, yamlDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Every "Ignoring unloadable config" line the run printed. */
function ignoreWarnings(stderr: string): string[] {
  return stderr.split('\n').filter((l) => l.includes('Ignoring unloadable config'));
}

describe('vat audit with an unloadable governing config', () => {
  it('scans the tree instead of aborting, and says the config was ignored', () => {
    const result = runAuditCli(tempDir);

    // The regression: this used to be exit 2 with no skill audited at all.
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Ignoring unloadable config');
    // The message must name the file, or it cannot be acted on.
    expect(result.stderr).toContain(CONFIG_FILENAME);
    // And it must not be silent about WHY the config was rejected — the
    // offending path, not just the fact that something was wrong.
    expect(result.stderr).toContain('resources.exclude');
  });

  it('warns once for the config, not once per skill it governs', () => {
    const result = runAuditCli(tempDir);

    expect(ignoreWarnings(result.stderr)).toHaveLength(1);
  });

  it('warns once through the PLUGIN-INVENTORY lane too, not once per bundled skill', () => {
    // The lane `validateSingleSkill` sits on. It received a throwaway `new Set()`
    // on every call, so the dedupe was structurally impossible here while the
    // assertion above stayed green — the fixture simply never reached this code.
    const result = runAuditCli(pluginDir);

    expect(ignoreWarnings(result.stderr)).toHaveLength(1);
  });

  it('names the config for a YAML SYNTAX error, whose message names nothing', () => {
    const result = runAuditCli(yamlDir);

    expect(result.status).toBe(0);
    const warnings = ignoreWarnings(result.stderr);
    expect(warnings).toHaveLength(1);
    // The path has to come from `ConfigLoadError.projectRoot`, because the yaml
    // library's own message has no filename in it to borrow.
    expect(warnings[0]).toContain(safePath.join(yamlDir, CONFIG_FILENAME));
  });

  it('records the ignored config in the REPORT, not only on stderr', () => {
    // The warning goes to stderr; the report goes to stdout. N skills silently
    // downgraded to the much weaker config-free validator, exit 0, and a report
    // that says nothing about it is the "detector silently disables itself" shape
    // this command's own docstring invokes.
    const result = runAuditCli(tempDir, ['--verbose']);

    expect(result.stdout).toContain('SCAN_PATH_UNREADABLE');
    expect(result.stdout).toContain(CONFIG_FILENAME);
  });

  it('agrees with the single-target lane on the same skill', () => {
    const scan = runAuditCli(tempDir);
    const single = runAuditCli(skillPath);

    // The whole point: the answer must not depend on whether the argument was
    // the file or the directory above it. The single-target lane always
    // tolerated this; the scan lane did not.
    expect(single.status).toBe(0);
    expect(scan.status).toBe(single.status);
  });
});

/**
 * `chmod 000` denies nothing to uid 0, and means nothing on Windows — the same
 * guard `audit-unreadable-path.integration.test.ts` carries, for the same reason.
 */
const CANNOT_DENY_READS =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

const UNREADABLE = 0o000;
const READABLE = 0o644;

describe.skipIf(CANNOT_DENY_READS)('vat audit with a config the FILESYSTEM refuses', () => {
  let eaccesDir: string;
  let eaccesConfig: string;

  beforeAll(() => {
    eaccesDir = buildFixture('vat-eacces-cfg-', 'version: 1\n', false);
    eaccesConfig = safePath.join(eaccesDir, CONFIG_FILENAME);
    fs.chmodSync(eaccesConfig, UNREADABLE);
  });

  afterAll(() => {
    // Restore the mode first, or `rm -rf` cannot remove it.
    if (fs.existsSync(eaccesConfig)) fs.chmodSync(eaccesConfig, READABLE);
    fs.rmSync(eaccesDir, { recursive: true, force: true });
  });

  it('files the finding on the CONFIG and still validates the skill', () => {
    // `config-loader.ts` preserves `cause` specifically so callers can ask
    // `isFilesystemAccessError` and "decide whether to degrade or abort".
    // `resolveGoverningConfig` caught `ConfigLoadError` unconditionally and never
    // asked — so an EACCES config produced no finding at all, and the run said
    // only that a config was "unloadable". A permissions problem and a typo need
    // different actions from the operator and must not share one sentence.
    const result = runAuditCli(eaccesDir, ['--verbose']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SCAN_PATH_UNREADABLE');
    expect(result.stdout).toContain('EACCES');
    // ...anchored on the config, which is the path that was actually refused.
    expect(result.stdout).toContain(CONFIG_FILENAME);
    // ...and the operator is told it was UNREADABLE, not merely unloadable.
    expect(result.stderr).toContain('Ignoring unreadable config');

    // 🚨 The half that a re-throw would have broken, and the reason this lane
    // degrades instead. Handing the error to the per-entry guard was measured on
    // this fixture: `filesScanned: 1, filesPassed: 0`, the finding anchored on
    // `skills/demo/SKILL.md`, and the perfectly readable skill never validated at
    // all. On a real `--user` run that is hundreds of skills losing every check
    // because one config is `chmod 000`.
    // `type: agent-skill`, not the `type: unknown` of a synthetic unreadable-path
    // result — the skill was VALIDATED, not merely counted.
    expect(result.stdout).toContain('path: skills/demo/SKILL.md');
    expect(result.stdout).toContain('type: agent-skill');
  });
});
