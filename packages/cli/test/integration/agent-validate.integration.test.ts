import fs from 'node:fs';


import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { AGENT_VALIDATE_REPORT_SCHEMA } from '../../src/commands/agent/validate-schema.js';
import { runCliCommand } from '../test-helpers.js';

describe('agent validate command (integration)', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-agent-validate-'));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should validate correct agent manifest', () => {
    const agentDir = safePath.join(tempDir, 'valid-agent');
    fs.mkdirSync(agentDir);
    fs.writeFileSync(
      safePath.join(agentDir, 'agent.yaml'),
      `metadata:
  name: test-agent
  version: 0.1.0
  description: Test agent
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-5
`
    );

    const result = runCliCommand('agent', 'validate', agentDir);
    const document = AGENT_VALIDATE_REPORT_SCHEMA.parse(yaml.parse(result.stdout));

    expect(result.status).toBe(0);
    expect(document.status).toBe('ok');
    expect(document.examined).toBe(1);
    expect(document.data.manifest).toEqual({
      name: 'test-agent',
      version: '0.1.0',
      path: safePath.relative(document.data.root, safePath.join(agentDir, 'agent.yaml')),
    });
    expect(result.stderr).toContain('Agent validation successful');
  });

  it('publishes each schema violation of a manifest it read as a finding at the manifest, exit 1', () => {
    const agentDir = safePath.join(tempDir, 'invalid-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      safePath.join(agentDir, 'agent.yaml'),
      `metadata:
  name: invalid-agent
spec:
  llm:
    notAValidField: true
`
    );

    const result = runCliCommand('agent', 'validate', agentDir);
    const document = AGENT_VALIDATE_REPORT_SCHEMA.parse(yaml.parse(result.stdout));

    expect(result.status).toBe(1);
    expect(document.status).toBe('findings');
    expect(document.examined).toBe(1);
    expect(new Set(document.findings.map((finding) => finding.code))).toEqual(new Set(['AGENT_MANIFEST_INVALID']));
    expect(document.data.manifest.name).toBeNull();
    expect(result.stderr).toContain('Agent validation failed');
  });

  it('refuses a manifest that is not YAML as INPUT_UNREADABLE, exit 2', () => {
    const agentDir = safePath.join(tempDir, 'not-yaml-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(safePath.join(agentDir, 'agent.yaml'), 'invalid: yaml: [[[{');

    const result = runCliCommand('agent', 'validate', agentDir);
    const document = AGENT_VALIDATE_REPORT_SCHEMA.parse(yaml.parse(result.stdout));

    expect(result.status).toBe(2);
    expect(document.status).toBe('error');
    expect(document.status === 'error' ? document.error.code : undefined).toBe('INPUT_UNREADABLE');
  });
});
