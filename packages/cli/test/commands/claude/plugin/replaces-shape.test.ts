/**
 * Unit tests for what `vat claude plugin install` refuses in a package's `vat.replaces` (and in
 * a skill name) before it plans anything: `readPackageJson` refuses a `vat.replaces` of the
 * wrong shape, and `assertSkillEntryName` a name that is not one path segment.
 *
 * What `vat.replaces` then removes is part of the install's one plan: pinned on a real
 * filesystem by `test/integration/plugin-install-transaction.integration.test.ts`, by
 * claude-marketplace's `planPackageInstall` tests, and by the fault matrix.
 */

import { readFile } from 'node:fs/promises';

import { HOSTILE_NAMES } from '@vibe-agent-toolkit/utils/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readPackageJson } from '../../../../src/commands/claude/plugin/helpers.js';
import { assertSkillEntryName } from '../../../../src/commands/claude/plugin/install.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFile: vi.fn(),
}));

// `readPackageJson` asks whether the package.json is there before it reads it; the read is this
// test's (mocked above), so the probe answers for it.
vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  pathPresent: vi.fn(() => true),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assertSkillEntryName', () => {
  it.each(HOSTILE_NAMES)('refuses %j and names the origin', (name) => {
    expect(() => assertSkillEntryName(name, 'SKILL.md name')).toThrow(/SKILL\.md name/);
  });

  it('returns a single-segment name unchanged', () => {
    expect(assertSkillEntryName('my-skill', 'x')).toBe('my-skill');
    expect(assertSkillEntryName('..cache', 'x')).toBe('..cache');
  });
});

/** `readFile` answers every read with a package.json whose `vat.replaces` is `replaces`. */
function packageWith(replaces: unknown): void {
  vi.mocked(readFile).mockResolvedValue(JSON.stringify({ name: '@test/pkg', version: '1.0.0', vat: { replaces } }) as never);
}

describe('readPackageJson — vat.replaces shape', () => {
  it.each([
    ['a string flatSkills', { flatSkills: 'ab' }, 'vat.replaces.flatSkills'],
    ['a non-string flatSkills entry', { flatSkills: [123] }, 'vat.replaces.flatSkills.0'],
    ['a string plugins', { plugins: 'ab' }, 'vat.replaces.plugins'],
    ['an unknown key', { flatskills: ['ab'] }, 'flatskills'],
    ['a non-object', 'ab', 'vat.replaces'],
  ])('refuses %s as INPUT_UNREADABLE naming the package and the field', async (_label, replaces, field) => {
    packageWith(replaces);

    const read = readPackageJson('/pkg', { side: 'source', label: 'The package directory /pkg' });

    await expect(read).rejects.toMatchObject({ refusal: 'INPUT_UNREADABLE' });
    await expect(read).rejects.toThrow('@test/pkg');
    await expect(read).rejects.toThrow(field);
  });

  it('accepts the documented shape, and a package with no vat.replaces', async () => {
    packageWith({ plugins: ['p'], flatSkills: ['s'] });
    await expect(readPackageJson('/pkg', { side: 'source', label: 'The package directory /pkg' })).resolves.toMatchObject({ vat: { replaces: { plugins: ['p'], flatSkills: ['s'] } } });

    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ name: '@test/pkg', version: '1.0.0' }) as never);
    await expect(readPackageJson('/pkg', { side: 'source', label: 'The package directory /pkg' })).resolves.toMatchObject({ name: '@test/pkg' });
  });
});
