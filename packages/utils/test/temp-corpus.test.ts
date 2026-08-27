/* eslint-disable security/detect-non-literal-fs-filename -- every path read here is a root this file's own `mkdtemp` just minted */
/**
 * The literal-corpus fixture primitives, which are themselves fixtures — so a
 * defect here is invisible in its own consumers' failures rather than reported
 * as one.
 *
 * 🪤 `replantableCorpus` is the shape two packages' `beforeEach`/`afterEach`
 * wrappers delegate to. Those wrappers are three lines each precisely BECAUSE
 * this holder carries the per-test state, so the state machine it implements
 * (nothing planted → planted → cleared) is what the assertions below are about.
 */

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { safePath } from '../src/path.js';
import { createTempCorpus, replantableCorpus } from '../src/testing.js';

/**
 * Two files whose bytes DIFFER.
 *
 * ⚠️ Deliberately not byte-identical: VAT's blobs are content-addressed, so
 * identical fixtures collapse into one blob and an assertion then describes
 * whichever path sorted first. A fixture helper's own test is the last place
 * that should model the trap it warns about.
 */
const CORPUS = {
  'one.md': '# one\n\nfirst marker\n',
  'two.md': '# two\n\nsecond marker\n',
} as const;

describe('createTempCorpus', () => {
  it('writes every entry verbatim under a fresh root', () => {
    const planted = createTempCorpus('vat-temp-corpus-write-', CORPUS);
    try {
      for (const [name, content] of Object.entries(CORPUS)) {
        expect(readFileSync(safePath.join(planted.root, name), 'utf8')).toBe(content);
      }
    } finally {
      planted.cleanup();
    }
  });

  it('mints a DIFFERENT root per call, so a suite that plants per test is isolated', () => {
    const first = createTempCorpus('vat-temp-corpus-distinct-', CORPUS);
    const second = createTempCorpus('vat-temp-corpus-distinct-', CORPUS);
    try {
      expect(first.root).not.toBe(second.root);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  it('removes the whole tree, and a second cleanup is a no-op rather than a throw', () => {
    const planted = createTempCorpus('vat-temp-corpus-cleanup-', CORPUS);
    planted.cleanup();
    expect(existsSync(planted.root)).toBe(false);
    expect(() => planted.cleanup()).not.toThrow();
  });
});

describe('replantableCorpus', () => {
  it('throws by name when root() is read before the first plant', () => {
    const holder = replantableCorpus('vat-replantable-unplanted-', CORPUS);
    // The whole reason the holder exists rather than a bare `let`: an
    // uninitialised `let` raises "Cannot read properties of undefined", which
    // names neither the suite nor the hook that is missing.
    expect(() => holder.root()).toThrow(/root\(\) before plant\(\)/u);
    expect(() => holder.root()).toThrow(/vat-replantable-unplanted-/u);
  });

  it('plants a readable tree and hands its root back through the getter', () => {
    const holder = replantableCorpus('vat-replantable-plant-', CORPUS);
    holder.plant();
    try {
      expect(readFileSync(safePath.join(holder.root(), 'one.md'), 'utf8')).toBe(CORPUS['one.md']);
    } finally {
      holder.clear();
    }
  });

  it('replants to a NEW root, which is what a per-test fixture depends on', () => {
    const holder = replantableCorpus('vat-replantable-replant-', CORPUS);
    holder.plant();
    const first = holder.root();
    holder.clear();
    holder.plant();
    const second = holder.root();
    try {
      // A holder that reused one root would let a test's writes leak into the
      // next one, and every suite built on it would go green while sharing state.
      expect(second).not.toBe(first);
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(true);
    } finally {
      holder.clear();
    }
  });

  it('a second plant() with no clear() between mints a new root and leaks nothing', () => {
    // 🪤 This is what NESTED describe blocks do: vitest runs the outer
    // `beforeEach` then the inner one before a single `afterEach`, so two
    // plants with no clear between them is ordinary usage, not an abuse. A
    // holder that kept the first handle would share one tree across the two
    // scopes AND leak the second for the process's lifetime — and because both
    // roots read fine, every suite that nests would stay green while doing it.
    const holder = replantableCorpus('vat-replantable-double-plant-', CORPUS);
    holder.plant();
    const first = holder.root();
    holder.plant();
    const second = holder.root();
    try {
      expect(second).not.toBe(first);
      expect(existsSync(first)).toBe(false);
    } finally {
      holder.clear();
    }
  });

  it('clear() removes the tree AND forgets the root, so a stale one cannot be read', () => {
    const holder = replantableCorpus('vat-replantable-clear-', CORPUS);
    holder.plant();
    const root = holder.root();
    holder.clear();
    expect(existsSync(root)).toBe(false);
    // 🪤 Forgetting matters independently of removing: a holder that kept the
    // path would hand a suite whose `beforeEach` silently stopped running a
    // root that merely no longer exists, and the failure would surface as a
    // missing FILE rather than as a missing hook.
    expect(() => holder.root()).toThrow(/root\(\) before plant\(\)/u);
  });

  it('clear() before any plant is a no-op, so a failed beforeEach does not mask itself', () => {
    const holder = replantableCorpus('vat-replantable-clear-unplanted-', CORPUS);
    expect(() => holder.clear()).not.toThrow();
  });
});
