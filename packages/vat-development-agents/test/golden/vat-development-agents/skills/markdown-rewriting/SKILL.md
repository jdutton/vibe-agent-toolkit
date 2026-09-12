---
name: markdown-rewriting
description: Use when programmatically editing markdown or frontmatter — moving
  files, updating references, batch-renaming, schema-evolution migrations.
  Steers to comment-preserving FrontmatterEditor + rewriteBodyLinks; away from
  gray-matter/js-yaml/regex.
---

# Editing markdown safely

When you write code that opens a markdown file, mutates the frontmatter or
body, and writes it back, you have ONE job that's easy to get wrong: keep
the file's content stable except for the intentional change. Lose comments,
blank lines, anchors, or quoting style, and every iteration degrades the
docs.

VAT ships canonical primitives for this. Use them.

## The rule

For **any** programmatic markdown edit, use `@vibe-agent-toolkit/resources`:

- `openFrontmatter(markdown)` — round-trip-safe editor. Comments,
  blank lines, EOL, YAML style all survive read → mutate → write. Exposes
  `.body` (settable), `.get(path)`, `.set(path, value)`, `.setArrayItem`,
  `.appendArrayItem`, `.delete(path)`, `.isDirty()`, and `.toString()`.
  The underlying `yaml.Document` is intentionally not exposed.
- `rewriteBodyLinks(body, rewriteHref)` — walk inline + reference-style
  body links with a per-href callback.
- `rewriteFrontmatterFieldsAtPaths(editor, paths, rewriteHref)` — rewrite
  specific frontmatter fields you know by name. Path syntax: `'name'`
  (top-level), `'name[]'` (array of strings — rewrite each item),
  `'meta.parent'` (nested), `'meta.refs[]'` (nested array).
- `rewriteFrontmatterUriReferencesFromSchema(editor, schema, rewriteHref)` —
  walk every schema-annotated URI-reference field automatically.

**The `rewriteHref` callback contract.** Return the new href, or return the
input string unchanged to skip that link. Anchor-only hrefs (`#section`),
external URLs, and refs that don't match your rule should all return as-is.
The callback receives only the href string — there is no field-path
context. When rules differ per field (e.g. `parent_spec` strict; `related[]`
permissive), use `rewriteFrontmatterFieldsAtPaths` with one call per path
group rather than the schema-driven helper.

**The primitives are pure (no I/O).** Read and write with whatever FS API
fits — `fs/promises`, `fs-extra`, streams, anything. The recipes below
use `readFileSync` / `writeFileSync` for clarity; production code is
free to use async equivalents.

## Anti-patterns — do NOT use these

- ❌ `gray-matter` — drops comments. Already banned by ESLint.
- ❌ `front-matter` — drops comments. Already banned by ESLint.
- ❌ `js-yaml` — drops comments AND has YAML 1.1 quirks (ISO date
  promotion). Already banned by ESLint.
- ❌ Raw `yaml.parse(text) → mutate → yaml.stringify(obj)` — drops comments
  even with eemeli `yaml`. Use `openFrontmatter` for the round-trip case.
- ❌ Regex on `---` fences to extract or replace frontmatter — fragile,
  loses style.
- ❌ Naive `body.replaceAll('/docs/old/', '/docs/new/')` — matches inside
  code blocks, inline code spans, attribute values, etc. Use
  `rewriteBodyLinks` so only actual markdown links are rewritten.

## Canonical recipe: move a file and update references

```typescript
import {
  openFrontmatter,
  rewriteBodyLinks,
  rewriteFrontmatterFieldsAtPaths,
} from '@vibe-agent-toolkit/resources';
import { readFileSync, writeFileSync } from 'node:fs';

const rewriteHref = (href: string): string =>
  href.replace('/docs/old/', '/docs/new/');

const filePath = 'docs/specs/foo.md';
const editor = openFrontmatter(readFileSync(filePath, 'utf8'));
editor.body = rewriteBodyLinks(editor.body, rewriteHref);
rewriteFrontmatterFieldsAtPaths(
  editor,
  ['parent_spec', 'adrs-cited[]', 'related-specs[]'],
  rewriteHref,
);
writeFileSync(filePath, editor.toString());
```

## When you have a JSON Schema for the frontmatter

If the file's frontmatter is governed by a schema (collection-validated, or
just a hand-written schema you trust), use the schema-driven helper
instead of listing field paths by hand. **Compose it with `rewriteBodyLinks`
to cover the body too** — most rewrites (file moves, folder renames) want
both sides updated:

```typescript
import { readFileSync, writeFileSync } from 'node:fs';
import {
  openFrontmatter,
  rewriteBodyLinks,
  rewriteFrontmatterUriReferencesFromSchema,
} from '@vibe-agent-toolkit/resources';

const rewriteHref = (href: string): string =>
  href.replace('/docs/specs/', '/docs/architecture/');

const schema = JSON.parse(readFileSync('schemas/spec.schema.json', 'utf8'));
const filePath = 'docs/specs/foo.md';
const editor = openFrontmatter(readFileSync(filePath, 'utf8'));

editor.body = rewriteBodyLinks(editor.body, rewriteHref);
rewriteFrontmatterUriReferencesFromSchema(editor, schema, rewriteHref);

writeFileSync(filePath, editor.toString());
```

