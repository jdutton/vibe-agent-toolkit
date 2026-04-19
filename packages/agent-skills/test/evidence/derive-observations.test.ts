import { describe, expect, it } from 'vitest';

import { deriveObservationsFromEvidence } from '../../src/evidence/derive-observations.js';
import type { EvidenceRecord } from '../../src/evidence/types.js';

const PLUGIN_LOCAL_SHELL_PATTERN_IDS: ReadonlySet<string> = new Set([
  'FENCED_SHELL_BLOCK',
  'ALLOWED_TOOLS_LOCAL_SHELL',
  'PROSE_LOCAL_SHELL_TOOL_REFERENCE',
  'HOOK_COMMAND_INVOKES_BINARY',
  'SCRIPT_FILE_PYTHON',
  'SCRIPT_FILE_SHELL',
  'SCRIPT_FILE_NODE',
]);

function mcpEvidence(command: string): EvidenceRecord {
  return {
    source: 'code',
    patternId: 'MCP_SERVER_COMMAND',
    location: { file: '.mcp.json' },
    matchText: `MCP server "test" command: ${command}`,
    confidence: 'high',
  };
}

function deriveForPlugin(records: EvidenceRecord[]) {
  return deriveObservationsFromEvidence(records, {
    localShellPatternIds: PLUGIN_LOCAL_SHELL_PATTERN_IDS,
    subject: 'plugin',
  });
}

function expectSingleExternalCli(commands: string[], expectedBinary: string): void {
  const result = deriveForPlugin(commands.map(mcpEvidence));
  const externalCli = result.filter(o => o.code === 'CAPABILITY_EXTERNAL_CLI');
  expect(externalCli).toHaveLength(1);
  expect(externalCli[0]?.payload).toEqual({ binary: expectedBinary });
}

describe('deriveObservationsFromEvidence — MCP interpreter rollup', () => {
  it('emits CAPABILITY_EXTERNAL_CLI(python3) for command: python3', () => {
    const result = deriveForPlugin([mcpEvidence('python3')]);
    const externalCli = result.filter(o => o.code === 'CAPABILITY_EXTERNAL_CLI');
    expect(externalCli).toHaveLength(1);
    expect(externalCli[0]?.payload).toEqual({ binary: 'python3' });
    expect(externalCli[0]?.supportingEvidence).toEqual(['MCP_SERVER_COMMAND']);
  });

  it('emits CAPABILITY_EXTERNAL_CLI(python3) for absolute path command', () => {
    expectSingleExternalCli(['/usr/bin/python3'], 'python3');
  });

  it('emits CAPABILITY_EXTERNAL_CLI(python3) for versioned python3.11', () => {
    expectSingleExternalCli(['python3.11'], 'python3');
  });

  it('emits CAPABILITY_EXTERNAL_CLI(node) for command: node', () => {
    expectSingleExternalCli(['node'], 'node');
  });

  it('emits no CAPABILITY_EXTERNAL_CLI for bespoke commands', () => {
    const result = deriveForPlugin([mcpEvidence('./my-server.sh')]);
    expect(result.some(o => o.code === 'CAPABILITY_EXTERNAL_CLI')).toBe(false);
  });

  it('emits no CAPABILITY_EXTERNAL_CLI when there is no MCP_SERVER_COMMAND evidence', () => {
    const result = deriveForPlugin([]);
    expect(result).toEqual([]);
  });

  it('deduplicates multiple python servers into one observation', () => {
    const result = deriveForPlugin([
      mcpEvidence('python3'),
      mcpEvidence('/usr/bin/python3'),
    ]);
    const externalCli = result.filter(o => o.code === 'CAPABILITY_EXTERNAL_CLI');
    expect(externalCli).toHaveLength(1);
    expect(externalCli[0]?.payload).toEqual({ binary: 'python3' });
    // Dedup by patternId, so supportingEvidence stays ['MCP_SERVER_COMMAND'].
    expect(externalCli[0]?.supportingEvidence).toEqual(['MCP_SERVER_COMMAND']);
  });

  it('emits separate observations for python3 and node when both are present', () => {
    const result = deriveForPlugin([
      mcpEvidence('python3'),
      mcpEvidence('node'),
    ]);
    const externalCli = result.filter(o => o.code === 'CAPABILITY_EXTERNAL_CLI');
    expect(externalCli).toHaveLength(2);
    // Sorted alphabetically by binary.
    expect(externalCli[0]?.payload).toEqual({ binary: 'node' });
    expect(externalCli[1]?.payload).toEqual({ binary: 'python3' });
  });
});
