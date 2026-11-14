/**
 * ExternalLinkValidator against a real HTTP server — one on 127.0.0.1, port 0,
 * started once for the file — so every case runs on every machine, CI
 * included, and fails only on our code.
 *
 * It checked https://example.com/ before, behind `NET_AVAILABLE=1`, and redded
 * CI whenever that host refused a runner: the suite measured someone else's
 * uptime and bot policy. A server we own also reaches what a public host
 * cannot be made to do on demand: a 500, a 429 that clears on the third try,
 * a request that never answers.
 *
 * The anonymous lane is markdown-link-check (link-check + needle): HEAD first,
 * GET when HEAD is not 200, redirects followed, and a retry only on a 429.
 * Every `Retry-After` here is `0`, because link-check waits 60 s on a 429 that
 * carries none.
 */
import type { ServerResponse } from 'node:http';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ExternalLinkValidator } from '../../src/external-link-validator.js';
import {
	setupExternalLinkValidatorSuite,
	startLinkTestServer,
	type LinkTestRoute,
	type LinkTestServer,
} from '../test-helpers.js';

/** A reserved TLD (RFC 2606 §2): no resolver can ever answer for it. */
const UNRESOLVABLE_URL = 'https://nonexistent.invalid/';

/** Short enough that the no-answer cases cost well under a second. */
const SHORT_TIMEOUT_MS = 100;

/** The 429s a flaky route sends before it answers 200. */
const FLAKY_FAILURES = 2;

/** Routes held open until all of them have a request in flight. */
const GATED_PATHS = ['/gate-a', '/gate-b', '/gate-c'];

function tooManyRequests(response: ServerResponse): void {
	response.writeHead(429, { 'retry-after': '0' }).end();
}

/**
 * A barrier: each request waits until every gated path has one in flight. A
 * validator that checked the links one at a time would never fill it, so its
 * first request would time out.
 */
function gatedRoutes(): Record<string, LinkTestRoute> {
	const waiting: ServerResponse[] = [];
	const hold: LinkTestRoute = (_request, response) => {
		waiting.push(response);
		if (waiting.length < GATED_PATHS.length) return;
		for (const held of waiting.splice(0)) held.writeHead(200).end();
	};
	return Object.fromEntries(GATED_PATHS.map((gatedPath) => [gatedPath, hold]));
}

function validatorIn(cacheDir: string, options: { timeout?: number; retries?: number }): ExternalLinkValidator {
	return new ExternalLinkValidator(cacheDir, { cacheTtlHours: 24, ...options });
}

/** How many GETs reached `routePath`: one per attempt once HEAD is refused. */
function gets(server: LinkTestServer, routePath: string): number {
	return server.requests(routePath).filter((method) => method === 'GET').length;
}

/**
 * Check `url` twice and assert both found no answer (status 0) and nothing was
 * cached. A no-answer is refused at both ends of the cache, never written and
 * never read back: the stats see the write side, `second.cached` the two together.
 */
async function expectNoAnswerNeverCached(validator: ExternalLinkValidator, url: string): Promise<void> {
	const first = await validator.validateLink(url);
	const second = await validator.validateLink(url);

	expect(first.url).toBe(url);
	expect(first.status).toBe('error');
	expect(first.statusCode).toBe(0);
	expect(first.error).toBeDefined();
	expect(second.cached).toBe(false);
	expect(await validator.getCacheStats()).toEqual({ total: 0, expired: 0 });
}

