/**
 * A parse thread takes its collector under V8's process-wide `--expose-gc`, and clears the flag
 * again: no context the host creates afterwards has a `gc`, and the code-cache tag is unchanged.
 * Set, acquire and clear run under the pool's lock, so threads started at once never clear it from
 * under one another. Each case runs in a child process, because the flag is process-wide.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';
import { describe, expect, inject, it } from 'vitest';

const BUILT_POOL = pathToFileURL(safePath.resolve(import.meta.dirname, '..', '..', 'dist', 'parse-pool.js')).href;
/** What `parse-worker.ts` throws when it is evaluated on a main thread, as every `require()` of it is. */
const WORKER_MAIN_THREAD_GUARD =
  "VAT's parse worker is a worker-thread entry point and cannot run on the main thread. Use createParsePool() from parse-pool.js instead.";
const BUILT_COLLECTOR = pathToFileURL(safePath.resolve(import.meta.dirname, '..', '..', 'dist', 'parse-collector.js')).href;
/** This package's build; a child joins each parse-thread module's name onto it. */
const BUILT_DIST = safePath.resolve(import.meta.dirname, '..', '..', 'dist');

/**
 * The modules a parse thread's `import()`s load, as paths under `dist/`: the worker's
 * entry, whose static graph `require()` walks whole, and each `import()` in `parser-loader.ts`,
 * read from that file so a new one is checked without anyone listing it. That is what is checked:
 * a dynamic `import()` written anywhere else in the worker's graph is not followed.
 *
 * Read from the syntax tree, not the text: every `import()` call in the file must name a relative
 * string literal, or the test fails — a specifier this cannot read never passes unchecked, and a
 * comment never hides or invents one.
 */
