# Parsers and Load Boundaries

**Status: half shipped, half intended, and each section says which.** The **parser** half is built —
the three capabilities are named in code, a `ParseFacts` conformance suite exists, and a second
implementation has been run through it (§5 steps 4–6). The **load-boundary** half is still a target:
every published barrel violates the rule in §4, and steps 1–3 are open. Read no section as a
description of shipped code unless it says so.

Two ideas, and they are the same idea seen from two ends:

1. **VAT does not need *a parser*. It needs three capabilities** — now named as interfaces, though
   one implementation still supplies all three, and a caller who wants only the cheapest still pays
   for the tokenize that serves them all.
2. **Nothing heavy may load unless it is being used.** No parser, no vector store, no database
   driver — including the ones built into Node. As VAT grows, the barrel is the thing that must
   stay light, because every consumer of every symbol pays for it.

## 1. The parse seam already exists, and the cache is what built it

The most important fact about making VAT's parser swappable is that **the abstraction is already
there and already load-bearing**, and nobody designed it on purpose.

`packages/resources/src/schemas/parse-facts.ts` defines `ParseFactsSchema` — VAT's own vocabulary
for what a parse yields: links, headings, anchors, unresolved references, lexical references,
content measures, token estimate, frontmatter source. It exists because the disk-backed parse cache
had to serialize a parse across a process boundary and **could not carry an mdast tree**.

The consequence is decisive:

> **A warm run reconstructs a complete `ParseResult` without loading the *markdown* parser.**

That is `rehydrate` in `parse-cache.ts`, pinned by
`packages/cli/test/integration/module-load-budget.integration.test.ts`. Field-completeness is
confirmed: the rehydrated result carries every field the cold path produces.

⚠️ **"No parser at all" would be false, and the distinction is the whole point of §4.** A warm scan
measured under V8 coverage loads **zero remark scripts, 14 parse5 scripts and 74 `yaml` scripts**.
parse5 arrives because it is still in the `resources` barrel's static graph (§4); `yaml` arrives
because `parseFrontmatterSource` is, in its own words, *"the one piece of parsing a cache HIT still
performs"* (`frontmatter-source.ts`) — the cache stores frontmatter as YAML source, not as a parsed
object, so a hit decodes it. YAML for config and frontmatter is the one parser the rule in §4
exempts; parse5's presence is the violation.

The parser is therefore *already* behind an interface. What is missing is not the seam — it is that
there is exactly one implementation and no registry. That schema's own docstring already anticipated
this: *"an externally registered parser is the case on the horizon."*

### How much mdast is actually left

✅ **Nothing outside the implementation takes a tree any more.** Three consumers used to, and the
analysis that led here is what decided the capability split — only one of them ever wanted structure:

| Consumer | What it took | What it actually needed | Today |
|---|---|---|---|
| `collectCodeContextRanges(tree)` | `Root` | `node.type` + `position.{start,end}.offset` over 8 node types, as `{fences, codeSpans, excluded}` — **spans, not structure** | `codeContextRangesFrom(spans)`, a pure filter |
| `findUnresolvedReferences(content, tree)` | `Root` | spans, **plus the label text of each `definition`** — see below: it does its own normalizing | `findUnresolvedReferences(content, spans)` |
| `collectAstFacts(tree)` | `Root` | links and flat headings — **the only structural consumer**, and `buildHeadingTree` is already a separate function taking flat headings | split across the two capabilities in `remark-parser.ts` |

**The count is two, not two and a half.** `findUnresolvedReferences`' `@param` says it collects
*"already-normalized definition identifiers"*, which reads as a dependency on the parser's
CommonMark case-folding. It is not one. `unresolved-references.ts` owns the normalization outright —
`normalizeReferenceLabel` trims, collapses whitespace runs and case-folds on VAT's own side, and
`referenceLabelKeys` indexes **both** the escaped and the unescaped spelling of every label. That
second function exists precisely *because* mdast is inconsistent here: it keeps backslash escapes in
`Definition.identifier` and removes them only in `label`, so matching either form alone reports
`[a][foo\]bar]` as dangling when it resolves.

