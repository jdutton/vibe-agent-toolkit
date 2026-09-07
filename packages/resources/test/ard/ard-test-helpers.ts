/**
 * Shared fixtures for the ARD emission suite.
 *
 * Extracted on the first repeat rather than the third: three ARD test files
 * need the same vendored-schema oracle and the same minimal surface, and jscpd
 * runs against a zero baseline.
 */

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { safePath } from '@vibe-agent-toolkit/utils';
import type { ValidateFunction } from 'ajv';

import { createAjvWithUriFormats } from '../../src/ajv-factory.js';
import type { ArdSurface } from '../../src/ard/index.js';
import type { ArdConfig } from '../../src/schemas/project-config.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The vendored upstream schema, read from `docs/external/ard/`.
 *
 * Read from the repo copy rather than a fixture duplicate: a second copy would
 * be a second thing to refresh, and the whole point of vendoring is that
 * exactly one copy exists (see `docs/external/ard/README.md`).
 */
export const VENDORED_ARD_SCHEMA_PATH = safePath.resolve(
  HERE,
  '../../../..',
  'docs/external/ard/ard-entry.schema.json'
);

interface VendoredSchema {
  readonly $id: string;
  readonly [key: string]: unknown;
}

export function loadVendoredArdSchema(): VendoredSchema {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derives from import.meta.url, not from input
  return JSON.parse(readFileSync(VENDORED_ARD_SCHEMA_PATH, 'utf-8')) as VendoredSchema;
}

export interface ArdOracle {
  /** Validates one ARD entry against `$defs/ArdEntry`. */
  readonly validateEntry: ValidateFunction;
  /** Validates a whole manifest against `$defs/ArdManifest`. */
  readonly validateManifest: ValidateFunction;
  /** Human-readable Ajv errors from the last call on `validate`. */
  errorsOf(validate: ValidateFunction): string;
}

/**
 * Compile the vendored schema through the shared Ajv factory.
 *
 * ⛔ Never construct Ajv directly here, and never hand-write a JSON Schema for
 * anything Zod already models. This helper's whole job is to reach the ONE
 * externally-authored authority.
 */
export function createArdOracle(): ArdOracle {
  const schema = loadVendoredArdSchema();
  const ajv = createAjvWithUriFormats(schema, { allErrors: true, strict: false });
  ajv.addSchema(schema);
  const validateEntry = ajv.getSchema(schema.$id);
  const validateManifest = ajv.getSchema(`${schema.$id}#/$defs/ArdManifest`);
  if (!validateEntry || !validateManifest) {
    throw new Error(
      'Vendored ARD schema did not expose ArdEntry/ArdManifest — the oracle is not wired.'
    );
  }
  return {
    validateEntry,
    validateManifest,
    errorsOf: (validate) =>
      (validate.errors ?? [])
        .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`)
        .join('; '),
  };
}

/** Minimal config: publisher only, which is all `ArdConfigSchema` requires. */
export const MINIMAL_ARD_CONFIG: ArdConfig = { publisher: 'example.com' };

/** Config that produces `url` entries rather than inline `data`. */
export const URL_ARD_CONFIG: ArdConfig = {
  publisher: 'example.com',
  baseUrl: 'https://example.com/catalog',
};

/** A skill surface carrying only what a caller must always supply. */
export const MINIMAL_SKILL_SURFACE: ArdSurface = {
  kind: 'skill',
  name: 'vat-skill-authoring',
  displayName: 'VAT Skill Authoring',
  data: { note: 'inline artifact document' },
};
