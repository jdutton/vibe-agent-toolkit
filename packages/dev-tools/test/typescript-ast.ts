/**
 * TypeScript AST helpers for the import-boundary structure tests, which hold a
 * rule over what a `src` file loads at runtime.
 */

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import ts from 'typescript';

import { packageSources } from './package-sources.js';

/** Packages that ship nothing to a user, so no import boundary holds over them. */
const PRIVATE_PACKAGES = ['packages/dev-tools/', 'packages/lab/'] as const;

/** The shipping packages' sources, and the files among them where `detect` found something. */
interface ShippingImporters {
  /** Every shipping package source file, repo-relative, with its text. */
  readonly files: ReadonlyMap<string, string>;
  /** Each file `detect` reported a non-empty list for, with that list. */
  readonly importers: ReadonlyMap<string, string[]>;
}

/**
 * Run `detect` over every shipping package's source (the private packages
 * excluded) and keep the files it found something in.
 *
 * @param detect - What one file's text imports that the boundary guards
 * @returns The shipping sources and their importers
 */
export function shippingImporters(detect: (body: string) => string[]): ShippingImporters {
  const files = new Map(
    [...packageSources()].filter(([file]) => !PRIVATE_PACKAGES.some((prefix) => toForwardSlash(file).startsWith(prefix))),
  );
  const importers = new Map(
    [...files].map(([file, body]) => [file, detect(body)] as [string, string[]]).filter(([, found]) => found.length > 0),
  );
  return { files, importers };
}

/** Each text's AST, once parsed — see {@link sourceOf}. */
const parsed = new Map<string, ts.SourceFile>();

/**
 * `body` as a TypeScript AST. Comments are trivia, so a JSDoc example is never an import.
 *
 * Parsed once per text per test file: several structure tests scan every
 * shipping source, and the parse is the bulk of each scan's cost.
 */
export function sourceOf(body: string): ts.SourceFile {
  let source = parsed.get(body);
  if (source === undefined) {
    source = ts.createSourceFile('module.ts', body, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    parsed.set(body, source);
  }
  return source;
}

/** Every node of `source`, depth first. */
export function nodesOf(source: ts.SourceFile): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return nodes;
}

/** Whether an import clause loads nothing at runtime: `import type`, or `{ type A, type B }`. */
export function importIsTypeOnly(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return false;
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) return true;
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}
