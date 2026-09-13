#!/usr/bin/env tsx
/**
 * Regenerate the file-derived lists in the root `CLAUDE.md` and the other
 * documents that carry one ({@link GENERATED_DOCUMENTS}).
 *
 * `CLAUDE.md` is loaded into every agent session, and four of its lists were
 * `ls` output that nothing re-derived: they were correct the day they were
 * written and wrong within a month (a skill missing from the skills table, a
 * contributing doc missing from the docs list, 29 of 36 dev-tools scripts
 * unlisted, five `resolveAssetReference` call sites unlisted). Each such list
 * now sits between `<!-- gen:<name> -->` and `<!-- /gen:<name> -->` markers in
 * the document whose topic it belongs to, this script owns what is between
 * them, and `--check` (run by `validate-structure`) fails when the committed
 * text is not what the tree says.
 *
 * Usage:
 *   bun run --cwd packages/dev-tools generate:claude-md           # rewrite every generated block
 *   bun run --cwd packages/dev-tools generate:claude-md --check   # exit 1 if any block is stale
 *
 * The prose around a block is hand-written and never touched. The indentation
 * of the opening marker is applied to every generated line, so a block inside
 * a list item stays inside it.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { ExitCode, type ExitCodeValue } from '@vibe-agent-toolkit/schema';
import { direntKindFollowingSync, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { isEntrypoint, log, PROJECT_ROOT } from './common.js';
import { readWorkspaceGraph } from './workspace-graph.js';

const CLAUDE_MD = 'CLAUDE.md';
/** Column at which the comma-separated lists wrap, matching the hand-written prose. */
const WRAP_COLUMN = 100;
const SKILLS_DIR = 'packages/vat-development-agents/resources/skills';
const ROUTER_SKILL = 'SKILL.md';
const DEV_TOOLS_SRC = 'packages/dev-tools/src';
const CONTRIBUTING_DOCS = 'docs/contributing';
const ASSET_REFERENCE_FN = 'resolveAssetReference';

/** A generator produces the lines of one block, without indentation. */
type BlockGenerator = (repoRoot: string) => string[];

