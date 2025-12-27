/**
 * Custom ESLint rules for ts-monorepo-template
 *
 * Security and Cross-Platform Compatibility Rules:
 * - no-child-process-execSync: Enforce safeExecSync() instead of execSync() (security + cross-platform)
 *
 * ## Why Custom Rules?
 *
 * When working with agentic code (Claude, Cursor, etc.), AI can easily reintroduce unsafe patterns.
 * Custom ESLint rules provide automatic guardrails that catch these issues during development.
 *
 * ## Adding New Rules
 *
 * When you identify a dangerous pattern that should be prevented:
 * 1. Create a new rule file in this directory using eslint-rule-factory.cjs
 * 2. Add it to the exports below
 * 3. Configure it in the root eslint.config.js
 *
 * Example:
 * ```js
 * // no-fs-unlinkSync.cjs
 * const factory = require('./eslint-rule-factory.cjs');
 * module.exports = factory({
 *   unsafeFn: 'unlinkSync',
 *   unsafeModule: 'node:fs',
 *   safeFn: 'safeUnlinkSync',
 *   safeModule: './common.js',
 *   message: 'Use safeUnlinkSync() for better error handling',
 * });
 * ```
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export default {
  rules: {
    'no-child-process-execSync': require('./no-child-process-execSync.cjs'),
  },
};
