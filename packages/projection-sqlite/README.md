# @vibe-agent-toolkit/projection-sqlite

A SQLite-backed `ProjectionStore` for VAT's resource projection, on Node's
built-in `node:sqlite` in WAL mode.

## Install

```bash
npm install @vibe-agent-toolkit/projection-sqlite
```

Separate from `@vibe-agent-toolkit/resources` because a storage backend is a
choice, not a default. Choosing this one costs almost nothing: `node:sqlite`
ships with Node, so there is no binary, no WASM module, no extension to seed and
nothing to download.

**Requires Node >= 22.13.0** — `node:sqlite` is absent from 22.12.0. The rest of
the toolkit stays at `>=22.0.0`; a backend nobody has to install should not
raise everyone else's floor. The module is unflagged from the Node 24 line
onward; on Node 22 it emits one `ExperimentalWarning` per process, which this
package deliberately does not suppress.

> 🪤 Bun's runtime has no `node:sqlite` (it ships `bun:sqlite`, a different API).
> Nothing in VAT executes under Bun, but importing this package into a Bun
> *application* will not work.

## Usage

```typescript
import { splitProjectionByScope } from '@vibe-agent-toolkit/resources';
import { openSqliteProjectionStore } from '@vibe-agent-toolkit/projection-sqlite';

const store = openSqliteProjectionStore();

const { blobs, extent } = splitProjectionByScope(projection);
await store.writeBlobFacts(blobs);
await store.writeExtent({ rootId, treeHash }, extent);

const cached = await store.readExtent({ rootId, treeHash });
if (cached === undefined) {
  // never scanned — populate it
}

await store.close();
```

## What it stores, and where

The twelve projection tables split in two, by the `scope` each declares in
`PROJECTION_TABLES`:

| scope | tables | keyed by | lifetime |
|---|---|---|---|
| `blob` | `blobs`, `blob_references`, `blob_sections`, `blob_conditions` | content key | forever — a pure function of the bytes, shared by every tree containing them |
| `extent` | the other eight | `(storeRootId, storeTreeHash)` | forever *for that tree* — the extent of a tree is a pure function of that tree |

Extent-scoped tables carry two extra leading columns holding that key, and their
primary key is prefixed with it, so reading one tree is a key-range scan and no
secondary index is needed.

The database lives at
`<vatCacheNamespaceRoot()>/projection-<shape digest>/projection.db`. The
namespace already moves on every VAT release; the shape digest is derived from
the row schemas themselves, so a schema edit lands in a different file rather
than being read back as rows this build would misinterpret. There is no version
number and no migration — the old directory goes cold and the OS temporary
directory purge, which is this cache's eviction policy, reclaims it.

## Traps this package exists to have already solved

- **`busy_timeout` is set before `journal_mode = WAL`** — the WAL switch takes a
  brief exclusive lock and a connection with no busy handler installed fails it.
- **…and the busy handler does not cover that statement anyway.** Measured: four
  processes opening a fresh store at once produced `database is locked` from the
  WAL switch with a 5,000 ms timeout already set. WAL is a persistent property of
  the *file*, so the switch is check-then-retry and a losing racer usually finds
  the mode already changed.
- **Reads run in an explicit `BEGIN DEFERRED`.** Reading nine tables in
  autocommit is nine read transactions, which is exactly the torn read this
  store promises cannot happen. It also fixes a staleness failure that is
  entirely silent: a connection doing only autocommit reads was measured
  returning an *empty* store 200,000 times while another process committed 500
  transactions to it, no error, exit 0 on both sides.
- **Statements are prepared once and reused**, for the same reason.
- **Writes replace their key range rather than relying on a conflict clause.**
  Three tables key on a legitimately nullable column, and SQLite's unique index
  treats two NULLs as distinct — so `ON CONFLICT DO NOTHING` would silently
  accumulate duplicates of exactly those rows.

## License

MIT
