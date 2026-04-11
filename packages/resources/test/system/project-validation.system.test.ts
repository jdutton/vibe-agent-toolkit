import { afterEach, beforeEach, describe, expect, it } from 'vitest';


import { ResourceRegistry } from '../../src/resource-registry.js';
import { findMonorepoRoot } from '../test-helpers.js';

describe('System Test: Project Link Validation (Dogfooding)', () => {
  let registry: ResourceRegistry;
  const projectRoot = findMonorepoRoot();

  beforeEach(() => {
    registry = new ResourceRegistry({ baseDir: projectRoot });
  });

  afterEach(() => {
    registry.clear();
  });

  it('should validate all markdown links in the project have no broken links', async () => {
    // This test dogfoods our own ResourceRegistry to validate all markdown files
    // in the vibe-agent-toolkit project. It ensures our documentation stays accurate
    // and all links remain valid.
    // Crawl the entire project for markdown files
    await registry.crawl({
      baseDir: projectRoot,
      include: ['**/*.md'],
      exclude: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/coverage/**',
        '**/test-fixtures/**', // Exclude test fixtures with intentionally broken links
        '**/test/fixtures/skill-files/**', // Exclude skill-files fixture (intentionally broken links for build artifact testing)
        '**/docs/plans/**', // Exclude implementation plans (reference code that doesn't exist yet)
      ],
    });

    const stats = registry.getStats();
    const resources = registry.getAllResources();

    // Log basic statistics
    console.log('\n' + '='.repeat(70));
    console.log('🔗 DOGFOODING: Validating Project Markdown Links');
    console.log('='.repeat(70));
    console.log(`\n📊 Resources Scanned:`);
    console.log(`  Total markdown files: ${stats.totalResources}`);
    console.log(`  Total links found: ${stats.totalLinks}`);
    console.log(`\n🔍 Links by Type:`);
    console.log(`  - local_file: ${stats.linksByType['local_file'] ?? 0} (links to other files in repo)`);
    console.log(`  - anchor: ${stats.linksByType['anchor'] ?? 0} (heading anchors in current file)`);
    console.log(`  - external: ${stats.linksByType['external'] ?? 0} (HTTP/HTTPS links - not validated)`);
    console.log(`  - email: ${stats.linksByType['email'] ?? 0} (mailto links)`);
    console.log(`  - unknown: ${stats.linksByType['unknown'] ?? 0} (unrecognized link types)`);

    // Validate all resources (skip git-ignore checks — this test validates
    // broken links, not gitignore behavior; skipping avoids 2×N spawnSync
    // calls to `git check-ignore` which cause 60s+ timeouts at scale)
    const validationResult = await registry.validate({ skipGitIgnoreCheck: true });

    // Log validation results
    console.log(`\n✅ Validation Results:`);
    console.log(`  Status: ${validationResult.passed ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`  Errors (broken links): ${validationResult.errorCount}`);
    console.log(`  Duration: ${validationResult.durationMs}ms`);
    console.log('='.repeat(70));

    // Log any errors found
    if (validationResult.errorCount > 0) {
      console.log('\n❌ BROKEN LINKS DETECTED:\n');
      let errorNum = 1;
      // All issues are errors now (no severity field)
      for (const issue of validationResult.issues) {
        const resource = resources.find(
          (r) => r.filePath === issue.resourcePath,
        );
        console.log(`[${errorNum}] ${issue.type.toUpperCase()}`);
        console.log(`    📄 File: ${issue.resourcePath}`);
        console.log(`    📍 Line: ${issue.line ?? 'unknown'}`);
        console.log(`    🔗 Link: ${issue.link}`);
        console.log(`    💬 ${issue.message}`);
        if (issue.suggestion) {
          console.log(`    💡 Suggestion: ${issue.suggestion}`);
        }
        if (resource) {
          console.log(`    🆔 Resource ID: ${resource.id}`);
        }
        console.log('');
        errorNum++;
      }
      console.log('='.repeat(70));
    }

    // Assert no broken links in the project
    // This is the core assertion that ensures all documentation links are valid
    expect(
      validationResult.errorCount,
      `❌ Found ${validationResult.errorCount} broken link(s) in project documentation.\n` +
      `This is a dogfooding check using our own ResourceRegistry.\n` +
      `See console output above for details on which links are broken.`,
    ).toBe(0);

    // Ensure we actually validated some files
    expect(stats.totalResources).toBeGreaterThan(0);
  }, 60_000); // 60 second timeout — crawls entire monorepo
});
