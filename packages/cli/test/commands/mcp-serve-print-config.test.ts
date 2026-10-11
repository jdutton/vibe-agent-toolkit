/**
 * `vat mcp serve` before the gateway starts: `--print-config` publishes the
 * Claude Desktop block ONLY for a collection that resolves, and a collection
 * that does not resolve ends on ERROR with nothing on stdout. The collection
 * resolver, the artifact writer and `process.exit` are doubles; no server runs.
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { serveCommand } from '../../src/commands/mcp/serve.js';

const doubles = vi.hoisted(() => ({ resolveCollection: vi.fn(), writeArtifact: vi.fn() }));
vi.mock('../../src/commands/mcp/collections.js', () => ({ resolveCollection: doubles.resolveCollection }));
vi.mock('../../src/utils/document-writer.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeArtifact: doubles.writeArtifact,
}));

const EXITED = 'process.exit called';

beforeEach(() => {
  doubles.resolveCollection.mockReset();
  doubles.writeArtifact.mockReset();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error(EXITED);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('vat mcp serve --print-config', () => {
  it('publishes a config keyed by the sanitised package name, once the collection resolves', async () => {
    doubles.resolveCollection.mockResolvedValue({ name: 'cats', agents: [] });

    await serveCommand('@vibe-agent-toolkit/vat-example-cat-agents', { printConfig: true });

    expect(doubles.writeArtifact).toHaveBeenCalledWith(
      'claude-desktop-config',
      { mcpServers: { 'vat-vat-example-cat-agents': { command: 'vat', args: ['mcp', 'serve', '@vibe-agent-toolkit/vat-example-cat-agents'] } } },
      'json',
    );
  });

  it('publishes nothing and ends on ERROR for a collection that does not resolve', async () => {
    doubles.resolveCollection.mockRejectedValue(new Error('Cannot find package'));

    await expect(serveCommand('missing-pkg', { printConfig: true, debug: true })).rejects.toThrow(EXITED);

    expect(process.exit).toHaveBeenCalledWith(ExitCode.ERROR);
    expect(doubles.writeArtifact).not.toHaveBeenCalled();
  });
});
