/**
 * Read an environment variable as a boolean.
 *
 * 🔑 **Returns `undefined` for anything it does not recognise, and never
 * guesses.** That is the whole point: the caller — not this function — decides
 * what an unreadable value means, because only the caller knows which way is
 * safe. A token-fetching kill switch wants "deny"; a cache toggle wants
 * "leave the cache on". A parser that folded the unknown case into `false`
 * would have made that choice for both of them.
 *
 * 🚨 **Why this exists at all.** Three switches were each a comparison against
 * the literal string `'0'`, so `=false` turned none of them off — measured for
 * `VAT_LINKAUTH_ALLOW_COMMAND`, which *still spawned subprocesses*. Every
 * spelling a human reaches for (`false`, `no`, `off`, `FALSE`, a value with a
 * stray space) failed open. A switch whose off position is one exact string is
 * not a switch.
 *
 * 📍 **Why it lives in `utils`.** It was written next to its first consumer in
 * `resources`, on the rule that utils takes a utility when a SECOND package
 * needs it rather than speculatively. That second package arrived:
 * `packages/cli`'s `projectionStoreSelected()` reads the same `VAT_CACHE` the
 * `resources` parse cache does, and two independent readings of one variable is
 * the defect, not the fix. The three consumers today:
 *
 * | Caller | Variable | Reads `undefined` as | Why |
 * |---|---|---|---|
 * | `link-auth/resolve-token.ts` | `VAT_LINKAUTH_ALLOW_COMMAND` | **deny** | gates a capability — fail closed |
 * | `resources/parse-cache.ts` | `VAT_CACHE` | cache stays on | gates a cache — an unreadable value must not silently change behaviour |
 * | `cli/utils/projection-store.ts` | `VAT_CACHE` | not a veto | same variable, same reading, one implementation |
 *
 * Same parser, different safe sides, each chosen at its own call site. That is
 * the contract; do not move a default in here.
 */

const TRUE_SPELLINGS: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'y', 'on']);
const FALSE_SPELLINGS: ReadonlySet<string> = new Set(['0', 'false', 'no', 'n', 'off']);

/**
 * Parse an env value as a boolean.
 *
 * Case-insensitive and surrounding whitespace is trimmed, because a value that
 * arrived through a shell, a CI YAML block, or a `.env` file routinely carries
 * both. Everything else — including the empty string, which is what an unset
 * shell variable expands to — returns `undefined`.
 *
 * @param raw - The raw env value, or `undefined` when the variable is unset
 * @returns `true` / `false` for a recognised spelling; `undefined` otherwise
 */
export function parseEnvBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_SPELLINGS.has(normalized)) return true;
  if (FALSE_SPELLINGS.has(normalized)) return false;
  return undefined;
}
