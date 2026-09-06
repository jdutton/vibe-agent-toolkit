# Knowledge interop formats: OKF and ARD

Two open specifications published in mid-2026 describe how machine-readable knowledge and
capabilities are packaged and found. They answer different questions and are frequently confused:

- **OKF** — *Open Knowledge Format*. **What is this knowledge package?**
- **ARD** — *Agentic Resource Discovery*. **Where does an agent find the available resources?**

They are separable. A bundle can exist with no discovery layer, and a catalog can advertise things
that are not bundles. VAT's interest in each is different, and neither depends on the other.

## Where VAT sits

VAT is **producer-side tooling**. It helps publishers produce well-formed knowledge and resource
repositories. The consumers are agents and LLMs, which are forgiving of malformed input — but *good
links are cheaper to resolve than bad ones*, and a publisher is the only party positioned to fix
them.

This framing decides a recurring question. OKF's conformance section says a **consumer** MUST NOT
reject a bundle for unknown keys, unknown types, missing optional fields, or broken links. That
clause binds consumers. **It does not constrain VAT**, which is free to gate as hard as an adopter
wants — VAT's default is to error on a bad resource link, and adopters may lower the severity.

## OKF — Open Knowledge Format

Published by Google Cloud, June 2026; **v0.2** at time of writing, and framed by its authors as a
starting point rather than a finished standard.

A **bundle** is a directory of markdown files, one *concept* per file, each carrying YAML
frontmatter. The bundle is the unit of distribution.

- **Exactly one required field: `type`** — a non-empty free string (`BigQuery Table`, `Playbook`,
  `Metric`). There is no central registry of values, and consumers are expected to tolerate unknown
  ones. But note the *scope*: conformance requires that frontmatter on **every** non-reserved `.md`
  file in the tree, so the cost of declaring a bundle is paid per file, not once. Only `index.md`
  and `log.md` are exempt — "all other `.md` files are concept documents" — and the specification
  offers no way to narrow a bundle's population below its whole tree.
- Recommended: `title`, `description`, `resource` (a URI for the underlying asset), `tags`.
- Optional families: `sources[]` (provenance), `generated` / `verified` (trust, with an actor
  convention of `human:<id>`, `process:<id>`, `<producer>/<version>`), `status` and `stale_after`
  (lifecycle).
- **Reserved filenames** `index.md` (directory listing) and `log.md` (dated update history) at any
  level. A bundle-root `index.md` may carry `okf_version`.
- **Cross-links are ordinary markdown links**, bundle-relative or relative — **not wikilinks**.
  Edges are untyped and directed. A bundle-relative link is written:

  ```markdown
  [Customers table](/tables/customers.md)
  ```

  where the leading `/` means *bundle root*, not filesystem root.

### Why it fits VAT's existing shape

A bundle is a **resource collection with a frontmatter schema**, which VAT already does end to end:
glob discovery, per-directory `frontmatterSchema` resolved through `resolveAssetReference`,
`vat resources validate`, packaging. See
[collection validation](../guides/collection-validation.md).

Two consequences worth stating plainly, because both have bitten designs already:

**OKF-ness is a property of a directory, not a file.** Everything that makes a bundle OKF is
bundle-scoped — reserved filenames per level, `okf_version` at the root, and `/`-absolute links
resolving against the *bundle root*. So it cannot be expressed as a `mimeType`, which is per-file
(see the `CollectionConfigSchema` docstring in
`packages/resources/src/schemas/project-config.ts` for the full ruling on that axis), and it cannot
be expressed by an include glob, which never names a root.

**The population must be spec-defined, not glob-narrowed.** OKF requires that *every* non-reserved
`.md` under the root parses and carries a `type`. If an include pattern decided what got checked, a
narrower glob would let a file nobody looked at break conformance while the bundle reported clean.

**OKF needs none of the wikilink work** — its links are markdown links, already captured as
`markdown-link` reference rows.

## ARD — Agentic Resource Discovery

Announced June 2026, Apache 2.0, with a data model developed in a Linux Foundation working group.
⚠️ **Status: Proposal, v0.91.** It is moving; emit against it, do not wire internals to it.

**There is no registry and no upload.** A publisher hosts a JSON-LD document at
`https://{domain}/.well-known/ard.json` containing an `entries` array. Alternative discovery paths
are in-page JSON-LD, an HTML `rel="ard"` link tag, and DNS SVCB records. Registries crawl and
federate; a registry entry is itself an entry type, so catalogs nest.

Structurally this is the model VAT already uses for `vat claude marketplace publish` — emit an
artifact and host it yourself. See [marketplace distribution](../guides/marketplace-distribution.md).

An **entry** requires `identifier` (a domain-anchored URN, `urn:air:<publisher>:<namespace>:<name>`),
`displayName`, and `type` — with `url` XOR `data` as a separate constraint rather than a fourth
required field.

**`representativeQueries` (2–5) is the field that decides usefulness.** The spec is explicit that an
entry without it cannot be found by search, *"which is what distinguishes an ARD entry from a bare
catalog entry."* Its absence is validated as a **warning**, not an error.

### Why ARD is a natural fit for VAT

ARD's envelope is deliberately **type-agnostic**: the specification "does not define or constrain
the internal schema of specific agent types", and `type` is an open IANA media-type string. So a
skill entry is expressible without ARD having to bless a skill type — and it has not blessed one.
`application/ai-skill+md` appears in the specification exactly once, in a worked example; the only
types it names as tracking towards formal registration are `application/a2a-agent-card+json` and
`application/mcp-server-card+json`, and it says even those registrations are pending. A publisher
emitting a skill entry is **coining** that media type, not adopting a registered one, and should
expect it to move.

What makes the fit natural is the other half: VAT already knows what a repo publishes, so an
`entries` array is very nearly a restatement of what the project config already declares.

That extends VAT's portability thesis from *portable agents* to *portable discovery*: today a
VAT-built skill reaches agents through npm and a Claude marketplace branch, both Claude-shaped
channels, while ARD is vendor-neutral.

⚠️ **Do not reuse OKF's argument here.** OKF's opening for VAT is that no validator ships anywhere.
ARD is the opposite — it ships a conformance CLI plus CDDL, JSON Schema and OpenAPI definitions.
VAT's value against ARD is **generating correct entries from real artifacts**, not being the only
linter.

### The OKF ↔ ARD join is not settled

An ARD entry can advertise an OKF bundle today only through namespaced `@context` extension terms. A
blessed `application/okf-bundle` media type is an open proposal, not a fact. Do not design as though
the two join cleanly.

## Related

- [Zones: extents and lenses](../architecture/zones.md) — the lens model that decides how a
  reference resolves, including the `wiki` lens
- [Resource projection](../architecture/resource-projection.md) — the tables, and the planned
  `edges` / `edge_resolutions` split
- [Collection validation](../guides/collection-validation.md) — per-directory frontmatter schemas
- [Package-based schema references](../guides/package-based-schema-references.md) — how a schema
  path resolves, including npm bare specifiers
