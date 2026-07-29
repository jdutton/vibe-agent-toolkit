/**
 * plugin.json merge.
 *
 * Precedence (spec section Design -> plugin.json merge):
 *   - CONFIG wins on: name, version, and the author subfields config can express
 *   - Author wins on: all other keys (keywords, repository, homepage, license, ...)
 *                     AND every author subfield config CANNOT express (url, ...)
 *   - description:    config.description ?? author.description ?? `${name} plugin`
 *
 * "VAT wins" is a misleading way to say this and the warnings below used to say
 * it: VAT invents nothing. `name` is the marketplace plugin entry's name and
 * the author's `name`/`email` are the marketplace `owner`, both straight out of
 * `vibe-agent-toolkit.config.yaml`. The config is the source of truth for plugin
 * identity precisely so a marketplace cannot ship plugins that disagree with it
 * about who published them. The warnings therefore name the winning value and
 * where it came from, so the reader can act on it.
 *
 * `author` is merged per SUBFIELD, not replaced wholesale, and the line is drawn
 * by what the config schema can express: marketplace `owner` has `name` and
 * `email`, so those two are config-owned — omitting `owner.email` publishes an
 * author with no email, deliberately. Every other subfield passes through from
 * the author's plugin.json. `author.url` is the case that forced this: Claude's
 * plugin.json spec supports it, VAT's config has no field for it, so overwriting
 * `author` wholesale DESTROYED the adopter's URL with no way to restore it. That
 * is data loss, not a precedence policy. A non-object `author` (npm's
 * "Name <email> (url)" string form, say) has no subfields to merge, so it is
 * replaced wholesale and warned about.
 *
 * Version resolution lives in `resolveVersion` (config > plugin.json > root) and
 * happens at the caller in `build.ts`. By the time `mergePluginJson` runs, the
 * value passed in `vat.version` IS the resolved answer — this function does no
 * additional precedence work for version.
 *
 * Mismatches on VAT-winning fields produce warnings — never errors.
 */

export interface VatGeneratedFields {
  name: string;
  /**
   * The resolved plugin version (already gone through the precedence chain in
   * `resolveVersion`). `undefined` only when all sources (config, plugin.json,
   * root package.json) are absent — in which case `version` is omitted from
   * the merged output entirely.
   */
  version: string | undefined;
  author: { name: string; email?: string };
}

export interface MergePluginJsonArgs {
  vat: VatGeneratedFields;
  configDescription: string | undefined;
  authorJson: Record<string, unknown> | undefined;
}

export interface MergePluginJsonResult {
  merged: Record<string, unknown>;
  /**
   * The merged `author` object — the same value as `merged.author`, surfaced
   * separately because it is ALSO what `marketplace.json`'s `plugins[].author`
   * publishes for this plugin. Regenerating that entry from the config `owner`
   * instead re-introduced the exact data loss this merge exists to prevent: the
   * passed-through subfields (`url`, ...) reached plugin.json but not the
   * marketplace listing, so the two manifests disagreed about the same author.
   */
  author: Record<string, unknown>;
  warnings: string[];
}

export interface ResolveVersionLogger {
  warn(message: string): void;
}

const VAT_OWNED_KEYS: ReadonlySet<string> = new Set(['name', 'version', 'author']);

/**
 * The `author` subfields VAT's config can express (marketplace `owner`) and
 * therefore owns. Ownership is by SCHEMA, not by presence: `owner.email` being
 * omitted means "this author publishes no email", so an email in plugin.json is
 * still overridden (and warned about) — the adopter has a config field for it.
 * Anything NOT listed here has no config field at all, so config cannot own it
 * and it passes through from plugin.json.
 */
const VAT_OWNED_AUTHOR_SUBFIELDS: ReadonlySet<string> = new Set(['name', 'email']);

/** The value if it is a plain (non-null, non-array) object, else undefined. */
function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The author's `author` object from plugin.json, when it is a mergeable object. */
function authoredAuthorObject(
  authorJson: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return authorJson ? asPlainObject(authorJson['author']) : undefined;
}

/**
 * Config-owned subfields from `owner`, plus every other subfield the author
 * declared. Config-owned keys are listed first so the published object reads
 * name/email-then-extras regardless of plugin.json's key order.
 */
function buildAuthorObject(
  vat: VatGeneratedFields,
  authorJson: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const passthrough: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(authoredAuthorObject(authorJson) ?? {})) {
    if (VAT_OWNED_AUTHOR_SUBFIELDS.has(k)) continue;
    passthrough[k] = v;
  }
  return {
    name: vat.author.name,
    ...(vat.author.email ? { email: vat.author.email } : {}),
    ...passthrough,
  };
}

