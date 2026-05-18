---
name: markdown-rewriting
description: Use when programmatically editing markdown or frontmatter — moving files, updating references, batch-renaming, schema-evolution migrations. Steers to comment-preserving FrontmatterEditor + rewriteBodyLinks; away from gray-matter/js-yaml/regex.
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
  `.appendArrayItem`, `.delete(path)`, and `.toString()`. The underlying
  `yaml.Document` is intentionally not exposed.
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
touched. **Frontmatter-only**: drop the `rewriteBodyLinks` line — the rest
is identical.

After running, diff the file (`git diff <path>`) to confirm the rewrite
touched only the fields and links you expected.

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
`git diff`. If you don't want it, gate your `writeFileSync` on whether
the editor actually changed anything material.

## Cross-links

- `vat-knowledge-resources` — how to validate URI-references in
  frontmatter against a collection schema.
- `vat-skill-authoring` — when to use leading-`/` (project-root-relative)
  URI-refs in SKILL.md frontmatter.
