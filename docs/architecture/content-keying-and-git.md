# Content Keying and Git

**Status markers used throughout:** ✅ shipped — 🔷 proposed, not yet built.

## 1. Overview

VAT and git both answer the question *"are these the same content?"* with a hash, and they hash
**different preimages**. Git normalizes a file and then hashes the result; VAT's `computeContentKey`
hashes the raw working-tree bytes. Both are legitimate identities. They answer different questions,
they are sound for different facts, and — the part that is counter-intuitive and keeps being
re-derived wrongly — **the git one is the portable one.**

This document exists because that reasoning is easy to state backwards. It records which key is sound
for what, the measured behaviour of the git plumbing that would supply either, and the consequences
that follow for the git crawl lane, together with the one optimization that was proposed on top of
that lane and refuted (§10) and the three shapes nobody should rebuild (§12). It is a reference, not
a plan: everything measured here is either reproducible from §9 or carries its date and its corpus,
and everything asserted about VAT's own code carries a `file:line`.

It sits alongside two neighbours and does not repeat them.
[Resource Scanning and Object Caching](./resource-scanning-and-caching.md) covers *discovering* what
bytes exist and the two lanes' cost models; [Resource Projection](./resource-projection.md) covers
what is *built* from those bytes. This document covers only the identity question in the middle.

## 2. Two identities, two preimages

| | git blob OID | VAT `contentKey` |
|---|---|---|
| preimage | the **cleaned** content — after `text`/`eol` attributes, `core.autocrlf`, `core.eol`, `working-tree-encoding` and any `filter.*` clean filter | the **raw working-tree bytes**, exactly as `readFile` returned them |
| algorithm | SHA-1 (or SHA-256 in a `sha256` repository), over `blob <len>\0` + content | SHA-256 over a domain-separated preimage, prefixed with the parser kind |
| shape | 40 hex chars | `<parserKind>.<64 hex chars>` — `content-key.ts:185` |
| stable across machines? | **yes** | **no** |
| computed by | git, already, during enumeration | VAT, on read |

VAT's key states its own preimage in the code that produces it:

> `// Read as bytes and decode here, rather than letting readFile decode: the key must be over what`
> `// was on disk, the decode is lossy, and readFile(path, 'utf-8') offers no BOM or encoding`
> `// handling at all.`
>
> — `packages/resources/src/content-key.ts:360-362`

The reason it is raw bytes and not the decoded string is written out at `content-key.ts:84-108`: UTF-8
decoding is many-to-one on invalid input, so `[c2]`, `[e2 82]` and `[ff]` all decode to one U+FFFD and
would collapse to one key. That argument is about decoding, and it settles decoding. It says nothing
about git, and it must not be read as though it did.

### 2.1 What the OID is, and is not

**The OID is a content identity.** Git normalizes and *then* hashes, so an OID names a document
independent of how any particular checkout encodes its line endings. Two files that share an OID at
23 bytes and 27 bytes on disk are the **same document** in two line-ending encodings — a markdown
parser yields the same headings, the same links and the same anchors from both. If line-ending
attributes changed what a document *says*, a Windows checkout would parse differently from a macOS
one, which would be absurd.

**The OID is not a byte-identity.** One OID can name two different working-tree byte strings in one
repository at one instant, because two paths can share cleaned content while sitting under different
`eol` or `filter.*` attributes.

⛔ **"The OID is unsound" is a falsehood and must not be written.** The precise statement, and the
only one this document endorses: *the OID is the most sound key for content, and it is unsound as a
byte-identical-on-disk key.* The distinction is the whole subject.

`packages/resources/src/content-key.ts:74-82` already encodes the operative rule that follows: a git
SHA may be used as a **lookup hint whose miss is free**; it must never *become* the key.

## 3. The portability inversion

This is the counter-intuitive half, and the reason the trade-off keeps being stated backwards.

