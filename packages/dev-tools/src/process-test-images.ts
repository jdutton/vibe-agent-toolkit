#!/usr/bin/env bun
/**
 * Image Processing Script for Cat Agent Test Fixtures
 *
 * This script processes cat photos for use as test fixtures:
 * - Resizes images to git-friendly dimensions (~512px wide)
 * - Compresses to target file size (~50-100KB)
 * - Writes structured test data to EXIF Description field
 * - Supports JPG, PNG, WebP formats
 *
 * Usage:
 *   bun scripts/process-test-images.ts <input-dir> <output-dir>
 *
 * Example:
 *   bun scripts/process-test-images.ts ~/Downloads/cat-photos test/fixtures/photos/cats
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// This utility script needs to process user-provided image paths

import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import sharp from 'sharp';
import { z } from 'zod';

/**
 * Schema for test fixture metadata stored in EXIF
 */
export const TestFixtureMetadataSchema = z.object({
  furColor: z.string().describe('Primary fur color (e.g., "Orange", "Black", "Calico")'),
  furPattern: z.string().optional().describe('Fur pattern (e.g., "Tabby", "Solid", "Patched")'),
  eyeColor: z.string().optional().describe('Eye color (e.g., "Green", "Blue", "Yellow")'),
  breed: z.string().optional().describe('Breed name (e.g., "Persian", "Maine Coon")'),
  size: z.enum(['tiny', 'small', 'medium', 'large']).describe('Size category'),
  personality: z.array(z.string()).optional().describe('Personality traits'),
  quirks: z.array(z.string()).optional().describe('Unique quirks or features'),
  notes: z.string().optional().describe('Additional notes for test expectations'),
  expectedCategory: z
    .enum(['cat', 'not-cat', 'cat-like'])
    .default('cat')
    .describe('Expected classification category'),
});

export type TestFixtureMetadata = z.infer<typeof TestFixtureMetadataSchema>;

/**
 * Configuration for image processing
 */
export interface ProcessingConfig {
  /** Target width in pixels (maintains aspect ratio) */
  targetWidth: number;
  /** JPEG quality (1-100) */
  jpegQuality: number;
  /** PNG compression level (0-9) */
  pngCompression: number;
  /** WebP quality (1-100) */
  webpQuality: number;
  /** Target max file size in KB (warning if exceeded) */
  targetMaxSizeKB: number;
}

const DEFAULT_CONFIG: ProcessingConfig = {
  targetWidth: 512,
  jpegQuality: 82,
  pngCompression: 6,
  webpQuality: 80,
  targetMaxSizeKB: 100,
};

/**
 * Supported image formats
 */
const SUPPORTED_FORMATS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/**
 * Process a single image file
 */
async function processImage(
  inputPath: string,
  outputPath: string,
  metadata: TestFixtureMetadata,
  config: ProcessingConfig = DEFAULT_CONFIG,
): Promise<void> {
  const ext = extname(inputPath).toLowerCase();

  if (!SUPPORTED_FORMATS.has(ext)) {
    throw new Error(`Unsupported format: ${ext}. Supported: ${[...SUPPORTED_FORMATS].join(', ')}`);
  }

  // Read and resize image
  let pipeline = sharp(inputPath).resize(config.targetWidth, undefined, {
    fit: 'inside',
    withoutEnlargement: true,
  });

  // Prepare EXIF metadata
  const exifDescription = JSON.stringify(metadata, null, 2);
  const exifData = {
    IFD0: {
      ImageDescription: exifDescription,
      Copyright: 'Unsplash (Free License)',
    },
  };

  // Apply format-specific settings
  if (ext === '.jpg' || ext === '.jpeg') {
    pipeline = pipeline.jpeg({
      quality: config.jpegQuality,
      progressive: true,
      mozjpeg: true,
    });
  } else if (ext === '.png') {
    pipeline = pipeline.png({
      compressionLevel: config.pngCompression,
      progressive: true,
    });
  } else if (ext === '.webp') {
    pipeline = pipeline.webp({
      quality: config.webpQuality,
    });
  }

  // Add EXIF metadata
  pipeline = pipeline.withMetadata({
    exif: exifData,
  });

  // Write output
  await pipeline.toFile(outputPath);

  // Check file size
  const stats = await stat(outputPath);
  const sizeKB = Math.round(stats.size / 1024);

  if (sizeKB > config.targetMaxSizeKB) {
    console.warn(`⚠️  ${basename(outputPath)}: ${sizeKB}KB (exceeds target ${config.targetMaxSizeKB}KB)`);
  } else {
    console.log(`✓ ${basename(outputPath)}: ${sizeKB}KB`);
  }
}

