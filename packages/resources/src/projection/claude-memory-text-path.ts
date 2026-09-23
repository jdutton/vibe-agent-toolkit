/**
 * The harness's text-file test for a memory file (`q7e`, over `Syn`), in a module
 * of its own because two readers share it: the launch walk, and the independent
 * loader reference in `test/helpers/claude-loader-reference.ts`.
 *
 * @vendor-claim reviewed=2026-09-23 verify=Re-extract `q7e` and `Syn` from the current Claude Code binary per docs/external/claude-code-memory-loader.md and diff them against this file
 */

/**
 * `Syn` — the only extensions the harness reads as a memory file. A file with
 * NO extension is read; any other is skipped with its imports. Transcribed
 * verbatim, `.R` included (the harness lowercases first, so it never matches).
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md', '.txt', '.text', '.json', '.yaml', '.yml', '.toml', '.xml', '.csv', '.html', '.htm', '.css',
  '.scss', '.sass', '.less', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.py', '.pyi',
  '.pyw', '.rb', '.erb', '.rake', '.go', '.rs', '.java', '.kt', '.kts', '.scala', '.c', '.cpp', '.cc',
  '.cxx', '.h', '.hpp', '.hxx', '.cs', '.swift', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.env', '.ini', '.cfg', '.conf', '.config', '.properties', '.sql', '.graphql', '.gql', '.proto', '.vue',
  '.svelte', '.astro', '.ejs', '.hbs', '.pug', '.jade', '.php', '.pl', '.pm', '.lua', '.r', '.R', '.dart',
  '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.cljc', '.edn', '.hs', '.lhs', '.elm', '.ml', '.mli',
  '.f', '.f90', '.f95', '.for', '.cmake', '.make', '.makefile', '.gradle', '.sbt', '.rst', '.adoc',
  '.asciidoc', '.org', '.tex', '.latex', '.lock', '.log', '.diff', '.patch',
]);

/**
 * `q7e`'s first test: does the harness read this path as a memory file at all?
 * Its extension — `path.extname` of the last segment, lowercased, where a
 * leading dot names a file rather than starting an extension — must be empty
 * or one of {@link TEXT_EXTENSIONS}.
 *
 * The ONE transcription of that vendor list: the launch walk
 * (`claude-context-walk.ts`) and the loader reference its differential compares
 * against both ask it, rather than keeping a second copy of 117 extensions two
 * readers could drift apart on.
 *
 * @param path - A root-relative path
 * @returns True when the harness would read it
 */
export function isMemoryTextPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const extension = dot <= 0 ? '' : base.slice(dot).toLowerCase();
  return extension === '' || TEXT_EXTENSIONS.has(extension);
}
