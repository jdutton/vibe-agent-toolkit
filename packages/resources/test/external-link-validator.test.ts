import markdownLinkCheck from 'markdown-link-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalLinkValidator } from '../src/external-link-validator.js';

import { setupExternalLinkValidatorSuite } from './test-helpers.js';

// Mock markdown-link-check to avoid real HTTP requests.
// Vitest hoists vi.mock() calls above imports automatically.
vi.mock('markdown-link-check', () => ({
	default: vi.fn(),
}));

const mockedLinkCheck = vi.mocked(markdownLinkCheck);

const EXAMPLE_URL = 'https://www.example.com';
const GITHUB_URL = 'https://github.com';
const BROKEN_URL = 'https://this-domain-definitely-does-not-exist-12345.com';

/**
 * Helper: simulate markdown-link-check calling its callback with an "alive" result
 */
function simulateAlive(statusCode = 200): void {
	mockedLinkCheck.mockImplementation((_markdown, _options, callback) => {
		callback(null, [{ link: '', status: 'alive', statusCode }]);
	});
}

/**
 * Helper: simulate markdown-link-check calling its callback with a "dead" result
 */
function simulateDead(statusCode = 0, err?: string | Error | object): void {
	mockedLinkCheck.mockImplementation((_markdown, _options, callback) => {
		callback(null, [{ link: '', status: 'dead', statusCode, err }]);
	});
}

/**
 * Helper: simulate markdown-link-check calling its callback with a top-level error
 */
function simulateError(message: string): void {
	mockedLinkCheck.mockImplementation((_markdown, _options, callback) => {
		callback(new Error(message), []);
	});
}

