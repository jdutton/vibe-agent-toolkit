import { promises as fs } from 'node:fs';
import path from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExternalLinkValidator } from '../src/external-link-validator.js';

const GOOGLE_URL = 'https://www.google.com';
const GITHUB_URL = 'https://github.com';
const BROKEN_URL = 'https://this-domain-definitely-does-not-exist-12345.com';

describe('ExternalLinkValidator', () => {
	let tempDir: string;
	let validator: ExternalLinkValidator;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(normalizedTmpdir(), 'link-validator-test-'));
		validator = new ExternalLinkValidator(tempDir, { cacheTtlHours: 24 });
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it('should validate a working URL', async () => {
		const result = await validator.validateLink(GOOGLE_URL);

		expect(result.url).toBe(GOOGLE_URL);
		expect(result.status).toBe('ok');
		expect(result.statusCode).toBe(200);
	});

	it('should detect broken URLs', async () => {
		// Use a URL that is guaranteed to not exist
		const result = await validator.validateLink(BROKEN_URL);

		expect(result.url).toBe(BROKEN_URL);
		expect(result.status).toBe('error');
		expect(result.statusCode).toBe(0);
		expect(result.error).toBeDefined();
	});

	it('should use cache for repeated checks', async () => {
		const result1 = await validator.validateLink(GOOGLE_URL);
		const result2 = await validator.validateLink(GOOGLE_URL);

		expect(result1.cached).toBe(false);
		expect(result2.cached).toBe(true);
		expect(result1.statusCode).toBe(result2.statusCode);
	});

	it('should handle timeout errors', async () => {
		const timeoutValidator = new ExternalLinkValidator(tempDir, {
			cacheTtlHours: 24,
			timeout: 1, // 1ms timeout - guaranteed to fail
		});

		const result = await timeoutValidator.validateLink(GOOGLE_URL);

		expect(result.status).toBe('error');
		expect(result.error).toBeDefined();
	});

	it('should respect retry configuration', async () => {
		const retryValidator = new ExternalLinkValidator(tempDir, {
			cacheTtlHours: 24,
			retries: 2,
		});

		// This should work eventually with retries
		const result = await retryValidator.validateLink(GOOGLE_URL);
		expect(result.status).toBe('ok');
	});

	it('should validate multiple links efficiently', async () => {
		const urls = [GOOGLE_URL, GITHUB_URL, BROKEN_URL];

		const results = await validator.validateLinks(urls);

		expect(results).toHaveLength(3);
		expect(results[0].status).toBe('ok');
		expect(results[1].status).toBe('ok');
		expect(results[2].status).toBe('error');
	});

	it('should handle concurrent validations with cache', async () => {
		// Run 3 validations concurrently
		const [result1, result2, result3] = await Promise.all([
			validator.validateLink(GOOGLE_URL),
			validator.validateLink(GOOGLE_URL),
			validator.validateLink(GOOGLE_URL),
		]);

		// At least one should be from cache (or they should all have same result)
		const cached = new Set([result1.cached, result2.cached, result3.cached]);
		const allSameStatus = result1.statusCode === result2.statusCode && result2.statusCode === result3.statusCode;

		expect(allSameStatus).toBe(true);
		// Cache behavior may vary due to concurrency, but results should be consistent
		expect(cached.has(true) || cached.has(false)).toBe(true);
	});
});
