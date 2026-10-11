/**
 * System test: `vat audit <git-url>` end-to-end against a real public
 * GitHub repo. Network-gated — set NET_AVAILABLE=1 to enable; the CI
 * validate workflow sets it, so this is the tier that runs it.
 *
 * Uses GitHub's canonical Hello-World demo repo for stability:
 * https://github.com/octocat/Hello-World. It holds one README and no
 * auditable file, so the honest verdict is FINDINGS with
 * `RESOURCE_CHECK_BROKEN` ("examined 0 files is not a verdict") — what this
 * pins is the clone lane: the URL resolves, the commit is named in the
 * report's `data.provenance`, `data.root` is null, and the audit reports on
 * what it found rather than passing an empty tree.
 */

import { ExitCode } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { AUDIT_REPORT_SCHEMA } from '../../src/commands/audit-schema.js';
import { runAuditCli } from '../test-helpers.js';

const NET_AVAILABLE = process.env.NET_AVAILABLE === '1';

/** The stderr line naming the source — the human half of `data.provenance`. */
const PROVENANCE_LINE = /Audited: .+ @ .+ \(commit [a-f0-9]{8}\)/;

describe.skipIf(!NET_AVAILABLE)('vat audit <git-url> — system test', () => {
  it(
    'clones a real public GitHub repo, names the commit, and refuses to call an empty tree clean',
    () => {
      const result = runAuditCli('https://github.com/octocat/Hello-World.git');
      const report = AUDIT_REPORT_SCHEMA.parse(parse(result.stdout));

      expect(report.examined).toBe(0);
      expect(report.findings.map((finding) => finding.code)).toStrictEqual(['RESOURCE_CHECK_BROKEN']);
      expect(report.data.root).toBeNull();
      expect(report.data.provenance?.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(result.stderr).toMatch(PROVENANCE_LINE);
      expect(result.status).toBe(ExitCode.FINDINGS);
    },
    60_000
  );

  it(
    'resolves GitHub shorthand to the same repo',
    () => {
      const result = runAuditCli('octocat/Hello-World');
      const report = AUDIT_REPORT_SCHEMA.parse(parse(result.stdout));

      expect(report.data.provenance?.url).toBe('https://github.com/octocat/Hello-World.git');
      expect(report.data.root).toBeNull();
      expect(result.stderr).toMatch(PROVENANCE_LINE);
      expect(result.status).toBe(ExitCode.FINDINGS);
    },
    60_000
  );
});
