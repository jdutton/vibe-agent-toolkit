/**
 * `vat audit settings` states ONE base and spells every path against it.
 *
 * The same contract `vat audit` keeps with `data.root`: the report states the
 * directory it ran in once, as `data.root`, and every other path — a finding's
 * `location`, a layer's `file`, a conflict's `ruleSource`, a value's `source`,
 * a probed `path` — is forward-slashed and relative to it. A document that
 * spelled one file absolutely in `layers` and `../../…` in `location` had two
 * coordinate systems and leaked `$HOME` into every run.
 */

import * as fs from 'node:fs';

import { isAbsoluteAnyPlatform, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yaml from 'yaml';

import { AUDIT_SETTINGS_REPORT_SCHEMA } from '../../src/commands/audit-settings-schema.js';

import { cleanupTestTempDir, createTestTempDir, executeCli, fakeHomeEnv, getBinPath, writeTestFile } from './test-common.js';

const binPath = getBinPath(import.meta.url);

/** Keys whose string value is a path in the document. */
const PATH_KEYS = new Set(['location', 'file', 'path', 'source', 'ruleSource', 'shadowedBySource']);

/** Every path-valued string in `node`, with where it sits. */
function pathsIn(node: unknown, trail: string, out: Array<{ trail: string; value: string }>): void {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) pathsIn(item, `${trail}[${i}]`, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const child = trail === '' ? key : `${trail}.${key}`;
    if (typeof value === 'string' && PATH_KEYS.has(key)) out.push({ trail: child, value });
    else pathsIn(value, child, out);
  }
}

/** `vat audit settings` in `cwd`, with `home` as the user's Claude config, parsed by the verb's registered schema. */
async function runSettings(cwd: string, home: string, args: string[], configDir?: string) {
  const env = { ...process.env, ...fakeHomeEnv(home), ...(configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir }) };
  const result = await executeCli(binPath, ['audit', 'settings', ...args], { cwd, env });
  return { result, report: AUDIT_SETTINGS_REPORT_SCHEMA.parse(yaml.parse(result.stdout)) };
}

describe('vat audit settings — one stated root (system test)', () => {
  let projectDir: string;
  let fakeHome: string;
  let tempDir: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-audit-settings-root-');
    // Real paths on both sides: the CLI's cwd is the resolved one (macOS /var → /private/var).
    const base = fs.realpathSync(tempDir);
    projectDir = safePath.join(base, 'project');
    fakeHome = safePath.join(base, 'home');
    fs.mkdirSync(safePath.join(projectDir, '.claude'), { recursive: true });
    fs.mkdirSync(safePath.join(fakeHome, '.claude'), { recursive: true });
    // A user rule the project duplicates: one SETTINGS_RULE_SHADOWED finding, anchored at a file OUTSIDE the root.
    writeTestFile(safePath.join(fakeHome, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['WebSearch(*)'] } }));
    writeTestFile(safePath.join(projectDir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['WebSearch'], deny: ['Bash'] } }));
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  it('states the working directory as data.root and spells every path in the effective report against it', async () => {
    const { result, report } = await runSettings(projectDir, fakeHome, []);

    expect(result.status, result.stderr).toBe(0);
    expect(report.data.root).toBe(toForwardSlash(projectDir));
    const paths: Array<{ trail: string; value: string }> = [];
    pathsIn({ findings: report.findings, data: { ...report.data, root: undefined } }, '', paths);
    // Both sides of the document are exercised: a finding and the data.
    expect(paths.some((p) => p.trail.startsWith('findings'))).toBe(true);
    expect(paths.some((p) => p.trail.startsWith('data.layers'))).toBe(true);
    for (const { trail, value } of paths) {
      expect(isAbsoluteAnyPlatform(value), `${trail} is absolute: ${value}`).toBe(false);
      expect(fs.existsSync(safePath.join(projectDir, value)), `${trail} does not resolve under data.root: ${value}`).toBe(true);
    }
    // The user file, outside the root, is spelled from it — never with $HOME.
    expect(report.findings.map((f) => f.location)).toContain('../home/.claude/settings.json');
    expect(result.stdout).not.toContain(toForwardSlash(fakeHome));
  });

  it('spells every probed settings path against data.root in --show-paths', async () => {
    const { report } = await runSettings(projectDir, fakeHome, ['--show-paths']);
    const paths: Array<{ trail: string; value: string }> = [];
    pathsIn(report.data.mode === 'paths' ? report.data.paths : [], 'paths', paths);

    expect(paths.length).toBeGreaterThan(0);
    // A candidate path may not exist — that is what the probe reports — but it is never absolute.
    expect(paths.filter((p) => isAbsoluteAnyPlatform(p.value))).toEqual([]);
  });

  // The default mode and --show-paths name the same user file: the one CLAUDE_CONFIG_DIR says.
  it('reads the user layer from CLAUDE_CONFIG_DIR, the file --show-paths names', async () => {
    const base = fs.realpathSync(tempDir);
    const configDir = safePath.join(base, 'relocated-config');
    const bareHome = safePath.join(base, 'bare-home');
    const bareProject = safePath.join(base, 'bare-project');
    fs.mkdirSync(bareHome, { recursive: true });
    fs.mkdirSync(bareProject, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    writeTestFile(safePath.join(configDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['WebSearch'] } }));

    const effective = await runSettings(bareProject, bareHome, [], configDir);
    const shown = await runSettings(bareProject, bareHome, ['--show-paths'], configDir);

    expect(effective.result.status, effective.result.stderr).toBe(0);
    const userLayers = effective.report.data.mode === 'effective' ? effective.report.data.layers.filter((l) => l.level === 'user') : [];
    expect(userLayers.map((l) => l.file)).toEqual(['../relocated-config/settings.json']);
    const shownUser = shown.report.data.mode === 'paths' ? shown.report.data.paths.filter((p) => p.level === 'user') : [];
    expect(shownUser.map((p) => p.path)).toEqual(['../relocated-config/settings.json']);
  });
});
