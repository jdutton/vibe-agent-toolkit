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
number and no migration — the old directory goes cold, and only the OS temporary
directory purge reclaims a directory this build no longer opens.

## Eviction: the newest few trees per root

A write keeps the three most recently written trees of the root it is writing
and drops the rest, rows and all, **inside its own transaction**. That is not
tidiness: the extent key is a whole-repository tree hash, so any edit anywhere
mints a brand new full extent. Measured on this repository, five edits took a
store from 9.83 MB / 18,079 rows to 58.49 MB / 108,474 rows with nothing ever
reclaimed; with retention it holds flat at 29.4 MB / 54,228 rows over eight.

- The cost is amortized and bounded: the write that adds an extent removes one,
  through a `DELETE` over a **prefix of each table's own primary key**. No scan,
  no background process, no command that surprises an operator with a big bill.
- The tree being written can never be the victim — it is by construction the most
  recently written one — so `vat build`'s second phase still reads what its first
  phase wrote.
- A concurrent read cannot be torn. Reads run under `BEGIN DEFERRED`, and in WAL
  a reader stays on the snapshot it opened with.
- Retention is **per root**. Two projects share one namespace, and a global age
  ordering would let a busy repository evict a quiet one's only extent.

The store is created with `auto_vacuum = INCREMENTAL` and runs
`PRAGMA incremental_vacuum` after a prune that freed anything, so the file
shrinks rather than merely stopping its growth. A store created before that
pragma shipped keeps `auto_vacuum = NONE` — its freed pages go to the freelist
and are reused, so it stops growing but never shrinks.

**Blob-scoped rows are not evicted.** They are a pure function of bytes and are
shared by every tree and root containing those bytes, so they cannot be
attributed to one extent without a scan that could race another process between
its `writeBlobFacts` and its `writeExtent`. They also grow by one file's rows per
edit where the extent tier grew by a whole corpus. That tier remains bounded only
by the namespace rotation.

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
