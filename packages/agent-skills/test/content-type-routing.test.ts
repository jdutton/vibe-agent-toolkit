import { describe, expect, it } from 'vitest';

import { getTargetSubdir, CONTENT_TYPE_ROUTING_MAP } from '../src/content-type-routing.js';

describe('getTargetSubdir', () => {
  // Scripts
  it('should route .mjs to scripts/', () => {
    expect(getTargetSubdir('dist/bin/cli.mjs')).toBe('scripts');
  });

  it('should route .cjs to scripts/', () => {
    expect(getTargetSubdir('lib/helper.cjs')).toBe('scripts');
  });

  it('should route .js to scripts/', () => {
    expect(getTargetSubdir('tools/run.js')).toBe('scripts');
  });

  it('should route .ts to scripts/', () => {
    expect(getTargetSubdir('src/main.ts')).toBe('scripts');
  });

  it('should route .sh to scripts/', () => {
    expect(getTargetSubdir('bin/setup.sh')).toBe('scripts');
  });

  it('should route .bash to scripts/', () => {
    expect(getTargetSubdir('bin/deploy.bash')).toBe('scripts');
  });

  it('should route .zsh to scripts/', () => {
    expect(getTargetSubdir('bin/init.zsh')).toBe('scripts');
  });

  it('should route .ps1 to scripts/', () => {
    expect(getTargetSubdir('scripts/setup.ps1')).toBe('scripts');
  });

  it('should route .py to scripts/', () => {
    expect(getTargetSubdir('tools/migrate.py')).toBe('scripts');
  });

  it('should route .rb to scripts/', () => {
    expect(getTargetSubdir('tools/generate.rb')).toBe('scripts');
  });

  it('should route .pl to scripts/', () => {
    expect(getTargetSubdir('tools/parse.pl')).toBe('scripts');
  });

  // Templates
  it('should route .json to templates/', () => {
    expect(getTargetSubdir('config/settings.json')).toBe('templates');
  });

  it('should route .yaml to templates/', () => {
    expect(getTargetSubdir('config/app.yaml')).toBe('templates');
  });

  it('should route .yml to templates/', () => {
    expect(getTargetSubdir('config/docker-compose.yml')).toBe('templates');
  });

  it('should route .toml to templates/', () => {
    expect(getTargetSubdir('config/pyproject.toml')).toBe('templates');
  });

  it('should route .xml to templates/', () => {
    expect(getTargetSubdir('config/pom.xml')).toBe('templates');
  });

  it('should route .ini to templates/', () => {
    expect(getTargetSubdir('config/settings.ini')).toBe('templates');
  });

  it('should route .cfg to templates/', () => {
    expect(getTargetSubdir('config/setup.cfg')).toBe('templates');
  });

  it('should route .conf to templates/', () => {
    expect(getTargetSubdir('config/nginx.conf')).toBe('templates');
  });

  it('should route .hbs to templates/', () => {
    expect(getTargetSubdir('views/page.hbs')).toBe('templates');
  });

  it('should route .mustache to templates/', () => {
    expect(getTargetSubdir('views/partial.mustache')).toBe('templates');
  });

  it('should route .ejs to templates/', () => {
    expect(getTargetSubdir('views/index.ejs')).toBe('templates');
  });

  it('should route .njk to templates/', () => {
    expect(getTargetSubdir('views/layout.njk')).toBe('templates');
  });

  it('should route .tmpl to templates/', () => {
    expect(getTargetSubdir('views/page.tmpl')).toBe('templates');
  });

  it('should route .tpl to templates/', () => {
    expect(getTargetSubdir('views/header.tpl')).toBe('templates');
  });

  it('should route *.example to templates/', () => {
    expect(getTargetSubdir('config/.env.example')).toBe('templates');
    expect(getTargetSubdir('config/settings.json.example')).toBe('templates');
    expect(getTargetSubdir('config/database.yml.example')).toBe('templates');
  });

  // Assets
  it('should route .png to assets/', () => {
    expect(getTargetSubdir('images/logo.png')).toBe('assets');
  });

  it('should route .jpg to assets/', () => {
    expect(getTargetSubdir('images/photo.jpg')).toBe('assets');
  });

  it('should route .svg to assets/', () => {
    expect(getTargetSubdir('icons/arrow.svg')).toBe('assets');
  });

  it('should route .gif to assets/', () => {
    expect(getTargetSubdir('images/spinner.gif')).toBe('assets');
  });

  it('should route .webp to assets/', () => {
    expect(getTargetSubdir('images/hero.webp')).toBe('assets');
  });

  it('should route .ico to assets/', () => {
    expect(getTargetSubdir('favicon.ico')).toBe('assets');
  });

  it('should route .bmp to assets/', () => {
    expect(getTargetSubdir('images/old.bmp')).toBe('assets');
  });

  it('should route .tiff to assets/', () => {
    expect(getTargetSubdir('images/scan.tiff')).toBe('assets');
  });

  it('should route .avif to assets/', () => {
    expect(getTargetSubdir('images/modern.avif')).toBe('assets');
  });

  it('should route .webm to assets/', () => {
    expect(getTargetSubdir('media/clip.webm')).toBe('assets');
  });

  it('should route .pdf to assets/', () => {
    expect(getTargetSubdir('docs/manual.pdf')).toBe('assets');
  });

  it('should route .woff to assets/', () => {
    expect(getTargetSubdir('fonts/inter.woff')).toBe('assets');
  });

  it('should route .woff2 to assets/', () => {
    expect(getTargetSubdir('fonts/inter.woff2')).toBe('assets');
  });

  it('should route .ttf to assets/', () => {
    expect(getTargetSubdir('fonts/mono.ttf')).toBe('assets');
  });

  it('should route .eot to assets/', () => {
    expect(getTargetSubdir('fonts/legacy.eot')).toBe('assets');
  });

  it('should route .css to assets/', () => {
    expect(getTargetSubdir('styles/main.css')).toBe('assets');
  });

  // Markdown (stays in resources)
  it('should route .md to resources/', () => {
    expect(getTargetSubdir('docs/guide.md')).toBe('resources');
  });

  // Unknown/fallback
  it('should route unknown extensions to resources/', () => {
    expect(getTargetSubdir('data/file.csv')).toBe('resources');
    expect(getTargetSubdir('data/file.parquet')).toBe('resources');
    expect(getTargetSubdir('data/file.sql')).toBe('resources');
  });

  // Edge cases
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