The intuition runs "git's identity is a repository-local artifact, so ours must be the portable one."
It is exactly inverted:

- A blob OID is a function of cleaned content, so **the same document produces the same OID on every
  platform.** Two developers, one on Windows with `core.autocrlf=true` and one on macOS, holding the
  same committed document, compute the same OID.
- A raw-bytes SHA-256 is a function of the checkout, so **the same document produces different keys on
  different platforms.** That Windows checkout holds CRLF bytes; the macOS checkout holds LF bytes;
  the two key differently and share nothing.

⇒ **A raw-bytes key cannot support a cross-machine shared cache. An OID can.** The blob tier's
"content-keyed, therefore cross-tree-shareable" premise is real *within* a platform and silently
narrower *across* one — named as a cost at `content-cache.ts:218-224`.

So "content keys are platform-variant" is an argument **for** the OID, not against it. Anyone who
finds themselves writing it as an argument against has the inversion.

## 4. What each key is sound for

The split is not between the two keys' quality. It is between **content-level facts** and
**byte-level facts**, and `ParseResult` currently carries both.

| fact | sound key | why |
|---|---|---|
| links, headings, anchors, slugs, document structure | **git OID** — more sound, and the only cross-machine option | normalization does not change what the document says |
| `sizeBytes`, and reproducing the file on disk | **raw-bytes SHA-256** | a byte count is a fact about the checkout, not about the document |
| character offsets into content (`startOffset` / `endOffset`) | **whatever content they were computed over** | see §4.1 — they are consistent with one specific character sequence and no other |

### 4.1 Offsets are character offsets, and the rule they impose

VAT records spans for every link it parses:

```ts
...(node.position?.start.offset !== undefined && node.position.end.offset !== undefined && {
  startOffset: node.position.start.offset,
  endOffset: node.position.end.offset,
}),
```

— `packages/resources/src/link-parser.ts:522-524`. The docstring immediately above (`:512-521`)
explains what they are for: the span covers the whole construct because *"the span is the one a
rewriter wants anyway"*, and the offsets are spread conditionally rather than defaulted because
*"reading `line` while silently defaulting an offset to 0 would put a rewrite at the top of the
document."* These feed link **rewriting**, not merely reporting. A wrong offset corrupts a file.

⚠️ **They are character offsets, not byte offsets.** mdast reports positions as indices into the
string it was handed, and VAT's own section offsets are derived the same way —
`lineStartOffsets` in `packages/resources/src/projection/blob-sections.ts:190-199` walks
`content.split('\n')` and accumulates `line.length + 1`, which is a JS string length. Nothing here
indexes bytes. `sizeBytes` is the one genuinely byte-shaped field, and it comes from a raw byte count
(`resource-registry.ts:408`, `parse-cache.ts:294`), never from a string length.

The distinction does not rescue the offsets from normalization, because normalization removes `\r`
characters and therefore moves character offsets too. What it does mean is that an offset is sound
**relative to the content it was computed over** and meaningless relative to any other. Hence the
rule:

> 🔑 **The bytes you parsed must be the bytes you rewrite.**

The resolution this permits, and the reason the split is workable rather than fatal: parse and cache
from whichever content the lane holds, and let **rewriting** — a rare, explicit operation over a
handful of files — read the working tree at the moment it rewrites. Never 1,500 files, and never a
rewrite driven by offsets that came from a different byte string.

### 4.2 Why line endings are the one divergence that costs measurement, not meaning

`packages/resources/src/projection/content-cache.ts:188-209` holds the measurement, and it is worth
knowing before reaching for CRLF as an example of a *wrong answer*. Measured through
`parseMarkdownContent` on one document in both line endings: headings identical in level, text, slug
and line; links identical in `href`, `text`, `type` and `line`. What moves is the `\r` in `content`,
the character `startOffset`/`endOffset`, `estimatedTokenCount`, and a blob section's `bytes` and
`tokens`.