⇒ VAT does not consume a parser's normalization; it re-derives it defensively and over-matches on
purpose, because over-matching only ever suppresses a finding. **What a replacement implementation
must supply is the definition's raw label and position — a span with a kind and a label, nothing
more.** There is no third capability hiding here, and the spans-and-kinds contract needs one field
rather than a home for a dialect rule.

### What a replacement implementation actually has to supply — now measured

A flat token stream carrying **character offsets** satisfies the span consumers, and that is the
contract `SourceSpan` states: half-open UTF-16 code-unit offsets into the exact source string, such
that `content.slice(start, end)` is the construct. Whether a particular flat-token parser meets it is
answered per implementation, and the obvious candidate does not.

> 🔑 **`markdown-it@14` produces ONE span for a document containing seven span-bearing constructs.**
> Measured by `markdown-it-conformance.test.ts` over a probe holding frontmatter, a heading, a link
> definition, an inline link, a reference link, an inline code span, raw HTML and a fence: the only
> span it can place is the **fence**. Positions exist on block tokens only — inline children carry
> `map: null` — so every inline construct the mask and the lexer depend on is simply absent.

Three consequences follow, and they are properties of that one number rather than separate defects:

- The definition lands in `env.references` with **no token and no position**, so
  `findUnresolvedReferences` has no labels and reports the document's one resolvable reference as
  dangling.
- A reference link arrives as the same `link_open` token an inline link does, so `nodeType` cannot
  be `linkReference`.
- Under the default `html: false` there is no raw-HTML token, so an author's `<a id="…">` fragment
  target is invisible.

⚠️ **And the frontmatter gap is worse than a missing field.** With no frontmatter rule, `---` above
and below a line makes it a **setext heading**, so `id: probe` enters the heading outline as an `h2`
with slug `id-probe`. A parser that merely missed frontmatter would cost one field; this one invents
a section.

That is a conformance finding, not a disqualification — see §3 for why it enters as a test
implementation anyway. It is recorded here because "a flat token stream satisfies all three" was an
assumption, and the first implementation checked against it refuted it.

⚠️ It also means the measured **10.62×** speed ratio is not like-for-like in a second way beyond
frontmatter: the rival parses neither frontmatter nor raw HTML, and gives no position to anything
inline.

### Three producer-named leaks to close, one of them not prose

The fact shape is VAT's, and two of the three leaks are documentation only:

- `ParseResult.frontmatterSource` — described as *"exactly as the mdast `yaml` node carried it"*.
  The fact is "the frontmatter block's source span, delimiters excluded."
- `ParseResult.contentMeasures` — described as needing *"the AST's `code` node offsets"*. The fact
  is "code-unit counts split by code context."

The third is **in the persisted contract, not in prose**:

- `LinkNodeTypeSchema` (`schemas/resource-metadata.ts`) is a Zod enum of `link` / `linkReference` /
  `definition` / `htmlAttribute` — three mdast node names and one parse5 fact, stored per link row.

⚠️ **That makes the first spec step a schema change, not a docstring pass.** `nodeType` is a field a
second implementation must be able to populate, so renaming it to producer-neutral kinds moves
`parseFactsShapeSource()`, which cold-starts every parse cache on upgrade. Its current shape also
carries a real invariant worth preserving: an absent `nodeType` means "some producer did not say",
never "the link is markdown". Sequencing it as *cheapest first* was wrong.

A contract that names one implementation's node types is not a contract — but the price of fixing
this one is a cache cold-start, and that belongs in the plan rather than in a footnote.

## 2. The three capabilities

