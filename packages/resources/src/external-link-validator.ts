import { userInfo } from 'node:os';

import type { IssueCode } from '@vibe-agent-toolkit/agent-schema';
import {
  defaultRunCommand,
  resolveAuthenticatedUrl,
  safePath,
  type LinkAuthConfig,
  type ResolveOutcome,
} from '@vibe-agent-toolkit/utils';
import markdownLinkCheck from 'markdown-link-check';

import { ExternalLinkCache } from './external-link-cache.js';
import { classifyAuthenticatedResponse } from './link-auth-classify.js';
import { fetchAuthenticated } from './link-auth-fetch.js';

/**
 * Resolve the OS user for cache scoping. Falls back through several layers
 * because `os.userInfo()` throws when the running user has no /etc/passwd
 * entry (common in container environments) — that's recoverable, not fatal.
 */
function resolveOsUser(): string {
  try {
    const u = userInfo().username;
    if (u !== '') return u;
  } catch {
    // userInfo() throws when the running user has no /etc/passwd entry —
    // recover via env vars below.
  }
  // Use `||` (not `??`) so an empty-string USER/USERNAME also falls through.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
  const fromEnv = process.env['USER'] || process.env['USERNAME'];
  if (fromEnv) return fromEnv;
  // Last resort: two distinct OS users on the same host both end up here
  // would share the auth cache (cross-user leak). Warn once so the
  // collision is at least observable. Adopters whose container clears
  // these env vars deliberately can set `USER=container-name` to scope.
  warnDefaultUserFallbackOnce();
  return 'default';
}

let defaultUserWarned = false;
function warnDefaultUserFallbackOnce(): void {
  if (defaultUserWarned) return;
  defaultUserWarned = true;
  console.warn(
    "[vat] linkAuth: could not determine an OS user via os.userInfo() or USER/USERNAME env; " +
      "scoping auth cache to 'default'. Two users on this host would share auth-cached results — " +
      'set the USER env var explicitly to scope per-user.',
  );
}

/**
 * Wrap a `LinkAuthDeps` so its `runCommand` (used by the engine's
 * `resolveToken`) caches results per unique argv. Without this, validating N
 * URLs from the same host re-runs the token command N times — `gh auth token`
 * spawns a subprocess each call, and we treat *all* token sources as
 * potentially expensive per the #125 review.
 *
 * The memo cache is keyed by JSON-stringified argv, so semantically-identical
 * invocations share. Cache is per-instance — code that creates a fresh
 * validator per run gets a fresh cache.
 */
function wrapLinkAuthDepsWithMemo(deps: LinkAuthDeps): LinkAuthDeps {
  type RunCommandFn = NonNullable<NonNullable<LinkAuthDeps>['runCommand']>;
  type RunCommandResult = ReturnType<RunCommandFn>;
  const memo = new Map<string, RunCommandResult>();
  const baseRunCommand: RunCommandFn = deps?.runCommand ?? defaultRunCommand;
  const runCommand: RunCommandFn = (argv) => {
    const key = JSON.stringify(argv);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const fresh = baseRunCommand(argv);
    memo.set(key, fresh);
    return fresh;
  };
  return { ...(deps ?? {}), runCommand };
}


/**
 * Make an OS username safe for use as a directory component. Replaces path
 * separators (`/`, `\`), the parent-directory shorthand (`..`), and other
 * characters that could escape the cacheDir. Windows can produce
 * `DOMAIN\user` forms; tests inject pathological values like `../escaped`.
 */
function sanitizeOsUser(user: string): string {
  // Replace any character outside `[A-Za-z0-9._-]` with `_`. Then collapse any
  // remaining `..` so a name like `..foo` cannot recombine into a traversal.
  const replaced = user.replaceAll(/[^A-Za-z0-9._-]/g, '_').replaceAll('..', '__');
  return replaced.length > 0 ? replaced : 'default';
}

type LinkAuthDeps = Parameters<typeof resolveAuthenticatedUrl>[2];
type VerifiedPlan = Extract<ResolveOutcome, { fetchUrl: string }>;

/**
 * Build a LinkValidationResult from a status code by re-classifying it under
 * the current run's provider `check` block. Used by both the cache-hit and
 * cache-miss paths so the two produce identical results for the same
 * `(url, provider)` pair — the cache only persists `statusCode`, not the
 * derived `code`, so the code must be re-derived on every read.
 */
