/**
 * System tests for `vat claude org` command group.
 *
 * These tests verify:
 * - Missing admin key error handling
 * - Missing regular API key for skills
 * - Stub responses for mutating commands
 * - Help text
 */

import { describe, expect, it } from 'vitest';

import { executeCli, executeCliAndParseYaml, getBinPath } from './test-common.js';

const binPath = getBinPath(import.meta.url);
const NOT_YET_IMPLEMENTED = 'not-yet-implemented';
const ADMIN_KEY_ENV = { ANTHROPIC_ADMIN_API_KEY: '', ANTHROPIC_API_KEY: '' };

async function runOrgWithoutKeys(args: string[]): Promise<Awaited<ReturnType<typeof executeCli>>> {
  return executeCli(binPath, ['claude', 'org', ...args], { env: ADMIN_KEY_ENV });
}

async function runStubCommand(args: string[]): Promise<{
  result: Awaited<ReturnType<typeof executeCli>>;
  parsed: Record<string, unknown>;
}> {
  return executeCliAndParseYaml(binPath, ['claude', 'org', ...args], { env: ADMIN_KEY_ENV });
}

/** Expect exit 2 with ANTHROPIC_ADMIN_API_KEY error. */
async function expectAdminKeyError(args: string[]): Promise<void> {
  const result = await runOrgWithoutKeys(args);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('ANTHROPIC_ADMIN_API_KEY');
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
  const result = await runOrgWithoutKeys(args);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('ANTHROPIC_API_KEY');
  expect(result.stderr).not.toContain('ANTHROPIC_ADMIN_API_KEY');
}

/** Expect exit 1 with not-yet-implemented stub for the given command name. */
async function expectStub(args: string[], commandName: string): Promise<void> {
  const { result, parsed } = await runStubCommand(args);
  expect(result.status).toBe(1);
  expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
  expect(parsed.command).toBe(commandName);
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
      { cmd: 'org users update', args: ['users', 'update', 'user_123', '--role', 'admin'] },
      { cmd: 'org users remove', args: ['users', 'remove', 'user_123'] },
      { cmd: 'org invites create', args: ['invites', 'create', '--email', 'test@example.com', '--role', 'user'] },
      { cmd: 'org invites delete', args: ['invites', 'delete', 'inv_123'] },
      { cmd: 'org workspaces create', args: ['workspaces', 'create', '--name', 'test'] },
      { cmd: 'org workspaces archive', args: ['workspaces', 'archive', 'ws_123'] },
      { cmd: 'org api-keys update', args: ['api-keys', 'update', 'key_123', '--name', 'new-name'] },
    ])('$cmd outputs not-yet-implemented and exits 1', async ({ cmd, args }) => {
      await expectStub(args, cmd);
    });

    // Workspace member stubs don't include command name in output
    it.each([
      { cmd: 'workspaces members add', args: ['workspaces', 'members', 'add', 'ws_123', '--user-id', 'u1', '--role', 'admin'] },
      { cmd: 'workspaces members update', args: ['workspaces', 'members', 'update', 'ws_123', '--user-id', 'u1', '--role', 'developer'] },
      { cmd: 'workspaces members remove', args: ['workspaces', 'members', 'remove', 'ws_123', '--user-id', 'u1'] },
    ])('org $cmd outputs not-yet-implemented and exits 1', async ({ args }) => {
      const { result, parsed } = await runStubCommand(args);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
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
      const result = await runOrgWithoutKeys(['skills', 'versions', 'add', 'skill_abc123', './fake-skill']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Source not found');
      expect(result.stderr).not.toContain('ANTHROPIC_ADMIN_API_KEY');
    });

    // The whole point of the command is that it takes the skill id outright, so a
    // missing id must be a usage error rather than something it tries to infer.
    it('org skills versions add requires a skill id', async () => {
      const result = await runOrgWithoutKeys(['skills', 'versions', 'add']);
      expect(result.status).not.toBe(0);
      expect(`${result.stderr}${result.stdout}`).toMatch(/missing required argument/i);
    });

    // `skills install` validates its source path BEFORE authenticating, so a bad path
    // reports the path — the credential is not what is wrong yet. Pinned separately so
    // the ordering is deliberate rather than incidental.
    it('org skills install reports a missing source before any key check', async () => {
      const result = await runOrgWithoutKeys(['skills', 'install', './fake-skill']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Source not found');
      expect(result.stderr).not.toContain('ANTHROPIC_ADMIN_API_KEY');
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
