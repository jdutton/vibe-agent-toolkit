/**
 * Materialize a CorpusEntry's source into a local staging directory.
 *
 * Strategy by source kind:
 *   local — copy from monorepo path into staging.
 *   git   — `git clone` into a SHA-keyed cache, then checkout the ref.
 *           Cache hit short-circuits the clone.
 *   npm   — not yet implemented; the schema allows it for forward compatibility
 *           but no harness run has needed an npm-hosted skill yet. Add via
 *           tar-fs/tar-stream (not a shell-out) when the first user lands.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- staging paths derive from validated manifest */

import { cpSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  isAbsolutePath,
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  safeExecResult,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';

import type { CorpusEntry, SkillSource } from '../types.js';

export interface StagedSkill {
  entryId: string;
  /** absolute path (forward slashes) to the directory containing the skill */
  rootDir: string;
  /** absolute path (forward slashes) to the SKILL.md (joins rootDir + entry.skillRelPath) */
  skillPath: string;
}

export interface FetchOptions {
  cacheDir?: string;
}

function defaultCacheDir(): string {
  return toForwardSlash(safePath.join(normalizedTmpdir(), 'vat-compat-empirical-cache'));
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSyncReal(dir, { recursive: true });
  }
}

function stageLocal(entry: CorpusEntry, source: Extract<SkillSource, { kind: 'local' }>, projectRoot: string, cacheDir: string): StagedSkill {
  const stageDir = safePath.join(cacheDir, 'local', entry.id);
  ensureDir(safePath.join(cacheDir, 'local'));

  const absSource = isAbsolutePath(source.path)
    ? toForwardSlash(source.path)
    : safePath.join(projectRoot, source.path);

  if (!existsSync(absSource)) {
    throw new Error(`local skill source does not exist: ${absSource}`);
  }

  if (existsSync(stageDir)) {
    return finalizeStage(entry, stageDir);
  }

  ensureDir(stageDir);
  cpSync(absSource, stageDir, { recursive: true });
  return finalizeStage(entry, stageDir);
}

/**
 * A ref is treated as immutable (cache-eligible without refresh) only if it
 * looks like a git SHA — 7-40 hex characters. Branch and tag names move over
 * time, so caching them would let stale clones masquerade as fresh evidence.
 */
const SHA_REF_RE = /^[0-9a-f]{7,40}$/i;

function refreshGitRef(stageDir: string, ref: string): void {
  // Force-refresh tags before the named-ref fetch. Without `--tags --force`,
  // a moved annotated tag (a tag object pointing at a new commit) won't
  // update the local tag ref — and the FETCH_HEAD-based checkout below
  // then resolves to the cached old commit, silently serving stale source.
  // The named `fetch origin <ref>` on the next line covers branches and
  // unmoved tags; this line specifically handles the moved-tag case.
  // Force-refresh tags before the named-ref fetch. The named fetch below
  // updates FETCH_HEAD correctly for the common case, but does not refresh
  // local tag refs — operations downstream of refreshGitRef that resolve
  // the tag by name (debugging, log inspection, etc.) would see stale refs.
  // `--tags --force` is also a hedge against the shallow-boundary case where
  // the new tag commit lies outside the `--depth 50` window: this fetch
  // deepens as needed before the depth-limited named fetch runs.
  const tagsRes = safeExecResult('git', ['-C', stageDir, 'fetch', '--quiet', '--tags', '--force', 'origin']);
  if (!tagsRes.success) {
    throw new Error(`git fetch --tags failed in ${stageDir}: ${tagsRes.stderr.toString()}`);
  }
  const fetchRes = safeExecResult('git', ['-C', stageDir, 'fetch', '--quiet', '--depth', '50', 'origin', ref]);
  if (!fetchRes.success) {
    throw new Error(`git fetch ${ref} failed in ${stageDir}: ${fetchRes.stderr.toString()}`);
  }
  // Discard any local modifications before checkout so a half-finished prior
  // run can't permanently wedge the cache. The clone is harness-owned scratch
  // space — there's nothing to preserve.
  const resetRes = safeExecResult('git', ['-C', stageDir, 'reset', '--hard', '--quiet']);
  if (!resetRes.success) {
    throw new Error(`git reset failed in ${stageDir}: ${resetRes.stderr.toString()}`);
  }
  const checkoutRes = safeExecResult('git', ['-C', stageDir, 'checkout', '--quiet', 'FETCH_HEAD']);
  if (!checkoutRes.success) {
    throw new Error(`git checkout ${ref} failed in ${stageDir}: ${checkoutRes.stderr.toString()}`);
  }
}

function stageGit(entry: CorpusEntry, source: Extract<SkillSource, { kind: 'git' }>, cacheDir: string): StagedSkill {
  const repoSlug = source.repo.replaceAll(/[^a-zA-Z0-9-]/g, '_');
  const stageDir = safePath.join(cacheDir, 'git', `${repoSlug}-${source.ref}`);

  if (existsSync(stageDir)) {
    if (!SHA_REF_RE.test(source.ref)) {
      refreshGitRef(stageDir, source.ref);
    }
    return finalizeStage(entry, stageDir);
  }

  ensureDir(toForwardSlash(dirname(stageDir)));

  const cloneRes = safeExecResult('git', ['clone', '--depth', '50', '--quiet', source.repo, stageDir]);
  if (!cloneRes.success) {
    throw new Error(`git clone failed for ${source.repo}: ${cloneRes.stderr.toString()}`);
  }

  const checkoutRes = safeExecResult('git', ['-C', stageDir, 'checkout', '--quiet', source.ref]);
  if (!checkoutRes.success) {
    throw new Error(`git checkout ${source.ref} failed in ${stageDir}: ${checkoutRes.stderr.toString()}`);
  }

  return finalizeStage(entry, stageDir);
}

function finalizeStage(entry: CorpusEntry, stageDir: string): StagedSkill {
  const rootDir = toForwardSlash(stageDir);
  const skillPath = safePath.join(rootDir, entry.skillRelPath);
  if (!existsSync(skillPath)) {
    throw new Error(`skill file missing at ${skillPath} (rel=${entry.skillRelPath}) for entry ${entry.id}`);
  }
  return { entryId: entry.id, rootDir, skillPath };
}

export function fetchSource(entry: CorpusEntry, projectRoot: string, options: FetchOptions = {}): StagedSkill {
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  ensureDir(cacheDir);

  switch (entry.source.kind) {
    case 'local':
      return stageLocal(entry, entry.source, projectRoot, cacheDir);
    case 'git':
      return stageGit(entry, entry.source, cacheDir);
    case 'npm':
      throw new Error(
        `npm-hosted skill sources are not yet implemented (entry: ${entry.id}, pkg: ${entry.source.pkg}). Add tar-fs-based extraction when the first npm corpus entry lands.`,
      );
  }
}
