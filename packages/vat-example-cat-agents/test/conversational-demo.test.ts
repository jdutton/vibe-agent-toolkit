/**
 * Test: Conversational demo wiring
 *
 * Verifies that the pieces the conversational demo depends on — the breed
 * advisor agent and the CLI transport — import and expose what the demo needs.
 *
 * NOT covered: actually starting the demo as a subprocess and asserting its
 * stdout. A `bun run <demo>` case used to sit here permanently disabled, because
 * the demo script's vitest imports break under `bun run`. A registered-but-never-
 * run case reads as a listed test in the suite output, so it was removed rather
 * than left claiming coverage it never provided. Re-add it — as a running test —
 * if the demo script is ever made subprocess-safe.
 */

import { describe, expect, it } from 'vitest';

describe('Conversational Demo Startup', () => {
  it('should import and reference agent correctly', async () => {
    // Verify the agent can be imported (TypeScript compilation check)
    const { breedAdvisorAgent } = await import('../src/conversational-assistant/breed-advisor.js');

    expect(breedAdvisorAgent).toBeDefined();
    expect(breedAdvisorAgent.name).toBe('breed-advisor');
    expect(breedAdvisorAgent.manifest.archetype).toBe('two-phase-conversational-assistant');
    expect(breedAdvisorAgent.manifest.description).toContain('cat breed');
  });

  it('should have CLITransport available from transports package', async () => {
    // Verify the transport is available (dependency check)
    const { CLITransport } = await import('@vibe-agent-toolkit/transports');

    expect(CLITransport).toBeDefined();
    expect(typeof CLITransport).toBe('function');
  });
});
