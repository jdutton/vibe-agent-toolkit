import { describe, expect, it } from 'vitest';

import { detectBrowserAuth, detectExternalCLI, detectLocalShell, runCompatDetectors } from '../../src/validators/compat-detectors.js';

describe('runCompatDetectors', () => {
  it('returns an empty array for portable content with no compat signals', () => {
    const content = [
      '---',
      'name: portable-skill',
      'description: A skill that does not touch shells, browsers, or external CLIs.',
      '---',
      '',
      '# Portable skill',
      '',
      "Call the Anthropic API with 'node' or the bundled SDK.",
    ].join('\n');
    const issues = runCompatDetectors(content, 'SKILL.md');
    expect(issues).toHaveLength(0);
  });

  it('attaches stable ValidationIssue shape with reference anchor', () => {
    // Minimal fixture that triggers COMPAT_REQUIRES_LOCAL_SHELL via allowed-tools;
    // detection itself is covered in per-code tests (Task 4).
    const content = [
      '---',
      'name: shell-skill',
      'description: Requires the Bash tool.',
      'allowed-tools: [Bash]',
      '---',
      '',
      '# Content',
    ].join('\n');
    const issues = runCompatDetectors(content, 'SKILL.md');
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.severity).toBe('warning');
      expect(issue.code).toMatch(/^COMPAT_/);
      expect(issue.location).toBe('SKILL.md');
      expect(issue.reference).toMatch(/^#compat_/);
      expect(issue.fix?.length ?? 0).toBeGreaterThan(10);
      expect(issue.message.length).toBeGreaterThan(10);
    }
  });
});

describe('detectLocalShell', () => {
  const DESC_Y = 'description: y';

  it('fires when allowed-tools frontmatter lists Bash', () => {
    const content = [
      '---',
      'name: uses-bash',
      'description: Uses Bash.',
      'allowed-tools: [Bash, Read]',
      '---',
      '',
      'Body.',
    ].join('\n');
    const issues = detectLocalShell(content, 'SKILL.md');
    expect(issues.some(i => i.code === 'COMPAT_REQUIRES_LOCAL_SHELL')).toBe(true);
  });

  it.each(['Edit', 'Write', 'NotebookEdit'])('fires when allowed-tools frontmatter lists %s', (tool) => {
    const content = [
      '---',
      `name: uses-${tool.toLowerCase()}`,
      'description: description',
      `allowed-tools: [${tool}]`,
      '---',
      'Body.',
    ].join('\n');
    const issues = detectLocalShell(content, 'SKILL.md');
    expect(issues.some(i => i.code === 'COMPAT_REQUIRES_LOCAL_SHELL'), `expected fire for ${tool}`).toBe(true);
  });

  it('fires when prose references the Bash tool by name', () => {
    const content = [
      '---',
      'name: x',
      DESC_Y,
      '---',
      '',
      'Use the Bash tool to run `ls`.',
    ].join('\n');
    const issues = detectLocalShell(content, 'SKILL.md');
    expect(issues.some(i => i.code === 'COMPAT_REQUIRES_LOCAL_SHELL')).toBe(true);
  });

  it('fires on direct bash/sh invocations in fenced shell code blocks', () => {
    const content = [
      '---',
      'name: x',
      DESC_Y,
      '---',
      '',
      'Run this:',
      '',
      '```bash',
      'echo hello',
      '```',
      '',
    ].join('\n');
    const issues = detectLocalShell(content, 'SKILL.md');
    expect(issues.some(i => i.code === 'COMPAT_REQUIRES_LOCAL_SHELL')).toBe(true);
  });

  it('does not fire for node-only or python-only content', () => {
    const content = [
      '---',
      'name: x',
      DESC_Y,
      '---',
      '',
      '```javascript',
      "console.log('hi');",
      '```',
      '',
      'Read files using the Read tool.',
    ].join('\n');
    const issues = detectLocalShell(content, 'SKILL.md');
    expect(issues).toHaveLength(0);
  });

  it('deduplicates: multiple signals produce one issue per (code, location)', () => {
    const content = [
      '---',
      'name: x',
      DESC_Y,
      'allowed-tools: [Bash]',
      '---',
      '',
      'Use the Bash tool.',
      '',
      '```bash',
      'ls',
      '```',
      '',
    ].join('\n');
    const issues = detectLocalShell(content, 'SKILL.md');
    expect(issues.filter(i => i.code === 'COMPAT_REQUIRES_LOCAL_SHELL')).toHaveLength(1);
  });
});

