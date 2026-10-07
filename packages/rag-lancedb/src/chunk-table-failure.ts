/**
 * Why LanceDB failed a read of the chunk table, decided at the cause rather
 * than from LanceDB's message — every LanceDB failure is the same
 * `GenericFailure`, so the message is all it offers. Each cause has its own
 * remedy, and a wrong one costs the operator their data or their time:
 *
 * - a file or directory the OS will not let this process read: fix its
 *   permissions. Removing the database fails on the same files.
 * - a table whose columns are not the ones this provider writes (another
 *   tool's table, a build with another metadata schema or embedding model):
 *   remove it and index again.
 * - otherwise, damaged files: remove it and index again.
 */

import fs from 'node:fs';

import type { Table } from '@lancedb/lancedb';
import { RAG_DATABASE_UNREADABLE_CODE, safePath, VatError } from '@vibe-agent-toolkit/utils';
import type { ZodObject, ZodRawShape } from 'zod';

import { TABLE_NAME } from './database-directory.js';
import { serializeMetadata, type LanceDBRow } from './schema.js';

/** The core columns every chunk row this provider writes carries (`chunkToLanceRow`). */
const CORE_CHUNK_COLUMNS = [
  'vector', 'chunkid', 'resourceid', 'content', 'contenthash', 'tokencount', 'chunkindex', 'totalchunks',
  'embeddingmodel', 'embeddedat', 'previouschunkid', 'nextchunkid', 'resourcecontenthash',
] as const satisfies ReadonlyArray<keyof LanceDBRow>;

/** What this provider expects of the chunk table it reads. */
export interface ChunkTableShape {
  readonly dbPath: string;
  readonly metadataSchema: ZodObject<ZodRawShape>;
  /** The embedding model's vector length. */
  readonly dimensions: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RefusedPath {
  readonly path: string;
  readonly errno: string;
}

function permissionRefusal(path: string, error: unknown): RefusedPath | undefined {
  const errno = (error as NodeJS.ErrnoException).code;
  return errno === 'EACCES' || errno === 'EPERM' ? { path, errno } : undefined;
}

function refusedFile(path: string): RefusedPath | undefined {
  try {
    fs.accessSync(path, fs.constants.R_OK);
    return undefined;
  } catch (error) {
    return permissionRefusal(path, error);
  }
}

/** The first entry under `dir` (or `dir` itself) the OS will not let this process list or read. */
function firstRefusedPath(dir: string): RefusedPath | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return permissionRefusal(dir, error);
  }
  for (const entry of entries) {
    // LanceDB writes no links into a table, and what one names is not the table's to judge.
    if (entry.isSymbolicLink()) continue;
    const path = safePath.join(dir, entry.name);
    let refused: RefusedPath | undefined;
    if (entry.isDirectory()) refused = firstRefusedPath(path);
    else if (entry.isFile()) refused = refusedFile(path);
    if (refused) return refused;
  }
  return undefined;
}

/** The table's columns as its schema reports them, or why the schema would not read. */
type StoredColumns = { readonly fields: ReadonlyArray<{ name: string; type: unknown }> } | { readonly schemaError: unknown };

async function storedColumns(table: Table): Promise<StoredColumns> {
  try {
    return { fields: (await table.schema()).fields };
  } catch (schemaError) {
    return { schemaError };
  }
}

/**
 * How the table's stored columns differ from the ones this provider writes.
 *
 * @returns One phrase per difference; empty when they match
 */
function columnDifferences(fields: ReadonlyArray<{ name: string; type: unknown }>, shape: ChunkTableShape): string[] {
  const present = new Set(fields.map((field) => field.name));
  // Serializing an empty record yields every metadata column at its sentinel.
  const metadataColumns = Object.keys(serializeMetadata<Record<string, unknown>>({}, shape.metadataSchema));
  const missing = [...CORE_CHUNK_COLUMNS, ...metadataColumns].filter((column) => !present.has(column));
  const differences = missing.length > 0 ? [`it has no ${missing.join(', ')} column${missing.length === 1 ? '' : 's'}`] : [];
  const vectorType = fields.find((field) => field.name === 'vector')?.type as { listSize?: unknown } | undefined;
  if (typeof vectorType?.listSize === 'number' && vectorType.listSize !== shape.dimensions) {
    differences.push(`its vectors have ${vectorType.listSize} dimensions and the embedding model makes ${shape.dimensions}`);
  }
  return differences;
}

/**
 * The refusal for a chunk table whose columns or vector size are not this
 * provider's; undefined when they are. A table of another vector size reads
 * without error, so every verb checks up front, not only after a failed read.
 */
export function foreignTableRefusal(
  shape: ChunkTableShape,
  fields: ReadonlyArray<{ name: string; type: unknown }>,
  cause?: unknown,
): VatError | undefined {
  const differences = columnDifferences(fields, shape);
  if (differences.length === 0) return undefined;
  return new VatError(
    RAG_DATABASE_UNREADABLE_CODE,
    `The '${TABLE_NAME}' table at ${shape.dbPath} is not one this build of vat rag index writes: ${differences.join('; ')}. ` +
      'Another tool, or a build with another metadata schema or embedding model, wrote it. Remove the database (vat rag clear) and index again.',
    cause === undefined ? undefined : { cause },
  );
}

/**
 * The refusal for a failed read of the chunk table, naming its cause.
 *
 * @param shape - Where the database is and what this provider expects of it
 * @param cause - What LanceDB threw
 * @param table - The open table, when the failure was a read of one (not the open)
 * @returns A `RAG_DATABASE_UNREADABLE` error whose message says why and what to do
 */
export async function chunkTableReadFailure(shape: ChunkTableShape, cause: unknown, table?: Table): Promise<VatError> {
  const where = `The '${TABLE_NAME}' table at ${shape.dbPath}`;
  const refused = firstRefusedPath(safePath.join(shape.dbPath, `${TABLE_NAME}.lance`));
  if (refused) {
    return new VatError(
      RAG_DATABASE_UNREADABLE_CODE,
      `${where} cannot be read: the OS refuses ${refused.path} (${refused.errno}). ` +
        'Fix its permissions and ownership; removing the database would fail on the same files.',
      { cause },
    );
  }
  const stored = table === undefined ? undefined : await storedColumns(table);
  const foreign = stored !== undefined && 'fields' in stored ? foreignTableRefusal(shape, stored.fields, cause) : undefined;
  if (foreign) return foreign;
  const schemaFailure = stored !== undefined && 'schemaError' in stored ? ` (its schema will not read either: ${messageOf(stored.schemaError)})` : '';
  return new VatError(
    RAG_DATABASE_UNREADABLE_CODE,
    `${where} cannot be read (its files are damaged): ${messageOf(cause)}${schemaFailure}. ` +
      'Remove the database (vat rag clear) and index again.',
    { cause },
  );
}

export const __internal = { CORE_CHUNK_COLUMNS } as const;
