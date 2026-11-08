### Fixed

- **`no-fs-realpathSync`, `no-os-tmpdir`, `no-fs-mkdirSync` and `no-child-process-execSync` no longer
  report a runtime `typeof` operand.** `expect(typeof fs.realpathSync.native).toBe('function')`,
  `typeof fs.realpathSync` and `typeof realpathSync` were reported as value references; a `typeof`
  neither calls nor passes the function. A reference nested deeper inside the operand
  (`typeof [x].map(realpathSync)`) is still reported.
- **`no-fs-realpathSync` and `no-child-process-execSync` no longer describe VAT's call shape for
  your own wrapper.** With `safeModule` set to a module outside `@vibe-agent-toolkit/utils`, the
  message said `normalizePath(target, { within })` / `safeExecSync(binary, args)` and the editor
  suggestion appended `{ within: TREE_CRAWLED_IN }` / `ARGV_FROM_SHELL_STRING`, which is wrong for a
  wrapper that takes the argument another way (`normalizePath(target, within)`). The message now
  names the function and your module without an argument spelling, and no suggestion is offered.
  With the default `safeModule`, or any `@vibe-agent-toolkit/utils` path, nothing changes.