function parseThreadModules(): string[] {
  const path = safePath.resolve(import.meta.dirname, '..', '..', 'src', 'parser-loader.ts');
  const tree = ts.createSourceFile(path, readFileSync(path, 'utf-8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const loaded: string[] = [];
  const unreadable: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      const relative = specifier !== undefined && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('./');
      if (relative) loaded.push(specifier.text.slice(2));
      else unreadable.push(node.getText(tree));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  expect(unreadable, 'an import() in parser-loader.ts that is not a relative string literal').toStrictEqual([]);
  expect(loaded.length).toBeGreaterThan(0);
  return ['parse-worker.js', ...loaded];
}

/**
 * Run `script` as an ES module in a child process with no `NODE_OPTIONS`, and read the JSON line it prints.
 *
 * @param script - The module's source
 * @returns What it printed, parsed
 */
function runChild(script: string): Record<string, unknown> {
  const directory = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-collector-'));
  const entry = safePath.join(directory, 'collector.mjs');
  writeFileSync(entry, script, 'utf-8');
  const env = { ...process.env };
  delete env['NODE_OPTIONS'];
  // `spawnSync` blocks the loop the test's own timeout runs on, so a hung child is bounded here.
  const child = spawnSync(process.execPath, [entry], { env, encoding: 'utf-8', timeout: inject('tierTestTimeout') });
  rmSync(directory, { recursive: true, force: true });

  expect(child.signal, `the child was killed: a hang past the tier timeout, or a V8 fatal error\n${child.stderr}`).toBeNull();
  expect(child.stderr).toBe('');
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout) as Record<string, unknown>;
}

describe('a parse thread\'s collector', () => {
  it('leaves no `gc` in a context the host creates after the pool ran, and the code-cache tag as it was', () => {
    const outcome = runChild([
      "import v8 from 'node:v8';",
      "import vm from 'node:vm';",
      `const { createParsePool } = await import(${JSON.stringify(BUILT_POOL)});`,
      'const tag = v8.cachedDataVersionTag();',
      'const pool = createParsePool({ size: 4 });',
      String.raw`await Promise.all(Array.from({ length: 8 }, (_, i) => pool.parse('markdown', '# ' + i + '\n', 4)));`,
      'await pool.shutdown();',
      "console.log(JSON.stringify({ sameTag: v8.cachedDataVersionTag() === tag, hostContextGc: vm.runInNewContext('typeof gc') }));",
    ].join('\n'));

    expect(outcome).toStrictEqual({ sameTag: true, hostContextGc: 'undefined' });
  });

  it('is had by every one of 16 threads started at once, over five rounds, under the shared lock', () => {
    // Static imports, never a top-level `await`: Node 22 aborts the whole process (V8
    // `Check failed: (location_) != nullptr` in `ExecuteAsyncModule`) when a worker is terminated
    // while an async module is still settling, about one run in six with no collector involved. The
    // worker's static graph and parser-loader's `import()`s have no top-level `await` (pinned by the
    // last case here), so this is the test's shape, never the product's.
    const workerBody = [
      `import { acquireCollector } from ${JSON.stringify(BUILT_COLLECTOR)};`,
      "import { parentPort, workerData } from 'node:worker_threads';",
      "parentPort.postMessage(acquireCollector(new Int32Array(workerData.lock), 2000) === null ? 'none' : 'collector');",
    ].join('\n');
    const outcome = runChild([
      "import { Worker } from 'node:worker_threads';",
      'const lock = new SharedArrayBuffer(4);',
      `const body = ${JSON.stringify(workerBody)};`,
      'const tally = { collector: 0, none: 0 };',
      'for (let round = 0; round < 5; round++) {',
      '  const answers = await Promise.all(Array.from({ length: 16 }, () => new Promise((resolve) => {',
      "    const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(body)), { workerData: { lock } });",
      "    worker.once('message', (answer) => { resolve(answer); void worker.terminate(); });",
      '  })));',
      '  for (const answer of answers) tally[answer] += 1;',
      '}',
      'console.log(JSON.stringify(tally));',
    ].join('\n'));

    expect(outcome).toStrictEqual({ collector: 80, none: 0 });
  });

  it('takes the lock from a holder that kept it past its stale time, and frees it and the flag after', () => {
    const outcome = runChild([
      "import vm from 'node:vm';",
      `const { acquireCollector } = await import(${JSON.stringify(BUILT_COLLECTOR)});`,
      'const lock = new Int32Array(new SharedArrayBuffer(4));',
      '// A holder that died holding it: never released.',
      'lock[0] = 424242;',
      'const collect = acquireCollector(lock, 50);',
      "console.log(JSON.stringify({ collector: typeof collect, lock: lock[0], contextGc: vm.runInNewContext('typeof gc') }));",
    ].join('\n'));

    expect(outcome).toStrictEqual({ collector: 'function', lock: 0, contextGc: 'undefined' });
  });

  it('evaluates the worker\'s static graph and every parser-loader import() synchronously: a top-level await would let a terminate abort Node 22', () => {
    // `require()` of an ES module refuses one with a top-level `await` (`ERR_REQUIRE_ASYNC_MODULE`)
    // and evaluates any other synchronously. The pool terminates threads mid-load (a load-clock
    // stop, a shutdown), and on Node 22 terminating a thread while an async module settles aborts
    // the whole process.
    //
    // Every loaded module must answer `ok`, and the parse worker exactly its own main-thread guard,
    // so any other failure (a moved module's `MODULE_NOT_FOUND`, a link error) is red. The
    // positive control has the worker's shape: an entry that throws while it evaluates, over a
    // dependency with a top-level `await`, so the check is shown to fire before evaluation.
    const modules = parseThreadModules();
    const outcome = runChild([
      "import { createRequire } from 'node:module';",
      "import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { join } from 'node:path';",
      'const require = createRequire(import.meta.url);',
      "const planted = mkdtempSync(join(tmpdir(), 'vat-tla-'));",
      String.raw`writeFileSync(join(planted, 'dep.mjs'), 'await Promise.resolve();\nexport const x = 1;\n');`,
      String.raw`writeFileSync(join(planted, 'entry.mjs'), "import './dep.mjs';\nthrow new Error('the entry throws, as the parse worker does');\n");`,
      "const codeOf = (file) => { try { require(file); return 'ok'; } catch (error) { return error.code ?? error.message; } };",
      `const dist = ${JSON.stringify(BUILT_DIST)};`,
      `const modules = ${JSON.stringify(modules)};`,
      "const verdict = { planted: codeOf(join(planted, 'entry.mjs')), codes: Object.fromEntries(modules.map((name) => [name, codeOf(join(dist, name))])) };",
      'rmSync(planted, { recursive: true, force: true });',
      'console.log(JSON.stringify(verdict));',
    ].join('\n'));

    expect(outcome).toStrictEqual({
      planted: 'ERR_REQUIRE_ASYNC_MODULE',
      codes: Object.fromEntries(
        modules.map((name) => [name, name === 'parse-worker.js' ? WORKER_MAIN_THREAD_GUARD : 'ok']),
      ),
    });
  });
});
