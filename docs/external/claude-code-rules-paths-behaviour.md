# Claude Code — how a `.claude/rules/` file's `paths:` is read and matched

> **Source:** the shipped Claude Code binary, version 2.1.280
> (`~/.local/share/claude/versions/2.1.280`), read with `strings -n 6`. Anthropic publishes no
> documentation for any of the behaviour below.
> **Read:** 2026-09-22
>
> @vendor-claim reviewed=2026-09-22 verify=Install the current Claude Code, run `strings -n 6` over its binary, re-find the rules-file reader by its `if(!n.paths)return{content:r}` shape and the matcher by its `.ignores(` call, and diff both against the transcriptions below; update this file and `packages/resources/src/projection/claude-context-rules.ts` together
>
> **Refresh policy:** re-read on adopting a Claude Code release that changes rules loading, or
> every ~90 days, whichever is sooner. VAT's model of this behaviour is
> `harnessPaths` (stored per `(blob, harness)` as `harness_blob_facts.paths` by `claude-memory.ts`) /
> the pattern matcher in `packages/resources/src/projection/claude-context-rules.ts`; this file is
> the only evidence for it, so the two are updated together or the model is unsourced.

## Why this cache exists

VAT reports a rule's `paths:` globs as dead (`CLAUDE_RULE_GLOB_INERT`) and counts a rule as
always-loaded or path-scoped in `vat claude context`. Both answers are only as good as VAT's model
of what Claude Code itself does, and the vendor documents none of it — the published examples show
a YAML sequence and stop there. Every divergence found so far produced a wrong answer an adopter
would act on, including a finding whose remedy deletes a working glob.

## The reader

Transcribed from the rules-file reader (also reached for `@include`d files):

```js
function kyn(e){let{frontmatter:n,content:r}=ts(e);if(!n.paths)return{content:r};
  let s=pet(n.paths).map((g)=>g.endsWith("/**")?g.slice(0,-3):g).filter((g)=>g.length>0);
  if(s.length===0||s.every((g)=>g==="**"))return{content:r};
  return{content:r,paths:s}}
```

So, in order: normalise (below), **strip a trailing `/**` from every pattern**, drop what is left
empty, and — if nothing survives, or every survivor is `**` — return the file with **no `paths:` at
all**, which means it loads on every turn. The same shape guards skills (`fNt`).

## The normaliser

```js
function C(e,n){if(Array.isArray(e))return e.flatMap((a)=>C(a,n));   // RECURSES into nested arrays
  if(typeof e!=="string")return[];                                    // a number, a map: nothing
  /* split on "," at brace depth 0, trim each part, drop empties */
  return r.filter((a)=>a.length>0).flatMap((a)=>N(a,n));}             // then brace-expand
var D=1000,z=4194304;                                                 // pattern and byte budgets
function N(e,n){if(!e.includes("{"))return[e]; /* … */}               // brace-free: no budget spent
```

A **string is a pattern list**: `paths: "a/**, b/**"` is two patterns, and a comma inside `{…}`
never splits. Brace expansion is `split(",")` only — **there is no `{1..n}` range expansion**, and
the 1,000-pattern / 4 MiB budgets are spent per pattern as expansion proceeds. Exhaustion refuses
**only the pattern that exhausts the budget** (it is used unexpanded): later patterns still call
`N`, and a brace-free one early-returns and stays fully live. The byte charge is
`n.bytes -= r.length * e.length` — the ORIGINAL pattern's length per result, not each result's own
length — guarded by `n.bytes<0 || u>n.results || u*e.length>n.bytes`.

## The matcher

The consumer builds a **`node-ignore`** matcher over the *stripped* patterns and asks it about each
repo-relative path (`j7e.default().add(globs).ignores(relPath)`; `node-ignore`'s own source is in
the same binary). These are **gitignore semantics, not picomatch**: a pattern with no slash is
unanchored and matches at any depth, and a matched directory carries its subtree. This is why
`src/**` — stripped to `src` — matches `packages/cli/src/index.ts`.

## Symlinked rules

A rules file or rules directory reached through a symlink whose target resolves **outside the
original working directory** is **skipped**, not loaded (`Lke`, with `includeExternal` false: the
directory arm returns `[]` and the file arm `continue`s when the resolved path is not inside the
cwd). A link whose target stays inside the root is loaded normally. So "share one rule set across
repositories by symlink" does not work in the lanes VAT models, and any claim that it does needs a
source this file does not have.