describe('detectExternalCLI', () => {
  const DESC_PROSE = 'description: prose-only';
  const DESC_BUNDLED = 'description: bundled-only';
  const DESC_MULTI_AZ = 'description: multi-az';

  it.each([
    ['az', 'az account show'],
    ['aws', 'aws s3 ls'],
    ['gcloud', 'gcloud projects list'],
    ['kubectl', 'kubectl get pods'],
    ['docker', 'docker build .'],
    ['terraform', 'terraform apply'],
    ['gh', 'gh pr create'],
    ['op', 'op item list'],
  ])('fires for %s invocation in a shell code block', (binary, command) => {
    const content = [
      '---',
      'name: x',
      `description: uses ${binary}`,
      '---',
      '',
      '```bash',
      command,
      '```',
      '',
    ].join('\n');
    const issues = detectExternalCLI(content, 'SKILL.md');
    expect(issues.some(i => i.code === 'COMPAT_REQUIRES_EXTERNAL_CLI'), `expected fire for ${binary}`).toBe(true);
  });

  it('does not fire on references inside prose (no shell context)', () => {
    const content = [
      '---',
      'name: x',
      DESC_PROSE,
      '---',
      '',
      "See the Azure docs for the 'az' command syntax.",
    ].join('\n');
    const issues = detectExternalCLI(content, 'SKILL.md');
    expect(issues).toHaveLength(0);
  });

  it('does not fire on bundled binaries like node/npx', () => {
    const content = [
      '---',
      'name: x',
      DESC_BUNDLED,
      '---',
      '',
      '```bash',
      'node scripts/do-thing.mjs',
      'npx tsc',
      '```',
      '',
    ].join('\n');
    const issues = detectExternalCLI(content, 'SKILL.md');
    expect(issues).toHaveLength(0);
  });

  it('deduplicates multiple invocations of the same binary', () => {
    const content = [
      '---',
      'name: x',
      DESC_MULTI_AZ,
      '---',
      '',
      '```bash',
      'az login',
      'az account show',
      'az vm list',
      '```',
      '',
    ].join('\n');
    const issues = detectExternalCLI(content, 'SKILL.md');
    expect(issues.filter(i => i.code === 'COMPAT_REQUIRES_EXTERNAL_CLI')).toHaveLength(1);
  });
});

describe('detectBrowserAuth', () => {
  const NAME_X = 'name: x';
  const DESC_MSAL_PY = 'description: msal-python';
  const DESC_MSAL_JS = 'description: msal-js';
  const DESC_WEBBROWSER = 'description: webbrowser-open';
  const DESC_SERVICE_PRINCIPAL = 'description: service-principal';

  it('fires on MSAL usage (Python msal import)', () => {
    const content = [
      '---',
      NAME_X,
      DESC_MSAL_PY,
      '---',
      '',
      '```python',
      'from msal import PublicClientApplication',
      '```',
      '',
    ].join('\n');
    expect(detectBrowserAuth(content, 'SKILL.md').some(i => i.code === 'COMPAT_REQUIRES_BROWSER_AUTH')).toBe(true);
  });

  it('fires on JS @azure/msal-* imports', () => {
    const content = [
      '---',
      NAME_X,
      DESC_MSAL_JS,
      '---',
      '',
      '```javascript',
      "import { PublicClientApplication } from '@azure/msal-node';",
      '```',
      '',
    ].join('\n');
    expect(detectBrowserAuth(content, 'SKILL.md').some(i => i.code === 'COMPAT_REQUIRES_BROWSER_AUTH')).toBe(true);
  });

  it.each([
    ['az login', 'az login'],
    ['gcloud auth login', 'gcloud auth login'],
    ['aws sso login', 'aws sso login'],
  ])('fires on %s in a shell code block', (_name, cmd) => {
    const content = [
      '---',
      NAME_X,
      `description: uses ${_name}`,
      '---',
      '',
      '```bash',
      cmd,
      '```',
      '',
    ].join('\n');
    expect(detectBrowserAuth(content, 'SKILL.md').some(i => i.code === 'COMPAT_REQUIRES_BROWSER_AUTH')).toBe(true);
  });

  it('fires on webbrowser.open() calls', () => {
    const content = [
      '---',
      NAME_X,
      DESC_WEBBROWSER,
      '---',
      '',
      '```python',
      'import webbrowser',
      "webbrowser.open('https://login.example.com/oauth')",
      '```',
      '',
    ].join('\n');
    expect(detectBrowserAuth(content, 'SKILL.md').some(i => i.code === 'COMPAT_REQUIRES_BROWSER_AUTH')).toBe(true);
  });

  it('does not fire on unrelated OAuth prose or token-based flows', () => {
    const content = [
      '---',
      NAME_X,
      DESC_SERVICE_PRINCIPAL,
      '---',
      '',
      'Use the bearer token from `AZURE_CLIENT_SECRET` for service-principal auth.',
    ].join('\n');
    expect(detectBrowserAuth(content, 'SKILL.md')).toHaveLength(0);
  });
});
