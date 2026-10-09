import fs from 'node:fs/promises';

import { AgentManifestSchema, type AgentManifest } from '@vibe-agent-toolkit/schema';
import { classifyFsFault, everyInOrder, isFsFaultError, isPathAbsentError, isVatError, safePath, VatError } from '@vibe-agent-toolkit/utils';
import { parse as parseYaml } from 'yaml';

export interface LoadedAgentManifest extends AgentManifest {
  /**
   * Absolute path to the manifest file
   * Added by loader for reference
   */
  __manifestPath: string;
}

/** A loader error for a path naming no manifest — the caller's mistake. */
export const AGENT_MANIFEST_NOT_FOUND_CODE = 'AGENT_MANIFEST_NOT_FOUND';

/** A loader error for a manifest whose content is not YAML. A manifest the OS refuses is a classified filesystem fault (`FS_FAULT`). */
export const AGENT_MANIFEST_UNREADABLE_CODE = 'AGENT_MANIFEST_UNREADABLE';

/** A loader error for a manifest that parsed but the schema rejects. */
export const AGENT_MANIFEST_INVALID_CODE = 'AGENT_MANIFEST_INVALID';

/**
 * Find agent manifest file from path argument
 * Supports:
 * - Direct path to manifest (agent.yaml, agent.yml)
 * - Directory containing manifest
 */
export async function findManifestPath(pathArg: string): Promise<string> {
  const absolutePath = safePath.resolve(process.cwd(), pathArg);

  // Check if it's a direct file reference
  if (pathArg.endsWith('.yaml') || pathArg.endsWith('.yml')) {
    if (!(await isAbsent(absolutePath))) return absolutePath;
    throw new VatError(AGENT_MANIFEST_NOT_FOUND_CODE, `Manifest file not found: ${absolutePath}`);
  }

  // Assume it's a directory - search for manifest
  const candidates = [
    safePath.join(absolutePath, 'agent.yaml'),
    safePath.join(absolutePath, 'agent.yml'),
  ];

  // In order: agent.yaml wins over agent.yml, and a refusal on the first stops the search.
  let found: string | undefined;
  await everyInOrder(candidates, async (candidate) => {
    if (await isAbsent(candidate)) return true;
    found = candidate;
    return false;
  });
  if (found !== undefined) return found;

  throw new VatError(
    AGENT_MANIFEST_NOT_FOUND_CODE,
    `No agent manifest found in ${absolutePath}. Expected agent.yaml or agent.yml`,
  );
}

/** Whether nothing is at `path`. A path the OS refuses (`EACCES`, `ELOOP`) is not "not found": the refusal propagates. */
async function isAbsent(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return false;
  } catch (error) {
    if (isPathAbsentError(error)) return true;
    throw unreadable(path, error);
  }
}

/** A manifest the OS refuses: a `source` fault on the path the command line named. */
function unreadable(path: string, error: unknown): unknown {
  return classifyFsFault(error, { side: 'source', origin: 'argument', action: 'read the agent manifest', path });
}

/**
 * Find a manifest and parse its YAML — everything short of the schema, so a
 * validator can report schema violations as findings about a file it read.
 */
export async function readAgentManifestDocument(pathArg: string): Promise<{ manifestPath: string; data: unknown }> {
  const manifestPath = await findManifestPath(pathArg);

  let content: string;
  try {
    content = await fs.readFile(manifestPath, 'utf-8');
  } catch (error) {
    throw unreadable(manifestPath, error);
  }

  try {
    return { manifestPath, data: parseYaml(content) as unknown };
  } catch (error) {
    throw new VatError(
      AGENT_MANIFEST_UNREADABLE_CODE,
      `Failed to parse YAML in ${manifestPath}: ${error instanceof Error ? error.message : 'unknown error'}`,
      { cause: error },
    );
  }
}

/** A coded loader error, said about the argument it was loading; a classified filesystem fault is thrown as itself, since its message already names the manifest path. */
function withManifestContext(error: VatError, pathArg: string): VatError {
  if (isFsFaultError(error)) return error;
  return new VatError(error.code, `Failed to load agent manifest from ${pathArg}: ${error.message}`, { cause: error });
}

/**
 * Load and validate agent manifest from file
 * Returns manifest with additional __manifestPath property
 */
export async function loadAgentManifest(pathArg: string): Promise<LoadedAgentManifest> {
  let document: { manifestPath: string; data: unknown };
  try {
    document = await readAgentManifestDocument(pathArg);
  } catch (error) {
    throw isVatError(error) ? withManifestContext(error, pathArg) : error;
  }

  const result = AgentManifestSchema.safeParse(document.data);
  if (!result.success) {
    const errors = result.error.errors
      .map(err => `  - ${err.path.join('.')}: ${err.message}`)
      .join('\n');
    throw new VatError(
      AGENT_MANIFEST_INVALID_CODE,
      `Failed to load agent manifest from ${pathArg}: Agent manifest validation failed:\n${errors}`,
    );
  }

  return {
    ...result.data,
    __manifestPath: document.manifestPath,
  };
}
