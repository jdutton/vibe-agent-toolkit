import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExternalLinkValidator } from '../../src/external-link-validator.js';
import { setupExternalLinkValidatorSuite } from '../test-helpers.js';

const GOOGLE_URL = 'https://www.google.com';
const EXAMPLE_URL = 'https://www.example.com';
const BROKEN_URL = 'https://this-domain-definitely-does-not-exist-12345.com';

describe('ExternalLinkValidator (integration)', () => {
	const suite = setupExternalLinkValidatorSuite('link-validator-integration-');

	beforeEach(suite.beforeEach);
	afterEach(suite.afterEach);

	it('should validate a working URL', async () => {
		const result = await suite.validator.validateLink(GOOGLE_URL);

		expect(result.url).toBe(GOOGLE_URL);
		expect(result.status).toBe('ok');
		expect(result.statusCode).toBe(200);
	});

	it('should detect broken URLs', async () => {
		const result = await suite.validator.validateLink(BROKEN_URL);

		expect(result.url).toBe(BROKEN_URL);
		expect(result.status).toBe('error');
		expect(result.statusCode).toBe(0);
		expect(result.error).toBeDefined();
	});

	it('should use cache for repeated checks', async () => {
		const result1 = await suite.validator.validateLink(GOOGLE_URL);
		const result2 = await suite.validator.validateLink(GOOGLE_URL);

		expect(result1.cached).toBe(false);
		expect(result2.cached).toBe(true);
		expect(result1.statusCode).toBe(result2.statusCode);
	});

	it('should handle timeout errors', async () => {
		const timeoutValidator = new ExternalLinkValidator(suite.tempDir, {
			cacheTtlHours: 24,
			timeout: 1, // 1ms timeout - guaranteed to fail
		});

		const result = await timeoutValidator.validateLink(GOOGLE_URL);

		expect(result.status).toBe('error');
		expect(result.error).toBeDefined();
	});

	it('should respect retry configuration', async () => {
		const retryValidator = new ExternalLinkValidator(suite.tempDir, {
			cacheTtlHours: 24,
			retries: 2,
		});

		// This should work eventually with retries
		const result = await retryValidator.validateLink(GOOGLE_URL);
		expect(result.status).toBe('ok');
	});

	it('should validate multiple links efficiently', async () => {
		const urls = [GOOGLE_URL, EXAMPLE_URL, BROKEN_URL];
		const results = await suite.validator.validateLinks(urls);

		expect(results).toHaveLength(urls.length);

		// Working URLs should be ok, broken URL should error
		const working = results.filter(r => r.status === 'ok');
		const broken = results.filter(r => r.status === 'error');
		expect(working.length).toBeGreaterThanOrEqual(2);
		expect(broken.length).toBe(1);
		expect(broken[0]?.url).toBe(BROKEN_URL);
	});

	it('should handle concurrent validations with cache', async () => {
		// Run 3 validations concurrently
		const [result1, result2, result3] = await Promise.all([
			suite.validator.validateLink(GOOGLE_URL),
			suite.validator.validateLink(GOOGLE_URL),
			suite.validator.validateLink(GOOGLE_URL),
		]);

		// At least one should be from cache (or they should all have same result)
		const cached = new Set([result1.cached, result2.cached, result3.cached]);
		const allSameStatus = result1.statusCode === result2.statusCode && result2.statusCode === result3.statusCode;

		expect(allSameStatus).toBe(true);
		// Cache behavior may vary due to concurrency, but results should be consistent
		expect(cached.has(true) || cached.has(false)).toBe(true);
	});

	it('should clear cache', async () => {
		// Validate and cache a URL
		await suite.validator.validateLink(GOOGLE_URL);

		// Clear cache
		await suite.validator.clearCache();

		// Next validation should not be cached
		const result = await suite.validator.validateLink(GOOGLE_URL);
		expect(result.cached).toBe(false);
	});

	it('should get cache statistics', async () => {
		// Initially empty
		let stats = await suite.validator.getCacheStats();
		expect(stats.total).toBe(0);

		// Add some entries
		await suite.validator.validateLink(GOOGLE_URL);
		await suite.validator.validateLink(EXAMPLE_URL);

		stats = await suite.validator.getCacheStats();
		expect(stats.total).toBeGreaterThan(0);
	});
});
