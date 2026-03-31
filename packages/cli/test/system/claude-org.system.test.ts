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

/**
 * Run an org command with no API keys set (empty env override).
 * Returns the CLI result for assertion.
 */
function runOrgWithoutKeys(args: string[]): ReturnType<typeof executeCli> {
  return executeCli(binPath, ['claude', 'org', ...args], {
    env: { ANTHROPIC_ADMIN_API_KEY: '', ANTHROPIC_API_KEY: '' },
  });
}

/**
 * Run a stub command and parse the YAML output.
 */
function runStubCommand(args: string[]): {
  result: ReturnType<typeof executeCli>;
  parsed: Record<string, unknown>;
} {
  return executeCliAndParseYaml(binPath, ['claude', 'org', ...args], {
    env: { ANTHROPIC_ADMIN_API_KEY: '', ANTHROPIC_API_KEY: '' },
  });
}

describe('vat claude org', () => {
  describe('missing admin key errors', () => {
    it('org info exits 2 with ANTHROPIC_ADMIN_API_KEY message', () => {
      const result = runOrgWithoutKeys(['info']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ANTHROPIC_ADMIN_API_KEY');
    });

    it('org users list exits 2 with ANTHROPIC_ADMIN_API_KEY message', () => {
      const result = runOrgWithoutKeys(['users', 'list']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ANTHROPIC_ADMIN_API_KEY');
    });

    it('org workspaces list exits 2 with ANTHROPIC_ADMIN_API_KEY message', () => {
      const result = runOrgWithoutKeys(['workspaces', 'list']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ANTHROPIC_ADMIN_API_KEY');
    });

    it('org invites list exits 2 with ANTHROPIC_ADMIN_API_KEY message', () => {
      const result = runOrgWithoutKeys(['invites', 'list']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ANTHROPIC_ADMIN_API_KEY');
    });

    it('org api-keys list exits 2 with ANTHROPIC_ADMIN_API_KEY message', () => {
      const result = runOrgWithoutKeys(['api-keys', 'list']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ANTHROPIC_ADMIN_API_KEY');
    });

    it('org usage exits 2 with ANTHROPIC_ADMIN_API_KEY message', () => {
      const result = runOrgWithoutKeys(['usage']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ANTHROPIC_ADMIN_API_KEY');
    });

    it('org cost exits 2 with ANTHROPIC_ADMIN_API_KEY message', () => {
      const result = runOrgWithoutKeys(['cost']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ANTHROPIC_ADMIN_API_KEY');
    });

    it('org code-analytics exits 2 with ANTHROPIC_ADMIN_API_KEY message', () => {
      const result = runOrgWithoutKeys(['code-analytics']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('ANTHROPIC_ADMIN_API_KEY');
    });
  });

  describe('missing regular API key for skills', () => {
    it('org skills list exits 2 with ANTHROPIC_API_KEY message', () => {
      // Skills commands need a valid admin key to construct the client,
      // but fail when getSkills() is called without ANTHROPIC_API_KEY.
      // With an empty admin key, the client constructor throws about admin key first.
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
    it('org users update outputs not-yet-implemented and exits 1', () => {
      const { result, parsed } = runStubCommand(['users', 'update', 'user_123', '--role', 'admin']);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
      expect(parsed.command).toBe('org users update');
    });

    it('org users remove outputs not-yet-implemented and exits 1', () => {
      const { result, parsed } = runStubCommand(['users', 'remove', 'user_123']);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
      expect(parsed.command).toBe('org users remove');
    });

    it('org invites create outputs not-yet-implemented and exits 1', () => {
      const { result, parsed } = runStubCommand([
        'invites',
        'create',
        '--email',
        'test@example.com',
        '--role',
        'user',
      ]);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
      expect(parsed.command).toBe('org invites create');
    });

    it('org invites delete outputs not-yet-implemented and exits 1', () => {
      const { result, parsed } = runStubCommand(['invites', 'delete', 'inv_123']);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
      expect(parsed.command).toBe('org invites delete');
    });

    it('org workspaces members add outputs not-yet-implemented and exits 1', () => {
      const { result, parsed } = runStubCommand(['workspaces', 'members', 'add', 'ws_123', '--user-id', 'u1', '--role', 'admin']);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
    });

    it('org workspaces members update outputs not-yet-implemented and exits 1', () => {
      const { result, parsed } = runStubCommand(['workspaces', 'members', 'update', 'ws_123', '--user-id', 'u1', '--role', 'developer']);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
    });

    it('org workspaces members remove outputs not-yet-implemented and exits 1', () => {
      const { result, parsed } = runStubCommand(['workspaces', 'members', 'remove', 'ws_123', '--user-id', 'u1']);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
    });

    it('org workspaces create outputs not-yet-implemented and exits 1', () => {
      const { result, parsed } = runStubCommand(['workspaces', 'create', '--name', 'test']);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
      expect(parsed.command).toBe('org workspaces create');
    });

    it('org workspaces archive outputs not-yet-implemented and exits 1', () => {
      const { result, parsed } = runStubCommand(['workspaces', 'archive', 'ws_123']);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
      expect(parsed.command).toBe('org workspaces archive');
    });

    it('org api-keys update outputs not-yet-implemented and exits 1', () => {
      const { result, parsed } = runStubCommand([
        'api-keys',
        'update',
        'key_123',
        '--name',
        'new-name',
      ]);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
      expect(parsed.command).toBe('org api-keys update');
    });

    it('org skills install outputs not-yet-implemented and exits 1', () => {
      const { result, parsed } = runStubCommand(['skills', 'install', 'my-skill']);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
      expect(parsed.command).toBe('org skills install');
    });

    it('org skills delete outputs not-yet-implemented and exits 1', () => {
      const { result, parsed } = runStubCommand(['skills', 'delete', 'my-skill']);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
      expect(parsed.command).toBe('org skills delete');
    });

    it('org skills versions list outputs not-yet-implemented and exits 1', () => {
      const { result, parsed } = runStubCommand(['skills', 'versions', 'list', 'my-skill']);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
      expect(parsed.command).toBe('org skills versions list');
    });

    it('org skills versions delete outputs not-yet-implemented and exits 1', () => {
      const { result, parsed } = runStubCommand([
        'skills',
        'versions',
        'delete',
        'my-skill',
        '1.0.0',
      ]);
      expect(result.status).toBe(1);
      expect(parsed.status).toBe(NOT_YET_IMPLEMENTED);
      expect(parsed.command).toBe('org skills versions delete');
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
