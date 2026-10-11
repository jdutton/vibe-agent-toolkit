/**
 * The npm lane's one seam: `npm pack` is a network call, so `downloadNpmPackage` becomes a
 * `vi.fn()` that `npmMocks` (in `install-family.ts`) points at the case's fixture tarball.
 *
 * Imported FIRST by each npm-lane matrix file, before anything that loads the install command:
 * the mock is registered as this module evaluates, ahead of the command importing `helpers.js`.
 */
import { vi } from 'vitest';

import type * as Helpers from '../../../src/commands/claude/plugin/helpers.js';

vi.mock('../../../src/commands/claude/plugin/helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Helpers>()),
  downloadNpmPackage: vi.fn(),
}));
