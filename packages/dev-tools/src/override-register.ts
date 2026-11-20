#!/usr/bin/env tsx
/**
 * override-register — holds every root `package.json` `overrides` pin to what an adopter resolves.
 *
 * npm and Bun honour `overrides` in the ROOT manifest only, so a pin here hardens VAT's own tree
 * and never an adopter's: an adopter installing a published VAT package resolves each declared
 * range afresh. {@link OVERRIDE_REGISTER} carries one row per pin, held to `bun.lock`:
 *   - `dev-only`: no published workspace reaches the package (dependencies, optional and peer
 *     dependencies, transitively, each resolved from the copy the declaring package sees);
 *   - `published`: one does, so every range a reached package declares for the pinned name must
 *     admit the pinned version — then an adopter's fresh resolution can land on it. A declared range
 *     that does not is red unless the row's `outsideRanges` names it (`"<declarer> <range>"`) with
 *     why adopters are still safe: an advisory range that excludes it, or the known-defects.md entry
 *     that records why they are not.
 * Red, both ways: a pin with no row, a row with no pin, a `dev-only` row on a package a published
 * workspace reaches, a `published` row on one none reaches, a declared range outside the pin with no
 * `outsideRanges` entry, an `outsideRanges` entry no declared range needs, and a blank reason.
 * Run: `bun run check:overrides` (full tier). Exit 0 = every pin's reach stated truly, 1 = a finding,
 * 2 = it could not read or parse `bun.lock` or a `package.json` (`runRegisterCheck`).
 */
import { readFileSync } from 'node:fs';

import { safePath, appendAll } from '@vibe-agent-toolkit/utils';
import semver from 'semver';

import { PROJECT_ROOT, isEntrypoint } from './common.js';
import { runRegisterCheck } from './osv-ignore-register.js';

/** Why one override exists, and what an adopter resolves for the package it pins. */
export type OverrideRow =
  | { readonly reach: 'dev-only'; readonly reason: string }
  | {
      readonly reach: 'published';
      readonly reason: string;
      /** `"<declarer> <range>"` → why adopters are safe although that range does not admit the pin. */
      readonly outsideRanges: Readonly<Record<string, string>>;
    };

/**
 * The ESLint stack's own minimatch range. It reaches adopters only through utils' optional
 * `eslint >=9.0.0` peer (the shipped lint rules), and GHSA-g3hv-75wg-m249 affects 7.0.0 up to 11.0.1,
 * so ^3.1.5 is outside it; OSV lists no advisory against minimatch 3.1.5, the newest 3.x.
 */
const ESLINT_MINIMATCH_3 = 'outside GHSA-g3hv-75wg-m249 (introduced 7.0.0); OSV lists no advisory against minimatch 3.1.5, the newest 3.x';

