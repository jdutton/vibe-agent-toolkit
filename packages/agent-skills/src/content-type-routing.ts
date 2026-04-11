/**
 * Content-type-aware routing for skill packaging.
 *
 * Routes auto-discovered non-markdown files to subdirectories based on
 * file extension. This is the single source of truth for extension→subdirectory
 * mapping, isolated so it can be replaced with config-driven routing later.
 */

import { extname } from 'node:path';

/** Target subdirectory categories for packaged skill files */
export type TargetSubdirCategory = 'resources' | 'scripts' | 'templates' | 'assets';

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
