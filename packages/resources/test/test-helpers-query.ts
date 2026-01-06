import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ResourceRegistry } from '../src/resource-registry.js';
import type { ResourceMetadata } from '../src/schemas/resource-metadata.js';

/**
 * Create a test file and add it to the registry.
 *
 * Automatically creates parent directories if needed.
 *
 * @param tempDir - Temporary directory path
 * @param filename - Filename to create (can include subdirectories like 'docs/README.md')
 * @param content - File content
 * @param registry - ResourceRegistry to add the file to
 * @returns The created resource metadata
 */
export async function createAndAddResource(
  tempDir: string,
  filename: string,
  content: string,
  registry: ResourceRegistry
): Promise<ResourceMetadata> {
  const filePath = join(tempDir, filename);
  const dir = dirname(filePath);

  // Create parent directories if they don't exist
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await fs.mkdir(dir, { recursive: true });

  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await fs.writeFile(filePath, content, 'utf-8');
  return await registry.addResource(filePath);
}

/**
 * Create two test files and add them to the registry.
 *
 * @param tempDir - Temporary directory path
 * @param file1Name - First filename
 * @param file1Content - First file content
 * @param file2Name - Second filename
 * @param file2Content - Second file content
 * @param registry - ResourceRegistry to add the files to
 * @returns Tuple of the two created resource metadata objects
 */
export async function createAndAddTwoResources(
  tempDir: string,
  file1Name: string,
  file1Content: string,
  file2Name: string,
  file2Content: string,
  registry: ResourceRegistry
): Promise<[ResourceMetadata, ResourceMetadata]> {
  const resource1 = await createAndAddResource(tempDir, file1Name, file1Content, registry);
  const resource2 = await createAndAddResource(tempDir, file2Name, file2Content, registry);
  return [resource1, resource2];
}

/**
 * Create three test files and add them to the registry.
 *
 * @param tempDir - Temporary directory path
 * @param file1Name - First filename
 * @param file1Content - First file content
 * @param file2Name - Second filename
 * @param file2Content - Second file content
 * @param file3Name - Third filename
 * @param file3Content - Third file content
 * @param registry - ResourceRegistry to add the files to
 * @returns Tuple of the three created resource metadata objects
 */
export async function createAndAddThreeResources(
  tempDir: string,
  file1Name: string,
  file1Content: string,
  file2Name: string,
  file2Content: string,
  file3Name: string,
  file3Content: string,
  registry: ResourceRegistry
): Promise<[ResourceMetadata, ResourceMetadata, ResourceMetadata]> {
  const resource1 = await createAndAddResource(tempDir, file1Name, file1Content, registry);
  const resource2 = await createAndAddResource(tempDir, file2Name, file2Content, registry);
  const resource3 = await createAndAddResource(tempDir, file3Name, file3Content, registry);
  return [resource1, resource2, resource3];
}

/**
 * Create two resources where the first has a link to the second.
 *
 * Common test pattern: first file has link, second file has no links.
 *
 * @param tempDir - Temporary directory path
 * @param registry - ResourceRegistry to add the files to
 * @returns Tuple of the two created resource metadata objects
 */
export async function createTwoResourcesWithLink(
  tempDir: string,
  registry: ResourceRegistry
): Promise<[ResourceMetadata, ResourceMetadata]> {
  return await createAndAddTwoResources(
    tempDir,
    'file1.md',
    '# File 1\n\n[Link](./file2.md)',
    'file2.md',
    '# File 2',
    registry
  );
}
