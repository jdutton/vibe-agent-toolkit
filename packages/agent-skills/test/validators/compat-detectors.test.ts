import { describe, expect, it } from 'vitest';

import { runCompatDetectors } from '../../src/validators/compat-detectors.js';

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

const SHELL_OBS = 'CAPABILITY_LOCAL_SHELL';
const CLI_OBS = 'CAPABILITY_EXTERNAL_CLI';
const AUTH_OBS = 'CAPABILITY_BROWSER_AUTH';

function obsCodes(observations: ReadonlyArray<{ code: string }>): string[] {
  return observations.map(o => o.code);
}

describe('runCompatDetectors', () => {
  it('returns empty evidence and observations for portable content', () => {
    const content = skill({
      name: 'portable-skill',
      description: 'A skill that does not touch shells, browsers, or external CLIs.',
      body: "# Portable skill\n\nCall the Anthropic API with 'node' or the bundled SDK.",
    });
    const { evidence, observations } = runCompatDetectors(content, 'SKILL.md');
    expect(evidence).toHaveLength(0);
    expect(observations).toHaveLength(0);
  });

  it('produces evidence with stable pattern IDs and locations', () => {
    const content = skill({
      name: 'shell-skill',
      description: 'Requires the Bash tool.',
      extraFrontmatter: 'allowed-tools: [Bash]',
      body: '# Content',
    });
    const { evidence, observations } = runCompatDetectors(content, 'SKILL.md');
    expect(observations).toHaveLength(1);
    expect(observations[0]?.code).toBe(SHELL_OBS);
    for (const e of evidence) {
      expect(e.source).toBe('code');
      expect(e.location.file).toBe('SKILL.md');
      expect(e.matchText.length).toBeGreaterThan(0);
      expect(['high', 'medium', 'low']).toContain(e.confidence);
    }
  });
});

describe('local-shell capability', () => {
  it('emits CAPABILITY_LOCAL_SHELL when allowed-tools frontmatter lists Bash', () => {
    const content = skill({
      name: 'uses-bash',
      description: 'Uses Bash.',
      extraFrontmatter: 'allowed-tools: [Bash, Read]',
      body: 'Body.',
    });
    const { evidence, observations } = runCompatDetectors(content, 'SKILL.md');
    expect(obsCodes(observations)).toContain(SHELL_OBS);
    expect(evidence.some(e => e.patternId === 'ALLOWED_TOOLS_LOCAL_SHELL')).toBe(true);
  });

  it.each(['Edit', 'Write', 'NotebookEdit'])('emits CAPABILITY_LOCAL_SHELL when allowed-tools lists %s', (tool) => {
    const content = skill({
      name: `uses-${tool.toLowerCase()}`,
      extraFrontmatter: `allowed-tools: [${tool}]`,
      body: 'Body.',
    });
    const { observations } = runCompatDetectors(content, 'SKILL.md');
    expect(obsCodes(observations), `expected fire for ${tool}`).toContain(SHELL_OBS);
  });

  it('emits CAPABILITY_LOCAL_SHELL when prose references the Bash tool by name', () => {
    const content = skill({ body: 'Use the Bash tool to run `ls`.' });
    const { evidence, observations } = runCompatDetectors(content, 'SKILL.md');
    expect(obsCodes(observations)).toContain(SHELL_OBS);
    expect(evidence.some(e => e.patternId === 'PROSE_LOCAL_SHELL_TOOL_REFERENCE')).toBe(true);
  });

  it('emits CAPABILITY_LOCAL_SHELL on direct bash invocations in fenced shell code blocks', () => {
    const content = skill({ body: `Run this:\n\n${bashBlock('echo hello')}` });
    const { evidence, observations } = runCompatDetectors(content, 'SKILL.md');
    expect(obsCodes(observations)).toContain(SHELL_OBS);
    expect(evidence.some(e => e.patternId === 'FENCED_SHELL_BLOCK')).toBe(true);
  });

  it('does not emit shell capability for node-only or python-only content', () => {
    const content = skill({
      body: `${codeBlock('javascript', "console.log('hi');")}\nRead files using the Read tool.`,
    });
    const { observations } = runCompatDetectors(content, 'SKILL.md');
    expect(obsCodes(observations)).not.toContain(SHELL_OBS);
  });

  it('rolls multiple shell-family signals into a single CAPABILITY_LOCAL_SHELL observation', () => {
    const content = skill({
      extraFrontmatter: 'allowed-tools: [Bash]',
      body: `Use the Bash tool.\n\n${bashBlock('ls')}`,
    });
    const { observations } = runCompatDetectors(content, 'SKILL.md');
    const shellObs = observations.filter(o => o.code === SHELL_OBS);
    expect(shellObs).toHaveLength(1);
    // Supporting evidence references each contributing pattern
    expect(shellObs[0]?.supportingEvidence).toEqual(
      expect.arrayContaining(['ALLOWED_TOOLS_LOCAL_SHELL', 'PROSE_LOCAL_SHELL_TOOL_REFERENCE', 'FENCED_SHELL_BLOCK']),
    );
  });
});

