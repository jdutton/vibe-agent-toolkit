/**
 * Common test setup for RAG system tests
 *
 * This file consolidates imports and setup logic shared across RAG test files
 * to eliminate duplication while maintaining clarity.
 */

import { afterAll, beforeAll, it } from 'vitest';

import {
  describe,
  executeCliAndParseYaml,
  expect,
  fs,
  getBinPath,
} from './test-common.js';
import { executeRagCommandInEmptyProject, setupIndexedRagTest } from './test-helpers.js';

// Re-export everything for convenience
export {
  afterAll,
  beforeAll,
  describe,
  executeCliAndParseYaml,
  executeRagCommandInEmptyProject,
  expect,
  fs,
  getBinPath,
  it,
  setupIndexedRagTest,
};
