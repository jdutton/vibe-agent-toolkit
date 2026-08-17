# @vibe-agent-toolkit/projection-parquet

Parquet output for VAT's resource projection, backed by DuckDB WASM.

> **Status: scaffold.** The package, its dependency pin, and its place in the
> monorepo build are in place; the writer itself lands next. The only export
> today is `PARQUET_FILE_EXTENSION`.

## Overview

VAT's resource projection turns a crawled corpus into tabular facts. This
package is the lane that materialises those tables as Parquet files on disk. It
owns three things that nothing else in the toolkit should have to carry:

- the **DuckDB WASM engine** it writes through,
- the **extension seeding** that makes that engine work offline, and
- the **writer** itself.

`@vibe-agent-toolkit/resources` exposes only a thin seam onto this package. It
does not depend on it.

## Installation — a deliberate, separate install

```bash
npm install @vibe-agent-toolkit/projection-parquet
```

This package is **not** a dependency, and **not** an `optionalDependency`, of
any other VAT package — `optionalDependencies` install by default, which would
defeat the entire point of the split. Installing it is an explicit act.

**Why the split:** the DuckDB WASM engine is roughly **138 MB unpacked**
(three engine builds — `mvp`, `eh`, `coi` — at 32–38 MB each, plus ~26 MB of
source maps). `@vibe-agent-toolkit/resources` is VAT's most widely installed
package and carries no heavy dependencies today; folding the engine into it
would charge that cost to every adopter who never writes a table.

Commands that need the writer discover its absence at runtime and print the
`npm install` line above rather than failing obscurely — the same
`ERR_MODULE_NOT_FOUND` gate the RAG backend uses (see
`packages/cli/src/utils/optional-backend.ts`).

## Usage sketch

Not yet implemented — shown so the intended shape is on record:

```typescript
import { PARQUET_FILE_EXTENSION } from '@vibe-agent-toolkit/projection-parquet';

// One projected table becomes one `<table>.parquet` under the output directory.
const fileName = `resources${PARQUET_FILE_EXTENSION}`;
```

## Dependency pinning

`@duckdb/duckdb-wasm` is pinned **exactly** (`1.32.0`), with no caret. Two
independent reasons, both verified:

1. The extension-cache probe path embeds a DuckDB **core** version derived from
   the package build, so the shipped extension bytes are version-coupled to the
   engine.
2. `npm view @duckdb/duckdb-wasm dist-tags` reports `latest` as a **prerelease**
   (`1.33.1-dev57.0`); `1.32.0` is the newest non-prerelease. A `^` range here
   risks silently resolving to a dev build.

<!-- @vendor-claim reviewed=2026-08-17 verify=run `npm view @duckdb/duckdb-wasm dist-tags` and re-read the extension cache path in @duckdb/duckdb-wasm's runtime source -->

## License

MIT
