/**
 * Agent Skill builder - converts VAT agents to Agent Skills
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { AGENT_MANIFEST_INVALID_CODE, loadAgentManifest, type LoadedAgentManifest } from '@vibe-agent-toolkit/agent-config';
import {
  applyTreePlan,
  copyTree,
  findProjectRoot,
  type FsBoundary,
  fsBoundary,
  pathPresent,
  planTreeChanges,
  proveTreeReadable,
  readRegularFile,
  safePath,
  type TreeChangeWarning,
  VatError,
  withFsFault,
} from '@vibe-agent-toolkit/utils';

import { asPackagerRefusal } from './packaging-errors.js';
import {
  landedPackageResult,
  packageGeneratedSkillInto,
  type PackagedInto,
  packageOutputChanges,
  packageOwnership,
  stagedPathMapper,
} from './skill-packager.js';

/**
 * The `VatError` code of a build with no output location: no `outputPath` was
 * given and no `package.json` encloses the agent to put the default one in.
 * The invocation's to fix — pass an output path, or build from inside a package.
 */
export const AGENT_PACKAGE_ROOT_MISSING_CODE = 'AGENT_PACKAGE_ROOT_MISSING';

/** How `scripts/` is walked, by the proof and the copy alike: a link is shipped as what it points at, inside `scripts/` only, and every read is the input's. */
const SCRIPTS_LINKS = { links: 'follow-contained', side: 'source' } as const;

/** Runs one write of the build's output under the build's boundary, naming what it was doing. */
type OutputWriter = <T>(action: string, write: () => Promise<T>) => Promise<T>;

export interface BuildOptions {
  /**
   * Path to agent directory or manifest file
   */
  agentPath: string;

  /**
   * Output path for skill bundle
   * If not provided, defaults to <agent-package-root>/dist/vat-bundles/skill
   */
  outputPath?: string;

  /**
   * Build target (skill, langchain, etc.)
   * Used for default output path determination
   */
  target?: string;

  /**
   * Whether to package the generated SKILL.md
   * @default true
   */
  package?: boolean;

  /**
   * Package formats to generate (when package=true)
   * @default ['directory']
   */
  formats?: ('directory' | 'zip' | 'npm' | 'marketplace')[];

  /**
   * Whether `<outputPath>/<agent-name>/` holds a previous build to replace
   * (`--force`). Default `false`: an explicit `outputPath` whose agent directory
   * already holds anything but an empty directory (or a file where an archive a
   * requested format writes beside it goes) is refused (`TREE_DEST_NOT_OWNED`) and
   * left exactly as it was — the one rule of `packageSkill` ({@link packageOwnership}).
   * The default location (no `outputPath`) is VAT's, and is replaced. Either way the
   * build is one tree-change plan: it lands whole or changes nothing. An output that
   * is, or holds, the agent's own source is refused (`TREE_DEST_HOLDS_SOURCE`).
   */
  replaceExistingOutput?: boolean;
}

export interface BuildResult {
  /**
   * Path where skill was written
   */
  outputPath: string;

  /**
   * Agent metadata
   */
  agent: {
    name: string;
    version: string | undefined;
  };

  /**
   * Files created
   */
  files: string[];

  /**
   * Package artifacts (when package=true)
   */
  packageArtifacts?: Record<string, string>;

  /**
   * What the build's plan left beside its output: a previous build, parked by the swap,
   * that the OS would not let VAT remove. The build is complete; each is a warning naming
   * the leftover.
   */
  residue: readonly TreeChangeWarning[];
}

/**
 * Build an Agent Skill from a VAT agent
 *
 * This function:
 * 1. Generates SKILL.md from agent.yml (the "extra pre-step")
 * 2. Optionally packages the SKILL.md using unified packaging logic
 */
