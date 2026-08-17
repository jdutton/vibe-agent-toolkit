/**
 * Parquet output for VAT's resource projection.
 *
 * This package is a **separate install**, on purpose. It carries the DuckDB
 * WASM engine (~37 MB of binaries once the extension bytes are seeded), and
 * `@vibe-agent-toolkit/resources` — VAT's most widely installed package — has
 * no heavy dependencies today. Putting the engine there would tax every
 * adopter who never writes a table, so the engine, the extension seeding, and
 * the writer live here instead, behind a thin seam in `resources`.
 *
 * It is deliberately NOT an `optionalDependency` of anything: npm installs
 * those by default, which would reintroduce exactly the cost this split
 * removes. Consumers run a separate `npm install`, and the CLI discovers the
 * absence at runtime through the `ERR_MODULE_NOT_FOUND` gate in
 * `packages/cli/src/utils/optional-backend.ts`.
 *
 * Scaffold only — the writer lands next.
 */

/**
 * Filename extension every table this package writes carries.
 *
 * Named here rather than spelled inline at each call site so the writer, the
 * reader, and any consumer globbing an output directory all agree on one
 * spelling.
 */
export const PARQUET_FILE_EXTENSION = '.parquet';