| Capability | What it answers | Already implemented as | Cost profile |
|---|---|---|---|
| **spans-and-kinds** | "where are the code fences, the raw HTML, the frontmatter, the links?" | `ParseSession.spansAndKinds()`, returning `links`, `anchors`, `frontmatterSource` and a flat `SourceSpan[]`. `codeContextRangesFrom` and the dangling-reference mask are pure filters over that array | cheapest to *serve*; still not cheap to *obtain* — see below |
| **structure** | "what is the heading tree, and where does each section start and end?" | `ParseSession.structure()`, returning **flat, unslugged** headings. `github-slugger`'s suffixing and the nesting are renderer conventions VAT owns, applied by the composer | needed by chunking and navigation, not by link integrity |
| **faithful edit** | "change this one value and leave every other byte alone" | `html-transform.ts`, which **never re-serializes** — it splices at parse5-reported offsets — and `frontmatter-editor.ts`, which states a byte-identity round-trip contract | needs source fidelity a normalizing serializer destroys |

The third row is the one VAT already discovered and never named — but it is named in **two** places,
not one. `html-transform.ts` avoids parse5's serializer deliberately, because it normalizes
whitespace, quotes and void elements. On the markdown side, `frontmatter-editor.ts` already ships the
same capability with an explicit byte-identity contract: *"`openFrontmatter(x).toString() === x` for
any well-formed input, byte-for-byte"*, preserving comments, blank lines, key ordering, quoting style
and detected EOL.

⚠️ **The gap is not frontmatter — it is the body.** `rewriteBodyLinks` (`rewriter-helpers.ts`) is
regex splicing over raw markdown, with no parser and no stated fidelity contract. That is the
markdown counterpart to `html-transform.ts` and the place where faithful-edit is asserted by
construction rather than by contract.

### ⛔ This split buys no speed, and the perf argument must not be revived

Tokenizing is **74–76%** of `remark-parse`; tree building is the remaining 24–26%. The spread is two
committed artifacts reporting the same probe: this document measured ~74%, `parser-bakeoff.ts` says
"roughly 76%". Every capability above needs tokenizing.

The ceiling that follows depends on a premise worth stating rather than assuming: **`remark-parse` is
64% of a cold `resources validate` wall on this Mac** (55% on the Windows box). So *"skip the tree
when you only wanted spans"* saves 24–26% × 64% = **15.4–16.6% of cold wall**, a **1.18×–1.20×
ceiling** — and less on Windows. That is the identical dead end that killed driving micromark
directly.

The measured 10.62× from `markdown-it` is a **different tokenizer**, not a skipped tree.

> The split does not make VAT fast. It makes VAT **swappable**, and swappable is what puts a faster
> tokenizer within reach. They compose in that order and only that order.

## 3. A second implementation, and what it is for

`markdown-it` is a **test-only implementation**: it lives in `dev-tools`, so it reaches no published
package's dependency graph, and nothing in the product can call it. It **does** run on every unit
suite — `markdown-it-conformance.test.ts` — which is the point. A rival kept behind a flag nobody
sets is a rival whose divergences drift unnoticed; running it every time is what makes the pinned
finding list go red when a gap closes or a new one opens.

The reason is not performance. It is that **a single-implementation interface is a claim nobody has
tested.** A second implementation is the only thing that converts "loosely coupled" from an
assertion into a measurement — and VAT's whole product thesis is portability across LLMs,
frameworks and targets, so a toolkit that cannot demonstrate parser pluggability in its own core is
selling something it has not proven on itself.

This is a starting position, not a commitment against shipping. If the conformance work shows
`markdown-it` is better for a particular capability, promoting it for that capability is a decision
the architecture should permit, not one it should have foreclosed.

⚠️ Do not assume that capability is spans-and-kinds. It is the intuitive guess — a flat token stream
looks like a natural fit — and it is the one the three-way failure in §1 lands hardest on: no
character offsets, no positioned link definitions. The capability where a rival is most likely to win
is an output of the conformance suite, not an input to it.

⚠️ **It is already in the tree, and that constrains how it enters.** `markdown-it` is a `dependency`
of `@vibe-agent-toolkit/dev-tools` — in `src/`, not `test/` — where `parser-bakeoff.ts` instantiates
it with a documented options set. A second, differently-configured instance would make the
conformance verdict and the speed verdict statements about two different parsers. The conformance
implementation must reuse that configuration, or change it in one place.

