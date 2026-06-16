/**
 * Bridge between the adopter-facing linkAuth config (Zod-validated, with
 * macro references) and the engine-facing config (fully-expanded providers).
 *
 * Adopter config providers can be either:
 *   - `{ use: <macro>, ...overrides }` — reference a shipped macro; deep-merge
 *     `overrides` on top of the macro's defaults
 *   - A full inline `{ match, rewrite, auth, token, check }` — used as-is
 *
 * This function walks each provider entry, runs macro expansion when needed,
 * and re-validates each fully-expanded provider against the inline schema
 * (the macro schema's `.passthrough()` accepts unknown override keys, which
 * silently no-op at expansion time — post-expansion validation is where
 * typo'd override fields surface as errors, per #113 §5).
 *
 * Per design issue #113 §5 (macros are config, not a privileged code path)
 * and §4 (engine vocabulary).
 */

import {
  expandMacro,
  type LinkAuthConfig,
  type Provider,
} from '@vibe-agent-toolkit/utils';
import type { z } from 'zod';

import { InlineProviderSchema, type LinkAuthProjectConfig } from './schemas/link-auth.js';

/**
 * Compile-time drift defense: top-level field sets must match between the
 * Zod schema and the engine's `Provider` interface. A strict structural
 * check would also catch sub-type drift, but TS variance (readonly arrays in
 * engine vs mutable in Zod inference) makes that noisy — the realistic
 * drift mode is adding/renaming a top-level field on one side and forgetting
 * the other, which this top-level key comparison catches at `tsc` time.
 *
 * The schema and engine type are kept in sync by review (per slice 1 design
 * decision); this guard makes that review easier.
 */
type _SchemaKeys = keyof z.infer<typeof InlineProviderSchema>;
type _EngineKeys = keyof Provider;
type _KeysAgree = [_SchemaKeys] extends [_EngineKeys]
  ? [_EngineKeys] extends [_SchemaKeys]
    ? true
    : { error: 'engine Provider has a field that InlineProviderSchema lacks'; missing: Exclude<_EngineKeys, _SchemaKeys> }
  : { error: 'InlineProviderSchema has a field that engine Provider lacks'; missing: Exclude<_SchemaKeys, _EngineKeys> };
// Type-level assert: the declaration must compile to `true` (i.e. both
// directions of the key-set check pass). The exported function holds a
// reference to the type so noUnusedLocals doesn't fire.
export const _assertSchemaKeysAgreeWithEngine: _KeysAgree = true;

export function buildLinkAuthEngineConfig(adopter: LinkAuthProjectConfig): LinkAuthConfig {
  const providers: Provider[] = adopter.providers.map((entry, index) =>
    expandProviderEntry(entry, index),
  );
  return { providers };
}

function expandProviderEntry(entry: unknown, index: number): Provider {
  // Discriminate via Object.hasOwn (not `'use' in entry`) so a prototype-
  // injected `use` cannot reroute an inline entry into macro expansion. The
  // Zod parser already produces plain JSON-shaped objects, but defending in
  // depth costs nothing.
  const isMacroRef =
    typeof entry === 'object' &&
    entry !== null &&
    Object.hasOwn(entry, 'use');

  if (!isMacroRef) {
    return entry as Provider;
  }

  const { use, overrides } = splitMacroEntry(entry as Record<string, unknown>);
  const expanded = expandMacro(use, overrides);

  // Re-validate the fully-expanded shape. A macro override that uses a typo'd
  // field name (e.g. `notFoundMeaningg`) is accepted by MacroProviderSchema's
  // .passthrough(), survives expansion as a stray field on the merged object,
  // and is caught here by InlineProviderSchema's .strict() — surfaced as a
  // config error rather than as silently-wrong runtime behavior.
  const parsed = InlineProviderSchema.safeParse(expanded);
  if (!parsed.success) {
    throw new Error(
      `linkAuth providers[${index}] (use: ${JSON.stringify(use)}) ` +
        `produced an invalid provider after macro expansion: ${parsed.error.message}`,
    );
  }
  return parsed.data as Provider;
}

function splitMacroEntry(entry: Record<string, unknown>): {
  use: string;
  overrides: Record<string, unknown>;
} {
  // `use` value comes from a Zod-validated source so the type is string at
  // this point — but defensively-check it anyway: `Object.hasOwn` upstream
  // tells us the key exists, not what its value's type is.
  const useValue = entry['use'];
  if (typeof useValue !== 'string') {
    throw new TypeError(`linkAuth provider \`use\` must be a string, got ${typeof useValue}`);
  }
  const overrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'use') continue;
    overrides[key] = value;
  }
  return { use: useValue, overrides };
}
