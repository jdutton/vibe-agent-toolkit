/**
 * AST helper utilities for creating TypeScript nodes
 * Converts MarkdownResource objects to TypeScript AST object literals
 */

import ts from 'typescript';

import type { MarkdownResource, MarkdownFragment } from '../compiler/types.js';

/**
 * Create a string literal node
 *
 * @param value - The string value
 * @returns String literal node
 */
function createStringLiteral(value: string): ts.StringLiteral {
  return ts.factory.createStringLiteral(value);
}

/**
 * Create an object literal property assignment
 *
 * @param name - Property name
 * @param value - Property value expression
 * @returns Property assignment node
 */
function createPropertyAssignment(
  name: string,
  value: ts.Expression,
): ts.PropertyAssignment {
  return ts.factory.createPropertyAssignment(
    ts.factory.createIdentifier(name),
    value,
  );
}

/**
 * Convert a plain object to an AST object literal
 *
 * @param obj - Plain JavaScript object
 * @returns Object literal expression node
 */
function objectToAst(obj: Record<string, unknown>): ts.ObjectLiteralExpression {
  const properties: ts.ObjectLiteralElementLike[] = [];

  for (const [key, value] of Object.entries(obj)) {
    let valueNode: ts.Expression;

    if (typeof value === 'string') {
      valueNode = createStringLiteral(value);
    } else if (typeof value === 'number') {
      valueNode = ts.factory.createNumericLiteral(value);
    } else if (typeof value === 'boolean') {
      valueNode = value ? ts.factory.createTrue() : ts.factory.createFalse();
    } else if (value === null) {
      valueNode = ts.factory.createNull();
    } else if (Array.isArray(value)) {
      valueNode = arrayToAst(value);
    } else if (typeof value === 'object') {
      valueNode = objectToAst(value as Record<string, unknown>);
    } else {
      // Fallback for undefined or other types
      valueNode = ts.factory.createIdentifier('undefined');
    }

    properties.push(createPropertyAssignment(key, valueNode));
  }

  return ts.factory.createObjectLiteralExpression(properties, true);
}

/**
 * Convert an array to an AST array literal
 *
 * @param arr - Array of values
 * @returns Array literal expression node
 */
function arrayToAst(arr: unknown[]): ts.ArrayLiteralExpression {
  const elements: ts.Expression[] = [];

  for (const item of arr) {
    if (typeof item === 'string') {
      elements.push(createStringLiteral(item));
    } else if (typeof item === 'number') {
      elements.push(ts.factory.createNumericLiteral(item));
    } else if (typeof item === 'boolean') {
      elements.push(item ? ts.factory.createTrue() : ts.factory.createFalse());
    } else if (item === null) {
      elements.push(ts.factory.createNull());
    } else if (Array.isArray(item)) {
      elements.push(arrayToAst(item));
    } else if (typeof item === 'object') {
      elements.push(objectToAst(item as Record<string, unknown>));
    } else {
      elements.push(ts.factory.createIdentifier('undefined'));
    }
  }

  return ts.factory.createArrayLiteralExpression(elements, false);
}

/**
 * Convert a MarkdownFragment to an AST object literal
 *
 * @param fragment - The markdown fragment
 * @returns Object literal expression node
 */
function fragmentToAst(fragment: MarkdownFragment): ts.ObjectLiteralExpression {
  return ts.factory.createObjectLiteralExpression(
    [
      createPropertyAssignment('heading', createStringLiteral(fragment.heading)),
      createPropertyAssignment('slug', createStringLiteral(fragment.slug)),
      createPropertyAssignment('camelCase', createStringLiteral(fragment.camelCase)),
      createPropertyAssignment('header', createStringLiteral(fragment.header)),
      createPropertyAssignment('body', createStringLiteral(fragment.body)),
      createPropertyAssignment('text', createStringLiteral(fragment.text)),
    ],
    true,
  );
}

/**
 * Convert a MarkdownResource to an AST object literal
 *
 * @param resource - The parsed markdown resource
 * @returns Object literal expression representing the resource
 *
 * @example
 * ```typescript
 * const resource = { frontmatter: { title: 'Test' }, content: '...', fragments: [...] };
 * const ast = resourceToAst(resource);
 * // Generates: { frontmatter: { title: 'Test' }, content: '...', fragments: [...] }
 * ```
 */
export function resourceToAst(resource: MarkdownResource): ts.ObjectLiteralExpression {
  // Convert frontmatter
  const frontmatterAst = objectToAst(resource.frontmatter);

  // Build fragments object with camelCase property access
  const fragmentsObject = ts.factory.createObjectLiteralExpression(
    resource.fragments.map((fragment) =>
      createPropertyAssignment(fragment.camelCase, fragmentToAst(fragment)),
    ),
    true,
  );

  // Create main object with meta, text, and fragments
  return ts.factory.createObjectLiteralExpression(
    [
      createPropertyAssignment('meta', frontmatterAst),
      createPropertyAssignment('text', createStringLiteral(resource.content)),
      createPropertyAssignment('fragments', fragmentsObject),
    ],
    true,
  );
}

/**
 * Create a const variable declaration statement
 *
 * @param name - Variable name
 * @param initializer - Expression to assign
 * @returns Variable statement node
 *
 * @example
 * ```typescript
 * const node = createConstDeclaration('Core', objectExpression);
 * // Generates: const Core = { ... };
 * ```
 */
export function createConstDeclaration(
  name: string,
  initializer: ts.Expression,
): ts.VariableStatement {
  return ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [
        ts.factory.createVariableDeclaration(
          ts.factory.createIdentifier(name),
          undefined,
          undefined,
          initializer,
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
}
