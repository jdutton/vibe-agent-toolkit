import { describe, expect, it } from 'vitest';

import { getTargetSubdir, CONTENT_TYPE_ROUTING_MAP, type TargetSubdirCategory } from '../src/content-type-routing.js';

/** [filePath, expectedSubdir] */
const ROUTING_CASES: Array<[string, TargetSubdirCategory]> = [
  // Scripts
  ['dist/bin/cli.mjs', 'scripts'],
  ['lib/helper.cjs', 'scripts'],
  ['tools/run.js', 'scripts'],
  ['src/main.ts', 'scripts'],
  ['bin/setup.sh', 'scripts'],
  ['bin/deploy.bash', 'scripts'],
  ['bin/init.zsh', 'scripts'],
  ['scripts/setup.ps1', 'scripts'],
  ['tools/migrate.py', 'scripts'],
  ['tools/generate.rb', 'scripts'],
  ['tools/parse.pl', 'scripts'],

  // Templates
  ['config/settings.json', 'templates'],
  ['config/app.yaml', 'templates'],
  ['config/docker-compose.yml', 'templates'],
  ['config/pyproject.toml', 'templates'],
  ['config/pom.xml', 'templates'],
  ['config/settings.ini', 'templates'],
  ['config/setup.cfg', 'templates'],
  ['config/nginx.conf', 'templates'],
  ['views/page.hbs', 'templates'],
  ['views/partial.mustache', 'templates'],
  ['views/index.ejs', 'templates'],
  ['views/layout.njk', 'templates'],
  ['views/page.tmpl', 'templates'],
  ['views/header.tpl', 'templates'],

  // Assets
  ['images/logo.png', 'assets'],
  ['images/photo.jpg', 'assets'],
  ['icons/arrow.svg', 'assets'],
  ['images/spinner.gif', 'assets'],
  ['images/hero.webp', 'assets'],
  ['favicon.ico', 'assets'],
  ['images/old.bmp', 'assets'],
  ['images/scan.tiff', 'assets'],
  ['images/modern.avif', 'assets'],
  ['media/clip.webm', 'assets'],
  ['docs/manual.pdf', 'assets'],
  ['fonts/inter.woff', 'assets'],
  ['fonts/inter.woff2', 'assets'],
  ['fonts/mono.ttf', 'assets'],
  ['fonts/legacy.eot', 'assets'],
  ['styles/main.css', 'assets'],

  // Markdown (stays in resources)
  ['docs/guide.md', 'resources'],
];

describe('getTargetSubdir', () => {
  it.each(ROUTING_CASES)(
    'should route %s to %s/',
    (filePath, expectedSubdir) => {
      expect(getTargetSubdir(filePath)).toBe(expectedSubdir);
    },
  );

  it('should route *.example to templates/', () => {
    expect(getTargetSubdir('config/.env.example')).toBe('templates');
    expect(getTargetSubdir('config/settings.json.example')).toBe('templates');
    expect(getTargetSubdir('config/database.yml.example')).toBe('templates');
  });

  it('should route unknown extensions to resources/', () => {
    expect(getTargetSubdir('data/file.csv')).toBe('resources');
    expect(getTargetSubdir('data/file.parquet')).toBe('resources');
    expect(getTargetSubdir('data/file.sql')).toBe('resources');
  });

  it('should handle files with no extension', () => {
    expect(getTargetSubdir('Makefile')).toBe('resources');
    expect(getTargetSubdir('Dockerfile')).toBe('resources');
  });

  it('should handle double extensions (use last)', () => {
    expect(getTargetSubdir('archive.tar.gz')).toBe('resources');
  });

  it('should handle paths with dots in directory names', () => {
    expect(getTargetSubdir('node_modules/.bin/cli.mjs')).toBe('scripts');
  });

  it('should be case-insensitive for extensions', () => {
    expect(getTargetSubdir('image/LOGO.PNG')).toBe('assets');
    expect(getTargetSubdir('scripts/Run.JS')).toBe('scripts');
  });
});

describe('CONTENT_TYPE_ROUTING_MAP', () => {
  it('should be a read-only map', () => {
    expect(CONTENT_TYPE_ROUTING_MAP).toBeDefined();
    expect(typeof CONTENT_TYPE_ROUTING_MAP.get).toBe('function');
  });
});
