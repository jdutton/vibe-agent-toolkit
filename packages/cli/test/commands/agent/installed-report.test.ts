/**
 * `vat agent installed` — the document it publishes, decided against a FAKE
 * listing: the scope directories and what `readdir` answers for each are
 * scripted, and the document writer is replaced by a recorder, so the scope
 * selection, the refusals, and the unreadable-scope warning are pinned with no
 * real tree and no process exit.
 */

import type * as FsPromises from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installedCommand } from '../../../src/commands/agent/installed.js';
import { errno } from '../../helpers/refusal-doubles.js';

const listings = vi.hoisted(() => new Map<string, unknown>());
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const readdir = vi.fn((path: string) => {
    const answer = listings.get(String(path));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  return { ...real, readdir, default: { ...real, readdir } };
});

const SCOPES = vi.hoisted(() => ({ user: '/home/.claude/skills', project: '/work/.claude/skills' }));
vi.mock('../../../src/utils/scope-locations.js', () => ({
  scopeLocationsFor: (runtime: string) => (runtime === 'agent-skill' ? { ...SCOPES } : undefined),
  knownScopeRuntimes: () => ['agent-skill'],
}));

/** What the command ended on: the report it published, or the refusal code. */
type Ending = { report: { examined: number; findings: Array<{ code: string; field?: string }>; data: { scanned: string[]; skills: unknown[] } } } | { refused: string };

const ENDED = 'ended';
const ending = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('../../../src/utils/document-writer.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  endWithReport: (_verb: string, report: unknown) => {
    ending.value = { report };
    throw new Error(ENDED);
  },
  endWithRefusal: (_verb: string, code: string) => {
    ending.value = { refused: code };
    throw new Error(ENDED);
  },
}));

async function run(options: Parameters<typeof installedCommand>[0]): Promise<Ending> {
  await expect(installedCommand(options)).rejects.toThrow(ENDED);
  return ending.value as Ending;
}

function dirent(name: string, kind: 'dir' | 'link' | 'file'): { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean } {
  return { name, isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' };
}

function reportOf(result: Ending): Extract<Ending, { report: unknown }>['report'] {
  if (!('report' in result)) throw new Error(`refused: ${result.refused}`);
  return result.report;
}

beforeEach(() => {
  listings.clear();
  ending.value = undefined;
});

describe('vat agent installed — the published document', () => {
  it('lists directories and links under every scope, and skips a scope directory that is absent', async () => {
    listings.set(SCOPES.user, [dirent('alpha', 'dir'), dirent('beta', 'link'), dirent('notes.txt', 'file')]);
    listings.set(SCOPES.project, errno('ENOENT'));

    const report = reportOf(await run({}));

    expect(report.examined).toBe(2);
    expect(report.data.scanned).toEqual(['user', 'project']);
    expect(report.data.skills).toEqual([
      { name: 'alpha', scope: 'user', type: 'directory', path: `${SCOPES.user}/alpha` },
      { name: 'beta', scope: 'user', type: 'symlink', path: `${SCOPES.user}/beta` },
    ]);
    expect(report.findings).toEqual([]);
  });

  it('scans only the scope --scope names', async () => {
    listings.set(SCOPES.project, [dirent('gamma', 'dir')]);

    const report = reportOf(await run({ scope: 'project', debug: true }));

    expect(report.data.scanned).toEqual(['project']);
    expect(report.data.skills).toHaveLength(1);
  });

  it('warns SCAN_PATH_UNREADABLE for a scope the OS will not list, and still lists the others', async () => {
    listings.set(SCOPES.user, errno('EACCES'));
    listings.set(SCOPES.project, [dirent('gamma', 'dir')]);

    const report = reportOf(await run({}));

    expect(report.findings).toMatchObject([{ code: 'SCAN_PATH_UNREADABLE', field: 'user' }]);
    expect(report.data.skills).toHaveLength(1);
  });

  it('refuses an unknown runtime and an unknown scope as USAGE_INVALID', async () => {
    expect(await run({ runtime: 'nope' })).toEqual({ refused: 'USAGE_INVALID' });
    expect(await run({ scope: 'galaxy' })).toEqual({ refused: 'USAGE_INVALID' });
  });
});
