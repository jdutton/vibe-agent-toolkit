import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

import {
	type ExternalLinkCacheEntry,
	ExternalLinkCacheEntrySchema,
} from './schemas/external-link-cache.js';

/**
 * Owner-only mode for the cache directory.
 *
 * `<tmpdir>/.vat-cache/` is a world-readable location shared by every user on the
 * host, and this cache holds the set of external URLs a project links to —
 * including private hostnames — while the per-user `auth-<user>/` sibling is
 * scoped by directory NAME alone, with no permission backing it. Creating the
 * directory owner-only is what makes that scoping mean something.
 *
 * ⚠️ POSIX only. On Windows the mode bits reduce to the read-only flag, so this
 * is a real mitigation on Linux and macOS and a no-op there — do not cite it as
 * a cross-platform guarantee.
 */
const CACHE_DIR_MODE = 0o700;

/**
 * Cache entry for external link validation results.
 *
 * Inferred from {@link ExternalLinkCacheEntrySchema}, not declared here: the
 * schema is what the read boundary actually enforces, so a hand-written twin
 * could only ever drift away from the check that matters.
 */
type CacheEntry = ExternalLinkCacheEntry;

/**
 * Cache storage format
 */
interface CacheData {
	[url: string]: CacheEntry;
}

/**
 * Keep only the entries this build can account for.
 *
 * ## Why validation lives at load, not at `get`
 *
 * The alternative — validate the one entry a lookup asks for — leaves every
 * other consumer reading whatever the file happened to hold. `getStats` counts
 * entries and calls `isExpired` on each; a foreign entry with no `timestamp`
 * yields `NaN > ttlMs === false`, so it is silently reported as a *live* cached
 * result, forever, and no lookup ever touches it to find out otherwise.
 * Filtering once, where the bytes enter the process, is what makes
 * {@link CacheData}'s type honest for every reader rather than for one of them.
 *
 * ## Per entry, not per file
 *
 * A single unparseable entry must not cost the whole file. `z.record` would
 * reject the map wholesale, which — on a cache shared by every VAT version on
 * the host, none of them namespaced — turns one bad neighbour into a full
 * internet re-fetch. Each entry stands or falls alone; a rejected one is simply
 * absent, and the next `set` for that URL rewrites it.
 *
 * ⚠️ Rejected entries are dropped from memory, not eagerly rewritten to disk.
 * They vanish from the file the next time anything calls `saveCache`, which is
 * a `set` or a `clear`. A read-only run leaves them where they lie — harmless,
 * since nothing in this process can see them, and cheaper than a disk write on
 * every lookup (which is what the removed version check did).
 *
 * `Object.fromEntries` rather than assignment into a literal, deliberately: the
 * keys come from a file any local user can write, and `entries['__proto__'] =`
 * on an object literal mutates the prototype instead of adding a property.
 * `fromEntries` defines an own data property, so a hostile key is inert data.
 *
 * @param value - The `JSON.parse` product of the cache file, unvalidated
 * @returns Every well-formed entry, keyed as stored
 */
function readEntries(value: unknown): CacheData {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return {};
	}

	return Object.fromEntries(
		Object.entries(value).flatMap(([key, candidate]) => {
			const parsed = ExternalLinkCacheEntrySchema.safeParse(candidate);
			return parsed.success ? [[key, parsed.data] as const] : [];
		}),
	);
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
		this.cacheFile = safePath.join(cacheDir, 'external-links.json');
	}

	/**
	 * Load cache from disk. Fail-soft: any IO error (ENOENT, EACCES, EROFS,
	 * corrupted JSON, …) degrades to an empty cache instead of throwing, and
	 * every surviving entry is put through {@link readEntries} — fail-soft
	 * covers unreadable bytes, the schema covers readable ones this build
	 * cannot account for, and neither is a substitute for the other.
	 *
	 * Why no error propagation: `vat resources validate` should keep running
	 * when the cache file isn't reachable (read-only filesystem, permission
	 * mismatch, full disk) — a missing cache costs an extra network round-trip,
	 * an exception costs the whole run. Per #125 review.
	 */
	private async loadCache(): Promise<CacheData> {
		if (this.cache !== null) {
			return this.cache;
		}

		try {
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- cacheDir is constructor parameter, controlled by caller
			await fs.mkdir(this.cacheDir, { recursive: true, mode: CACHE_DIR_MODE });
			 
			// eslint-disable-next-line security/detect-non-literal-fs-filename, local/no-raw-text-decode -- reading back this cache's own JSON, written as UTF-8 by `save()` below
			const data = await fs.readFile(this.cacheFile, 'utf-8');
			this.cache = readEntries(JSON.parse(data));
			return this.cache;
		} catch {
			// All IO and parse errors degrade to an empty cache. Subsequent
			// reads see the same empty cache (this.cache is set), so we don't
			// re-spam mkdir/read on every lookup within the same run.
			this.cache = {};
			return this.cache;
		}
	}

	/**
	 * Save cache to disk. Fail-soft: any IO error becomes a no-op instead of
	 * throwing. Same rationale as `loadCache` — a non-persisted entry costs an
	 * extra fetch on the next run, an exception costs the whole current run.
	 */
	private async saveCache(): Promise<void> {
		if (this.cache === null) {
			return;
		}

		try {
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- cacheDir is constructor parameter, controlled by caller
			await fs.mkdir(this.cacheDir, { recursive: true, mode: CACHE_DIR_MODE });
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- cacheFile is derived from cacheDir
			await fs.writeFile(this.cacheFile, JSON.stringify(this.cache, null, 2), 'utf-8');
		} catch {
			// No-op on IO failure. The in-memory cache (`this.cache`) is still
			// authoritative for the current run; only the disk persistence is
			// lost.
		}
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
	 * Check if cache entry is expired.
	 *
	 * The TTL and the schema are orthogonal gates and neither subsumes the
	 * other: the schema asks whether the entry is a *shape* this build can
	 * read, the TTL asks whether the world has had time to move under it. A
	 * schema-valid entry can be a year stale; a five-second-old entry can be
	 * written by a foreign build.
	 *
	 * The TTL does, however, carry one job the schema hands it. Because this
	 * tenant lives outside the version namespace on purpose (see
	 * `schemas/external-link-cache.ts`), the shape changes a validator cannot
	 * see — an added *optional* field — have no directory rename to hide behind
	 * here. `ttlHours` is what bounds them: the affected entries age out within
	 * a day rather than being detected. Bounded, not immediate.
	 */
	private isExpired(entry: CacheEntry): boolean {
		const now = Date.now();
		const age = now - entry.timestamp;
		const ttlMs = this.ttlHours * 60 * 60 * 1000;
		return age > ttlMs;
	}

	/**
	 * Get cached result for URL.
	 *
	 * There is no version field to check. Shape is settled before an entry ever
	 * reaches here — {@link readEntries} ran at load, so anything still in
	 * `cache` is an entry this build can account for, and the only question
	 * left at lookup time is age. Ordering the two that way is deliberate: a
	 * foreign entry is not merely unusable for *this* URL, it is unusable for
	 * every reader, so rejecting it per-lookup would have been the narrower fix.
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
