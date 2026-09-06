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
  ARD_NAME_SEGMENT_PATTERN,
  ARD_PUBLISHER_SEGMENT_PATTERN,
  ArdEntrySchema,
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

function resolveIdentifier(surface: ArdSurface, config: ArdConfig): string {
  if (!ARD_PUBLISHER_SEGMENT_PATTERN.test(config.publisher)) {
    throw new ArdDerivationError(
      surface,
      `ard.publisher "${config.publisher}" is not a valid URN segment (allowed: letters, digits, "." and "-").`
    );
  }
  const namespace = config.namespace ?? defaultArdNamespace(surface.kind);
  for (const [label, segment] of [
    ['ard.namespace', namespace],
    ['the surface name', surface.name],
  ] as const) {
    if (!ARD_NAME_SEGMENT_PATTERN.test(segment)) {
      throw new ArdDerivationError(
        surface,
        `${label} "${segment}" is not a valid URN segment (allowed: letters, digits, ".", "_" and "-").`
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
        `Supply an explicit \`ard.entries.${surface.name}.type\` to emit it.`
    );
  }
  return derived;
}

/**
 * Join a base URL and a relative path without letting either's slashes decide
 * the result — exactly one separator, whatever the caller wrote.
 *
 * Scanned rather than `replace(/\/+$/, '')`-ed: an anchored `+` over a
 * single-character class is linear in fact but scores as super-linear, and
 * rewriting a regex to satisfy a score is a game with no end. Index arithmetic
 * settles it.
 */
function joinArdUrl(baseUrl: string, urlPath: string): string {
  let end = baseUrl.length;
  while (end > 0 && baseUrl[end - 1] === '/') end -= 1;
  let start = 0;
  while (start < urlPath.length && urlPath[start] === '/') start += 1;
  return `${baseUrl.slice(0, end)}/${urlPath.slice(start)}`;
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
    return { url: joinArdUrl(config.baseUrl, surface.urlPath) };
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
 * The trust manifest, with the one binding ARD actually mandates checked.
 *
 * §"publisher-authority binding": the identity's trust domain MUST align with
 * the `<publisher>` segment of the entry identifier. "Align" is not defined
 * further, so VAT reads it as *the same host, or a subdomain of it* — tight
 * enough to catch a copy-paste from another org, loose enough for a workload
 * identity that lives under the publisher's domain.
 */
function resolveTrustManifest(surface: ArdSurface, config: ArdConfig): ArdEntryDraft['trustManifest'] {
  const configured = config.trustManifest;
  if (configured === undefined) return undefined;
  const host = identityAuthority(configured.identity);
  const publisher = config.publisher.toLowerCase();
  if (host !== undefined && host !== publisher && !host.endsWith(`.${publisher}`)) {
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
 *   with the publisher.
 */
export function buildArdEntry(surface: ArdSurface, config: ArdConfig): ArdEntry {
  const overrides = config.entries?.[surface.name];
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

/** Build every entry, in the order the surfaces were given. */
export function buildArdEntries(
  surfaces: readonly ArdSurface[],
  config: ArdConfig
): ArdEntry[] {
  return surfaces.map((surface) => buildArdEntry(surface, config));
}
