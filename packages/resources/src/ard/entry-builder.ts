/**
 * Turning a VAT surface into an ARD entry.
 *
 * ## What is derived and what is authored
 *
 * | Field | Source |
 * |---|---|
 * | `identifier`, `displayName`, `type`, `url`, `version`, `updatedAt`, `description`, `tags` | **derived** from the surface VAT already holds |
 * | `capabilities`, `representativeQueries` | **authored**, read from `ard.entries.<name>` and nowhere else |
 *
 * ⚠️ **`representativeQueries` is never generated.** The ARD spec says an entry
 * without it "cannot be found by search, which is what distinguishes an ARD
 * entry from a bare catalog entry", which makes synthesising a plausible set
 * from a skill description tempting. A wrong representative query is worse than
 * a missing one: it makes a resource discoverable for the wrong task, and
 * unlike a broken link nothing downstream ever reports it. ARD's own
 * conformance tester treats absence as a **warning** (§D.2), so emitting
 * without them is exactly conformant and honest about what is missing. A
 * *proposal* a human confirms is acceptable; silent generation is not.
 */

import type { z } from 'zod';

import type { ArdConfig, ArdEntryOverrides } from '../schemas/project-config.js';

import {
  ArdEntrySchema,
  isArdBaseUrl,
  isArdNameSegment,
  isArdPublisherDomain,
  isArdUrlPath,
  type ArdEntry,
} from './entry-schema.js';
import { defaultArdNamespace, deriveArdMediaType, type ArdSurfaceKind } from './surface.js';

/**
 * One VAT surface, described in the terms an ARD entry needs.
 *
 * Everything optional here is optional because VAT may or may not hold it for a
 * given surface — never because an author may supply it. Author-supplied fields
 * live in {@link ArdEntryOverrides}.
 */
export interface ArdSurface {
  readonly kind: ArdSurfaceKind;
  /** The config key. Becomes the `<name>` URN segment and the override key. */
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly version?: string;
  /** ISO 8601 timestamp of the artifact's last modification. */
  readonly updatedAt?: string;
  readonly tags?: readonly string[];
  /** Path appended to `ard.baseUrl` to form `url`. Ignored when no baseUrl is configured. */
  readonly urlPath?: string;
  /** The complete artifact document, used when no `url` can be formed. */
  readonly data?: Record<string, unknown>;
}

/**
 * A surface could not be turned into a conformant entry.
 *
 * Always a hard failure, never a skip: an entry VAT half-derived would advertise
 * a resource under a value nobody chose.
 */
export class ArdDerivationError extends Error {
  readonly surfaceName: string;
  readonly kind: ArdSurfaceKind;

  constructor(surface: Pick<ArdSurface, 'kind' | 'name'>, message: string) {
    super(`ARD entry "${surface.name}" (${surface.kind}): ${message}`);
    this.name = 'ArdDerivationError';
    this.surfaceName = surface.name;
    this.kind = surface.kind;
  }
}

type ArdEntryDraft = z.input<typeof ArdEntrySchema>;

/**
 * The `ard.entries` key that names exactly one surface.
 *
 * 🚨 `skills.config`, `claude.marketplaces` and `okf.bundles` are three
 * INDEPENDENT key spaces, so a bare name is not an identity — a config
 * declaring a skill *and* an OKF bundle both called `knowledge` had a single
 * `ard.entries.knowledge` block, and every field in it reached both. The skill
 * silently lost its coined `application/ai-skill+md` and was published as an
 * OKF bundle at exit 0. `capabilities` and `representativeQueries` bleed the
 * same way, and a wrong representative query is the failure this module's
 * docstring calls worse than a missing one.
 *
 * The qualified form `<kind>:<name>` is the precise key. `:` is outside
 * {@link ARD_NAME_SEGMENT_PATTERN}, so a qualified key can never collide with a
 * bare one. The bare form stays legal because it is unambiguous for the
 * overwhelming majority of configs, where a name occurs in one key space only;
 * {@link assertUnambiguousOverrideKeys} refuses it exactly when it is not.
 */
