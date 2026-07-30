/**
 * Make a process's stdio blocking, so `process.exit()` can never discard output.
 *
 * Lives in utils rather than in the CLI because it is not CLI-specific: it
 * belongs to any published bin that writes a payload and then exits. VAT ships
 * two of those (`vat` and the resource-compiler bin), and the CLI package sits
 * at the top of the dependency chain — nothing may depend on it — so a bin
 * outside `packages/cli` could not reach this fix while it lived there.
 */

/** Whether each stdio stream was actually switched into blocking mode. */
export interface StdioBlockingResult {
	stdout: boolean;
	stderr: boolean;
}

/**
 * Switch one stream's underlying handle into blocking mode.
 *
 * @returns `true` only if `setBlocking` was present AND completed without
 * throwing. Both failure modes are real: a handle can be absent (stdio replaced,
 * or a shape libuv does not wrap), and `setBlocking` can throw on a handle type
 * that does not support it.
 */
function setStreamBlocking(stream: NodeJS.WriteStream): boolean {
	try {
		const handle = (
			stream as unknown as { _handle?: { setBlocking?: (blocking: boolean) => void } }
		)._handle;
		if (typeof handle?.setBlocking !== 'function') return false;
		handle.setBlocking(true);
		return true;
	} catch {
		// Best-effort: never let a startup nicety take down the process.
		return false;
	}
}

/**
 * Make stdout/stderr BLOCKING, so that `process.exit()` can never discard output.
 *
 * Call once, first thing, from a bin's entry point.
 *
 * Node makes a pipe's stdio non-blocking, which is what turns `console.log` and
 * `process.stdout.write` into buffered, asynchronous writes. `process.exit` does
 * not drain those buffers, so a command that exits the moment it finishes can
 * lose whatever had not yet reached the pipe (64 KB on Linux/macOS) — with exit
 * code 0, so nothing signals the loss. An interactive TTY is unbuffered and
 * looks perfect, which is why this class of bug survives: it only bites the
 * piped consumer (`vat command | jq .status`).
 *
 * Fixing this at a single YAML writer would cover stdout only. It is done here
 * because the same truncation applies to STDERR, which carries progress lines
 * and `file:line:column: severity:` findings, and a report that loses its tail
 * at 64 KB is worse than one that never printed. One mechanism covers both
 * streams and every writer, present and future.
 *
 * `setBlocking` is the libuv behaviour behind `process.stdout` and the mechanism
 * Node itself uses for TTYs; it is reached through the stream's INTERNAL handle,
 * so every access is guarded and a failure is non-fatal — a platform where this
 * is unavailable keeps the previous behaviour rather than crashing at startup.
 *
 * That guard is exactly why this reports back instead of returning `void`.
 * Depending on an internal API means the silent-failure path is a genuine
 * possibility — Windows named pipes do not present the same handle shape as
 * POSIX pipes — and a silent failure here reverts to truncating output with
 * nothing to distinguish it from a working run. Callers surface the result
 * under a debug flag so a truncation report can be diagnosed rather than
 * guessed at. See {@link describeStdioBlocking}.
 */
export function makeStdioBlocking(): StdioBlockingResult {
	return {
		stdout: setStreamBlocking(process.stdout),
		stderr: setStreamBlocking(process.stderr),
	};
}

/**
 * Render {@link makeStdioBlocking}'s result as one debug line.
 *
 * Lives next to the thing it describes because every bin that calls
 * `makeStdioBlocking` reports it, and hand-written copies of the wording
 * would drift.
 */
export function describeStdioBlocking(result: StdioBlockingResult): string {
	const failed = (['stdout', 'stderr'] as const).filter((name) => !result[name]);
	if (failed.length === 0) {
		return 'stdio: stdout and stderr are blocking; process.exit cannot truncate output';
	}
	return `stdio: could NOT make ${failed.join(' and ')} blocking — output on ${failed.length === 1 ? 'that stream' : 'those streams'} may be truncated at the pipe buffer when the CLI exits`;
}
