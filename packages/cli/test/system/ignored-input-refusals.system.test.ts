/**
 * Input a verb used to IGNORE is refused instead (system test).
 *
 * Each row here once exited 0 with the operator's argument silently dropped:
 * `resources validate --format bogus` wrote YAML, `mcp serve <bogus>
 * --print-config` printed a paste-ready block for a package that does not load,
 * and `audit --settings` without `--compat`, under `--user`, or naming a file
 * that is not there audited without the settings check it asked for.
 */

import * as fs from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestTempDir, createTestTempDir, fakeHomeEnv, getBinPath, writeFileTree } from './test-common.js';
import { executeCli, parseYamlOutput } from './test-helpers/index.js';

type CliResult = ReturnType<typeof executeCli>;

const binPath = getBinPath(import.meta.url);
/** Commander's usage ending, remapped by VAT to the error code. */
const USAGE_EXIT = 2;

let tempDir: string;
let pluginDir: string;
let fakeHome: string;

/** The CLI in the fixture plugin, under a fake HOME so no real settings layer is read. */
function run(args: string[]): CliResult {
  return executeCli(binPath, args, { cwd: pluginDir, env: { ...process.env, ...fakeHomeEnv(fakeHome) } });
}

/** A Commander usage refusal: exit 2, the accepted values named, nothing on stdout. */
function expectChoicesRefusal(result: CliResult, allowed: string): void {
  expect(result.status, result.stderr).toBe(USAGE_EXIT);
  expect(result.stderr).toContain(`Allowed choices are ${allowed}`);
  expect(result.stdout).toBe('');
}

/** `vat audit . <args>` refused with `code`, and its message says `fragment`. */
function expectAuditRefusal(args: string[], code: string, fragment: string): void {
  const result = run(['audit', '.', ...args]);
  expect(result.status, result.stderr).toBe(USAGE_EXIT);
  const document = parseYamlOutput(result.stdout) as { status: string; error?: { code: string; message: string } };
  expect(document.status).toBe('error');
  expect(document.error?.code).toBe(code);
  expect(document.error?.message).toContain(fragment);
}

describe('input a verb used to ignore is refused (system test)', () => {

  beforeAll(() => {
    tempDir = createTestTempDir('vat-ignored-input-');
    fakeHome = safePath.join(tempDir, 'home');
    mkdirSyncReal(fakeHome, { recursive: true });
    pluginDir = safePath.join(tempDir, 'plugin');
    writeFileTree(pluginDir, {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'p', version: '1.0.0' }),
      'skills/s/SKILL.md': '---\nname: s\ndescription: A skill for the settings refusal tests.\n---\n# s\n',
      'valid-settings.json': JSON.stringify({ permissions: { deny: ['Bash'] } }),
      'malformed-settings.json': '{ not json',
      'docs/a.md': '# A\n',
    });
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  describe('resources validate', () => {
    it('refuses an unknown --format, naming the formats it offers', () => {
      expectChoicesRefusal(run(['resources', 'validate', 'docs', '--format', 'bogus']), 'yaml, json, text');
    });

    it('refuses an unknown --validation-mode', () => {
      expectChoicesRefusal(run(['resources', 'validate', 'docs', '--validation-mode', 'bogus']), 'strict, permissive');
    });
  });

  it('mcp serve --print-config refuses a package that does not load, printing no config', () => {
    const result = run(['mcp', 'serve', 'vat-no-such-package-anywhere', '--print-config']);
    expect(result.status, result.stderr).toBe(USAGE_EXIT);
    expect(result.stdout).not.toContain('mcpServers');
    expect(result.stderr).toContain('vat mcp serve failed');
  });

  describe('audit --settings', () => {
    it('without --compat is USAGE_INVALID naming the fix', () => {
      expectAuditRefusal(['--settings', 'valid-settings.json'], 'USAGE_INVALID', '--settings requires --compat');
    });

    it('auto-discovered (no file) without --compat is USAGE_INVALID too', () => {
      expectAuditRefusal(['--settings'], 'USAGE_INVALID', '--settings requires --compat');
    });

    it('under --user is USAGE_INVALID', () => {
      const result = run(['audit', '--user', '--compat', '--settings', 'valid-settings.json']);
      expect(result.status, result.stderr).toBe(USAGE_EXIT);
      expect(parseYamlOutput(result.stdout)).toMatchObject({ status: 'error', error: { code: 'USAGE_INVALID' } });
      expect(result.stdout).toContain('--settings is not supported with --user');
    });

    it('naming a file that is not there is USAGE_INVALID naming the path', () => {
      expectAuditRefusal(['--compat', '--settings', 'no-such-settings.json'], 'USAGE_INVALID', 'no-such-settings.json');
    });

    it('naming a directory is INPUT_UNREADABLE', () => {
      fs.mkdirSync(safePath.join(pluginDir, 'settings-dir'), { recursive: true });
      expectAuditRefusal(['--compat', '--settings', 'settings-dir'], 'INPUT_UNREADABLE', 'settings-dir');
    });

    it('naming a file that does not parse is INPUT_UNREADABLE, not a warning beside an unchecked report', () => {
      expectAuditRefusal(['--compat', '--settings', 'malformed-settings.json'], 'INPUT_UNREADABLE', 'malformed-settings.json');
    });

    it.skipIf(CANNOT_DENY_READS)('an auto-discovered project settings file the OS refuses is INPUT_UNREADABLE naming it, never skipped as absent', () => {
      const lockedSettings = safePath.join(pluginDir, '.claude', 'settings.json');
      writeFileTree(pluginDir, { '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Bash'] } }) });
      fs.chmodSync(lockedSettings, 0o000);
      try {
        expectAuditRefusal(['--compat', '--settings'], 'INPUT_UNREADABLE', '.claude/settings.json');
      } finally {
        fs.rmSync(safePath.join(pluginDir, '.claude'), { recursive: true, force: true });
      }
    });

    it('control: --compat with a readable settings file runs the settings check', () => {
      const result = run(['audit', '.', '--compat', '--settings', 'valid-settings.json']);
      expect(result.status, result.stderr).not.toBe(USAGE_EXIT);
      const document = parseYamlOutput(result.stdout) as { data: { files: Array<{ type: string; settings?: unknown }> } };
      expect(document.data.files.find((f) => f.type === 'claude-plugin')?.settings).toBeDefined();
    });
  });
});