export async function buildAgentSkill(options: BuildOptions): Promise<BuildResult> {
  const { agentPath, target = 'skill', package: shouldPackage = true } = options;

  // Load agent manifest
  const manifest = await loadAgentManifest(agentPath);
  if (!manifest.__manifestPath) {
    throw new Error('Loaded manifest missing __manifestPath');
  }
  const agentDir = path.dirname(manifest.__manifestPath);

  // Determine output path
  const baseOutputPath =
    options.outputPath ?? getDefaultOutputPath(manifest.__manifestPath, target);

  // Append agent name to output path
  const outputPath = safePath.join(baseOutputPath, manifest.metadata.name);
  const formats = options.formats ?? ['directory'];

  // Every source is read, or proven readable, BEFORE the output is touched: a
  // refused source must never leave a half-written bundle. Role by PATH: the output
  // is the more specific root when it sits inside the agent.
  const sources = await readAgentSources(manifest, agentDir, fsBoundary({ source: [agentDir], destination: [outputPath] }, { origin: 'content' }));
  const projectRoot = findProjectRoot(agentDir) ?? agentDir;
  const packagedFormats = shouldPackage ? formats : [];

  // ONE plan: the agent directory (written whole into a staged tree beside it) and the
  // archives a format writes beside it. It lands whole, or changes nothing — a previous
  // build is never removed first. Who may lose what is there: `packageOwnership`.
  const holder: { built?: AgentBuilt } = {};
  const plan = await planTreeChanges(packageOutputChanges({
    outputPath,
    skillName: manifest.metadata.name,
    formats: packagedFormats,
    ownership: packageOwnership({ outputPath: options.outputPath, replaceExistingOutput: options.replaceExistingOutput }),
    reads: sources.paths,
    write: async (staged) => {
      holder.built = await writeAgentBuild({ manifest, agentDir, sources, staged, outputPath, formats, shouldPackage });
      return holder.built.packaged?.siblings ?? {};
    },
  }));
  const { warnings } = await applyTreePlan(plan);
  // The plan resolves only once its fill has run, so the build is there.
  if (holder.built === undefined) throw new Error('buildAgentSkill: the plan resolved without writing the build');
  const { staged, files, packaged } = holder.built;
  const landedPath = stagedPathMapper(projectRoot, staged, outputPath);
  const result: BuildResult = {
    outputPath,
    agent: {
      name: manifest.metadata.name,
      version: manifest.metadata.version,
    },
    files: files.map(landedPath),
    residue: warnings,
  };
  if (packaged !== undefined) {
    const landed = landedPackageResult(packaged, { outputPath, projectRoot, formats: packagedFormats, residue: warnings });
    result.files.push(...landed.files.dependencies.map(f => safePath.join(agentDir, f)));
    if (landed.artifacts !== undefined) result.packageArtifacts = landed.artifacts;
  }
  return result;
}

/** What one agent build wrote into its staged tree. */
interface AgentBuilt {
  /** The staged tree it was written into. */
  readonly staged: string;
  /** Every file it generated or copied, on the staged tree. */
  readonly files: string[];
  /** The package of the generated SKILL.md, when packaged. */
  readonly packaged: PackagedInto | undefined;
}

/**
 * Write the agent build into `staged`, a plan's staged tree: the generated SKILL.md and
 * manifest guide, `scripts/`, `LICENSE.txt`, then the package of that SKILL.md, in place.
 * A write is the destination's by path (`staged`); a read of the agent's tree the source's.
 */
