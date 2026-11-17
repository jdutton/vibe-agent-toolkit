#!/usr/bin/env tsx
/**
 * override-register — holds every root `package.json` `overrides` pin to a stated reach.
 *
 * npm and Bun honour `overrides` in the ROOT manifest only, so a pin here hardens VAT's own tree
 * and never an adopter's: an adopter installing a published VAT package resolves that package's
 * declared ranges afresh. A pin on a package a published workspace reaches therefore says nothing
 * about adopters, and a register row has to. {@link OVERRIDE_REGISTER} carries one row per pin:
 *   - `dev-only`: no published workspace reaches the package (dependencies, optional and peer
 *     dependencies, transitively, as `bun.lock` resolves them);
 *   - `published`: one does, and `adopters` says why an adopter's own resolution is safe, or names
 *     the known-defects.md entry that records why it is not.
 * Red, both ways: a pin with no row, a row with no pin, a `dev-only` row on a package a published
 * workspace reaches, a `published` row on one none reaches, and a blank reason.
 * Run: `bun run check:overrides` (full tier). Exit 0 = every pin's reach stated truly, 1 = a finding.
 */
import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

import { PROJECT_ROOT, isEntrypoint } from './common.js';
import { reportFindings } from './osv-ignore-register.js';

/** Why one override exists, and whether an adopter inherits the package it pins. */
export type OverrideRow =
  | { readonly reach: 'dev-only'; readonly reason: string }
  | { readonly reach: 'published'; readonly reason: string; readonly adopters: string };

const ADOPTERS_RESOLVE_PATCHED = 'every published range admits a patched release, and a fresh install resolves one; the pin only holds VAT\'s own lockfile there';

const SWEEP = "a security pin from the transitive-advisory sweep (CHANGELOG Security, osv-scanner.toml notes)";

/** One row per root `overrides` key. */
export const OVERRIDE_REGISTER: Readonly<Record<string, OverrideRow>> = {
  undici: { reach: 'published', reason: SWEEP, adopters: ADOPTERS_RESOLVE_PATCHED },
  'fast-uri': { reach: 'published', reason: SWEEP, adopters: ADOPTERS_RESOLVE_PATCHED },
  tar: { reach: 'published', reason: SWEEP, adopters: ADOPTERS_RESOLVE_PATCHED },
  'js-yaml': { reach: 'published', reason: SWEEP, adopters: ADOPTERS_RESOLVE_PATCHED },
  'ip-address': { reach: 'published', reason: SWEEP, adopters: ADOPTERS_RESOLVE_PATCHED },
  'form-data': { reach: 'published', reason: SWEEP, adopters: ADOPTERS_RESOLVE_PATCHED },
  nanoid: { reach: 'dev-only', reason: SWEEP },
  postcss: { reach: 'dev-only', reason: SWEEP },
  'smol-toml': { reach: 'dev-only', reason: 'GHSA-r4xh-jqrq-34v2, fixed in 1.9.0' },
  yaml: { reach: 'published', reason: SWEEP, adopters: 'the published workspaces declare yaml ^2.9.0 themselves' },
  flatted: { reach: 'published', reason: SWEEP, adopters: ADOPTERS_RESOLVE_PATCHED },
  rollup: { reach: 'dev-only', reason: SWEEP },
  vite: { reach: 'dev-only', reason: SWEEP },
  vitest: { reach: 'dev-only', reason: 'one vitest across every workspace, the version the root devDependency names' },
  lodash: { reach: 'dev-only', reason: SWEEP },
  turbo: { reach: 'dev-only', reason: 'one turbo for the build graph, the version the root devDependency names' },
  ws: { reach: 'dev-only', reason: SWEEP },
  handlebars: { reach: 'published', reason: 'three advisories against 4.7.9, fixed in 4.7.10', adopters: ADOPTERS_RESOLVE_PATCHED },
  glob: { reach: 'published', reason: 'GHSA-3g3m-2fjr-6pw4, fixed only in 14.0.2+; rimraf still declares ^13', adopters: 'the published workspaces declare glob ^14.0.3 themselves' },
  minimatch: { reach: 'published', reason: 'GHSA-g3hv-75wg-m249, fixed only in 11.0.1+; the ESLint stack declares older majors', adopters: ADOPTERS_RESOLVE_PATCHED },
  sharp: { reach: 'published', reason: 'GHSA-wq5f-xc86-pv6w and the libvips advisories, fixed in 0.35.5', adopters: 'NOT safe: @lancedb/lancedb pins @huggingface/transformers 3.0.2, which declares sharp ^0.33.5; see known-defects.md "An adopter installing rag-lancedb resolves sharp 0.33.5"' },
  'source-map-js': { reach: 'dev-only', reason: 'GHSA-68fv-2mgg-jv7q, fixed in 1.2.2' },
  'vibe-agent-toolkit': { reach: 'dev-only', reason: 'resolves the umbrella package to its workspace, never the registry' },
};

