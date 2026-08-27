/**
 * A throwaway on-disk corpus written from a literal, for suites that must drive
 * the REAL `populate()` rather than a hand-assembled base.
 *
 * The three moves — mkdtemp a root, write the literal into it, remove it — are
 * identical wherever a projection suite needs a real tree, and written twice
 * they are a 22-line clone. Written once, the
 * `security/detect-non-literal-fs-filename` justification and the
 * `recursive: true, force: true` teardown live in a single place.
 *
 * ⚠️ The root comes back through a GETTER, never as a value. `beforeEach` remints
 * it per test, so a value captured at registration time is `undefined` in the
 * first test and stale in every one after it.
 *
 * 🪤 Fixture files must NOT be byte-identical to each other. Blobs are
 * content-addressed and the parser kind is the only path-derived input to the
 * key, so two files with the same bytes collapse into ONE blob the moment they
 * route to the same parser — and assertions then describe whichever path sorted
 * first. Give every fixture a distinguishing marker line.
 */

import { replantableCorpus } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach } from 'vitest';

/** A fixture corpus's per-test root. */
export interface TempCorpus {
  /** The root minted for the test currently running. */
  root: () => string;
}

/**
 * Register `beforeEach`/`afterEach` that plant and remove a literal corpus.
 *
 * @param prefix - `mkdtemp` prefix, so a leaked directory names its own suite
 * @param corpus - Fixture name to file content; written verbatim, UTF-8
 * @returns An accessor for the current test's root
 */
export function setupTempCorpus(
  prefix: string,
  corpus: Readonly<Record<string, string>>,
): TempCorpus {
  const planted = replantableCorpus(prefix, corpus);
  beforeEach(planted.plant);
  afterEach(planted.clear);

  return { root: planted.root };
}
