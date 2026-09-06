import { OrgApiClient } from '@vibe-agent-toolkit/claude-marketplace';
import type { Command } from 'commander';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { writeNotYetImplementedStub } from '../src/commands/claude/org/stubs.js';
import { createOrgUsersCommand } from '../src/commands/claude/org/users.js';
import { createOrgWorkspacesCommand } from '../src/commands/claude/org/workspaces.js';

/** Capture everything the stub writes to stdout for one invocation. */
function captureStub(command: string): string {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    writeNotYetImplementedStub(command);
  } finally {
    spy.mockRestore();
  }
  return chunks.join('');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writeNotYetImplementedStub', () => {
  it('emits the machine-readable status and the command name', () => {
    const output = captureStub('org users update');

    expect(output).toContain('status: not-yet-implemented\n');
    expect(output).toContain('command: "org users update"\n');
  });

  /**
   * The stub used to promise `plannedFor: "0.1.22"` and "coming in the next
   * release". Both rot: every release that ships without the feature turns the
   * promise into a lie, and nothing in the build re-checks it. The message must
   * therefore be true at ANY future version — which means it must not name a
   * version or a release at all.
   */
  it('makes no dated promise: no version number and no release timeline', () => {
    const output = captureStub('org users update');

    // Bounded quantifiers: an unbounded `\d+\.\d+\.\d+` is a backtracking hazard
    // (sonarjs/slow-regex). Four digits per segment covers any real semver.
    expect(output).not.toMatch(/\d{1,4}\.\d{1,4}\.\d{1,4}/);
    expect(output).not.toMatch(/plannedFor/i);
    expect(output).not.toMatch(/next release|future release|coming (in|soon)/i);
  });

  it('emits valid YAML front-matter delimiters around the payload', () => {
    const output = captureStub('org api-keys update');

    expect(output.startsWith('---\n')).toBe(true);
    expect(output).toContain('command: "org api-keys update"\n');
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
