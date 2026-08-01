/**
 * Ajv factory for adopters consuming VAT-generated schemas.
 *
 * VAT's frontmatter walker treats `format: "uri-reference"` (plus `uri`,
 * `iri`, `iri-reference`) as first-class URI families and validates the
 * referenced files via {@link import('./utils.js').resolveLocalHref}, not via
 * Ajv. But adopters consuming the same schemas with vanilla
 * `new Ajv(...)` hit Ajv's default strict mode, which upgrades
 * `unknown format "uri-reference" ignored` from a warning to a thrown error.
 *
 * This helper returns an Ajv instance with the standard JSON Schema format
 * vocabulary registered (via `ajv-formats`) plus no-op shims for
 * `iri` / `iri-reference` (which `ajv-formats` does not ship). All
 * URI-family schemas compile cleanly under strict mode.
 */

import { Ajv, type Options as AjvOptions } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
// ajv-formats is a CJS module published with `module.exports = formatsPlugin`
// plus an `exports.default` alias. Under NodeNext module resolution the
// default import is typed as the namespace object (not callable), even
// though the runtime value IS the plugin function. The `.default ??
// namespace` pattern below resolves both at type level and runtime.
import * as ajvFormatsModule from 'ajv-formats';

type AddFormatsFn = (ajv: Ajv) => Ajv;

const addFormats: AddFormatsFn =
  (ajvFormatsModule as unknown as { default?: AddFormatsFn }).default ??
  (ajvFormatsModule as unknown as AddFormatsFn);

/**
 * `$schema` dialect → the Ajv build carrying that draft's meta-schema, keyed by
 * the draft path segment so both URI spellings select the same build.
 *
 * `canonical` is the exact URI Ajv registers the meta-schema under, which is
 * always `https`. It is needed to alias the `http` spelling — see
 * {@link aliasHttpDialect}.
 */
const DIALECT_BUILDS: ReadonlyArray<{ marker: string; canonical: string; build: typeof Ajv }> = [
  {
    marker: '/draft/2020-12/',
    canonical: 'https://json-schema.org/draft/2020-12/schema',
    build: Ajv2020 as unknown as typeof Ajv,
  },
  {
    marker: '/draft/2019-09/',
    canonical: 'https://json-schema.org/draft/2019-09/schema',
    build: Ajv2019 as unknown as typeof Ajv,
  },
];

/** The dialect entry a schema's `$schema` selects, or undefined for draft-07 and older. */
function dialectFor(schema: object): (typeof DIALECT_BUILDS)[number] | undefined {
  const dialect = (schema as { $schema?: unknown }).$schema;
  if (typeof dialect !== 'string') return undefined;
  return DIALECT_BUILDS.find(({ marker }) => dialect.includes(marker));
}

/**
 * Register the `http` spelling of a dialect URI as an alias for the `https` one.
 *
 * Selecting the right build is necessary but not sufficient. Ajv registers each
 * meta-schema under its canonical `https` `$id` only, and resolves a schema's
 * `$schema` by exact string match — so `http://json-schema.org/draft/2020-12/schema`
 * still fails inside Ajv with the same "no schema with key or ref" error even once
 * Ajv2020 is doing the compiling. The `http` spelling is not canonical for 2019-09
 * or 2020-12 (it was for draft-07, which is where the habit comes from), but it is
 * unambiguous in intent, and this project's rule for reading the outside world is
 * to be liberal. Aliasing is preferred over rewriting the caller's `$schema`, which
 * would mutate an input we do not own.
 */
function aliasHttpDialect(ajv: Ajv, canonical: string): void {
  const httpSpelling = canonical.replace(/^https:/, 'http:');
  if (ajv.getSchema(httpSpelling)) return;
  const meta = ajv.getSchema(canonical)?.schema;
  if (meta !== undefined) ajv.addMetaSchema(meta as object, httpSpelling);
}

/**
 * Construct an Ajv instance able to compile `schema`, pre-registered with the
 * URI-family formats VAT schemas use. Use this anywhere downstream code
 * compiles a schema that may reference `format: "uri-reference"` (or `uri`,
 * `iri`, `iri-reference`).
 *
 * **The schema is a required argument because the correct Ajv build cannot be
 * chosen without it.** VAT compiles JSON Schemas it does not own — an adopter's
 * collection `frontmatterSchema` is arbitrary external input — and Ajv's default
 * export carries only the draft-07 and older meta-schemas. A schema declaring
 * `"$schema": "https://json-schema.org/draft/2020-12/schema"` (the current
 * standard, and what most generators emit today) failed to compile at all under
 * it, surfacing as a `FRONTMATTER_SCHEMA_ERROR` at **error** severity for every
 * file in the collection: `no schema with key or ref ".../draft/2020-12/schema"`.
 * The remediation that message implies — fix your schema — was wrong; the schema
 * was valid and VAT could not read it. Per this project's Postel's-law rule,
 * reading the outside world is the liberal direction.
 *
 * @param schema - The schema about to be compiled. Only its `$schema` is read.
 * @param options - Ajv options. Passed through unchanged — caller controls
 *   `allErrors`, `strict`, `allowUnionTypes`, `verbose`, etc.
 *
 * @example
 * import { createAjvWithUriFormats } from '@vibe-agent-toolkit/resources';
 *
 * const ajv = createAjvWithUriFormats(mySchemaWithUriReference, { allErrors: true });
 * const validate = ajv.compile(mySchemaWithUriReference);
 * if (!validate(data)) console.error(validate.errors);
 */
export function createAjvWithUriFormats(schema: object, options: AjvOptions = {}): Ajv {
  const dialect = dialectFor(schema);
  const ajv = new (dialect?.build ?? Ajv)(options);
  if (dialect) aliasHttpDialect(ajv, dialect.canonical);
  addFormats(ajv);
  // ajv-formats does not register `iri` / `iri-reference`. Adopters whose
  // schemas declare those would still hit "unknown format" under strict
  // mode. Register no-op validators — Ajv accepts the format token, and
  // semantic validation happens through resolveLocalHref / equivalent.
  ajv.addFormat('iri', true);
  ajv.addFormat('iri-reference', true);
  return ajv;
}
