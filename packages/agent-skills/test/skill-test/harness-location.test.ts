import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertSafeWorkdir,
  deriveHarnessKey,
  HarnessLocationError,
  resolveHarnessRoot,
} from '../../src/skill-test/harness-location.js';

describe('deriveHarnessKey', () => {
  it('is deterministic for the same sorted skill set', () => {
    expect(deriveHarnessKey(['b', 'a'])).toBe(deriveHarnessKey(['a', 'b']));
  });

  it('sanitizes names (no path separators leak into the key)', () => {
    const key = deriveHarnessKey(['../evil', 'ok']);
    expect(key).not.toContain('/');
    expect(key).not.toContain('..');
  });

  it('rejects empty skill set', () => {
    expect(() => deriveHarnessKey([])).toThrow();
  });
});

describe('resolveHarnessRoot', () => {
  it('places the harness under <tmp>/vat-skill-test/<key>', () => {
    const root = resolveHarnessRoot(['a'], '/tmp');
    // eslint-disable-next-line sonarjs/publicly-writable-directories -- hardcoded /tmp test path for API testing, not system security concern
    expect(root.startsWith('/tmp/vat-skill-test/')).toBe(true);
  });
});

describe('assertSafeWorkdir', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-workdir-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('passes a clean directory', () => {
    expect(() => assertSafeWorkdir(dir)).not.toThrow();
  });

  it('refuses a dir with CLAUDE.md in its ancestry (exit 2)', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture setup, controlled directory
    writeFileSync(safePath.join(dir, 'CLAUDE.md'), '# ambient', 'utf8');
    const child = safePath.join(dir, 'sub');
    mkdirSyncReal(child);
    expect(() => assertSafeWorkdir(child)).toThrow(HarnessLocationError);
  });

  it('refuses a dir with .claude/ in its ancestry (exit 2)', () => {
    mkdirSyncReal(safePath.join(dir, '.claude'));
    const child = safePath.join(dir, 'sub');
    mkdirSyncReal(child);
    expect(() => assertSafeWorkdir(child)).toThrow(HarnessLocationError);
  });

  it('HarnessLocationError carries exitCode 2', () => {
    expect.assertions(1);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test fixture setup, controlled directory
    writeFileSync(safePath.join(dir, 'CLAUDE.md'), 'x', 'utf8');
    try { assertSafeWorkdir(dir); } catch (e) { expect((e as HarnessLocationError).exitCode).toBe(2); }
  });
});
