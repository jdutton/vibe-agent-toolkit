#!/usr/bin/env bun
/**
 * Validation script for agent.yaml
 *
 * Validates agent-generator's manifest against @vibe-agent-toolkit/agent-schema.
 * This is the forcing function to discover schema refinements needed for Phase 1.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { AgentManifestSchema } from '../../../../packages/agent-schema/dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function main(): void {
  console.log('Validating agent.yaml against AgentManifestSchema...\n');

  // Read agent.yaml
  const agentYamlPath = resolve(__dirname, 'agent.yaml');
  const agentYamlContent = readFileSync(agentYamlPath, 'utf-8');

  // Parse YAML to object
  const agentData = parseYaml(agentYamlContent);

  console.log('Parsed agent.yaml successfully');
  console.log('Agent name:', agentData.metadata?.name);
  console.log('Agent version:', agentData.metadata?.version);
  console.log();

  // Validate against schema
  const result = AgentManifestSchema.safeParse(agentData);

  if (result.success) {
    console.log('✅ VALIDATION PASSED');
    console.log('agent.yaml is valid according to AgentManifestSchema');
    process.exit(0);
  }

  // Validation failed - report detailed errors
  console.log('❌ VALIDATION FAILED\n');
  console.log('Errors found:\n');

  const errors = result.error.errors;

  // Group errors by path for better readability
  const errorsByPath = new Map<string, typeof errors>();

  for (const error of errors) {
    const path = error.path.join('.');
    const existing = errorsByPath.get(path) ?? [];
    existing.push(error);
    errorsByPath.set(path, existing);
  }

  // Report errors
  let errorCount = 0;
  for (const [path, pathErrors] of errorsByPath) {
    for (const error of pathErrors) {
      errorCount++;
      console.log(`[${errorCount}] Path: ${path || '(root)'}`);
      console.log(`    Code: ${error.code}`);
      console.log(`    Message: ${error.message}`);

      if (error.code === 'unrecognized_keys') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Error shape from Zod
        const keys = (error as any).keys;
        if (keys && Array.isArray(keys)) {
          console.log(`    Unrecognized keys: ${keys.join(', ')}`);
        }
      }

      console.log();
    }
  }

  console.log(`Total errors: ${errorCount}`);
  console.log();
  console.log('Next steps:');
  console.log('1. Review errors above');
  console.log('2. Determine if agent.yaml needs fixes OR schema needs refinements');
  console.log('3. Document findings in DESIGN-NOTES.md');

  process.exit(1);
}

main();
