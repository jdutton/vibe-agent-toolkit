/**
 * Agent discovery utility - finds agents in common locations
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import * as yaml from 'js-yaml';

export interface DiscoveredAgent {
  name: string;
  version: string;
  path: string;
  manifestPath: string;
}

/**
 * Discover all agents in common locations
 */
export async function discoverAgents(): Promise<DiscoveredAgent[]> {
  const searchPaths = [
    'packages/vat-development-agents/agents',
    'agents',
    '.',
  ];

  const agentPromises = searchPaths.map(searchPath => discoverAgentsInPath(searchPath));
  const agentArrays = await Promise.all(agentPromises);

  return agentArrays.flat();
}

async function discoverAgentsInPath(searchPath: string): Promise<DiscoveredAgent[]> {
  try {
    const absolutePath = path.resolve(process.cwd(), searchPath);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path is from predefined constant list
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });

    const directories = entries.filter(entry => entry.isDirectory());
    const agentPromises = directories.map(entry =>
      discoverAgentInDirectory(path.join(absolutePath, entry.name))
    );

    const agents = await Promise.all(agentPromises);
    return agents.filter((agent): agent is DiscoveredAgent => agent !== null);
  } catch {
    // Path doesn't exist or not accessible - return empty array
    return [];
  }
}

async function discoverAgentInDirectory(agentDir: string): Promise<DiscoveredAgent | null> {
  const manifestPath = await findManifest(agentDir);
  if (!manifestPath) {
    return null;
  }

  return parseAgentManifest(manifestPath, agentDir);
}

async function findManifest(dir: string): Promise<string | null> {
  const candidates = ['agent.yaml', 'agent.yml'];

  for (const candidate of candidates) {
    const manifestPath = path.join(dir, candidate);
    try {
      await fs.access(manifestPath);
      return manifestPath;
    } catch {
      // Continue
    }
  }

  return null;
}

async function parseAgentManifest(
  manifestPath: string,
  agentDir: string
): Promise<DiscoveredAgent | null> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifestPath from findManifest, trusted
    const content = await fs.readFile(manifestPath, 'utf-8');
    const data = yaml.load(content) as {
      metadata?: { name?: string; version?: string };
    };

    if (data?.metadata?.name && data?.metadata?.version) {
      return {
        name: data.metadata.name,
        version: data.metadata.version,
        path: agentDir,
        manifestPath,
      };
    }
  } catch {
    // Invalid manifest - skip
  }

  return null;
}

/**
 * Find agent by name from discovered agents
 */
export async function findAgentByName(name: string): Promise<DiscoveredAgent | null> {
  const agents = await discoverAgents();
  return agents.find(agent => agent.name === name) ?? null;
}

/**
 * Resolve agent path from name or path
 *
 * If the input looks like a path (contains / or \, or ends with .yaml/.yml),
 * it is returned as-is. Otherwise, it's treated as an agent name and
 * resolved via discovery.
 *
 * @param pathOrName - Agent name or path
 * @param logger - Optional logger for debug output
 * @returns Resolved agent path
 */
export async function resolveAgentPath(
  pathOrName: string,
  logger?: { debug: (message: string) => void }
): Promise<string> {
  // If it looks like a path, return it as-is
  if (pathOrName.includes('/') || pathOrName.includes('\\') || pathOrName.endsWith('.yaml') || pathOrName.endsWith('.yml')) {
    return pathOrName;
  }

  // Otherwise, try to resolve as agent name
  logger?.debug(`Looking up agent by name: ${pathOrName}`);
  const agent = await findAgentByName(pathOrName);

  if (agent) {
    logger?.debug(`Found agent: ${agent.name} at ${agent.path}`);
    return agent.path;
  }

  logger?.debug(`No agent found with name '${pathOrName}', treating as path`);
  return pathOrName;
}
