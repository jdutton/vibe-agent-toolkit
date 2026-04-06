/**
 * ESLint rule to disallow function declarations inside test blocks
 *
 * Catches the SonarQube code smell: "Move function to the outer scope" (S1515)
 * Functions defined inside describe/it/test blocks should be moved to module scope
 * for better reusability and to prevent the code smell.
 *
 * Why: Helper functions inside test blocks are harder to:
 * - Reuse across test files
 * - Test independently
 * - Understand (hidden inside blocks)
 * - Maintain (scattered throughout test suites)
 *
 * @example
 * // BAD - Function inside describe block
 * describe('validate command', () => {
 *   function setupWorkingDirectoryMocks(configDir, treeHash) {
 *     // ... setup code
 *   }
 *
 *   it('should work', () => {
 *     setupWorkingDirectoryMocks('/path', 'abc123');
 *   });
 * });
 *
 * // GOOD - Function at module scope
 * function setupWorkingDirectoryMocks(configDir, treeHash) {
 *   // ... setup code
 * }
 *
 * describe('validate command', () => {
 *   it('should work', () => {
 *     setupWorkingDirectoryMocks('/path', 'abc123');
 *   });
 * });
 */

const TEST_BLOCK_PATTERN = /^(describe|it|test|before|after|beforeEach|afterEach|beforeAll|afterAll)$/i;

/**
 * Check if a node is a test-related call expression
 * (describe, it, test, beforeEach, afterEach, beforeAll, afterAll, etc.)
 */
function isTestBlock(node) {
  if (node.type !== 'CallExpression') {
    return false;
  }

  const callee = node.callee;

  // Direct calls: describe(), it(), test(), etc.
  if (callee.type === 'Identifier') {
    return TEST_BLOCK_PATTERN.test(callee.name);
  }

  // Member calls: test.describe(), test.it(), etc. (Playwright)
  if (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier'
  ) {
    return TEST_BLOCK_PATTERN.test(callee.property.name);
  }

  return false;
}

module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow function declarations inside test blocks (SonarQube S1515)',
      category: 'Best Practices',
      recommended: true,
    },
    messages: {
      moveToModuleScope:
        'Move function \'{{name}}\' to module scope (outside describe/it/test blocks). ' +
        'Helper functions inside test blocks are harder to reuse and maintain. ' +
        'This matches SonarQube rule S1515 (Intentionality/Maintainability).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowedFunctionNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'Function names that are allowed inside test blocks',
          },
        },
        additionalProperties: false,
      },
    ],
  },

  create(context) {
    let testBlockDepth = 0;
    const allowedNames = new Set(
      context.options[0]?.allowedFunctionNames || []
    );

    return {
      CallExpression(node) {
        if (isTestBlock(node)) {
          testBlockDepth++;
        }
      },

      'CallExpression:exit'(node) {
        if (isTestBlock(node)) {
          testBlockDepth--;
        }
      },

      FunctionDeclaration(node) {
        if (testBlockDepth > 0) {
          const functionName = node.id?.name || '<anonymous>';

          if (allowedNames.has(functionName)) {
            return;
          }

          context.report({
            node,
            messageId: 'moveToModuleScope',
            data: {
              name: functionName,
            },
          });
        }
      },
    };
  },
};
