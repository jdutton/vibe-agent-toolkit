/**
 * Test helpers for system tests
 *
 * Barrel re-export from focused modules.
 * All test files import from './test-helpers/index.js'.
 */

export {
  assertValidationFailureWithErrorInStderr,
  executeAndParseYaml,
  executeCli,
  executeCliAndParseYaml,
  executeCommandAndParse,
  executeScanAndParse,
  executeValidateAndParse,
  parseYamlOutput,
  testConfigError,
} from './cli-runner.js';
export type { CliResult } from './cli-runner.js';

export {
  createTempProject,
  createTestTempDir,
  setupTestProject,
} from './project-setup.js';
export type { TestProjectOptions } from './project-setup.js';

export {
  executeRagCommandInEmptyProject,
  executeRagQueryAndExpectSuccess,
  setupIndexedRagTest,
  setupRagTestProject,
  setupRagTestSuite,
} from './rag-setup.js';

export {
  createInstalledSkillDir,
  executeSkillsCommandAndExpectYaml,
  setupDevTestProject,
  setupInstallTestSuite,
} from './skills-setup.js';

export {
  createMarkdownWithFrontmatter,
  createSchemaFile,
  executeResourcesValidateWithSchema,
  setupSchemaAndValidate,
} from './frontmatter-setup.js';

export { MCPTestClient } from './mcp-client.js';
