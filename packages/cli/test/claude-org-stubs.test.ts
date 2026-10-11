import { OrgApiClient } from '@vibe-agent-toolkit/claude-marketplace';
import { ExitCode } from '@vibe-agent-toolkit/schema';
import type { Command } from 'commander';
import { describe, it, expect, afterEach, vi } from 'vitest';
import yaml from 'yaml';

import { createOrgApiKeysCommand } from '../src/commands/claude/org/api-keys.js';
import { createOrgInvitesCommand } from '../src/commands/claude/org/invites.js';
import { createOrgUsersCommand } from '../src/commands/claude/org/users.js';
import { createOrgWorkspacesCommand } from '../src/commands/claude/org/workspaces.js';
import { reportShapeFor } from '../src/report-schemas.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** One stub leaf: its registered verb, the group that holds it, and an argv that satisfies its options. */
const STUB_LEAVES: ReadonlyArray<readonly [verb: string, makeGroup: () => Command, argv: readonly string[]]> = [
  ['claude org api-keys update', createOrgApiKeysCommand, ['update', 'key_1', '--name', 'n']],
  ['claude org invites create', createOrgInvitesCommand, ['create', '--email', 'a@example.com', '--role', 'user']],
  ['claude org invites delete', createOrgInvitesCommand, ['delete', 'inv_1']],
  ['claude org users update', createOrgUsersCommand, ['update', 'user_1', '--role', 'admin']],
  ['claude org users remove', createOrgUsersCommand, ['remove', 'user_1']],
  ['claude org workspaces create', createOrgWorkspacesCommand, ['create', '--name', 'w']],
  ['claude org workspaces archive', createOrgWorkspacesCommand, ['archive', 'ws_1']],
  ['claude org workspaces members add', createOrgWorkspacesCommand, ['members', 'add', 'ws_1', '--user-id', 'u', '--role', 'workspace_user']],
  ['claude org workspaces members update', createOrgWorkspacesCommand, ['members', 'update', 'ws_1', '--user-id', 'u', '--role', 'r']],
  ['claude org workspaces members remove', createOrgWorkspacesCommand, ['members', 'remove', 'ws_1', '--user-id', 'u']],
];

/** Run one stub leaf through its real action: the stdout it publishes and the code it ends on. */
async function runStub(makeGroup: () => Command, argv: readonly string[]): Promise<{ stdout: string; exitCode: unknown }> {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  await makeGroup().parseAsync([...argv], { from: 'user' });
  return { stdout: chunks.join(''), exitCode: exit.mock.calls[0]?.[0] };
}

describe('the not-implemented stub leaves', () => {
  it.each(STUB_LEAVES)('a stub publishes status error, error.code NOT_IMPLEMENTED, exit 2: %s', async (verb, makeGroup, argv) => {
    const { stdout, exitCode } = await runStub(makeGroup, argv);
    const document = reportShapeFor(verb).schema.parse(yaml.parse(stdout)) as { status: string; error?: { code: string }; examined: number };

    expect(document.status).toBe('error');
    expect(document.error?.code).toBe('NOT_IMPLEMENTED');
    expect(document.examined).toBe(0);
    expect(exitCode).toBe(ExitCode.ERROR);
  });

  /**
   * The stub used to promise `plannedFor: "0.1.22"` and "coming in the next
   * release". Both rot: every release that ships without the feature turns the
   * promise into a lie, and nothing in the build re-checks it. The message must
   * therefore be true at ANY future version — which means it must not name a
   * version or a release at all.
   */
  it('makes no dated promise: no version number and no release timeline', async () => {
    const { stdout } = await runStub(createOrgUsersCommand, ['update', 'user_1', '--role', 'admin']);
    const message = (yaml.parse(stdout) as { error: { message: string } }).error.message;

    // Bounded quantifiers: an unbounded `\d+\.\d+\.\d+` is a backtracking hazard
    // (sonarjs/slow-regex). Four digits per segment covers any real semver.
    expect(message).not.toMatch(/\d{1,4}\.\d{1,4}\.\d{1,4}/);
    expect(message).not.toMatch(/plannedFor/i);
    expect(message).not.toMatch(/next release|future release|coming (in|soon)/i);
    expect(message).toContain('Anthropic Console');
  });
});