⇒ A CRLF/LF pair costs **fidelity of measurement**, never a wrong answer about what the document
says. The mechanisms that genuinely change the text served are divergent `filter.*` and
`working-tree-encoding` configuration, and those — not line endings — are what a hint's soundness
condition must cover (`content-cache.ts:247-251`).

## 5. 🪤 `git cat-file --filters` and `--batch` — the trap

Any design that wants **checkout-exact** bytes out of git rather than normalized ones reaches for
`git cat-file --filters`. Under `--batch` it does not behave the way git's own documented output
contract says it does, and the failure is silent enough to ship.

### 5.1 The measured table

git 2.50.1 (Apple Git-155), throwaway repository under `GIT_CONFIG_NOSYSTEM=1` and
`GIT_CONFIG_GLOBAL=/dev/null`, `.gitattributes` = `*.md eol=crlf`, one document authored with LF and
re-materialized through a checkout. Reproduce with §9.

| invocation | exit | announced size | payload delivered |
|---|---|---|---|
| working tree (`wc -c`) | — | — | **20 B, CRLF** |
| `cat-file blob <oid>` | 0 | — | 18 B, LF — normalized, as stored |
| `cat-file --filters --path=doc.md <oid>` — single object | 0 | — | **20 B, CRLF — checkout-exact** ✅ |
| `cat-file --batch --filters`, stdin `<oid> doc.md` | 0 | **18** 🚨 | **20 B, CRLF** — filters applied, header wrong |
| `cat-file --batch-check --filters`, stdin `<oid> doc.md` | 0 | **18** 🚨 | — (announces the stored size, not the filtered one) |
| `cat-file --batch --filters --path=doc.md`, stdin `<oid>` | **128** | 18, then abort | `fatal: missing path for '<oid>'` |
| `cat-file --batch --filters`, stdin `HEAD:doc.md` | **128** | — | `fatal: missing path for '<oid>'` |
| `cat-file --batch-command --filters --buffer`, `contents <oid> doc.md` | 0 | — | `<oid> doc.md missing` |
| `cat-file --batch-command --filters --buffer`, `contents HEAD:doc.md` | **128** | 18, then abort | `fatal: missing path for '<oid>'` |

Three facts, in order of how much damage they can do:

1. **`--filters` *is* honoured under `--batch`** — but only when the path is supplied per input line
   as `<oid> SP <path>`, which is what `git cat-file --help` prescribes ("*When used with `--textconv`
   or `--filters`, the input lines must specify the path, separated by whitespace*").
2. 🚨 **The batch header still announces `%(objectsize)` — the size of the *stored* blob, not of the
   filtered payload.** Git's own BATCH OUTPUT contract says the record is
   `<oid> SP <type> SP <size> LF` followed by "*the object contents (consisting of `%(objectsize)`
   bytes), followed by a newline*". Under `--filters` that contract is violated: 18 announced, 20
   delivered. `--batch-check --filters` reports the same 18, so the filtered size cannot even be
   pre-queried.
3. **`--path=` does not supply the path in batch mode.** It is documented for the non-batch form only,
   and supplying it while omitting the per-line path aborts the whole pipe with exit 128. In git
   2.50.1 `--batch-command` has **no** working `--filters` route at all: `contents <oid> <path>`
   reports the object missing, and `contents <tree-ish>:<path>` aborts.

### 5.2 The consequence: filtered records cannot be framed

Fact 2 is not cosmetic. A batch reader that follows git's documented framing — read the header, read
`size` bytes, expect LF — desynchronizes on the **first** filtered object and never recovers.
Measured over two documents (blobs of 18 B and 17 B, both 20 B in the working tree):

```text
record 0: header 'e5c5c558… blob 18' announces 18B;
          byte at announced end = b'\r'  ->  NOT LF -> reader is desynchronized
record 1: header not parseable as '<oid> <type> <size>': ''
```

