/**
 * Claude Skill builder - converts VAT agents to Claude Skills
 */

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadAgentManifest, type LoadedAgentManifest } from '@vibe-agent-toolkit/agent-config';
import { copyDirectory } from '@vibe-agent-toolkit/utils';

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
}

/**
 * Build a Claude Skill from a VAT agent
 */
export async function buildClaudeSkill(options: BuildOptions): Promise<BuildResult> {
  const { agentPath, target = 'skill' } = options;

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
  const outputPath = path.join(baseOutputPath, manifest.metadata.name);

  // Ensure output directory exists
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path constructed from validated manifest
  await fs.mkdir(outputPath, { recursive: true });

  const files: string[] = [];

  // Generate SKILL.md
  const skillPath = await generateSkillFile(manifest, agentDir, outputPath);
  files.push(skillPath);

  // Generate agent-manifest-guide.md
  const guidePath = await generateManifestGuide(outputPath);
  files.push(guidePath);

  // Copy scripts/ directory if it exists (supports .js and .py)
  const scriptsPath = path.join(agentDir, 'scripts');
  try {
    await fs.access(scriptsPath);
    const outputScriptsPath = path.join(outputPath, 'scripts');
    await copyDirectory(scriptsPath, outputScriptsPath);
    files.push(outputScriptsPath);
  } catch {
    // No scripts directory to copy
  }

  // Copy LICENSE.txt if it exists
  const licensePath = path.join(agentDir, 'LICENSE.txt');
  try {
    await fs.access(licensePath);
    const outputLicensePath = path.join(outputPath, 'LICENSE.txt');
    await fs.copyFile(licensePath, outputLicensePath);
    files.push(outputLicensePath);
  } catch {
    // No LICENSE.txt to copy
  }

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
  const systemPromptRef = manifest.spec.prompts?.system?.$ref;
  if (!systemPromptRef) {
    throw new Error('Agent must have a system prompt (spec.prompts.system.$ref)');
  }

  const fullSystemPromptPath = path.resolve(agentDir, systemPromptRef);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Path constructed from manifest reference
  const systemPrompt = await fs.readFile(fullSystemPromptPath, 'utf-8');

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
    model: claude-sonnet-4-20250514

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
  const skillPath = path.join(outputPath, 'SKILL.md');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Output path is validated
  await fs.writeFile(skillPath, skillContent, 'utf-8');

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
    model: claude-sonnet-4-20250514
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
    model: claude-sonnet-4-20250514
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
    model: claude-sonnet-4-20250514
    temperature: 0.3
    maxTokens: 16000
    alternatives:
      - provider: anthropic
        model: claude-opus-4-20250514
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
    model: claude-sonnet-4-20250514
    alternatives:
      - provider: anthropic
        model: claude-3-5-haiku-20241022  # Faster/cheaper fallback
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
    model: claude-sonnet  # BAD: which version?
\`\`\`

**Why**: Model versions change capabilities and pricing. Be specific.

✅ **Do**: Use full version identifiers

\`\`\`yaml
spec:
  llm:
    model: claude-sonnet-4-20250514  # Explicit version
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

  const guidePath = path.join(outputPath, 'agent-manifest-guide.md');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Output path is validated
  await fs.writeFile(guidePath, guide, 'utf-8');

  return guidePath;
}


/**
 * Get the default output path for agent bundles
 * Returns <agent-package-root>/dist/vat-bundles/<target>
 */
function getDefaultOutputPath(manifestPath: string, target: string): string {
  const agentPackageRoot = findAgentPackageRoot(manifestPath);
  return path.join(agentPackageRoot, 'dist', 'vat-bundles', target);
}

/**
 * Find the package root that contains the agent
 * Walks up from the agent directory to find the nearest package.json
 */
function findAgentPackageRoot(manifestPath: string): string {
  let currentDir = path.dirname(path.resolve(manifestPath));

  // Walk up until we find a package.json or hit the filesystem root
  while (currentDir !== path.dirname(currentDir)) {
    const packageJsonPath = path.join(currentDir, 'package.json');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Searching for package.json
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }

  throw new Error(
    `Could not find package.json for agent at ${manifestPath}. ` +
      `Agent must be within an npm package to build bundles.`
  );
}
