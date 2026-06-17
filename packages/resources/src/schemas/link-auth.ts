/**
 * Zod schema for `resources.linkAuth` config.
 *
 * Validates the shape of an adopter's linkAuth configuration: providers
 * (each either a `use: <macro>` reference or a full inline provider) plus
 * an optional cache config. **Passthrough** — per the repo Postel's Law
 * rule, schemas that parse external data (adopter `vibe-agent-toolkit.config.yaml`)
 * are liberal: unknown fields pass through rather than abort the parse, so
 * an adopter with a forward-compatible field or a typo gets `vat resources
 * validate` degrading gracefully instead of crashing. Typo-catching DX is
 * a separate lint/warn pass, not a hard parse failure.
 *
 * Provider entries accept EITHER:
 *   - `{ use: <name>, ...overrides }` — reference a shipped macro by name;
 *     override fields are deep-merged on top at expansion time.
 *   - A full inline `{ match, rewrite, auth, token, check }` — every required
 *     field present, with declared-field types still enforced (passthrough
 *     only relaxes unknown-key handling, not type checking on known fields).
 *
 * Mirrors the runtime types in `@vibe-agent-toolkit/utils`'s `link-auth/`
 * module. Keep these aligned: a config that parses here must satisfy the
 * `Provider` / `LinkAuthConfig` interfaces over there.
 *
 * Per design issue #113 §4 (vocabulary) and §5 (macros), and the repo
 * CLAUDE.md Postel's Law rule for adopter-facing configs.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Leaf types
// ---------------------------------------------------------------------------

export const ProviderMatchSchema = z
  .object({
    host: z.string().min(1).describe('Glob matched against URL hostname'),
    excludeHost: z
      .array(z.string().min(1))
      .optional()
      .describe('Globs that, if any match the hostname, exclude this provider'),
  })
  .passthrough()
  .describe('Provider selection — match.host + optional excludeHost globs');

export const RewriteRuleSchema = z
  .object({
    when: z.string().min(1).describe('Regex source (RFC-style, JavaScript-compatible) matched against the URL'),
    vars: z
      .record(z.string(), z.string())
      .optional()
      .describe('Computed variables, each a template that references captures from `when`'),
    to: z.string().min(1).describe('URL template — interpolates ${capture} and ${var}'),
  })
  .passthrough()
  .describe('A single rewrite rule (one entry in a provider\'s ordered rewrite list)');

export const ProviderAuthSchema = z
  .object({
    headers: z
      .record(z.string(), z.string())
      .describe('Header name → value template. Values interpolate ${token} and any capture/var.'),
  })
  .passthrough()
  .describe('Auth headers attached to the authenticated fetch');

export const TokenSourceSchema = z
  .union([
    z.object({ env: z.string().min(1) }).passthrough(),
    z
      .object({
        command: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
      })
      .passthrough(),
  ])
  .describe('A single token source — env var, or argv command (preferred), or convenience string');

export const ProviderCheckSchema = z
  .object({
    method: z.enum(['GET', 'HEAD']),
    aliveStatus: z
      .array(z.number().int().min(100).max(599))
      .min(1)
      .describe('HTTP status codes meaning the URL is alive (per host semantics)'),
    notFoundMeaning: z
      .enum(['ambiguous', 'dead'])
      .describe(
        'Per-host: does 404 mean "dead" (honest 404 host like Graph) or "ambiguous" (masking host like GitHub)?',
      ),
  })
  .passthrough()
  .describe('Status-to-outcome classifier (consumed by the resources layer, not the pure engine)');

// ---------------------------------------------------------------------------
// Provider entry (inline OR macro reference)
// ---------------------------------------------------------------------------

export const InlineProviderSchema = z
  .object({
    match: ProviderMatchSchema,
    rewrite: z.array(RewriteRuleSchema).min(1).describe('Ordered rewrite rules — first matching wins'),
    auth: ProviderAuthSchema,
    token: z.array(TokenSourceSchema).describe('Ordered token sources — first non-empty wins'),
    check: ProviderCheckSchema,
  })
  .passthrough();

const MacroProviderSchema = z
  .object({
    use: z.string().min(1).describe('Macro name (e.g. "github", "sharepoint")'),
  })
  .passthrough()
  .describe(
    'Reference a shipped macro by name. Override fields (match/rewrite/auth/token/check) deep-merge on top at expansion time.',
  );

export const ProviderEntrySchema = z
  .union([MacroProviderSchema, InlineProviderSchema])
  .describe('A provider entry — either { use: <macro>, ...overrides } or a full inline provider');

// ---------------------------------------------------------------------------
// Top-level linkAuth config
// ---------------------------------------------------------------------------

export const LinkAuthCacheSchema = z
  .object({
    ttlMinutes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Content cache TTL in minutes (default 30 — used by slice 3 content-fetch)'),
  })
  .passthrough();

export const LinkAuthConfigSchema = z
  .object({
    cache: LinkAuthCacheSchema.optional(),
    providers: z
      .array(ProviderEntrySchema)
      .describe('Ordered list of providers — first claiming-by-host wins'),
  })
  .passthrough()
  .describe('`resources.linkAuth` — authenticated external link resolution config');

/**
 * Adopter-facing config shape — what an `vibe-agent-toolkit.config.yaml`
 * parses to. Distinct from `@vibe-agent-toolkit/utils`'s `LinkAuthConfig`
 * (the engine shape, with fully-expanded providers only). The bridge
 * function `buildLinkAuthEngineConfig` converts between the two.
 */
export type LinkAuthProjectConfig = z.infer<typeof LinkAuthConfigSchema>;
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;
export type RewriteRule = z.infer<typeof RewriteRuleSchema>;
export type TokenSource = z.infer<typeof TokenSourceSchema>;