`-Z` (NUL-delimited input and output) makes each record NUL-terminated, so a reader *can* frame by
scanning for the delimiter — but the announced size is still the stored blob size, and NUL-scanning is
only sound over content guaranteed to contain no NUL byte, which VAT cannot assert about an arbitrary
adopter corpus.

⇒ **Checkout-exact bytes over one long-lived pipe are reachable only by abandoning git's length-prefixed
framing.** Not impossible; not free; and not something to discover downstream of a wrong parse.

### 5.3 ⭐ Why this repository is the worst possible place to test it

VAT's root `.gitattributes` pins `* text=auto eol=lf` with an explicit `eol=lf` per file type, and its
stated purpose is *"Prevents Windows developers from accidentally committing CRLF line endings."* It
sets no `core.autocrlf`, no `core.eol` and no `filter.*`.

⇒ **In this repository, on every platform, working-tree bytes equal blob bytes by construction.** A
`--filters` implementation with the framing bug passes every local test, every CI run, and every
assertion anyone thinks to write here, and is wrong only on someone else's Windows checkout.

This is not a hypothetical blindness. The same construction is what made the existing cross-path hint
route un-testable in this repo: all 313 hint hits measured over this repository's 8,548-file corpus
were sound, and `content-cache.ts:226-234` names the resulting equality assertion **vacuous** — *"it
holds for a reason that has nothing to do with the hint being safe, which is exactly how this survived
being looked at."*

Anything in this class needs a fixture that plants hostile `.gitattributes` in a throwaway repository.
`packages/resources/test/system/git-hostile-config.system.test.ts` is that fixture, and it gates each
arm on a host capability rather than failing when one is absent.

## 6. What follows for the git crawl lane

### 6.1 A per-file spawn is not a candidate

The single-object `cat-file --filters --path=X <oid>` form is the only invocation that returns
checkout-exact bytes without framing hazards, and it costs **one process spawn per file**. Over a
corpus of thousands of files that is not a cost model anyone would choose; only the long-lived
`--batch` pipe was ever a candidate, and §5 is what that pipe actually offers.

### 6.2 The stronger move: read nothing

The design ruling the git lane operates under is not "read the bytes from a cheaper place" — it is
**do not read the bytes**. A byte never read cannot be the wrong byte, which makes the entire
end-of-line and filter correctness problem above *moot* on that lane rather than merely mitigated.

Two things make it achievable rather than aspirational:

- **Every required column of a realization row is answerable from git with no syscall.**
  `exists` is true by construction (`git add -A` stages deletions, so a snapshot entry exists),
  `isDirectory` is false by construction, symlink-ness comes from mode `120000`, and `gitignored` is
  false by construction under `--exclude-standard`. `mtime`, `contentKey` and `symlinkResolves` are
  all nullable, and `ContentStateSchema`
  (`packages/resources/src/schemas/projection-resources.ts:119`) already has the vocabulary for
  "there are bytes here and nobody asked for them": `deferred` — *"This is not a failure, and it is
  the only member that a later pass can legitimately turn into `keyed`."*
- **A warm store hit is already a proof that nothing changed.** A hit means the tree hash matched, and
  the tree hash is a function of every file's content. So every stored `contentKey` behind a hit is
  provably current, *whichever key produced it*. Re-deriving it re-proves what the cache key already
  proved.

That second point is what makes the warm lane's cost redundant rather than parallelizable. Measured
warm, on a clean machine, over an 8,548-file adopter monorepo: admission cost
**513.8 ms of a 1,021.5 ms crawl — 50.3%, across 1,461 calls that were all cache hits**.

> ⚠️ That reading was taken when the crawl seam charged admission **once per file**, under a row id
> (`resource-registry:add-resource`) that no longer exists. The row is now
> `resource-registry:admit` and is charged once per `addResources` CALL, because the lane fans out
> and summing overlapping per-file brackets would over-count the wall clock. So "1,461 calls" is a
> file count from the old grain, not something a current dump reproduces — the 50.3% share stands,
> the divisor does not.