function collectAuthorPassthrough(
  authorJson: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!authorJson) return out;
  for (const [k, v] of Object.entries(authorJson)) {
    if (VAT_OWNED_KEYS.has(k)) continue;
    if (k === 'description') continue;
    out[k] = v;
  }
  return out;
}

function collectWarnings(
  vat: VatGeneratedFields,
  authorJson: Record<string, unknown> | undefined,
  mergedAuthor: Record<string, unknown>,
): string[] {
  if (!authorJson) return [];
  const warnings: string[] = [];
  if ('name' in authorJson && authorJson['name'] !== vat.name) {
    warnings.push(
      `plugin.json "name" (${JSON.stringify(authorJson['name'])}) disagrees with the marketplace config, ` +
        `which declares "${vat.name}". Using the config value. ` +
        `Align plugin.json, or drop its "name" field — the config owns plugin identity.`,
    );
  }
  const authorWarning = authorFieldWarning(authorJson, mergedAuthor);
  if (authorWarning) warnings.push(authorWarning);
  return warnings;
}

/**
 * Warn only about author subfields CONFIG OWNS and the author disagreed on — the
 * passed-through ones are not a disagreement, they are the author's to set. Key
 * order is irrelevant, so reordering plugin.json cannot manufacture a warning.
 */
function authorFieldWarning(
  authorJson: Record<string, unknown>,
  mergedAuthor: Record<string, unknown>,
): string | undefined {
  if (!('author' in authorJson)) return undefined;
  const authored = asPlainObject(authorJson['author']);
  if (!authored) {
    return (
      `plugin.json "author" (${JSON.stringify(authorJson['author'])}) is not an object, so VAT cannot ` +
      `merge it — publishing ${JSON.stringify(mergedAuthor)} from the marketplace \`owner\` in ` +
      `vibe-agent-toolkit.config.yaml instead. Use the object form ` +
      `({ "name": ..., "email": ..., "url": ... }) to keep fields like "url": the config owns name/email, ` +
      `every other author field passes through.`
    );
  }
  const overridden = [...VAT_OWNED_AUTHOR_SUBFIELDS].filter(
    (key) => key in authored && authored[key] !== mergedAuthor[key],
  );
  if (overridden.length === 0) return undefined;
  const overriddenList = overridden.map((key) => JSON.stringify(key)).join(', ');
  return (
    `plugin.json "author" disagrees with the marketplace \`owner\` in vibe-agent-toolkit.config.yaml on ` +
    `${overriddenList} — publishing ${JSON.stringify(mergedAuthor)}. ` +
    `The config owns the author's name/email for every plugin in the marketplace; align plugin.json, or ` +
    `drop those fields from it. (Author fields the config cannot express, like "url", pass through ` +
    `untouched.)`
  );
}

/**
 * Resolve the effective plugin version using the precedence chain:
 *   marketplace-config-supplied version > plugin.json:version > root package.json version
 *
 * If both the config and plugin.json supply a version and they disagree, a warning is
 * emitted via the supplied logger (config still wins). When agreement holds — or when
 * one side is absent — no warning is emitted.
 *
 * Returns `undefined` only when all three sources are absent.
 */
export function resolveVersion(
  configEntry: { version?: string | undefined } | undefined,
  authorJson: { version?: string | undefined } | undefined,
  rootVersion: string | undefined,
  logger: ResolveVersionLogger = console,
): string | undefined {
  const config = configEntry?.version;
  const author = authorJson?.version;

  if (config && author && config !== author) {
    logger.warn(
      `Plugin version mismatch: marketplace config declares ${config}, ` +
        `plugin.json declares ${author}. Using config (${config}). ` +
        `Reconcile by removing one or the other.`,
    );
  }
  return config ?? author ?? rootVersion;
}

function resolveDescription(
  vat: VatGeneratedFields,
  configDescription: string | undefined,
  authorJson: Record<string, unknown> | undefined,
): string {
  const authorDescription =
    authorJson && typeof authorJson['description'] === 'string'
      ? authorJson['description']
      : undefined;
  return configDescription ?? authorDescription ?? `${vat.name} plugin`;
}

export function mergePluginJson(args: MergePluginJsonArgs): MergePluginJsonResult {
  const { vat, configDescription, authorJson } = args;

  const merged: Record<string, unknown> = collectAuthorPassthrough(authorJson);
  merged['name'] = vat.name;

  // Version is already resolved by the caller via resolveVersion.
  // Omit entirely when no source supplied a value.
  if (vat.version !== undefined) {
    merged['version'] = vat.version;
  }

  const author = buildAuthorObject(vat, authorJson);
  merged['author'] = author;
  merged['description'] = resolveDescription(vat, configDescription, authorJson);

  const warnings = collectWarnings(vat, authorJson, author);
  return { merged, author, warnings };
}