export function ardEntryOverrideKey(kind: ArdSurfaceKind, name: string): string {
  return `${kind}:${name}`;
}

/**
 * One `ard.entries` key, read as a config key rather than as a property.
 *
 * 🚨 `entries[name]` reads through the prototype. `z.record` yields a
 * plain-prototype object, so `entries.toString` is a FUNCTION rather than
 * `undefined` — and the ambiguity gate, which asked exactly that question,
 * exited 1 on two surfaces named `toString` while naming a config key the file
 * does not contain. Every lookup in this lane goes through here so the class
 * cannot come back one call site at a time.
 */
function readOverride(
  entries: Readonly<Record<string, ArdEntryOverrides>>,
  key: string
): ArdEntryOverrides | undefined {
  return Object.hasOwn(entries, key) ? entries[key] : undefined;
}

/**
 * The override block that applies to one surface, qualified key first.
 *
 * 🔑 The precedence is the whole point and it lives HERE, once: the CLI's
 * surface collector used to carry its own copy of the same `??`, and neither
 * copy was pinned — two mutations reversing the order to bare-first stayed
 * green. A single definition means one test can decide it for every caller.
 *
 * Qualified-first, because `<kind>:<name>` names exactly one surface while a
 * bare name names a *name* across three independent key spaces. The bare block
 * that loses is reported by {@link findShadowedArdOverrideKeys} rather than
 * discarded in silence.
 */
export function findArdEntryOverride(
  config: ArdConfig,
  kind: ArdSurfaceKind,
  name: string
): ArdEntryOverrides | undefined {
  const entries = config.entries;
  if (entries === undefined) return undefined;
  return readOverride(entries, ardEntryOverrideKey(kind, name)) ?? readOverride(entries, name);
}

function findOverrides(
  surface: Pick<ArdSurface, 'kind' | 'name'>,
  config: ArdConfig
): ArdEntryOverrides | undefined {
  return findArdEntryOverride(config, surface.kind, surface.name);
}

/** A bare `ard.entries` key that a qualified key for the same surface outranks. */
export interface ShadowedArdOverrideKey {
  readonly kind: ArdSurfaceKind;
  readonly name: string;
  /** The `ard.entries` key whose block is never read. */
  readonly shadowedKey: string;
  /** The `ard.entries` key that supplied the block instead. */
  readonly winningKey: string;
}

/**
 * Bare override blocks that a qualified key for the same surface displaces.
 *
 * Not an error: the precedence rule is deterministic and documented, and a
 * config carrying both keys has one obvious reading. But the block that loses
 * is dead config the author cannot see is dead — the same silence
 * {@link assertUnambiguousOverrideKeys} exists to end — so the caller is handed
 * the fact and decides how to say it.
 */
export function findShadowedArdOverrideKeys(
  surfaces: readonly ArdSurface[],
  config: ArdConfig
): ShadowedArdOverrideKey[] {
  const entries = config.entries;
  if (entries === undefined) return [];
  const shadowed: ShadowedArdOverrideKey[] = [];
  const reported = new Set<string>();
  for (const { kind, name } of surfaces) {
    const winningKey = ardEntryOverrideKey(kind, name);
    if (reported.has(winningKey)) continue;
    if (readOverride(entries, winningKey) === undefined) continue;
    if (readOverride(entries, name) === undefined) continue;
    reported.add(winningKey);
    shadowed.push({ kind, name, shadowedKey: name, winningKey });
  }
  return shadowed;
}

