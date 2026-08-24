/**
 * What a `vat` invocation is allowed to LOAD.
 *
 * The startup work this pins is invisible to every other kind of test: the CLI
 * behaves identically whether or not it loaded the markdown toolchain first, so
 * a careless module-scope `import` re-adds ~2 seconds with every existing test
 * still green. That is not hypothetical — it is exactly what happened. The
 * parser deferral inside `parse-cache.ts` bought nothing at all for a while,
 * because `resources/index.ts` value-exported `parseMarkdown`, and nothing
 * noticed until someone measured by hand.
 *
 * ## Why module loads and not elapsed time
 *
 * A timing assertion is the obvious alternative and the wrong one: it is
 * flaky on shared CI, it needs a threshold nobody can justify, and it fails for
 * reasons that have nothing to do with the property. "Was this module loaded?"
 * is a fact, and it is the fact the optimisation is actually about.
 *
 * ## How
 *
 * `NODE_V8_COVERAGE=<dir>` makes Node write one JSON file per process listing
 * every script it loaded, by URL. Spawn the real built CLI, read the list, and
 * assert what is in it.
 *
 * ## Reading a failure
 *
 * A failure here is not "the test is broken" — it means an import was added
 * that every `vat` invocation now pays for. Find it with the reported URL and
 * either defer it behind `await import(...)` at its use site, or make the
 * export a lazy wrapper (see `parseMarkdown` in `resources/src/index.ts`).
 *
 * The warm-scan case is the one that fails for a second reason: an `await
 * loadParser(...)` hoisted above a per-document loop, to keep a broken install
 * from being blamed on documents. That is a real problem with a different fix —
 * rethrow `ParserUnavailableError` from the catch (`isParserUnavailable`) — and
 * hoisting it has already cost this saving twice.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- every path here is a temp dir this test created and owns */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, it, expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = safePath.resolve(__dirname, '../../dist/bin.js');
const repoRoot = safePath.resolve(__dirname, '../../../..');

/**
 * The markdown toolchain, and the module that drags it in.
 *
 * `parse5` is deliberately NOT here, and its absence is a statement of fact
 * rather than an oversight: `html-transform.ts` imports `html-link-parser.js`
 * statically for `rewriteHtmlLinks`, which is synchronous and so cannot become
 * a lazy wrapper without changing its signature. parse5 therefore still loads
 * eagerly — ~38ms, against remark's ~730ms. Adding it to this list would fail
 * immediately; making it pass needs `rewriteHtmlLinks` to go async first.
 */
const PARSER_NEEDLES = ['remark-parse', 'resources/dist/link-parser.js'] as const;

/**
 * One module per command, reachable ONLY through that command's loader.
 *
 * These are what makes the per-command dispatch observable: nothing else in the
 * CLI imports them, so "did `commands/audit.js` load?" answers "did the loader
 * table get walked, or was one entry called?" and nothing else. Each is a file
 * that exists on disk today — `commands/audit.js` is a sibling of the
 * `commands/audit/` DIRECTORY, and the `.js` in the needle is what keeps the two
 * apart.
 *
 * A wrong needle here would make every "is absent" assertion below pass
 * vacuously, which is why the root-`--help` case asserts these same strings are
 * PRESENT. Get one wrong and that case goes red rather than the others going
 * quietly green.
 */
/**
 * The corpus every parsing case here scans.
 *
 * One constant because three cases must scan the SAME tree: the cold/warm pair
 * below is only evidence if both runs did identical work, and the `VAT_CACHE=0`
 * control is only a control for them if it parses the same documents.
 */
const SCAN_ARGS = ['resources', 'scan', 'docs/contributing'] as const;

/**
 * The resources barrel — the module the parser hides BEHIND.
 *
 * Asserted absent for `--version` and present everywhere the parser's absence is
 * the claim: "the barrel loaded and the parser did not" is the whole property,
 * and without the first half it is satisfied by a run that loaded nothing.
 */
