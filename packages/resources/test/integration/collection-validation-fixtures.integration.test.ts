/**
 * Integration test for collection-based frontmatter validation using pre-built test fixtures.
 *
 * This test validates the comprehensive test fixtures in test-fixtures/collections/
 * against the behavior expected from Phase 6 (per-collection resource validation).
 *
 * Unlike system tests that create fixtures dynamically, this test uses static
 * fixtures that can be:
 * - Manually tested during development
 * - Used as examples for documentation
 * - Browsed to understand the feature
 *
 * Testing Approach:
 * - Uses VAT_TEST_ROOT and VAT_TEST_CONFIG environment variables
 * - Demonstrates the recommended pattern for testing with project configs
 * - Can be run manually: VAT_TEST_ROOT=./packages/resources/test-fixtures/collections vat resources validate
 */

import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load as loadYaml } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import type { ProjectConfig } from '../../src/schemas/project-config.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const fixturesDir = join(__dirname, '../../test-fixtures/collections');
const configPath = join(fixturesDir, 'vibe-agent-toolkit.config.yaml');

describe('Collection validation with test fixtures', () => {
  // Helper to load config consistently
  function loadTestConfig(): ProjectConfig {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- configPath is from controlled constant
    const configContent = readFileSync(configPath, 'utf-8');
    return loadYaml(configContent) as ProjectConfig;
  }

  // Helper to create registry and run validation
  async function setupAndValidate() {
    const config = loadTestConfig();

    const registry = new ResourceRegistry({
      config,
      rootDir: fixturesDir,
    });

    await registry.crawl({ baseDir: fixturesDir });
    const result = await registry.validate();

    return { config, registry, result };
  }

  // Set up environment variables for testing
  beforeEach(() => {
    process.env['VAT_TEST_ROOT'] = fixturesDir;
    process.env['VAT_TEST_CONFIG'] = configPath;
  });

  afterEach(() => {
    delete process.env['VAT_TEST_ROOT'];
    delete process.env['VAT_TEST_CONFIG'];
  });

  it('should validate test fixtures and find exactly 7 errors', async () => {
    const { result } = await setupAndValidate();

    // Should find exactly 7 validation errors (all issues are errors now)
    expect(result.issues).toHaveLength(7);

    // Verify all expected files have errors
    const errorFiles = result.issues.map((e) => basename(e.resourcePath));
    expect(errorFiles).toContain('guide-invalid-category.md');
    expect(errorFiles).toContain('guide-missing-required.md');
    expect(errorFiles).toContain('doc-invalid-status.md');
    expect(errorFiles).toContain('badName-SKILL.md');
    expect(errorFiles).toContain('missing-description-SKILL.md');
    expect(errorFiles).toContain('short-description-SKILL.md');
    expect(errorFiles).toContain('invalid-version-SKILL.md');
  });

  it('should pass validation for valid files', async () => {
    const { result } = await setupAndValidate();

    // Valid files should have no errors
    const validFiles = ['guide-valid.md', 'doc-valid.md', 'code-reviewer-SKILL.md'];
    const validFileErrors = result.issues.filter(
      (i) => validFiles.some((f) => i.resourcePath.includes(f))
    );

    expect(validFileErrors).toHaveLength(0);
  });

  it('should show helpful error messages with actual and expected values', async () => {
    const { result } = await setupAndValidate();

    // Find enum validation error (invalid category)
    const categoryError = result.issues.find(
      (i) =>
        i.resourcePath.includes('guide-invalid-category.md') &&
        i.message.includes('category')
    );
    expect(categoryError).toBeDefined();
    expect(categoryError?.message).toContain('got:'); // Shows actual value
    expect(categoryError?.message).toContain('Expected one of:'); // Shows allowed values

    // Find missing required field error
    const missingError = result.issues.find(
      (i) =>
        i.resourcePath.includes('guide-missing-required.md') &&
        i.message.includes('title')
    );
    expect(missingError).toBeDefined();
    expect(missingError?.message).toContain('Missing required property');

    // Find pattern validation error (kebab-case)
    const patternError = result.issues.find(
      (i) =>
        i.resourcePath.includes('badName-SKILL.md') &&
        i.message.includes('name')
    );
    expect(patternError).toBeDefined();
    expect(patternError?.message).toContain('Must match pattern');
    expect(patternError?.message).toContain('^[a-z0-9-]+$');
  });

  it('should apply strict mode correctly (no extra fields)', async () => {
    const { config, registry } = await setupAndValidate();

    // Verify guides collection uses strict mode
    expect(config.resources?.collections?.['guides']?.validation?.mode).toBe(
      'strict'
    );

    // Guide collection uses strict schema (additionalProperties: false)
    // Valid guide has no extra fields, should pass
    const validGuide = registry.getResourceById('guide-valid');
    expect(validGuide).toBeDefined();
  });

  it('should apply permissive mode correctly (extra fields allowed)', async () => {
    const { config, result } = await setupAndValidate();

    // Verify documentation collection uses permissive mode
    expect(config.resources?.collections?.['documentation']?.validation?.mode).toBe(
      'permissive'
    );

    // doc-valid.md has custom_field and another_custom which should be allowed
    const docErrors = result.issues.filter(
      (i) => i.resourcePath.includes('doc-valid.md')
    );
    expect(docErrors).toHaveLength(0);
  });

  it('should validate multiple schema requirements (skills collection)', async () => {
    const { result } = await setupAndValidate();

    // Skills collection should catch multiple error types
    const skillErrors = result.issues.filter(
      (i) =>
        i.resourcePath.includes('-SKILL.md') &&
        !i.resourcePath.includes('code-reviewer')
    );

    // 4 invalid skill files
    expect(skillErrors).toHaveLength(4);

    // Pattern validation (name not kebab-case)
    const patternErrors = skillErrors.filter((e) => e.message.includes('pattern'));
    expect(patternErrors.length).toBeGreaterThan(0);

    // Required field validation
    const requiredErrors = skillErrors.filter((e) =>
      e.message.includes('required')
    );
    expect(requiredErrors.length).toBeGreaterThan(0);

    // Verify short-description error is present (one of the 4 skill errors)
    expect(skillErrors.some((e) =>
      e.resourcePath.includes('short-description-SKILL.md')
    )).toBe(true);
  });

  it('should validate resources across all three collections', async () => {
    const { registry } = await setupAndValidate();

    const resources = registry.getAllResources();

    // Should find resources in all three collections
    const collections = new Set(
      resources.flatMap((r) => r.collections ?? [])
    );

    expect(collections.has('guides')).toBe(true);
    expect(collections.has('documentation')).toBe(true);
    expect(collections.has('skills')).toBe(true);

    // Total resources: includes valid, invalid, and README.md
    // At least 9 files in collections (may include README if not excluded)
    expect(resources.length).toBeGreaterThanOrEqual(9);
  });
});
