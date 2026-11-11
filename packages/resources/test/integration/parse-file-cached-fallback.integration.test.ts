/**
 * `parseFileCached` never parses on the calling thread: every miss is ONE
 * bounded parse in the worker pool — so the answer is the worker's, the one a
 * crawl gives and files, and a skill lane's verdict never depends on whether a
 * crawl warmed the cache first (ADR I0), nor on the calling thread's stack.
 *
 * When the calling thread parsed, its stack overflow WAS the answer: a document
 * the worker parses was refused cold and admitted warm (served the crawl's facts).
 *
 * The BUILT module runs in a child process whose main-thread stack is shrunk
 * with `--stack-size`, so the in-process overflow is certain at a depth the
 * worker (its stack set by `resourceLimits`) parses in milliseconds — never a
 * depth that sits between one host's stack and another's. The child's
 * `TMPDIR` is fresh, so its parse cache is cold.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BUILT_INDEX = pathToFileURL(safePath.resolve(import.meta.dirname, '..', '..', 'dist', 'index.js')).href;

/** What the child's one `parseFileCached` call came to. */
type Outcome = { ok: true; blockquotes: number } | { ok: false; name: string; limit: string | null };

let scratch: string;

/**
 * Parse one document with the built `parseFileCached`, in a child whose main
 * thread has a small stack, cold or after an earlier child filed it.
 *
 * @param content - The document
 * @param name - Its file name under scratch (one cache per scratch, shared by every call)
 * @returns What the call returned or threw
 */
function parseInChild(content: string, name: string): Outcome {
  const file = safePath.join(scratch, name);
  writeFileSync(file, content, 'utf-8');
  const script = [
    `const { parseFileCached } = await import(${JSON.stringify(BUILT_INDEX)});`,
    `const outcome = await parseFileCached(${JSON.stringify(file)}, 'markdown').then(`,
    "  (result) => ({ ok: true, blockquotes: result.content.split('>').length - 1 }),",
    '  (error) => ({ ok: false, name: error.name, limit: error.limit ?? null }),',
    ');',
    'console.log(JSON.stringify(outcome));',
  ].join('\n');
  // A script FILE, not `--eval`: a worker inherits its parent's execArgv, and
  // `--input-type` is refused by a worker started from a file.
  const entry = safePath.join(scratch, `${name}.mjs`);
  writeFileSync(entry, script, 'utf-8');
  const child = spawnSync(process.execPath, ['--stack-size=250', entry], {
    env: { ...process.env, TMPDIR: safePath.join(scratch, 'tmp'), TEMP: safePath.join(scratch, 'tmp'), TMP: safePath.join(scratch, 'tmp') },
    encoding: 'utf-8',
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout) as Outcome;
}

describe('parseFileCached under a calling-thread stack too small for the document', () => {
  beforeAll(() => {
    scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-parse-fallback-'));
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('admits a document the worker parses, cold and warm alike', () => {
    const document = `${'>'.repeat(3000)} deep\n`;

    expect(parseInChild(document, 'blockquotes.md')).toStrictEqual({ ok: true, blockquotes: 3000 });
    // Warm: the cold parse filed the worker's facts, and a hit gives the same answer.
    expect(parseInChild(document, 'blockquotes.md')).toStrictEqual({ ok: true, blockquotes: 3000 });
  });

  it('refuses a document over the worker\'s limits, cold and warm alike, with the worker\'s refusal', () => {
    // 20,000 nested lists: past `outputDepth` in the worker, and far past this
    // thread's stack — the overflow is never the answer.
    const document = `---\na: ${'['.repeat(20_000)}${']'.repeat(20_000)}\n---\n# Deep\n`;

    const cold = parseInChild(document, 'frontmatter.md');
    expect(cold).toMatchObject({ ok: false, name: 'ParseLimitError' });
    expect(parseInChild(document, 'frontmatter.md')).toStrictEqual(cold);
  });
});
