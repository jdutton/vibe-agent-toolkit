/* eslint-disable security/detect-non-literal-fs-filename -- Test helper using temp directories */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Set up a nested directory structure for testing copyDirectory
 */
export async function setupNestedDirectory(
  tempDir: string,
  subdir: string,
  nestedFile: string,
  nestedContent: string
): Promise<{ srcDir: string; destDir: string }> {
  const srcDir = path.join(tempDir, 'src');
  const destDir = path.join(tempDir, 'dest');
  await fs.mkdir(path.join(srcDir, subdir), { recursive: true });
  await fs.writeFile(path.join(srcDir, subdir, nestedFile), nestedContent);
  return { srcDir, destDir };
}
