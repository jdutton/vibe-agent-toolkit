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
| `build-headers.ts` | Build request headers, substitute `${token}` into templates |
| `template.ts` | Generic `${…}` template substitution with allowlist enforcement |
| `transforms.ts` | Transform functions callable inside templates (e.g. `base64url`) — the safety allowlist for template calls |

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
under `<cacheDir>/auth-${sanitizedOsUser}/external-links.json`. Cache entries carry
`version: 1`; a version mismatch triggers a re-fetch. Do not cache derived LINK_AUTH_*
codes — only the raw `statusCode`; re-classify on every cache hit under the current
provider's `check` block.

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

### VAT_LINKAUTH_ALLOW_COMMAND=0

Set this env var (or pass `allowCommand: false` in `TokenResolutionDeps`) to skip all
`{ command: ... }` sources at runtime. Only `{ env: ... }` sources are tried. Useful in
security-sensitive environments or when the CI policy prohibits arbitrary child-process
execution from the validator.

This is an escape hatch, not a security boundary. Operators who need a hard block should
not configure `command:` sources in the first place.

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
- **No adopter-visible field renames without a version bump.** The cache `version: 1`
  field gates reads. If you change the cache entry shape, bump the version constant and
  update the cache-miss path.