Threading
redundant work makes it finish sooner; deleting it makes it free. The principled ordering, and it
generalizes well past this lane: **decide whether the work must happen at all, and only then
parallelize what survives.**

⇒ If the git lane reads nothing, the OID is not merely an acceptable key — it is the **exact** key for
the only bytes involved, it needs no hashing at all, and it is portable across machines for free.
`GitCrawlSource` already carries it: `crawl-source.ts:325` sets `contentHint: entry.oid`, while
`FilesystemCrawlSource` sets `contentHint: null` (`:201`) because it has nothing to offer.
`crawl-source.ts:18` states the asymmetry as a design property of the seam — *"blob OID, already
computed"* against *"none — bytes get read and hashed."*

### 6.3 Where a hint may and may not be offered

An OID is offered as a hint, never as an identity, and the conditions are enumerated at
`content-cache.ts:311-323`. The three that matter most:

- The stored key is still **hashed from the bytes** on a miss. A hint only chooses which
  already-computed answer to reuse.
- **No hint for a symlink** (whose OID names the link *target string*, not the bytes a follower reads)
  and none for a submodule (whose OID is a commit). `EnumeratedPath.contentHint`
  (`crawl-source.ts:114`) is null for both, at the only place that can see the mode.
- **A hint hit returns the content too**, so a row keyed from the memo never goes back to disk and
  cannot bind an old key to new bytes.

Anyone widening where a hint is offered or consumed owns the condition at `content-cache.ts:247-251`:
paths sharing an OID must also share their `filter.*` and `working-tree-encoding` configuration.
Normalizing what the OID names is not that condition and cannot be made into it.

Anyone widening it in the other direction — into a mechanism that *eliminates reads* rather than one
that reuses an answer already computed — owns §10 instead. That was proposed, measured and refuted,
and the entire prize it reached for is 45 reads.

## 7. Git LFS: a documented limitation, not a feature to build

Git LFS is the one divergence that is a genuine *indirection* rather than an encoding difference. Under
LFS the committed blob is a ~130-byte **pointer** — three lines of `version` / `oid` / `size` — and the
working tree holds the real content only when a smudge filter ran.

**VAT's defined behaviour: LFS-managed files are never parsed.** Recording that a large binary exists,
and that something points at it, is the whole obligation. Anything that "parsed" such a file would be
parsing the pointer.

Two properties make this a limitation VAT can state rather than a silent hazard:

- **It is declared, not inferred.** LFS is configured in `.gitattributes`, so an LFS-managed path is
  detectable rather than surprising.
- **It is pinned by a test, in both directions.**
  `packages/resources/test/system/git-hostile-config.system.test.ts:1163-1223` covers it:
  - *No LFS installed* — the shape every VAT run over an LFS repository without `git lfs` sees. The
    pointer **is** the file, and the test asserts the degenerate case explicitly rather than assuming
    it is inert: 130 bytes, zero headings, and one outbound reference —
    `https://git-lfs.github.com/spec/v1`, the pointer's own `version` line, *"a link the document does
    not have."*
  - *Genuinely LFS-tracked* — gated on `git lfs` being installed, skipped rather than failed when it
    is not. Asserts the split directly: the committed blob contains the pointer while the working tree
    holds the document.

🔷 **The gap worth naming**: the second arm proves the split exists but does not yet pin VAT's
behaviour over an LFS-managed `.md`/`.html` — the case where a naive path parses a 130-byte pointer as
if it were the prose it stands in for. That is the test the ruling above needs in order to be enforced
rather than merely documented.

## 8. Accepted consequence: the two lanes cache different things

A git-sourced projection and a filesystem-sourced projection **populate different cache entries for the
same file**, because they key different preimages. This is a known, accepted property of the design,
not a defect awaiting a fix.

