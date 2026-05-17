# Roots and Config — Canonical Concepts

VAT distinguishes three root concepts. Each has a single discovery function in
`@vibe-agent-toolkit/utils`, a documented purpose, and a clear "returns null when"
contract. Conflating them is the historical bug this doc exists to prevent.

This page is the source of truth referenced by every command's `Requirements:`
help block.

## The three roots

| Concept | Discovery | Purpose | Returns `null` when |
|---|---|---|---|
| **`projectRoot`** | nearest `vibe-agent-toolkit.config.yaml` → else nearest `.git/` | The VAT authoring boundary for a run. Used for URI-reference resolution (leading-`/` links), asset references, `isWithinProject` gates, validation scope, gitignore-safety scope. | No config and no `.git/` ancestor exist anywhere up the tree. |
| **`gitRoot`** | nearest `.git/` | Version-control operations only — gitignore filtering, git metadata. Never used as a stand-in for `projectRoot`. | Not in a git repository. |
| **`nodeWorkspaceRoot`** | nearest `package.json` with a `"workspaces"` key | Node-specific tooling: monorepo binary discovery, locating the dev-mode CLI build, plugin dist build paths. Absent for Python skills, single-skill repos, plain doc projects. | No workspace `package.json` ancestor exists. |

**Key principle: each discovery function returns `string | null`.** No internal
fallbacks. The fallback policy is enforced at the CLI boundary, per command —
see [Per-command policy](#per-command-policy) below.

All four functions (the three above plus `findConfigFile`) live in
`@vibe-agent-toolkit/utils`. Library code never invokes them directly; CLI
dispatch passes the resolved root(s) into the libraries it orchestrates.

## The projectRoot ladder

`findProjectRoot(startDir)` walks ancestors checking two independent conditions,
in this order:

1. Is there a `vibe-agent-toolkit.config.yaml` at this directory? → return this directory.
2. Is there a `.git/` at this directory? → return this directory.
3. Otherwise, ascend one level and repeat.
4. If filesystem root is reached without a hit → return `null`.

The two checks compete on a per-directory basis: at every ancestor we ask
"config here?" first, "`.git/` here?" second. The **nearest config-anchored
ancestor wins** even if a `.git/` ancestor sits closer to `startDir`, because
the config file is a stronger declaration of intent than the version-control
boundary. A skill nested in a sub-package with its own
`vibe-agent-toolkit.config.yaml` honors its sub-package's config, not the
monorepo's git root.

### Why config-file existence does not *define* projectRoot

A run can have a `projectRoot` without a config file (a bare git repo with no
`vibe-agent-toolkit.config.yaml`). A run can also have a config supplied
programmatically (tests, SDK embedding) without any file on disk. **Config is a
value that can be loaded, supplied, or absent — independent of the directory
question.** The config file's location *informs* `projectRoot` discovery; it
does not *define* `projectRoot`.

## The CLI-boundary discovery rule

**`find*Root()` is called only at CLI dispatch or top-level CLI command entry.**
Inner functions take the roots they need as parameters.

This rule is non-negotiable across the VAT codebase. Reasons:

1. **Testability.** Inner functions stay unit-testable without filesystem state.
   Tests pass roots explicitly; no need to scaffold `.git/` or config-yaml
   fixtures into the wrong place.
2. **Performance.** Discovery walks the filesystem. Calling it once at the
   boundary — instead of inside every nested utility — keeps repeated calls
   off the hot path.
3. **Predictability.** Centralizes the "did discovery fall back to `cwd`?"
   question to one place. Eliminates the "odd, well-it-used-to-work fallback"
   bugs caused by inner functions silently re-discovering a different root.
4. **Policy centralization.** Per-command policy ("required vs. tolerate-null
   vs. loud-cwd") lives at the boundary, next to the help text that documents
   it, not buried inside a library.

Enforcement is via code review today. A future `vat audit` rule could
mechanize this.

## Per-command policy

Every CLI command declares its `projectRoot` policy and config policy. The
policy lives in two places that must agree: the command's
`.addHelpText('after', ...)` block (visible via `vat <cmd> --help`) and the
per-command CLI reference doc under `packages/cli/docs/` or `docs/cli/`.

### projectRoot policies

| Policy | Behavior |
|---|---|
| `N/A` | Command does not use `projectRoot` at all. |
| `tolerate null` | Command runs without one; a `null` result is fine. |
| `loud-cwd` | Command falls back to `cwd` with an explicit stderr warning. See [Loud-cwd fallback](#loud-cwd-fallback). |
| `required` | Command refuses to run without a discovered `projectRoot`. Fails fast with a clear error message. |

### Config policies

| Policy | Behavior |
|---|---|
| `not used` | Command does not read `vibe-agent-toolkit.config.yaml`. |
| `accept defaults` | Runs with built-in defaults if no config file exists. |
| `required file` | Needs a real `vibe-agent-toolkit.config.yaml` on disk. |
| `required fields` | Config file must contain specific non-default fields (e.g. `skills.*`, `rag.*`). |

### Per-command matrix

| Command | `projectRoot` policy | Config policy | Notes |
|---|---|---|---|
| `vat doctor` | tolerate null + report as finding | accept defaults | Diagnostic; runs anywhere. |
| `vat inventory` | N/A | not used | User-level enumeration. |
| `vat audit [target]` | per-skill walk-up (each scanned skill walks up to its own governing `projectRoot`) | accept defaults | Skills with no governing config or git ancestor are reported as ungoverned. External/community auditing supported. |
| `vat corpus scan` | tolerate null | accept defaults | External corpus operations. |
| `vat resources scan [path]` | `[path]` if given; else loud-cwd | accept defaults | Discovery only. |
| `vat resources validate [path]` | `[path]` if given; else loud-cwd | accept defaults | `--frontmatter-schema` independent. Leading-`/` link resolution scopes to the discovered `projectRoot`. Once cwd-fallback fires, `projectRoot` is cwd and leading-`/` links resolve against cwd. |
| `vat rag index [path]` | tolerate null | required fields (`rag.*`) | Cannot index without store config. |
| `vat rag query <text>` | tolerate null | required file with `rag.*` | Locates configured store. |
| `vat rag stats` / `vat rag clear` | tolerate null | required file with `rag.*` | Same. |
| `vat agent list` | N/A | not used | User-level. |
| `vat agent installed` | N/A | not used | User-level. |
| `vat agent build <pathOrName>` | required | required file with `agents.*` | Explicit adoption. |
| `vat agent run <pathOrName> <input>` | tolerate null | accept defaults | Path-explicit. |
| `vat agent validate <pathOrName>` | required | accept defaults | Source-mode validation. |
| `vat agent import` / `install` / `uninstall` | N/A | not used | User-level. |
| `vat mcp list-collections` / `serve` | N/A | not used | Server operations. |
| `vat skills build` | required | required file with `skills.*` | Canonical explicit-adoption command. |
| `vat skills validate` | required | accept defaults | Source validation. |
| `vat skills list` | tolerate null (`--user` skips it entirely) | accept defaults | Project vs. user-level. |
| `vat skills install` | N/A | not used | User-level. |
| `vat skills package` | required | required file with `skills.*` | Packaging is adoption. |
| `vat skill review <target>` | tolerate null | accept defaults | Single-skill review. |
| `vat claude *` | N/A | not used | User-level Claude config. |
| `vat build` (orchestrator) | required | required file with required fields per phase | Orchestrator. |
| `vat verify` (orchestrator) | required | required file | Verifies published artifact. |

## Loud-cwd fallback

For commands declared `loud-cwd`, when `findProjectRoot(cwd)` returns `null`,
the command does **not** fail. Instead it falls back to `cwd` as the effective
`projectRoot` and emits a single stderr warning:

```
warn: no vibe-agent-toolkit.config.yaml or .git/ ancestor; using <cwd> as projectRoot
```

After this point the command behaves as if `projectRoot === cwd`. For
`vat resources validate`, this means leading-`/` links and frontmatter
URI-references resolve against `cwd`. The `absolute_no_root` failure mode for
leading-`/` links fires only when `projectRoot` is genuinely undefined —
typically a programmatic embedder that has not supplied one.

The warning is never silent. It is the contract that distinguishes "you forgot
to set up a project" from "we silently picked a surprising root."

## Config-file location vs. projectRoot

Two distinct ideas that often correspond but are separable:

- The **config file** is a *value* — a `ProjectConfig` object. It can be loaded
  from disk, supplied programmatically, or be absent (in which case the command
  either accepts defaults or fails per its config policy).
- The **`projectRoot`** is a *directory*. It is the authoring boundary used by
  link resolution, `isWithinProject` gates, and gitignore scoping.

In the common case (a project with `vibe-agent-toolkit.config.yaml` at its
root), the config file lives inside `projectRoot` and the discovery functions
return the same directory. But VAT does not assume this: tests and embedders
can supply a config without a file on disk, and a bare git repo can have a
`projectRoot` without a config. **The function that finds the config file
(`findConfigFile`) is separate from the function that finds the project root
(`findProjectRoot`).** They share a discovery ladder but answer different
questions.

## Path utilities

When code crosses the CLI boundary and joins or resolves filesystem paths, it
uses `safePath.join` / `safePath.resolve` / `safePath.relative` from
`@vibe-agent-toolkit/utils`. These wrappers always return forward slashes so
Windows and Unix behave identically. Local ESLint rules (`no-path-join`,
`no-path-resolve`, `no-path-relative`) enforce this — see the repository
[`CLAUDE.md`](../../CLAUDE.md) for the rationale.

## See also

- [`CLAUDE.md`](../../CLAUDE.md) — repo-level guidance, including the
  CLI-boundary rule under "Project-Specific Technical Principles".
- [`docs/validation-codes.md`](../validation-codes.md) — every VAT validation
  code, including the `broken_file` variants emitted for leading-`/` link
  failures.
- [`docs/guides/collection-validation.md`](../guides/collection-validation.md)
  — per-collection frontmatter validation; leading-`/` resolution applies to
  frontmatter URI-references identically to markdown body links.
