/**
 * Which VAT surface an ARD entry describes, and what may be **derived** from
 * that fact alone.
 *
 * The governing rule is: VAT already knows what its surfaces are, so an author
 * must never be asked to restate something `ProjectConfigSchema` already holds.
 * The corollary is the interesting half — where VAT does *not* know, it derives
 * nothing and says so, rather than picking a plausible value.
 */

/**
 * The VAT surfaces an ARD entry can describe.
 *
 * `mcp-server` is present because the builder is general, **not** because VAT
 * derives one: there is no adopter-facing MCP configuration surface, so an MCP
 * entry can only ever come from an explicit author declaration.
 */
export type ArdSurfaceKind = 'skill' | 'marketplace' | 'okf-bundle' | 'mcp-server';

/**
 * The media type VAT emits for a skill.
 *
 * ⚠️ **COINED, not blessed.** `application/ai-skill+md` occurs exactly once in
 * the whole ARD specification, inside a JSON example, and is not among the two
 * types the spec names as "de-facto community standards tracking towards formal
 * registration" (`application/a2a-agent-card+json` and
 * `application/mcp-server-card+json` — and even those registrations are
 * pending). VAT is coining this value.
 *
 * What makes coining sound anyway is that ARD's envelope is explicitly
 * type-agnostic: §3.3 says the specification "does not define or constrain" the
 * internal schema of specific types, and `type` is an open IANA media-type
 * string. So a skill entry is *expressible*. That is enough to build on, and it
 * must never be sold as a vocabulary match — expect this value to move.
 */
export const ARD_SKILL_MEDIA_TYPE = 'application/ai-skill+md';

/**
 * Media types VAT is willing to derive from a surface kind alone.
 *
 * ⛔ Three of the four kinds are deliberately absent, and each absence is a
 * finding, not an oversight:
 *
 * - **marketplace** — `application/ai-catalog+json` appears **nowhere** in the
 *   specification. `ai-catalog` survives only as ARD's predecessor well-known
 *   path, and the vendored `ai-catalog.schema.json` is the *container* schema
 *   (`AICatalogManifest`, requiring `specVersion` + `entries`), not a value for
 *   an entry's `type`.
 * - **okf-bundle** — `application/okf-bundle` is an open upstream issue
 *   (ards-project/ard-spec#27), not a fact.
 * - **mcp-server** — speculative; VAT has no MCP configuration surface to
 *   derive from, and a package merely existing is not a declaration.
 *
 * Each of those emits only when the author supplies an explicit
 * `ard.entries.<name>.type`, and never by derivation.
 */
const DERIVED_MEDIA_TYPES: Readonly<Partial<Record<ArdSurfaceKind, string>>> = {
  skill: ARD_SKILL_MEDIA_TYPE,
};

/** The media type derivable from a surface kind, or `undefined` when VAT will not guess. */
export function deriveArdMediaType(kind: ArdSurfaceKind): string | undefined {
  return DERIVED_MEDIA_TYPES[kind];
}

/**
 * Default `<namespace>` URN segment per surface kind.
 *
 * Only `skills` and `bundles` are named by `ArdConfigSchema`'s docstring; the
 * other two are ordinary naming, chosen so that a URN is buildable at all.
 * Unlike `type`, a namespace segment makes no vocabulary claim — it is a label
 * inside the publisher's own authority — so defaulting one is not the same act
 * as coining a media type. `ard.namespace` overrides all of them.
 */
export const ARD_DEFAULT_NAMESPACES: Readonly<Record<ArdSurfaceKind, string>> = {
  skill: 'skills',
  marketplace: 'marketplaces',
  'okf-bundle': 'bundles',
  'mcp-server': 'servers',
};

/** The `<namespace>` segment a surface kind uses when the config names none. */
export function defaultArdNamespace(kind: ArdSurfaceKind): string {
  return ARD_DEFAULT_NAMESPACES[kind];
}