describe('ExternalLinkValidator (integration, local HTTP server)', () => {
	let server: LinkTestServer;

	beforeAll(async () => {
		server = await startLinkTestServer({
			'/ok': (_request, response) => response.writeHead(200).end('ok'),
			'/server-error': (_request, response) => response.writeHead(500).end(),
			'/moved': (_request, response) => response.writeHead(301, { location: '/ok' }).end(),
			'/moved-to-missing': (_request, response) => response.writeHead(302, { location: '/missing' }).end(),
			'/never-answers': () => {
				// Hold the socket open; close() destroys it.
			},
			// HEAD always refused, so every attempt also issues the GET counted below.
			'/flaky': (request, response, seen) => {
				if (request.method === 'GET' && seen >= FLAKY_FAILURES) {
					response.writeHead(200).end('ok');
					return;
				}
				tooManyRequests(response);
			},
			'/always-429': (_request, response) => tooManyRequests(response),
			...gatedRoutes(),
		});
	});

	afterAll(async () => {
		await server.close();
	});

	const suite = setupExternalLinkValidatorSuite('link-validator-integration-');
	beforeEach(suite.beforeEach);
	afterEach(suite.afterEach);

	it('reports a 200 as ok', async () => {
		const url = server.url('/ok');
		const result = await suite.validator.validateLink(url);

		expect(result).toEqual({ url, status: 'ok', statusCode: 200, cached: false });
	});

	it.each([
		['/missing', 404],
		['/server-error', 500],
	])('reports %s as broken with status %i', async (routePath, statusCode) => {
		const url = server.url(routePath);
		const result = await suite.validator.validateLink(url);

		expect(result.url).toBe(url);
		expect(result.status).toBe('error');
		expect(result.statusCode).toBe(statusCode);
		expect(result.cached).toBe(false);
		expect(result.error).toBeDefined();
	});

	it('follows a redirect and reports the status it lands on', async () => {
		const before = server.requests('/ok').length;
		const result = await suite.validator.validateLink(server.url('/moved'));

		expect(result.status).toBe('ok');
		expect(result.statusCode).toBe(200);
		expect(server.requests('/ok').length).toBeGreaterThan(before);
	});

	it('reports a redirect to a missing page as broken', async () => {
		const result = await suite.validator.validateLink(server.url('/moved-to-missing'));

		expect(result.status).toBe('error');
		expect(result.statusCode).toBe(404);
	});

	it('answers a repeated check from the cache without a second request', async () => {
		const url = server.url('/ok');
		const first = await suite.validator.validateLink(url);
		const requestsAfterFirst = server.requests('/ok').length;
		const second = await suite.validator.validateLink(url);

		expect(first.cached).toBe(false);
		expect(second).toEqual({ url, status: 'ok', statusCode: 200, cached: true });
		expect(server.requests('/ok')).toHaveLength(requestsAfterFirst);
	});

	it('caches a broken result too, with its status', async () => {
		const url = server.url('/missing');
		await suite.validator.validateLink(url);
		const second = await suite.validator.validateLink(url);

		expect(second.cached).toBe(true);
		expect(second.status).toBe('error');
		expect(second.statusCode).toBe(404);
	});

	it('reports a server that never answers as an error, and does not cache it', async () => {
		const validator = validatorIn(suite.tempDir, { timeout: SHORT_TIMEOUT_MS });
		await expectNoAnswerNeverCached(validator, server.url('/never-answers'));
	});

	it('reports a name that can never resolve as an error, and does not cache it', async () => {
		await expectNoAnswerNeverCached(suite.validator, UNRESOLVABLE_URL);
	});

	it('retries a 429 and succeeds once the server answers', async () => {
		const validator = validatorIn(suite.tempDir, { retries: FLAKY_FAILURES });
		const result = await validator.validateLink(server.url('/flaky'));

		expect(result.status).toBe('ok');
		expect(result.statusCode).toBe(200);
		expect(gets(server, '/flaky')).toBe(FLAKY_FAILURES + 1);
	});

	it('stops after the configured retries and reports the 429 uncached', async () => {
		const retries = 2;
		const validator = validatorIn(suite.tempDir, { retries });
		const url = server.url('/always-429');

		const first = await validator.validateLink(url);
		expect(first.status).toBe('error');
		expect(first.statusCode).toBe(429);
		expect(gets(server, '/always-429')).toBe(retries + 1);

		const second = await validator.validateLink(url);
		expect(second.cached).toBe(false);
		expect(await validator.getCacheStats()).toEqual({ total: 0, expired: 0 });
	});

	it('checks multiple links concurrently and returns results in input order', async () => {
		const gated = GATED_PATHS.map((gatedPath) => server.url(gatedPath));
		const urls = [...gated, server.url('/missing'), UNRESOLVABLE_URL];

		const results = await validatorIn(suite.tempDir, { timeout: 2000 }).validateLinks(urls);

		expect(results.map((r) => r.url)).toEqual(urls);
		expect(results.map((r) => [r.status, r.statusCode])).toEqual([
			['ok', 200],
			['ok', 200],
			['ok', 200],
			['error', 404],
			['error', 0],
		]);
	});

	it('gives concurrent checks of one URL the same answer', async () => {
		const url = server.url('/ok');
		const results = await Promise.all([
			suite.validator.validateLink(url),
			suite.validator.validateLink(url),
			suite.validator.validateLink(url),
		]);

		for (const result of results) {
			expect(result.status).toBe('ok');
			expect(result.statusCode).toBe(200);
		}
	});

	it('refetches after the cache is cleared', async () => {
		const url = server.url('/ok');
		await suite.validator.validateLink(url);
		await suite.validator.clearCache();
		const requestsBefore = server.requests('/ok').length;

		const result = await suite.validator.validateLink(url);

		expect(result.cached).toBe(false);
		expect(server.requests('/ok').length).toBeGreaterThan(requestsBefore);
	});

	it('counts cached entries in its statistics', async () => {
		expect(await suite.validator.getCacheStats()).toEqual({ total: 0, expired: 0 });

		await suite.validator.validateLink(server.url('/ok'));
		await suite.validator.validateLink(server.url('/missing'));

		expect(await suite.validator.getCacheStats()).toEqual({ total: 2, expired: 0 });
	});
});