async function writeAgentBuild(input: {
  manifest: LoadedAgentManifest;
  agentDir: string;
  sources: AgentSources;
  staged: string;
  /** Where `staged` lands: the run writes it too, so a crawl fault on it is the destination's. */
  outputPath: string;
  formats: NonNullable<BuildOptions['formats']>;
  shouldPackage: boolean;
}): Promise<AgentBuilt> {
  const { manifest, agentDir, sources, staged } = input;
  const boundary = fsBoundary({ source: [agentDir], destination: [staged] }, { origin: 'content' });
  const writingOutput: OutputWriter = (action, write) => boundary.run(action, 'destination', write);

  const files: string[] = [];

  // STEP 1: Generate SKILL.md from agent.yml
  const skillPath = await generateSkillFile(manifest, sources.systemPrompt, staged, writingOutput);
  files.push(skillPath);

  // Generate agent-manifest-guide.md
  const guidePath = await generateManifestGuide(staged, writingOutput);
  files.push(guidePath);

  // Copy scripts/ (supports .js and .py). Its tree was proven above; a file that turns
  // unreadable before the copy reaches it is still the source's — copyTree classifies its
  // own reads — while a write it fails is decided by the boundary, by path.
  if (sources.scriptsPath !== undefined) {
    const scriptsPath = sources.scriptsPath;
    const outputScriptsPath = safePath.join(staged, 'scripts');
    await writingOutput(`copy ${scriptsPath} to ${outputScriptsPath}`, () => copyTree(scriptsPath, outputScriptsPath, SCRIPTS_LINKS));
    files.push(outputScriptsPath);
  }

  if (sources.license !== undefined) {
    const license = sources.license;
    const outputLicensePath = safePath.join(staged, 'LICENSE.txt');
    await writingOutput(`write ${outputLicensePath}`, () => fs.writeFile(outputLicensePath, license));
    files.push(outputLicensePath);
  }

  // STEP 2: Optionally package the generated SKILL.md, in place.
  if (!input.shouldPackage) return { staged, files, packaged: undefined };
  // A source fault inside the packager is the SKILL_PACKAGING_FAILED finding; the agent's own
  // source reads above stay their table refusal. Told apart here, at the packager call.
  const packaged = await packageGeneratedSkillInto(skillPath, staged, { formats: input.formats, basePath: agentDir }, [input.outputPath])
    .catch((error: unknown) => {
      throw asPackagerRefusal(error);
    });
  // NOT `refuseFailedChecks`: the build adds scripts/ and LICENSE.txt that the generated SKILL.md
  // never links, so the packager's PACKAGED_UNREFERENCED_FILE (an error) fires on every agent that
  // has them — refusing on it would refuse those builds outright. Registered in known-defects.md.
  return { staged, files, packaged };
}

/** What the build reads from the agent's own source, all of it before writing anything. */
interface AgentSources {
  /** The system prompt's text. */
  systemPrompt: string;
  /** `scripts/`, proven listable and readable, or `undefined` when absent. */
  scriptsPath: string | undefined;
  /** `LICENSE.txt`'s bytes, or `undefined` when absent. */
  license: Buffer | undefined;
  /** Every source path, for the output check: an output holding one is refused. */
  paths: string[];
}

/**
 * Read the agent's sources. Only ABSENCE skips `scripts/` or `LICENSE.txt`:
 * one that is there but cannot be read fails the build, coded as the source's,
 * rather than shipping a bundle that silently lacks it.
 */
async function readAgentSources(manifest: LoadedAgentManifest, agentDir: string, boundary: FsBoundary): Promise<AgentSources> {
  const { path: systemPromptPath, text: systemPrompt } = await readSystemPrompt(manifest, agentDir);
  const paths = [manifest.__manifestPath ?? agentDir, systemPromptPath];

  const scriptsCandidate = safePath.join(agentDir, 'scripts');
  const scriptsPath = pathPresent(scriptsCandidate, 'follow', 'source', 'probe') ? scriptsCandidate : undefined;
  if (scriptsPath !== undefined) {
    // Proven by the walk the copy below follows, before anything is written.
    await proveTreeReadable(scriptsPath, SCRIPTS_LINKS);
    paths.push(scriptsPath);
  }

  const licensePath = safePath.join(agentDir, 'LICENSE.txt');
  let license: Buffer | undefined;
  if (pathPresent(licensePath, 'follow', 'source', 'probe')) {
    license = await boundary.run(`read ${licensePath}`, 'source', () => readRegularFile(licensePath));
    paths.push(licensePath);
  }
  return { systemPrompt, scriptsPath, license, paths };
}

/**
 * The system prompt the manifest names. A missing `$ref` is the manifest's to
 * fix. The file it names is read as a `source` of origin `config` — the manifest
 * chose the path — so an absent one is the config's mistake and one the OS will
 * not read is the input's, as the refusal table decides.
 */
async function readSystemPrompt(manifest: LoadedAgentManifest, agentDir: string): Promise<{ path: string; text: string }> {
  const systemPromptRef = manifest.spec.prompts?.system?.$ref;
  if (!systemPromptRef) {
    throw new VatError(AGENT_MANIFEST_INVALID_CODE, 'Agent must have a system prompt (spec.prompts.system.$ref)');
  }

  const fullSystemPromptPath = safePath.resolve(agentDir, systemPromptRef);
  const text = await withFsFault(
    { side: 'source', origin: 'config', action: `read the system prompt ${systemPromptRef} (spec.prompts.system.$ref)`, path: fullSystemPromptPath },
    () => readRegularFile(fullSystemPromptPath),
  );
  return { path: fullSystemPromptPath, text: text.toString('utf-8') };
}

