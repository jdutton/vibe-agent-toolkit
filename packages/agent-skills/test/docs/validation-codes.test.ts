/* eslint-disable security/detect-non-literal-fs-filename */
// Test file reads a fixture path computed from __dirname — not user input
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CODE_REGISTRY } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import GithubSlugger from 'github-slugger';
import { describe, expect, it } from 'vitest';


const __dirname = fileURLToPath(new URL('.', import.meta.url));
// Repo root is 4 levels up: packages/agent-skills/test/docs -> repo root
const REPO_ROOT = safePath.resolve(__dirname, '../../../..');
const DOC_PATH = safePath.resolve(REPO_ROOT, 'docs/validation-codes.md');

/**
 * Compute a heading anchor with the EXACT algorithm VAT's link validator uses:
 * `github-slugger` applied to the visible heading text (see
 * packages/resources/src/link-parser.ts). VAT does NOT honor kramdown `{#id}`
 * attributes, so this test must not either — the anchor an in-doc link resolves
 * against is solely the GitHub slug of the heading text.
 *
 * `GithubSlugger` is stateful: a single instance deduplicates repeated slugs by
 * appending `-1`, `-2`, … A FRESH instance per call avoids that dedup so each
 * heading is slugged independently, exactly as a reader following one link sees it.
 */
function githubSlug(headingText: string): string {
  return new GithubSlugger().slug(headingText);
}

/**
 * Collect every heading anchor the doc exposes, computed the way VAT computes
 * them: the GitHub slug of the visible heading text. Kramdown `{#anchor}`
 * attributes are intentionally NOT honored — VAT's link validator ignores them,
 * so the doc's in-page links must resolve against the slugged heading text.
 */
function collectDocAnchors(doc: string): Set<string> {
  const anchors = new Set<string>();
  for (const rawLine of doc.split('\n')) {
    const line = rawLine.trimStart();
    if (!line.startsWith('#')) continue;
    const text = line.replace(/^#+/, '').trim();
    if (text.length === 0) continue;
    anchors.add(githubSlug(text));
  }
  return anchors;
}

describe('docs/validation-codes.md', () => {
  const doc = readFileSync(DOC_PATH, 'utf-8');
  const docAnchors = collectDocAnchors(doc);

  for (const [code, entry] of Object.entries(CODE_REGISTRY)) {
    it(`documents ${code} at a heading whose GitHub anchor equals ${entry.reference}`, () => {
      // entry.reference is the canonical anchor shown in CLI output, e.g. '#link_broken_file'.
      // Strip the leading '#' and require a heading whose real GitHub-slugified
      // (or explicit {#...}) anchor EQUALS it — substring matching would let a
      // mismatched auto-slug (e.g. '#link_broken_file-link_broken_file') pass.
      const expectedAnchor = entry.reference.slice(1);
      expect(docAnchors).toContain(expectedAnchor);
    });
  }

  it('includes the severity model section', () => {
    expect(doc).toMatch(/## Severity Model/i);
  });

  it('includes the migration table', () => {
    expect(doc).toMatch(/ignoreValidationErrors/);
    expect(doc).toMatch(/validation\.severity/);
    expect(doc).toMatch(/validation\.allow/);
  });

  // --- Single-source rule catalog (issue #129 AC5) -------------------------
  // The catalog table is the spine: its Severity / Description / Fix cells must
  // equal CODE_REGISTRY exactly, so the registry, docs, and runtime cannot
  // drift. Tightened from anchor-presence to full cell equality.
  describe('rule catalog (registry == docs)', () => {
    const rows = parseCatalogRows(doc);

    it('has a catalog table between the BEGIN/END markers', () => {
      expect(rows.size).toBeGreaterThan(0);
    });

    it('every catalog code is a real registry code', () => {
      for (const code of rows.keys()) {
        expect(CODE_REGISTRY).toHaveProperty(code);
      }
    });

    for (const [code, cells] of parseCatalogRows(doc)) {
      it(`${code} catalog row equals registry severity/description/fix`, () => {
        const entry = CODE_REGISTRY[code as keyof typeof CODE_REGISTRY];
        expect(cells.severity).toBe(entry.defaultSeverity);
        expect(cells.description).toBe(entry.description);
        expect(cells.fix).toBe(entry.fix);
      });
    }
  });
});

interface CatalogCells {
  severity: string;
  description: string;
  fix: string;
}

/**
 * Parse the `<!-- BEGIN:rule-catalog -->`…`<!-- END:rule-catalog -->` markdown
 * table into `code → {severity, description, fix}`. Unescapes `\|` cell escapes
 * and extracts the code name from the `[`CODE`](#anchor)` link cell.
 */
function parseCatalogRows(doc: string): Map<string, CatalogCells> {
  const block = /<!-- BEGIN:rule-catalog[^>]*-->([\s\S]*?)<!-- END:rule-catalog -->/.exec(doc);
  const rows = new Map<string, CatalogCells>();
  if (!block?.[1]) return rows;
  const codeCell = /`([A-Z0-9_]+)`/;
  for (const rawLine of block[1].split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.slice(1, -1).split('|').map(c => c.trim().replaceAll(String.raw`\|`, '|'));
    if (cells.length !== 4) continue;
    const codeMatch = codeCell.exec(cells[0] ?? '');
    if (!codeMatch?.[1]) continue; // skip header / separator rows
    rows.set(codeMatch[1], {
      severity: cells[1] ?? '',
      description: cells[2] ?? '',
      fix: cells[3] ?? '',
    });
  }
  return rows;
}
