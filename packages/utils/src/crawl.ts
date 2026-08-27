/**
 * @vibe-agent-toolkit/utils/crawl
 *
 * Directory crawling (`crawlDirectory`, `crawlDirectorySync`) plus the
 * never-crawl / build-output glob constants. Node-only — reads the filesystem
 * and shells out to `git` for the gitignore-aware fast path.
 *
 * This is the only *subpath* entry that reaches `picomatch` — `./crawl` is
 * therefore the narrow entry that makes `picomatch` a required install. The `.`
 * barrel reaches it too, through this same `file-crawler` route.
 *
 * Deliberately NOT folded into `./glob`. `./glob` is guarded as portable —
 * `node:path` and no third-party dependency (see `test/subpath-purity.test.ts`)
 * — and file-crawler would break both halves of that guarantee.
 */

export * from './file-crawler.js';
