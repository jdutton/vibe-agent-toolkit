/**
 * Turning a failed `vibe-agent-toolkit.config.yaml` parse into something an
 * adopter can act on.
 *
 * ## Why this module exists
 *
 * `ResourcesConfigSchema` is `.strict()`, which is the right call — a
 * passthrough object ACCEPTS `cheks:` and then STRIPS it, so an unenforced rule
 * reads as a config that declared no rules. But strictness is only worth having
 * if the refusal is legible, and it was not. The **three** config readers in the
 * toolkit each formatted the same `ZodError` differently and none named the
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
 * - `cli/commands/skill/test/configure.ts` called `ProjectConfigSchema.safeParse`
 *   directly and interpolated the same JSON dump. ⚠️ This sentence used to say
 *   "the two config readers", and the count was the defect: the third reader was
 *   invisible to whoever fixed the other two, so `vat skill test configure`
 *   went on refusing an unknown key and printing the blob for a whole release
 *   after both defects were declared dead. **Count the `safeParse` call sites
 *   before trusting this list** — `git grep 'ProjectConfigSchema'` is the check.
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

/**
 * Reorder issues so the ones that actually REFUSE the config are rendered first.
 *
 * 🚨 The defect this exists to stop. {@link formatConfigValidationError} caps the
 * rendered list at {@link MAX_RENDERED_ISSUES}, while `onlyUnknownKeys` is
 * computed over ALL of them. A config carrying 25 unknown keys and one
 * `test.concurrency: "four"` produced 26 issues with the type error at position
 * 26 — so the thrown message was 20 unrecognized-key blocks, each ending "Delete
 * it, or correct the spelling.", plus "… and 6 more issue(s)". The adopter was
 * told the config was refused, shown nothing but complaints about keys that are
 * explicitly NO LONGER FATAL, and handed a remedy that could not lift the
 * refusal. The word `concurrency` never appeared.
 *
 * Sorting is cheaper and safer than raising the cap: the cap exists so a
 * thousand-issue config does not scroll the terminal, and raising it just moves
 * the same hole further out. What the cap must never hide is the issue that
 * decided the outcome.
 *
 * @param issues - The issues from a failed strict parse, in Zod's order
 * @returns The same issues, every non-`unrecognized_keys` one first, each
 *   group's relative order preserved
 */
function fatalIssuesFirst(issues: readonly z.ZodIssue[]): z.ZodIssue[] {
  const isUnknownKey = (issue: z.ZodIssue): boolean => issue.code === z.ZodIssueCode.unrecognized_keys;
  return [...issues.filter((issue) => !isUnknownKey(issue)), ...issues.filter(isUnknownKey)];
}

/**
 * Remove exactly the keys a strict schema refused, so the document can be
 * re-parsed as the adopter's config minus the parts VAT has no field for.
 *
 * Driven by the ISSUES themselves rather than by a hand-kept list of retired
 * key names: whatever the schema rejected is what gets dropped, so this cannot
 * drift away from the schema the way a list would.
 *
 * @param raw - The parsed YAML document (not mutated)
 * @param issues - The issues from the failed strict parse
 * @returns A copy with every unrecognized key deleted
 */
function withoutUnrecognizedKeys(raw: unknown, issues: readonly z.ZodIssue[]): unknown {
  const copy = structuredClone(raw);
  for (const issue of issues) {
    if (issue.code !== z.ZodIssueCode.unrecognized_keys) continue;
    let node: unknown = copy;
    for (const segment of issue.path) {
      if (node === null || typeof node !== 'object') break;
      node = (node as Record<string | number, unknown>)[segment];
    }
    if (node === null || typeof node !== 'object') continue;
    for (const key of issue.keys) {
      delete (node as Record<string, unknown>)[key];
    }
  }
  return copy;
}

/**
 * Parse a config, treating an UNKNOWN KEY as a warning and anything else as a
 * refusal.
 *
 * ## Why unknown keys stopped being fatal
 *
 * A key VAT does not have is a key VAT was **already ignoring**. Before the
 * schema went strict it was silently stripped; going strict turned years of
 * silent acceptance into a hard exit for a field that never did anything. That
 * lands on commands which do not even read the section involved — a real
 * adopter's `resources.metadata` blocked `vat claude org skills install`, which
 * loads config only to decide which eval suites to withhold, and blocked it in
 * every worktree at once. The refusal was legible (see
 * {@link formatConfigValidationError}) and still wrong: legibility is not the
 * same as proportionality.
 *
 * ⚠️ **Only unrecognized keys are downgraded.** A missing required field, a
 * wrong type, a bad enum — anything that means VAT would act on a config it
 * misread — still throws. The distinction is exactly the one the old behaviour
 * collapsed: "I do not know this word" is not "I misunderstood your
 * instruction".
 *
 * 🔑 The warning is a REQUIRED callback, not an optional one. An optional sink
 * invites callers to omit it, and a config silently losing keys is the failure
 * the strictness was introduced to end — this keeps the message while dropping
 * the exit code.
 *
 * @param schema - The strict schema to parse against
 * @param raw - The parsed YAML document
 * @param onUnknownKeys - Receives the rendered warning when keys were dropped
 * @param options - Rendering context for any message produced
 * @param options.configPath - Absolute path, named in every message
 * @returns The validated config, with unrecognized keys removed
 * @throws Error when the config fails for any reason other than unknown keys
 */
export function parseConfigAllowingUnknownKeys<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
  onUnknownKeys: (message: string) => void,
  options: { configPath?: string } = {},
): z.infer<S> {
  const strict = schema.safeParse(raw);
  if (strict.success) return strict.data;

  const { configPath } = options;
  const onlyUnknownKeys = strict.error.issues.every(
    (issue) => issue.code === z.ZodIssueCode.unrecognized_keys,
  );
  if (!onlyUnknownKeys) {
    // Rendered from a REORDERED issue list, so the issue that made the config
    // fatal survives the cap — see {@link fatalIssuesFirst}.
    throw new Error(
      formatConfigValidationError(new z.ZodError(fatalIssuesFirst(strict.error.issues)), {
        ...options,
        schema,
      }),
    );
  }

  const formatted = formatConfigValidationError(strict.error, { ...options, schema });
  const relaxed = schema.safeParse(withoutUnrecognizedKeys(raw, strict.error.issues));
  // Belt and braces: if dropping the refused keys does not produce a valid
  // config, the original diagnosis was wrong and the refusal stands. Reached
  // only if a schema rejects a key AND depends on it, which no schema here
  // does — but guessing on that would be exactly the assumption this file was
  // written to stop making.
  //
  // The extra sentence is not decoration: `formatted` is a pure unknown-keys
  // message whose every remedy reads "delete it", and deleting is precisely what
  // has just been TRIED and failed. Shipping it unqualified would hand an
  // adopter a fix that provably does not work, with nothing to say the tool
  // knows that.
  if (!relaxed.success) {
    throw new Error(
      `${formatted}\n  Dropping those keys did not make the config valid; the diagnosis above is`
      + ' incomplete.',
    );
  }

  const where = configPath === undefined ? '' : ` (${configPath})`;
  onUnknownKeys(
    `${formatted}\n  Ignoring the unknown key(s) and continuing: VAT was already`
    + ' discarding them, so this is a warning rather than a refusal. Delete them to'
    + ` silence this${where}.`,
  );
  return relaxed.data;
}
