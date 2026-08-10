/**
 * The renderer is where an honest measurement most easily becomes a dishonest
 * claim, so this suite is mostly about what must NEVER disappear from a line.
 *
 * Three rules, each with cases below:
 *
 * 1. **No number appears without what qualifies it.** `loaderCalls` is the
 *    sharpest case: 6,371 of 6,411 calls on `vat resources scan docs/` were
 *    Node's own module loader, and the facet buckets those out of the site list.
 *    A report that showed only the 40 remaining would let a reader conclude "vat
 *    barely touches the disk", which is the opposite of true. `processes` is the
 *    same shape of hazard in reverse: 1 means the counter never propagated into
 *    vat's real binary, so the report describes the launcher alone.
 * 2. **The absence of a delta is never rendered as good news.** `unmeasurable`
 *    and `unwarranted` get their own words, and a case below proves those words
 *    are not the words `unchanged` uses.
 * 3. **They are Node `fs` and `child_process` calls, never syscalls.** One
 *    `fs.readFile` is not one syscall, and a reader who took the label literally
 *    would compare these numbers against `dtruss` output forever. A case asserts
 *    the word never appears in any output this module produces.
 */

import { describe, expect, it } from 'vitest';

import { compareIo } from '../src/facets/io/compare.js';
import { renderIoComparison, renderIoReport } from '../src/facets/io/render.js';
import type { IoCommandStats } from '../src/facets/io/types.js';

import { BUSY_LOAD, compareOneCommand, ioCommand, ioReport, ioSite } from './io-fixtures.js';
import { COORDINATE } from './report-fixtures.js';

/**
 * The real N+1 this facet was built to surface.
 *
 * Measured in vat's own code: 28 `readdir` calls over 14 distinct directories —
 * every directory read exactly twice.
 */
const N_PLUS_ONE = ioSite({
  method: 'fs.readdirSync',
  site: 'claude-marketplace/dist/inventory/extract-plugin.js:321',
  count: 28,
  distinctArgs: 14,
});

/**
 * The row that made this defect visible — a spawn site, on the real `vat audit`
 * report. Argument 0 is the binary, so no distinct-argument set is kept.
 */
const SPAWN_NO_READING = ioSite({
  method: 'child_process.spawnSync',
  site: 'packages/utils/dist/git-utils.js:60',
  count: 8,
  distinctArgs: null,
});

/**
 * Render a one-command report.
 *
 * @param over - What the case varies about the command
 * @param options - Renderer options the case varies
 * @returns The rendered text
 */
function render(
  over: Partial<IoCommandStats> = {},
  options?: Parameters<typeof renderIoReport>[1],
): string {
  return renderIoReport(ioReport([ioCommand(over)]), options);
}

/**
 * Render a comparison of two single-command reports.
 *
 * @param before - The baseline row
 * @param after - The compared row
 * @returns The rendered text
 */
function renderDiff(before: IoCommandStats, after: IoCommandStats): string {
  return renderIoComparison(compareOneCommand(before, after));
}

describe('renderIoReport — the header', () => {
  it('names the subject, its version and the instrument build', () => {
    const text = render();

    expect(text).toContain(`Subject:    ${COORDINATE.subject.id} @ aaaaaaaa`);
    expect(text).toContain('Instrument: vat 0.1.42 (11111111)');
  });

  it('marks a dirty working tree, because the bytes measured are not that commit', () => {
    const dirty = ioReport([ioCommand()], {
      coordinate: {
        ...COORDINATE,
        subjectVersion: {
          kind: 'git',
          commit: 'b'.repeat(40),
          ref: 'main',
          dirty: true,
          workingFingerprint: 'c'.repeat(16),
        },
      },
    });

    expect(renderIoReport(dirty)).toContain('DIRTY working tree');
  });

  it('describes a snapshot subject by its fingerprint and file count', () => {
    const snapshot = ioReport([ioCommand()], {
      coordinate: {
        ...COORDINATE,
        subjectVersion: { kind: 'snapshot', fingerprint: 'd'.repeat(16), fileCount: 1484 },
      },
    });

    expect(renderIoReport(snapshot)).toContain('snapshot dddddddd (1,484 files)');
  });

  it('says what was counted, and never calls it a syscall', () => {
    const text = render();

    expect(text).toContain('fs and child_process calls');
    expect(text.toLowerCase()).not.toContain('syscall');
  });
});

