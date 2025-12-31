import fs from 'node:fs/promises';
import path from 'node:path';

import { AgentManifestSchema, type AgentManifest } from '@vibe-agent-toolkit/agent-schema';
import { parse as parseYaml } from 'yaml';

export interface LoadedAgentManifest extends AgentManifest {
  /**
   * Absolute path to the manifest file
   * Added by loader for reference
   */
  __manifestPath: string;
}

/**
 * Find agent manifest file from path argument
 * Supports:
 * - Direct path to manifest (agent.yaml, agent.yml)
 * - Directory containing manifest
 */
export async function findManifestPath(pathArg: string): Promise<string> {
  const absolutePath = path.resolve(process.cwd(), pathArg);

  // Check if it's a direct file reference
  if (pathArg.endsWith('.yaml') || pathArg.endsWith('.yml')) {
    try {
      await fs.access(absolutePath);
      return absolutePath;
    } catch {
      throw new Error(`Manifest file not found: ${absolutePath}`);
    }
  }

  // Assume it's a directory - search for manifest
  const candidates = [
    path.join(absolutePath, 'agent.yaml'),
    path.join(absolutePath, 'agent.yml'),
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue to next candidate
    }
  }

  throw new Error(
    `No agent manifest found in ${absolutePath}. Expected agent.yaml or agent.yml`
  );
}

/**
 * Load and validate agent manifest from file
 * Returns manifest with additional __manifestPath property
 */
export async function loadAgentManifest(pathArg: string): Promise<LoadedAgentManifest> {
  try {
    // Find manifest file
    const manifestPath = await findManifestPath(pathArg);

    // Read file (manifestPath validated by findManifestPath)
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path validated above
    const content = await fs.readFile(manifestPath, 'utf-8');

    // Parse YAML
    let data: unknown;
    try {
      data = parseYaml(content);
    } catch (error) {
      throw new Error(
        `Failed to parse YAML: ${error instanceof Error ? error.message : 'unknown error'}`
      );
    }

    // Validate schema
    const result = AgentManifestSchema.safeParse(data);
    if (!result.success) {
      const errors = result.error.errors
        .map(err => `  - ${err.path.join('.')}: ${err.message}`)
        .join('\n');
      throw new Error(`Agent manifest validation failed:\n${errors}`);
    }

    // Add manifest path to result
    return {
      ...result.data,
      __manifestPath: manifestPath,
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load agent manifest from ${pathArg}: ${error.message}`);
    }
    throw error;
  }
}
