### Changed

- **`@vibe-agent-toolkit/no-fs-realpathSync` no longer autofixes.** Its fix wrote a one-argument
  `normalizePath(x)`, which does not compile now that `normalizePath` takes `{ within }`. `--fix`
  leaves the call alone; the editor suggestion writes `normalizePath(x, { within: undefined })`,
  which fails the typecheck until you name the tree the path is crawled in.
- **`@vibe-agent-toolkit/no-child-process-execSync` no longer autofixes.** Its fix turned
  `execSync('ls -la')` into `safeExecSync('ls -la')`, which compiles but runs a binary named
  `ls -la`: `safeExecSync` takes a binary and an argument array, not a shell string. Re-check any
  call an earlier `--fix` rewrote. The editor suggestion appends `ARGV_FROM_SHELL_STRING`, which
  fails the typecheck until you split the command.
