/**
 * Acceptance test: HTML fragment anchors are skipped by default, and only
 * validated strictly when the caller opts in via `checkHtmlAnchors: true`.
 *
 * Real-world HTML pages frequently link to fragments that are resolved at
 * runtime by client-side JavaScript (hash routers, SPA route fragments,
 * hash-encoded param strings) rather than a literal `id` attribute present
 * in the markup. Treating those the same as static HTML ids produced
 * false-positive LINK_BROKEN_ANCHOR issues. This test is the regression
 * guard: it exercises the three fragment shapes (patterned after real
 * external-adopter HTML, reproduced here as synthetic fixtures) end-to-end
 * through ResourceRegistry.validate().
 */

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeAll } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ValidationResult } from '../../src/schemas/validation-result.js';

const FIXTURES_DIR = safePath.resolve(import.meta.dirname, '../fixtures/html-anchors');
const FIXTURE_FILES = ['a-app.html', 'b-intake.html', 'c-app.html'];

/** Filter a validation result down to LINK_BROKEN_ANCHOR issues. */
function brokenAnchors(result: ValidationResult): ValidationResult['issues'] {
  return result.issues.filter((issue) => issue.code === 'LINK_BROKEN_ANCHOR');
}

describe('HTML anchor defaults (regression guard for runtime-resolved fragments)', () => {
  let registry: ResourceRegistry;

  beforeAll(async () => {
    // addResources() (not crawl()) so the fixtures are picked up even when they
    // are not yet committed to git — crawl() discovers files via `git ls-files`
    // and would silently skip untracked fixtures, turning this into a vacuous pass.
    registry = new ResourceRegistry({ baseDir: FIXTURES_DIR });
    await registry.addResources(FIXTURE_FILES.map((name) => safePath.join(FIXTURES_DIR, name)));
  });

  it('default validate() flags zero LINK_BROKEN_ANCHOR across hash-router, param-string, and SPA-route fragments', async () => {
    // a-app.html: #planning resolved at runtime via data-tab lookup (not a literal id)
    // b-intake.html: #id=abc123&mode=client is a hash-encoded param string
    // c-app.html: #/pipeline, #/settings are SPA route fragments
    expect(registry.size()).toBe(FIXTURE_FILES.length);

    const result = await registry.validate({ skipGitIgnoreCheck: true });

    expect(brokenAnchors(result)).toHaveLength(0);
  });

  it('opt-in checkHtmlAnchors: true still catches a genuinely missing HTML id', async () => {
    // a-app.html's only literal id is "tab-planning" (via data-tab), not "planning" —
    // so strict mode must still flag #planning as broken. This proves the fix is a
    // default-skip, not a blanket skip.
    const result = await registry.validate({ skipGitIgnoreCheck: true, checkHtmlAnchors: true });
    const broken = brokenAnchors(result);

    expect(broken).toHaveLength(1);
    expect(broken[0]?.link).toBe('#planning');
  });
});