function resolveIdentifier(surface: ArdSurface, config: ArdConfig): string {
  if (!isArdPublisherDomain(config.publisher)) {
    throw new ArdDerivationError(
      surface,
      `ard.publisher "${config.publisher}" is not a publisher domain — it must be a DOMAIN such as ` +
        '"example.com" (letters, digits, "." and "-", with at least one dot and no empty label).'
    );
  }
  const namespace = config.namespace ?? defaultArdNamespace(surface.kind);
  for (const [label, segment] of [
    ['ard.namespace', namespace],
    ['the surface name', surface.name],
  ] as const) {
    if (!isArdNameSegment(segment)) {
      throw new ArdDerivationError(
        surface,
        `${label} "${segment}" is not a valid URN segment (allowed: letters, digits, ".", "_" and ` +
          '"-", and never "." or ".." alone — those are dot segments a URL resolver collapses, so ' +
          'the entry would advertise an address other than the one its identifier names).'
      );
    }
  }
  return `urn:air:${config.publisher}:${namespace}:${surface.name}`;
}

function resolveType(surface: ArdSurface, overrides: ArdEntryOverrides | undefined): string {
  const derived = overrides?.type ?? deriveArdMediaType(surface.kind);
  if (derived === undefined) {
    throw new ArdDerivationError(
      surface,
      'the ARD specification names no media type for this surface, so VAT will not derive one. ' +
        `Supply an explicit \`ard.entries."${ardEntryOverrideKey(surface.kind, surface.name)}".type\` ` +
        'to emit it.'
    );
  }
  return derived;
}

/**
 * RESOLVE a relative entry path against the configured base.
 *
 * 🚨 This was string concatenation, and concatenation is not URL resolution.
 * `https://example.com/base?tenant=acme#frag` + `/skills/expenses` produced
 * `https://example.com/base?tenant=acme#frag/skills/expenses`, which is a URL a
 * `format: uri` check accepts and which resolves to `https://example.com/base`
 * for EVERY entry, because the path landed inside the fragment. `mailto:` —
 * admitted by `z.string().url()` — produced `mailto:ops@example.com/skills/…`.
 * Both address nothing and are mutually indistinguishable; that is a different
 * class from a wrong-but-well-formed path.
 *
 * The base is refused rather than repaired ({@link isArdBaseUrl}) because a
 * query and a fragment do not survive relative resolution: silently dropping
 * them would publish a URL the author did not write, which is the same fault in
 * a politer form. `ard.baseUrl` is refused at config load too — this gate
 * catches a config assembled in process, and both read the one predicate.
 *
 * ⛔ The trailing slash is appended to the base's PATH before resolving, which
 * deliberately preserves the ruled-out doubling case: `baseUrl:
 * https://example.com/skills` with the namespace-mirroring path `skills/<name>`
 * still yields `/skills/skills/<name>`. That is a config error the project has
 * ruled it will not paper over, and letting `new URL` silently drop the last
 * segment of a slash-less base would "fix" it into a different wrong answer.
 *
 * The leading-slash strip on `urlPath` is likewise kept: without it a caller's
 * `/skills/a.md` would resolve against the ORIGIN and throw the base's path
 * away.
 *
 * ⚠️ Resolution is also what makes a `urlPath` DANGEROUS, which the docstring
 * above anticipated for the base and not for the path: an absolute URL relocates
 * the entry to another origin while its identifier stays anchored at the
 * publisher, and a dot segment — `..`, or `%2e%2e`, which decodes here — walks
 * out of the base's subtree. {@link isArdUrlPath} refuses both, so the address
 * an entry advertises is always inside the base its publisher chose.
 */
