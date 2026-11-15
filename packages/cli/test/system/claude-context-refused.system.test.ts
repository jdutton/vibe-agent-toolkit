/**
 * `vat claude context` over a tree holding a rules file whose facts the run
 * refused: the answer names it and the run does not end 0.
 *
 * The seed is a path-scoped rule pushed one import past the default
 * `outputRows` cap, so the worker stops its read with no test-only limit in
 * play. Its `paths:` were never read, so whether it loads is unknown — and
 * reading it as paths-less charged it to every launch, under exit 0.
 *
 * A temp tree, not this repository: the claim is about a refused file, and this
 * repository holds none.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createIsolatedScratch,
  executeCli,
  getBinPath,
  isolatedScratchEnv,
  writeFileTree,
} from './test-common.js';

/** The rule the worker refuses. */
const REFUSED_RULE = '.claude/rules/scoped.md';

/**
 * One import more than the default `outputRows` cap (16,384) allows a single
 * read to produce. A literal because the resolver is not public API; if the
 * default ever rises, the rule is read in full and every assertion below goes
 * RED — the literal cannot make this test pass vacuously.
 */
const PAST_THE_CAP = Array.from({ length: 16_385 }, (_, index) => `@a${index}.md`).join('\n');

let scratch: string;
let tree: string;
let binPath: string;

beforeAll(() => {
  binPath = getBinPath(import.meta.url);
  scratch = createIsolatedScratch('vat-claude-context-refused-');
  tree = safePath.join(scratch, 'tree');
  writeFileTree(tree, {
    'CLAUDE.md': '# Root\n',
    [REFUSED_RULE]: `---\npaths: ['src/**/*.ts']\n---\n\n${PAST_THE_CAP}\n`,
    'src/index.ts': 'export {};\n',
    'docs/readme.md': '# Readme\n',
  });
});

afterAll(() => {
  cleanupTestTempDir(scratch);
});

/** Run `vat claude context` in the tree. */
function contextIn(args: readonly string[]): ReturnType<typeof executeCli> {
  return executeCli(binPath, ['claude', 'context', ...args], { cwd: tree, env: isolatedScratchEnv(scratch) });
}

describe('vat claude context over a refused rules file', () => {
  it('names it refused, charges nothing for it, and exits 1', async () => {
    const result = await contextIn(['docs', '--format', 'json']);
    const envelope = JSON.parse(result.stdout) as {
      answers: Array<{ rows: Array<{ path: string }>; refused: Array<{ path: string; code: string }> }>;
    };
    const [answer] = envelope.answers;

    expect(answer?.rows.map((row) => row.path)).toEqual(['CLAUDE.md']);
    expect(answer?.refused.map(({ path, code }) => ({ path, code })))
      .toEqual([{ path: REFUSED_RULE, code: 'RESOURCE_PARSE_LIMIT_EXCEEDED' }]);
    expect(result.stderr).toContain('RESOURCE_PARSE_LIMIT_EXCEEDED');
    expect(result.status).toBe(1);
  });

  it('prints refused: <code> in the text rendering and in the --all map', async () => {
    const text = await contextIn(['docs']);
    const map = await contextIn(['--all']);

    expect(text.stdout).toContain(`${REFUSED_RULE}  refused: RESOURCE_PARSE_LIMIT_EXCEEDED`);
    expect(text.status).toBe(1);
    expect(map.stdout).toContain(`${REFUSED_RULE}  refused: RESOURCE_PARSE_LIMIT_EXCEEDED`);
    expect(map.status).toBe(1);
  });
});
