/**
 * The type of `typescript.cjs` beside it: VAT's vendored copy of TypeScript's `lib/typescript.js`,
 * written there by `build` (`packages/dev-tools/src/vendor-typescript.ts`) from this package's
 * exact-pinned `typescript` devDependency. The copy is generated and gitignored; this declaration is
 * committed, so the loader typechecks on a fresh clone before the copy exists.
 */
import type * as ts from 'typescript';

export = ts;