function joinArdUrl(surface: ArdSurface, baseUrl: string, urlPath: string): string {
  if (!isArdUrlPath(urlPath)) {
    throw new ArdDerivationError(
      surface,
      `the entry path "${urlPath}" is not a path under \`ard.baseUrl\`. It must carry no scheme, no ` +
        '"//" prefix and no "." or ".." segment (encoded or not) — each of those RESOLVES to an ' +
        'address outside the base, so the entry would advertise a resource its identifier does not ' +
        'anchor.'
    );
  }
  if (!isArdBaseUrl(baseUrl)) {
    throw new ArdDerivationError(
      surface,
      `ard.baseUrl "${baseUrl}" cannot be a base for entry URLs. It must be an http(s) URL carrying ` +
        'no query and no fragment — a base\'s query and fragment do not survive relative resolution, ' +
        'so every entry would resolve to the same address.'
    );
  }
  const base = new URL(baseUrl);
  // Scanned rather than `replace(/\/+$/, '')`-ed: an anchored `+` over a
  // single-character class is linear in fact but scores as super-linear, and
  // rewriting a regex to satisfy a score is a game with no end.
  let end = base.pathname.length;
  while (end > 0 && base.pathname[end - 1] === '/') end -= 1;
  base.pathname = `${base.pathname.slice(0, end)}/`;
  let start = 0;
  while (start < urlPath.length && urlPath[start] === '/') start += 1;
  return new URL(urlPath.slice(start), base).toString();
}

/**
 * The `url` XOR `data` half of the entry.
 *
 * A caller may legitimately supply both a `urlPath` and inline `data`, meaning
 * "publish a URL if the config gives me a base, otherwise inline it". So `url`
 * wins when it can be formed and `data` is the fallback — never both, which the
 * schema's `oneOf` forbids.
 */
function resolveLocation(
  surface: ArdSurface,
  config: ArdConfig
): { url: string } | { data: Record<string, unknown> } {
  if (config.baseUrl !== undefined && surface.urlPath !== undefined) {
    return { url: joinArdUrl(surface, config.baseUrl, surface.urlPath) };
  }
  if (surface.data !== undefined) return { data: surface.data };
  throw new ArdDerivationError(
    surface,
    'an entry needs exactly one of `url` or `data`, and neither could be derived. ' +
      'Set `ard.baseUrl` (the surface supplies the path) or supply an inline artifact document.'
  );
}

/**
 * The host of an identity URI, or `undefined` when the form carries none.
 *
 * `did:web:example.com` deliberately yields `undefined`: DID methods encode
 * their authority per-method, and inventing a parse for each one would turn a
 * check into a guess.
 *
 * ⚠️ `undefined` here means "this form has no authority *in the URI*", NOT "this
 * identity is fine". A bare `example.com` also yields `undefined`, and
 * {@link resolveTrustManifest} — not this function — is what decides which of
 * the two absences is legitimate.
 */
function identityAuthority(identity: string): string | undefined {
  // Split on the literal `://` rather than matching a scheme with a regex: the
  // regex form is quantifier-nested enough to be scored super-linear, and the
  // index arithmetic is both linear and easier to read.
  const marker = identity.indexOf('://');
  if (marker <= 0) return undefined;
  const rest = identity.slice(marker + '://'.length);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  if (authority === '') return undefined;
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  const portAt = host.lastIndexOf(':');
  const hasPort = portAt > 0 && /^\d+$/.test(host.slice(portAt + 1));
  return (hasPort ? host.slice(0, portAt) : host).toLowerCase();
}

/**
 * The one identity form whose authority VAT deliberately does not parse.
 *
 * A DID's authority is defined by its METHOD — `did:web`, `did:key`, `did:ion`
 * each answer "who is this" differently — so binding one would mean
 * implementing a parse per method, and a wrong parse is worse than an absent
 * one. This is the ONLY exemption; see {@link resolveTrustManifest}.
 */
const DID_IDENTITY_PREFIX = 'did:';

