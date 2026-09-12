# Contributor Guide: linkAuth Engine

This guide is for developers working on the linkAuth feature inside VAT itself. For
adopter documentation (how to configure `resources.linkAuth`), see the main README and
`vibe-agent-toolkit.config.yaml` reference.

Design: issue #113 in `jdutton/vibe-agent-toolkit`.

## Architecture overview

The linkAuth pipeline has three layers:

```
Adopter YAML config
      ↓
  Engine (packages/resources/src/link-auth/)
      ↓  builds LinkAuthConfig, resolves providers, runs rewrites
  Validator (packages/resources/src/link-auth-validator.ts)
      ↓  calls engine, classifies results as LINK_AUTH_* codes
  vat resources validate
```

### Engine vocabulary (packages/resources/src/link-auth/)

| File | Responsibility |
|---|---|
| `macros.yaml` | Shipped provider macros (`github`, `sharepoint`) — YAML entries, not TS |
| `expand-macro.ts` | Loads `macros.yaml`, applies adopter deep-merge overrides |
| `resolve.ts` | Engine entry point: `resolveAuthenticatedUrl(url, config, deps)` — picks provider, runs rewrites, resolves token, plans the fetch |
| `select-provider.ts` | Match a URL against configured providers (host + `excludeHost` rules) |
| `rewrite.ts` | URL rewrite rules (regex `when` + `to` with `${var}` substitution) |
| `resolve-token.ts` | Token source resolution (`env:` + `command:` sources, GIT_* scrubbing, `VAT_LINKAUTH_ALLOW_COMMAND` opt-out) |
| `build-headers.ts` | Build request headers, substitute `${token}` into templates; `sensitiveHeaderValues` + `redactSecretsInText` — the §8 token-redaction pair |
| `template.ts` | Generic `${…}` template substitution with allowlist enforcement; `templateReferences` checks a template without rendering it |
| `transforms.ts` | Transform functions callable inside templates (e.g. `base64url`) — the safety allowlist for template calls |
| `compile-check.ts` | Config-time compilation of one provider (`assertProviderCompiles`, `LinkAuthConfigError`) — every statically knowable defect refuses the run here, by name, before any URL is seen |

Not in this directory but load-bearing for it: `parseEnvBoolean` (`packages/utils/src/env-flag.ts`,
imported from `@vibe-agent-toolkit/utils`) — env values read as booleans, `undefined` when
unrecognized, so the caller picks the safe side.

### Validator wiring (packages/resources/src/)

| File | Responsibility |
|---|---|
| `schemas/link-auth.ts` | Zod schema for the `resources.linkAuth` YAML block |
| `link-auth-config-build.ts` | `buildLinkAuthEngineConfig()` — turns the adopter config into an engine-ready `LinkAuthConfig` |
| `link-auth-content-fetch.ts` | Orchestrates: call engine → fetch via `authTransport` → return response for classification |
| `link-auth-classify.ts` | Maps HTTP outcomes to `LINK_AUTH_*` validation codes per the provider's `check` block |
| `link-auth-transport.ts` | `authTransport` — HTTP fetch primitive. Cross-origin auth strip, `Retry-After`, timeout, signal propagation |
| `external-link-validator.ts` | Validator entry point invoked by `vat resources validate` |

### Content cache

`ExternalLinkCache` (packages/resources/src/external-link-cache.ts) stores auth results
under `<cacheDir>/auth-${sanitizedOsUser}/external-links.json`. An entry is three scalars —
`statusCode`, `statusMessage`, `timestamp` — and carries **no version field**; whether a
stored entry is readable is decided by the `.strict()` `ExternalLinkCacheEntrySchema` at the
load boundary, not by a number (see *Code style* below). Do not cache derived LINK_AUTH_*
codes — only the raw `statusCode`; re-classify on every cache hit under the current
provider's `check` block.

A **transient** refusal is not cached at all: `isTransientRefusal` in
`external-link-validator.ts` keeps 429s, 403s and 503s carrying a rate-limit or `Retry-After`
signal, and no-response results (`statusCode: 0` — DNS, connect, timeout) out of a store whose
TTL is 24 hours. Both lanes — anonymous and authenticated — read that ONE predicate, on the
write side and on the read side, so a row an older build already wrote for a transient status is
a miss rather than an answer. A durable refusal — a plain 403, a 401, a 404 — is cached as
before.

## Adding a new built-in provider macro