**The equivalence harness is the conformance suite.** "Do two implementations produce identical
`ParseFacts` over the corpus?" is the same code as "is this parser change faster or just
differently wrong", and building it once serves both permanently.

### 🪤 What the suite does NOT catch, learned by building it

`parse-conformance.ts` checks span fidelity by asserting the character at `startOffset` is one the
kind can begin with — the cheapest check that catches an implementation reporting **line ranges**
where character offsets were asked for.

> ⚠️ It reported **nothing** against `markdown-it`, which does exactly that. Every span it emits is
> a block construct, and a block begins a line, so a line-aligned offset lands on the right
> character and the check passes.

The unit mismatch surfaced one layer down instead: a line-aligned fence span runs to the start of the
following line, swallowing the trailing newline, so `contentMeasures.codeBlockCodeUnits` came out
**one higher** than remark's. A suite that only checked spans would have called that clean. This is
the general shape — the fact diff is the instrument that discriminates, and the span checks are a
faster path to a subset of what it finds, never a substitute for it.

## 4. Load boundaries: nothing heavy loads unless it is used

The rule, stated plainly:

> **No parser, store, or runtime may be reachable from a package barrel's static module graph.**
> The only things loaded eagerly are what every invocation genuinely needs — YAML for config, the
> schema layer, path and filesystem primitives.

### 🚨 Stated plainly: every published barrel currently violates this rule

The rule is the target, not the state. Measured cold import cost on this Mac, three runs each:

| Module | Cold ms |
|---|---|
| `rag` barrel | 202 / 253 / 407 |
| `resources` barrel | 185 / 207 / 213 |
| **`utils` barrel** | 93 / 153 / 169 |
| `@vibe-validate/git` | 54 / 39 / 45 |
| `yaml` | 33 / 30 / 31 |
| `handlebars` | 28 / 28 / 26 |
| `ajv` | 15 |
| **`parse5`** | **9 / 10 / 10** |
| `utils` `./project` subpath | 19 / 18 / 13 |

Two things follow, and neither is comfortable:

- **`utils` is the barrel that matters most**, because it is in every other barrel's graph. When
  those numbers were taken it pulled `handlebars`, `yaml`, `@vibe-validate/git`, `which`, `picomatch`
  and `ignore`; the last row shows what a pure subpath cost by comparison, ~10× less. **It now pulls
  none of them** — every domain carrying a dependency moved to a subpath (`./crawl`, `./git`,
  `./process`, `./skill-test`, `./yaml`), `handlebars` left the package altogether with
  `renderHandlebarsTemplate` moving to its one caller in `resources`, and
  `subpath-purity.test.ts` asserts the
  barrel's third-party set is `[]` by equality. ⚠️ The 93/153/169 ms row is therefore a
  **pre-trim** measurement and has not been re-taken; do not quote it as current.
- **parse5 is the seventh-largest eager item in the `resources` barrel — roughly 5% of its load.**
  `ajv` alone costs 50% more. §5 step 2 remains worth doing, but its justification is
  *enforceability*, not milliseconds, and any framing that calls it the big win is wrong.

The largest boundaries in the tree are the ones this document does not otherwise discuss:
`rag-lancedb` → LanceDB + apache-arrow; four runtime adapters → whole vendor SDKs; `gateway-mcp` →
the MCP SDK + `ajv`; and `projection-sqlite`, below.

### Why this is a rule and not a preference

It has already regressed once, silently and expensively. `packages/resources/src/index.ts` used a
plain value re-export for `parseMarkdown`, which put the entire remark stack in the barrel's module
graph. Every consumer of *every symbol* in the package paid the remark stack's module load — **~730
ms, and that figure is Windows-only** in both places it is recorded (`frontmatter-source.ts` says so
explicitly). It cancelled the parse cache's own deferral outright: a fully warm scan that parsed
nothing still loaded the parser. Nothing noticed until someone measured by hand.

⚠️ **Do not quote ~730 ms as a general number.** It is one platform, and the pair of figures the
load-budget test carries beside it ("~38 ms parse5 vs remark ~730 ms") no longer reproduces at all —
66 vs 95 on a recent measurement. The shape of the claim holds; the numbers must be re-taken before
anyone uses them, and the stale pair must be re-measured or deleted where it sits.