// ── Where an id from argv lands in the request path ────────────────────

/**
 * The path an org command actually asks the Admin API for, for a given argv.
 *
 * Reaches the REAL command action — the id is parsed by Commander and spliced
 * (or encoded) by the same expression production runs — and stops at the client
 * boundary. Anything shallower would be a test of `encodeURIComponent`, which
 * needs no test; the claim being pinned is that this command applies it.
 *
 * `OrgApiClient.prototype` is a plain object, so patching a method on it is not
 * the ESM module-export spy the repo forbids. Mocking `get` also means no key is
 * ever read and no socket is ever opened: `buildAdminHeaders` is never reached.
 * `process.exit` is stubbed because `executeOrgCommand` ends on it.
 */
async function adminPathFor(command: Command, argv: string[]): Promise<string> {
  // An empty page, so the list actions' own `resp.data.map` has something real
  // to run on and the command completes instead of ending in an error handler.
  const get = vi.spyOn(OrgApiClient.prototype, 'get')
    .mockResolvedValue({ data: [], has_more: false } as never);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  await command.parseAsync(argv, { from: 'user' });

  const call = get.mock.calls[0];
  if (call === undefined) throw new Error('the command never reached the API client');
  return call[0];
}

/** Ids shaped to escape their path segment if they were spliced in raw. */
const HOSTILE_IDS: ReadonlyArray<readonly [label: string, id: string, encoded: string]> = [
  ['a traversal', '../../foo', '..%2F..%2Ffoo'],
  ['a query delimiter', 'abc?limit=1', 'abc%3Flimit%3D1'],
  ['a fragment delimiter', 'abc#frag', 'abc%23frag'],
  ['a space', 'abc def', 'abc%20def'],
];

/** An org command whose request path carries an id taken straight from argv. */
interface IdTakingEndpoint {
  readonly name: string;
  readonly makeCommand: () => Command;
  readonly argvFor: (id: string) => string[];
  readonly pathFor: (encodedId: string) => string;
}

const ID_TAKING_ENDPOINTS: readonly IdTakingEndpoint[] = [
  {
    name: 'users get',
    makeCommand: createOrgUsersCommand,
    argvFor: (id) => ['get', id],
    pathFor: (encodedId) => `/v1/organizations/users/${encodedId}`,
  },
  {
    name: 'workspaces get',
    makeCommand: createOrgWorkspacesCommand,
    argvFor: (id) => ['get', id],
    pathFor: (encodedId) => `/v1/organizations/workspaces/${encodedId}`,
  },
  {
    name: 'workspaces members list',
    makeCommand: createOrgWorkspacesCommand,
    argvFor: (id) => ['members', 'list', id],
    pathFor: (encodedId) => `/v1/organizations/workspaces/${encodedId}/members`,
  },
];

/**
 * The guard that makes the per-endpoint assertions mean what they say.
 *
 * Each expected path is built by substituting the encoded id into a template,
 * so it pins "cannot escape its segment" only while the encoded form itself
 * carries no separator and is not simply the raw id. `../../foo` spliced raw
 * would add two segments; encoded it cannot add any.
 */
describe('an id from argv cannot escape its path segment', () => {
  it('encodes every hostile id into a single path segment', () => {
    for (const [, raw, encoded] of HOSTILE_IDS) {
      expect(encoded).not.toContain('/');
      expect(encoded).not.toBe(raw);
    }
  });

  describe.each(ID_TAKING_ENDPOINTS)('$name', ({ makeCommand, argvFor, pathFor }) => {
    it.each(HOSTILE_IDS)('%s', async (_label, id, encoded) => {
      expect(await adminPathFor(makeCommand(), argvFor(id))).toBe(pathFor(encoded));
    });
  });
});
