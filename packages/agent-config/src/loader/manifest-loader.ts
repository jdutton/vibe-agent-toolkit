import fs from 'node:fs/promises';

import { AgentManifestSchema, type AgentManifest } from '@vibe-agent-toolkit/schema';
import { everyInOrder, isPathAbsentError, isVatError, safePath, VatError } from '@vibe-agent-toolkit/utils';
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

/** A loader error for a manifest that is there but the OS refuses, or that is not YAML. */
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

/**
 * Whether nothing is at `path`. Only an absence answers `true`: a path the OS
 * refuses (`EACCES`, `ELOOP`) is not "not found", and reporting it as such
 * sends the reader to create a manifest that is already there — so the
 * refusal propagates.
 */
async function isAbsent(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return false;
  } catch (error) {
    if (isPathAbsentError(error)) return true;
    throw unreadable(path, error);
  }
}

function unreadable(path: string, error: unknown): VatError {
  const reason = error instanceof Error ? error.message : String(error);
  return new VatError(AGENT_MANIFEST_UNREADABLE_CODE, `Cannot read agent manifest ${path}: ${reason}`, { cause: error });
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

/**
 * Load and validate agent manifest from file
 * Returns manifest with additional __manifestPath property
 */
export async function loadAgentManifest(pathArg: string): Promise<LoadedAgentManifest> {
  let document: { manifestPath: string; data: unknown };
  try {
    document = await readAgentManifestDocument(pathArg);
  } catch (error) {
    if (isVatError(error)) {
      throw new VatError(error.code, `Failed to load agent manifest from ${pathArg}: ${error.message}`, { cause: error });
    }
    throw error;
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