/** Sorted entries of a directory, or an error naming it — never an empty list for a missing dir. */
function listDir(repoRoot: string, relDir: string): { name: string; isDirectory: boolean }[] {
  const dir = safePath.join(repoRoot, relDir);
  return readdirSync(dir, { withFileTypes: true })
    // Followed: a linked directory is listed as the directory it is.
    .map((entry) => ({ name: entry.name, isDirectory: direntKindFollowingSync(dir, entry) === 'directory' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Wrap backticked names into comma-separated lines no wider than {@link WRAP_COLUMN}. */
export function wrapBacktickedList(names: readonly string[], indentWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  const items = names.map((name, index) => `\`${name}\`${index < names.length - 1 ? ',' : ''}`);
  for (const item of items) {
    const candidate = current === '' ? item : `${current} ${item}`;
    if (current !== '' && indentWidth + candidate.length > WRAP_COLUMN) {
      lines.push(current);
      current = item;
    } else {
      current = candidate;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/** Every workspace package as a `| name | ships | purpose |` row. */
const packagesTree: BlockGenerator = (repoRoot) => {
  const rows = readWorkspaceGraph(repoRoot).packages.map((pkg) => {
    const description = pkg.manifest['description'];
    const purpose = typeof description === 'string' ? description : '';
    return `| \`${pkg.dir}\` | ${pkg.isPrivate ? 'private' : 'yes'} | ${purpose} |`;
  });
  return ['| Package | Ships | Purpose |', '|---|---|---|', ...rows];
};

/** Every top-level script under `packages/dev-tools/src/`, by basename. */
const devToolsScripts: BlockGenerator = (repoRoot) =>
  listDir(repoRoot, DEV_TOOLS_SRC)
    .filter((entry) => !entry.isDirectory && entry.name.endsWith('.ts'))
    .map((entry) => entry.name.slice(0, -'.ts'.length));

/** Every document under `docs/contributing/`. */
const contributingDocs: BlockGenerator = (repoRoot) =>
  listDir(repoRoot, CONTRIBUTING_DOCS)
    .filter((entry) => !entry.isDirectory && entry.name.endsWith('.md'))
    .map((entry) => entry.name);

/** Recursively collect `.ts` files under `dir`, repo-relative, sorted. */
function collectTypeScriptFiles(repoRoot: string, relDir: string, into: string[]): void {
  for (const entry of listDir(repoRoot, relDir)) {
    const rel = `${relDir}/${entry.name}`;
    if (entry.isDirectory) collectTypeScriptFiles(repoRoot, rel, into);
    else if (entry.name.endsWith('.ts')) into.push(rel);
  }
}

/**
 * Every `packages/*\/src` file that CALLS `resolveAssetReference` — the file
 * that defines it is not a call site and is left out by looking for the
 * `export function` form rather than by naming the file.
 */
const assetReferenceSites: BlockGenerator = (repoRoot) => {
  const files: string[] = [];
  for (const pkg of readWorkspaceGraph(repoRoot).packages) {
    const srcDir = `packages/${pkg.dir}/src`;
    try {
      collectTypeScriptFiles(repoRoot, srcDir, files);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  const call = `${ASSET_REFERENCE_FN}(`;
  const definition = `function ${ASSET_REFERENCE_FN}(`;
  return files
    .filter((rel) => {
      const text = readFileSync(safePath.join(repoRoot, rel), 'utf8');
      return text.includes(call) && !text.includes(definition);
    })
    .sort((a, b) => a.localeCompare(b))
    .map((rel) => `- \`${toForwardSlash(rel)}\``);
};

/** The `name:` of a skill file's frontmatter, or an error naming the file. */
function skillName(repoRoot: string, relPath: string): string {
  const text = readFileSync(safePath.join(repoRoot, relPath), 'utf8');
  // Only the leading frontmatter block: a skill body may quote another
  // skill's frontmatter in a code fence, and that `name:` is not this file's.
  const frontmatter = text.startsWith('---\n') ? text.slice(4, text.indexOf('\n---', 4)) : '';
  const name = frontmatter
    .split('\n')
    .filter((line) => line.startsWith('name:'))
    .map((line) => line.slice('name:'.length).trim())
    .find((value) => value !== '');
  if (name === undefined || name === '') {
    throw new Error(`${relPath} has no frontmatter \`name:\`; every shipped skill must declare one`);
  }
  return name;
}

/**
 * The router's `| If you're working on... | Load |` table, inverted: each
 * sub-skill's routing cells, in table order.
 */
function routerRows(repoRoot: string): Map<string, string[]> {
  const text = readFileSync(safePath.join(repoRoot, SKILLS_DIR, ROUTER_SKILL), 'utf8');
  const rows = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    // `| <when> | \`vibe-agent-toolkit:<skill>\` |` — split on the pipes rather
    // than one regex, which would backtrack across the whole cell.
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const [, when, load] = cells;
    const skill = load !== undefined && /^`vibe-agent-toolkit:[\w-]+`$/.test(load) ? load.slice('`vibe-agent-toolkit:'.length, -1) : undefined;
    if (when === undefined || when === '' || skill === undefined || cells.length !== 4) continue;
    const list = rows.get(skill) ?? [];
    list.push(when);
    rows.set(skill, list);
  }
  return rows;
}

/**
 * One row per shipped skill, with "use when" taken from the router skill's
 * own routing table — the one place the plugin already decides which skill a
 * task belongs to. A skill the router does not route to, or a router row
 * naming a skill that is not on disk, throws: both are plugin defects, and a
 * table that silently omitted either would hide them.
 */
const skillsTable: BlockGenerator = (repoRoot) => {
  const files = listDir(repoRoot, SKILLS_DIR)
    .filter((entry) => !entry.isDirectory && entry.name.endsWith('.md') && entry.name !== 'CLAUDE.md')
    .map((entry) => entry.name);
  const routes = routerRows(repoRoot);
  const onDisk = new Map<string, string>();
  for (const file of files) onDisk.set(skillName(repoRoot, `${SKILLS_DIR}/${file}`), file);

  const unrouted = [...onDisk.keys()].filter((name) => name !== skillName(repoRoot, `${SKILLS_DIR}/${ROUTER_SKILL}`) && !routes.has(name));
  const phantom = [...routes.keys()].filter((name) => !onDisk.has(name));
  if (unrouted.length > 0 || phantom.length > 0) {
    throw new Error(
      `${SKILLS_DIR}/${ROUTER_SKILL} and the skill files disagree — ` +
        `not routed to: [${unrouted.join(', ')}]; routed to but absent: [${phantom.join(', ')}]`,
    );
  }

  const routerName = skillName(repoRoot, `${SKILLS_DIR}/${ROUTER_SKILL}`);
  const rows = [`| \`${routerName}\` (\`${ROUTER_SKILL}\`) | Starting VAT work or deciding which sub-skill applies — the router; load it first |`];
  for (const [name, file] of [...onDisk.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (file === ROUTER_SKILL) continue;
    rows.push(`| \`${name}\` | ${(routes.get(name) ?? []).join(' · ')} |`);
  }
  return ['| Skill | Use when |', '|---|---|', ...rows];
};

/** Every block name a generated document may carry, and what fills it. */
export const CLAUDE_MD_GENERATORS: Readonly<Record<string, BlockGenerator>> = {
  'packages-tree': packagesTree,
  'dev-tools-scripts': (repoRoot) => wrapBacktickedList(devToolsScripts(repoRoot), 0),
  'skills-table': skillsTable,
  'contributing-docs': (repoRoot) => wrapBacktickedList(contributingDocs(repoRoot), 2),
  'asset-reference-sites': assetReferenceSites,
};

/** A document that carries generated blocks, and the blocks it must carry. */
export interface GeneratedDocument {
  /** Repo-relative path. */
  readonly path: string;
  /** Every block name the document must carry — a missing one is a list with nowhere to go. */
  readonly blocks: readonly string[];
}

/**
 * Where each generated list lives: beside the rule it serves, so a list is
 * loaded only by the session that reads that rule. Every generator name is
 * claimed by exactly one document (pinned by the unit test).
 */
export const GENERATED_DOCUMENTS: readonly GeneratedDocument[] = [
  { path: CLAUDE_MD, blocks: ['packages-tree', 'skills-table', 'contributing-docs'] },
  { path: '.claude/rules/asset-references.md', blocks: ['asset-reference-sites'] },
  { path: 'packages/dev-tools/README.md', blocks: ['dev-tools-scripts'] },
];

const OPEN_MARKER = /^([ \t]*)<!-- gen:([\w-]+) -->[ \t]*$/;
const CLOSE_MARKER = /^[ \t]*<!-- \/gen:([\w-]+) -->[ \t]*$/;

/** The result of regenerating one document's blocks. */
export interface RegeneratedDocument {
  /** The document with every block regenerated. */
  readonly text: string;
  /** Block names whose content changed. */
  readonly changed: readonly string[];
  /** Every block name found, in document order. */
  readonly found: readonly string[];
}

/**
 * Regenerate every marked block in `text`.
 *
 * @param text - The current document
 * @param repoRoot - Where the generators read from
 * @param docPath - The document's repo-relative path, for the error messages
 * @returns The regenerated document and which blocks moved
 * @throws On a marker whose name has no generator, an unclosed block, or a
 *   close marker with no open — each is a block that would silently never be
 *   regenerated
 */
export function regenerateBlocks(text: string, repoRoot: string, docPath: string = CLAUDE_MD): RegeneratedDocument {
  const lines = text.split('\n');
  const out: string[] = [];
  const changed: string[] = [];
  const found: string[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const open = OPEN_MARKER.exec(line);
    if (!open) {
      if (CLOSE_MARKER.test(line)) throw new Error(`${docPath}:${index + 1}: close marker with no open block`);
      out.push(line);
      index += 1;
      continue;
    }

    const [, indent = '', name = ''] = open;
    const generator = CLAUDE_MD_GENERATORS[name];
    if (generator === undefined) {
      throw new Error(`${docPath}:${index + 1}: no generator is registered for block "${name}"`);
    }
    found.push(name);

    const closeIndex = lines.findIndex((candidate, at) => at > index && CLOSE_MARKER.exec(candidate)?.[1] === name);
    if (closeIndex === -1) throw new Error(`${docPath}:${index + 1}: block "${name}" is never closed`);

    const previous = lines.slice(index + 1, closeIndex);
    const generated = generator(repoRoot).map((generatedLine) => `${indent}${generatedLine}`);
    if (previous.join('\n') !== generated.join('\n')) changed.push(name);

    out.push(line, ...generated, lines[closeIndex] ?? '');
    index = closeIndex + 1;
  }

  return { text: out.join('\n'), changed, found };
}

/** One document's regeneration: the result plus the blocks it must carry but does not. */
export interface RegeneratedDocumentReport {
  readonly document: GeneratedDocument;
  readonly result: RegeneratedDocument;
  readonly missing: readonly string[];
}

/** Regenerate one document in memory (nothing is written). */
export function regenerateDocument(repoRoot: string, document: GeneratedDocument): RegeneratedDocumentReport {
  const text = readFileSync(safePath.join(repoRoot, document.path), 'utf8');
  const result = regenerateBlocks(text, repoRoot, document.path);
  const missing = document.blocks.filter((name) => !result.found.includes(name));
  return { document, result, missing };
}

/** Regenerate one document on disk unless `check`; the exit code says whether anything was off. */
function processDocument(document: GeneratedDocument, check: boolean): ExitCodeValue {
  const { result, missing } = regenerateDocument(PROJECT_ROOT, document);

  if (missing.length > 0) {
    log(`✗ ${document.path} carries no block for: ${missing.join(', ')}`, 'red');
    return ExitCode.FINDINGS;
  }

  if (result.changed.length === 0) {
    log(`✓ ${document.path} generated blocks match the tree (${result.found.length} blocks)`, 'green');
    return ExitCode.OK;
  }

  if (check) {
    log(`✗ ${document.path} generated block(s) are stale: ${result.changed.join(', ')}`, 'red');
    log('  Regenerate with: bun run --cwd packages/dev-tools generate:claude-md', 'yellow');
    return ExitCode.FINDINGS;
  }

  writeFileSync(safePath.join(PROJECT_ROOT, document.path), result.text, 'utf8');
  log(`✓ Regenerated ${document.path} block(s): ${result.changed.join(', ')}`, 'green');
  return ExitCode.OK;
}

function main(argv: readonly string[]): ExitCodeValue {
  const check = argv.includes('--check');
  const codes = GENERATED_DOCUMENTS.map((document) => processDocument(document, check));
  return codes.every((code) => code === ExitCode.OK) ? ExitCode.OK : ExitCode.FINDINGS;
}

if (isEntrypoint(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
