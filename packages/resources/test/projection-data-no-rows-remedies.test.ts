/**
 * What a routed file with no rows is told to do, and which runs are told at all: a root input of the
 * workspace step (the root `package.json`, `pnpm-workspace.yaml`) is never told to route itself away,
 * since that only trades its `DATA_FILE_NO_ROWS` for the root's `DATA_REQUEST_UNROUTED`; its finding
 * and the root's `WORKSPACE_ROOT_NO_ROWS` refusal give one remedy, and the refusal is retryable only
 * where a rerun can pass. A run whose statements name only `workspace_*` relations reports only the
 * files the workspace step declared.
 */

import { describe, expect, it } from 'vitest';

import { keyContent, type KeyedContent } from '../src/content-key.js';
import { ParseLimitError, ParseWorkerDiedError } from '../src/parse-limits.js';
import type { DataDemand } from '../src/projection/data-stage.js';
import type { DataVariant } from '../src/schemas/projection-data.js';

import { extractorOf, stage, staged, type Realized } from './helpers/data-stage-fixture.js';

const WORKSPACE: DataDemand = { tables: [], routes: false, values: false, workspace: true, tsconfig: false };
const WORKSPACE_AND_NODES: DataDemand = { tables: ['dataNodes'], routes: false, values: false, workspace: true, tsconfig: false };
const ROOT_PKG = 'package.json';
const MEMBER = 'packages/a/package.json';
const EXCLUDE = 'resources.extractors.data.exclude';

/** The extractor, failing every file whose text names the failure: a limit by its name, `died` a worker death. */
const FAILING = extractorOf((_variant: DataVariant, input: KeyedContent) => {
  if (input.content.includes('died')) return new ParseWorkerDiedError({ exitCode: 1 });
  const limit = (['inputBytes', 'outputRows', 'outputBytes', 'outputDepth', 'timeMs', 'heapMb', 'stackMb'] as const).find((name) => input.content.includes(`"${name}"`));
  return limit === undefined ? undefined : new ParseLimitError(limit, 1);
});

/** @returns `root` beside one healthy member */
function rootFailing(root: Realized): Realized[] {
  return [root, { path: MEMBER, text: '{"name": "a"}' }];
}

/** Stage `files` with the workspace demanded: the root input's finding, and the workspace refusal. */
async function rootInputAnswer(files: readonly Realized[]): Promise<{ readonly remedy: string; readonly refusalRemedy: string; readonly retryable: boolean }> {
  const result = staged(await stage(files, { demand: WORKSPACE, extractor: FAILING }));
  const defect = result.defects.find((entry) => entry.path === ROOT_PKG);
  if (defect === undefined) throw new Error(`expected a defect at ${ROOT_PKG}, got ${JSON.stringify(result.defects)}`);
  if (result.workspace?.outcome !== 'refused') throw new Error(`expected the workspace refused, got ${JSON.stringify(result.workspace)}`);
  return { remedy: defect.remedy, refusalRemedy: result.workspace.refusal.remedy, retryable: result.workspace.refusal.retryable };
}

describe('a root input of the workspace step with no rows', () => {
  it.each<[string, Realized, RegExp, boolean]>([
    ['malformed', { path: ROOT_PKG, text: '{' }, /^fix the file$/u, false],
    ['not text', { path: ROOT_PKG, text: '{"a": "\u0000"}' }, /^fix the file$/u, false],
    ['past the input cap at population', { path: ROOT_PKG, state: 'oversize' }, /smaller or simpler/u, false],
    ...(['inputBytes', 'outputRows', 'outputBytes', 'outputDepth'] as const).map((limit): [string, Realized, RegExp, boolean] =>
      [`past ${limit}`, { path: ROOT_PKG, text: `{"${limit}": 1}` }, /^make the file smaller or simpler/u, false]),
    ['stopped by the time cap', { path: ROOT_PKG, text: '{"timeMs": 1}' }, /^run again; .*smaller or simpler/u, true],
    ...(['heapMb', 'stackMb'] as const).map((limit): [string, Realized, RegExp, boolean] =>
      [`stopped by ${limit}`, { path: ROOT_PKG, text: `{"${limit}": 1}` }, /^make the file smaller or simpler/u, false]),
    ['a worker death', { path: ROOT_PKG, text: '{"died": 1}' }, /^run again$/u, true],
    ['changed under the run', { path: ROOT_PKG, text: '{"is": 2}', recorded: keyContent('{"was": 1}', 'none').key }, /^run again, after stopping whatever is writing the file$/u, true],
    ['gone under the run', { path: ROOT_PKG, state: 'deferred' }, /^run again, after stopping whatever is writing the file$/u, true],
    ['permission refused', { path: ROOT_PKG, state: 'unreadable', faultClass: 'refused' }, /^grant read permission on the file$/u, false],
    ['busy', { path: ROOT_PKG, state: 'unreadable', faultClass: 'busy' }, /^wait for whatever holds the file/u, true],
  ])('%s: one remedy for the finding and the refusal, never routing it away', async (_name, root, remedy, retryable) => {
    const answer = await rootInputAnswer(rootFailing(root));
    expect(answer.remedy).toMatch(remedy);
    expect(answer.remedy).not.toContain(EXCLUDE);
    expect(answer.refusalRemedy).toBe(answer.remedy);
    expect(answer.retryable).toBe(retryable);
  });

  it('a pnpm-workspace.yaml pnpm reads is a root input too', async () => {
    const result = staged(await stage([{ path: ROOT_PKG, text: '{"packageManager": "pnpm@9.0.0"}' }, { path: 'pnpm-workspace.yaml', text: 'packages: [\n' }], { demand: WORKSPACE }));
    const defect = result.defects.find((entry) => entry.path === 'pnpm-workspace.yaml');
    expect(defect?.remedy).toBe('fix the file');
    expect(result.workspace).toMatchObject({ outcome: 'refused', refusal: { code: 'WORKSPACE_ROOT_NO_ROWS', remedy: 'fix the file', retryable: false } });
  });

  it('a member package.json keeps the generic remedy, which may route it away', async () => {
    const result = staged(await stage([{ path: ROOT_PKG, text: '{"workspaces": ["packages/*"]}' }, { path: MEMBER, text: '{' }], { demand: WORKSPACE }));
    expect(result.defects.map((entry) => entry.path)).toStrictEqual([MEMBER]);
    expect(result.defects[0]?.remedy).toContain(EXCLUDE);
  });

  it('with no workspace relation named, the root package.json is an ordinary routed file', async () => {
    const result = staged(await stage([{ path: ROOT_PKG, text: '{' }], { demand: { ...WORKSPACE_AND_NODES, workspace: false } }));
    expect(result.defects[0]?.remedy).toContain(EXCLUDE);
  });
});

describe('which routed files a run reports', () => {
  const files: Realized[] = [
    { path: ROOT_PKG, text: '{"workspaces": ["packages/*"]}' },
    { path: MEMBER, text: '{' },
    { path: 'tsconfig.json', text: '{' },
  ];

  it('names only the files the workspace step declared when the statements name only workspace_* relations', async () => {
    const result = staged(await stage(files, { demand: WORKSPACE }));
    expect(result.defects.map((entry) => entry.path)).toStrictEqual([MEMBER]);
  });

  it('names every routed file when a statement also names a data__* relation', async () => {
    const result = staged(await stage(files, { demand: WORKSPACE_AND_NODES }));
    expect(result.defects.map((entry) => entry.path)).toStrictEqual([MEMBER, 'tsconfig.json']);
  });
});
