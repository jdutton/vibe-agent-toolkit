import { describe, expect, it } from 'vitest';

import { detectBrowserAuth, detectExternalCLI, detectLocalShell, runCompatDetectors } from '../../src/validators/compat-detectors.js';

/** Build a minimal SKILL.md content string from frontmatter fields and a body. */
function skill(opts: {
  name?: string;
  description?: string;
  extraFrontmatter?: string;
  body: string;
}): string {
  const lines = ['---', `name: ${opts.name ?? 'x'}`, `description: ${opts.description ?? 'y'}`];
  if (opts.extraFrontmatter !== undefined) {
    lines.push(opts.extraFrontmatter);
  }
  lines.push('---', '', opts.body);
  return lines.join('\n');
}

/** Wrap a command in a fenced bash code block. */
function bashBlock(command: string): string {
  return `\`\`\`bash\n${command}\n\`\`\`\n`;
}

/** Wrap code in a fenced code block with the given language. */
function codeBlock(lang: string, code: string): string {
  return `\`\`\`${lang}\n${code}\n\`\`\`\n`;
}

const SHELL_CODE = 'COMPAT_REQUIRES_LOCAL_SHELL';
const CLI_CODE = 'COMPAT_REQUIRES_EXTERNAL_CLI';
const AUTH_CODE = 'COMPAT_REQUIRES_BROWSER_AUTH';

/** Check if any issue has the given code. */
function hasCode(issues: Array<{ code: string }>, code: string): boolean {
  return issues.some(i => i.code === code);
}

describe('runCompatDetectors', () => {
  it('returns an empty array for portable content with no compat signals', () => {
    const content = skill({
      name: 'portable-skill',
      description: 'A skill that does not touch shells, browsers, or external CLIs.',
      body: "# Portable skill\n\nCall the Anthropic API with 'node' or the bundled SDK.",
    });
    expect(runCompatDetectors(content, 'SKILL.md')).toHaveLength(0);
  });

  it('attaches stable ValidationIssue shape with reference anchor', () => {
    const content = skill({
      name: 'shell-skill',
      description: 'Requires the Bash tool.',
      extraFrontmatter: 'allowed-tools: [Bash]',
      body: '# Content',
    });
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
  it('fires when allowed-tools frontmatter lists Bash', () => {
    const content = skill({
      name: 'uses-bash',
      description: 'Uses Bash.',
      extraFrontmatter: 'allowed-tools: [Bash, Read]',
      body: 'Body.',
    });
    expect(hasCode(detectLocalShell(content, 'SKILL.md'), SHELL_CODE)).toBe(true);
  });

  it.each(['Edit', 'Write', 'NotebookEdit'])('fires when allowed-tools frontmatter lists %s', (tool) => {
    const content = skill({
      name: `uses-${tool.toLowerCase()}`,
      extraFrontmatter: `allowed-tools: [${tool}]`,
      body: 'Body.',
    });
    expect(hasCode(detectLocalShell(content, 'SKILL.md'), SHELL_CODE), `expected fire for ${tool}`).toBe(true);
  });

  it('fires when prose references the Bash tool by name', () => {
    const content = skill({ body: 'Use the Bash tool to run `ls`.' });
    expect(hasCode(detectLocalShell(content, 'SKILL.md'), SHELL_CODE)).toBe(true);
  });

  it('fires on direct bash/sh invocations in fenced shell code blocks', () => {
    const content = skill({ body: `Run this:\n\n${bashBlock('echo hello')}` });
    expect(hasCode(detectLocalShell(content, 'SKILL.md'), SHELL_CODE)).toBe(true);
  });

  it('does not fire for node-only or python-only content', () => {
    const content = skill({
      body: `${codeBlock('javascript', "console.log('hi');")}\nRead files using the Read tool.`,
    });
    expect(detectLocalShell(content, 'SKILL.md')).toHaveLength(0);
  });

  it('deduplicates: multiple signals produce one issue per (code, location)', () => {
    const content = skill({
      extraFrontmatter: 'allowed-tools: [Bash]',
      body: `Use the Bash tool.\n\n${bashBlock('ls')}`,
    });
    expect(detectLocalShell(content, 'SKILL.md').filter(i => i.code === SHELL_CODE)).toHaveLength(1);
  });
});

describe('detectExternalCLI', () => {
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
    const content = skill({ description: `uses ${binary}`, body: bashBlock(command) });
    expect(hasCode(detectExternalCLI(content, 'SKILL.md'), CLI_CODE), `expected fire for ${binary}`).toBe(true);
  });

  it('does not fire on references inside prose (no shell context)', () => {
    const content = skill({ body: "See the Azure docs for the 'az' command syntax." });
    expect(detectExternalCLI(content, 'SKILL.md')).toHaveLength(0);
  });

  it('does not fire on bundled binaries like node/npx', () => {
    const content = skill({ body: bashBlock('node scripts/do-thing.mjs\nnpx tsc') });
    expect(detectExternalCLI(content, 'SKILL.md')).toHaveLength(0);
  });

  it('deduplicates multiple invocations of the same binary', () => {
    const content = skill({ body: bashBlock('az login\naz account show\naz vm list') });
    expect(detectExternalCLI(content, 'SKILL.md').filter(i => i.code === CLI_CODE)).toHaveLength(1);
  });
});

describe('detectBrowserAuth', () => {
  it('fires on MSAL usage (Python msal import)', () => {
    const content = skill({ body: codeBlock('python', 'from msal import PublicClientApplication') });
    expect(hasCode(detectBrowserAuth(content, 'SKILL.md'), AUTH_CODE)).toBe(true);
  });

  it('fires on JS @azure/msal-* imports', () => {
    const content = skill({
      body: codeBlock('javascript', "import { PublicClientApplication } from '@azure/msal-node';"),
    });
    expect(hasCode(detectBrowserAuth(content, 'SKILL.md'), AUTH_CODE)).toBe(true);
  });

  it.each([
    ['az login', 'az login'],
    ['gcloud auth login', 'gcloud auth login'],
    ['aws sso login', 'aws sso login'],
  ])('fires on %s in a shell code block', (_name, cmd) => {
    const content = skill({ description: `uses ${_name}`, body: bashBlock(cmd) });
    expect(hasCode(detectBrowserAuth(content, 'SKILL.md'), AUTH_CODE)).toBe(true);
  });

  it('fires on webbrowser.open() calls', () => {
    const content = skill({
      body: codeBlock('python', "import webbrowser\nwebbrowser.open('https://login.example.com/oauth')"),
    });
    expect(hasCode(detectBrowserAuth(content, 'SKILL.md'), AUTH_CODE)).toBe(true);
  });

  it('does not fire on unrelated OAuth prose or token-based flows', () => {
    const content = skill({ body: 'Use the bearer token from `AZURE_CLIENT_SECRET` for service-principal auth.' });
    expect(detectBrowserAuth(content, 'SKILL.md')).toHaveLength(0);
  });
});
