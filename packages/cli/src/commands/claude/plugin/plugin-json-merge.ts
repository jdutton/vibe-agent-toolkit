/**
 * plugin.json merge.
 *
 * Precedence (spec section Design -> plugin.json merge):
 *   - VAT wins on:    name, version, author (shallow wholesale replace)
 *   - Author wins on: all other keys (keywords, repository, homepage, license, ...)
 *   - description:    config.description ?? author.description ?? `${name} plugin`
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
  warnings: string[];
}

export interface ResolveVersionLogger {
  warn(message: string): void;
}

const VAT_OWNED_KEYS: ReadonlySet<string> = new Set(['name', 'version', 'author']);

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildAuthorObject(vat: VatGeneratedFields): Record<string, unknown> {
  return vat.author.email
    ? { name: vat.author.name, email: vat.author.email }
    : { name: vat.author.name };
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
  mergedAuthor: unknown,
): string[] {
  if (!authorJson) return [];
  const warnings: string[] = [];
  if ('name' in authorJson && authorJson['name'] !== vat.name) {
    warnings.push(
      `plugin.json "name" mismatch: author value ${JSON.stringify(authorJson['name'])} ignored; using VAT-generated "${vat.name}".`,
    );
  }
  if ('author' in authorJson && !deepEqual(authorJson['author'], mergedAuthor)) {
    warnings.push(
      `plugin.json "author" mismatch: author-supplied value discarded; using VAT-generated author object.`,
    );
  }
  return warnings;
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

  merged['author'] = buildAuthorObject(vat);
  merged['description'] = resolveDescription(vat, configDescription, authorJson);

  const warnings = collectWarnings(vat, authorJson, merged['author']);
  return { merged, warnings };
}