const BARREL_NEEDLE = 'resources/dist/index.js';

const COMMAND_NEEDLES = {
  audit: 'cli/dist/commands/audit.js',
  inventory: 'cli/dist/commands/inventory.js',
  rag: 'cli/dist/commands/rag/index.js',
} as const;

/**
 * Run the CLI and report every script URL Node loaded.
 *
 * @param args - Arguments to pass to the CLI
 * @param extraEnv - Environment overrides for the spawned process
 * @returns The loaded script URLs, and the process result
 */
function loadedScripts(
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): { urls: string[]; status: number | null } {
  // mkdtempSync, never a `/tmp/...` literal — that has no drive letter and is
  // not absolute on Windows, where this suite also runs. normalizedTmpdir()
  // rather than os.tmpdir() for the same reason: 8.3 short names (RUNNER~1).
  const covDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-modload-'));
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- node is required for CLI integration tests
    const result = spawnSync('node', [binPath, ...args], {
      encoding: 'utf-8',
      cwd: repoRoot,
      env: { ...process.env, ...extraEnv, NODE_V8_COVERAGE: covDir },
    });

    const urls: string[] = [];
    for (const file of readdirSync(covDir)) {
      const parsed: unknown = JSON.parse(readFileSync(safePath.join(covDir, file), 'utf-8'));
      const { result: scripts } = parsed as { result?: { url?: string }[] };
      for (const script of scripts ?? []) if (script.url) urls.push(script.url);
    }
    return { urls, status: result.status };
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }
}

/**
 * Assert the markdown toolchain was NOT loaded.
 *
 * Shared by every case that pins an absence, so the needle list is applied one
 * way in one place. It deliberately asserts nothing about what WAS loaded:
 * every caller states its own positive control first, because an empty `urls`
 * would satisfy this function completely.
 *
 * @param urls - Every script URL the invocation loaded
 */
function expectParserAbsent(urls: readonly string[]): void {
  for (const needle of PARSER_NEEDLES) {
    expect(urls.filter(url => url.includes(needle))).toEqual([]);
  }
}

/**
 * Every `src/*.ts` under `packages/`, as absolute paths.
 *
 * Walks the packages directory rather than reading a hardcoded list: a list is
 * a second thing to keep in step with the tree, and the one failure mode that
 * matters here is a call appearing in a file nobody thought to enumerate.
 *
 * @returns Absolute paths of every TypeScript source file in every package
 */
function packageSourceFiles(): string[] {
  const packagesDir = safePath.join(repoRoot, 'packages');
  const files: string[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    const srcDir = safePath.join(packagesDir, pkg, 'src');
    if (!existsSync(srcDir)) continue;
    for (const entry of readdirSync(srcDir, { recursive: true, encoding: 'utf-8' })) {
      if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        files.push(safePath.join(srcDir, entry));
      }
    }
  }
  return files;
}

/**
 * Which package sources contain `needle` in CODE, reported repo-relative.
 *
 * Comment-only lines are dropped first: the call sites this pins carry long
 * comments explaining why they do NOT hoist a load, and several name the
 * function they are not calling. A scan that could not tell those apart from a
 * real call would fail on its own documentation.
 *
 * @param needle - The code fragment to look for
 * @returns Repo-relative paths, sorted, of every source file whose code has it
 */
function sourceFilesCalling(needle: string): string[] {
  const hits: string[] = [];
  for (const file of packageSourceFiles()) {
    const code = readFileSync(file, 'utf-8')
      .split('\n')
      .filter(line => {
        const trimmed = line.trimStart();
        return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
      })
      .join('\n');
    if (code.includes(needle)) hits.push(toForwardSlash(safePath.relative(repoRoot, file)));
  }
  return hits.sort((a, b) => a.localeCompare(b));
}

