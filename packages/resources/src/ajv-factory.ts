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
 * Construct an Ajv instance pre-registered with the URI-family formats VAT
 * schemas use. Use this anywhere downstream code compiles a schema that may
 * reference `format: "uri-reference"` (or `uri`, `iri`, `iri-reference`).
 *
 * @param options - Ajv options. Passed through unchanged — caller controls
 *   `allErrors`, `strict`, `allowUnionTypes`, `verbose`, etc.
 *
 * @example
 * import { createAjvWithUriFormats } from '@vibe-agent-toolkit/resources';
 *
 * const ajv = createAjvWithUriFormats({ allErrors: true });
 * const validate = ajv.compile(mySchemaWithUriReference);
 * if (!validate(data)) console.error(validate.errors);
 */
export function createAjvWithUriFormats(options: AjvOptions = {}): Ajv {
  const ajv = new Ajv(options);
  addFormats(ajv);
  // ajv-formats does not register `iri` / `iri-reference`. Adopters whose
  // schemas declare those would still hit "unknown format" under strict
  // mode. Register no-op validators — Ajv accepts the format token, and
  // semantic validation happens through resolveLocalHref / equivalent.
  ajv.addFormat('iri', true);
  ajv.addFormat('iri-reference', true);
  return ajv;
}
