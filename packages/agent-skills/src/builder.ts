/**
 * Agent Skill builder - converts VAT agents to Agent Skills
 */

import { statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { AGENT_MANIFEST_INVALID_CODE, loadAgentManifest, type LoadedAgentManifest } from '@vibe-agent-toolkit/agent-config';
import { copyDirectory, isFilesystemAccessError, isPathAbsentError, safePath, toForwardSlash, VatError } from '@vibe-agent-toolkit/utils';

import { proveReadable, withFsAttribution } from './fs-attribution.js';
import { packageSkill } from './skill-packager.js';

/**
 * The `VatError` code of a build with no output location: no `outputPath` was
 * given and no `package.json` encloses the agent to put the default one in.
 * The invocation's to fix — pass an output path, or build from inside a package.
 */
export const AGENT_PACKAGE_ROOT_MISSING_CODE = 'AGENT_PACKAGE_ROOT_MISSING';

/**
 * The `VatError` code of a file of the agent's own source — its system prompt,
 * `scripts/`, `LICENSE.txt`, the `package.json` above it — that is there and
 * the OS will not read or stat (EACCES, EISDIR, ELOOP). Only an absence is
 * "not there"; this is the input's refusal, never a VAT defect and never a skip.
 */
export const AGENT_SOURCE_UNREADABLE_CODE = 'AGENT_SOURCE_UNREADABLE';

/** The refusal for an agent source path the OS would not read. */
function sourceUnreadable(target: string, error: unknown): VatError {
  const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
  return new VatError(AGENT_SOURCE_UNREADABLE_CODE, `Agent source cannot be read (${code}): ${target}`, { cause: error });
}

/**
 * Do `read`, which touches only the agent's own source at `target`; a
 * filesystem refusal is {@link sourceUnreadable}, naming the path the OS named
 * when it names one. A copy is never passed here whole — its errno does not say
 * which side refused — so each copy reads its source through this first.
 */
async function readingSource<T>(target: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isFilesystemAccessError(error)) throw error;
    throw sourceUnreadable((error as NodeJS.ErrnoException).path ?? target, error);
  }
}

/**
 * Do `write`, which touches only the build's OUTPUT at `target`. A filesystem
 * refusal — an unwritable or read-only output directory, a full disk, a file in
 * the way of `--output` — is the run not finishing (`packagingOutputError`), the
 * same code the packager gives its own output: never a defect in VAT, and never
 * a finding against the agent.
 */
function writingOutput<T>(target: string, write: () => Promise<T>, action = 'written'): Promise<T> {
  return withFsAttribution(`agent build output ${toForwardSlash(target)}`, 'output', write, action);
}

/**
 * Refuse a source tree the OS will not let the build list or read, before any
 * of it is copied. Only a regular file is opened: a named pipe, socket or device
 * (or a link to one) has no bytes to ship, and opening a pipe blocks until a
 * writer appears, so it is refused as the source's without being opened.
 */
async function requireReadableTree(dir: string): Promise<void> {
  const entries = await readingSource(dir, () => fs.readdir(dir, { recursive: true, withFileTypes: true }));
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const file = safePath.join(entry.parentPath, entry.name);
    const target = entry.isSymbolicLink() ? await readingSource(file, () => fs.stat(file)) : entry;
    if (target.isDirectory()) continue;
    if (!target.isFile()) {
      throw new VatError(AGENT_SOURCE_UNREADABLE_CODE, `Agent source cannot be read (not a regular file: a named pipe, socket or device): ${file}`);
    }
    await readingSource(file, () => proveReadable(file));
  }
}

/**
 * Whether `target` resolves to something (`stat`, so a dangling link is
 * absent). Anything the OS says other than absence is {@link sourceUnreadable}.
 */
