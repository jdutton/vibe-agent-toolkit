/**
 * A throwaway on-disk corpus for the parse-fact oracle suites.
 *
 * Both suites need the same three moves — mkdtemp a root, write a literal
 * corpus into it, remove it afterwards — and the pipeline oracles take ABSOLUTE
 * paths, so both also need the same map from fixture name to absolute path.
 * Written twice, that scaffolding was a 24-line clone; written once, the
 * `security/detect-non-literal-fs-filename` justification and the
 * `recursive: true, force: true` teardown exist in a single place.
 *
 * ⚠️ The root is handed back through a GETTER rather than as a value. `beforeEach`
 * runs per test, so the root a suite must use is the one minted for the test
 * currently running; a value captured at registration time would be `undefined`
 * in the first test and stale in every one after it.
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { replantableCorpus } from '@vibe-agent-toolkit/utils/testing';
import { afterEach, beforeEach } from 'vitest';

/** A fixture corpus's per-test root and the absolute paths inside it. */
export interface CorpusFixture {
  /** The root minted for the test currently running. */
  root: () => string;
  /** Every corpus file, absolute, in declaration order. */
  absolutePaths: () => string[];
}

/**
 * Register `beforeEach`/`afterEach` that plant and remove a literal corpus.
 *
 * @param prefix - `mkdtemp` prefix, so a leaked directory names its own suite
 * @param corpus - Fixture name to file content; written verbatim, UTF-8
 * @returns Accessors for the current test's root and its absolute paths
 */
export function setupCorpusFixture(
  prefix: string,
  corpus: Readonly<Record<string, string>>,
): CorpusFixture {
  const planted = replantableCorpus(prefix, corpus);
  beforeEach(planted.plant);
  afterEach(planted.clear);

  return {
    root: planted.root,
    absolutePaths: () => Object.keys(corpus).map((name) => safePath.join(planted.root(), name)),
  };
}
