# Command Population — Open Questions

**What this is.** The backlog behind the [Command Population Matrix](./command-population-matrix.md).
Two lists: every question that matrix marks `⚠️ undeclared`, and every place a document and the code
make claims that disagree. The matrix states what the system is; this file states what has not been
decided about it, and what is written down wrongly.

**This is a working document and it is expected to shrink.** A question leaves when somebody rules on
it and the ruling is declared somewhere the matrix can cite. A divergence leaves when the claim and
the code agree. Neither leaves by being read carefully: nothing here is resolvable by reading the
code, which is what makes a question a question rather than a defect.

Citations name a file and a symbol, never a line number — same convention as the matrix, for the same
reason: a symbol survives a refactor and can be grepped, a line number can do neither.

## Contradictions between documents and code

Each is a specific, falsifiable claim that the code does not support. A closed one keeps its entry
rather than being deleted, marked **fixed** and naming the change that closed it, so the pattern
stays legible.

### The inventory population header called the projection an opt-in second implementation

**Claim:** "opt-in second implementation", of a lane that had become the default.
**Where:** the module docstring of `packages/claude-marketplace/src/inventory/inventory-population.ts`.
**Status: fixed** at `b4afef72` — the header now says the projection is the default. See
[the inventory selector](./command-population-matrix.md#the-inventory-selector).

### The scanning document declined the untracked ruling instead of making it

**Claim:** "a separate product decision this document does not make", of the untracked question.
**Where:** `docs/architecture/resource-scanning-and-caching.md` §2.
**Status: fixed** — §2.1 now declares the ruling instead of declining it, and
`packages/resources/src/resource-registry.ts › ResourceRegistry.crawl()` conforms to it.

### The filesystem extent's narrowing claim was reasoned rather than measured

**Claim:** "This extent cannot be narrowed — dropping non-markdown loses real members".
**Where:** the module docstring of
`packages/resources/src/projection/contributors/filesystem-extent.ts`, which documents
`FilesystemExtentContributor`.
**Status: fixed, on a re-derived and NARROWER reason.**
`packages/resources/test/projection-extent-narrowing.test.ts` builds
`SKILL.md → scripts/tool.mjs → docs/note.md`, withholds the non-markdown row, and measures the loss.
The claim survives because the script is a **direct** link target of its own root: a markdown file
links to a non-markdown file, so narrowing to markdown loses a member outright. Measured member sets
are 2 wide (`SKILL.md`, `scripts/tool.mjs`) and 1 narrowed (`SKILL.md`).

⚠️ **The transitive half of the original reason is gone, and it was never re-derivable.** When the
fixture was written, every non-`.html` file went to the remark parser, so the script's JSDoc
reference lexed as an AST `markdown-link` and the leaf was a transitive member. Parse routing is now
MIME-driven: a `.mjs` routes to no document parser, emits no `markdown-link` /
`markdown-link-reference` / `markdown-definition` row, and its two references to the leaf both lex as
`bare-token` — a form `packages/resources/src/schemas/project-config.ts › ExtentDeclarationSchema`'s
default `follow` does not traverse. `docs/note.md` is now on disk, enumerated by the extent, and a
member of nothing. **Bundled scripts are closure members; they are not closure doors.** The arm that
pinned the old precondition was deleted rather than kept alive on a contrived population, and its
subject is recorded in the suite header. What that leaves undeclared is filed below as
[should a closure follow the paths a non-parsed file names?](#should-a-closure-follow-the-paths-a-non-parsed-file-names).

### Plugin-local discovery is described as tracked-only and as seeing untracked directories

**Claim:** "Discovery honors the same git visibility as the tree-copy (tracked files only, inside a
git repo)".
**Where:** `docs/architecture/skill-packaging.md` § *One listing, one answer*.
**Status: open, and self-contradicting** — the same paragraph then describes warning about untracked
skill directories, which requires seeing them. Two listings exist in
`packages/agent-skills/src/plugin-distribution-layout.ts` —
`listPluginSourceSkillDirs()`, tracked-only, and `listUntrackedPluginSkillDirs()`, everything — and
the sentence describes only the first while the paragraph describes both. See
[plugin-local skill visibility](./command-population-matrix.md#plugin-local-skill-visibility).

### The resources selector is described as covering every route that loads resources

**Claim:** the selector "covers `vat resources scan`/`validate`, `vat rag index` and the pipeline
oracles in one place — they all load through `loadResourcesWithConfig`".
**Where:** `docs/architecture/resource-scanning-and-caching.md` §3.4, and
`packages/cli/src/utils/resource-loader.ts › RESOURCES_CRAWL_ENV`.
**Status: open** — true of those four, but `vat audit` builds its registry through
`crawlAndResolveRegistry` (called from `packages/cli/src/commands/audit.ts › validateSingleSkill()`)
with no `populationSource`, and is therefore reachable by no selector. The sentence is accurate about
what it lists and reads as a claim of completeness.

### Cache recovery is documented for a corruption nothing detects

**Claim:** "None of them is durable — recovery is always rescan", of the four caches.
**Where:** `packages/cli/src/commands/cache/index.ts › createCacheCommand()`, in its help text.
**Status: open, and narrow** — true of the caches, but `vat cache clear` is documented as the
recovery path for a *corrupt* cache while nothing detects corruption, so the operator is the
detector. Not wrong; unfalsifiable as written.

### Two config keys answer which skills a project has

**Claim:** two different config keys answer "which skills does this project have".
**Where:** `packages/cli/src/commands/skills/list.ts › listCommand()` reads
`resources.include`/`resources.exclude`; every other skills lane reads `skills.include` via
`packages/cli/src/commands/skills/skill-discovery.ts › discoverSkillsFromConfig()`.
**Status: open** — `vat skills list` can disagree with `vat skills validate` about the skill set of
the same project, by construction rather than by drift, and no diagnostic says so.

### Detectors are described as never walking the filesystem

**Claim:** "Detectors are pure consumers of inventory data — they never walk the filesystem
directly".
**Where:** [`docs/architecture/README.md`](./README.md), Audit System §.
**Status: open** — accurate about the *detectors*, but `vat audit` itself reaches five enumeration
seams, one of which — `packages/claude-marketplace/src/inventory/extract-skill.ts ›
crawlSkillLinkRegistry()` — bypasses `ResourceRegistry.crawl` entirely and so is invisible to the
crawl-timing bracket that would otherwise account for it.

## The open questions

Every cell the matrix marks `⚠️ undeclared`, collected. These are decisions, not defects. Nothing
here should be resolved by reading the code, and a gate must never accept `⚠️ undeclared` as a
satisfied state: it is a request for a ruling, and accepting it would convert an open question into a
permanent one.

**Already decided, recorded so neither is re-litigated.** Whether `tracked ∪ (untracked ∧ ¬ignored)`
is the universe for every command was decided and declared at
`docs/architecture/resource-scanning-and-caching.md` §2.1 — it is now the matrix's
[universe rule](./command-population-matrix.md#the-universe-rule). What the blob-stage flags should
be called was decided and declared at `packages/resources/src/projection/merge.ts ›
CONTENT_PARSING_DERIVE` / `› CONTENT_PARSING_SKIP`; the matrix keeps the record of what the old name
asserted and the false conclusion it produced.

### Does the ruling bind packaging populations?

**Does the ruling bind packaging populations — what *ships* — as well as validation populations?**
`vat claude plugin build` deliberately ships tracked-only and warns
([plugin-local skill visibility](./command-population-matrix.md#plugin-local-skill-visibility)).
Under the universe rule's set, an untracked-not-ignored skill *would* be in a commit, so it should
ship. Under "you ship what you committed", it should not. Both readings are defensible and they
disagree.

### Does the ruling bind populations that are not git-backed?

Outside a working tree the concepts do not exist and the whole tree is the population. Nothing says
whether that is the intended answer or an accident of there being no oracle.

### Is the raw readdir route intended, or is it drift?

Most commands whose population source names it enumerate with no git awareness at all, so neither
selector nor `.gitignore` reaches them — and `vat audit` proves the route does not require that: the
same `fs.readdir` recursion in `packages/cli/src/commands/audit.ts › scanDirectory()`, but pruning
gitignored paths through its own `GitTracker` in `› buildGitIgnoreMap()`, reachable by no selector
either way. So the route is one mechanism carrying several behaviours, and nothing says which of them
a new command should reach for.

### Should vat audit be on the projection lane?

It is the highest-volume enumerating verb and is reachable by no selector.

### Should a packaging or verify verb see gitignored build output deliberately?

Today it sees `dist/` because its route never filters, not because a rule grants it.

### What is the intended non-git behaviour for a corpus carrying a .gitignore?

SharePoint, OneDrive and iCloud corpora are in scope; a `.gitignore` there is inert.

### Which commands are entitled to have no population at all?

The matrix's list of commands that enumerate nothing is a judgement call that document makes and no
rule supports.

### Is the inventory projection meant to stay plugin-directory-only?

`packages/cli/src/commands/inventory.ts › populationProviderFor()` gives a rootedness *reason* for
excluding the marketplace, `--user` and single-skill shapes, not an intent that they stay excluded.

### Should the content demand belong to the lane or to the consumer?

`contentDemand` is now a per-registration constructor parameter
(`packages/resources/src/projection/contributors/filesystem-extent.ts ›
FilesystemExtentContributor.constructor()`), and the two lanes already state different demands — the
matrix's content-read table shows `deferred` against `deferGitignored`. That one contributor needed
two answers is what keeps the question live rather than settling it: nothing declares whether the
demand belongs to the lane that registers the contributor or to the consumer that reads the result,
so a third consumer has no rule to follow.

### Should a closure follow the paths a non-parsed file names?

**Opened by the re-derivation of
[the filesystem extent's narrowing claim](#the-filesystem-extents-narrowing-claim-was-reasoned-rather-than-measured).**
A skill's `scripts/tool.mjs` names `docs/note.md` and nothing in VAT walks that edge, so a data file
reachable only from a bundled script is in no skill's closure — it will not be packaged, and no
membership check can see that it is missing. This was previously invisible: while every non-`.html`
file went to the remark parser, a path named in a JSDoc comment happened to lex as `markdown-link`
and was followed, so the gap existed only for paths written outside comments.

The one mechanism available today is widening `packages/resources/src/schemas/project-config.ts ›
ExtentDeclarationSchema`'s default `follow` to include `bare-token`, and that was **declined**:
`bare-token` is 21,687 rows on this repo alone, so every `import` specifier and every path-shaped
string would become a closure edge. What is undeclared is whether the gap should be closed some other
way — a narrower lexical form, a per-collection opt-in, or a rule that a script declares its own data
files — or accepted as the price of not following strings. Widening `follow` is its own change with
its own measurement, never a side effect of parse routing.

### Should a command ever report a gitignored file rather than dropping it?

`vat skills list` does, uniquely — see
[gitignored status as an annotation](./command-population-matrix.md#gitignored-status-as-an-annotation).
If that is the right model, the other routes are wrong; if it is not, it is.

### Is a denylist the intended shape for the org skill-upload set?

`vat claude org skills install` walks the skill directory and uploads what it finds, filtered by
`packages/cli/src/commands/claude/org/skills.ts › NEVER_UPLOADED_DIR_NAMES` — `evals`,
`node_modules`, `.git` — plus any declared eval-suite input, resolved inside
`› collectSkillUploadFiles()` so no caller can obtain a set with the exclusion skipped, as that
function's docstring states; and every exclusion is reported rather than silent, which is what
`› CollectedUploadFiles.excluded` exists for. It deliberately does not consult git, and that is
correct: a skill legitimately ships generated assets git ignores. What is undeclared is the SHAPE — a
denylist can only exclude what somebody thought of, so a stray `.env` or scratch note at the skill
root still uploads, where an allowlist (the skill declares what it ships, as npm `files` does) could
not.

### Is the skill link registry meant to be a separate seam?

`packages/claude-marketplace/src/inventory/extract-skill.ts › crawlSkillLinkRegistry()` calls
`crawlDirectory` and feeds `addResources` without going through `ResourceRegistry.crawl`, so it is
reachable by no `populationSource` and is outside the accounting bracket. Three commands depend on
it.

### Should a single-named-path verb ever enumerate the whole project?

`vat skill review` names one skill and crawls the project twice; `vat skill test run` and
`vat agent run` enumerate to resolve a bare name. Nothing says whether that is intended cost or
accidental reach.

## Related

- [Command Population Matrix](./command-population-matrix.md) — the permanent half: what each command's
  population is, per command and per git-vs-non-git corpus.
- [Resource Scanning and Object Caching](./resource-scanning-and-caching.md) — the authority on
  mechanism, and the home of the universe rule.
