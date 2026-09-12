/**
 * Content-type-aware routing for skill packaging.
 *
 * Routes auto-discovered non-markdown files to subdirectories based on
 * file extension. This is the single source of truth for extension→subdirectory
 * mapping, isolated so it can be replaced with config-driven routing later.
 */

import { extname } from 'node:path';

/**
 * Target subdirectory categories for packaged skill files.
 *
 * Runtime value, not just a type: every consumer that needs to enumerate the
 * bundled-subdirectory vocabulary (e.g. the bundled-resource link detector)
 * derives it from here so the two can never drift apart.
 */
export const TARGET_SUBDIR_CATEGORIES = ['resources', 'scripts', 'templates', 'assets'] as const;

/** Target subdirectory categories for packaged skill files */
export type TargetSubdirCategory = (typeof TARGET_SUBDIR_CATEGORIES)[number];

/**
 * Subdirectory the `claude-web` packaging target packs every resource into.
 *
 * Target-specific layout name rather than a content-type routing category —
 * claude-web ignores extension routing and flattens everything into
 * `references/`. Consumers enumerating on-disk bundled subdirectories need
 * this alongside {@link TARGET_SUBDIR_CATEGORIES}.
 */
export const CLAUDE_WEB_REFERENCES_SUBDIR = 'references';

/**
 * Static extension→subdirectory mapping.
 *
 * Keys are lowercase extensions including the leading dot.
 * Values are subdirectory names (without trailing slash).
 */
const EXTENSION_MAP = new Map<string, TargetSubdirCategory>([
  // Markdown → resources
  ['.md', 'resources'],

  // Scripts
  ['.mjs', 'scripts'],
  ['.cjs', 'scripts'],
  ['.js', 'scripts'],
  ['.ts', 'scripts'],
  ['.sh', 'scripts'],
  ['.bash', 'scripts'],
  ['.zsh', 'scripts'],
  ['.ps1', 'scripts'],
  ['.py', 'scripts'],
  ['.rb', 'scripts'],
  ['.pl', 'scripts'],

  // Templates
  ['.json', 'templates'],
  ['.yaml', 'templates'],
  ['.yml', 'templates'],
  ['.toml', 'templates'],
  ['.xml', 'templates'],
  ['.ini', 'templates'],
  ['.cfg', 'templates'],
  ['.conf', 'templates'],
  ['.hbs', 'templates'],
  ['.mustache', 'templates'],
  ['.ejs', 'templates'],
  ['.njk', 'templates'],
  ['.tmpl', 'templates'],
  ['.tpl', 'templates'],

  // Assets
  ['.png', 'assets'],
  ['.jpg', 'assets'],
  ['.svg', 'assets'],
  ['.gif', 'assets'],
  ['.webp', 'assets'],
  ['.ico', 'assets'],
  ['.bmp', 'assets'],
  ['.tiff', 'assets'],
  ['.avif', 'assets'],
  ['.webm', 'assets'],
  ['.pdf', 'assets'],
  ['.woff', 'assets'],
  ['.woff2', 'assets'],
  ['.ttf', 'assets'],
  ['.eot', 'assets'],
  ['.css', 'assets'],
]);

/** Read-only view of the extension→subdirectory map for inspection/testing */
export const CONTENT_TYPE_ROUTING_MAP: ReadonlyMap<string, TargetSubdirCategory> = EXTENSION_MAP;

/**
 * Determine the target subdirectory for a file based on its extension.
 *
 * Uses a static extension map. Files ending in `.example` (e.g., `.env.example`)
 * are routed to `templates/`. Unknown extensions fall back to `resources/`.
 *
 * @param filePath - File path (absolute or relative, only extension is used)
 * @returns Subdirectory name: 'scripts', 'templates', 'assets', or 'resources'
 */
export function getTargetSubdir(filePath: string): TargetSubdirCategory {
  const ext = extname(filePath).toLowerCase();

  // Special case: *.example → templates (e.g., .env.example, settings.json.example)
  if (ext === '.example') {
    return 'templates';
  }

  return EXTENSION_MAP.get(ext) ?? 'resources';
}

/**
 * Packaging target: determines ZIP directory structure
 * - 'claude-code': Standard VAT format with resources/ subdirectory (default)
 * - 'claude-web': Claude.ai web upload format with references/, scripts/, assets/ subdirectories
 */
export type PackagingTarget = 'claude-code' | 'claude-web';

/**
 * The subdirectory the packager puts a bundled file in — THE routing answer.
 *
 * ⛔ {@link getTargetSubdir} is only half of it. It reads the extension, which is
 * the `claude-code` rule; `claude-web` ignores extensions entirely and flattens
 * every resource into {@link CLAUDE_WEB_REFERENCES_SUBDIR}. Anything asking
 * *"where does this file end up?"* must ask HERE and pass the target.
 *
 * 🚩 This function lived in `skill-packager.ts`, and a validator that needed the
 * same answer could not import it without a cycle — so it called
 * `getTargetSubdir` instead and silently answered for one target. That made the
 * whole `claude-web` packaging target false-positive
 * `PACKAGED_REFERENCED_PATH_MISSING` on files that shipped: same fixture, clean
 * under `--target claude-code`, a finding under `--target claude-web`. Two
 * routing answers for one question is the defect, and it lives with the routing
 * table now so there can only be one.
 */
export function getResourceSubdirForFile(filePath: string, target: PackagingTarget): string {
  if (target === 'claude-web') {
    return CLAUDE_WEB_REFERENCES_SUBDIR;
  }
  return getTargetSubdir(filePath);
}