/**
 * Generate SKILL.md from agent manifest
 * Following Anthropic best practices: frontmatter + concise content + references
 */
async function generateSkillFile(
  manifest: LoadedAgentManifest,
  systemPrompt: string,
  outputPath: string,
  writingOutput: OutputWriter,
): Promise<string> {
  // Build SKILL.md with frontmatter
  const frontmatter = `---
name: ${manifest.metadata.name}
description: ${manifest.metadata.description ?? 'VAT Agent'}
license: ${manifest.metadata.license ?? 'MIT'}
---

`;

  // Add agent manifest format section with reference to guide
  const manifestSection = `

## Agent Manifest Format

Your output must be a valid VAT agent manifest in YAML format.

**For complete specification, examples, and patterns**: Read \`agent-manifest-guide.md\`

Quick example:
\`\`\`yaml
metadata:
  name: my-agent
  description: What it does

spec:
  llm:
    provider: anthropic
    model: claude-sonnet-5

  prompts:
    system:
      $ref: ./prompts/system.md
\`\`\`
`;

  // Build tools section if tools exist
  let toolsSection = '';
  if (manifest.spec.tools && manifest.spec.tools.length > 0) {
    toolsSection = '\n## Available Tools\n\n';
    for (const tool of manifest.spec.tools) {
      const desc = tool.description ?? 'No description provided';
      toolsSection += `- \`${tool.name}\`: ${desc}\n`;
    }
  }

  // Assemble full content
  const skillContent = frontmatter + systemPrompt + manifestSection + toolsSection;

  // Write SKILL.md
  const skillPath = safePath.join(outputPath, 'SKILL.md');
  await writingOutput(`write ${skillPath}`, () => fs.writeFile(skillPath, skillContent, 'utf-8'));

  return skillPath;
}

/**
 * Generate agent-manifest-guide.md with comprehensive documentation
 */
