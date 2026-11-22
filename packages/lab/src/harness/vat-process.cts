/**
 * What the in-process probes share: which process is vat, and how a record is written.
 *
 * `facets/memory/rss-probe.cts` and `facets/perf/perf-probe.cts` are `--require`d
 * into every node process a measured vat launches, and each must write only for
 * vat's own. Two copies of that rule would drift (one probe counting what the
 * other skips would make the facets disagree about how many processes a run
 * had), so both call this; so do they for the collision-proof write.
 *
 * A process is vat's when its main script (`process.argv[1]`, its own links read
 * - npm's `.bin/vat` is one) belongs to one of {@link VAT_PACKAGE_NAMES}: the
 * nearest `package.json` above it names the launcher or the CLI and is not
 * `private` (the monorepo's root shares the launcher's name). Decided from the
 * install alone, so it holds for every vat ever published, and it excludes what
 * vat is not: `npm` under `npx`, a `node -e`, a tool vat spawns.
 *
 * Zero non-builtin dependencies: this is loaded by a probe that is injected into
 * a vat that may be running from an `npx:` build's install, where nothing of the
 * lab's is installed. A probe requires it by relative path, beside itself in
 * the emitted tree.
 */

import crypto = require('node:crypto');
import fs = require('node:fs');
import path = require('node:path');

/** The packages whose scripts are vat: the umbrella launcher, and the CLI it delegates to. */
const VAT_PACKAGE_NAMES: ReadonlySet<string> = new Set(['vibe-agent-toolkit', '@vibe-agent-toolkit/cli']);

/** Links read from a main script before giving up deciding - a cycle, not an install. */
const MAX_LINK_HOPS = 40;

/**
 * Say on stderr why the probe could not decide, and decide "not vat".
 *
 * A probe that could not tell must not guess vat - that would count an
 * unrelated process - and must not be silent: a repeat that then fails for
 * want of a vat record needs its cause on record.
 *
 * @param probe - The probe's name, for the line
 * @param what - What was being read
 * @param error - Why it failed
 */
function undecided(probe: string, what: string, error: unknown): false {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[vat-lab ${probe}] cannot read ${what}: ${reason}\n`);
  return false;
}

/**
 * Whether the nearest `package.json` above `file` names one of vat's packages.
 *
 * @param probe - The probe's name, for a failure line
 * @param file - A real (link-resolved) absolute path
 */
function ownedByVat(probe: string, file: string): boolean {
  let dir = path.dirname(file);
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    // `lstat`, which follows nothing; an absent manifest moves the walk up.
    if (fs.lstatSync(manifest, { throwIfNoEntry: false }) !== undefined) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
        const owner = typeof parsed === 'object' && parsed !== null ? (parsed as { name?: unknown; private?: unknown }) : {};
        // Published packages only: the monorepo's private root is named `vibe-agent-toolkit` too.
        return typeof owner.name === 'string' && VAT_PACKAGE_NAMES.has(owner.name) && owner.private !== true;
      } catch (error) {
        return undecided(probe, manifest, error);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Whether this process's main script is one of vat's.
 *
 * @param probe - The probe's name (`rss probe`), for a failure line
 * @param main - The main script as the process was started with it
 */
function isVatMainScript(probe: string, main: string | undefined): boolean {
  if (main === undefined || main === '') return false;
  let file = path.resolve(main);
  try {
    // The installed `.bin/vat` is a link into the package, and its own directory
    // owns nothing - so the script's own link is read, by its text, hop by hop.
    // A link among its ancestors needs no reading: the walk up to the nearest
    // `package.json` passes through it.
    let hops = 0;
    while (fs.lstatSync(file).isSymbolicLink()) {
      if (++hops > MAX_LINK_HOPS) throw new Error(`more than ${String(MAX_LINK_HOPS)} links`);
      file = path.resolve(path.dirname(file), fs.readlinkSync(file));
    }
  } catch (error) {
    return undecided(probe, main, error);
  }
  return ownedByVat(probe, file);
}

/**
 * Write one process's record, under a name no other process in the directory holds.
 *
 * A random suffix rather than the pid alone: pids are recycled across the
 * processes one repeat spawns, and a pid-keyed name would let a later process
 * overwrite a sibling's record. `wx` makes the impossible collision a loud
 * failure instead of a silent overwrite.
 *
 * Never throws - a measurement must not break the thing it measures - but a
 * failure is said on stderr: a missing record nobody mentioned would read as a
 * process that never ran.
 *
 * @param probe - The probe's name, for a failure line
 * @param logDir - Directory to write into: the capture's own, made before the process started
 * @param prefix - The file name's stem, naming the facet
 * @param build - Produces the record; it runs here so a throw is reported like any write failure
 */
function writeProbeRecord(probe: string, logDir: string, prefix: string, build: () => unknown): void {
  try {
    const file = path.join(logDir, `${prefix}-${String(process.pid)}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify(build()), { flag: 'wx' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[vat-lab ${probe}] failed to write record: ${reason}\n`);
  }
}

export = { isVatMainScript, writeProbeRecord, VAT_PACKAGE_NAMES };
