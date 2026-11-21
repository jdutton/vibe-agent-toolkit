/**
 * 🚨 `vat validate`'s checks overlap, the lasting enforcer, over store states the gate must judge:
 * the same build run overlapped and sequential is indistinguishable from outside in every one, and
 * the overlapped run's debug facts say what its gate decided (`test-helpers/checks-overlap.ts`).
 *
 * - A store hit holding a member the store cannot answer for: an evicted blob key, blob rows that do
 *   not add up (the damaged-blobs arm), a member whose stored realization sends it cold. Each is a
 *   `member` decline naming the member and the predicate, so the run stays sequential. Each is made
 *   by editing the seeded store: no file of a git tree is stored unkeyed or uncovered on its own.
 * - A store whose blob tier cannot be read back: the run refuses before any checks child starts, in
 *   either mode. A store file that is not a database.
 * - A member that becomes unreadable after the gate admitted it (its readability probe refused):
 *   the parent computes it after the spawn, and the debug facts report those writes as they are.
 *
 * The parse limits arm (`hydratesUnder` false) is not here: no surface sets a run's parse limits
 * (`ParsePoolPolicy.limits` is programmatic only), so a `vat validate` run always parses under the
 * limits the store files its facts under. The gate's unit test holds that condition.
 */

import { readdirSync, rmSync, writeFileSync } from 'node:fs';

import { PROJECTION_TABLES, quoteIdentifier } from '@vibe-agent-toolkit/resources';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { storeFilesUnder } from '../helpers/projection-store-probe.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

import { cleanupTestTempDir, fs } from './test-common.js';
import {
  createOverlapFixture,
  editStore,
  expectFacts,
  expectSameOutput,
  type InFlight,
  killInFlight,
  type OverlapFixture,
  runBothModes,
  sequentialFacts,
  storedContentKey,
} from './test-helpers/checks-overlap.js';

// ⛔ Disposal paths: every `vat` process (and its checks child) inherits the scratch TMPDIR.
useScratchTmpdir('vat-scratch-checks-overlap-declines-');

/** The member each store edit damages. */
const MEMBER = 'docs/a.md';


/** The blob-scoped tables, read off the registry, so a blob table added later is evicted too. */
const BLOB_TABLES = Object.values(PROJECTION_TABLES).filter((spec) => spec.scope === 'blob');

let fixture: OverlapFixture;
// The run a case has in flight, so a red case cannot leave it (or its held child) running.
let inFlight: InFlight | undefined;

