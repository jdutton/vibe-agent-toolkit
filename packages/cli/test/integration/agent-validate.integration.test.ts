import fs from 'node:fs';


import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { AGENT_VALIDATE_REPORT_SCHEMA } from '../../src/commands/agent/validate-schema.js';
import { executeCli } from '../system/test-helpers/cli-runner.js';
import { binPath } from '../test-helpers.js';

describe('agent validate command (integration)', () => {
  let tempDir: string;

  /**
   * Run from INSIDE the fixture, which is its own project root. Every location
   * in the document is relative to the working directory, and the OS temp dir
   * can sit on another drive than the checkout — on the Windows runner it is
   * `C:` against a `D:` workspace — where no relative path exists at all.
   */
  const runAgentValidate = (agentDir: string): ReturnType<typeof executeCli> =>
    executeCli(binPath, ['agent', 'validate', agentDir], { cwd: tempDir });

  beforeAll(() => {
    tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-agent-validate-'));
    fs.mkdirSync(safePath.join(tempDir, '.git'));
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

    const result = runAgentValidate(agentDir);
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

    const result = runAgentValidate(agentDir);
    const document = AGENT_VALIDATE_REPORT_SCHEMA.parse(yaml.parse(result.stdout));

    expect(result.status).toBe(1);
    expect(document.status).toBe('findings');
    expect(document.examined).toBe(1);
    expect(new Set(document.findings.map((finding) => finding.code))).toEqual(new Set(['AGENT_MANIFEST_INVALID']));
    expect(new Set(document.findings.map((finding) => finding.location))).toEqual(new Set(['invalid-agent/agent.yaml']));
    expect(document.data.manifest.name).toBeNull();
    expect(result.stderr).toContain('Agent validation failed');
  });

  it('refuses a manifest that is not YAML as INPUT_UNREADABLE, exit 2', () => {
    const agentDir = safePath.join(tempDir, 'not-yaml-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(safePath.join(agentDir, 'agent.yaml'), 'invalid: yaml: [[[{');

    const result = runAgentValidate(agentDir);
    const document = AGENT_VALIDATE_REPORT_SCHEMA.parse(yaml.parse(result.stdout));

    expect(result.status).toBe(2);
    expect(document.status).toBe('error');
    expect(document.status === 'error' ? document.error.code : undefined).toBe('INPUT_UNREADABLE');
  });
});