async function generateManifestGuide(outputPath: string, writingOutput: OutputWriter): Promise<string> {
  const guide = `# VAT Agent Manifest Guide

## Overview

VAT agents use YAML manifests to define their behavior, capabilities, and requirements.
This guide provides the complete specification with examples and best practices.

## Manifest Structure

### Metadata Section

\`\`\`yaml
metadata:
  name: my-agent              # kebab-case identifier (required)
  version: 1.0.0              # semver format (optional - can come from package.json)
  description: What it does   # Human-readable description (optional but recommended)
  author: Your Name           # Author or organization (optional)
  license: MIT                # License identifier (optional)
  tags: [tag1, tag2]          # Tags for categorization (optional)
\`\`\`

### Spec Section

\`\`\`yaml
spec:
  llm:                         # LLM configuration (required)
    provider: anthropic        # anthropic, openai, google
    model: claude-sonnet-5
    temperature: 0.7           # 0.0-2.0 (default varies by provider)
    maxTokens: 16000           # optional
    topP: 0.9                  # optional nucleus sampling

  prompts:                     # Prompt templates (optional)
    system:
      $ref: ./prompts/system.md
    user:                      # optional user prompt template
      $ref: ./prompts/user.md

  interface:                   # I/O schemas (optional but recommended)
    input:
      $ref: ./schemas/input.schema.json
    output:
      $ref: ./schemas/output.schema.json

  tools:                       # Tool definitions (optional)
    - name: tool-name
      type: library            # library, mcp, builtin
      description: What it does
      package: package-name    # for type: library
      function: functionName   # for type: library

  resources:                   # Resource registry (optional)
    my_resource:
      path: ./path/to/resource
      type: prompt             # prompt, schema, documentation, data, template
      template: mustache       # optional: mustache, handlebars, none
      fragment: true           # optional: can be referenced by other resources

  credentials:                 # Credentials requirements (optional)
    agent:
      - name: API_KEY_NAME
        description: What it's for
        required: true
        source: env            # env, vault, config
\`\`\`

## Minimal Example

The simplest possible agent with just the required fields:

\`\`\`yaml
metadata:
  name: simple-greeter
  description: Says hello to users

spec:
  llm:
    provider: anthropic
    model: claude-sonnet-5
  prompts:
    system:
      $ref: ./prompts/system.md
\`\`\`

## Complex Example

A full-featured agent with all optional sections:

\`\`\`yaml
metadata:
  name: pr-security-reviewer
  version: 1.0.0
  description: Reviews pull requests for security vulnerabilities
  author: Security Team
  license: MIT
  tags: [security, code-review, owasp]

spec:
  interface:
    input:
      $ref: ./schemas/input.schema.json
    output:
      $ref: ./schemas/output.schema.json

  llm:
    provider: anthropic
    model: claude-sonnet-5
    temperature: 0.3
    maxTokens: 16000
    alternatives:
      - provider: anthropic
        model: claude-opus-4-8
      - provider: openai
        model: gpt-4o

  prompts:
    system:
      $ref: ./prompts/system.md
    user:
      $ref: ./prompts/user.md

  tools:
    - name: analyze-code
      type: library
      package: @security/static-analyzer
      function: analyzeCode
      description: Static analysis for security issues

    - name: owasp-check
      type: mcp
      server: owasp-tools
      description: Check against OWASP Top 10

  resources:
    system_prompt:
      path: ./prompts/system.md
      type: prompt
    user_prompt:
      path: ./prompts/user.md
      type: template
      template: mustache

  credentials:
    agent:
      - name: GITHUB_TOKEN
        description: GitHub API token for PR access
        required: true
        source: env
\`\`\`

## Common Patterns

### Pattern: Multi-Step Agent with User Prompt Template

Use a user prompt template with mustache/handlebars variables to structure agent input:

\`\`\`yaml
spec:
  prompts:
    system:
      $ref: ./prompts/system.md
    user:
      $ref: ./prompts/user.md  # Contains {{variables}}

  interface:
    input:
      $ref: ./schemas/input.schema.json  # Defines the variables
\`\`\`

### Pattern: Agent with Alternative LLM Models

Specify fallback models for cost optimization or availability:

\`\`\`yaml
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-5
    alternatives:
      - provider: anthropic
        model: claude-haiku-4-5  # Faster/cheaper fallback
      - provider: openai
        model: gpt-4o  # Cross-provider fallback
\`\`\`

### Pattern: Agent with Tool Integration

Integrate external tools via library imports or MCP servers:

\`\`\`yaml
spec:
  tools:
    - name: web-search
      type: mcp
      server: brave-search
      description: Search the web for current information

    - name: calculate
      type: library
      package: @vat/math-tools
      function: calculate
      description: Perform mathematical calculations
\`\`\`

### Pattern: Resource-Rich Agent

Use the resource registry for complex prompt structures:

\`\`\`yaml
spec:
  resources:
    base_prompt:
      path: ./prompts/base.md
      type: prompt
      fragment: true  # Can be included by other resources

    enhanced_prompt:
      path: ./prompts/enhanced.md
      type: prompt
      template: mustache  # Uses {{> base_prompt}} to include fragment

    docs:
      path: ./docs/**/*.md
      type: documentation
\`\`\`

## Anti-Patterns

### ❌ Don't: Inline Prompts in Manifest

\`\`\`yaml
spec:
  prompts:
    system: "You are a helpful assistant..."  # BAD: hard to maintain
\`\`\`

**Why**: Prompts should be in separate files for version control, testing, and reusability.

✅ **Do**: Use \`$ref\` to external files

\`\`\`yaml
spec:
  prompts:
    system:
      $ref: ./prompts/system.md
\`\`\`

### ❌ Don't: Skip Input Schema for Structured Agents

\`\`\`yaml
spec:
  prompts:
    user:
      $ref: ./prompts/user.md  # Uses {{variables}} but no schema
  # BAD: Missing interface.input
\`\`\`

**Why**: Without input schema, validation is impossible and users don't know what fields are required.

✅ **Do**: Define input schema

\`\`\`yaml
spec:
  interface:
    input:
      $ref: ./schemas/input.schema.json
  prompts:
    user:
      $ref: ./prompts/user.md
\`\`\`

### ❌ Don't: Use Generic Model Names

\`\`\`yaml
spec:
  llm:
    model: claude-sonnet  # BAD: which family member?
\`\`\`

**Why**: A bare family name is ambiguous. Pin a specific, current model alias so capabilities and pricing are well-defined.

✅ **Do**: Use a specific model alias

\`\`\`yaml
spec:
  llm:
    model: claude-sonnet-5  # Specific current alias
\`\`\`

### ❌ Don't: Duplicate Information

\`\`\`yaml
spec:
  prompts:
    system:
      $ref: ./prompts/system.md
  resources:
    system_prompt:
      path: ./prompts/system.md  # BAD: duplicates prompts.system
      type: prompt
\`\`\`

**Why**: Information should live in one place. Use resources for complex scenarios only.

✅ **Do**: Use prompts section for simple cases

\`\`\`yaml
spec:
  prompts:
    system:
      $ref: ./prompts/system.md
  # No need for resources entry
\`\`\`

## Field Reference

### Required Fields

- \`metadata.name\`: Agent identifier (kebab-case)
- \`spec.llm.provider\`: LLM provider name
- \`spec.llm.model\`: Model identifier with version

### Recommended Fields

- \`metadata.description\`: Human-readable purpose
- \`metadata.version\`: Semantic version
- \`spec.prompts.system\`: System prompt reference
- \`spec.interface.input\`: Input schema (for structured agents)
- \`spec.interface.output\`: Output schema (for structured agents)

### Optional Fields

- \`metadata.author\`: Author or organization
- \`metadata.license\`: License identifier (e.g., MIT, Apache-2.0)
- \`metadata.tags\`: Array of categorization tags
- \`spec.llm.temperature\`: Sampling temperature (0.0-2.0)
- \`spec.llm.maxTokens\`: Maximum response tokens
- \`spec.llm.topP\`: Nucleus sampling parameter (0.0-1.0)
- \`spec.llm.alternatives\`: Alternative LLM configurations
- \`spec.prompts.user\`: User prompt template
- \`spec.tools\`: Tool definitions array
- \`spec.resources\`: Resource registry object
- \`spec.credentials\`: Credentials requirements
- \`spec.memory\`: Memory configuration (future)
- \`spec.rag\`: RAG configuration (future)
- \`spec.composition\`: Multi-agent composition (future)

## Best Practices

1. **Be Explicit**: Use full model version identifiers
2. **Validate Everything**: Define input/output schemas
3. **Separate Concerns**: Keep prompts in files, not inline
4. **Document Credentials**: List all required environment variables
5. **Version Your Agents**: Use semantic versioning
6. **Tag Appropriately**: Use tags for discovery and organization
7. **Test with Alternatives**: Include fallback models for reliability

## Next Steps

- See \`SKILL.md\` for agent-specific guidance
- Review input/output schemas in \`schemas/\` directory
- Check \`examples/\` for real-world usage patterns
`;

  const guidePath = safePath.join(outputPath, 'agent-manifest-guide.md');
  await writingOutput(`write ${guidePath}`, () => fs.writeFile(guidePath, guide, 'utf-8'));

  return guidePath;
}


/**
 * Get the default output path for agent bundles
 * Returns <agent-package-root>/dist/vat-bundles/<target>
 */
function getDefaultOutputPath(manifestPath: string, target: string): string {
  const agentPackageRoot = findAgentPackageRoot(manifestPath);
  return safePath.join(agentPackageRoot, 'dist', 'vat-bundles', target);
}

/**
 * Find the package root that contains the agent
 * Walks up from the agent directory to find the nearest package.json
 */
function findAgentPackageRoot(manifestPath: string): string {
  let currentDir = path.dirname(safePath.resolve(manifestPath));

  // Walk up until we find a package.json or hit the filesystem root
  while (currentDir !== path.dirname(currentDir)) {
    const packageJsonPath = safePath.join(currentDir, 'package.json');
    if (pathPresent(packageJsonPath, 'follow', 'source', 'probe')) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }

  throw new VatError(
    AGENT_PACKAGE_ROOT_MISSING_CODE,
    `Could not find package.json for agent at ${manifestPath}. ` +
      `Agent must be within an npm package to build bundles, or pass an output path.`
  );
}
