/* eslint-disable security/detect-non-literal-fs-filename -- test writes to temp dirs from computed paths */
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import { parseHtml, parseHtmlContent } from '../src/html-link-parser.js';

const dirs: string[] = [];

async function writeHtml(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-html-'));
  dirs.push(dir);
  const file = safePath.join(dir, name);
  await writeFile(file, body, 'utf-8');
  return file;
}

/**
 * Write raw bytes, bypassing UTF-8 encoding.
 *
 * Needed because every ASCII fixture makes `stat().size` and
 * `Buffer.byteLength(decodedContent)` equal, so an ASCII-only suite cannot tell
 * the two apart — and telling them apart is the whole point of `sizeBytes`
 * being a parameter.
 */
async function writeHtmlBytes(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-html-'));
  dirs.push(dir);
  const file = safePath.join(dir, name);
  await writeFile(file, bytes);
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

describe('parseHtmlContent', () => {
  it('is equivalent to parseHtml for the same file', async () => {
    const file = await writeHtml(
      'equivalence.html',
      [
        // No doctype on purpose: parse5 reports `missing-doctype`, so this
        // fixture exercises the optional `parseErrors` key as well as `anchors`.
        '<html><head><title>Equivalence</title></head>',
        '<body><h1 id="top">Top</h1>',
        '<a href="./other.html">other</a>',
        '<a name="legacy"></a>',
        '<img src="img/logo.png">',
        '<p>unclosed',
        '</body></html>',
      ].join('\n'),
    );

    const fromFile = await parseHtml(file);
    const [content, stats] = await Promise.all([readFile(file, 'utf-8'), stat(file)]);
    const fromContent = parseHtmlContent(content, stats.size);

    expect(fromContent).toEqual(fromFile);
    // Shape guards: HTML omits unresolvedReferences entirely and does populate
    // parseErrors — the inverse of the markdown parser. Both halves must agree.
    expect('unresolvedReferences' in fromContent).toBe(false);
    expect('unresolvedReferences' in fromFile).toBe(false);
    expect(fromContent.parseErrors).toBeDefined();
  });

  it('parses content that corresponds to no file on disk', () => {
    const result = parseHtmlContent(
      '<html><body><h2 id="virtual">V</h2><a href="https://example.com">e</a></body></html>',
      4242,
    );

    expect(result.links.map((l) => l.href)).toEqual(['https://example.com']);
    expect(result.anchors).toEqual(['virtual']);
    expect(result.headings).toEqual([]);
    // sizeBytes is whatever the caller supplied — never derived from content.
    expect(result.sizeBytes).toBe(4242);
  });

  it('reports the on-disk byte count, not the decoded string length', async () => {
    // A lone 0xFF is invalid UTF-8 and decodes to U+FFFD, which re-encodes to
    // THREE bytes. So the file is 17 bytes on disk but its decoded form measures
    // 19 — the only condition under which `stat().size`,
    // `Buffer.byteLength(content)` and `content.length` disagree.
    //
    // This fixture exists because the suite could not otherwise tell them apart:
    // with ASCII-only fixtures, swapping `stat().size` for
    // `Buffer.byteLength(content)` in `parseHtml` leaves every test green. That
    // swap is a real defect — `sizeBytes` reaches packaged output bytes via
    // content-transform.ts — so it must be falsifiable here.
    const file = await writeHtmlBytes(
      'malformed.html',
      Uint8Array.from([...Buffer.from('<p id="bad">'), 0xff, ...Buffer.from('</p>')]),
    );

    const [content, stats] = await Promise.all([readFile(file, 'utf-8'), stat(file)]);

    // Guard the guard: if these ever stop differing the fixture has lost its
    // power and the assertions below become vacuous.
    expect(stats.size).toBe(17);
    expect(Buffer.byteLength(content)).toBe(19);
    expect(content.length).toBe(17);

    const fromFile = await parseHtml(file);
    expect(fromFile.sizeBytes).toBe(stats.size);
    expect(fromFile.sizeBytes).not.toBe(Buffer.byteLength(content));

    // And the content-only half reports exactly what it was handed.
    expect(parseHtmlContent(content, stats.size).sizeBytes).toBe(17);
    expect(parseHtmlContent(content, Buffer.byteLength(content)).sizeBytes).toBe(19);
  });
});
