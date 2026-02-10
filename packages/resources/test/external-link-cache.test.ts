import { promises as fs } from 'node:fs';
import path from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExternalLinkCache } from '../src/external-link-cache.js';

const EXAMPLE_URL = 'https://example.com';
const GITHUB_URL = 'https://github.com';
const BROKEN_URL = 'https://broken.com';

describe('ExternalLinkCache', () => {
	let tempDir: string;
	let cache: ExternalLinkCache;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(normalizedTmpdir(), 'link-cache-test-'));
		cache = new ExternalLinkCache(tempDir, 24);
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it('should store and retrieve link status', async () => {
		await cache.set(EXAMPLE_URL, 200, 'OK');

		const result = await cache.get(EXAMPLE_URL);
		expect(result).toEqual({
			statusCode: 200,
			statusMessage: 'OK',
			timestamp: expect.any(Number),
		});
	});

	it('should return null for non-existent links', async () => {
		const result = await cache.get('https://nonexistent.com');
		expect(result).toBeNull();
	});

	it('should expire old entries', async () => {
		const shortLivedCache = new ExternalLinkCache(tempDir, 0); // 0 hours TTL

		await shortLivedCache.set(EXAMPLE_URL, 200, 'OK');

		// Wait a tiny bit to ensure timestamp has passed
		await new Promise((resolve) => setTimeout(resolve, 10));

		const result = await shortLivedCache.get(EXAMPLE_URL);
		expect(result).toBeNull();
	});

	it('should not expire fresh entries', async () => {
		await cache.set(EXAMPLE_URL, 200, 'OK');

		const result = await cache.get(EXAMPLE_URL);
		expect(result).not.toBeNull();
	});

	it('should handle error status codes', async () => {
		await cache.set(BROKEN_URL, 404, 'Not Found');

		const result = await cache.get(BROKEN_URL);
		expect(result).toEqual({
			statusCode: 404,
			statusMessage: 'Not Found',
			timestamp: expect.any(Number),
		});
	});

	it('should overwrite existing entries', async () => {
		await cache.set(EXAMPLE_URL, 200, 'OK');
		await cache.set(EXAMPLE_URL, 404, 'Not Found');

		const result = await cache.get(EXAMPLE_URL);
		expect(result).toEqual({
			statusCode: 404,
			statusMessage: 'Not Found',
			timestamp: expect.any(Number),
		});
	});

	it('should handle multiple links', async () => {
		await cache.set(EXAMPLE_URL, 200, 'OK');
		await cache.set(GITHUB_URL, 200, 'OK');
		await cache.set(BROKEN_URL, 404, 'Not Found');

		const result1 = await cache.get(EXAMPLE_URL);
		const result2 = await cache.get(GITHUB_URL);
		const result3 = await cache.get(BROKEN_URL);

		expect(result1).not.toBeNull();
		expect(result2).not.toBeNull();
		expect(result3).not.toBeNull();
	});

	it('should persist cache to disk', async () => {
		await cache.set(EXAMPLE_URL, 200, 'OK');

		// Create new cache instance with same directory
		const newCache = new ExternalLinkCache(tempDir, 24);
		const result = await newCache.get(EXAMPLE_URL);

		expect(result).not.toBeNull();
		expect(result?.statusCode).toBe(200);
	});

	it('should handle corrupted cache file gracefully', async () => {
		// Write invalid JSON to cache file
		const cacheFile = path.join(tempDir, 'external-links.json');
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir from mkdtemp, safe
		await fs.writeFile(cacheFile, 'invalid json {{{');

		// Should handle gracefully and return null
		const result = await cache.get(EXAMPLE_URL);
		expect(result).toBeNull();

		// Should be able to write after corruption
		await cache.set(EXAMPLE_URL, 200, 'OK');
		const newResult = await cache.get(EXAMPLE_URL);
		expect(newResult).not.toBeNull();
	});

	it('should clear all cache entries', async () => {
		// Add some entries
		await cache.set(EXAMPLE_URL, 200, 'OK');
		await cache.set(GITHUB_URL, 200, 'OK');

		// Clear cache
		await cache.clear();

		// All entries should be gone
		expect(await cache.get(EXAMPLE_URL)).toBeNull();
		expect(await cache.get(GITHUB_URL)).toBeNull();
	});

	it('should get cache statistics', async () => {
		// Initially empty
		let stats = await cache.getStats();
		expect(stats.total).toBe(0);
		expect(stats.expired).toBe(0);

		// Add fresh entries
		await cache.set(EXAMPLE_URL, 200, 'OK');
		await cache.set(GITHUB_URL, 200, 'OK');

		stats = await cache.getStats();
		expect(stats.total).toBe(2);
		expect(stats.expired).toBe(0);

		// Add expired entry
		const shortCache = new ExternalLinkCache(tempDir, 0);
		await shortCache.set(BROKEN_URL, 404, 'Not Found');

		// Wait for expiration
		await new Promise((resolve) => setTimeout(resolve, 10));

		stats = await shortCache.getStats();
		expect(stats.total).toBeGreaterThan(0);
		expect(stats.expired).toBeGreaterThan(0);
	});

	it('should handle cache directory creation', async () => {
		// Test with non-existent directory
		const newDir = path.join(tempDir, 'nested', 'cache');
		const newCache = new ExternalLinkCache(newDir, 24);

		// Should create directory and work normally
		await newCache.set(EXAMPLE_URL, 200, 'OK');
		const result = await newCache.get(EXAMPLE_URL);

		expect(result).not.toBeNull();
		expect(result?.statusCode).toBe(200);
	});
});