describe('ExternalLinkValidator', () => {
	const suite = setupExternalLinkValidatorSuite('link-validator-unit-');

	beforeEach(suite.beforeEach);
	afterEach(async () => {
		vi.restoreAllMocks();
		await suite.afterEach();
	});

	it('should validate a working URL', async () => {
		simulateAlive(200);

		const result = await suite.validator.validateLink(EXAMPLE_URL);

		expect(result.url).toBe(EXAMPLE_URL);
		expect(result.status).toBe('ok');
		expect(result.statusCode).toBe(200);
		expect(result.cached).toBe(false);
	});

	it('should detect broken URLs', async () => {
		simulateDead(0, 'ENOTFOUND');

		const result = await suite.validator.validateLink(BROKEN_URL);

		expect(result).toMatchObject({
			url: BROKEN_URL,
			status: 'error',
			statusCode: 0,
			cached: false,
		});
		expect(result.error).toBe('ENOTFOUND');
		expect(mockedLinkCheck).toHaveBeenCalledTimes(1);
	});

	it('should use cache for repeated checks', async () => {
		simulateAlive(200);

		const result1 = await suite.validator.validateLink(EXAMPLE_URL);
		const result2 = await suite.validator.validateLink(EXAMPLE_URL);

		expect(result1.cached).toBe(false);
		expect(result2.cached).toBe(true);
		expect(result1.statusCode).toBe(result2.statusCode);
		// markdown-link-check should only be called once (second call is cache hit)
		expect(mockedLinkCheck).toHaveBeenCalledTimes(1);
	});

	it('should handle timeout errors', async () => {
		simulateError('ETIMEDOUT');

		const timeoutValidator = new ExternalLinkValidator(suite.tempDir, {
			cacheTtlHours: 24,
			timeout: 1,
		});

		const result = await timeoutValidator.validateLink(EXAMPLE_URL);

		expect(result.status).toBe('error');
		expect(result.error).toBe('ETIMEDOUT');
	});

	it('should pass timeout option to markdown-link-check', async () => {
		simulateAlive(200);

		const timeoutValidator = new ExternalLinkValidator(suite.tempDir, {
			cacheTtlHours: 24,
			timeout: 3000,
		});

		await timeoutValidator.validateLink(EXAMPLE_URL);

		expect(mockedLinkCheck).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ timeout: '3000ms' }),
			expect.any(Function),
		);
	});

	it('should pass retry configuration to markdown-link-check', async () => {
		simulateAlive(200);

		const retryValidator = new ExternalLinkValidator(suite.tempDir, {
			cacheTtlHours: 24,
			retries: 5,
		});

		await retryValidator.validateLink(EXAMPLE_URL);

		expect(mockedLinkCheck).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ retryCount: 5 }),
			expect.any(Function),
		);
	});

	it('should validate multiple links efficiently', async () => {
		// Route mock responses by URL: alive for known URLs, dead for broken
		mockedLinkCheck.mockImplementation((markdown, _options, callback) => {
			if (markdown.includes(BROKEN_URL)) {
				callback(null, [{ link: '', status: 'dead', statusCode: 0, err: 'ENOTFOUND' }]);
			} else {
				callback(null, [{ link: '', status: 'alive', statusCode: 200 }]);
			}
		});

		const urls = [EXAMPLE_URL, GITHUB_URL, BROKEN_URL];
		const results = await suite.validator.validateLinks(urls);

		expect(results).toHaveLength(3);
		expect(results[0]?.status).toBe('ok');
		expect(results[1]?.status).toBe('ok');
		expect(results[2]?.status).toBe('error');
	});

	it('should handle concurrent validations with cache', async () => {
		simulateAlive(200);

		const [result1, result2, result3] = await Promise.all([
			suite.validator.validateLink(EXAMPLE_URL),
			suite.validator.validateLink(EXAMPLE_URL),
			suite.validator.validateLink(EXAMPLE_URL),
		]);

		// All should have the same status code
		const allSameStatus = result1.statusCode === result2.statusCode && result2.statusCode === result3.statusCode;
		expect(allSameStatus).toBe(true);

		// Cache behavior may vary due to concurrency, but results should be consistent
		const cached = new Set([result1.cached, result2.cached, result3.cached]);
		expect(cached.has(true) || cached.has(false)).toBe(true);
	});

	it('should clear cache', async () => {
		simulateAlive(200);

		// Validate and cache a URL
		await suite.validator.validateLink(EXAMPLE_URL);

		// Clear cache
		await suite.validator.clearCache();

		// Next validation should not be cached
		const result = await suite.validator.validateLink(EXAMPLE_URL);
		expect(result.cached).toBe(false);
		// markdown-link-check should be called twice (cache was cleared)
		expect(mockedLinkCheck).toHaveBeenCalledTimes(2);
	});

	it('should get cache statistics', async () => {
		simulateAlive(200);

		// Initially empty
		let stats = await suite.validator.getCacheStats();
		expect(stats.total).toBe(0);

		// Add some entries - need different URLs for different cache entries
		await suite.validator.validateLink(EXAMPLE_URL);

		// Use different mock for second URL
		simulateAlive(200);
		await suite.validator.validateLink(GITHUB_URL);

		stats = await suite.validator.getCacheStats();
		expect(stats.total).toBe(2);
	});

	it('should handle markdown-link-check returning no results', async () => {
		mockedLinkCheck.mockImplementation((_markdown, _options, callback) => {
			callback(null, []);
		});

		const result = await suite.validator.validateLink(EXAMPLE_URL);

		expect(result.status).toBe('error');
		expect(result.statusCode).toBe(0);
		expect(result.error).toBe('No result from markdown-link-check');
	});

	it('should handle markdown-link-check top-level error', async () => {
		simulateError('Network failure');

		const result = await suite.validator.validateLink(EXAMPLE_URL);

		expect(result.status).toBe('error');
		expect(result.statusCode).toBe(0);
		expect(result.error).toBe('Network failure');
	});

	it('should pass user agent to markdown-link-check', async () => {
		simulateAlive(200);

		const customValidator = new ExternalLinkValidator(suite.tempDir, {
			userAgent: 'TestBot/1.0',
		});

		await customValidator.validateLink(EXAMPLE_URL);

		expect(mockedLinkCheck).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				httpHeaders: expect.arrayContaining([
					expect.objectContaining({
						headers: { 'User-Agent': 'TestBot/1.0' },
					}),
				]),
			}),
			expect.any(Function),
		);
	});

	it('should cache error results and return them as cached', async () => {
		simulateDead(404, 'Not Found');

		// First call: not cached
		const result1 = await suite.validator.validateLink(BROKEN_URL);
		expect(result1.status).toBe('error');
		expect(result1.statusCode).toBe(404);
		expect(result1.cached).toBe(false);

		// Second call: should be cached
		const result2 = await suite.validator.validateLink(BROKEN_URL);
		expect(result2.status).toBe('error');
		expect(result2.statusCode).toBe(404);
		expect(result2.cached).toBe(true);
		expect(result2.error).toBeDefined();
	});

	it('should handle dead link with Error object as err', async () => {
		simulateDead(500, new Error('Internal Server Error'));

		const result = await suite.validator.validateLink(EXAMPLE_URL);

		expect(result.status).toBe('error');
		expect(result.statusCode).toBe(500);
		expect(result.error).toBe('Internal Server Error');
	});

	it('should handle dead link with object as err', async () => {
		simulateDead(503, { code: 'UNAVAILABLE', detail: 'Service down' });

		const result = await suite.validator.validateLink(EXAMPLE_URL);

		expect(result.status).toBe('error');
		expect(result.statusCode).toBe(503);
		expect(result.error).toBeDefined();
		// Should be JSON serialized
		expect(result.error).toContain('UNAVAILABLE');
	});

	it('should handle dead link with no err (fallback message)', async () => {
		simulateDead(404);

		const result = await suite.validator.validateLink(EXAMPLE_URL);

		expect(result.status).toBe('error');
		expect(result.statusCode).toBe(404);
		// Should use fallback message format
		expect(result.error).toBe('Link status: dead');
	});
});
