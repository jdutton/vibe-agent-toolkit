/**
 * Where `vat inventory` files a `SCAN_PATH_UNREADABLE` finding.
 *
 * A refused path inside the subject is located relative to it. A refused path
 * OUTSIDE the subject — a followed link, a cross-drive path on Windows — is
 * filed on the subject itself (`'.'`), and its absolute path stays out of the
 * finding (it remains in `data.inventory.parseErrors[]`). No extractor reached
 * from the CLI on POSIX produces such a row today, so the row is injected at
 * the one seam the command reads it through, `unreadableParseErrors`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type * as AgentSkillsModule from '@vibe-agent-toolkit/agent-skills';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { inventoryCommand } from '../../src/commands/inventory.js';
import { captureProcessExit } from '../test-doubles.js';

/** The refused paths the next run reports, or `undefined` to read the real inventory. */
const injected = vi.hoisted(() => ({ paths: undefined as string[] | undefined }));

vi.mock('@vibe-agent-toolkit/agent-skills', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSkillsModule>();
  return {
    ...actual,
    unreadableParseErrors: (inv: Parameters<typeof actual.unreadableParseErrors>[0]) =>
      injected.paths === undefined
        ? actual.unreadableParseErrors(inv)
        : injected.paths.map((path) => ({ path, message: `EACCES: permission denied, open '${path}'`, unreadable: true as const })),
  };
});

interface PublishedFinding {
  code: string;
  location?: string;
  message: string;
}

let scratch: string;
let plugin: string;

/** Run `vat inventory <plugin> --format json` and return its findings. */
async function findingsFor(paths: string[]): Promise<PublishedFinding[]> {
  injected.paths = paths;
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await captureProcessExit(() => inventoryCommand(plugin, { format: 'json' }));
    const document = JSON.parse(stdout.mock.calls.map((call) => String(call[0])).join('')) as { findings: PublishedFinding[] };
    return document.findings;
  } finally {
    stdout.mockRestore();
  }
}

describe('vat inventory locates an unreadable path against the subject', () => {
  beforeAll(() => {
    scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-inventory-location-'));
    plugin = safePath.join(scratch, 'plugin');
    mkdirSyncReal(safePath.join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(safePath.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p' }));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  afterEach(() => {
    injected.paths = undefined;
  });

  it('files a path inside the subject at its subject-relative location (control)', async () => {
    const findings = await findingsFor([safePath.join(plugin, 'skills', 'locked')]);

    expect(findings.map((f) => [f.code, f.location])).toEqual([['SCAN_PATH_UNREADABLE', 'skills/locked']]);
    expect(findings[0]?.message).toContain('(skills/locked: the OS refused the read');
  });

  it('files the subject directory itself at "."', async () => {
    const findings = await findingsFor([plugin]);

    expect(findings.map((f) => [f.code, f.location])).toEqual([['SCAN_PATH_UNREADABLE', '.']]);
    expect(findings[0]?.message).toContain('(.: the OS refused the read');
  });

  it('files a path outside the subject on the subject, and keeps its absolute path out of the finding', async () => {
    const outside = safePath.join(scratch, 'elsewhere', 'linked.md');
    const findings = await findingsFor([outside]);

    expect(findings.map((f) => [f.code, f.location])).toEqual([['SCAN_PATH_UNREADABLE', '.']]);
    expect(findings[0]?.message).toContain('(a path it links to outside the subject: the OS refused the read');
    expect(JSON.stringify(findings)).not.toContain(outside);
    expect(JSON.stringify(findings)).not.toContain('..');
  });
});
