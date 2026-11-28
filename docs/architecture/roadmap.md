# Roadmap

What VAT plans to build next, across every package, in priority order, and what has been placed
later or declined, each with what would change that. None carries a date. An item leaves this
file in the change that delivers it; git history holds what shipped.

Package-local detail stays with its package and is linked from here, never copied:
the lab's stages ([`packages/lab/docs/roadmap.md`](../../packages/lab/docs/roadmap.md)), the fact
store's deferred items ([Fact Extractors, Deferred](./fact-extractors.md#deferred)) and RAG's
([RAG, Future Enhancements](./rag.md#future-enhancements)). Open defects are in
[`known-defects.md`](../contributing/known-defects.md), not here.

## In front

### Warm runs that pay for the files that changed

An edit moves the git tree key, so the next run misses the whole stored extent. In a cached
validation run, stored per-file rows are reused by content key and git-held files are keyed from
git's snapshot with no read, so VAT reads and parses only the edited files, but it still rebuilds
the extent and the multi-file layer from those rows and still opens every member once for its
readability check. Goal: the developer edit loop, and every pull-request CI run that restores the
default branch's cache, pay for the changed files only. The lab measures it: an edit arm beside a
clean warm arm in one invocation, judged by the gap between them. Each step is gated in tests by
work counters, never by time.

1. **Reuse stored per-file rows on a miss.** One predicate decides which content keys the store
   covers. The extent and the multi-file layer are rebuilt from stored rows, and only uncovered
   files are parsed. Two concurrent writers keep the key ledger and the rows consistent, and a
   read torn between tiers yields a miss, never a wrong answer. Proof: parse lookups at most the
   number of edited files; an independent oracle, against the store being off, that no stale row
   is served; every member read at most once.
2. **Keep the overlapped checks child after a written miss.** Today a miss that writes the store
   turns the overlap off. Its design is reopened and is reviewed against the code before it is
   built.
3. **Typed content identity and Git LFS in the store key.** One `ContentKey` type with one parser,
   one formatter and one total order. LFS content joins the key, so `git lfs pull` makes the next
   run miss.
4. **Modification times in the realizations table.** Breaking. It ships in the release that carries
   the content-key changes: one cold start and one changelog of every breaking change.

### More parsers, and parsers a project adds

Every parser is reached through the one parser-kind router
([`projection/router.ts`](../../packages/resources/src/projection/router.ts)), which makes these
additive. The parse capabilities a parser implements and the load-boundary rule it must keep are in
[Parsers and Load Boundaries](./parsers-and-load-boundaries.md).

5. **Structured-data rows.** Workspace packages (`package.json` workspaces) as rows, on typed
   content keys (item 3), beside the JSON, JSONC and YAML rows already built (the `data__*`
   relations, with their own coverage owner and byte budget).
6. **TypeScript and JavaScript facts from per-file syntax.** Import, import-name and export rows
   ship as syntax (the `ts__*` relations and `ts_imports`: type-only versus value, dynamic imports,
   re-exports, `export *`), as do the tsconfig relations. What remains: resolved targets for the
   import rows (including `package.json` `exports`/`imports` and tsconfig `paths`); declaration
   rows with their literal initializer; and reference and call rows for imported symbols. Syntax
   and module resolution only: no type checker, no language server. Resolution stays out of the
   per-file cache key.
7. **Custom parsers.** A project declares a parser for a file kind VAT does not ship, routed by
   the same router, its rows stored and keyed like the built-in kinds. Gate: a design for the
   registration contract and how a project parser's version enters the cache namespace.

### The check language: rules a project can move out of its own scripts

`vat resources check` and `vat resources query` judge a repository with SQL over stored rows. A
project moving its own guard scripts into checks finds rules that the rows could answer but the
language cannot yet say. Goal: every rule whose inputs are committed JSON, YAML or file listings is
expressible as a check, with no second copy of the rule left in the project. Each item below names
the kind of rule it unblocks.

8. **Regular-expression extraction.** `regexp(pattern, text[, flags])` and the `REGEXP` operator
   ship (see [`vat resources query`](../../packages/cli/docs/resources.md)); they say whether a
   pattern matches, not what it matched. What remains is every match with its capture groups, for
   rules that pull names out of free text: script and file names in CI workflow `run:` strings and
   in `package.json` script bodies, followed from script to script to a fixed point by a recursive
   CTE. The rows are already there: a multi-line `run:` value is held whole, one value per
   `/jobs/<id>/steps/<n>/run` pointer. One difference from a raw-text scan is deliberate: a text
   scan also counts a name inside a YAML comment, and rows hold no comments.
   - **Today:** many such rules can already be written when the candidates are a finite set the
     rows hold: join each candidate (a path `resource_realizations` lists, a script key
     `data__values` holds) to the text, test it with the shipped `regexp()`, and recurse with a
     CTE. What cannot be written is a rule whose names are not already rows.
   - **What the engine allows:** VAT's SQLite is `node:sqlite` (`DatabaseSync`), which registers
     scalar functions (`function()`) and aggregates (`aggregate()`) but no table-valued functions.
     A native extension would need `loadExtension`, and VAT ships no native binaries.
   - **Design:** a scalar `regexp_matches(text, pattern[, flags])` that returns a JSON array of
     matches with their capture groups, expanded into rows by the built-in `json_each()`:
     `FROM data__values v, json_each(regexp_matches(v.value, '...'))`.
   - **Risk, and the open choice:** the hazard is the one the shipped `regexp()` already carries.
     JavaScript's `RegExp` backtracks and a synchronous SQL function cannot be interrupted, so a
     catastrophic pattern runs until the run's own budget stops it: `vat resources check` at its
     default budget, `vat resources query` only under `--budget` (the bounds are in
     [`vat resources check`](../../packages/cli/docs/resources.md#vat-resources-check-path)).
     Extraction widens the exposure, since it scans the whole text where a test stops at the first
     match. Either keep that bound as the answer, vet each pattern with the repository's ReDoS
     rule (`security/detect-unsafe-regex`), or match with V8's linear-time engine, which exists
     only behind the `--enable-experimental-regexp-engine` flag and the `l` regexp flag, so never
     in a default run. Vetting alone is weaker: a rewrite can satisfy that rule while staying
     quadratic, which is why VAT's own hardened patterns are pinned by a growth-ratio test rather
     than by the linter.

   What would bring it forward: the first rule that reads CI or script text for names the rows do
   not already list.
9. **Content digests.** `sha256()` ships. Two digests remain:
   - A canonical-content digest per JSON or YAML node or subtree (keys sorted, in the style of
     RFC 8785, ideally with named keys excluded), for rules that pin a schema's shape by digest. A
     recursive CTE cannot rebuild a sorted subtree from pre-order rows, so this cannot be written
     in SQL today.
   - The SHA-256 of a file's raw bytes as a documented column. `blob` is not one: a tracked file's
     `blob` is its git object ID, which hashes git's object header with the bytes, and only a file
     read from disk is keyed by the SHA-256 of its bytes
     ([`vat resources query`](../../packages/cli/docs/resources.md) says not to parse a digest out
     of it). `sha256()` hashes a value, not the file it came from.

   What would bring it forward: a rule that compares committed digests against content.
10. **Excusing one empty include glob.** A check already asserts its own input (`examined` over
    `data__routes`, failing as `RESOURCE_CHECK_EXAMINED_NOTHING`), and an include glob that routes
    nothing is a `DATA_INCLUDE_GLOB_INERT` warning. What remains is the reach of the excuse: the
    data extractor's `allowEmpty` covers the whole block, and a severity override covers the whole
    code, so a project that lets a fixture tree omit one file also silences a mistyped glob or one
    whose file moved. `allowEmpty` per glob would excuse that one glob alone. What would bring it
    forward: a project that needs a deliberately empty glob beside globs it wants watched.
11. **Materialized computed relations.** A plain `WITH` term that reads a computed relation
    (`data__values`, or the join of realizations to resources) can be evaluated again at each
    reference; the `AS MATERIALIZED` workaround is documented, with its measurement, in
    [`vat resources query`](../../packages/cli/docs/resources.md). What remains is the engine half:
    evaluate each computed relation once per statement, so a check needs no workaround. What would
    bring it forward: a second slow check.
12. **Reading the base tree.** Shrink-only ratchet rules ask whether a count grew against the
    merge base, so they need a committed file as it stands in the base commit. Today that half of
    such a rule cannot move into a check and stays in the project. What would bring it forward: a
    design for which base a run reads (the merge base of the current branch, or a named ref) and how
    a base-tree read enters the store key.

## Later

- **Nested repositories (git submodules).** A general design exists: every mode `160000` entry
  with a git directory gets its own snapshot, LFS pass and reader, and joins the store key as a
  digest of each repository's tree key. Until then a submodule's contents are walked from disk
  and are not in the store key, so an uncommitted edit inside one is served stale (a
  [known defect](../contributing/known-defects.md#an-uncommitted-edit-inside-a-submodule-is-served-stale)).
  What would bring it forward: a VAT user whose repository has submodules.
- **Speed-ups with diminishing returns.** Measured once the warm edit loop is done, each worth a
  fraction of a second per run:
  - an integer surrogate key for extent rows;
  - decoding only the blob tables a run declares;
  - an incremental Claude rules scope;
  - one `git status --porcelain=v2` walk instead of several.

  The long-run direction behind them is to query stored rows in place instead of hydrating them.
  What would bring them forward: a lab measurement where one of them dominates a warm run.
- **A routing edit that re-derives only what it changed.** Editing one `include` line of the data
  extractor config re-derives the whole population on the next run, a cold run where a store hit
  was expected. Reusing stored per-file rows on a miss (item 1) is the likely base for it. What would bring it forward: projects that edit routing often enough
  for the cold run to be felt.
- **Evaluating checks in parallel.** Checks run one after another, and stay simple until a
  measurement shows check evaluation, not population, dominates a run. What would bring it forward:
  that measurement.
- **Storing the tsconfig relations.** The `tsconfig_*` relations are recomputed on every run
  that names one, a warm run included, rather than stored: about 1.7 s more on a warm run that
  names one, measured once under load. That cuts against warm validation reading only stored
  facts. Storing them needs a key that moves exactly when a demanded config, its `extends` chain
  or the git-content listing it matched against changes. What would bring it forward: a lab
  record where the recomputation dominates a warm run that names them.
- **A layout fact for generated files.** A check over rows compares values, never bytes, so a
  rule that a generated file is current byte for byte (this repository's generated tsconfig
  references: line endings, the final newline, whitespace, strict JSON) cannot become a check,
  and its port stays a TypeScript gate. Either layout moves to a formatter gate and the port
  compares values over `data__values`, or a layout fact (the file's bytes or a canonical
  serialization digest) becomes a column. The raw-bytes digest of item 9 is one form such a
  column could take. The half that asks whether every workspace package is referenced is
  expressible today over `workspace_packages` and `tsconfig_closure`. What would bring it
  forward: a ruling on which of the two, or a second generated-file rule.

## Declined, with what would reopen it

- **A per-tsconfig TypeScript program for facts.** Facts come from per-file syntax so each file's
  rows depend only on that file. Reopens if a needed fact cannot be derived without the checker.
- **A "committed artifact equals generator output" primitive.** Render-and-compare rules (a
  committed file that a project script derives from other files) stay in the project. Porting the
  generator into SQL is a second implementation of it, and the two drift. Reopens if VAT can run a
  project's own generator as a declared step and compare its output, without restating the
  generator.
- **A seam for a project-supplied judgement function.** A rule whose judge is a tested library in
  the project cannot move into a check without copying that judge. VAT does not run project code
  inside a check. Reopens with a design for how project code is registered, sandboxed and keyed,
  the same question custom parsers (item 7) must answer first.
