/**
 * Agent discovery utility - finds agents in common locations
 */

import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';

import { direntKindFollowing, isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';
import * as yaml from 'yaml';

import { CommandRefusalError } from './command-refusal.js';

export interface DiscoveredAgent {
  name: string;
  version: string;
  path: string;
  manifestPath: string;
}

/**
 * The directories agent discovery lists, relative to the working directory, in
 * search order.
 */
export const AGENT_SEARCH_PATHS: readonly string[] = [
  'packages/vat-development-agents/agents',
  'agents',
  '.',
];

/** A path discovery could not read: every agent beneath it is missing from the answer. */
export interface UnreadableAgentPath {
  /** The absolute directory or manifest the OS refused. */
  path: string;
  /** The errno it was refused with. */
  errno: string;
}

/** What one discovery found, and the paths it could not read. */
interface AgentSurvey {
  agents: DiscoveredAgent[];
  /** One entry per refused path, deduplicated: empty when the answer is complete. */
  unreadable: UnreadableAgentPath[];
}

/**
 * Discover the agents under {@link AGENT_SEARCH_PATHS}, keeping going past a
 * path the OS refuses and handing each refusal back — for a listing, which
 * reports the gap as its own finding.
 *
 * Only an ABSENCE is empty: a search path that does not exist holds no agents,
 * a directory with no manifest is not an agent, a manifest that is not YAML is
 * not one either. A path the OS refuses is none of those, and is `unreadable`.
 */
export async function surveyAgents(): Promise<AgentSurvey> {
  const unreadable = new Map<string, UnreadableAgentPath>();
  const refused = (path: string, error: unknown): null => {
    unreadable.set(path, { path, errno: (error as NodeJS.ErrnoException).code ?? 'unknown error' });
    return null;
  };

  const agentArrays = await Promise.all(
    AGENT_SEARCH_PATHS.map(searchPath => discoverAgentsInPath(safePath.resolve(process.cwd(), searchPath), refused)),
  );
  return { agents: agentArrays.flat(), unreadable: [...unreadable.values()] };
}

/**
 * Discover all agents in common locations — refusing, rather than answering
 * short, when any of them cannot be read: a lookup by name that silently missed
 * the agent would say "not found" about a tree it never opened.
 *
 * @throws {CommandRefusalError} `INPUT_UNREADABLE` naming the first path the OS refused
 */
export async function discoverAgents(): Promise<DiscoveredAgent[]> {
  const { agents, unreadable } = await surveyAgents();
  const [first] = unreadable;
  if (first) {
    throw new CommandRefusalError(
      'INPUT_UNREADABLE',
      `Agent discovery could not read ${first.path} (${first.errno}); an agent beneath it cannot be found.`,
    );
  }
  return agents;
}

/** Records a refused path and answers `null` (nothing found there). */
type RefusedPath = (path: string, error: unknown) => null;

async function discoverAgentsInPath(absolutePath: string, refused: RefusedPath): Promise<DiscoveredAgent[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(absolutePath, { withFileTypes: true });
  } catch (error) {
    // No such search path: nothing here.
    if (isPathAbsentError(error)) return [];
    refused(absolutePath, error);
    return [];
  }

  // Followed: a `--dev` install is a symlinked agent directory and is discovered.
  const kinds = await Promise.all(entries.map(async entry => {
    try {
      return await direntKindFollowing(absolutePath, entry);
    } catch (error) {
      return refused(safePath.join(absolutePath, entry.name), error);
    }
  }));
  const directories = entries.filter((_, i) => kinds[i] === 'directory');
  const agents = await Promise.all(directories.map(entry =>
    discoverAgentInDirectory(safePath.join(absolutePath, entry.name), refused)
  ));
  return agents.filter((agent): agent is DiscoveredAgent => agent !== null);
}

async function discoverAgentInDirectory(agentDir: string, refused: RefusedPath): Promise<DiscoveredAgent | null> {
  const manifestPath = await findManifest(agentDir, refused);
  if (!manifestPath) {
    return null;
  }

  return parseAgentManifest(manifestPath, agentDir, refused);
}

async function findManifest(dir: string, refused: RefusedPath): Promise<string | null> {
  const candidates = ['agent.yaml', 'agent.yml'];

  for (const candidate of candidates) {
    const manifestPath = safePath.join(dir, candidate);
    try {
      await fs.access(manifestPath);
      return manifestPath;
    } catch (error) {
      // Not this candidate. Anything but an absence is the directory refusing
      // the probe — recorded against the directory, which is what a listing of
      // it refused too, so one locked directory is one gap.
      if (!isPathAbsentError(error)) return refused(dir, error);
    }
  }

  return null;
}

async function parseAgentManifest(
  manifestPath: string,
  agentDir: string,
  refused: RefusedPath,
): Promise<DiscoveredAgent | null> {
  try {
    const content = await fs.readFile(manifestPath, 'utf-8');
    const data = yaml.parse(content) as {
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
  } catch (error) {
    // A manifest that is not YAML is skipped — the documented shape of "not an
    // agent". A manifest that vanished since the probe is the same. A manifest
    // the OS refuses to read is neither.
    if (!(error instanceof yaml.YAMLParseError) && !isPathAbsentError(error)) return refused(manifestPath, error);
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