describe('renderIoReport — aggregates that must never be hidden', () => {
  it('shows the loader total alongside the user total', () => {
    // Without the loader aggregate a reader cannot tell "6,371 were bucketed out"
    // from "there were only 436", and those support opposite conclusions.
    const text = render();

    expect(text).toContain('436 user calls');
    expect(text).toContain('6,371 loader calls');
  });

  it('CONTROL: a healthy two-process run carries no propagation warning', () => {
    // The negative half of the case below. Without it, an unconditional warning
    // would pass the positive assertion while shouting on every clean report.
    expect(render()).not.toContain('COUNTER DID NOT PROPAGATE');
  });

  it('warns loudly when only one process was counted', () => {
    // 1 means the preload never reached vat's real binary, so every number on
    // the line describes the launcher — a report that looks healthy and is empty.
    const text = render({ processes: 1 });

    expect(text).toContain('1 process');
    expect(text).toContain('COUNTER DID NOT PROPAGATE');
  });
});

describe('renderIoReport — the stability qualifier sits next to the numbers', () => {
  it('CONTROL: a row whose repeats agreed says so plainly, with no warning', () => {
    const text = render();

    expect(text).toContain('repeats agreed');
    expect(text).not.toContain('UNSTABLE');
    expect(text).not.toContain('UNTESTED');
  });

  it('marks a row whose own repeats disagreed', () => {
    expect(render({ stable: false })).toContain('UNSTABLE');
  });

  it('marks a row whose determinism was never tested', () => {
    const text = render({ runs: 1, comparedRuns: 1, stable: null });

    expect(text).toContain('UNTESTED');
    expect(text).toContain('1 compared');
  });
});

describe('renderIoReport — call sites and the N+1 finding', () => {
  it('shows count and distinct arguments together, always', () => {
    const text = render({ userCalls: 28, sites: [N_PLUS_ONE] });

    expect(text).toContain('fs.readdirSync');
    expect(text).toContain('extract-plugin.js:321');
    expect(text).toContain('28 calls / 14 distinct args');
  });

  it('flags the repetition, as a lower bound', () => {
    // distinctArgs merged across processes is an UPPER bound on distinct files,
    // so count/distinctArgs is a LOWER bound on repetition. Saying "2.0x" flat
    // would claim precision the merge cannot support.
    expect(render({ userCalls: 28, sites: [N_PLUS_ONE] })).toContain('2.0x repeated');
  });

  it('CONTROL: necessary work carries no repetition flag', () => {
    // 436 reads of 436 distinct files. A renderer that flagged everything would
    // pass the case above while making the marker meaningless.
    expect(render()).not.toContain('repeated');
  });

  it('renders a capped site as a floor and makes no ratio claim', () => {
    // Capped means the counter stopped tracking arguments, so the number is a
    // FLOOR. Reading it as exact would report an N+1 that may not exist.
    const capped = ioSite({ ...N_PLUS_ONE, argsCapped: true });

    const text = render({ userCalls: 28, sites: [capped] });

    expect(text).toContain('>=14 distinct args');
    expect(text).toContain('CAPPED');
    expect(text).not.toContain('2.0x repeated');
  });

  it('never renders a ratio for a site that kept no distinct-argument reading', () => {
    // MEASURED on the real report for `vat audit .`: this exact row read
    // `count=8 distinctArgs=1 argsCapped=false` and rendered as an 8.00x
    // redundancy row. Argument 0 is the binary — `which.sync('git')` hands back
    // the same absolute path every time — so the row was structurally
    // guaranteed to look maximally redundant whatever the spawns did.
    const text = render({ userCalls: 8, sites: [SPAWN_NO_READING] });

    expect(text).toContain('child_process.spawnSync');
    expect(text).toContain('NOT TRACKED');
    expect(text).not.toContain('repeated');
    // And no invented number: a `0` here would read as a measurement.
    expect(text).not.toContain('0 distinct args');
  });

  it('CONTROL: the same row WITH a reading of 1 does render 8.0x, so the case above can fail', () => {
    const text = render({
      userCalls: 8,
      sites: [ioSite({ ...SPAWN_NO_READING, distinctArgs: 1 })],
    });

    expect(text).toContain('8.0x repeated');
  });

  it('caps the site list but says how many it withheld and that the total includes them', () => {
    const sites = Array.from({ length: 5 }, (_, index) =>
      ioSite({ site: `file-${String(index)}.js:1`, count: 10, distinctArgs: 10 }),
    );

    const text = render({ userCalls: 50, sites }, { maxSites: 2 });

    expect(text).toContain('file-0.js:1');
    expect(text).not.toContain('file-4.js:1');
    expect(text).toContain('3 more sites not shown');
    expect(text).toContain('50 user calls');
  });

  it('reports a failed command instead of inventing zeros for it', () => {
    const text = render({ failed: true, failure: 'exited 2: no config found' });

    expect(text).toContain('FAILED');
    expect(text).toContain('no config found');
    expect(text).not.toContain('user calls');
  });
});