The defence in the source today is a wrapper function with a ⚠️ comment. **A comment cannot hold an
invariant.** Two instruments hold it instead, and they answer different questions:

| Instrument | Asks | Catches | Cost |
|---|---|---|---|
| `packages/utils/test/subpath-purity.test.ts` | *what is in this export subpath's transitive source graph?* | **any** new third-party dependency entering the graph, per package | milliseconds, no spawn |
| `module-load-budget.integration.test.ts` | *which scripts did this real CLI invocation load?* | a **known** heavy import being re-added, per invocation | ~1.3 s per spawn |

🔑 **Purity is the default instrument.** It walks each subpath's transitive source graph and asserts
the **exact** third-party set, with negative controls including one proving the walker throws rather
than silently returning a small set — so it goes red on a dependency nobody thought to name. A
V8-coverage needle is the right tool only when the property is about *which invocation* loads
something, not *which import* reaches it. 🪤 Writing a second graph walker in another package lands
on jscpd against a zero baseline.

⇒ **Every lazy boundary needs a test that goes red when someone makes it eager.** The regression is
invisible in review and free to introduce, so review is not a control.

🚩 The most-regressed invariant in this repo fires **no `.claude/rules` glob at the file where it
regresses**: nothing covers `packages/*/src/index.ts`. That is the cheapest missing artifact named
anywhere in this document.

### ⚠️ Lazy import defers evaluation, never installation

These are two different wins and only one of them comes from `await import()`:

- **Evaluation** — deferred by a dynamic import. This is the remark saving above, and it is real
  (subject to the platform caveat: the ~730 ms figure is Windows-only and needs re-taking).
- **Installation** — not deferred by anything in the source. `onnxruntime-web` is a plain
  `dependency` of `@vibe-agent-toolkit/rag` and is lazily imported at its use site, so an adopter
  who installs `rag` downloads the wasm whether or not they ever embed.

Getting the install-size win needs `optionalDependencies` plus a graceful failure, or a separate
package. The same package already demonstrates the shape: `openai` is declared under
`peerDependenciesMeta` as optional.

### The worked example to copy: `optional-backend.ts`

The seam is `packages/cli/src/utils/optional-backend.ts`; `projection-store.ts` is one instance of
it, and the RAG lane is the other and larger one. New boundaries should go through the seam rather
than re-implement it, and it already carries the numbers that justify itself: on the published
`vibe-agent-toolkit@0.1.42`, **275 MB of a 351 MB install is the RAG lane**, and
`import('@lancedb/lancedb')` is **1,350 ms cold** — it once ran before `vat --version` could print a
string. That is ~135× parse5.

What the shape guarantees:

- the backend is reached through `await import(...)`, so `@lancedb/lancedb` and `node:sqlite` are
  never in the CLI's static graph — the latter even though it ships with Node;
- the import happens **after** the cheap disqualifying checks, so a corpus outside a git repository
  costs nothing and says why. ⚠️ That ordering is currently an accident of layout in
  `projection-store.ts`; a one-line hoist would undo it and no test would notice;
- a missing backend is distinguished from an unsupported Node — only `ERR_MODULE_NOT_FOUND` means
  "not installed", because telling someone to install a package when they need to upgrade Node
  sends them round a loop that cannot terminate;
- it does not fall back, retry or degrade: an absent backend is a legible error naming the package
  to install.

⚠️ **The seam declares a negative invariant that nothing enforces.** `optional-backend.ts` carries a
comment saying it deliberately does not import `commands/rag/command-helpers.js`, because that module
statically pulls `rag-lancedb` and would load the very backend the file exists to defer. That is a
comment holding an invariant, which the section above says cannot work.

Built-in does not mean free. `node:sqlite` gets the same treatment as a third-party driver.

