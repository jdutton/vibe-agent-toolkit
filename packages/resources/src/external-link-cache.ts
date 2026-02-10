import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Cache entry for external link validation results
 */
interface CacheEntry {
	statusCode: number;
	statusMessage: string;
	timestamp: number;
}

/**
 * Cache storage format
 */
interface CacheData {
	[url: string]: CacheEntry;
}

/**
 * External link validation cache
 *
 * Stores results of external URL checks to minimize redundant network requests.
 * Uses file-based storage for persistence across runs.
 *
 * Cache keys are SHA-256 hashes of normalized URLs to handle long URLs and
 * special characters safely in filenames.
 *
 * Example:
 * ```typescript
 * const cache = new ExternalLinkCache('/tmp/cache', 24);
 *
 * // Store a result
 * await cache.set('https://example.com', 200, 'OK');
 *
 * // Retrieve a result
 * const result = await cache.get('https://example.com');
 * if (result) {
 *   console.log(`Status: ${result.statusCode}`);
 * }
 * ```
 */
export class ExternalLinkCache {
	private readonly cacheDir: string;
	private readonly ttlHours: number;
	private readonly cacheFile: string;
	private cache: CacheData | null = null;

	/**
	 * Create a new external link cache
	 *
	 * @param cacheDir - Directory to store cache files
	 * @param ttlHours - Time-to-live in hours (default: 24)
	 */
	constructor(cacheDir: string, ttlHours = 24) {
		this.cacheDir = cacheDir;
		this.ttlHours = ttlHours;
		this.cacheFile = path.join(cacheDir, 'external-links.json');
	}

	/**
	 * Load cache from disk
	 */
	private async loadCache(): Promise<CacheData> {
		if (this.cache !== null) {
			return this.cache;
		}

		try {
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- cacheDir is constructor parameter, controlled by caller
			await fs.mkdir(this.cacheDir, { recursive: true });
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- cacheFile is derived from cacheDir
			const data = await fs.readFile(this.cacheFile, 'utf-8');
			this.cache = JSON.parse(data) as CacheData;
			return this.cache;
		} catch (error) {
			// Handle missing file or corrupted JSON - start with empty cache
			if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
				this.cache = {};
				return this.cache;
			}
			throw error;
		}
	}

	/**
	 * Save cache to disk
	 */
	private async saveCache(): Promise<void> {
		if (this.cache === null) {
			return;
		}

		// eslint-disable-next-line security/detect-non-literal-fs-filename -- cacheDir is constructor parameter, controlled by caller
		await fs.mkdir(this.cacheDir, { recursive: true });
		// eslint-disable-next-line security/detect-non-literal-fs-filename -- cacheFile is derived from cacheDir
		await fs.writeFile(this.cacheFile, JSON.stringify(this.cache, null, 2), 'utf-8');
	}

	/**
	 * Normalize URL for caching
	 *
	 * Removes trailing slashes and anchors to treat variations as the same URL.
	 */
	private normalizeUrl(url: string): string {
		try {
			const parsed = new URL(url);
			// Remove hash/anchor
			parsed.hash = '';
			// Remove trailing slash
			let normalized = parsed.toString();
			if (normalized.endsWith('/')) {
				normalized = normalized.slice(0, -1);
			}
			return normalized;
		} catch {
			// If URL parsing fails, use as-is
			return url;
		}
	}

	/**
	 * Generate cache key for URL
	 *
	 * Uses SHA-256 hash to handle long URLs and special characters.
	 */
	private getCacheKey(url: string): string {
		const normalized = this.normalizeUrl(url);
		return createHash('sha256').update(normalized).digest('hex');
	}

	/**
	 * Check if cache entry is expired
	 */
	private isExpired(entry: CacheEntry): boolean {
		const now = Date.now();
		const age = now - entry.timestamp;
		const ttlMs = this.ttlHours * 60 * 60 * 1000;
		return age > ttlMs;
	}

	/**
	 * Get cached result for URL
	 *
	 * @param url - URL to look up
	 * @returns Cache entry or null if not found/expired
	 */
	async get(url: string): Promise<CacheEntry | null> {
		const cache = await this.loadCache();
		const key = this.getCacheKey(url);
		const entry = cache[key];

		if (!entry) {
			return null;
		}

		if (this.isExpired(entry)) {
			delete cache[key];
			await this.saveCache();
			return null;
		}

		return entry;
	}

	/**
	 * Store validation result in cache
	 *
	 * @param url - URL to cache
	 * @param statusCode - HTTP status code
	 * @param statusMessage - HTTP status message
	 */
	async set(url: string, statusCode: number, statusMessage: string): Promise<void> {
		const cache = await this.loadCache();
		const key = this.getCacheKey(url);

		cache[key] = {
			statusCode,
			statusMessage,
			timestamp: Date.now(),
		};

		await this.saveCache();
	}

	/**
	 * Clear all cache entries
	 */
	async clear(): Promise<void> {
		this.cache = {};
		await this.saveCache();
	}

	/**
	 * Get cache statistics
	 */
	async getStats(): Promise<{ total: number; expired: number }> {
		const cache = await this.loadCache();
		const keys = Object.keys(cache);
		const expired = keys.filter((key) => {
			const entry = cache[key];
			// Type guard: ensure entry exists before checking expiration
			if (entry === undefined) {
				return false;
			}
			return this.isExpired(entry);
		}).length;

		return {
			total: keys.length,
			expired,
		};
	}
}
