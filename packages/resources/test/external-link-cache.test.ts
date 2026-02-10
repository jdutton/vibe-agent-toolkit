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
});