/** One row per root `overrides` key. */
export const OVERRIDE_REGISTER: Readonly<Record<string, OverrideRow>> = {
  undici: { reach: 'published', reason: 'GHSA-2m5v-pch6-74hx, GHSA-4qv8-2p9j-2685, GHSA-4w7w-5xrc-9h26, GHSA-55wc-3pg8-jfw6, GHSA-9fm3-97px-rjf6, GHSA-f72v-6w45-q472, GHSA-qrxm-fqhp-jwvm and GHSA-xjj6-f33q-929c, fixed in 7.30.1', outsideRanges: {} },
  'fast-uri': { reach: 'published', reason: 'GHSA-333x-w4r6-6crp, GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr and GHSA-xhq7-xmqj-769h, fixed in 3.1.9', outsideRanges: {} },
  tar: { reach: 'published', reason: 'GHSA-r292-9mhp-454m (fixed in 7.5.21) and GHSA-23hp-3jrh-7fpw (7.5.19), among others', outsideRanges: {} },
  'js-yaml': { reach: 'published', reason: 'GHSA-2883-xcg3-v3hh, fixed in 4.3.2', outsideRanges: {} },
  'ip-address': { reach: 'published', reason: 'GHSA-rxp7-6hxx-x8q5, fixed in 10.7.4', outsideRanges: {} },
  'form-data': { reach: 'published', reason: 'GHSA-hmw2-7cc7-3qxx, fixed in 4.0.6', outsideRanges: {} },
  nanoid: { reach: 'dev-only', reason: 'GHSA-2v37-7h3g-55p8, fixed in 3.3.18' },
  postcss: { reach: 'dev-only', reason: 'GHSA-fxqj-rqcc-2cmp, fixed in 8.5.23' },
  'smol-toml': { reach: 'dev-only', reason: 'GHSA-r4xh-jqrq-34v2, fixed in 1.9.0' },
  yaml: { reach: 'published', reason: 'GHSA-48c2-rrv3-qjmp, fixed in 2.8.3; held at 2.9.0, the floor the published workspaces declare', outsideRanges: {} },
  flatted: { reach: 'published', reason: 'GHSA-rf6f-7fwh-wjgh, fixed in 3.4.2', outsideRanges: {} },
  rollup: { reach: 'dev-only', reason: 'GHSA-mw96-cpmx-2vgc, fixed in 4.59.0' },
  vite: { reach: 'dev-only', reason: 'GHSA-587h-7wmj-h5pm, GHSA-698v-4r3x-3vcv, GHSA-9jrq-w75r-8gcw, GHSA-r825-w8mm-5pxw and GHSA-rq7h-c2jc-7f22, fixed in 7.3.7' },
  vitest: { reach: 'dev-only', reason: 'one vitest across every workspace, the version the root devDependency names' },
  lodash: { reach: 'dev-only', reason: 'GHSA-f23m-r3pf-42rh, fixed in 4.18.1' },
  turbo: { reach: 'dev-only', reason: 'one turbo for the build graph, the version the root devDependency names' },
  ws: { reach: 'dev-only', reason: 'GHSA-96hv-2xvq-fx4p, fixed in 8.21.0' },
  handlebars: { reach: 'published', reason: 'GHSA-8r5x-fm3f-whwj, GHSA-p8wg-vrv2-v86f and GHSA-xw65-4hp5-5hc7, fixed in 4.7.10', outsideRanges: {} },
  glob: { reach: 'published', reason: 'GHSA-3g3m-2fjr-6pw4, fixed only in 14.0.2+', outsideRanges: {} },
  minimatch: {
    reach: 'published',
    reason: 'GHSA-g3hv-75wg-m249, fixed only in 11.0.1+',
    outsideRanges: {
      'eslint ^3.1.5': ESLINT_MINIMATCH_3,
      '@eslint/eslintrc ^3.1.5': ESLINT_MINIMATCH_3,
      '@eslint/config-array ^3.1.5': ESLINT_MINIMATCH_3,
    },
  },
  sharp: {
    reach: 'published',
    reason: 'GHSA-wq5f-xc86-pv6w (fixed in 0.35.5), GHSA-rgj7-g3m4-5g8c (0.35.4) and GHSA-f88m-g3jw-g9cj (0.35.0)',
    outsideRanges: {
      '@huggingface/transformers ^0.33.5':
        'NOT safe: an adopter installing rag-lancedb resolves sharp 0.33.5 through @lancedb/lancedb and @huggingface/transformers 3.0.2; see known-defects.md "An adopter installing rag-lancedb resolves sharp 0.33.5"',
    },
  },
  'source-map-js': { reach: 'dev-only', reason: 'GHSA-68fv-2mgg-jv7q, fixed in 1.2.2' },
  'vibe-agent-toolkit': { reach: 'dev-only', reason: 'resolves the umbrella package to its workspace, never the registry' },
};

/** One range a reached package (or a published workspace) declares for a dependency. */
export interface Declaration {
  /** The declaring package's name. */
  readonly from: string;
  readonly range: string;
}

/** Package name → every range a package a published workspace reaches declares for it. */
export type PublishedReach = ReadonlyMap<string, readonly Declaration[]>;

interface BunLock {
  readonly workspaces: Record<string, Record<string, unknown>>;
  readonly packages: Record<string, unknown[]>;
}

/** bun.lock is JSON with trailing commas. */
function parseBunLock(lockText: string): BunLock {
  return JSON.parse(lockText.replaceAll(/,(\s*[}\]])/g, '$1')) as BunLock;
}

/** The runtime edges of one manifest or lock entry, with their ranges: dependencies, optional and peer. */
function runtimeDependencies(meta: unknown): Array<[string, string]> {
  if (typeof meta !== 'object' || meta === null) return [];
  const record = meta as Record<string, unknown>;
  return ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((field) => {
    const deps = record[field];
    if (typeof deps !== 'object' || deps === null) return [];
    return Object.entries(deps).map(([name, range]): [string, string] => [name, String(range)]);
  });
}

/**
 * The lock key `name` resolves to from a package at `parent` (a list of names), nearest first.
 * Bun keys a copy nested under a package as `<parent key>/<name>`, and a workspace's own copy as
 * `<workspace name>/<name>` (measured on Bun 1.3.9: `@probe/pub/ms` beside a hoisted `ms`).
 */
function resolveKey(packages: BunLock['packages'], parent: readonly string[], name: string): string[] | undefined {
  for (let cut = parent.length; cut >= 0; cut -= 1) {
    const path = [...parent.slice(0, cut), name];
    if (packages[path.join('/')] !== undefined) return path;
  }
  return undefined;
}

