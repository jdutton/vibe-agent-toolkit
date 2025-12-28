import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import { findMonorepoRoot } from '../test-helpers.js';

describe('System Test: Project Link Validation (Dogfooding)', () => {
  let registry: ResourceRegistry;
  const projectRoot = findMonorepoRoot();

  beforeEach(() => {
    registry = new ResourceRegistry();
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

    // Validate all resources
    const validationResult = await registry.validate();

    // Log validation results
    console.log(`\n✅ Validation Results:`);
    console.log(`  Status: ${validationResult.passed ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`  Errors (broken links): ${validationResult.errorCount}`);
    console.log(`  Warnings: ${validationResult.warningCount}`);
    console.log(`  Info: ${validationResult.infoCount}`);
    console.log(`  Duration: ${validationResult.durationMs}ms`);
    console.log('='.repeat(70));

    // Log any errors found
    if (validationResult.errorCount > 0) {
      console.log('\n❌ BROKEN LINKS DETECTED:\n');
      let errorNum = 1;
      for (const issue of validationResult.issues) {
        if (issue.severity === 'error') {
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
  }, 10000); // 10 second timeout for system test
});
