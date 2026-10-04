/**
 * System tests for `vat claude org` command group.
 *
 * These tests verify:
 * - A refusal on an external verb (missing key, usage mistake, no such source)
 *   publishes `{ error: { code, message } }` and ends on 2
 * - The not-implemented stubs publish the envelope's error branch
 *   (`NOT_IMPLEMENTED`) through the document writer
 * - Help text
 */

import { chmodSync } from 'node:fs';
import { homedir } from 'node:os';

import type { RefusalCode } from '@vibe-agent-toolkit/schema';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it } from 'vitest';

import { reportShapeFor } from '../../src/report-schemas.js';

import { cleanupTestTempDir, createTestTempDir, executeCli, executeCliAndParseYaml, getBinPath } from './test-common.js';

const binPath = getBinPath(import.meta.url);
const ADMIN_KEY_ENV = { ANTHROPIC_ADMIN_API_KEY: '', ANTHROPIC_API_KEY: '' };

async function runOrgWithoutKeys(args: string[]): Promise<Awaited<ReturnType<typeof executeCliAndParseYaml>>> {
  return executeCliAndParseYaml(binPath, ['claude', 'org', ...args], { env: ADMIN_KEY_ENV });
}

/**
 * Expect the external verb's refusal document — `{ error: { code, message } }`,
 * the one failure payload every `claude org` verb publishes — at exit 2.
 */
async function expectExternalRefusal(args: string[], code: RefusalCode, mentions: string): Promise<Awaited<ReturnType<typeof executeCliAndParseYaml>>> {
  const run = await runOrgWithoutKeys(args);
  const { result, parsed } = run;
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
  expect(parsed, result.stdout).toStrictEqual({ error: { code, message: expect.stringContaining(mentions) } });
  expect(result.stderr).toContain(mentions);
  return run;
}

/** Expect exit 2 with ANTHROPIC_ADMIN_API_KEY error. */
async function expectAdminKeyError(args: string[]): Promise<void> {
  await expectExternalRefusal(args, 'USAGE_INVALID', 'ANTHROPIC_ADMIN_API_KEY');
}

/**
 * Expect exit 2 naming the REGULAR key — and never the admin key.
 *
 * `/v1/skills` authenticates with `ANTHROPIC_API_KEY` and never sends the admin key,
 * so a workspace member holding only a regular key must be able to run these. Asserting
 * the admin key is ABSENT is the whole point: the command previously demanded it at
 * construction time and thereby refused every non-admin, and an assertion that accepted
 * either message is what let that ship.
 */
async function expectSkillsKeyError(args: string[]): Promise<void> {
  const { result } = await expectExternalRefusal(args, 'USAGE_INVALID', 'ANTHROPIC_API_KEY');
  expect(result.stderr).not.toContain('ANTHROPIC_ADMIN_API_KEY');
}

/**
 * Expect the not-yet-implemented stub for `verb`: the envelope's error branch,
 * validated against the stub entry's published schema, at ERROR — a verb that
 * cannot do its job is not a finding about the org.
 */
async function expectStub(args: string[], verb: string): Promise<void> {
  const { result, parsed } = await runOrgWithoutKeys(args);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(2);
  const document = reportShapeFor(verb).schema.parse(parsed) as { status: string; error?: { code: string } };
  expect(document.status).toBe('error');
  expect(document.error?.code).toBe('NOT_IMPLEMENTED');
}