/** Every package a published workspace reaches through runtime edges, as `bun.lock` resolves them. */
export function publishedReach(lockText: string, publishedWorkspaces: ReadonlySet<string>): PublishedReach {
  const { workspaces, packages } = parseBunLock(lockText);
  const reach = new Map<string, Declaration[]>();
  const declared = new Set<string>();
  const seen = new Set<string>();
  const stack = Object.entries(workspaces)
    .filter(([path]) => publishedWorkspaces.has(path))
    .map(([, manifest]) => {
      const name = String(manifest['name']);
      return { from: name, parent: [name], deps: runtimeDependencies(manifest) };
    });
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    for (const [dep, range] of item.deps) {
      const path = resolveKey(packages, item.parent, dep);
      if (path === undefined) continue;
      const declarations = reach.get(dep) ?? [];
      reach.set(dep, declarations);
      if (!declared.has(`${dep}\0${item.from}\0${range}`)) {
        declared.add(`${dep}\0${item.from}\0${range}`);
        declarations.push({ from: item.from, range });
      }
      const key = path.join('/');
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push({ from: dep, parent: path, deps: runtimeDependencies(packages[key]?.[2]) });
    }
  }
  return reach;
}

/** Why a published row's pin and the ranges adopters resolve disagree; empty when they agree. */
function rangeFindings(name: string, pin: unknown, declarations: readonly Declaration[], outsideRanges: Readonly<Record<string, string>>): string[] {
  if (typeof pin !== 'string' || semver.valid(pin) === null) return [`override ${name} pins ${String(pin)}, which is not a version an adopter's range can be judged against`];
  const findings: string[] = [];
  const outside = new Set(declarations.filter(({ range }) => !semver.satisfies(pin, range)).map(({ from, range }) => `${from} ${range}`));
  for (const key of outside) {
    const why = outsideRanges[key];
    if (why === undefined) findings.push(`override ${name} pins ${pin}, but ${key.replace(' ', ' declares ')}, which does not admit it: an adopter resolves that range, not the pin. Raise the range in the published package, or name "${key}" in the row's outsideRanges with why adopters are still safe`);
    else if (why.trim() === '') findings.push(`override ${name}: outsideRanges "${key}" has no reason`);
  }
  for (const key of Object.keys(outsideRanges)) {
    if (!outside.has(key)) findings.push(`override ${name}: outsideRanges names "${key}", which no reached package declares outside the pin any more: delete it`);
  }
  return findings;
}

/** Why one register row misstates its pin; empty when it is true. */
function rowFindings(name: string, row: OverrideRow, pin: unknown, declarations: readonly Declaration[] | undefined): string[] {
  const findings: string[] = [];
  if (row.reason.trim() === '') findings.push(`override ${name} has no reason`);
  if (row.reach === 'dev-only') {
    if (declarations !== undefined) findings.push(`override ${name} is registered dev-only, but a published workspace reaches it: an adopter's install ignores the pin, so register it published and hold its declared ranges to the pin`);
    return findings;
  }
  if (declarations === undefined) return [...findings, `override ${name} is registered published, but no published workspace reaches it any more: register it dev-only`];
  return [...findings, ...rangeFindings(name, pin, declarations, row.outsideRanges)];
}

/** Why the root `overrides`, {@link OVERRIDE_REGISTER} and the published reach disagree; empty when they agree. */
export function overrideFindings(overrides: Readonly<Record<string, unknown>>, reach: PublishedReach, register: Readonly<Record<string, OverrideRow>>): string[] {
  const findings: string[] = [];
  for (const [name, pin] of Object.entries(overrides)) {
    const row = register[name];
    if (row === undefined) {
      findings.push(`package.json overrides ${name} with no OVERRIDE_REGISTER row (packages/dev-tools/src/override-register.ts): state its reason and whether adopters reach it`);
      continue;
    }
    appendAll(findings, rowFindings(name, row, pin, reach.get(name)));
  }
  for (const name of Object.keys(register)) {
    if (!(name in overrides)) findings.push(`OVERRIDE_REGISTER has a row for ${name}, which package.json no longer overrides: delete the row`);
  }
  return findings;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Reads `bun.lock` and the manifests under `root` and judges its overrides; throws when it cannot read them. */
export function checkOverrides(root: string): string[] {
  const lockText = readFileSync(safePath.join(root, 'bun.lock'), 'utf8');
  const published = new Set(
    Object.keys(parseBunLock(lockText).workspaces).filter((path) => path !== '' && readJson(safePath.join(root, path, 'package.json'))['private'] !== true),
  );
  const overrides = readJson(safePath.join(root, 'package.json'))['overrides'];
  return overrideFindings(typeof overrides === 'object' && overrides !== null ? (overrides as Record<string, unknown>) : {}, publishedReach(lockText, published), OVERRIDE_REGISTER);
}

function main(): void {
  runRegisterCheck(() => checkOverrides(PROJECT_ROOT), `package.json overrides: ${Object.keys(OVERRIDE_REGISTER).length} pins, each with its reach stated truly and every published range admitting its pin or named as an exception.`);
}

if (isEntrypoint(import.meta.url)) main();