describe('renderIoReport — machine load', () => {
  it('reports a quiet machine without implying the counts depend on it', () => {
    expect(render()).toContain('Machine load: clean');
  });

  it('says so when load could not be measured at all', () => {
    const blind = ioReport([ioCommand()]);
    const text = renderIoReport({
      ...blind,
      body: { ...blind.body, load: { ...BUSY_LOAD, available: false, contaminated: false } },
    });

    expect(text).toContain('NOT MEASURED');
  });
});

describe('renderIoComparison — verdict wording', () => {
  it('names the axis that varies', () => {
    expect(renderDiff(ioCommand(), ioCommand())).toContain('same coordinate');
  });

  it('CONTROL: an unchanged row still prints every aggregate', () => {
    const text = renderDiff(ioCommand(), ioCommand());

    expect(text).toContain('unchanged');
    expect(text).toContain('6,371');
    expect(text).toContain('2 processes');
  });

  it('renders a change with the before, the after and the signed delta', () => {
    const after = ioCommand({ userCalls: 402, sites: [ioSite({ count: 402 })] });

    const text = renderDiff(ioCommand(), after);

    expect(text).toContain('CHANGED');
    expect(text).toContain('436 -> 402 (-34)');
  });

  it('lists sites that appeared, vanished and moved', () => {
    const before = ioCommand({ sites: [ioSite({ site: 'gone.js:1', count: 436 })] });
    const after = ioCommand({ sites: [ioSite({ site: 'new.js:9', count: 436 })] });

    const text = renderDiff(before, after);

    expect(text).toContain('gone.js:1');
    expect(text).toContain('new.js:9');
  });

  it('gives an unmeasurable row words an unchanged row never uses', () => {
    // The mutant this kills: rendering "no delta available" with the same
    // reassuring phrase as "no delta present". A reader scanning for green must
    // not be able to count a broken command as a pass.
    const broken = ioCommand({ failed: true, failure: 'exited 2' });

    const text = renderDiff(broken, ioCommand());

    expect(text).toContain('NO MEASUREMENT');
    expect(text).not.toContain('unchanged');
  });

  it('gives an unwarranted row its own words too, and shows the raw movement', () => {
    const before = ioCommand({ stable: false });
    const after = ioCommand({ stable: false, userCalls: 402, sites: [ioSite({ count: 402 })] });

    const text = renderDiff(before, after);

    expect(text).toContain('NOT ATTRIBUTABLE');
    expect(text).not.toContain('unchanged');
    expect(text).not.toContain('CHANGED');
    // The numbers are real; only the entitlement to call the difference a change
    // is missing, so hiding them would throw away a true observation.
    expect(text).toContain('436 -> 402 (-34)');
  });

  it('says when a distinctArgs comparison could not be read', () => {
    const after = ioCommand({ sites: [ioSite({ distinctArgs: 400, argsCapped: true })] });

    const text = renderDiff(ioCommand(), after);

    expect(text).toContain('distinct-argument');
    expect(text).toContain('capped');
  });

  it('describes commands present on only one side', () => {
    const result = compareIo(
      ioReport([ioCommand({ name: 'gone' })]),
      ioReport([ioCommand({ name: 'fresh' })]),
    );
    const text = result.ok ? renderIoComparison(result) : '';

    expect(text).toContain('no baseline');
    expect(text).toContain('only in the baseline');
  });

  it('warns at the top when either side was captured on a busy machine', () => {
    const busy = ioReport([ioCommand()]);
    const result = compareIo(ioReport([ioCommand()]), {
      ...busy,
      body: { ...busy.body, load: BUSY_LOAD },
    });
    const text = result.ok ? renderIoComparison(result) : '';

    expect(text).toContain('contaminated');
  });

  it('never calls any of it a syscall', () => {
    const after = ioCommand({ userCalls: 28, sites: [N_PLUS_ONE] });

    expect(renderDiff(ioCommand(), after).toLowerCase()).not.toContain('syscall');
  });
});
