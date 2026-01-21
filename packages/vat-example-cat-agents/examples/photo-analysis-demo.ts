#!/usr/bin/env bun
/**
 * Photo Analysis Demo - demonstrates photo analyzer with actual test fixtures
 *
 * This demo:
 * 1. Loads actual cat photos from test/fixtures/photos
 * 2. Analyzes each photo using either mock mode OR real vision API
 * 3. Displays the extracted characteristics
 * 4. Demonstrates handling of not-cat images
 *
 * Mock Mode (default):
 * - Reads EXIF metadata embedded during image processing
 * - Falls back to filename pattern extraction
 * - DOES NOT analyze actual image pixels
 * - Fast and free (no API calls)
 *
 * Real Mode (requires API key):
 * - Calls actual vision API (Claude Vision, GPT-4 Vision, etc.)
 * - Analyzes actual image pixels
 * - No hints from filename/EXIF
 * - Slow and costs money
 *
 * Run with:
 *   bun examples/photo-analysis-demo.ts           # Mock mode
 *   USE_REAL_VISION=true bun examples/photo-analysis-demo.ts  # Real mode (not implemented yet)
 */

/* eslint-disable security/detect-non-literal-fs-filename */
// This demo script reads test fixture directories

import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzePhoto } from '../src/one-shot-llm-analyzer/photo-analyzer.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Configuration: Mock mode vs Real vision API
 */
const USE_MOCK_MODE = process.env.USE_REAL_VISION !== 'true';

interface AnalysisResult {
  filename: string;
  category: 'cat' | 'not-cat';
  characteristics: Awaited<ReturnType<typeof analyzePhoto>>;
  error?: string;
}

/**
 * Color codes for terminal output
 */
const colors = {
  reset: '\x1B[0m',
  bright: '\x1B[1m',
  dim: '\x1B[2m',
  red: '\x1B[31m',
  green: '\x1B[32m',
  yellow: '\x1B[33m',
  blue: '\x1B[34m',
  magenta: '\x1B[35m',
  cyan: '\x1B[36m',
};

function section(title: string): void {
  console.log(`\n${colors.bright}${colors.cyan}${'='.repeat(70)}`);
  console.log(`${title}`);
  console.log(`${'='.repeat(70)}${colors.reset}\n`);
}

function log(label: string, message: string, color: string): void {
  console.log(`${color}[${label}]${colors.reset} ${message}`);
}

/**
 * Analyze all photos in a directory
 */
async function analyzePhotosInDirectory(dirPath: string, category: 'cat' | 'not-cat'): Promise<AnalysisResult[]> {
  const files = await readdir(dirPath);
  const imageFiles = files.filter(
    (f) => f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.png') || f.endsWith('.webp'),
  );

  const results: AnalysisResult[] = [];

  for (const file of imageFiles) {
    const filePath = join(dirPath, file);

    try {
      log('Analyzing', file, colors.cyan);

      const result = await analyzePhoto(filePath, { mockable: USE_MOCK_MODE });

      results.push({
        filename: file,
        category,
        characteristics: result,
      });

      log('Success', `Analyzed ${file}`, colors.green);
    } catch (error) {
      results.push({
        filename: file,
        category,
        characteristics: {} as AnalysisResult['characteristics'],
        error: error instanceof Error ? error.message : String(error),
      });

      log('Error', `Failed to analyze ${file}: ${error}`, colors.red);
    }
  }

  return results;
}

/**
 * Display analysis results in a formatted way
 */
