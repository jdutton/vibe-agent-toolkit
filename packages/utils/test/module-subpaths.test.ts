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
   */
  it('./git ships exactly one root finder, and the barrel agrees', async () => {
    const mod = await import('../src/git.js');
    expect('findGitRoot' in mod).toBe(false);
    expect('gitFindRoot' in mod).toBe(true);

    const barrel: Record<string, unknown> = await import('../src/index.js');
    expect('findGitRoot' in barrel).toBe(false);
    expect(typeof barrel['gitFindRoot']).toBe('function');
  });

  it('./crawl exposes directory crawling and the crawl-exclusion globs', async () => {
    const mod = await import('../src/crawl.js');
    expect(typeof mod.crawlDirectory).toBe('function');
    expect(typeof mod.crawlDirectorySync).toBe('function');
    expect(Array.isArray(mod.NEVER_CRAWL_GLOBS)).toBe(true);
    expect(Array.isArray(mod.BUILD_OUTPUT_GLOBS)).toBe(true);
  });

  // No `./project` entry: it was removed after its four exports scored zero
  // replaceable call sites on the package's primary consumer (see
  // `package-exports.test.ts` for the measurement). `project-utils` is still
  // built and still reachable from the `.` barrel for VAT's own internals — the
  // published SUBPATH is what went away, not the code.
  it('project-root discovery stays on the `.` barrel', async () => {
    const barrel: Record<string, unknown> = await import('../src/index.js');
    expect(typeof barrel['findProjectRoot']).toBe('function');
    expect(typeof barrel['findConfigFile']).toBe('function');
    expect(typeof barrel['findNodeWorkspaceRoot']).toBe('function');
    expect(typeof barrel['resetProjectRootCaches']).toBe('function');
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

  it('./template exposes Handlebars rendering', async () => {
    const mod = await import('../src/template-entry.js');
    expect(typeof mod.renderTemplate).toBe('function');
  });

  it('./yaml exposes the surgical YAML updater', async () => {
    const mod = await import('../src/yaml.js');
    expect(typeof mod.updateYamlIn).toBe('function');
  });

  it('./testing exposes the temp-dir suite helpers', async () => {
    const mod = await import('../src/testing.js');
    expect(typeof mod.getTestOutputDir).toBe('function');
    expect(typeof mod.setupAsyncTempDirSuite).toBe('function');
    expect(typeof mod.setupSyncTempDirSuite).toBe('function');
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
