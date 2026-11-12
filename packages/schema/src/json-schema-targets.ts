import type { ZodTypeAny } from 'zod';

import { VatPackageMetadataSchema } from './package-metadata.js';
import { ValidationConfigSchema } from './validation-config.js';

/** One Zod schema and the `schemas/<name>.json` artifact generated from it. */
export interface JsonSchemaTarget {
  /** Basename of the emitted file, and the `definitions` key inside it. */
  readonly name: string;
  /** The Zod schema the artifact is generated from. */
  readonly schema: ZodTypeAny;
}

/**
 * Every JSON Schema this package ships under `schemas/`.
 *
 * 🔑 **A generated artifact is a second consumer of every schema edit, and it
 * fails SILENTLY.** `scripts/generate-json-schemas.ts` writes these files and
 * `test/emitted-json-schemas.test.ts` asserts on what it wrote; both read this
 * list, so a schema added to one is never missing from the other. The list used
 * to live only in the script, which meant the artifacts had no test at all and a
 * `severity` key space that stopped being constrained shipped unnoticed.
 */
export const JSON_SCHEMA_TARGETS: readonly JsonSchemaTarget[] = [
  { name: 'vat-package-metadata', schema: VatPackageMetadataSchema },
  { name: 'validation-config', schema: ValidationConfigSchema },
];
