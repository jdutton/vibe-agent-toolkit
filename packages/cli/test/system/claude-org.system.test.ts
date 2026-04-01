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

function runOrgWithoutKeys(args: string[]): ReturnType<typeof executeCli> {
  return executeCli(binPath, ['claude', 'org', ...args], { env: ADMIN_KEY_ENV });
}

function runStubCommand(args: string[]): {
  result: ReturnType<typeof executeCli>;
  parsed: Record<string, unknown>;
} {
  return executeCliAndParseYaml(binPath, ['claude', 'org', ...args], { env: ADMIN_KEY_ENV });
}

/** Expect exit 2 with ANTHROPIC_ADMIN_API_KEY error. */
function expectAdminKeyError(args: string[]): void {
  const result = runOrgWithoutKeys(args);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('ANTHROPIC_ADMIN_API_KEY');
}

/** Expect exit 1 with not-yet-implemented stub for the given command name. */
function expectStub(args: string[], commandName: string): void {
  const { result, parsed } = runStubCommand(args);
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
    ])('org $cmd exits 2 with ANTHROPIC_ADMIN_API_KEY message', ({ args }) => {
      expectAdminKeyError(args);
    });
  });

  describe('missing regular API key for skills', () => {
    it('org skills list exits 2 with API key message', () => {
      const result = runOrgWithoutKeys(['skills', 'list']);
      expect(result.status).toBe(2);
      // Either message is acceptable — depends on which key is checked first
      expect(
        result.stderr.includes('ANTHROPIC_API_KEY') ||
          result.stderr.includes('ANTHROPIC_ADMIN_API_KEY'),
      ).toBe(true);
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
    ])('$cmd outputs not-yet-implemented and exits 1', ({ cmd, args }) => {
      expectStub(args, cmd);
    });

    // Workspace member stubs don't include command name in output
    it.each([
      { cmd: 'workspaces members add', args: ['workspaces', 'members', 'add', 'ws_123', '--user-id', 'u1', '--role', 'admin'] },
      { cmd: 'workspaces members update', args: ['workspaces', 'members', 'update', 'ws_123', '--user-id', 'u1', '--role', 'developer'] },
      { cmd: 'workspaces members remove', args: ['workspaces', 'members', 'remove', 'ws_123', '--user-id', 'u1'] },
    ])('org $cmd outputs not-yet-implemented and exits 1', ({ args }) => {
      const { result, parsed } = runStubCommand(args);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
    });
  });

  describe('implemented skills commands (key errors without credentials)', () => {
    it.each([
      { cmd: 'skills install', args: ['skills', 'install', './fake-skill'] },
      { cmd: 'skills delete', args: ['skills', 'delete', 'skill_abc123'] },
      { cmd: 'skills versions list', args: ['skills', 'versions', 'list', 'my-skill'] },
      { cmd: 'skills versions delete', args: ['skills', 'versions', 'delete', 'my-skill', '1.0.0'] },
    ])('org $cmd exits 2 with API key message when no key', ({ args }) => {
      expectAdminKeyError(args);
    });
  });

  describe('help text', () => {
    it('org --help exits 0 and mentions admin key', () => {
      const result = executeCli(binPath, ['claude', 'org', '--help']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('ANTHROPIC_ADMIN_API_KEY');
      expect(result.stdout).toContain('info');
      expect(result.stdout).toContain('users');
      expect(result.stdout).toContain('workspaces');
      expect(result.stdout).toContain('usage');
      expect(result.stdout).toContain('cost');
      expect(result.stdout).toContain('skills');
    });

    it('org info --help exits 0', () => {
      const result = executeCli(binPath, ['claude', 'org', 'info', '--help']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('organization');
    });
  });
});