The costs, stated plainly so nobody re-discovers them as surprises:

- No reuse across a `projection=git` run and a `projection=file` run over the same tree. Each pays its
  own first population.
- The blob tier's cross-tree sharing is exact on the git lane (an OID is an OID everywhere) and
  platform-scoped on the filesystem lane.
- Neither lane produces a *wrong* answer about what a document says. §4.2 is the measurement behind
  that clause.

⛔ **Do not "fix" this by normalizing what VAT hashes.** Normalizing the raw-bytes key would destroy
the one thing it is for — being a fact about the checkout, which is what `sizeBytes` and on-disk
reproduction need — and would not deliver the OID's portability either, since a VAT-specific
normalization is not git's. The two keys stay two keys.

## 9. Reproducing every measurement in this document

Everything in §5 is reproducible in under a second. The recipe is deliberately hostile to the
environment so the answer is about git rather than about the machine:

```sh
#!/bin/sh
set -e
export GIT_CONFIG_NOSYSTEM=1        # ignore /etc/gitconfig
export GIT_CONFIG_GLOBAL=/dev/null  # ignore ~/.gitconfig
R="${1:?usage: probe <throwaway-dir>}"
rm -rf "$R"; mkdir -p "$R"; cd "$R"
git init -q .
git config user.email probe@example.com
git config user.name Probe

printf '*.md eol=crlf\n' > .gitattributes   # a checkout MUST produce CRLF
printf 'line one\nline two\n' > doc.md      # authored with LF
git add -A && git commit -q -m probe
rm doc.md && git checkout -q -- doc.md      # force the smudge/eol path to run

OID=$(git rev-parse HEAD:doc.md)
echo "worktree           : $(wc -c < doc.md) B"                       # 20, CRLF
echo "cat-file blob      : $(git cat-file blob "$OID" | wc -c) B"      # 18, LF
echo "single --filters   : $(git cat-file --filters --path=doc.md "$OID" | wc -c) B"  # 20, CRLF
printf '%s doc.md\n' "$OID" | git cat-file --batch --filters | od -c   # header says 18; payload is 20, CRLF
printf '%s\n' "$OID" | git cat-file --batch --filters --path=doc.md    # fatal: missing path
```

Three properties of the recipe are load-bearing and should survive any edit to it:

- **`GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`.** Without them the result is a fact
  about the operator's `~/.gitconfig`.
- **`eol=crlf` on a repository whose author writes LF.** This is what manufactures a divergence on a
  machine that has none. On macOS with no attribute, nothing converts and every invocation agrees —
  which is precisely the blindness §5.3 describes.
- **`rm` then `git checkout --` after the commit.** Git does not rewrite an existing working-tree file
  just because an attribute changed. Without the re-materialization the working tree still holds the
  authored LF bytes and the probe silently measures nothing.

⚠️ **Read the payload, not the header.** `od -c | head -3` shows only the 48-byte record header of a
`--batch` response and cuts off before the content begins — which reads as "normalized, 18 bytes, LF"
and is the opposite of what the pipe actually delivered. Every reading in the §5 table is taken from
the full capture.

To verify the framing consequence in §5.2, plant a second document with a different blob length in the
same repository, feed both `<oid> <path>` lines to one `--batch --filters` process, then parse the
output by git's documented contract: read the header, skip `size` bytes, and assert the next byte is
LF. It is `\r`, and record 1's header no longer parses.

## 10. What was proposed and refuted: the OID as a read-elimination key

§6.2's ruling for the git lane is *do not read the bytes at all*. A more ambitious proposal sat next
to it and was measured in 2026-08: keep the keyed lane reading, but give it a persisted
`(blobSha, parserKind) → contentKey` memo plus an eligibility gate, so that a path whose OID is
already known skips its read entirely. Every number came back against it.