A macro is a shorthand that expands to a full inline provider. The two shipped macros
(`github`, `sharepoint`) live in `packages/resources/src/link-auth/macros.yaml` — as YAML
entries, not TypeScript. The macro loader (`expand-macro.ts`) reads the file once at
module init and applies adopter deep-merge overrides at runtime.

To add a new macro `myprovider`:

1. **Add the entry** to `packages/resources/src/link-auth/macros.yaml`:
   ```yaml
   myprovider:
     match:
       host: myprovider.example
     rewrite:
       - when: '^https://myprovider\.example/(?<path>.+)$'
         to: 'https://api.myprovider.example/v1/${path}'
     auth:
       headers:
         Authorization: 'Bearer ${token}'
     token:
       - env: MYPROVIDER_TOKEN
     check:
       method: GET
       aliveStatus: [200]
       notFoundMeaning: dead
   ```

   Note: `use:` in the adopter YAML is validated by `expand-macro.ts` at runtime
   (throws `UnknownMacroError`), not by an enum in the Zod schema. Adding a
   macro is a **YAML-only** change — no code edit to `schemas/link-auth.ts` is
   required.

2. **Write unit tests** for the expansion in
   `packages/resources/test/link-auth/expand-macro.test.ts`. Cover: base expansion,
   at least one adopter override, and — if applicable — the "no zero-config
   token source" case (see the `sharepoint` tests for the pattern).

3. **Write an integration test** in `packages/resources/test/` that verifies a
   roundtrip through `buildLinkAuthEngineConfig` with `use: 'myprovider'`.

4. **Document** the macro in the main README and in the linkAuth section of
   `packages/vat-development-agents/resources/skills/vat-knowledge-resources.md`
   (the skill that surfaces linkAuth config to agents).

Per issue #113 §10: the design explicitly limits shipped macros to hosts where auth is
universally needed and the pattern is stable. Do not add macros speculatively — open an
issue and wait for adopter demand.

## Token resolution (resolve-token.ts)

### Source priority

Sources are tried in order; the first non-empty value wins:

```yaml
token:
  - env: GITHUB_TOKEN      # read process.env.GITHUB_TOKEN
  - command: gh auth token # spawn gh, trim stdout
```

### Command execution

Commands run via `safeExecResult` with `shell: false` (argv-based spawn, no shell). The
string form `command: "gh auth token"` is whitespace-tokenized; shell operators (`|`,
`&&`) become literal argv elements — they are **not** pipes.

### GIT_* environment scrubbing

`defaultRunCommand` strips all `GIT_*` env vars before spawning. This matters because
`vat resources validate` is often run from a git pre-commit hook, where git sets
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, and other vars. These interfere with any
tool that internally shells out to git (most notably `gh auth token`). Without scrubbing,
`gh auth token` fails inside a pre-commit hook.

If you add a new default command runner or wrap `defaultRunCommand`, preserve the
scrubbing.

### VAT_LINKAUTH_ALLOW_COMMAND

Set this env var to a false value (or pass `allowCommand: false` in `TokenResolutionDeps`)
to skip all `{ command: ... }` sources at runtime. Only `{ env: ... }` sources are tried.
Useful in security-sensitive environments or when the CI policy prohibits arbitrary
child-process execution from the validator.

The value is parsed by `parseEnvBoolean` (`packages/utils/src/env-flag.ts`), case-insensitively and
with surrounding whitespace trimmed:

| Value | Effect |
|---|---|
| unset | commands allowed (shipped default) |
| `1` `true` `yes` `y` `on` | commands allowed |
| `0` `false` `no` `n` `off` | commands **denied** |
| anything else, including `""` | commands **denied** — see below |

🚨 **A value we cannot parse denies.** This used to be a comparison against the literal
string `'0'`, under which `VAT_LINKAUTH_ALLOW_COMMAND=false` *still spawned subprocesses* —
measured. Every spelling a human reaches for failed open. The only reason to touch this
variable is to turn command execution off, so an unintelligible value is read as the
operator saying no; the cost of getting that wrong is a `LINK_AUTH_UNVERIFIED` finding,
which is visible, rather than a subprocess they thought they had forbidden, which is not.

An explicit `allowCommand` in deps always wins over the env var, in both directions.

This is still an escape hatch, not a security boundary. Operators who need a hard block
should not configure `command:` sources in the first place.

### Nothing in the engine may throw at the validator