describe('vat claude org', () => {
  describe('missing admin key errors', () => {
    it.each([
      { cmd: 'info', args: ['info'] },
      { cmd: 'users list', args: ['users', 'list'] },
      { cmd: 'workspaces list', args: ['workspaces', 'list'] },
      { cmd: 'invites list', args: ['invites', 'list'] },
      { cmd: 'api-keys list', args: ['api-keys', 'list'] },
      { cmd: 'usage', args: ['usage'] },
      { cmd: 'cost', args: ['cost'] },
      { cmd: 'code-analytics', args: ['code-analytics'] },
    ])('org $cmd exits 2 with ANTHROPIC_ADMIN_API_KEY message', async ({ args }) => {
      await expectAdminKeyError(args);
    });
  });

  describe('missing regular API key for skills', () => {
    it('org skills list exits 2 naming the regular key, not the admin key', async () => {
      await expectSkillsKeyError(['skills', 'list']);
    });
  });

  describe('stub commands (mutating operations)', () => {
    it.each([
      { cmd: 'users update', args: ['users', 'update', 'user_123', '--role', 'admin'] },
      { cmd: 'users remove', args: ['users', 'remove', 'user_123'] },
      { cmd: 'invites create', args: ['invites', 'create', '--email', 'test@example.com', '--role', 'user'] },
      { cmd: 'invites delete', args: ['invites', 'delete', 'inv_123'] },
      { cmd: 'workspaces create', args: ['workspaces', 'create', '--name', 'test'] },
      { cmd: 'workspaces archive', args: ['workspaces', 'archive', 'ws_123'] },
      { cmd: 'api-keys update', args: ['api-keys', 'update', 'key_123', '--name', 'new-name'] },
      { cmd: 'workspaces members add', args: ['workspaces', 'members', 'add', 'ws_123', '--user-id', 'u1', '--role', 'admin'] },
      { cmd: 'workspaces members update', args: ['workspaces', 'members', 'update', 'ws_123', '--user-id', 'u1', '--role', 'developer'] },
      { cmd: 'workspaces members remove', args: ['workspaces', 'members', 'remove', 'ws_123', '--user-id', 'u1'] },
    ])('org $cmd refuses with NOT_IMPLEMENTED and exits 2', async ({ cmd, args }) => {
      await expectStub(args, `claude org ${cmd}`);
    });
  });

  describe('implemented skills commands (key errors without credentials)', () => {
    it.each([
      { cmd: 'skills delete', args: ['skills', 'delete', 'skill_abc123'] },
      { cmd: 'skills versions list', args: ['skills', 'versions', 'list', 'my-skill'] },
      { cmd: 'skills versions delete', args: ['skills', 'versions', 'delete', 'my-skill', '1.0.0'] },
    ])('org $cmd exits 2 naming the regular key, not the admin key', async ({ args }) => {
      await expectSkillsKeyError(args);
    });

    // Like `install`, `versions add` validates its source path before authenticating.
    it('org skills versions add reports a missing source before any key check', async () => {
      const { result } = await expectExternalRefusal(['skills', 'versions', 'add', 'skill_abc123', './fake-skill'], 'USAGE_INVALID', 'Source not found');
      expect(result.stderr).not.toContain('ANTHROPIC_ADMIN_API_KEY');
    });

    // The whole point of the command is that it takes the skill id outright, so a
    // missing id must be a usage error rather than something it tries to infer.
    //
    // The exact code, not `not.toBe(0)`: that assertion is satisfied by exit 1,
    // which every command's --help publishes as "at least one error-severity
    // finding" — a claim about a run that never started. `ExitCode.ERROR` is 2
    // precisely so a wrapper can tell the two apart, and an assertion that accepts
    // either cannot see the difference it exists to protect.
    it('org skills versions add requires a skill id', async () => {
      const { result } = await runOrgWithoutKeys(['skills', 'versions', 'add']);
      expect(result.status).toBe(2);
      expect(`${result.stderr}${result.stdout}`).toMatch(/missing required argument/i);
    });

    // `skills install` validates its source path BEFORE authenticating, so a bad path
    // reports the path — the credential is not what is wrong yet. Pinned separately so
    // the ordering is deliberate rather than incidental.
    it('org skills install reports a missing source before any key check', async () => {
      const { result } = await expectExternalRefusal(['skills', 'install', './fake-skill'], 'USAGE_INVALID', 'Source not found');
      expect(result.stderr).not.toContain('ANTHROPIC_ADMIN_API_KEY');
    });

    /**
     * A source under a parent the process may not traverse cannot be stat'ed:
     * whether it exists is unknown, so it is the INPUT's refusal — never
     * "Source not found" (USAGE_INVALID), and never an uncoded INTERNAL_ERROR
     * from the stat that follows. One predicate decides it
     * (`unstatablePathRefusal`).
     */
    it.skipIf(CANNOT_DENY_READS).each([
      { cmd: 'skills install', args: (source: string) => ['skills', 'install', source] },
      { cmd: 'skills versions add', args: (source: string) => ['skills', 'versions', 'add', 'skill_abc123', source] },
    ])('org $cmd over a source under an untraversable parent refuses with INPUT_UNREADABLE', async ({ args }) => {
      const root = createTestTempDir('vat-org-eacces-');
      const parent = safePath.join(root, 'locked');
      mkdirSyncReal(safePath.join(parent, 'skill'), { recursive: true });
      chmodSync(parent, 0o000);
      try {
        await expectExternalRefusal(args(safePath.join(parent, 'skill')), 'INPUT_UNREADABLE', 'EACCES');
      } finally {
        chmodSync(parent, 0o755);
        cleanupTestTempDir(root);
      }
    });

    /**
     * A usage mistake must publish the document the command's help promises, on
     * the exit code its contract publishes — not a Node crash dump.
     *
     * Measured before the fix: `node dist/bin.js claude org skills install` exited
     * **1** with **0 bytes on stdout** and a stderr carrying ten frames of
     * commander internals plus absolute $HOME paths. Both guards threw from the
     * async Commander action, outside executeOrgCommand, and `bin.ts` parses
     * synchronously — so the rejection reached no catch at all.
     */
    it.each([
      { case: 'neither <source> nor --from-npm', args: ['skills', 'install'], message: 'Provide a <source> path' },
      {
        case: 'both <source> and --from-npm',
        args: ['skills', 'install', './some-skill', '--from-npm', 'pkg@1.0.0'],
        message: 'Provide either <source> or --from-npm',
      },
      // The other two illegal combinations. Both flags used to be ACCEPTED and
      // silently ignored on the lane that cannot honour them — which publishes a
      // skill under the wrong title, or publishes every skill in a package when
      // the operator named one.
      {
        case: '--title with --from-npm, which can publish several skills',
        args: ['skills', 'install', '--from-npm', 'pkg@1.0.0', '--title', 'Mine'],
        message: '--title applies to a single skill',
      },
      {
        case: '--skill without --from-npm, which selects inside a package',
        args: ['skills', 'install', './some-skill', '--skill', 'other'],
        message: '--skill selects one skill inside an npm package',
      },
    ])('org skills install with $case exits 2 with a USAGE_INVALID refusal document', async ({ args, message }) => {
      const { result } = await expectExternalRefusal(args, 'USAGE_INVALID', message);

      // No stack dump, and no absolute home directory anywhere in the output.
      // A literal, not a regex: a V8 stack frame is four spaces then `at `.
      expect(result.stderr).not.toContain('    at ');
      expect(`${result.stdout}${result.stderr}`).not.toContain(homedir());
    });
  });

  describe('help text', () => {
    it('org --help exits 0 and mentions admin key', async () => {
      const result = await executeCli(binPath, ['claude', 'org', '--help']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ANTHROPIC_ADMIN_API_KEY');
      expect(result.stdout).toContain('info');
      expect(result.stdout).toContain('users');
      expect(result.stdout).toContain('workspaces');
      expect(result.stdout).toContain('usage');
      expect(result.stdout).toContain('cost');
      expect(result.stdout).toContain('skills');
    });

    it('org info --help exits 0', async () => {
      const result = await executeCli(binPath, ['claude', 'org', 'info', '--help']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('organization');
    });
  });
});