They are recorded here because a conclusion without its numbers cannot be defended the next time
someone re-derives the idea — and this one is easy to re-derive, because it sounds obviously right.

### 10.1 The three decisive numbers

**1. ~2% of reads are eliminable, and VAT already eliminates them.** One blob is read per *distinct*
key, so a keyed path's read is skippable only when some other path shares its identity. On this
repository, 2026-08: **2,096 tracked paths → 2,051 distinct OIDs = 45 eliminable reads (2.1%)**.
That is exactly the set the `contentHint`/`hintHits` route of §6.3 already collapses, so the memo's
whole read-side prize had been banked before it was proposed.

**2. The proposed eligibility gate excludes 100% of both real trees.** Measured 2026-08 with
`git check-attr --stdin -z text eol filter`: a large adopter monorepo, **8,405 paths → 0 eligible**;
this repository, **2,096 paths → 0 eligible**. The cause is not exotic configuration — it is the
most common `.gitattributes` line in existence. `* text=auto eol=lf` sets `text` and `eol` on
*every* path. ⇒ **Any gate phrased "text/eol attribute active ⇒ ineligible" is empty by
construction.** It ships green, does nothing, and nothing about it looks wrong on the way past.

This is §5.3's blindness with its sign flipped, and one `.gitattributes` line causes both: there,
uniform normalization makes a *broken* implementation pass every test anyone thinks to write here;
here, the same uniformity makes a *correct* implementation do nothing at all. Note that the adopter
tree fails the gate too, so a second corpus would not have caught it either — that is the difference
between this and the §5.3 case, and it is why the gate had to be measured rather than reviewed.

**3. Reads were never the cost.** Reading *every* file in this repository costs **94 ms warm**
(2026-08; 2,096 files / 26.5 MB, ≈45 µs per file), against the **4,580.7 ms**
`resource-registry:enumerate` arm measured on a large adopter monorepo. ⚠️ **Those are two different
trees.** It is a cross-corpus ratio, not a same-tree one, and it is stated that way deliberately
rather than tidied into a single figure. Even crediting perfect read elimination with the whole
94 ms against that arm, it removes ≲2% of it — and the honest elimination is not 94 ms at all, it is
the 45 reads of point 1. [Resource Scanning and Object Caching](./resource-scanning-and-caching.md)
pairs the two figures at its adopter table and rules that the 4,580.7 ms is never to be quoted
without them; *why* that pair is decisive is this section.

### 10.2 The sound gate, which is worth more than the refutation

The refutation kills one optimization. The gate it produced outlives it, and anything in this class
should start from the gate rather than from attribute names:

- A `filter` attribute (a clean/smudge pair) active ⇒ **ineligible**, unconditionally. A filter is an
  arbitrary transformation, and nothing may be inferred about the bytes it produced.
- With no filter, the only transformation git can apply is EOL normalization, and normalization
  strictly **removes CR bytes** — it never adds one. Therefore:

> 🔑 **Absent a `filter`, blob size == working-tree size ⟺ the bytes are identical.**

Two properties make that better than the gate it replaces. It is **complete** for the EOL case rather
than a heuristic — under that condition a size match is a proof, not evidence. And it catches
`core.autocrlf`, which `git check-attr` is **blind to**: Git for Windows defaults it to `true` while
`check-attr` reports the path as `unspecified`, so an attribute-only gate reads a CRLF checkout as
untouched. Working-tree size is a `stat` and blob size is already carried by the enumeration, which
is what lets the gate sit in front of the read it is deciding about rather than after it.

### 10.3 The cost nobody would guess: the temp-index snapshot

Decoupling the read from the working tree needs a snapshot, and a snapshot costs a **~140 ms
temp-index write that puts loose objects into `.git/objects` on every run** (2026-08, this
repository). Two consequences, either disqualifying on its own:

- It **mutates the repository it is reading.** A read-only command that grows the adopter's object
  store on every invocation is not a read-only command.