`ExternalLinkValidator.validateLink` calls `resolveAuthenticatedUrl` **outside any
try/catch**. Anything that escapes the engine therefore ends `vat resources validate` and
`vat audit` over the whole tree, for every adopter with `resources.linkAuth` configured, on
account of one link.

`resolveAuthenticatedUrl` owns that boundary: a provider that throws while building the
request for one URL comes back as `{ outcome: 'provider-error', reason }`, which the
validator reports as `LINK_AUTH_PROVIDER_ERROR` (default `error`, never cached). When adding
an engine step, put it inside that try/catch, and keep the internal error types throwing —
the boundary translates them, the producers should stay precise.

🔑 **`provider-error` is not `unverified`, and the statically knowable defects never reach
it from `resources.linkAuth`.** `unverified` means "no token source resolved", and its
registry remedy invites a token-less CI lane to set `LINK_AUTH_UNVERIFIED` to `ignore`; a
provider-config error used to ride under that same outcome, so with the override in place a
mistyped `when` produced a green run over links nothing had fetched. Now
`buildLinkAuthEngineConfig` runs `assertProviderCompiles` (`link-auth/compile-check.ts`)
over every expanded provider — `match.host` globs, `when` regexes, every template's syntax
and transform names, `vars`/capture collisions, and every name a template reads against
what its rule declares — and throws `LinkAuthConfigError` naming `providers[<n>]`, the host
and the field; the CLI turns that into exit 2. The CLI calls it at config load
(`packages/cli/src/utils/resource-loader.ts`, `assertLinkAuthProvidersCompile`), so every
verb on that loader — `vat validate`, `vat resources validate` with or without
`--check-external-urls`, `vat resources scan`, `vat rag index` — refuses the same config
the same way; the registry's own call under the external-URL lane is the second, not the
only, site. What is left for the runtime outcome is per-URL: a declared capture group that
did not participate in this match, or a transform refusing a particular value. When adding a
check to the engine, add its static half to `compile-check.ts` in the same change, calling
the same function the runtime lane calls.

The public `fetchAuthenticated` (`link-auth-content-fetch.ts`) passes `provider-error`
through under its own name with the reason; it is a third `ContentFetchResult` variant, not
`unsupported`, so a consumer that falls back to an anonymous fetch on `unsupported` cannot do
so for a URL the adopter configured authentication for.

Two rules follow for anything under `link-auth/`:

- **Adopter DATA must never reach a `throw`.** Only the adopter's *config* may be judged
  malformed. The worked example is `template.ts`: its unterminated-`${` guard asks the
  question of the template, never of the rendered output, because a URL path segment like
  `skeleton/${{values.name}}/README.md` is ordinary data and used to crash the run.
- **Substituted values are inert.** They are never re-scanned, so a value may contain `${`,
  `${{…}}`, or something that looks like a transform call, and it stays literal.

## Token redaction (§8 "tokens never leak")

The mechanism is `sensitiveHeaderValues(headers)` + `redactSecretsInText(text, secrets)` in
`link-auth/build-headers.ts`. One live call site:

- `link-auth-transport.ts` — everything `fetchImpl` throws. **MEASURED on Node 24.13:** undici
  embeds the header VALUE verbatim in its TypeError —
  `Headers.append: "Bearer <tok>\0" is an invalid header value.` — and an `Authorization`
  value carrying a NUL or an interior newline triggers it. `command: git credential fill`
  produces exactly that, because `resolveToken` only trims the ends of stdout. That message
  reached `vat resources validate`'s stdout through the validator's `safeSerializeError`.
  The probe is `util.inspect` itself (unbounded depth, hidden and Symbol-keyed properties,
  getter values, `Map`/`Headers` contents, a reassigned `.stack`) plus `JSON.stringify` for
  the one thing inspect does not print — a `toJSON` result. The replacement error's message
  is the compact `name: message` / `cause` / `errors` account, redacted, not the inspect dump.
  The redaction matches the JSON-escaped, `util.inspect`-escaped, percent-encoded,
  base64/base64url and case-folded forms of each secret as well as the verbatim bytes; the
  inspect form exists because inspect prints a NUL as `\x00` where JSON prints `\u0000`, and
  a NUL-bearing credential on an own property matched neither, measured.

`link-auth/resolve.ts` deliberately has NO scrub. Every error its catch can see quotes the
template, the pattern or a name — never a substituted value — so its reason text cannot
carry a token, and `test/link-auth/resolve.test.ts` pins that property. A scrub there had
no input that could contain a token, and its guard test passed with the call deleted.

Two design notes worth keeping:

