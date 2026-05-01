/**
 * System test: `vat audit <git-url>` end-to-end against a real public
 * GitHub repo. Network-gated — set NET_AVAILABLE=1 to enable.
 *
 * Uses GitHub's canonical Hello-World demo repo for stability:
 * https://github.com/octocat/Hello-World
 */

import { describe, expect, it } from 'vitest';

import { runAuditCli } from '../test-helpers.js';

const NET_AVAILABLE = process.env.NET_AVAILABLE === '1';

describe.skipIf(!NET_AVAILABLE)('vat audit <git-url> — system test', () => {
  it(
    'clones a real public GitHub repo and audits it',
    () => {
      const result = runAuditCli('https://github.com/octocat/Hello-World.git');
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/Audited: .+ @ .+ \(commit [a-f0-9]{8}\)/);
    },
    60_000
  );

  it(
    'audits via GitHub shorthand',
    () => {
      const result = runAuditCli('octocat/Hello-World');
      expect(result.status).toBe(0);
    },
    60_000
  );
});
