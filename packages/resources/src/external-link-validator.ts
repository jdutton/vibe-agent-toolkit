import markdownLinkCheck from 'markdown-link-check';

import { ExternalLinkCache } from './external-link-cache.js';

/**
 * Safely serialize an error to a string, preventing [object Object] issues.
 * Handles Error objects, strings, objects, and edge cases.
 */
function safeSerializeError(err: unknown): string | undefined {
	if (!err) {
		return undefined;
	}

	if (typeof err === 'string') {
		// Return undefined for empty strings so fallback message is used
		return err.trim() || undefined;
	}

	if (err instanceof Error) {
		// Return undefined for empty messages so fallback is used
		return err.message.trim() || undefined;
	}

	// For objects, try JSON.stringify with fallback
	try {
		const serialized = JSON.stringify(err);
		// Avoid returning literal "{}" which isn't helpful
		if (serialized === '{}') {
			// Try to extract something useful from the object
			const msg = (err as { message?: unknown }).message;
			return typeof msg === 'string' && msg.trim() ? msg : 'Unknown error';
		}
		return serialized;
	} catch {
		// JSON.stringify can fail on circular references
		// Try to extract message property if it exists
		const msg = (err as { message?: unknown }).message;
		return typeof msg === 'string' && msg.trim() ? msg : 'Error (unserializable)';
	}
}

/**
 * Configuration options for external link validation
 */
export interface ExternalLinkValidatorOptions {
	/** Time-to-live for cache entries in hours (default: 24) */
	cacheTtlHours?: number;
	/** Request timeout in milliseconds (default: 5000) */
	timeout?: number;
	/** Number of retries for failed requests (default: 2) */
	retries?: number;
	/** User agent string for requests (default: generic) */
	userAgent?: string;
}

/**
 * Result of validating a single external link
 */
export interface LinkValidationResult {
	/** The URL that was validated */
	url: string;
	/** Validation status: 'ok' = working, 'error' = broken */
	status: 'ok' | 'error';
	/** HTTP status code (e.g., 200, 404) */
	statusCode: number;
	/** Error message if validation failed */
	error?: string;
	/** Whether result came from cache */
	cached: boolean;
}

/**
 * Validates external URLs in markdown content
 *
 * Uses markdown-link-check library with caching to efficiently validate
 * external links. Respects cache TTL and provides detailed error information.
 *
 * Example:
 * ```typescript
 * const validator = new ExternalLinkValidator('/tmp/cache', {
 *   cacheTtlHours: 24,
 *   timeout: 5000,
 * });
 *
 * const result = await validator.validateLink('https://example.com');
 * if (result.status === 'error') {
 *   console.error(`Broken link: ${result.url} - ${result.error}`);
 * }
 * ```
 */
export class ExternalLinkValidator {
	private readonly cache: ExternalLinkCache;
	private readonly options: Required<ExternalLinkValidatorOptions>;

	/**
	 * Create a new external link validator
	 *
	 * @param cacheDir - Directory for storing cache
	 * @param options - Validation options
	 */
	constructor(cacheDir: string, options: ExternalLinkValidatorOptions = {}) {
		this.options = {
			cacheTtlHours: options.cacheTtlHours ?? 24,
			timeout: options.timeout ?? 5000,
			retries: options.retries ?? 2,
			userAgent:
				options.userAgent ??
				'Mozilla/5.0 (compatible; VAT-LinkChecker/1.0; +https://github.com/jdutton/vibe-agent-toolkit)',
		};

		this.cache = new ExternalLinkCache(cacheDir, this.options.cacheTtlHours);
	}

	/**
	 * Validate a single external link
	 *
	 * @param url - URL to validate
	 * @returns Validation result
	 */
	async validateLink(url: string): Promise<LinkValidationResult> {
		// Check cache first
		const cached = await this.cache.get(url);
		if (cached) {
			const isOk = cached.statusCode >= 200 && cached.statusCode < 400;

			// Return success result without error property (exactOptionalPropertyTypes)
			if (isOk) {
				return {
					url,
					status: 'ok' as const,
					statusCode: cached.statusCode,
					cached: true,
				};
			}

			// Return error result with error property
			return {
				url,
				status: 'error' as const,
				statusCode: cached.statusCode,
				cached: true,
				error: cached.statusMessage,
			};
		}

		// Validate using markdown-link-check
		const result = await this.checkLink(url);

		// Store in cache
		await this.cache.set(url, result.statusCode, result.error ?? 'OK');

		return {
			...result,
			cached: false,
		};
	}

	/**
	 * Validate multiple links
	 *
	 * @param urls - URLs to validate
	 * @returns Array of validation results
	 */
	async validateLinks(urls: string[]): Promise<LinkValidationResult[]> {
		return Promise.all(urls.map((url) => this.validateLink(url)));
	}

	/**
	 * Check a link using markdown-link-check
	 */
	private async checkLink(
		url: string,
	): Promise<Pick<LinkValidationResult, 'url' | 'status' | 'statusCode' | 'error'>> {
		return new Promise((resolve) => {
			const markdown = `[link](${url})`;

			markdownLinkCheck(
				markdown,
				{
					timeout: `${this.options.timeout}ms`,
					retryOn429: true,
					retryCount: this.options.retries,
					aliveStatusCodes: [200, 206, 301, 302, 307, 308],
					ignorePatterns: [],
					httpHeaders: [
						{
							urls: [url],
							headers: {
								'User-Agent': this.options.userAgent,
							},
						},
					],
				},
				(error: Error | null, results: Array<{ link: string; status: string; statusCode: number; err?: string | Error | object }>) => {
					if (error) {
						resolve({
							url,
							status: 'error',
							statusCode: 0,
							error: error.message,
						});
						return;
					}

					const result = results[0];
					if (!result) {
						resolve({
							url,
							status: 'error',
							statusCode: 0,
							error: 'No result from markdown-link-check',
						});
						return;
					}

					if (result.status === 'alive') {
						resolve({
							url,
							status: 'ok',
							statusCode: result.statusCode,
						});
					} else {
						const errorMessage = safeSerializeError(result.err) ?? `Link status: ${result.status}`;

						resolve({
							url,
							status: 'error',
							statusCode: result.statusCode,
							error: errorMessage,
						});
					}
				},
			);
		});
	}

	/**
	 * Clear the validation cache
	 */
	async clearCache(): Promise<void> {
		await this.cache.clear();
	}

	/**
	 * Get cache statistics
	 */
	async getCacheStats(): Promise<{ total: number; expired: number }> {
		return this.cache.getStats();
	}
}
