/**
 * Comment-density ceilings, one per package with a `src/`, in percent of
 * non-blank lines. Read by `comment-density.ts` and asserted both ways by
 * the structure gate: a package may not rise above its entry, and an entry
 * more than a point above its package must be lowered. The table only moves
 * down. Re-seed with `bun run comment-density --print-ceilings` after a
 * deliberate prose reduction; never to admit growth.
 *
 * ⚠️ The tolerance is ASYMMETRIC by design — zero upward, one point downward.
 * A package sitting exactly at its ceiling (seeded to 0.1) reds the full tier
 * on ONE added comment line unless code lines come with it — including the
 * `-- reason` that `eslint-comments/require-description` requires on every
 * directive. That first red is not a flake: it is the ratchet asking whether
 * the prose earns its place, and the honest answers are to cut a line
 * elsewhere in the package or to lower nothing and add code.
 */
export const COMMENT_DENSITY_CEILINGS: Readonly<Record<string, number>> = {
  'agent-config': 25,
  'agent-runtime': 43.8,
  'agent-skills': 50.7,
  'claude-marketplace': 42.6,
  'cli': 43.2,
  // 29.7 → 31.7 when the 565-row unused-exports allowlist moved out of src
  // into a data file: those rows counted as CODE, so the seed was inflated by
  // ~1,000 lines of data and the ratio rose with no prose added.
  'dev-tools': 31.7,
  'discovery': 42.1,
  'gateway-mcp': 27.7,
  'lab': 55.9,
  'projection-sqlite': 63.6,
  'rag': 50.5,
  'rag-lancedb': 48.8,
  'resource-compiler': 38.6,
  'resources': 62.8,
  'runtime-claude-agent-sdk': 42.3,
  'runtime-langchain': 50.8,
  'runtime-openai': 51.6,
  'runtime-vercel-ai-sdk': 57.6,
  'schema': 44.4,
  'test-agents': 34.9,
  'transports': 34.9,
  'utils': 62.8,
  'vat-development-agents': 14.8,
  'vat-example-cat-agents': 20.2,
};