- **An error is replaced only when redaction actually changed its text.** An ordinary network
  failure keeps its original `Error` — exact message, real stack, real class. Rewrapping every
  failure to guard the rare one would trade every diagnosis for one.
- **A `redactHeaders(map) → map` helper used to be documented as this mechanism and had ZERO
  production callers** — its only caller was its own test. It was deleted rather than wired
  up: it is the wrong shape for the leak that was actually happening (it cannot touch a value
  another library has already pasted into a string), and printing a header map is the shape
  under which a name allowlist becomes an unconditional leak. There is no name allowlist any
  more: redaction keys on every rendered header VALUE, because every `auth.headers` /
  `fetch.headers` value is secret-bearing by contract (`PRIVATE-TOKEN`, `X-API-Key` and
  `Authorization` are all just names). The same premise governs cross-origin redirects, which
  are re-fetched bare — every adopter header dropped, not the one named `authorization`. If a
  real map-serializing caller appears, reinstate a helper *with* that caller, keyed the same way.

Any new site that can serialize a header, an error carrying one, or a token must route
through the redaction pair, and must be pinned by a test asserting a literal token string is
absent from the emitted output.

## Testing requirements

### Unit tests

Every new source type, macro, rewrite rule, or token-resolution behaviour needs a unit
test in `packages/resources/test/link-auth/`. Use injected `deps` — never depend on ambient
`process.env` state or real network calls.

Test the **transform allowlist** (`packages/resources/src/link-auth/transforms.ts` — the
map of names to transform functions, callable inside `${…}` templates) for any new
allowed transform. The allowlist protects against arbitrary function invocation via
config; a bypassed transform is a security issue.

Test the **header template** expansion (`${token}` substitution). Verify that a token
containing `}` or other special characters does not escape the template.

### Integration tests

`packages/resources/test/integration/linkauth-cross-slice.integration.test.ts` — verifies
the engine wires together with the real Zod schema, real macro expansions, and the
resources-side validator layer. No real network calls; inject a mock transport when
adding new cases.

### System tests

`packages/resources/test/system/link-auth-token-dispatch.system.test.ts` — exercises real
binaries (`git`, `gh`) through `resolveToken` with no injected deps. This is the
cross-platform canary: on Windows, binaries are `.cmd` shims and dispatch goes through
`shouldUseShell` in `safe-exec.ts`. Keep this test in sync when you change how
`defaultRunCommand` spawns processes.

### What the system test does NOT cover

- Real authenticated HTTP requests (too flaky for CI; test with a mock transport)
- The full validator pipeline (covered by resources integration tests)
- Cache persistence (covered by resources unit tests via `ExternalLinkCache`)

## Code style

Follow the project-wide conventions in `CLAUDE.md`. A few linkAuth-specific notes:

- **No shell execution.** The entire pipeline deliberately avoids `shell: true`. Do not
  introduce shell strings anywhere in the engine.
- **Fail-soft I/O.** Cache reads and writes use fail-soft error handling. Never let a
  cache I/O failure propagate to the adopter as a hard error.
- **Re-classify on cache hit.** Never cache the derived `LINK_AUTH_*` code; cache only
  `statusCode`. The adopter's `check` block may be updated between runs.
- **⛔ No version constant gates the cache — and none may be added.** The cache entry once
  carried a hand-bumped `version: 1` that was checked *instead of* the entry's own fields, so
  it certified a shape it had never looked at: an entry with `version: 1` and a `statusCode`
  of `"200"` was returned as a hit, and the string then reached `isAliveStatus` — a
  `Set<number>.has`, which no string is ever a member of — reporting a live link broken at
  full confidence, from a check that passed. It is gone. What decides whether a stored entry
  is readable is `ExternalLinkCacheEntrySchema` (`packages/resources/src/schemas/external-link-cache.ts`),
  a `.strict()` Zod schema applied at the load boundary in `external-link-cache.ts`.

  **If you change the cache entry shape, change the schema — that is the whole migration.** An
  entry written by the old shape carries a key this build has no field for, `.strict()` makes it
  a miss, and it costs exactly one refetch. Do not add an integer, a `SCHEMA_VERSION`, or any
  other number a human must remember to bump; see the "🚫🚫 NO VERSIONS" section of the repo's
  `CLAUDE.md`, which admits no exception. The one change the schema cannot see is an added
  *optional* field, and the answer there is the TTL (bounded, not immediate) or an explicit
  `vat cache clear` — never a constant.
