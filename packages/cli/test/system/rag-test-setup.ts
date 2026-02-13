/**
 * Common test setup for RAG system tests
 *
 * This file consolidates imports and setup logic shared across RAG test files
 * to eliminate duplication while maintaining clarity.
 */






// Re-export everything for convenience

export {getTestOutputDir} from '@vibe-agent-toolkit/utils';
export {afterAll, beforeAll, it} from 'vitest';
export {describe, executeCliAndParseYaml, expect, fs, getBinPath} from './test-common.js';
export {executeRagCommandInEmptyProject, executeRagQueryAndExpectSuccess, setupIndexedRagTest, setupRagTestSuite} from './test-helpers/index.js';