- **Break-even is ≈3,100 files, and it loses on every cold-index run** — a fresh worktree, a CI
  checkout — *regardless* of corpus size. Those are exactly the two shapes CI presents, so the run
  that would justify the cost is the one run that can never show it.

## 11. What the keyed entries cost on disk, and why they are not compressed

These measure the content-keyed cache rather than git. They belong here because each is a fact about
what keying *produces*, and each one closed a question that otherwise gets re-opened by intuition.

**Compression was rejected, and the rejection is re-derivable rather than permanent.** Measured
2026-08 over this repository's cache: the median entry is **924 bytes**, **54% are under 1 KB** and
**87% under 4 KB**, none pretty-printed, and only ~**1%** exceed 16 KB. gzip saves 60% on a sample —
and at that median frees **no actual disk at all**, because a sub-block entry still occupies one
allocation block, while adding an inflate to every read. ⇒ It buys nothing measurable and charges
every reader. The two facts that decide it are the median and the filesystem's block size, so anyone
re-opening this re-measures the median first: if the ~1% tail over 16 KB grows into the bulk of the
bytes, the arithmetic changes and the rejection does not survive it.

**The corpus bytes are read and hashed three times per run.** `collectRealization` reads and hashes
once per `(extent, path)` — so once for each extent a path belongs to — and blob population then
reads again on top. That multiplier, not a single read, is what §6.2's *read nothing* ruling attacks
at the source, and it is what any read-elimination proposal would actually have to beat.

**Scale is not this repository, and it is not off by the file count.** Measured 2026-08: a large
adopter monorepo at **20,671 paths / 1,188.8 MB** against this repository's **5,684 paths /
40.8 MB** — **29× the bytes for a 4.2× corpus**, so the mean file is about seven times larger there.
⇒ Anything whose cost scales with bytes rather than with files is sized wrong here by roughly that
factor, and a per-file average taken from this tree does not transfer.

⚠️ **Three path counts for this repository appear in this document — 2,096 (§10), 5,684 (above) and
8,548 (§5.3) — and they are not interchangeable.** Each probe enumerated the population its own
question needed, at its own date. A number is only comparable to another taken over the same
population; carrying one across to the other's ratio silently changes what is being claimed.

## 12. 🛑 Do not rebuild

Three shapes were proposed, measured and refuted in the work above. They are transcribed verbatim so
that the next person to think of one finds it named before spiking it:

1. The persisted `(blobSha, parserKind) → contentKey` memo.
2. "git OID as content identity to eliminate reads."
3. Any gate phrased "text/eol attribute active ⇒ ineligible".

None of the three is refuted by taste, and none is re-opened by an argument. (1) and (2) are bounded
above by the 45 eliminable reads of §10.1, and (3) is empty by construction on every tree carrying
`* text=auto eol=lf`. Reopening any of them means producing a measurement that moves those numbers,
on a tree that is named. What survives and should be reused is §10.2's size-equality gate, which is
sound whether or not anything is ever built on top of it.

## Related

- [Resource Scanning and Object Caching](./resource-scanning-and-caching.md) — the two lanes'
  cost models, the crawl-source seam, and the object-level content cache. §3.1 treats
  `git cat-file --batch` as the cheap, race-free way to read captured content; it is, and this
  document supplies the half it does not state — those bytes are the *normalized* content, and
  `--filters` is not a free upgrade to checkout-exact.
- [Resource Projection](./resource-projection.md) — the output side: what gets built from these bytes
  and the schema it is stored under.
- `packages/resources/src/content-key.ts` — the module docstring is the authority on why the preimage
  is raw bytes, why a git SHA may be a hint and never a key, and why decoding lives elsewhere.
- `packages/resources/src/projection/content-cache.ts` — the `#byHint` docstring holds the
  measurements behind §4.2 and §6.3, separates the mechanisms that can change text from the ones that
  cannot, and names which lane is exposed.
