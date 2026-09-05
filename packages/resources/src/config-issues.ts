/**
 * Turning a failed `vibe-agent-toolkit.config.yaml` parse into something an
 * adopter can act on.
 *
 * ## Why this module exists
 *
 * `ResourcesConfigSchema` is `.strict()`, which is the right call — a
 * passthrough object ACCEPTS `cheks:` and then STRIPS it, so an unenforced rule
 * reads as a config that declared no rules. But strictness is only worth having
 * if the refusal is legible, and it was not. The two config readers in the
 * toolkit each formatted the same `ZodError` differently and neither named the
 * file:
 *
 * - `cli/utils/config-loader.ts` interpolated `error.message`, which in Zod 3 is
 *   a **JSON dump of the issue array**. Measured on a real adopter carrying
 *   `resources.metadata` — a key VAT removed and had been silently discarding
 *   for releases — all five verbs (`resources scan/validate/query/check`,
 *   `audit`) exited 2 in under a second with a raw JSON blob that never named
 *   the config path, never said the key had been removed, and offered no remedy.
 * - `resources/config-parser.ts` joined `path: message` pairs with commas, which
 *   is legible but says nothing more than Zod's own wording.
 *
 * ⚠️ **NOT every block under it is strict, and this docstring used to say
 * otherwise.** `ResourceCheckSchema`, `ValidationConfigSchema` and
 * `LinkAuthConfigSchema` are strict; `CollectionConfigSchema`,
 * `CollectionValidationSchema` and `ExternalUrlValidationSchema` are **not**, so
 * a misspelled key inside a collection is still accepted and stripped today.
 * That gap is left open deliberately — closing it is a second breaking change
 * for every adopter config and needs its own CHANGELOG note and its own adopter
 * run. `ResourcesConfigSchema`'s own docstring carries the same warning and ends
 * *"Do not 'restore' the old sentence"*; this module is where a maintainer
 * working on strictness actually lands, so the warning has to be here too. The
 * false sentence survived one round of fixing precisely because it lived in two
 * places and only one was corrected.
 *
 * ⛔ **The general rule this exists to serve:** tightening a schema from
 * passthrough to strict is a breaking change for every config in the wild, and
 * the blast radius is invisible from inside this repo, whose own config
 * obviously passes. Pair any such tightening with a real-adopter run, a
 * CHANGELOG entry, and an error that names the file and the remedy. This module
 * is the third of those.
 *
 * ## 🔑 The accepted-key list is DERIVED, never written down
 *
 * {@link objectSchemaAt} walks the *schema* to the path Zod complained about and
 * reads its `shape`. Adding, renaming or removing a config key moves the
 * suggestion list with zero human action, and there is no second list to fall
 * out of step with the first. When the walk cannot resolve the path — a union, a
 * shape this walker does not know — the clause is simply omitted rather than
 * guessed at.
 */

import { z } from 'zod';

/** How many issues are rendered before the tail is summarised. */
const MAX_RENDERED_ISSUES = 20;

/**
 * Strip the wrappers that sit between a declaration and the schema it describes.
 *
 * `resources` is a `ZodOptional<ZodObject>`, a collection's `validation` is a
 * `ZodOptional<ZodEffects<ZodObject>>`, and a walker that did not unwrap would
 * give up on the first optional key — which is every key in this config.
 *
 * @param schema - Any schema
 * @returns The innermost schema it wraps, or itself
 */
function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (
    schema instanceof z.ZodOptional
    || schema instanceof z.ZodNullable
    || schema instanceof z.ZodDefault
    || schema instanceof z.ZodCatch
    || schema instanceof z.ZodReadonly
  ) {
    return unwrapSchema(schema._def.innerType as z.ZodTypeAny);
  }
  if (schema instanceof z.ZodEffects) return unwrapSchema(schema.innerType() as z.ZodTypeAny);
  return schema;
}

/**
 * The object schema governing `path`, when the walk can reach one.
 *
 * Record and array segments are traversed by VALUE rather than by key, because
 * an issue path through `resources.collections.docs.include` names a collection
 * the schema never mentions — `collections` is a `ZodRecord`, so `docs` is data.
 *
 * @param root - The schema the document was parsed against
 * @param path - A Zod issue path, as reported
 * @returns The object schema at that path, or undefined when it is not an object
 *   or the walk met a shape this function does not model
 */