describe('vat validate — the checks overlap over store states the gate judges, same build, both modes', () => {
  beforeAll(async () => {
    fixture = await createOverlapFixture('vat-checks-overlap-declines-');
  });

  afterEach(() => {
    killInFlight(inFlight);
    inFlight = undefined;
  });

  afterAll(() => {
    cleanupTestTempDir(fixture.scratch);
  });

  it('an evicted blob key: a member decline naming it and readRoute; output identical', async () => {
    const both = await runBothModes(fixture, [], {
      store: 'warm',
      prepare: (cache) => editStore(cache, (database) => {
        const key = storedContentKey(database, MEMBER);
        for (const spec of BLOB_TABLES) {
          const [column] = spec.primaryKey;
          database.prepare(`DELETE FROM ${quoteIdentifier(spec.name)} WHERE ${quoteIdentifier(column ?? '')} = ?`).run(key);
        }
      }),
    });

    expectFacts(both, sequentialFacts({ condition: 'member', member: MEMBER, route: 'readRoute' }));
    expectSameOutput(both.overlapped, both.sequential);
  });

  it('damaged blobs (rows that do not add up for one member): a member decline naming it; output identical', async () => {
    const both = await runBothModes(fixture, [], {
      store: 'warm',
      prepare: (cache) => editStore(cache, (database) => {
        const changed = database.prepare(`UPDATE ${quoteIdentifier(PROJECTION_TABLES.blobs.name)} SET "headingCount" = "headingCount" + 1 WHERE "contentKey" = ?`)
          .run(storedContentKey(database, MEMBER)).changes;
        expect(Number(changed), 'the damaged blobs row').toBe(1);
      }),
    });

    expectFacts(both, sequentialFacts({ condition: 'member', member: MEMBER, route: 'readRoute' }));
    expectSameOutput(both.overlapped, both.sequential);
  });

  it('a member whose stored realization sends it cold: a member decline naming it and storedRoute; output identical', async () => {
    // A git tree keys every member it holds, so no fixture file is stored unkeyed; the store's row
    // is made to say what a file the read refused leaves (`unreadable`, no key).
    const both = await runBothModes(fixture, [], {
      store: 'warm',
      prepare: (cache) => editStore(cache, (database) => {
        const realizations = quoteIdentifier(PROJECTION_TABLES.resourceRealizations.name);
        const changed = database.prepare(`UPDATE ${realizations} SET "contentState" = 'unreadable', "contentKey" = NULL WHERE path = ?`).run(MEMBER).changes;
        expect(Number(changed), 'the member\'s realization rows').toBeGreaterThan(0);
      }),
    });

    expectFacts(both, sequentialFacts({ condition: 'member', member: MEMBER, route: 'storedRoute' }));
    expectSameOutput(both.overlapped, both.sequential);
  });

  it('a blob tier that cannot be read back: refused before any checks child starts, in either mode', async () => {
    const both = await runBothModes(fixture, [], {
      store: 'warm',
      prepare: (cache) => editStore(cache, (database) => {
        const changed = database.prepare(`UPDATE ${quoteIdentifier(PROJECTION_TABLES.blobs.name)} SET anchors = 'not json'`).run().changes;
        expect(Number(changed), 'the seeded blob rows').toBeGreaterThan(0);
      }),
    });

    expectFacts(both, sequentialFacts({ condition: 'rejected', error: expect.stringContaining("The projection store's blob facts could not be read") }));
    expect(both.overlapped.childStarted, 'an overlapped checks child').toBe(false);
    expect(both.sequential.childStarted, 'a sequential checks child').toBe(false);
    expect(both.overlapped.code).toBe(2);
    expectSameOutput(both.overlapped, both.sequential);
  });

  it('a damaged store (its file is not a database): output identical', async () => {
    const both = await runBothModes(fixture, [], {
      store: 'warm',
      prepare: (cache) => {
        const [file] = storeFilesUnder(cache);
        if (file === undefined) throw new Error('no seeded store');
        for (const journal of [`${file}-wal`, `${file}-shm`]) rmSync(journal, { force: true });
        writeFileSync(file, 'this is not a SQLite database\n'.repeat(256), 'utf-8');
      },
    });

    // A store file that is not a database answers nothing: the home misses, and the gate leaves it sequential.
    expectFacts(both, sequentialFacts({ condition: 'not-hit' }));
    expectSameOutput(both.overlapped, both.sequential);
  });

  it('a member unreadable after the gate admitted it: computed after the spawn, its writes reported as they are; output identical', async () => {
    const both = await runBothModes(fixture, [], {
      store: 'warm',
      // No parse cache: the member's cold parse writes one, inside the post-spawn window.
      prepare: (cache) => {
        for (const namespace of readdirSync(cache)) rmSync(safePath.join(cache, namespace, 'parse'), { recursive: true, force: true });
      },
      preloads: ['parent-only-probe-refused.mjs'],
      during: (running, files) => {
        inFlight = { running, files };
        return Promise.resolve();
      },
      env: (files) => ({
        VAT_TEST_PARENT_PROBE_REFUSED: MEMBER,
        VAT_TEST_PARENT_PROBE_TRACE: files.path('probe.trace'),
        VAT_TEST_CHILD_RELEASE_FILE: files.path('release'),
      }),
    });

    for (const run of [both.overlapped, both.sequential]) {
      const tracePath = safePath.join(fixture.scratch, `run-${run.mode}`, 'probe.trace');
      expect(fs.readFileSync(tracePath, 'utf-8'), `${run.mode}: the probe was refused`).toBe('refused\n');
    }
    // The residual path the gate cannot see: the parent parsed and filed the member after the spawn.
    // The count is reported, not hidden; it is not 0.
    expectFacts(both, {
      checksOverlapped: 1,
      gateDeclinedBy: null,
      childStderrBytesAtTurn: expect.any(Number),
      parentStoreWritesUntilChildExit: 0,
      parentParseCacheWritesUntilChildExit: 1,
    });
    expectSameOutput(both.overlapped, both.sequential);
  });
});
