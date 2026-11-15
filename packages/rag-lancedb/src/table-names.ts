import type { Connection } from '@lancedb/lancedb';

/**
 * Every table name in a LanceDB database, walking `listTables` to the end.
 *
 * `Connection.tableNames()` is deprecated; its replacement returns one page at a
 * time, and a page may be shorter than its limit without being the last — only a
 * response with no `pageToken` ends the listing. Reading a single page would
 * silently miss tables past it, so every caller goes through this walk.
 *
 * @param connection - An open LanceDB connection
 * @returns The table names, in the order LanceDB lists them
 */
export async function listAllTableNames(connection: Connection): Promise<string[]> {
  const names: string[] = [];
  // Each page's request carries the previous page's token, so the walk recurses.
  const readFrom = async (pageToken: string | undefined): Promise<void> => {
    const page = await connection.listTables(pageToken === undefined ? {} : { pageToken });
    names.push(...page.tables);
    if (page.pageToken !== undefined && page.pageToken !== '') await readFrom(page.pageToken);
  };
  await readFrom(undefined);
  return names;
}
