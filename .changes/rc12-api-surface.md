### Breaking

- **`normalizePath(target, { within })` replaces `normalizePath(...paths)`** (`@vibe-agent-toolkit/utils`,
  library-only). A relative `target` resolves against cwd; `within` is the tree being crawled (pass `target`
  itself for the operator's own path). No old spelling compiles. Migrate each by its arity:
  - `normalizePath(rel, base)` — the old two-path form resolved its FIRST argument against its SECOND →
    `normalizePath(safePath.resolve(base, rel), { within: base })`.
  - `normalizePath(a, b)` with an ABSOLUTE first argument — the old form returned `a` and ignored `b`, so
    the call was almost always written root-first: you probably meant
    `normalizePath(safePath.resolve(a, b), { within: a })`.
  - `normalizePath(a, b, c, …)` — three or more resolved left to right → `normalizePath(safePath.resolve(a, b, c, …), { within: a })`,
    or plain `safePath.resolve(a, b, c, …)` where the caller never needed the real path.
  - `normalizePath(rel)` with a relative path → `path.normalize(rel)`. The old one-path form returned a
    relative path and touched no filesystem; `normalizePath` now always returns an absolute,
    filesystem-resolved one.
  - `normalizePath(abs)` with an absolute path → `normalizePath(abs, { within: abs })`.
- **`new FsLookupCache(within)` and `crawlDirectorySync({ outputs, … })` take required arguments**
  (`@vibe-agent-toolkit/utils`, library-only): the cache names the tree its paths are crawled in, and
  `crawlDirectorySync` requires `outputs` exactly as `crawlDirectory` does (`[]` for a read-only caller).
- **`@vibe-agent-toolkit/resource-compiler/language-service`: `loadMarkdownResource(filePath, within)` and
  `getMarkdownResource(filePath, within, loader)` take a required `within`** (library-only) — the
  directory of the file that imports the markdown.
- **The `@vibe-agent-toolkit/utils` `.` barrel no longer re-exports process, git, crawl, skill-test, YAML-edit
  or link-auth code** (library-only). Change the import path; the names are unchanged:
  - `./process`: `isToolAvailable`, `getToolVersion`, `safeExecSync`, `safeExecResult`, `safeExecFromString`,
    `SafeExecOptions`, `SafeExecResult`, `CommandExecutionError`, `spawnHardened`, `shouldUseShell`,
    `hasShellSyntax`, `isPathLike`, `resolveShellCommandToken`, `windowsShellQuote`, `buildWindowsShellLine`,
    `makeStdioBlocking`, `describeStdioBlocking`, `StdioBlockingResult`.
  - `./git`: `GitTracker`, `GitTrackerInitOptions`, `gitFindRoot`, `gitLsFiles`, `isGitIgnored`,
    `loadGitignoreRules`, `isGitUrl`, `parseGitUrl`, `ParsedGitUrl`, `nonInteractiveGitOverrides`,
    `NonInteractiveGitOverrides`.
  - `./crawl`: `crawlDirectory`, `crawlDirectorySync`, `CrawlOptions`, `NEVER_CRAWL_GLOBS`, `BUILD_OUTPUT_GLOBS`.
  - `./skill-test` (new subpath): `spawnHeadlessClaude`, `SpawnHeadlessOptions`, `SpawnResult`,
    `ClaudeSpawnArgs`, `assembleClaudeArgs`, `killAllActiveClaudeChildren`, `resolveAuth`, `ResolveAuthOptions`,
    `ResolvedAuth`, `AuthMode`, `AuthMechanism`, `AuthPreflightError`, `probeAuthStatus`, `AuthStatusProbe`,
    `AuthStatusResult`, `applyDeclaredEnv`, `DeclaredEnvInput`, `DeclaredEnvResult`, `buildForwardedEnv`,
    `ForwardEnvOptions`, `formatForwardedEnvLine`, `protectedEnvNames`, `parseStreamJsonTranscript`,
    `ParsedTranscript`, `detectInvocationFromTranscript`.
  - `./yaml`: `updateYamlIn`, `verifyConfinedYamlEdit`, `YamlPath`, `YamlScalarValue`.
  - **Moved to `@vibe-agent-toolkit/resources`**: `resolveAuthenticatedUrl`, `ResolveOutcome`, `LinkAuthConfig`,
    `Provider`, `ProviderAuth`, `ProviderCheck`, `ProviderMatch`, `RewriteRule`, `TokenSource`, `expandMacro`,
    `UnknownMacroError`, `defaultRunCommand`.
- **`@vibe-agent-toolkit/utils/template` and `renderTemplate` are deleted** (library-only). Use Handlebars directly.
- **`@vibe-agent-toolkit/agent-skills`** (library-only):
  - `findDistributedSkillLocationBySource(config, configDir, skillDir)` is removed: build
    `indexPluginLocalSkills(config, configDir)` once and call `.locationOf(skillMdPath)` — the path of
    the skill's `SKILL.md`, not the skill directory the removed function took.
  - `detectHostedIncompatibleShape(pluginPath, locationRoot)` requires `locationRoot`, the base every finding's
    `location` is relative to.
  - `packagedFileEntries(…, hasConventionalSuite)` and `resolveTestInputDirs(…, hasConventionalSuite)` require
    the run's probe: create one with `conventionalSuiteProbe()` and pass it to every call in the run.
