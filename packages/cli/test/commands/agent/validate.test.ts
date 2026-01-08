import fs from 'node:fs';
import { join } from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runCliCommand } from '../../test-helpers.js';

describe('agent validate command (integration)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(join(normalizedTmpdir(), 'vat-agent-validate-'));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should validate correct agent manifest', () => {
    const agentDir = join(tempDir, 'valid-agent');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
    fs.mkdirSync(agentDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
    fs.writeFileSync(
      join(agentDir, 'agent.yaml'),
      `metadata:
  name: test-agent
  version: 0.1.0
  description: Test agent
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
`
    );

    const result = runCliCommand('agent', 'validate', agentDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('status: success');
    expect(result.stdout).toContain('test-agent');
    expect(result.stderr).toContain('Agent validation successful');
  });

  it('should show validation errors for invalid manifest', () => {
    const agentDir = join(tempDir, 'invalid-agent');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
    fs.mkdirSync(agentDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- safe: tempDir is from mkdtempSync
    fs.writeFileSync(
      join(agentDir, 'agent.yaml'),
      `metadata:
  name: invalid-agent
spec:
  llm:
    notAValidField: true
`
    );

    const result = runCliCommand('agent', 'validate', agentDir);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status: error');
    expect(result.stderr).toContain('Agent validation failed');
  });
});