function sourcePresent(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch (error) {
    if (isPathAbsentError(error)) return false;
    throw sourceUnreadable(target, error);
  }
}

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

  // Ensure output directory exists
  await writingOutput(outputPath, () => fs.mkdir(outputPath, { recursive: true }), 'created');

  const files: string[] = [];

  // STEP 1: Generate SKILL.md from agent.yml
  const skillPath = await generateSkillFile(manifest, agentDir, outputPath);
  files.push(skillPath);

  // Generate agent-manifest-guide.md
  const guidePath = await generateManifestGuide(outputPath);
  files.push(guidePath);

  // Copy scripts/ directory if it exists (supports .js and .py). Only ABSENCE
  // skips the copy: a scripts/ that is there but cannot be copied (a plain file,
  // an unreadable entry) fails the build rather than shipping a bundle that
  // silently lacks its scripts — coded as the source's refusal, which is why the
  // tree is read before it is copied.
  const scriptsPath = safePath.join(agentDir, 'scripts');
  if (sourcePresent(scriptsPath)) {
    const outputScriptsPath = safePath.join(outputPath, 'scripts');
    await requireReadableTree(scriptsPath);
    // The source tree was read above, so a refusal here is the output's.
    await writingOutput(outputScriptsPath, () => copyDirectory(scriptsPath, outputScriptsPath));
    files.push(outputScriptsPath);
  }

  // Copy LICENSE.txt if it exists — same rule: absence skips, an unreadable one is refused.
  const licensePath = safePath.join(agentDir, 'LICENSE.txt');
  if (sourcePresent(licensePath)) {
    const outputLicensePath = safePath.join(outputPath, 'LICENSE.txt');
    const license = await readingSource(licensePath, () => fs.readFile(licensePath));
    await writingOutput(outputLicensePath, () => fs.writeFile(outputLicensePath, license));
    files.push(outputLicensePath);
  }

  // STEP 2: Optionally package the generated SKILL.md
  if (shouldPackage) {
    const packageResult = await packageSkill(skillPath, {
      outputPath,
      // The SKILL.md was generated into outputPath above: package it in place.
      sourceGeneratedInOutput: true,
      formats: options.formats ?? ['directory'],
      basePath: agentDir,
    });

    const result: BuildResult = {
      outputPath: packageResult.outputPath,
      agent: {
        name: manifest.metadata.name,
        version: manifest.metadata.version,
      },
      files: [...files, ...packageResult.files.dependencies.map(f => safePath.join(agentDir, f))],
    };

    // Conditionally add packageArtifacts (exactOptionalPropertyTypes)
    if (packageResult.artifacts !== undefined) {
      result.packageArtifacts = packageResult.artifacts;
    }

    return result;
  }

  // Just generate SKILL.md without packaging
  return {
    outputPath,
    agent: {
      name: manifest.metadata.name,
      version: manifest.metadata.version,
    },
    files,
  };
}

/**
 * Generate SKILL.md from agent manifest
 * Following Anthropic best practices: frontmatter + concise content + references
 */
async function generateSkillFile(
  manifest: LoadedAgentManifest,
  agentDir: string,
  outputPath: string
): Promise<string> {
  // Read system prompt
  // Both refusals are the manifest's to fix — coded so a caller never reports
  // them as a defect in VAT.
  const systemPromptRef = manifest.spec.prompts?.system?.$ref;
  if (!systemPromptRef) {
    throw new VatError(AGENT_MANIFEST_INVALID_CODE, 'Agent must have a system prompt (spec.prompts.system.$ref)');
  }

  const fullSystemPromptPath = safePath.resolve(agentDir, systemPromptRef);
  let systemPrompt: string;
  try {
    systemPrompt = await fs.readFile(fullSystemPromptPath, 'utf-8');
  } catch (error) {
    if (!isPathAbsentError(error)) throw sourceUnreadable(fullSystemPromptPath, error);
    throw new VatError(AGENT_MANIFEST_INVALID_CODE, `spec.prompts.system.$ref names ${systemPromptRef}, which does not exist.`, { cause: error });
  }

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
  await writingOutput(skillPath, () => fs.writeFile(skillPath, skillContent, 'utf-8'));

  return skillPath;
}

/**
 * Generate agent-manifest-guide.md with comprehensive documentation
 */
async function generateManifestGuide(outputPath: string): Promise<string> {
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
  await writingOutput(guidePath, () => fs.writeFile(guidePath, guide, 'utf-8'));

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
    if (sourcePresent(packageJsonPath)) {
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
