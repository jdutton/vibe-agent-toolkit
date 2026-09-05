import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

import { normalizedTmpdir, removeScratchDir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalLinkCache } from '../src/external-link-cache.js';

const EXAMPLE_URL = 'https://example.com';
const GITHUB_URL = 'https://github.com';
const BROKEN_URL = 'https://broken.com';
const CACHE_FILE = 'external-links.json';

/** The key `ExternalLinkCache` files a URL under — SHA-256 of the normalized URL. */
function entryKey(url: string): string {
	return createHash('sha256').update(url).digest('hex');
}

/**
 * Write the cache file directly, bypassing `set()`.
 *
 * Every test that pins the read boundary needs bytes the writer cannot
 * produce — that is what a read-boundary check is for — so going through the
 * public API would prove nothing.
 */
async function writeRawCache(dir: string, contents: unknown): Promise<void> {
	// eslint-disable-next-line security/detect-non-literal-fs-filename -- dir comes from mkdtemp in beforeEach
	await fs.writeFile(safePath.join(dir, CACHE_FILE), JSON.stringify(contents));
}

describe('ExternalLinkCache', () => {
	let tempDir: string;
	let cache: ExternalLinkCache;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'link-cache-test-'));
		cache = new ExternalLinkCache(tempDir, 24);
	});

	afterEach(async () => {
		await removeScratchDir(tempDir);
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
		vi.useFakeTimers();
		try {
			const shortLivedCache = new ExternalLinkCache(tempDir, 0); // 0 hours TTL

			await shortLivedCache.set(EXAMPLE_URL, 200, 'OK');

			// Advance time by 1ms to ensure TTL=0 entry expires
			vi.advanceTimersByTime(1);

			const result = await shortLivedCache.get(EXAMPLE_URL);
			expect(result).toBeNull();
		} finally {
			vi.useRealTimers();
		}
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

	describe('the removed cache version', () => {
		it('exports no hand-bumped version constant', async () => {
			// An absence pin, not decoration. `CACHE_VERSION = 1` never moved off
			// 1 and was checked INSTEAD OF the entry's own fields, so it
			// certified a shape it had not looked at. What replaced it is
			// `ExternalLinkCacheEntrySchema` at the read boundary. The guard
			// names the SHAPE rather than the symbol on purpose:
			// `CACHE_VERSION_2` would pass a symbol-only check.
			const modules = await Promise.all([
				import('../src/external-link-cache.js'),
				import('../src/schemas/external-link-cache.js'),
			]);
			const versionish = modules.flatMap((module) =>
				Object.keys(module).filter((name) => /VERSION|REVISION/u.test(name)),
			);

			expect(versionish).toStrictEqual([]);
		});

		it('writes no version field to disk', async () => {
			await cache.set(EXAMPLE_URL, 200, 'OK');

			const cacheFile = safePath.join(tempDir, CACHE_FILE);
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir from mkdtemp
			const written: unknown = JSON.parse(await fs.readFile(cacheFile, 'utf-8'));
			const entries = Object.values(written as Record<string, Record<string, unknown>>);

			expect(entries).toHaveLength(1);
			expect(entries[0]).not.toHaveProperty('version');
		});

		it('treats an entry carrying the old version field as a miss', async () => {
			// The migration, such as it is: `.strict()` sees `version` as a key
			// this build has no field for, so entries written by the removed
			// code path cost exactly one refetch and then stop existing. Pre-1.0
			// this repo does not keep a field alive for a reader that is gone.
			const url = 'https://versioned.example.com';
			await writeRawCache(tempDir, {
				[entryKey(url)]: {
					statusCode: 200,
					statusMessage: 'OK',
					timestamp: Date.now(),
					version: 1,
				},
			});

			expect(await cache.get(url)).toBeNull();
		});
	});

	describe('the read boundary', () => {
		it('treats a foreign statusCode type as a miss, not a broken link', async () => {
			// The failure the removed constant permitted: `version: 1` passed and
			// nothing looked at `statusCode`, so a string reached `isAliveStatus`
			// — a `Set<number>.has`, which no string is ever a member of. The
			// link would have been reported broken at full confidence.
			const url = 'https://stringly.example.com';
			await writeRawCache(tempDir, {
				[entryKey(url)]: { statusCode: '200', statusMessage: 'OK', timestamp: Date.now() },
			});

			expect(await cache.get(url)).toBeNull();
		});

		it('treats an entry missing a required field as a miss', async () => {
			const url = 'https://truncated.example.com';
			await writeRawCache(tempDir, { [entryKey(url)]: { statusCode: 200 } });

			expect(await cache.get(url)).toBeNull();
		});

		it('does not count a timestamp-less entry as a live cached result', async () => {
			// Why the schema runs at load rather than per-lookup: `getStats`
			// never calls `get`, so an entry with no `timestamp` would give
			// `NaN > ttlMs === false` and be reported live forever, with no
			// lookup able to evict it.
			await writeRawCache(tempDir, {
				[entryKey('https://ageless.example.com')]: { statusCode: 200, statusMessage: 'OK' },
			});

			expect(await cache.getStats()).toEqual({ total: 0, expired: 0 });
		});

		it('keeps well-formed neighbours of a rejected entry', async () => {
			// Per-entry, not per-file. `z.record` would reject the map wholesale
			// and — on a cache deliberately shared across VAT versions — turn one
			// bad neighbour into a full internet refetch.
			await writeRawCache(tempDir, {
				[entryKey(EXAMPLE_URL)]: { statusCode: 200, statusMessage: 'OK', timestamp: Date.now() },
				[entryKey(BROKEN_URL)]: { statusCode: 404, statusMessage: 'Not Found', timestamp: 'yesterday' },
			});

			expect(await cache.get(EXAMPLE_URL)).not.toBeNull();
			expect(await cache.get(BROKEN_URL)).toBeNull();
		});

		it('degrades a non-object cache file to an empty cache', async () => {
			await writeRawCache(tempDir, ['not', 'a', 'map']);

			expect(await cache.get(EXAMPLE_URL)).toBeNull();
			expect(await cache.getStats()).toEqual({ total: 0, expired: 0 });
		});
	});

	it('should handle corrupted cache file gracefully', async () => {
		// Write invalid JSON to cache file
		const cacheFile = safePath.join(tempDir, CACHE_FILE);
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

	// chmod modes used to simulate IO failures. Named for documentation; the
	// `sonarjs/file-permissions` warning fires on the chmod call sites (where
	// the literal is "applied"), so the per-call eslint-disable comments at
	// each `await fs.chmod(...)` are what actually silence it.
	const MODE_NO_PERMS = 0o000;
	const MODE_RO_OWNER = 0o500;
	const MODE_RW_OWNER = 0o700;
	const MODE_RW_FILE = 0o644;

	it.skipIf(process.platform === 'win32')(
		'treats EACCES on cache file as a cache miss (fail-soft IO; POSIX-only)',
		async () => {
			// Per #125 review: cache IO must degrade, not abort the whole run.
			// Seed an entry, then revoke read permission on the cache file —
			// the next get() call should return null rather than throw EACCES.
			await cache.set(EXAMPLE_URL, 200, 'OK');
			const cacheFile = safePath.join(tempDir, CACHE_FILE);
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: revokes perms on self-created tempDir to simulate EACCES
			await fs.chmod(cacheFile, MODE_NO_PERMS);
			try {
				// Fresh instance to force re-read from disk.
				const newCache = new ExternalLinkCache(tempDir, 24);
				const result = await newCache.get(EXAMPLE_URL);
				expect(result).toBeNull();
			} finally {
				// Restore perms so afterEach cleanup succeeds.
				// eslint-disable-next-line security/detect-non-literal-fs-filename, sonarjs/file-permissions -- test-only: restore RW (0o644) on file inside self-created tempDir so cleanup runs
				await fs.chmod(cacheFile, MODE_RW_FILE);
			}
		},
	);

	it.skipIf(process.platform === 'win32')(
		'treats EACCES on cache directory as a no-op set (fail-soft IO; POSIX-only)',
		async () => {
			// Read-only parent dir → mkdir/writeFile fail with EACCES. set()
			// must complete without throwing; the in-memory cache still holds
			// the entry for the rest of this run, but the disk write is lost.
			// eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: read-only mode on tempDir to simulate EACCES
			await fs.chmod(tempDir, MODE_RO_OWNER);
			try {
				await expect(cache.set(EXAMPLE_URL, 200, 'OK')).resolves.toBeUndefined();
			} finally {
				// eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only: restore RW on tempDir for cleanup
				await fs.chmod(tempDir, MODE_RW_OWNER);
			}
		},
	);

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

		// Add expired entry using fake timers for deterministic expiry
		vi.useFakeTimers();
		try {
			const shortCache = new ExternalLinkCache(tempDir, 0);
			await shortCache.set(BROKEN_URL, 404, 'Not Found');

			// Advance time by 1ms to ensure TTL=0 entry expires
			vi.advanceTimersByTime(1);

			stats = await shortCache.getStats();
			expect(stats.total).toBeGreaterThan(0);
			expect(stats.expired).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('should handle cache directory creation', async () => {
		// Test with non-existent directory
		const newDir = safePath.join(tempDir, 'nested', 'cache');
		const newCache = new ExternalLinkCache(newDir, 24);

		// Should create directory and work normally
		await newCache.set(EXAMPLE_URL, 200, 'OK');
		const result = await newCache.get(EXAMPLE_URL);

		expect(result).not.toBeNull();
		expect(result?.statusCode).toBe(200);
	});
});