/**
 * Interactive metadata prompt (simple version - can be enhanced)
 */
async function promptForMetadata(filename: string): Promise<TestFixtureMetadata> {
  console.log(`\n📸 Processing: ${filename}`);
  console.log('Please provide metadata (press Enter to use defaults shown in brackets):');

  // For now, use intelligent defaults based on filename
  // In a real implementation, you'd use readline to prompt interactively
  const lower = filename.toLowerCase();

  const metadata: TestFixtureMetadata = {
    furColor: extractFromFilename(lower, ['orange', 'black', 'white', 'gray', 'calico'], 'Orange') ?? 'Orange',
    furPattern: extractFromFilename(lower, ['tabby', 'solid', 'patched', 'striped'], 'Tabby'),
    eyeColor: extractFromFilename(lower, ['green', 'blue', 'yellow', 'amber'], 'Green'),
    breed: extractFromFilename(lower, ['persian', 'maine coon', 'siamese', 'domestic shorthair']),
    size: (extractFromFilename(lower, ['tiny', 'small', 'large'], 'medium') ?? 'medium') as 'tiny' | 'small' | 'medium' | 'large',
    personality: extractPersonality(lower),
    quirks: extractQuirks(lower),
    expectedCategory: lower.includes('dog') || lower.includes('not-cat') || lower.includes('robot') || lower.includes('bear') ? 'not-cat' : 'cat',
  };

  console.log('Generated metadata:', JSON.stringify(metadata, null, 2));
  return metadata;
}

/**
 * Extract value from filename based on keywords
 */
function extractFromFilename(
  filename: string,
  keywords: string[],
  defaultValue?: string,
): string | undefined {
  for (const keyword of keywords) {
    if (filename.includes(keyword)) {
      return keyword.charAt(0).toUpperCase() + keyword.slice(1);
    }
  }
  return defaultValue;
}

/**
 * Extract personality traits from filename
 */
function extractPersonality(filename: string): string[] {
  const traits: string[] = [];
  const keywords = ['playful', 'lazy', 'grumpy', 'affectionate', 'curious', 'regal', 'mischievous'];

  for (const keyword of keywords) {
    if (filename.includes(keyword)) {
      traits.push(keyword.charAt(0).toUpperCase() + keyword.slice(1));
    }
  }

  return traits.length > 0 ? traits : ['Friendly'];
}

/**
 * Extract quirks from filename
 */
function extractQuirks(filename: string): string[] {
  const quirks: string[] = [];

  if (filename.includes('three-leg')) {
    quirks.push('Three-legged');
  }
  if (filename.includes('cross-eye')) {
    quirks.push('Cross-eyed stare');
  }
  if (filename.includes('scar')) {
    quirks.push('Lightning bolt scar');
  }

  return quirks;
}

/**
 * Process all images in a directory
 */
async function processDirectory(inputDir: string, outputDir: string, config?: ProcessingConfig): Promise<void> {
  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  // Read input directory
  const entries = await readdir(inputDir, { withFileTypes: true });

  let processed = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const ext = extname(entry.name).toLowerCase();
    if (!SUPPORTED_FORMATS.has(ext)) {
      console.log(`⏭️  Skipping ${entry.name} (unsupported format)`);
      skipped++;
      continue;
    }

    const inputPath = join(inputDir, entry.name);
    const outputPath = join(outputDir, entry.name);

    try {
      const metadata = await promptForMetadata(entry.name);
      await processImage(inputPath, outputPath, metadata, config);
      processed++;
    } catch (error) {
      console.error(`❌ Error processing ${entry.name}:`, error);
      skipped++;
    }
  }

  console.log(`\n✅ Processed: ${processed}, Skipped: ${skipped}`);
}

/**
 * Main CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error('Usage: bun scripts/process-test-images.ts <input-dir> <output-dir>');
    console.error('\nExample:');
    console.error('  bun scripts/process-test-images.ts ~/Downloads/cats test/fixtures/photos/cats');
    process.exit(1);
  }

  const [inputDir, outputDir] = args as [string, string];

  console.log('🖼️  Image Processing Utility for Cat Agent Test Fixtures\n');
  console.log(`Input:  ${inputDir}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Target: ${DEFAULT_CONFIG.targetWidth}px wide, ~${DEFAULT_CONFIG.targetMaxSizeKB}KB max\n`);

  await processDirectory(inputDir, outputDir, DEFAULT_CONFIG);
}

// Run if executed directly
if (import.meta.main) {
  await main();
}

// Export for testing
export { processImage, processDirectory };
