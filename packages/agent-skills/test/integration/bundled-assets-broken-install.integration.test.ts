/**
 * Bundled assets reach the parser through ONE dispatcher, as a crawl's files
 * do — so the pool's broken-install breaker (three thread deaths in a row, no
 * answer between them) can trip, and a build on a broken install fails as the
 * install's fault (`ParserUnavailableError`).
 *
 * Before, `registerBundledAssets` admitted each asset with its own
 * `addResource`, so each got its own one-shot pool: every pool saw exactly one
 * death, never three, and the build refused the FIRST asset as a document whose
 * parse worker died — blaming a file for the install.
 *
 * The worker entry is pointed at a thread that loads and then dies on every
 * job (`__setParseWorkerEntryForTest`, on the BUILT module the package under
 * test imports). The skill's own SKILL.md is parsed first with the real
 * worker, so the crawl is a cache hit and the assets are the first parses the
 * dying thread meets.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { isParserUnavailable, parseFileCached } from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import { createFrontmatter, packageInPlace } from '../test-helpers.js';

/** The built pool module — the instance `@vibe-agent-toolkit/resources` itself imports. */
const BUILT_POOL = pathToFileURL(safePath.resolve(import.meta.dirname, '..', '..', '..', 'resources', 'dist', 'parse-pool.js')).href;

interface PoolTestSeam {
  __setParseWorkerEntryForTest(entry: string | null): void;
}

const ASSETS = ['a.html', 'b.html', 'c.html', 'd.html'];

let scratch: string | undefined;
let seam: PoolTestSeam | undefined;

afterEach(() => {
  seam?.__setParseWorkerEntryForTest(null);
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe('registerBundledAssets on a broken install', () => {
  it('fails the build as parser-unavailable, not as a refusal blamed on the first asset', async () => {
    const dir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-bundled-broken-'));
    scratch = dir;
    // Unique bytes per run, so no earlier run's cache entry answers for them.
    const nonce = randomUUID();
    for (const asset of ASSETS) {
      writeFileSync(safePath.join(dir, asset), `<html><body><p>${asset} ${nonce}</p></body></html>\n`, 'utf-8');
    }
    const links = ASSETS.map((asset) => `- [${asset}](${asset})`).join('\n');
    const skillPath = safePath.join(dir, 'SKILL.md');
    const frontmatter = createFrontmatter({ name: 'broken-install', description: 'Uses its pages ' + nonce });
    writeFileSync(skillPath, `${frontmatter}\n\n# Pages\n\n${links}\n`, 'utf-8');
    await parseFileCached(skillPath, 'markdown');

    const entry = safePath.join(dir, 'dying-worker.mjs');
    writeFileSync(
      entry,
      "import { parentPort } from 'node:worker_threads';\nparentPort.postMessage({ ready: true });\nparentPort.on('message', () => { process.exit(3); });\n",
      'utf-8',
    );
    seam = (await import(BUILT_POOL)) as PoolTestSeam;
    seam.__setParseWorkerEntryForTest(entry);

    const outcome = await packageInPlace(skillPath, { outputPath: safePath.join(dir, 'out') }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(isParserUnavailable(outcome), String(outcome)).toBe(true);
  });
});