function objectSchemaAt(
  root: z.ZodTypeAny,
  path: readonly (string | number)[],
): z.ZodObject<z.ZodRawShape> | undefined {
  let current = unwrapSchema(root);
  for (const segment of path) {
    if (current instanceof z.ZodObject) {
      const shape = current.shape as Record<string, z.ZodTypeAny>;
      const next = shape[String(segment)];
      if (next === undefined) return undefined;
      current = unwrapSchema(next);
    } else if (current instanceof z.ZodRecord) {
      current = unwrapSchema(current.valueSchema as z.ZodTypeAny);
    } else if (current instanceof z.ZodArray) {
      current = unwrapSchema(current.element as z.ZodTypeAny);
    } else {
      return undefined;
    }
  }
  return current instanceof z.ZodObject ? current : undefined;
}

/** How a dotted path is spelled when the issue is about the document itself. */
const ROOT_LABEL = '(top level)';

/**
 * Render an issue path the way it is written in YAML.
 *
 * @param path - A Zod issue path
 * @returns A dotted path, or {@link ROOT_LABEL} for the empty path
 */
function dottedPath(path: readonly (string | number)[]): string {
  return path.length === 0 ? ROOT_LABEL : path.join('.');
}

/**
 * The remedy sentence for a key the schema does not have.
 *
 * States both causes because an adopter cannot tell them apart from the outside,
 * and the second one — a key VAT used to accept, took no notice of, and has now
 * started refusing — is the one that reads as VAT breaking for no reason unless
 * it is said out loud.
 *
 * @param accepted - The keys the schema does accept here, or undefined when the
 *   schema walk could not resolve the path
 * @returns The sentences that follow the key list
 */
function unrecognizedKeyRemedy(accepted: readonly string[] | undefined): string {
  const cause = 'It is either misspelled, or it was removed from VAT\'s schema in an'
    + ' earlier release — in which case VAT accepted it and silently discarded it,'
    + ' and now says so rather than letting you believe it took effect.'
    + ' Delete it, or correct the spelling.';
  if (accepted === undefined || accepted.length === 0) return cause;
  return `${cause} Accepted here: ${[...accepted].sort((a, b) => a.localeCompare(b)).join(', ')}.`;
}

/**
 * Render one issue as an indented block.
 *
 * @param issue - The issue
 * @param schema - The schema the document was parsed against, for key suggestions
 * @returns One or more lines, already indented
 */
function renderIssue(issue: z.ZodIssue, schema: z.ZodTypeAny | undefined): string {
  const where = dottedPath(issue.path);
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    const keys = issue.keys.map((key) => `"${key}"`).join(', ');
    const accepted = schema === undefined ? undefined : objectSchemaAt(schema, issue.path)?.keyof().options;
    const noun = issue.keys.length === 1 ? 'key' : 'keys';
    return `  ${where}: unrecognized ${noun} ${keys}\n      ${unrecognizedKeyRemedy(accepted)}`;
  }
  return `  ${where}: ${issue.message}`;
}

/**
 * The operator-facing message for a config file that parsed as YAML but failed
 * validation.
 *
 * @param error - What the schema refused
 * @param options - Rendering context
 * @param options.configPath - Absolute path of the file, named in the first line
 *   because an adopter running `vat audit` in a monorepo has several
 * @param options.schema - The schema it was parsed against, used to derive the
 *   accepted-key list; omit and that clause is left off
 * @returns A multi-line message, no trailing newline
 */
export function formatConfigValidationError(
  error: z.ZodError,
  options: { configPath?: string; schema?: z.ZodTypeAny } = {},
): string {
  const { configPath, schema } = options;
  const subject = configPath === undefined ? 'Invalid configuration' : `Invalid configuration in ${configPath}`;
  const shown = error.issues.slice(0, MAX_RENDERED_ISSUES);
  const lines = shown.map((issue) => renderIssue(issue, schema));
  const hidden = error.issues.length - shown.length;
  if (hidden > 0) lines.push(`  … and ${hidden} more issue(s)`);
  return `${subject}:\n${lines.join('\n')}`;
}