function buildAuthResult(
	originalUrl: string,
	statusCode: number,
	plan: VerifiedPlan,
	cached: boolean,
	cachedStatusMessage?: string,
): LinkValidationResult {
	const classified = classifyAuthenticatedResponse(statusCode, plan.check);
	const result: LinkValidationResult = {
		url: originalUrl,
		status: classified?.outcome === 'alive' ? 'ok' : 'error',
		statusCode,
		cached,
	};
	if (classified?.code != null) {
		result.code = classified.code;
	}
	if (result.status === 'error') {
		result.error = cachedStatusMessage ?? `HTTP ${statusCode}`;
	}
	return result;
}

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
	/** Request timeout in milliseconds (default: 3000) */
	timeout?: number;
	/** Number of retries for failed requests (default: 2) */
	retries?: number;
	/** User agent string for requests (default: generic) */
	userAgent?: string;
	/**
	 * Optional linkAuth config (per issue #113). When set, URLs whose host is
	 * claimed by a provider in this config bypass the anonymous markdown-link-check
	 * path and use an authenticated direct fetch instead. URLs no provider claims
	 * continue to use markdown-link-check.
	 */
	linkAuthConfig?: LinkAuthConfig;
	/**
	 * Override the `fetch` implementation used by the authenticated branch.
	 * Defaults to `globalThis.fetch`. Tests inject a stub; advanced adopters
	 * may inject a wrapper for corporate proxies, custom TLS, or telemetry.
	 */
	fetchImpl?: typeof fetch;
	/**
	 * Override the linkAuth engine's token-resolution dependencies (env map +
	 * runCommand). Defaults to reading `process.env` and running real commands
	 * via `safeExecSync`. Tests inject a deterministic env; advanced adopters
	 * usually leave unset.
	 */
	linkAuthDeps?: LinkAuthDeps;
	/**
	 * Override the sleep used between 429 retries. Defaults to `setTimeout`.
	 * Test-only — production benefits from real wall-clock delay so Retry-After
	 * hints are honored.
	 */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * OS user to scope the authenticated cache by (#113 §6.3). Defaults to
	 * `os.userInfo().username` with env-var fallbacks. Tests inject a fixed
	 * value; production callers omit.
	 */
	osUser?: string;
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
	/**
	 * Set when the authenticated branch classified the response (issue #113 §7).
	 * Consumers use this directly instead of mapping `statusCode` to a code, so
	 * `notFoundMeaning`-dependent routing (404 → `LINK_AUTH_DEAD` vs
	 * `LINK_AUTH_DEAD_OR_UNAUTHORIZED`) reflects the matched provider's config.
	 *
	 * Invariant: `code` is set iff the URL hit the authenticated branch AND
	 * the outcome maps to a `LINK_AUTH_*` code per §7 (`unverified`, or any
	 * classified status: `unauthorized`, `forbidden`, `dead`,
	 * `dead_or_unauthorized`). Unset on the anonymous markdown-link-check path,
	 * on `unsupported` (no provider claimed the host), and on classifier-`null`
	 * statuses (5xx, unclassified) where the consumer's status-code mapping
	 * (`EXTERNAL_URL_*`) is the correct fallback.
	 */
	code?: IssueCode;
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
 *   timeout: 3000,
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
	/**
	 * Auth-branch cache — scoped to a per-OS-user subdirectory of `cacheDir`
	 * (#113 §6.3) so two users on a shared machine never read each other's
	 * authenticated results. Distinct from `cache` (the anonymous cache, which
	 * stays shared across users for the markdown-link-check path).
	 */
	private readonly authCache: ExternalLinkCache;
	private readonly options: {
		cacheTtlHours: number;
		timeout: number;
		retries: number;
		userAgent: string;
	};
	private readonly linkAuthConfig: LinkAuthConfig | undefined;
	private readonly fetchImpl: typeof fetch;
	private readonly linkAuthDeps: LinkAuthDeps;
	private readonly sleep: ((ms: number) => Promise<void>) | undefined;

	/**
	 * Create a new external link validator
	 *
	 * @param cacheDir - Directory for storing cache
	 * @param options - Validation options
	 */
	constructor(cacheDir: string, options: ExternalLinkValidatorOptions = {}) {
		this.options = {
			cacheTtlHours: options.cacheTtlHours ?? 24,
			timeout: options.timeout ?? 3000,
			retries: options.retries ?? 2,
			userAgent:
				options.userAgent ??
				'Mozilla/5.0 (compatible; VAT-LinkChecker/1.0; +https://github.com/jdutton/vibe-agent-toolkit)',
		};

		this.linkAuthConfig = options.linkAuthConfig;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		// Wrap the configured runCommand (or the engine's default) with a memo
		// keyed by stringified argv so each unique token-resolution command runs
		// at most once per validator instance. Validating N links to the same
		// host previously re-resolved the token N times — including subprocess
		// spawns for `command` sources. Per #125 review: treat all token
		// resolvers as expensive; the memo's lifetime equals one validate() run.
		this.linkAuthDeps = wrapLinkAuthDepsWithMemo(options.linkAuthDeps);
		this.sleep = options.sleep;

		this.cache = new ExternalLinkCache(cacheDir, this.options.cacheTtlHours);

		const osUser = sanitizeOsUser(options.osUser ?? resolveOsUser());
		const authCacheDir = safePath.join(cacheDir, `auth-${osUser}`);
		this.authCache = new ExternalLinkCache(authCacheDir, this.options.cacheTtlHours);
	}

	/**
	 * Validate a single external link
	 *
	 * @param url - URL to validate
	 * @returns Validation result
	 */
	async validateLink(url: string): Promise<LinkValidationResult> {
		// Authenticated branch (issue #113): if a provider in linkAuthConfig
		// claims this URL's host, bypass markdown-link-check and do a direct
		// authenticated fetch + per-§7 classify.
		if (this.linkAuthConfig) {
			const plan = resolveAuthenticatedUrl(url, this.linkAuthConfig, this.linkAuthDeps);
			if ('fetchUrl' in plan) {
				return this.validateAuthenticatedLink(url, plan);
			}
			if (plan.outcome === 'unverified') {
				// Per §6.3: never cache unverified outcomes — the result flips the
				// moment a token appears, so caching a "no token" result is wrong.
				return {
					url,
					status: 'error',
					statusCode: 0,
					error: plan.reason,
					cached: false,
					code: 'LINK_AUTH_UNVERIFIED',
				};
			}
			// 'unsupported' → fall through to anonymous markdown-link-check path
		}

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
	 * Issue an authenticated fetch for `originalUrl` using the engine's plan
	 * (rewritten URL + auth headers + provider's check config), classify the
	 * response per #113 §7, and write a status-cache entry. Cache is keyed by
	 * the *rewritten* URL (§6.3) — the original `blob/` URL 404s, so caching
	 * by original would poison results.
	 */
	private async validateAuthenticatedLink(
		originalUrl: string,
		plan: VerifiedPlan,
	): Promise<LinkValidationResult> {
		// Cache check, keyed by rewritten URL. IMPORTANT: re-classify the cached
		// statusCode under the *current* run's provider `check` block, rather
		// than treating cache-hit as a status-only short-circuit. The cache
		// only persists `statusCode` — without re-classifying we'd drop the
		// LINK_AUTH_* `code`, and the consumer would fall back to
		// `EXTERNAL_URL_DEAD` (error) instead of `LINK_AUTH_DEAD_OR_UNAUTHORIZED`
		// (warning). Cache-hit semantics must match cache-miss semantics for
		// the same (url, provider) pair.
		const cached = await this.authCache.get(plan.fetchUrl);
		if (cached) {
			return buildAuthResult(originalUrl, cached.statusCode, plan, true, cached.statusMessage);
		}

		// Fresh fetch via the auth-aware helper (handles cross-origin redirect
		// Authorization stripping + 429/Retry-After per §5.2 §8). The conditional
		// spread builds the object in one pass — AuthFetchOptions.sleep is
		// readonly so post-construction assignment would be a TS error.
		const fetchOptions: Parameters<typeof fetchAuthenticated>[3] = {
			signal: AbortSignal.timeout(this.options.timeout),
			...(this.sleep === undefined ? {} : { sleep: this.sleep }),
		};

		let response: Response;
		try {
			response = await fetchAuthenticated(
				plan.fetchUrl,
				plan.headers,
				this.fetchImpl,
				fetchOptions,
			);
		} catch (err) {
			// Network-level failure (DNS/connect/TLS/timeout) — return error with
			// no code so the consumer's existing statusCode→IssueCode mapping
			// (EXTERNAL_URL_ERROR / EXTERNAL_URL_TIMEOUT) applies.
			const message = safeSerializeError(err) ?? 'Authenticated fetch failed';
			return {
				url: originalUrl,
				status: 'error',
				statusCode: 0,
				error: message,
				cached: false,
			};
		}

		const result = buildAuthResult(originalUrl, response.status, plan, false);
		// Persist by rewritten URL so subsequent runs hit the cache. The cache
		// only stores statusCode + statusMessage; the `code` is re-derived on
		// read by re-running classifyAuthenticatedResponse against the current
		// provider (see the authCache.get branch above).
		await this.authCache.set(plan.fetchUrl, result.statusCode, result.error ?? 'OK');
		return result;
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
	 * Clear both validation caches (anonymous + authenticated).
	 *
	 * Adopters call this after rotating a token or invalidating link data —
	 * the operation must wipe both surfaces or stale auth results survive
	 * (a real bug: a 401 cached under the old token would haunt the new one).
	 */
	async clearCache(): Promise<void> {
		await Promise.all([this.cache.clear(), this.authCache.clear()]);
	}

	/**
	 * Get combined cache statistics across both caches.
	 */
	async getCacheStats(): Promise<{ total: number; expired: number }> {
		const [anon, auth] = await Promise.all([this.cache.getStats(), this.authCache.getStats()]);
		return { total: anon.total + auth.total, expired: anon.expired + auth.expired };
	}
}
