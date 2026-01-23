/**
 * Test: Conversational demo startup verification
 *
 * Verifies that the conversational demo can start without errors
 * and shows appropriate messages when API key is missing.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execAsync = promisify(exec);

describe('Conversational Demo Startup', () => {
  it('should start without errors and show API key warning when key is missing', async () => {
    // Remove API key to test startup without it
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;

    // Run the demo with a short timeout (it should exit quickly without API key)
    const { stdout, stderr } = await execAsync(
      'bun run /Users/jeff/Workspaces/vibe-agent-toolkit/packages/vat-example-cat-agents/examples/conversational-demo.ts',
      {
        env,
        timeout: 5000, // 5 second timeout
      }
    );

    // Verify output contains expected messages
    expect(stdout).toContain('Conversational Demo: Breed Selection Advisor');
    expect(stdout).toContain('No OPENAI_API_KEY found');
    expect(stdout).toContain('Set environment variable to run real LLM calls');

    // Should not have any errors
    expect(stderr).toBe('');
  }, 10000); // 10 second test timeout

  it('should import and reference agent correctly', async () => {
    // Verify the agent can be imported (TypeScript compilation check)
    const { breedAdvisorAgent } = await import('../src/conversational-assistant/breed-advisor.js');

    expect(breedAdvisorAgent).toBeDefined();
    expect(breedAdvisorAgent.name).toBe('breed-advisor');
    expect(breedAdvisorAgent.manifest.archetype).toBe('conversational-assistant');
    expect(breedAdvisorAgent.manifest.description).toContain('cat breed');
  });

  it('should have CLITransport available from transports package', async () => {
    // Verify the transport is available (dependency check)
    const { CLITransport } = await import('@vibe-agent-toolkit/transports');

    expect(CLITransport).toBeDefined();
    expect(typeof CLITransport).toBe('function');
  });
});
