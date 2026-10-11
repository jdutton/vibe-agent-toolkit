/**
 * `vat audit --compat --settings`: what the settings lane finds is a FINDING, so the document
 * and the human channel agree.
 *
 * A plugin whose skill declares a tool the org policy denies used to publish `status: ok`,
 * `findings: []`, `summary: {0, 0, 0}` — with the conflict under `data.files[].settings` and a
 * stderr line saying one was found. The sibling verb `vat audit settings` fixed exactly that for
 * its own conflicts; this is the same contract for this lane.
 */

import fs from 'node:fs';

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { runAuditCli } from '../test-helpers.js';

import { auditWithSettings, bashSkill, writeDenyBashSettings, writeSettingsPlugin } from './audit-settings-fixture.js';

interface Envelope {
  status: string;
  summary: { errors: number; warnings: number; info: number };
  findings: Array<{ code: string; severity: string; location?: string; message: string }>;
  data: { counts: { filesWithWarnings: number; filesPassed: number }; files: Array<{ type: string; status: string; summary: { warnings: number } }> };
}

let tempDir: string;
let pluginDir: string;
let denyBash: string;
let denyNothing: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-compat-findings-'));
  pluginDir = writeSettingsPlugin(tempDir, 'blocked-plugin', { deploy: bashSkill('deploy') });
  denyBash = writeDenyBashSettings(tempDir);
  denyNothing = safePath.join(tempDir, 'open-settings.json');
  fs.writeFileSync(denyNothing, JSON.stringify({ permissions: { deny: [] } }));
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const conflictsOf = (envelope: Envelope): Envelope['findings'] => envelope.findings.filter((finding) => finding.code === 'SETTINGS_POLICY_CONFLICT');
const notChecked = (envelope: Envelope): Envelope['findings'] => envelope.findings.filter((finding) => finding.code === 'COMPAT_NOT_CHECKED');

const HOOKS = 'hooks/hooks.json';

describe('vat audit --compat --settings: a settings conflict is a finding', () => {
  it('publishes the conflict as a finding on the plugin, and the status and counts follow it', () => {
    const { exit, stderr, plugin, report } = auditWithSettings(pluginDir, denyBash);
    const envelope = report as unknown as Envelope;

    // The lane's own block still says so…
    expect(plugin?.settings?.compatible).toBe(false);
    expect(plugin?.settings?.conflicts.map((conflict) => conflict.type)).toEqual(['tool-blocked']);
    // …and so does the envelope: one finding, on the plugin, naming the tool and the policy file.
    const conflicts = conflictsOf(envelope);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ severity: 'warning', location: '.' });
    expect(conflicts[0]?.message).toContain('Tool "Bash" in skills/deploy/SKILL.md blocked by org policy');
    expect(conflicts[0]?.message).toContain('managed-settings.json');
    expect(envelope.status).toBe('findings');
    expect(envelope.summary.warnings).toBeGreaterThanOrEqual(1);
    // The plugin's own row carries it, so the file counts do.
    const row = envelope.data.files.find((file) => file.type === 'claude-plugin');
    expect(row).toMatchObject({ status: 'findings' });
    expect(row?.summary.warnings).toBeGreaterThanOrEqual(1);
    expect(envelope.data.counts.filesWithWarnings).toBeGreaterThanOrEqual(1);
    // A warning does not fail an audit; the human channel says what the document says.
    expect(exit).toBe(ExitCode.OK);
    expect(stderr).toContain('1 settings conflict(s) found');
  });

  // A file the analyzer could not parse is listed under `compatibility.unchecked`, and no scan
  // finding says so: the document must, or its `status: ok` is a verdict over fewer files than it claims.
  it('publishes a path the analyzer could not read as COMPAT_NOT_CHECKED at that path, once', () => {
    const broken = writeSettingsPlugin(tempDir, 'broken-hooks-plugin', {});
    fs.mkdirSync(safePath.join(broken, 'hooks'), { recursive: true });
    fs.writeFileSync(safePath.join(broken, HOOKS), '{ this is not JSON');

    const envelope = parseYaml(runAuditCli(broken, ['--compat']).stdout) as Envelope & { data: { files: Array<{ type: string; compatibility?: { unchecked?: Array<{ path: string }> } }> } };

    // The premise: the block lists the file.
    expect(envelope.data.files.find((file) => file.type === 'claude-plugin')?.compatibility?.unchecked?.map((entry) => entry.path)).toEqual([HOOKS]);
    expect(notChecked(envelope).map((finding) => [finding.severity, finding.location])).toEqual([['warning', HOOKS]]);
    expect(notChecked(envelope)[0]?.message).toContain('could not examine this path');
    expect(envelope.status).toBe('findings');
  });

  // The controls: the same plugin, asked about a policy that blocks nothing, and not asked at all.
  it('publishes no such finding when the policy blocks nothing, or the settings lane was not asked', () => {
    const open = auditWithSettings(pluginDir, denyNothing);
    expect(open.plugin?.settings).toEqual({ compatible: true, conflicts: [] });
    expect(conflictsOf(open.report as unknown as Envelope)).toEqual([]);

    const compatOnly = parseYaml(runAuditCli(pluginDir, ['--compat']).stdout) as Envelope;
    expect(conflictsOf(compatOnly)).toEqual([]);
  });
});
