#!/usr/bin/env node
/**
 * Portable echo: prints `process.argv.slice(2).join(' ')`.
 *
 * Used by safe-exec integration tests instead of the system `echo` binary.
 * On Windows the GNU coreutils `echo.exe` lives at `C:\Program Files\Git\usr\bin`
 * — present in Git Bash and on GitHub-hosted runners by happenstance, absent
 * in plain PowerShell/cmd. Depending on it made the tests silently dependent
 * on the launching shell. Node is always on PATH wherever vitest runs, so we
 * use `node <this-fixture>` instead. See issue #102 follow-up.
 */
process.stdout.write(process.argv.slice(2).join(' '));
