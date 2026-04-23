/**
 * plugin.json merge.
 *
 * Precedence (spec section Design -> plugin.json merge):
 *   - VAT wins on:    name, version, author (shallow wholesale replace)
 *   - Author wins on: all other keys (keywords, repository, homepage, license, ...)
 *   - description:    config.description ?? author.description ?? `${name} plugin`
 *
 * Mismatches on VAT-winning fields produce warnings — never errors.
 */

export interface VatGeneratedFields {
  name: string;
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
  if (
    vat.version !== undefined &&
    'version' in authorJson &&
    authorJson['version'] !== vat.version
  ) {
    warnings.push(
      `plugin.json "version" mismatch: author value ${JSON.stringify(authorJson['version'])} ignored; using VAT-generated "${vat.version}".`,
    );
  }
  if ('author' in authorJson && !deepEqual(authorJson['author'], mergedAuthor)) {
    warnings.push(
      `plugin.json "author" mismatch: author-supplied value discarded; using VAT-generated author object.`,
    );
  }
  return warnings;
}

function resolveVersion(
  vat: VatGeneratedFields,
  authorJson: Record<string, unknown> | undefined,
): string | undefined {
  if (vat.version !== undefined) return vat.version;
  if (authorJson && typeof authorJson['version'] === 'string') return authorJson['version'];
  return undefined;
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

  const version = resolveVersion(vat, authorJson);
  if (version !== undefined) {
    merged['version'] = version;
  }

  merged['author'] = buildAuthorObject(vat);
  merged['description'] = resolveDescription(vat, configDescription, authorJson);

  const warnings = collectWarnings(vat, authorJson, merged['author']);
  return { merged, warnings };
}