/**
 * The trust manifest, with the one binding ARD actually mandates checked.
 *
 * §"publisher-authority binding": the identity's trust domain MUST align with
 * the `<publisher>` segment of the entry identifier. "Align" is not defined
 * further, so VAT reads it as *the same host, or a subdomain of it* — tight
 * enough to catch a copy-paste from another org, loose enough for a workload
 * identity that lives under the publisher's domain.
 *
 * 🚨 An identity carrying no authority at all used to skip that check in
 * silence. The DID exemption was written as "no `://`, no authority to parse",
 * and a bare `attacker.com` has no `://` either — so it was emitted into the
 * manifest with the one binding ARD mandates never applied, at exit 0. It is
 * also not a form the config schema offers: its own description says "SPIFFE
 * ID, DID, or HTTPS FQDN URI", and a bare domain is none of the three.
 *
 * So the rule is now stated positively, and there are exactly two ways past it:
 * the authority is IN the URI and VAT binds it, or the identity is a DID and
 * the deferral is deliberate. A scheme-less string is neither, and guessing
 * which URI the author meant — `https://example.com`? `did:web:example.com`? a
 * SPIFFE trust domain? — is the guess this lane exists to refuse.
 */
function resolveTrustManifest(surface: ArdSurface, config: ArdConfig): ArdEntryDraft['trustManifest'] {
  const configured = config.trustManifest;
  if (configured === undefined) return undefined;
  const host = identityAuthority(configured.identity);
  const publisher = config.publisher.toLowerCase();
  if (host === undefined) {
    if (!configured.identity.toLowerCase().startsWith(DID_IDENTITY_PREFIX)) {
      throw new ArdDerivationError(
        surface,
        `trustManifest.identity "${configured.identity}" carries no authority VAT can bind to the ` +
          `publisher "${config.publisher}". ARD requires publisher-authority binding, and VAT can ` +
          'only perform it when the authority is in the URI: write an HTTPS FQDN URI ' +
          `("https://${config.publisher}/workload") or a SPIFFE ID ` +
          `("spiffe://${config.publisher}/workload"). A DID ("did:web:${config.publisher}") is the ` +
          'one exempt form, because DID methods encode their authority per-method.'
      );
    }
  } else if (host !== publisher && !host.endsWith(`.${publisher}`)) {
    throw new ArdDerivationError(
      surface,
      `trustManifest.identity "${configured.identity}" is anchored at "${host}", which does not align ` +
        `with the publisher "${config.publisher}". ARD requires publisher-authority binding.`
    );
  }
  return configured.identityType === undefined
    ? { identity: configured.identity }
    : { identity: configured.identity, identityType: configured.identityType };
}

/** Copy across the fields whose presence depends on what VAT happens to hold. */
function applyOptionalFields(
  draft: ArdEntryDraft,
  surface: ArdSurface,
  overrides: ArdEntryOverrides | undefined
): void {
  if (surface.description !== undefined) draft.description = surface.description;
  if (surface.tags !== undefined) draft.tags = [...surface.tags];
  if (surface.version !== undefined) draft.version = surface.version;
  if (surface.updatedAt !== undefined) draft.updatedAt = surface.updatedAt;
  if (overrides?.capabilities !== undefined) draft.capabilities = [...overrides.capabilities];
  // ⚠️ Authored only. See this module's docstring: VAT never writes these.
  if (overrides?.representativeQueries !== undefined) {
    draft.representativeQueries = [...overrides.representativeQueries];
  }
}

/**
 * Build one ARD entry from a surface plus the project's `ard` configuration.
 *
 * @throws {ArdDerivationError} when a field VAT refuses to guess is missing —
 *   a media type for a surface the spec names none for, an unusable URN
 *   segment, no `url` and no `data`, or a trust identity that does not align
 *   with the publisher — including one carrying no authority to align at all.
 */
export function buildArdEntry(surface: ArdSurface, config: ArdConfig): ArdEntry {
  const overrides = findOverrides(surface, config);
  const draft: ArdEntryDraft = {
    identifier: resolveIdentifier(surface, config),
    displayName: surface.displayName,
    type: resolveType(surface, overrides),
    ...resolveLocation(surface, config),
  };
  applyOptionalFields(draft, surface, overrides);
  const trustManifest = resolveTrustManifest(surface, config);
  if (trustManifest !== undefined) draft.trustManifest = trustManifest;

  // The strict parse is the last gate on VAT's own output: an unknown key here
  // is VAT's bug, not an extension term, and it must not reach a published
  // document. (`.strict()` — see entry-schema.ts.)
  const parsed = ArdEntrySchema.safeParse(draft);
  if (!parsed.success) {
    throw new ArdDerivationError(
      surface,
      `the emitted entry is not well-formed — ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`
    );
  }
  return parsed.data;
}

