import type { EvidenceRecord } from '@vibe-agent-toolkit/agent-skills';

import { buildEvidence } from './evidence-helpers.js';

/**
 * Scan an MCP config object for server runtime requirements.
 * Each server with a `command` field yields an MCP_SERVER_COMMAND record;
 * each server with a `url` field yields an MCP_SERVER_URL record.
 */
export function scanMcpConfig(config: Record<string, unknown>, filePath: string): EvidenceRecord[] {
  const evidence: EvidenceRecord[] = [];

  const servers = config['mcpServers'];
  if (!servers || typeof servers !== 'object') return evidence;

  for (const [serverName, serverConfig] of Object.entries(servers as Record<string, unknown>)) {
    if (!serverConfig || typeof serverConfig !== 'object') continue;
    const sc = serverConfig as Record<string, unknown>;

    const command = sc['command'];
    if (typeof command === 'string') {
      evidence.push(
        buildEvidence(
          'MCP_SERVER_COMMAND',
          filePath,
          `MCP server "${serverName}" command: ${command}`,
        ),
      );
    }

    const url = sc['url'];
    if (typeof url === 'string') {
      evidence.push(
        buildEvidence(
          'MCP_SERVER_URL',
          filePath,
          `MCP server "${serverName}" url: ${url}`,
        ),
      );
    }
  }

  return evidence;
}
