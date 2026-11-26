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

An edit moves the git tree key, so today the next run misses the whole stored extent and
re-reads, re-keys and re-looks-up every file, although the store already holds rows for almost
all of them. Goal: the developer edit loop, and every pull-request CI run that restores the
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
4. **Git-held files keyed by object ID.** Members take their identity from git's index, with no
   disk read. This needs a vibe-validate release that stages with `--sparse`.
5. **Modification times in the realizations table.** Breaking.

### More parsers, and parsers a project adds

Every parser is reached through the one parser-kind router
([`projection/router.ts`](../../packages/resources/src/projection/router.ts)), which makes these
additive. The parse capabilities a parser implements and the load-boundary rule it must keep are in
[Parsers and Load Boundaries](./parsers-and-load-boundaries.md).

6. **Structured-data rows.** YAML files as queryable rows beside the JSON and JSONC rows already
   built (the `data__*` relations, with their own coverage owner and byte budget), and workspace
   packages (`package.json` workspaces) as rows, on typed content keys (item 3); git object-ID
   keys (item 4) move them once.
7. **TypeScript and JavaScript facts from per-file syntax.** Import rows with resolved targets
   (including `package.json` `exports`/`imports` and tsconfig `paths`), type-only versus value,
   dynamic imports and re-exports; the export map, including `export *`; declaration rows with
   their literal initializer; reference and call rows for imported symbols; and tsconfig file
   membership. Syntax and module resolution only: no type checker, no language server. Resolution
   stays out of the per-file cache key.
8. **Custom parsers.** A project declares a parser for a file kind VAT does not ship, routed by
   the same router, its rows stored and keyed like the built-in kinds. Gate: a design for the
   registration contract and how a project parser's version enters the cache namespace.

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

## Declined, with what would reopen it

- **A per-tsconfig TypeScript program for facts.** Facts come from per-file syntax so each file's
  rows depend only on that file. Reopens if a needed fact cannot be derived without the checker.