⚠️ **And "built-in" is not what makes `projection-sqlite` cheap — it is not cheap.** The package
value-imports the `resources` barrel (`projectionColumnTypes`, `projectionShapeDigest`,
`vatCacheNamespaceRoot`, `PROJECTION_TABLES`, `quoteIdentifier`), so loading the store drags the
entire resources graph — parse5 included. The boundary keeps `node:sqlite` out of the CLI's static
graph and admits ~200 ms of barrel behind it. Deferring a small thing behind a large one is not a
boundary; it is a delay.

### Current state, honestly

| Surface | Deferred today? | Pinned by a test? |
|---|---|---|
| markdown parser (remark stack) | ✅ yes — lazy wrapper in the barrel | ✅ `PARSER_NEEDLES` |
| CLI command modules, **rag's included** | ✅ yes — lazy per-verb dispatch | ✅ `COMMAND_NEEDLES`, asserted absent under another verb and present under root `--help` |
| projection store / `node:sqlite` | ✅ yes — `await import`, env-gated | ❌ no needle |
| **HTML parser (parse5)** | ❌ **no — loads eagerly with the barrel** | ❌ absence documented, not asserted |
| **rag *package* / `onnxruntime-web`** | ⚠️ package-level load unverified | ❌ no needle |
| `rag-lancedb`, runtime adapters, `gateway-mcp` | ✅ behind `optional-backend.ts` | ❌ no needle, and no declared boundary to pin |

⚠️ The rag row is two rows, and conflating them hides the gap. The **command module**
(`cli/dist/commands/rag/index.js`) is pinned in both directions today. What is unpinned is the **rag
package barrel and `onnxruntime-web` underneath it** — and per the subsection above, a lazy import
would not save an adopter the download in any case.

### The parse5 blocker, and its removal

`index.ts` statically re-exports `rewriteHtmlLinks` from `html-transform.ts`, which statically
imports `html-link-parser.ts`, which statically imports parse5. So parse5 is in the barrel's graph
for every consumer of every symbol.

The blocker is that **`rewriteHtmlLinks` is synchronous** and therefore cannot become a lazy
wrapper without changing its signature. It has exactly **one** production caller,
`packages/agent-skills/src/skill-packager.ts`. Making it async removes the blocker, and the
load-budget test already has the shape waiting — parse5's absence from `PARSER_NEEDLES` is
documented there as a deliberate statement of fact rather than an oversight (with the stale figure
pair noted above, which must go in the same edit).

Two things this costs that the boundary itself does not pay for:

- ⚠️ **There is no adopter migration route.** `resources` exports only `"."` and
  `"./markdown-processor"`, so after `rewriteHtmlLinks` goes async there is no subpath through which
  an adopter can reach a synchronous form. Pre-1.0 this is permitted and free; it is still a breaking
  export change and must be labelled one.
- ⚠️ **There is no HTML corpus to control on.** The repository holds three committed `.html` files,
  all under `test/fixtures/`, which `vibe-agent-toolkit.config.yaml` excludes globally — a scan sees
  `filesScanned: 0`. A parse5 *presence* assertion therefore has nothing to fire on until a corpus
  exists, and an absence assertion with no live present-case asserts nothing.

## 5. What this implies for the execution spec

In dependency order, each item independently landable:

1. **Close the producer-named leaks** in `ParseResult` so the contract names no implementation's node
   types. ⚠️ **Not cheap, and not prose-only**: two are docstrings, but `LinkNodeTypeSchema` is a
   persisted enum of mdast node names, so this moves `parseFactsShapeSource()` and cold-starts every
   parse cache on upgrade. Land it deliberately, not as a warm-up.
2. **Make `rewriteHtmlLinks` async** and defer parse5 behind the barrel's lazy wrapper. Add parse5
   to `PARSER_NEEDLES` — the test moves from documenting the gap to enforcing its closure.
   ⚠️ **This is worth ~10 ms and roughly 5% of the `resources` barrel.** Its justification is
   compartmentalization and enforceability; no performance claim belongs on it. It also needs an HTML
   corpus to control on, and one does not exist yet.
