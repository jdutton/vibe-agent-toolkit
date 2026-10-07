### Added

- **`@vibe-agent-toolkit/utils` exports ordered and bounded-parallel async iteration:**
  `forEachInOrder`, `mapInOrder`, `everyInOrder` (one call at a time; the first rejection, or the
  first `false` for `everyInOrder`, stops the run before any later item starts) and
  `mapWithConcurrency(items, fn, limit = FS_CONCURRENCY)` (`Promise.all`-shaped, at most `limit`
  in flight, results in input order; a limit that is not a whole number of at least 1 rejects
  with `RangeError`). They replace `await` inside a loop, which the repo's ESLint config now refuses
  (`no-await-in-loop` and core `require-await`, mirroring SonarCloud S9382 and S7503).
  Alongside them: `mapConcurrentFailingInOrder(items, fn)` (`mapWithConcurrency` that lets every
  call settle, then rethrows the failure of the EARLIEST item by position — the error a sequential
  loop would have raised) and `promised(work)` (`work()` as a promise, a synchronous throw
  arriving as a rejection — `Promise.try` until the Node floor has it).

### Changed

- **Breaking: `importSkillToAgent` (`@vibe-agent-toolkit/agent-skills`) is synchronous.** It
  returns `ImportResult` directly instead of `Promise<ImportResult>`: its body never awaited
  anything. Drop the `await` at the call site; a caller that chained `.then()` must not.
