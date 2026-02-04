/**
 * Core types for the resource compiler
 */

/**
 * Represents a parsed markdown resource with frontmatter and fragments
 */
export interface MarkdownResource {
  /** Parsed YAML frontmatter as a key-value object */
  frontmatter: Record<string, unknown>;
  /** Full markdown content (excluding frontmatter) */
  content: string;
  /** Extracted H2 heading fragments */
  fragments: MarkdownFragment[];
}

/**
 * Represents a single H2 heading section in markdown
 */
export interface MarkdownFragment {
  /** Original heading text (e.g., "Purpose Driven") */
  heading: string;
  /** Slugified heading (e.g., "purpose-driven") */
  slug: string;
  /** camelCase property name (e.g., "purposeDriven") */
  camelCase: string;
  /** Heading with markdown prefix (e.g., "## Purpose Driven") */
  header: string;
  /** Content below the heading (excluding the heading itself) */
  body: string;
  /** Full text (header + body) */
  text: string;
}

/**
 * Options for compiling markdown resources
 */
export interface CompileOptions {
  /** Input directory containing markdown files */
  inputDir: string;
  /** Output directory for compiled JavaScript/TypeScript */
  outputDir: string;
  /** Enable watch mode for automatic recompilation */
  watch?: boolean;
  /** Enable verbose logging */
  verbose?: boolean;
  /** File glob pattern (default: "**\/*.md") */
  pattern?: string;
}

/**
 * Result of parsing a single markdown file
 */
export interface ParseResult {
  /** Path to the markdown file */
  filePath: string;
  /** Parsed resource */
  resource: MarkdownResource;
}

/**
 * Result of compiling a single markdown file
 */
export interface CompileResult {
  /** Path to the original markdown file */
  sourcePath: string;
  /** Path to the generated JavaScript file */
  jsPath: string;
  /** Path to the generated TypeScript declaration file */
  dtsPath: string;
  /** Whether compilation succeeded */
  success: boolean;
  /** Error message if compilation failed */
  error?: string;
}
