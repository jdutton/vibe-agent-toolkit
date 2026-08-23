---
paths:
  - "**/*.test.ts"
---

# A green test that proved nothing is worse than a red one

Both failures below exit 0. Neither is visible in a diff.

## Assert the COLLECTED-TEST COUNT

A vitest filter that matches no file collects **0 tests and exits 0**. A run reported as passing
may have executed nothing.

- Read the `Tests N passed` line before believing a green run. `0 passed` is a FAILURE.
- Prefer `bunx vitest run <exact/path.test.ts>` over a name substring — a wrong path errors,
  a wrong substring silently passes.

## Build control characters with `String.fromCodePoint` — never type an escape

A `\u`-style escape typed into a source file gets normalized into a **real control byte** on the
way in. That byte makes the file read as binary to `grep`, breaks exact-match edits, and is
invisible in review. It has bitten this repo repeatedly, once inside a comment warning about it.

```ts
const ESC = String.fromCodePoint(0x1b); // ✅
```

- `String.fromCharCode` is banned by `unicorn/prefer-code-point`; the two are identical for every
  BMP value, which is every control character.
- `cat -v` a fixture file you suspect. A stray `^[` is the tell.

## A POSIX absolute literal is not absolute on Windows

`/tmp/x` has no drive letter, so a hardcoded fixture root loses it and the test fails on Windows
CI only. This repo runs Windows in CI and has shipped several such defects.

- Build fixture paths from `tmpdir()` / `mkdtempSync`, never from a `/`-rooted literal.
- Compare paths with `toForwardSlash()` from `@vibe-agent-toolkit/utils`.

## Prove the test can fail

Before claiming a fix is pinned, revert the fix by hand and confirm the test goes red, with the
failure count stated. A test written from a diagnosis can be vacuous because the class is right
and the mechanism wrong.
