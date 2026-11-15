/**
 * The one way the verdict facet reads a YAML input file (subjects, deltas):
 * read, parse, validate against a strict schema — and refuse, naming the file
 * and every issue, rather than throw.
 */

import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';

import { describeIssues, messageOf } from '../../harness/dumps.js';

/** A validated value, or why there is none. */
export type Validated<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: string };

/**
 * Validate an already-read document.
 *
 * @param schema - The strict schema
 * @param value - The document's root value
 * @param what - What the document is, for the refusal ("a verdict subjects file")
 * @returns The parsed value, or a refusal naming every issue
 */
export function validateDocument<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, what: string): Validated<T> {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, refusal: `REFUSED: not ${what} — ${describeIssues(parsed.error)}` };
}

/**
 * Read a YAML file and validate it.
 *
 * @param file - The file
 * @param schema - The strict schema
 * @param what - What the document is, for the refusal
 * @returns The parsed value, or a refusal
 */
export function readYamlDocument<T>(file: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, what: string): Validated<T> {
  let value: unknown;
  try {
    value = parseYaml(readFileSync(file, 'utf-8')) as unknown;
  } catch (error) {
    return { ok: false, refusal: `REFUSED: cannot read ${what} at '${file}': ${messageOf(error)}` };
  }
  return validateDocument(schema, value, what);
}
