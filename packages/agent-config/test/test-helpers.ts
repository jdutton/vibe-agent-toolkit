
/* eslint-disable security/detect-non-literal-fs-filename -- Test helpers using temp directories */
import fs from 'node:fs';
import path from 'node:path';

import { mkdirSyncReal } from '@vibe-agent-toolkit/utils';
import { expect } from 'vitest';

import { type ValidationResult } from '../src/validator/agent-validator.js';

/**
 * Assert that validation result shows errors with specific content
 */
export function assertValidationHasError(
  result: ValidationResult,
  searchTerms: string[]
): void {
  expect(result.valid).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
  const hasExpectedError = result.errors.some(error =>
    searchTerms.some(term => error.includes(term))
  );
  expect(hasExpectedError).toBe(true);
}

/**
 * Assert that validation failed with unknown manifest info
 */
export function assertValidationFailedWithUnknownManifest(
  result: ValidationResult,
  options: { checkVersion?: boolean } = {}
): void {
  expect(result.valid).toBe(false);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.manifest.name).toBe('unknown');
  if (options.checkVersion !== false) {
    expect(result.manifest.version).toBe('unknown');
  }
}

/**
 * Common agent manifest template parts
 */
const AGENT_YAML = 'agent.yaml';
const LLM_SPEC = `spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5`;

interface AgentManifestOptions {
  name: string;
  version?: string;
  description?: string;
  rag?: {
    sources?: Array<{ path: string }>;
    provider?: string;
  };
  prompts?: {
    system?: string;
    user?: string;
  };
  resources?: Record<string, unknown>;
}

function addMetadata(parts: string[], options: AgentManifestOptions): void {
  parts.push('metadata:', `  name: ${options.name}`);
  if (options.version) parts.push(`  version: ${options.version}`);
  if (options.description) parts.push(`  description: ${options.description}`);
}

function addRagConfig(parts: string[], rag: NonNullable<AgentManifestOptions['rag']>): void {
  parts.push('  rag:', '    default:');
  if (rag.provider) parts.push(`      provider: ${rag.provider}`);
  if (rag.sources) {
    parts.push('      sources:');
    for (const source of rag.sources) parts.push(`        - path: ${source.path}`);
  }
}

function addPrompts(parts: string[], prompts: NonNullable<AgentManifestOptions['prompts']>): void {
  parts.push('  prompts:');
  if (prompts.system) parts.push('    system:', `      $ref: ${prompts.system}`);
  if (prompts.user) parts.push('    user:', `      $ref: ${prompts.user}`);
}

function addResourceEntry(
  parts: string[],
  key: string,
  resource: Record<string, unknown>,
  indent: string
): void {
  parts.push(`${indent}${key}:`);
  if (resource.path) {
    const pathStr = typeof resource.path === 'string' ? resource.path : JSON.stringify(resource.path);
    parts.push(`${indent}  path: ${pathStr}`);
    if (resource.type) {
      const typeStr = typeof resource.type === 'string' ? resource.type : JSON.stringify(resource.type);
      parts.push(`${indent}  type: ${typeStr}`);
    }
  } else {
    for (const [nestedKey, nestedValue] of Object.entries(resource)) {
      addResourceEntry(parts, nestedKey, nestedValue as Record<string, unknown>, `${indent}  `);
    }
  }
}

/**
 * Generate agent manifest YAML string
 */
export function createAgentManifest(options: AgentManifestOptions): string {
  const parts: string[] = [];
  addMetadata(parts, options);
  parts.push(LLM_SPEC);
  if (options.rag) addRagConfig(parts, options.rag);
  if (options.prompts) addPrompts(parts, options.prompts);
  if (options.resources) {
    parts.push('  resources:');
    for (const [key, value] of Object.entries(options.resources)) {
      addResourceEntry(parts, key, value as Record<string, unknown>, '    ');
    }
  }
  return parts.join('\n');
}

/**
 * Create test agent directory with manifest
 */
export function createTestAgent(
  tempDir: string,
  dirName: string,
  manifestOptions: AgentManifestOptions,
  additionalFiles?: Record<string, string>
): string {
  const agentDir = path.join(tempDir, dirName);
  mkdirSyncReal(agentDir, { recursive: true });

  // Create additional files first (may include nested directories)
  if (additionalFiles) {
    for (const [filePath, content] of Object.entries(additionalFiles)) {
      const fullPath = path.join(agentDir, filePath);
      const dir = path.dirname(fullPath);
      if (dir !== agentDir) {
        mkdirSyncReal(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, content);
    }
  }

  // Create manifest
  fs.writeFileSync(path.join(agentDir, AGENT_YAML), createAgentManifest(manifestOptions));

  return agentDir;
}
