/* eslint-disable security/detect-non-literal-fs-filename -- test writes to temp dirs from computed paths */
import { mkdtemp, writeFile } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import { parseHtml } from '../src/html-link-parser.js';

const dirs: string[] = [];

async function writeHtml(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-html-'));
  dirs.push(dir);
  const file = safePath.join(dir, name);
  await writeFile(file, body, 'utf-8');
  return file;
}

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('parseHtml', () => {
  it('extracts <a href> and <img src> links', async () => {
    const file = await writeHtml(
      'page.html',
      '<html><body><a href="./other.html">x</a><img src="img/logo.png"></body></html>',
    );
    const result = await parseHtml(file);
    const hrefs = result.links.map((l) => l.href).sort((a, b) => a.localeCompare(b));
    expect(hrefs).toEqual(['./other.html', 'img/logo.png']);
    expect(result.links.find((l) => l.href === './other.html')?.type).toBe('local_file');
  });

  it('collects id and name attributes as anchors', async () => {
    const file = await writeHtml(
      'anchors.html',
      '<html><body><h2 id="intro">Intro</h2><a name="legacy"></a></body></html>',
    );
    const result = await parseHtml(file);
    expect(new Set(result.anchors)).toEqual(new Set(['intro', 'legacy']));
    expect(result.headings).toEqual([]);
  });

  it('reports malformed markup via parseErrors', async () => {
    const file = await writeHtml('bad.html', '<html><body><p>unclosed</body></html>');
    const result = await parseHtml(file);
    expect(result.parseErrors).toBeDefined();
    expect((result.parseErrors ?? []).length).toBeGreaterThan(0);
  });

  it('omits anchors/parseErrors when there are none', async () => {
    const file = await writeHtml('clean.html', '<!doctype html><title>t</title><p>hi</p>');
    const result = await parseHtml(file);
    expect(result.anchors).toBeUndefined();
    expect(result.parseErrors).toBeUndefined();
  });
});
