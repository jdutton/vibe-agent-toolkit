/** I0 absence-cause seeds: one test per seed of `SYSTEM_SEEDS['extent']` in `../helpers/absence-seeds.ts`. */

import { it } from 'vitest';

import { seedFile } from '../helpers/absence-seeds.js';

for (const seed of seedFile('extent', import.meta.url)) it.skipIf(seed.unplantable)(seed.title, seed.run);
