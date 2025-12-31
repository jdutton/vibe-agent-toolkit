import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(__dirname, '../../../dist/bin.js');

describe('agent validate command (integration)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(join(os.tmpdir(), 'vat-agent-validate-'));
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
      `apiVersion: vat.dev/v1
kind: Agent
metadata:
  name: test-agent
  version: 0.1.0
  description: Test agent
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
`
    );

    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
    const result = spawnSync('node', [binPath, 'agent', 'validate', agentDir], {
      encoding: 'utf-8',
    });

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
      `apiVersion: vat.dev/v1
kind: Agent
metadata:
  name: invalid-agent
spec:
  llm:
    notAValidField: true
`
    );

    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
    const result = spawnSync('node', [binPath, 'agent', 'validate', agentDir], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('status: error');
    expect(result.stderr).toContain('Agent validation failed');
  });
});
