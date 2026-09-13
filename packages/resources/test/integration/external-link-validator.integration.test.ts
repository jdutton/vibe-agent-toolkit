/**
 * Network-gated — set `NET_AVAILABLE=1` to enable, as the other network suites
 * in this repo are (turbo hashes the variable, so a run with it set is its own
 * cache key).
 *
 * It was gated on `!process.env.CI`, and by a `beforeAll` reachability probe
 * read through `describe.skipIf` — which evaluates its argument at COLLECTION,
 * before any `beforeAll` runs, so the flag was always `false` and the suite
 * never ran anywhere. Then the gate moved the integration tier under `CI=1`
 * (`bun run validate` sets it too), which closed the last door the `CI` check
 * left open. A suite that structurally cannot run is a green count of zero.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ExternalLinkValidator } from '../../src/external-link-validator.js';
import { setupExternalLinkValidatorSuite } from '../test-helpers.js';

// Use httpbin.org — designed for automated HTTP testing, no bot detection
const WORKING_URL = 'https://httpbin.org/status/200';
const BROKEN_URL = 'https://this-domain-definitely-does-not-exist-12345.com';

const NET_AVAILABLE = process.env['NET_AVAILABLE'] === '1';

describe.skipIf(!NET_AVAILABLE)('ExternalLinkValidator (integration)', () => {
	const suite = setupExternalLinkValidatorSuite('link-validator-integration-');

	beforeEach(suite.beforeEach);
	afterEach(suite.afterEach);

	it('should validate a working URL', async () => {
		const result = await suite.validator.validateLink(WORKING_URL);

		expect(result.url).toBe(WORKING_URL);
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
		const result1 = await suite.validator.validateLink(WORKING_URL);
		const result2 = await suite.validator.validateLink(WORKING_URL);

		expect(result1.cached).toBe(false);
		expect(result2.cached).toBe(true);
		expect(result1.statusCode).toBe(result2.statusCode);
	});

	it('should handle timeout errors', async () => {
		const timeoutValidator = new ExternalLinkValidator(suite.tempDir, {
			cacheTtlHours: 24,
			timeout: 1, // 1ms timeout - guaranteed to fail
		});

		const result = await timeoutValidator.validateLink(WORKING_URL);

		expect(result.status).toBe('error');
		expect(result.error).toBeDefined();
	});

	it('should respect retry configuration', async () => {
		const retryValidator = new ExternalLinkValidator(suite.tempDir, {
			cacheTtlHours: 24,
			retries: 2,
		});

		// This should work eventually with retries
		const result = await retryValidator.validateLink(WORKING_URL);
		expect(result.status).toBe('ok');
	});

	it('should validate multiple links efficiently', async () => {
		const urls = [WORKING_URL, BROKEN_URL];
		const results = await suite.validator.validateLinks(urls);

		expect(results).toHaveLength(urls.length);

		const workingResult = results.find(r => r.url === WORKING_URL);
		expect(workingResult?.status).toBe('ok');

		const brokenResult = results.find(r => r.url === BROKEN_URL);
		expect(brokenResult?.status).toBe('error');
	});

	it('should handle concurrent validations with cache', async () => {
		// Run 3 validations concurrently
		const [result1, result2, result3] = await Promise.all([
			suite.validator.validateLink(WORKING_URL),
			suite.validator.validateLink(WORKING_URL),
			suite.validator.validateLink(WORKING_URL),
		]);

		// All should have same status code regardless of cache timing
		const allSameStatus = result1.statusCode === result2.statusCode && result2.statusCode === result3.statusCode;
		expect(allSameStatus).toBe(true);
	});

	it('should clear cache', async () => {
		// Validate and cache a URL
		await suite.validator.validateLink(WORKING_URL);

		// Clear cache
		await suite.validator.clearCache();

		// Next validation should not be cached
		const result = await suite.validator.validateLink(WORKING_URL);
		expect(result.cached).toBe(false);
	});

	it('should get cache statistics', async () => {
		// Initially empty
		let stats = await suite.validator.getCacheStats();
		expect(stats.total).toBe(0);

		// Add some entries
		await suite.validator.validateLink(WORKING_URL);

		stats = await suite.validator.getCacheStats();
		expect(stats.total).toBeGreaterThan(0);
	});
});