The schema-driven call walks every field whose schema position has
`format: uri-reference` (or `uri`, `iri-reference`, `iri`) and rewrites
the value via your callback. Fields outside the URI-family are not
touched. **Templated-URI formats are intentionally excluded** —
`uri-template` (RFC 6570 templates with `{var}` placeholders) and
JSON-Pointer-derived formats aren't file references and don't fit the
rewrite shape.

**Frontmatter-only**: drop the `rewriteBodyLinks` line — the rest
is identical.

After running, diff the file (`git diff <path>`) to confirm the rewrite
touched only the fields and links you expected.

## Bulk migration: many files at once

When the rewrite spans dozens or thousands of files (folder rename,
schema-evolution migration, citation cleanup), the natural shape is
glob + iterate + dry-run + `isDirty()` gate. Pattern:

```typescript
import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'glob';  // or `node:fs`'s glob, or fast-glob
import {
  openFrontmatter,
  rewriteBodyLinks,
  rewriteFrontmatterUriReferencesFromSchema,
} from '@vibe-agent-toolkit/resources';

const DRY_RUN = process.env['DRY_RUN'] !== 'false';
const rewriteHref = (href: string): string =>
  href.replace('/docs/specs/', '/docs/architecture/');

const schema = JSON.parse(readFileSync('schemas/spec.schema.json', 'utf8'));
const files = globSync('docs/**/*.md');

let changed = 0;
let unchanged = 0;
for (const filePath of files) {
  const original = readFileSync(filePath, 'utf8');
  const editor = openFrontmatter(original);

  editor.body = rewriteBodyLinks(editor.body, rewriteHref);
  rewriteFrontmatterUriReferencesFromSchema(editor, schema, rewriteHref);

  // Skip files where nothing material changed. Avoids the no-op churn
  // described in §"What's preserved, what isn't".
  const next = editor.toString();
  if (!editor.isDirty() || next === original) {
    unchanged++;
    continue;
  }

  if (DRY_RUN) {
    console.log(`would update ${filePath}`);
  } else {
    writeFileSync(filePath, next);
  }
  changed++;
}

console.log(`${DRY_RUN ? 'DRY RUN: ' : ''}${changed} changed, ${unchanged} unchanged`);
```

**Recommended workflow for bulk runs:**

1. **Sentinel-first.** Run on a single representative file first
   (`globSync` pattern that matches exactly one path). Eyeball the diff.
2. **Dry-run the full set.** `DRY_RUN=true` lists every file the script
   would touch. Spot-check at least 3 entries before going wet.
3. **Iterate.** Adjust the callback or schema until the dry-run plan
   matches your intent.
4. **Run wet.** `DRY_RUN=false`. Then run your project's link validator
   (`vat resources validate`, link-check CI, etc.) on the corpus before
   committing — the rewrite is reversible via `git checkout` if any
   targets are wrong.

**Delegating to a subagent.** Bulk rewrites are good subagent work, but
brief them with the same three guardrails: provide the exact callback
rule, mandate dry-run first, and ask for a structured report (counts
of files changed/unchanged, a sample of 3 before/after diffs). Without
those guardrails, a subagent can silently produce a thousand-file diff
that's wrong in a subtle way and only catchable on careful review.

## What's preserved, what isn't

`openFrontmatter` inherits its preservation guarantees from `yaml.Document`
(eemeli). Read-only round-trip (no mutations) is byte-identical. Once you
mutate, the frontmatter section is re-emitted by `yaml.Document` and a few
things normalize:

| Behavior | Preserved on mutation? |
|---|---|
| Inline comment **text** (`# comment`) | ✅ |
| Inline comment **leading whitespace** (`  #` vs ` #`) | ❌ collapsed to one space |
| Leading comments on keys | ✅ (best-effort; comment-attachment is yaml.Document's call) |
| Comments on individual array items | ✅ |
| Block scalar style (`|`, `>`, `|-`, `>+`) | ✅ |
| Quoting style (plain / single / double) | ✅ |
| Blank lines between blocks | ✅ |
| Key ordering | ✅ |
| EOL (LF or CRLF) | ✅ (detected from first line break) |
| Anchors and aliases | ✅ on round-trip; mutating them follows `yaml.Document` semantics, not ours |

**Consequence:** even a "no-op" rewrite (callback returns the input
unchanged) re-emits frontmatter and can collapse `  #` → ` #` on every
line that has an inline comment. The change is harmless but shows up in
`git diff`. Two ways to skip the write in this case:

- **`editor.isDirty()`** — returns `true` if any mutator was called or
  `body` was reassigned to a different string. Cheap, no string compare,
  but flips on any mutator call even when the value didn't change
  (e.g. `set('foo', sameValue)`). Fine for most workflows.
- **Byte-level dirty check** — `editor.toString() !== originalText`. Catches
  the no-op-rewrite case exactly; one extra serialize per file. Use this
  when you must produce zero diff on no-op runs.

The bulk-migration recipe above combines both: `isDirty()` as the cheap
short-circuit, then a byte compare to filter out comment-whitespace-only
deltas.

## Cross-links

- `vat-knowledge-resources` — how to validate URI-references in
  frontmatter against a collection schema.
- `vat-skill-authoring` — when to use leading-`/` (project-root-relative)
  URI-refs in SKILL.md frontmatter.