describe('external-CLI capability', () => {
  it.each([
    ['az', 'az account show'],
    ['aws', 'aws s3 ls'],
    ['gcloud', 'gcloud projects list'],
    ['kubectl', 'kubectl get pods'],
    ['docker', 'docker build .'],
    ['terraform', 'terraform apply'],
    ['gh', 'gh pr create'],
    ['op', 'op item list'],
  ])('emits CAPABILITY_EXTERNAL_CLI for %s invocation in a shell code block', (binary, command) => {
    const content = skill({ description: `uses ${binary}`, body: bashBlock(command) });
    const { observations } = runCompatDetectors(content, 'SKILL.md');
    const cliObs = observations.filter(o => o.code === CLI_OBS);
    expect(cliObs.length, `expected fire for ${binary}`).toBeGreaterThanOrEqual(1);
    expect(cliObs.some(o => (o.payload as { binary: string } | undefined)?.binary === binary)).toBe(true);
  });

  it('does not emit external-CLI for references inside prose (no shell context)', () => {
    const content = skill({ body: "See the Azure docs for the 'az' command syntax." });
    const { observations } = runCompatDetectors(content, 'SKILL.md');
    expect(obsCodes(observations)).not.toContain(CLI_OBS);
  });

  it('does not emit external-CLI for bundled binaries like node/npx', () => {
    const content = skill({ body: bashBlock('node scripts/do-thing.mjs\nnpx tsc') });
    const { observations } = runCompatDetectors(content, 'SKILL.md');
    expect(obsCodes(observations)).not.toContain(CLI_OBS);
  });

  it('rolls multiple invocations of the same binary into a single observation', () => {
    const content = skill({ body: bashBlock('az login\naz account show\naz vm list') });
    const { observations } = runCompatDetectors(content, 'SKILL.md');
    const cliObs = observations.filter(o => o.code === CLI_OBS);
    expect(cliObs).toHaveLength(1);
    expect((cliObs[0]?.payload as { binary: string } | undefined)?.binary).toBe('az');
  });

  it('emits one CAPABILITY_EXTERNAL_CLI observation per distinct binary', () => {
    const content = '```bash\naz login\ngh auth login\n```';
    const { observations } = runCompatDetectors(content, '/test/SKILL.md');
    const cliObs = observations.filter(o => o.code === 'CAPABILITY_EXTERNAL_CLI');
    const binaries = cliObs.map(o => (o.payload as { binary: string }).binary).sort((a, b) => a.localeCompare(b));
    expect(binaries).toEqual(['az', 'gh']);
  });
});

describe('browser-auth capability', () => {
  it('emits CAPABILITY_BROWSER_AUTH on MSAL usage (Python msal import)', () => {
    const content = skill({ body: codeBlock('python', 'from msal import PublicClientApplication') });
    const { observations } = runCompatDetectors(content, 'SKILL.md');
    expect(obsCodes(observations)).toContain(AUTH_OBS);
  });

  it('emits CAPABILITY_BROWSER_AUTH on JS @azure/msal-* imports', () => {
    const content = skill({
      body: codeBlock('javascript', "import { PublicClientApplication } from '@azure/msal-node';"),
    });
    const { observations } = runCompatDetectors(content, 'SKILL.md');
    expect(obsCodes(observations)).toContain(AUTH_OBS);
  });

  it.each([
    ['az login', 'az login'],
    ['gcloud auth login', 'gcloud auth login'],
    ['aws sso login', 'aws sso login'],
  ])('emits CAPABILITY_BROWSER_AUTH on %s in a shell code block', (_name, cmd) => {
    const content = skill({ description: `uses ${_name}`, body: bashBlock(cmd) });
    const { observations } = runCompatDetectors(content, 'SKILL.md');
    expect(obsCodes(observations)).toContain(AUTH_OBS);
  });

  it('emits CAPABILITY_BROWSER_AUTH on webbrowser.open() calls', () => {
    const content = skill({
      body: codeBlock('python', "import webbrowser\nwebbrowser.open('https://login.example.com/oauth')"),
    });
    const { observations } = runCompatDetectors(content, 'SKILL.md');
    expect(obsCodes(observations)).toContain(AUTH_OBS);
  });

  it('does not fire on unrelated OAuth prose or token-based flows', () => {
    const content = skill({ body: 'Use the bearer token from `AZURE_CLIENT_SECRET` for service-principal auth.' });
    const { observations } = runCompatDetectors(content, 'SKILL.md');
    expect(obsCodes(observations)).not.toContain(AUTH_OBS);
  });
});