3. **Pin the remaining surfaces**: the projection store, and the rag package barrel. Prefer
   `subpath-purity`-style graph assertions where the question is *which import*; use a load-budget
   needle only where the question is *which invocation*. A boundary with no test is a boundary one
   careless import undoes.
4. ✅ **Name the three capabilities in code** — `parse-capabilities.ts`. `spans-and-kinds` yields
   `links`, `anchors`, `frontmatterSource` and a flat `SourceSpan[]`; `structure` yields flat,
   unslugged headings; `faithful-edit` yields **nothing** and is a claim about the offsets, checked
   rather than implemented. `remark-parser.ts` is the reference implementation and
   `parseMarkdownContent` is the composer, which now takes the implementation as a parameter.
5. ✅ **Build the equivalence harness** — `parse-conformance.ts`, a field-by-field `ParseFacts` diff
   with three kinds of finding (`missing-capability`, `span-fidelity`, `facts-differ`) that call for
   different responses. ⛔ There is no `CONFORMANCE_VERSION`: the report carries
   `parseFactsShapeSource()`, so it **declares the fact shape it was taken against** and moves with
   the schema.
6. ✅ **Add `markdown-it` as a test implementation** — `dev-tools/src/markdown-it-parser.ts`, built
   from the same `createMarkdownItProcessor()` the bake-off times so the fidelity verdict and the
   speed verdict are about one parser. Seven `ParseFacts` fields diverge; see §1 and §3.

Steps 1–3 are load-boundary work and need none of the parser work. Steps 4–6 are the parser
interface, and no *behaviour* changed before 5 existed: **without a whole-corpus facts diff you
cannot tell *faster* from *differently wrong*, and differently-wrong ships silently.** In practice 6
is what exercises 5 — a harness with one implementation cannot demonstrate that it discriminates —
so they landed together rather than in sequence.

⚠️ **Step 1 is still open, and step 4 did not close it.** `SourceSpan.kind` is named in VAT's own
vocabulary from the start (`code-block`, `inline-link`, `link-definition`, …) because spans are not
persisted and were free to be named right. `LinkNodeTypeSchema` still enumerates mdast node names in
the persisted link rows, and undoing that still costs a parse-cache cold start.

🔑 **What 4–6 actually bought, stated so nobody re-litigates it as a perf change:** the three walks
of the same tree (`collectAstFacts`, `collectCodeContextRanges`, `collectMaskFacts`) became one, and
the two range consumers became pure filters over spans. Output is unchanged — 2,739 `resources` unit
tests pass untouched — and no timing claim is made for it. The point is that a second implementation
can now be measured against a contract instead of against a diff.

### 🔶 Where this plan is aimed is an open decision

Steps 1–3 as written pin the surfaces this document happened to examine. The measurements in §4 say
the largest boundaries in the tree are elsewhere: the `utils` barrel, which every other barrel
inherits, and the RAG lane at 275 MB and 1,350 ms. Neither was in the step list.

**The `utils` half is now closed.** The barrel reaches no third-party package, asserted by equality
rather than by an approved list, so the property cannot decay quietly. The justification was
architecture on the 0.2 boundary, not milliseconds — the barrel is 93–169 ms once per process
against a ~10 s `resources validate`, and saying otherwise would have oversold it.

**The RAG half is still open, and its cost is still the larger one.** `@lancedb/lancedb` is already
behind two dynamic hops from `bin.ts` and is an `optionalDependency`, so nothing there needs
deferring — what it lacks is a *test*, and a boundary held by a comment is the failure mode this
document exists to name. The unfixed eager cost in that lane is `gpt-tokenizer`: a static value
import off `rag/src/index.ts`, 44 MB, whose millisecond cost has never been measured.

## Related

- [Resource Scanning and Object Caching](./resource-scanning-and-caching.md) — the two-lane cost
  model and the content-decoding seam these parsers sit behind.
- [Resource Projection](./resource-projection.md) — the parse-cache output shape whose
  serialization forced the fact contract described in §1.
- [CLI Architecture](./cli.md) — why the CLI layer stays dumb, and the per-verb lazy dispatch that
  §4 extends to packages.
