import { describe, expect, it } from 'vitest';

interface EslintPlugin {
  rules: Record<string, { create?: unknown } | undefined>;
  configs: { recommended: { rules: Record<string, string> } };
}

describe('whole-module subpath entries', () => {
  it('./git exposes git root discovery, ls-files, ignore checking, and URL parsing', async () => {
    const mod = await import('../src/git.js');
    expect(typeof mod.gitFindRoot).toBe('function');
    expect(typeof mod.gitLsFiles).toBe('function');
    expect(typeof mod.isGitIgnored).toBe('function');
    expect(typeof mod.loadGitignoreRules).toBe('function');
    expect(typeof mod.GitTracker).toBe('function');
    expect(typeof mod.parseGitUrl).toBe('function');
    expect(typeof mod.isGitUrl).toBe('function');
    expect(typeof mod.nonInteractiveGitOverrides).toBe('function');
  });

  /**
   * `runGit` is reachable from exactly one published entry, and this is it.
   *
   * The chokepoint is what makes "git runs with a scrubbed environment" a
   * property of the package rather than of each caller: `safeExecSync` and
   * `safeExecResult` refuse the `git` binary and point here. A second route —
   * `runGit` reappearing on the `.` barrel, or a caller reaching
   * `git-run.js` some other way — would give the ambient environment a door,
   * and nothing else in the suite would notice.
   */
  it('./git is the only published route to runGit', async () => {
    const mod = await import('../src/git.js');
    expect(typeof mod.runGit).toBe('function');
    expect(typeof mod.runGitOrThrow).toBe('function');

    const barrel: Record<string, unknown> = await import('../src/index.js');
    expect('runGit' in barrel).toBe(false);
    expect('runGitOrThrow' in barrel).toBe(false);
  });

  /**
   * ONE root finder, everywhere — not one per entry.
   *
   * `findGitRoot` was a body-for-body alias: `export function findGitRoot(startDir)
   * { return gitFindRoot(startDir); }`. Keeping it off `./git` fixed the symptom
   * (adopters of the narrow entry could only find one name) while leaving the cause
   * in place: the `.` barrel — the entry with the most consumers — still offered
   * both, so the coin-flip just moved. Its own hiding place was the tell, too:
   * `findGitRoot` was one of the 22 symbols reachable ONLY from the wide barrel,
   * which is precisely the shape "import the one you need" is supposed to rule out.
   *
   * Under the pre-1.0 policy (CLAUDE.md: "DO NOT maintain old APIs alongside new
   * ones", "DO remove old code completely"), the alias is deleted rather than
   * relocated. No production code in this repo ever called it.
   *
   * The barrel now offers NEITHER name — git is a domain and reaches consumers
   * through `./git` alone — so the coin flip cannot be reinstated from that side
   * either.
   */
  it('./git ships exactly one root finder, and the barrel offers none', async () => {
    const mod = await import('../src/git.js');
    expect('findGitRoot' in mod).toBe(false);
    expect('gitFindRoot' in mod).toBe(true);

    const barrel: Record<string, unknown> = await import('../src/index.js');
    expect('findGitRoot' in barrel).toBe(false);
    expect('gitFindRoot' in barrel).toBe(false);
  });

  it('./crawl exposes directory crawling and the crawl-exclusion globs', async () => {
    const mod = await import('../src/crawl.js');
    expect(typeof mod.crawlDirectory).toBe('function');
    expect(typeof mod.crawlDirectorySync).toBe('function');
    expect(Array.isArray(mod.NEVER_CRAWL_GLOBS)).toBe(true);
    expect(Array.isArray(mod.BUILD_OUTPUT_GLOBS)).toBe(true);
  });

  /**
   * `./project` exists so these four are reachable WITHOUT the barrel.
   *
   * They were briefly barrel-only, which made a capability whose own code imports
   * nothing but `node:fs` and `node:path` cost five third-party packages to reach.
   * Both routes are asserted: the subpath, because that is the point, and the
   * barrel, because removing them from it would be a separate breaking change.
   */
  it('./project exposes project-root discovery, and the barrel still agrees', async () => {
    const mod = await import('../src/project.js');
    expect(typeof mod.findProjectRoot).toBe('function');
    expect(typeof mod.findConfigFile).toBe('function');
    expect(typeof mod.findNodeWorkspaceRoot).toBe('function');
    expect(typeof mod.resetProjectRootCaches).toBe('function');

    const barrel: Record<string, unknown> = await import('../src/index.js');
    expect(typeof barrel['findProjectRoot']).toBe('function');
    expect(typeof barrel['findConfigFile']).toBe('function');
    expect(typeof barrel['findNodeWorkspaceRoot']).toBe('function');
    expect(typeof barrel['resetProjectRootCaches']).toBe('function');
  });

  /**
   * `./text` exists so the one bytes-to-text seam can be reached without
   * `node:fs` — see `subpath-purity.test.ts` for the assertion that it stays
   * pure. The file-reading half is asserted on `./fs`, deliberately not here.
   */
  it('./text exposes the content-decoding seam, and only the pure half', async () => {
    const mod: Record<string, unknown> = await import('../src/text.js');
    expect(typeof mod['decodeTextContent']).toBe('function');
    expect('readTextContent' in mod).toBe(false);
    expect('readTextContentSync' in mod).toBe(false);
  });

  it('./fs exposes the file-reading half of the same seam', async () => {
    const mod = await import('../src/fs.js');
    expect(typeof mod.readTextContent).toBe('function');
    expect(typeof mod.readTextContentSync).toBe('function');
  });

  it('./glob exposes the glob pattern helpers', async () => {
    const mod = await import('../src/glob.js');
    expect(typeof mod.isGlob).toBe('function');
  });

  it('./zod exposes version-agnostic Zod introspection', async () => {
    const mod = await import('../src/zod.js');
    expect(typeof mod.getZodTypeName).toBe('function');
    expect(mod.ZodTypeNames).toBeDefined();
  });

  it('./yaml exposes the surgical YAML updater', async () => {
    const mod = await import('../src/yaml.js');
    expect(typeof mod.updateYamlIn).toBe('function');
  });

  it('./process exposes the spawn and exec primitives', async () => {
    const mod = await import('../src/process.js');
    expect(typeof mod.safeExecSync).toBe('function');
    expect(typeof mod.safeExecResult).toBe('function');
    expect(typeof mod.spawnHardened).toBe('function');
    expect(typeof mod.makeStdioBlocking).toBe('function');
  });

  /**
   * `./skill-test` carries no dependency of its own; it is a subpath because of
   * what it REACHES — spawning a headless agent goes through `./process`, which
   * costs `which` and `@vibe-validate/git`. Left on the `.` barrel it charged
   * every path-helper importer for both, which is the entire reason the entry
   * exists. `subpath-purity.test.ts` pins that reachability; this pins the
   * surface, so a consumer moved onto the entry cannot silently lose half of it.
   */
  it('./skill-test exposes the headless-agent harness surface', async () => {
    const mod = await import('../src/skill-test/index.js');
    expect(typeof mod.spawnHeadlessClaude).toBe('function');
    expect(typeof mod.assembleClaudeArgs).toBe('function');
    expect(typeof mod.killAllActiveClaudeChildren).toBe('function');
    expect(typeof mod.probeAuthStatus).toBe('function');
    expect(typeof mod.resolveAuth).toBe('function');
    expect(typeof mod.applyDeclaredEnv).toBe('function');
    expect(typeof mod.parseStreamJsonTranscript).toBe('function');
  });

  it('./testing exposes the temp-dir suite helpers', async () => {
    const mod = await import('../src/testing.js');
    expect(typeof mod.getTestOutputDir).toBe('function');
    expect(typeof mod.setupAsyncTempDirSuite).toBe('function');
    expect(typeof mod.setupSyncTempDirSuite).toBe('function');
    // The bounded teardown both suite helpers delegate to. A consumer wiring
    // its own `afterAll` needs it from the same subpath as the helpers.
    expect(typeof mod.removeScratchDir).toBe('function');
    // 🪤 `detachGitEnv` is asserted HERE, not only in its own unit test, because
    // it is reached across a package boundary through this subpath. When
    // `testing.ts` became a definition site as well as a barrel, its
    // `export *` was dropped and this export vanished — reddening a CLI suite
    // 20 tests deep in another package rather than anything in `utils`.
    expect(typeof mod.detachGitEnv).toBe('function');
    // The literal-corpus primitives, which are defined in `testing.ts` itself
    // rather than re-exported. Both halves of a mixed module need a pin, or
    // whichever half is unasserted is the one a later edit deletes.
    expect(typeof mod.createTempCorpus).toBe('function');
    expect(typeof mod.replantableCorpus).toBe('function');
  });

  it('./asset exposes asset reference resolution', async () => {
    const mod = await import('../src/asset.js');
    expect(typeof mod.resolveAssetReference).toBe('function');
  });

  /**
   * `./eslint` is the one subpath not compiled from `src/`, so it is imported here
   * the way an adopter's `eslint.config.js` does — through the exports map, by
   * specifier — rather than by relative source path like every case above. That
   * makes this the only test in the repo that would fail if the `./eslint` key
   * were dropped from the manifest while the files stayed put.
   *
   * Rule-by-rule coverage lives in `test/eslint/`; this asserts the entry exists
   * and has the shape ESLint requires of a plugin.
   */
  it('./eslint exposes the rule pack and its recommended config', async () => {
    const mod: unknown = await import('@vibe-agent-toolkit/utils/eslint');
    const plugin = (mod as { default: EslintPlugin }).default;
    expect(typeof plugin.rules['no-path-join']?.create).toBe('function');
    expect(plugin.configs.recommended.rules['@vibe-agent-toolkit/no-path-join']).toBe('warn');
  });
});