describe('module load budget (integration)', () => {
  it('`--version` loads neither the resources package nor the markdown parser', () => {
    const { urls, status } = loadedScripts(['--version']);

    // Positive control FIRST. An unwritten or unparsed coverage file yields an
    // empty list, and every "is absent" assertion below would then pass by
    // absence — the failure mode this whole file exists to prevent elsewhere.
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some(url => url.includes('cli/dist/bin.js'))).toBe(true);
    expect(status).toBe(0);

    expectParserAbsent(urls);
    expect(urls.filter(url => url.includes(BARREL_NEEDLE))).toEqual([]);
  });

  it('a command that actually parses DOES load the parser, so the check can distinguish', () => {
    // The negative control for the assertions above: if `--version` passing
    // were an artifact of the needles never matching anything, this fails too.
    //
    // `VAT_CACHE=0` is load-bearing. With the cache warm every document is a
    // hit, nothing is parsed, and the parser is legitimately never imported —
    // which is the whole point of the deferral, and would make this control
    // pass for the wrong reason on a cold machine and fail on a warm one.
    const { urls } = loadedScripts(SCAN_ARGS, { VAT_CACHE: '0' });

    expect(urls.length).toBeGreaterThan(0);
    for (const needle of PARSER_NEEDLES) {
      expect(urls.some(url => url.includes(needle))).toBe(true);
    }
  });

  it('a SECOND scan of the same corpus loads no parser at all', () => {
    // THE case this file was missing, and the whole reason a regression shipped:
    // the properties above are all about invocations that parse nothing, and the
    // warm-run claim — "every document is a cache hit, so the parser is never
    // imported" — was stated in the prose of the case below and tested nowhere.
    // Two hoists of `loadParser` above the parse cache's hit-path return have
    // since made a fully warm scan load the parser again with every existing
    // test still green. Measured at the time of writing: 1,235 scripts cold
    // against 1,049 warm, and ~1.0s of wall clock on a 184-document corpus.
    //
    // A PRIVATE temp dir, so the cache state under test belongs to this test.
    // `os.tmpdir()` reads TMPDIR on POSIX and TEMP/TMP on Windows, and VAT's
    // cache root is `<tmpdir>/.vat-cache` — so setting all three makes the first
    // run genuinely cold no matter what else has run on this machine, and leaves
    // the shared cache untouched. Without it the "cold" run below could be a
    // warm one, and its positive control would be the thing that failed.
    const cacheHome = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-warmscan-'));
    const privateTmp = { TMPDIR: cacheHome, TEMP: cacheHome, TMP: cacheHome };
    try {
      const cold = loadedScripts(SCAN_ARGS, privateTmp);

      // Positive control, and it is doing two jobs: the run has to have
      // succeeded AND to have actually parsed, or "warm" below means nothing —
      // an empty cache directory and a fully warm one both produce zero parses
      // if the scan itself did no work.
      expect(cold.status).toBe(0);
      expect(cold.urls.length).toBeGreaterThan(0);
      for (const needle of PARSER_NEEDLES) {
        expect(cold.urls.some(url => url.includes(needle))).toBe(true);
      }

      const warm = loadedScripts(SCAN_ARGS, privateTmp);

      // The second positive control: the warm run did the same work — same
      // command, same corpus, exit 0, the resources barrel loaded — so the
      // absence below is the parser being skipped and not the scan being skipped.
      expect(warm.status).toBe(0);
      expect(warm.urls.length).toBeGreaterThan(0);
      expect(warm.urls.some(url => url.includes(BARREL_NEEDLE))).toBe(true);

      expectParserAbsent(warm.urls);
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it('a command that DOES load the resources barrel still does not load the parser', () => {
    // The property `resources/src/index.ts` is actually about, pinned here for
    // the first time. Its ⚠️ block names THIS FILE as what fails if
    // `parseMarkdown` goes back to a plain value re-export — and that was false:
    // the `--version` cases never load `resources/dist/index.js` at all, so what
    // the barrel statically imports cannot affect them either way. Only an
    // invocation that loads the barrel can see the difference.
    //
    // `resources --help` is the cheapest such invocation. Commander renders the
    // subcommand list and parses no document, so unlike the case above no
    // `VAT_CACHE` setting is needed — there is no cache state that could decide
    // whether the parser loads.
    const { urls, status } = loadedScripts(['resources', '--help']);

    // Positive control FIRST, and here it carries the whole case: assert the
    // barrel WAS loaded before asserting the parser behind it was not.
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some(url => url.includes(BARREL_NEEDLE))).toBe(true);
    expect(status).toBe(0);

    expectParserAbsent(urls);
  });

  it('a known verb loads ONLY its own command module', () => {
    // The headline claim of the per-command dispatch, and nothing pinned it
    // before this case: both `--version` cases short-circuit at `versionOnly`
    // BEFORE reaching the `Object.hasOwn(COMMAND_LOADERS, ...)` branch, so
    // replacing that whole branch with the load-everything loop left every other
    // case in this file green while the saving silently reverted.
    //
    // `inventory` is the subject because it is an ordinary table entry — not the
    // `doctor` special case — and `--help` exercises the dispatch without
    // running a scan.
    const { urls, status } = loadedScripts(['inventory', '--help']);

    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some(url => url.includes(COMMAND_NEEDLES.inventory))).toBe(true);
    expect(status).toBe(0);

    // The other thirteen table entries must not have loaded. Two stand in for
    // the rest: one plain module, one whose loader pulls in a whole subtree.
    expect(urls.filter(url => url.includes(COMMAND_NEEDLES.audit))).toEqual([]);
    expect(urls.filter(url => url.includes(COMMAND_NEEDLES.rag))).toEqual([]);
  });

  it('root `--help` DOES load the whole tree, so the case above can distinguish', () => {
    // The negative control for the case above, and the guard on the needles
    // themselves. Root help has to list every command, so it registers all of
    // them; if `COMMAND_NEEDLES` ever names a path that no longer exists — a
    // renamed module, a command moved into a directory of its own — this case
    // goes red, rather than the absence assertions above passing because nothing
    // could ever have matched them.
    const { urls, status } = loadedScripts(['--help']);

    expect(urls.length).toBeGreaterThan(0);
    expect(status).toBe(0);
    for (const needle of Object.values(COMMAND_NEEDLES)) {
      expect(urls.some(url => url.includes(needle))).toBe(true);
    }
  });

  it('nothing outside the parse cache calls `loadParser`', () => {
    // The warm-scan case above can only see the lane it drives — the resource
    // registry. The regression it exists to catch appeared at FIVE call sites
    // across four packages at once, and the four others (blob derivation, skill
    // link traversal, the parse-fact oracle, rag indexing) are reached by
    // commands this suite does not run. So the same property is also pinned
    // structurally: the ONLY place allowed to ask for a parser is the parse
    // cache itself, past its hit-path return.
    //
    // A source scan rather than a behavioural one, deliberately. Driving four
    // more lanes would be four more slow spawns and would still miss the fifth
    // the day it is added, whereas "who may call this function" is decidable by
    // reading, and a new caller is exactly the diff that regressed twice.
    const callers = sourceFilesCalling('loadParser(');

    // Positive control FIRST, and it does two jobs: a walk that found nothing
    // (a moved `src/`, a broken glob) would otherwise report a clean tree, and
    // a needle that matches nothing would too.
    expect(callers.length).toBeGreaterThan(0);
    expect(callers).toEqual(['packages/resources/src/parse-cache.ts']);
  });

  it('the always-on cache-control registration stays off the heavy path', () => {
    // `registerCacheControl` runs on EVERY invocation before parsing. It lived
    // in `commands/cache/index.ts`, which imports `./clear.js` and the
    // resources package behind it — ~1.2s paid even by `--version`.
    const { urls } = loadedScripts(['--version']);

    expect(urls.some(url => url.includes('cache/cache-control.js'))).toBe(true);
    expect(urls.filter(url => url.includes('cache/clear.js'))).toEqual([]);
  });
});
