import { describe, expect, it } from 'vitest';

import {
  detectInterpreter,
  extractMcpCommandFromMatchText,
} from '../../src/evidence/interpreter-detection.js';

describe('detectInterpreter', () => {
  it('normalizes python3 to python3', () => {
    expect(detectInterpreter('python3')).toBe('python3');
  });

  it('normalizes bare "python" to python3', () => {
    expect(detectInterpreter('python')).toBe('python3');
  });

  it('normalizes python2 to python3 (interpreter-as-CLI signal)', () => {
    expect(detectInterpreter('python2')).toBe('python3');
  });

  it('normalizes versioned python3.11 to python3', () => {
    expect(detectInterpreter('python3.11')).toBe('python3');
  });

  it('normalizes absolute path /usr/bin/python3 to python3', () => {
    expect(detectInterpreter('/usr/bin/python3')).toBe('python3');
  });

  it('normalizes homebrew path to python3', () => {
    expect(detectInterpreter('/opt/homebrew/bin/python3')).toBe('python3');
  });

  it('normalizes node to node', () => {
    expect(detectInterpreter('node')).toBe('node');
  });

  it('normalizes absolute node path to node', () => {
    expect(detectInterpreter('/usr/local/bin/node')).toBe('node');
  });

  it('normalizes nodejs alias to node', () => {
    expect(detectInterpreter('nodejs')).toBe('node');
  });

  it('returns undefined for non-interpreter commands', () => {
    expect(detectInterpreter('./scripts/my-server.sh')).toBeUndefined();
    expect(detectInterpreter('npx')).toBeUndefined();
    expect(detectInterpreter('uv')).toBeUndefined();
    expect(detectInterpreter('bun')).toBeUndefined();
    expect(detectInterpreter('deno')).toBeUndefined();
  });

  it('returns undefined for empty/whitespace input', () => {
    expect(detectInterpreter('')).toBeUndefined();
    expect(detectInterpreter('   ')).toBeUndefined();
  });

  it('does not match substring-embedded interpreter names', () => {
    // Bespoke binary happens to contain "python" — should NOT match.
    expect(detectInterpreter('my-python-wrapper')).toBeUndefined();
  });
});

describe('extractMcpCommandFromMatchText', () => {
  it('extracts the command from mcp-config-scanner matchText', () => {
    const matchText = 'MCP server "weather" command: python3';
    expect(extractMcpCommandFromMatchText(matchText)).toBe('python3');
  });

  it('extracts commands with path segments', () => {
    const matchText = 'MCP server "x" command: /usr/bin/python3';
    expect(extractMcpCommandFromMatchText(matchText)).toBe('/usr/bin/python3');
  });

  it('returns undefined for matchText without a command segment', () => {
    expect(extractMcpCommandFromMatchText('MCP server "x" url: https://example.com')).toBeUndefined();
    expect(extractMcpCommandFromMatchText('unrelated text')).toBeUndefined();
  });
});
