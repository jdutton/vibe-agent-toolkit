/**
 * The globs a build's link-graph registry includes — the packager's DOOR rule.
 *
 * `walkLinkGraph` traverses a link target only when it is a registry member;
 * anything else is bundled as cargo and never opened. So "which files does a
 * build walk through" is exactly "which files does the registry include", and
 * this constant is both: the skill packager's and the marketplace inventory's
 * registries crawl it, and both lanes' closure declarations name it as
 * `traverseGlobs`.
 *
 * ⛔ Not "whatever parses as markdown". `.txt`, `.markdown` and the extensionless
 * well-knowns (`README`, `LICENSE`, …) route to the markdown parser but are not
 * members, so the build ships them without following a link out of them. A
 * closure keyed on parser kind walked through them and admitted documents no
 * build ships.
 */
export const LINK_GRAPH_MEMBER_GLOBS: readonly string[] = Object.freeze(['**/*.md']);
