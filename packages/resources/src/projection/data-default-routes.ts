/**
 * The `data` instance's default routes as globs, apart from their compiled matchers, so the config
 * schema can describe them without importing the router: `router.ts` compiles these, in this order,
 * and `project-config.ts` writes its description from them.
 */

import type { DataVariant } from '../schemas/projection-data.js';

/** One default route: the globs it matches and the variant it names. */
interface DataDefaultRoute {
  readonly globs: readonly string[];
  readonly variant: DataVariant;
}

/** The default routes, in the order they are asked; the first match names the variant. */
export const DEFAULT_DATA_ROUTE_GLOBS: readonly DataDefaultRoute[] = [
  { globs: ['**/package.json'], variant: 'json' },
  { globs: ['**/tsconfig*.json', '**/jsconfig*.json'], variant: 'jsonc' },
  { globs: ['**/pnpm-workspace.yaml'], variant: 'yaml' },
];
