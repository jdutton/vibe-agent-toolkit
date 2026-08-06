/* eslint-disable security/detect-non-literal-fs-filename -- test sandbox paths derived from tmp dirs */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectHostedIncompatibleShape } from '../../src/validators/plugin-hosted-shape.js';

const SHEBANG = '#!/usr/bin/env node\n';
const CLI_FILE = 'example-cli.mjs';

/** Create `bin/` under a temp plugin dir holding the given file names. */
function seedBin(pluginDir: string, ...names: string[]): void {
  const binDir = safePath.join(pluginDir, 'bin');
  mkdirSyncReal(binDir, { recursive: true });
  for (const name of names) {
    writeFileSync(safePath.join(binDir, name), SHEBANG);
  }
}

describe('detectHostedIncompatibleShape', () => {
  let pluginDir: string;

  beforeEach(() => {
    pluginDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-hosted-shape-'));
  });

  afterEach(() => {
    rmSync(pluginDir, { recursive: true, force: true });
  });

  it('reports nothing when the plugin has no bin/ directory', () => {
    expect(detectHostedIncompatibleShape(pluginDir)).toEqual([]);
  });

  it('reports nothing for an empty bin/ directory', () => {
    mkdirSyncReal(safePath.join(pluginDir, 'bin'), { recursive: true });
    expect(detectHostedIncompatibleShape(pluginDir)).toEqual([]);
  });

  it('reports nothing when bin is a file rather than a directory', () => {
    writeFileSync(safePath.join(pluginDir, 'bin'), 'not a directory');
    expect(detectHostedIncompatibleShape(pluginDir)).toEqual([]);
  });

  it('reports nothing when executables live in a non-PATH directory such as cli/', () => {
    const cliDir = safePath.join(pluginDir, 'cli');
    mkdirSyncReal(cliDir, { recursive: true });
    writeFileSync(safePath.join(cliDir, CLI_FILE), SHEBANG);
    expect(detectHostedIncompatibleShape(pluginDir)).toEqual([]);
  });

  it('emits PLUGIN_TOPLEVEL_BIN_DIR at warning severity', () => {
    seedBin(pluginDir, CLI_FILE);

    const issues = detectHostedIncompatibleShape(pluginDir);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('PLUGIN_TOPLEVEL_BIN_DIR');
    expect(issues[0]?.severity).toBe('warning');
    expect(issues[0]?.message).toContain(`bin/${CLI_FILE}`);
    expect(issues[0]?.location).toBe(safePath.join(pluginDir, 'bin'));
  });

  it('points at scripts/ as the documented alternative', () => {
    seedBin(pluginDir, CLI_FILE);

    expect(detectHostedIncompatibleShape(pluginDir)[0]?.message).toContain('scripts/');
  });

  it('names up to three entries and elides the rest', () => {
    seedBin(pluginDir, 'a.mjs', 'b.mjs', 'c.mjs', 'd.mjs', 'e.mjs');

    const message = detectHostedIncompatibleShape(pluginDir)[0]?.message ?? '';

    expect(message).toContain('(bin/a.mjs, bin/b.mjs, bin/c.mjs, +2 more)');
  });
});
