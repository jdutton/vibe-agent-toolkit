/**
 * The npm lane's one seam: `npm pack` is a network call, so `packNpmPackage` becomes a
 * `vi.fn()` that `npmMocks` (in `install-family.ts`) points at the case's fixture tarball.
 * Everything after the download — the extraction included — is the real code.
 *
 * Imported FIRST by each npm-lane matrix file, before anything that loads the install command:
 * the mock is registered as this module evaluates, ahead of the command importing `npm-pack.js`.
 */
import { vi } from 'vitest';

vi.mock('../../../src/commands/claude/plugin/npm-pack.js', () => ({
  packNpmPackage: vi.fn(),
}));
