// Test file - all file operations are in temp directories
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ResourceRegistry } from '../../src/resource-registry.js';
import { setupTempDirTestSuite, startLinkTestServer, type LinkTestServer } from '../test-helpers.js';

/**
 * Create a test file with external link and return registry
 */
async function setupRegistryWithExternalLink(tempDir: string, url: string): Promise<ResourceRegistry> {
  const testFile = safePath.join(tempDir, 'test.md');
  await writeFile(testFile, `# Test\n\n[Link](${url})\n`);

  const registry = new ResourceRegistry({ baseDir: tempDir });
  await registry.addResource(testFile);
  return registry;
}

function deadLinkPath(): string {
  return `/dead-${randomUUID()}`;
}

/**
 * The links point at a local server rather than a public host, so the suite
 * runs everywhere and fails only on our code. The registry's URL cache is the
 * shared one under the system temp dir and outlives the run, so every link
 * carries a fresh UUID: a port reused by a later run must never read this
 * run's rows. The server answers 404 to any path, which is the dead link each
 * case wants.
 */
describe('ResourceRegistry external URL validation', () => {
  let server: LinkTestServer;
  beforeAll(async () => {
    server = await startLinkTestServer({});
  });
  afterAll(async () => {
    await server.close();
  });

  const suite = setupTempDirTestSuite('registry-external-urls-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('reports a dead external URL when checkExternalUrls is true', async () => {
    const routePath = deadLinkPath();
    const url = server.url(routePath);
    const registry = await setupRegistryWithExternalLink(suite.tempDir, url);

    const result = await registry.validate({ checkExternalUrls: true });

    expect(result.totalResources).toBe(1);
    expect(result.totalLinks).toBe(1);
    expect(result.passed).toBe(false);
    expect(result.issues.map((issue) => [issue.code, issue.link])).toEqual([['EXTERNAL_URL_DEAD', url]]);
    expect(server.requests(routePath).length).toBeGreaterThan(0);
  });

  it('never requests external URLs when checkExternalUrls is false', async () => {
    const routePath = deadLinkPath();
    const registry = await setupRegistryWithExternalLink(suite.tempDir, server.url(routePath));

    const result = await registry.validate({ checkExternalUrls: false });

    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(server.requests(routePath)).toHaveLength(0);
  });

  it('answers a repeat from the cache, and refetches under noCache', async () => {
    const routePath = deadLinkPath();
    const registry = await setupRegistryWithExternalLink(suite.tempDir, server.url(routePath));

    await registry.validate({ checkExternalUrls: true });
    const afterFirst = server.requests(routePath).length;
    await registry.validate({ checkExternalUrls: true });
    expect(server.requests(routePath)).toHaveLength(afterFirst);

    const result = await registry.validate({ checkExternalUrls: true, noCache: true });
    expect(server.requests(routePath).length).toBeGreaterThan(afterFirst);
    expect(result.issues.map((issue) => issue.code)).toEqual(['EXTERNAL_URL_DEAD']);
  });
});
