/* eslint-disable security/detect-non-literal-fs-filename */
// Test file reads a fixture path computed from __dirname — not user input
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CODE_REGISTRY } from '@vibe-agent-toolkit/agent-schema';
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
});