/** bun.lock is JSON with trailing commas. */
function parseBunLock(lockText: string): { workspaces: Record<string, Record<string, unknown>>; packages: Record<string, unknown[]> } {
  return JSON.parse(lockText.replaceAll(/,(\s*[}\]])/g, '$1')) as {
    workspaces: Record<string, Record<string, unknown>>;
    packages: Record<string, unknown[]>;
  };
}

/** The runtime edges of one manifest or lock entry: dependencies, optional and peer. */
function runtimeDependencies(meta: unknown): string[] {
  if (typeof meta !== 'object' || meta === null) return [];
  const record = meta as Record<string, unknown>;
  return ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((field) => {
    const deps = record[field];
    return typeof deps === 'object' && deps !== null ? Object.keys(deps) : [];
  });
}

/** The lock key `name` resolves to from a package at `parent` (a list of names), nearest first. */
function resolveKey(packages: Record<string, unknown[]>, parent: readonly string[], name: string): string[] | undefined {
  for (let cut = parent.length; cut >= 0; cut -= 1) {
    const path = [...parent.slice(0, cut), name];
    if (packages[path.join('/')] !== undefined) return path;
  }
  return undefined;
}

/** Every package name a published workspace reaches through runtime edges, as `bun.lock` resolves them. */
export function publishedReach(lockText: string, publishedWorkspaces: ReadonlySet<string>): Set<string> {
  const { workspaces, packages } = parseBunLock(lockText);
  const reach = new Set<string>();
  const seen = new Set<string>();
  const stack: Array<{ parent: string[]; deps: string[] }> = Object.entries(workspaces)
    .filter(([path]) => publishedWorkspaces.has(path))
    .map(([, manifest]) => ({ parent: [], deps: runtimeDependencies(manifest) }));
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    for (const dep of item.deps) {
      const path = resolveKey(packages, item.parent, dep);
      if (path === undefined) continue;
      reach.add(dep);
      const key = path.join('/');
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push({ parent: path, deps: runtimeDependencies(packages[key]?.[2]) });
    }
  }
  return reach;
}

/** Why one register row misstates its pin; empty when it is true. */
function rowFindings(name: string, row: OverrideRow, reached: boolean): string[] {
  const findings: string[] = [];
  if (row.reason.trim() === '') findings.push(`override ${name} has no reason`);
  if (row.reach === 'dev-only') {
    if (reached) findings.push(`override ${name} is registered dev-only, but a published workspace reaches it: an adopter's install ignores the pin, so say why that is safe (reach: 'published', adopters: ...)`);
    return findings;
  }
  if (!reached) findings.push(`override ${name} is registered published, but no published workspace reaches it any more: register it dev-only`);
  if (row.adopters.trim() === '') findings.push(`override ${name} reaches adopters and does not say why they are safe`);
  return findings;
}

/** Why the root `overrides`, {@link OVERRIDE_REGISTER} and the published reach disagree; empty when they agree. */
export function overrideFindings(overrides: Readonly<Record<string, unknown>>, reach: ReadonlySet<string>, register: Readonly<Record<string, OverrideRow>>): string[] {
  const findings: string[] = [];
  for (const name of Object.keys(overrides)) {
    const row = register[name];
    if (row === undefined) {
      findings.push(`package.json overrides ${name} with no OVERRIDE_REGISTER row (packages/dev-tools/src/override-register.ts): state its reason and whether adopters reach it`);
      continue;
    }
    findings.push(...rowFindings(name, row, reach.has(name)));
  }
  for (const name of Object.keys(register)) {
    if (!(name in overrides)) findings.push(`OVERRIDE_REGISTER has a row for ${name}, which package.json no longer overrides: delete the row`);
  }
  return findings;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function main(): void {
  const lockText = readFileSync(safePath.join(PROJECT_ROOT, 'bun.lock'), 'utf8');
  const published = new Set(
    Object.keys(parseBunLock(lockText).workspaces).filter((path) => path !== '' && readJson(safePath.join(PROJECT_ROOT, path, 'package.json'))['private'] !== true),
  );
  const overrides = readJson(safePath.join(PROJECT_ROOT, 'package.json'))['overrides'];
  const findings = overrideFindings(typeof overrides === 'object' && overrides !== null ? (overrides as Record<string, unknown>) : {}, publishedReach(lockText, published), OVERRIDE_REGISTER);
  reportFindings(findings, `package.json overrides: ${Object.keys(OVERRIDE_REGISTER).length} pins, each with its reach stated truly.`);
}

if (isEntrypoint(import.meta.url)) main();