/**
 * Refuse a bare `ard.entries` key that names surfaces of more than one kind.
 *
 * The alternative — letting the first match win, or applying the block to all
 * of them — is what shipped, and it retyped a skill as an OKF bundle without a
 * word on stderr. A refusal is the only outcome that does not require the
 * author to have noticed; the message names the qualified keys, so the fix is
 * readable from the terminal.
 *
 * Judged over the surfaces actually being EMITTED, not over the config: a
 * surface that was skipped cannot be bled onto, and warning about it would make
 * this gate cry wolf.
 */
function assertUnambiguousOverrideKeys(
  surfaces: readonly ArdSurface[],
  config: ArdConfig
): void {
  const entries = config.entries;
  if (entries === undefined) return;
  const kindsByName = new Map<string, Set<ArdSurfaceKind>>();
  for (const surface of surfaces) {
    const kinds = kindsByName.get(surface.name) ?? new Set<ArdSurfaceKind>();
    kinds.add(surface.kind);
    kindsByName.set(surface.name, kinds);
    // `readOverride`, never `entries[name]`: the bare form reads through the
    // prototype, and two surfaces named `toString` were refused with a message
    // naming `ard.entries.toString`, a key no config contains.
    if (kinds.size < 2 || readOverride(entries, surface.name) === undefined) continue;
    const qualified = [...kinds]
      .map((kind) => `\`ard.entries."${ardEntryOverrideKey(kind, surface.name)}"\``)
      .join(' and ');
    throw new ArdDerivationError(
      surface,
      `\`ard.entries.${surface.name}\` is ambiguous — surfaces of ${kinds.size} different kinds are ` +
        `named "${surface.name}" (${[...kinds].join(', ')}), and those are independent key spaces. ` +
        `Qualify the override by kind: ${qualified}.`
    );
  }
}

/**
 * Refuse two surfaces that collapse to one `identifier`.
 *
 * 🚨 ARD calls `identifier` the "globally unique discovery handle", and JSON
 * Schema cannot express array-element uniqueness — so the vendored-schema
 * oracle passes a manifest carrying the same identifier twice, which is a live
 * instance of why `additionalProperties: true` makes schema validation weak
 * evidence. Reachable from a legal config: a skill and a marketplace both named
 * `main` under a single `ard.namespace` override emitted two byte-identical
 * entries at exit 0.
 */
function assertUniqueIdentifiers(
  entries: readonly ArdEntry[],
  surfaces: readonly ArdSurface[]
): void {
  const seen = new Map<string, ArdSurface>();
  for (const [index, entry] of entries.entries()) {
    const surface = surfaces[index];
    if (surface === undefined) continue;
    const first = seen.get(entry.identifier);
    if (first !== undefined) {
      throw new ArdDerivationError(
        surface,
        `identifier "${entry.identifier}" is already emitted by the ${first.kind} "${first.name}". ` +
          'An ARD identifier is a globally unique discovery handle, so two surfaces must not share ' +
          'one. Give the surfaces distinct names, or drop the single `ard.namespace` override that ' +
          'collapsed the per-kind namespaces.'
      );
    }
    seen.set(entry.identifier, surface);
  }
}

/** Build every entry, in the order the surfaces were given. */
export function buildArdEntries(
  surfaces: readonly ArdSurface[],
  config: ArdConfig
): ArdEntry[] {
  assertUnambiguousOverrideKeys(surfaces, config);
  const entries = surfaces.map((surface) => buildArdEntry(surface, config));
  assertUniqueIdentifiers(entries, surfaces);
  return entries;
}
