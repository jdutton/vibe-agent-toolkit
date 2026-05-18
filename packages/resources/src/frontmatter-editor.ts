/**
 * FrontmatterEditor — round-trip-safe primitive for editing YAML frontmatter
 * in markdown files.
 *
 * Public surface: openFrontmatter(markdown) → FrontmatterEditor.
 *
 * Round-trip identity contract: openFrontmatter(x).toString() === x for any
 * well-formed input, byte-for-byte. Mutations preserve comments, blank lines,
 * key ordering, quoting style, and detected EOL.
 *
 * See docs/superpowers/specs/2026-05-17-frontmatter-editor-and-yaml-consolidation-design.md
 * §5 for the full contract.
 */

import { Document, parseDocument } from 'yaml';

export class FrontmatterParseError extends Error {
  public override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'FrontmatterParseError';
    this.cause = cause;
  }
}

/** Path to a value in the parsed frontmatter document. */
export type FrontmatterPath = string | readonly (string | number)[];

/** Scalar value type accepted by mutation methods. */
export type FrontmatterScalar = string | number | boolean | null;

export interface FrontmatterEditor {
  body: string;
  get(path: FrontmatterPath): unknown;
  set(path: FrontmatterPath, value: FrontmatterScalar): void;
  setArrayItem(path: FrontmatterPath, index: number, value: FrontmatterScalar): void;
  appendArrayItem(path: FrontmatterPath, value: FrontmatterScalar): void;
  delete(path: FrontmatterPath): void;
  toString(): string;
}

interface FrontmatterSplit {
  hasFrontmatter: boolean;
  frontmatterText: string;
  body: string;
  eol: '\n' | '\r\n';
}

const OPENING_FENCE = /^---\r?\n/;
// Closing fence: either immediately after opening (empty frontmatter), or
// preceded by a newline. Trailing variants accept newline or EOF.
const EMPTY_CLOSING_FENCE = /^---(?:\r?\n|$)/;
const CLOSING_FENCE = /(?:\r?\n---\r?\n|\r?\n---$)/;

function detectEol(input: string): '\n' | '\r\n' {
  const firstBreak = input.indexOf('\n');
  if (firstBreak === -1) return '\n';
  return firstBreak > 0 && input.charAt(firstBreak - 1) === '\r' ? '\r\n' : '\n';
}

function splitFrontmatter(input: string): FrontmatterSplit {
  const eol = detectEol(input);
  const openingMatch = OPENING_FENCE.exec(input);
  if (!openingMatch) {
    return { hasFrontmatter: false, frontmatterText: '', body: input, eol };
  }
  const afterOpening = input.slice(openingMatch[0].length);
  // Handle empty frontmatter (closing fence immediately follows opening fence)
  const emptyMatch = EMPTY_CLOSING_FENCE.exec(afterOpening);
  if (emptyMatch) {
    const bodyStart = emptyMatch[0].length;
    return {
      hasFrontmatter: true,
      frontmatterText: '',
      body: afterOpening.slice(bodyStart),
      eol,
    };
  }
  const closingMatch = CLOSING_FENCE.exec(afterOpening);
  if (!closingMatch) {
    return { hasFrontmatter: false, frontmatterText: '', body: input, eol };
  }
  const frontmatterText = afterOpening.slice(0, closingMatch.index);
  const bodyStart = closingMatch.index + closingMatch[0].length;
  const body = afterOpening.slice(bodyStart);
  return { hasFrontmatter: true, frontmatterText, body, eol };
}

class FrontmatterEditorImpl implements FrontmatterEditor {
  private readonly doc: Document.Parsed | Document;
  private readonly hasFrontmatter: boolean;
  private readonly eol: '\n' | '\r\n';
  public body: string;

  constructor(input: string) {
    const split = splitFrontmatter(input);
    this.hasFrontmatter = split.hasFrontmatter;
    this.eol = split.eol;
    this.body = split.body;
    if (!split.hasFrontmatter) {
      this.doc = new Document({});
      return;
    }
    try {
      this.doc = parseDocument(split.frontmatterText, { prettyErrors: true });
      if (this.doc.errors.length > 0) {
        throw new FrontmatterParseError(
          `Invalid YAML frontmatter: ${this.doc.errors[0]?.message ?? 'unknown error'}`,
          this.doc.errors[0],
        );
      }
    } catch (error) {
      if (error instanceof FrontmatterParseError) throw error;
      throw new FrontmatterParseError(
        `Failed to parse frontmatter: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  private toPath(path: FrontmatterPath): readonly (string | number)[] {
    if (Array.isArray(path)) return path;
    if (typeof path === 'string') return [path];
    return path as readonly (string | number)[];
  }

  get(path: FrontmatterPath): unknown {
    const segments = this.toPath(path);
    if (segments.length === 0) return this.doc.toJS();
    return this.doc.getIn(segments as Iterable<unknown>, false);
  }

  set(path: FrontmatterPath, value: FrontmatterScalar): void {
    const segments = this.toPath(path);
    this.doc.setIn(segments as Iterable<unknown>, value);
  }

  setArrayItem(path: FrontmatterPath, index: number, value: FrontmatterScalar): void {
    const segments = [...this.toPath(path), index];
    this.doc.setIn(segments as Iterable<unknown>, value);
  }

  appendArrayItem(path: FrontmatterPath, value: FrontmatterScalar): void {
    const segments = this.toPath(path);
    this.doc.addIn(segments as Iterable<unknown>, value);
  }

  delete(path: FrontmatterPath): void {
    const segments = this.toPath(path);
    this.doc.deleteIn(segments as Iterable<unknown>);
  }

  toString(): string {
    // No frontmatter originally, and nothing was added → return body unchanged.
    if (!this.hasFrontmatter && this.isDocEffectivelyEmpty()) {
      return this.body;
    }
    // Empty frontmatter (e.g. `---\n---\n`) where the doc remained empty —
    // preserve the empty fence block without injecting `null` or `{}` between.
    if (this.hasFrontmatter && this.isDocEffectivelyEmpty()) {
      return `---${this.eol}---${this.eol}${this.body}`;
    }
    const fmText = this.doc.toString();
    const normalized = this.eol === '\r\n' ? fmText.replaceAll('\n', '\r\n') : fmText;
    return `---${this.eol}${normalized}---${this.eol}${this.body}`;
  }

  private isDocEffectivelyEmpty(): boolean {
    const contents = this.doc.contents;
    if (contents === null) return true;
    // yaml.YAMLMap and YAMLSeq expose `items`; an empty map/seq counts as empty.
    const maybeItems = (contents as { items?: unknown[] }).items;
    if (Array.isArray(maybeItems) && maybeItems.length === 0) return true;
    return false;
  }
}

export function openFrontmatter(markdown: string): FrontmatterEditor {
  return new FrontmatterEditorImpl(markdown);
}