function displayResults(results: AnalysisResult[]): void {
  for (const result of results) {
    console.log(`\n${colors.bright}${colors.magenta}━━━ ${result.filename} ━━━${colors.reset}`);
    console.log(`${colors.dim}Category: ${result.category}${colors.reset}`);

    if (result.error) {
      console.log(`${colors.red}Error: ${result.error}${colors.reset}`);
      continue;
    }

    const { physical, behavioral, description } = result.characteristics;

    console.log(`\n${colors.yellow}Physical Characteristics:${colors.reset}`);
    console.log(`  Fur Color: ${physical.furColor}`);
    if (physical.furPattern) {
      console.log(`  Fur Pattern: ${physical.furPattern}`);
    }
    if (physical.eyeColor) {
      console.log(`  Eye Color: ${physical.eyeColor}`);
    }
    if (physical.breed) {
      console.log(`  Breed: ${physical.breed}`);
    }
    console.log(`  Size: ${physical.size}`);

    console.log(`\n${colors.yellow}Behavioral Traits:${colors.reset}`);
    console.log(`  Personality: ${behavioral.personality.join(', ')}`);
    if (behavioral.quirks && behavioral.quirks.length > 0) {
      console.log(`  Quirks: ${behavioral.quirks.join(', ')}`);
    }

    console.log(`\n${colors.yellow}Description:${colors.reset}`);
    console.log(`  ${colors.dim}${description}${colors.reset}`);
  }
}

/**
 * Main demo function
 */
async function runDemo(): Promise<void> {
  console.log(`${colors.bright}${colors.magenta}`);
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║            Photo Analysis Demo - VAT Example Cat Agents              ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(colors.reset);

  const mode = USE_MOCK_MODE ? 'MOCK MODE (filename + EXIF)' : 'REAL VISION API';
  const modeColor = USE_MOCK_MODE ? colors.yellow : colors.green;
  console.log(`${colors.bright}${modeColor}Mode: ${mode}${colors.reset}`);
  if (USE_MOCK_MODE) {
    console.log(`${colors.dim}(Set USE_REAL_VISION=true to use actual vision API)${colors.reset}`);
  }
  console.log();

  const fixturesDir = join(__dirname, '..', 'test', 'fixtures', 'photos');
  const catsDir = join(fixturesDir, 'cats');
  const notCatsDir = join(fixturesDir, 'not-cats');

  // ============================================================================
  // Analyze Cat Photos
  // ============================================================================
  section('Analyzing Cat Photos');

  log('Info', `Loading images from: ${basename(catsDir)}/`, colors.dim);
  const catResults = await analyzePhotosInDirectory(catsDir, 'cat');

  displayResults(catResults);

  // ============================================================================
  // Analyze Not-Cat Photos (Negative Test Cases)
  // ============================================================================
  section('Analyzing Not-Cat Photos (Negative Tests)');

  log('Info', `Loading images from: ${basename(notCatsDir)}/`, colors.dim);
  const notCatResults = await analyzePhotosInDirectory(notCatsDir, 'not-cat');

  displayResults(notCatResults);

  // ============================================================================
  // Summary
  // ============================================================================
  section('Summary');

  const totalImages = catResults.length + notCatResults.length;
  const successCount = catResults.filter((r) => !r.error).length + notCatResults.filter((r) => !r.error).length;
  const errorCount = totalImages - successCount;

  console.log(`${colors.bright}Total Images Analyzed: ${totalImages}${colors.reset}`);
  console.log(`${colors.green}Successful: ${successCount}${colors.reset}`);
  if (errorCount > 0) {
    console.log(`${colors.red}Errors: ${errorCount}${colors.reset}`);
  }

  if (USE_MOCK_MODE) {
    console.log(`\n${colors.dim}${colors.yellow}⚠ MOCK MODE ACTIVE${colors.reset}${colors.dim}`);
    console.log(`This demo extracted characteristics from filename patterns and EXIF metadata.`);
    console.log(`It did NOT analyze the actual image pixels.`);
    console.log(`\nTo test with real vision API:`);
    console.log(`  USE_REAL_VISION=true bun examples/photo-analysis-demo.ts${colors.reset}\n`);
  } else {
    console.log(`\n${colors.dim}${colors.green}✓ REAL VISION API MODE${colors.reset}${colors.dim}`);
    console.log(`This demo analyzed actual image pixels using vision API.${colors.reset}\n`);
  }
}

// Run the demo
try {
  await runDemo();
} catch (error) {
  console.error(`${colors.red}Demo failed:${colors.reset}`, error);
  process.exit(1);
}
