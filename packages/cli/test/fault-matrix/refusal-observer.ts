/**
 * The refusal path's one seam for the fault matrix: which thrown value a published refusal was
 * built from. The report carries only the code and the message; invariant I8 needs the value
 * itself, to know whether the verb classified the fault (`FsFaultError`) and how.
 *
 * Every refusal's human half goes through `errorMessageOf` (`document-writer`'s `announceRefusal`)
 * just before the verb exits, so wrapping it records the value: the last one handed over before
 * the first exit is the refusal's. `runVerb` reads that trail (`refusal-trail.ts`); the matrix fails a refused
 * run the trail cannot explain, so a seam that stopped seeing refusals cannot make I8 vacuous.
 *
 * Imported FIRST by each case module, before anything that loads a command: the mock is registered
 * as this module evaluates, ahead of any command importing `command-refusal.js`.
 */
import { vi } from 'vitest';

import type * as CommandRefusal from '../../src/utils/command-refusal.js';

vi.mock('../../src/utils/command-refusal.js', async (importOriginal) => {
  const original = await importOriginal<typeof CommandRefusal>();
  // A factory runs ahead of this module's own imports, so the trail is reached the way vitest allows: imported inside it.
  const { refusalTrail } = await import('./refusal-trail.js');
  return {
    ...original,
    errorMessageOf: (error: unknown): string => {
      refusalTrail.push(error);
      return original.errorMessageOf(error);
    },
  };
});
