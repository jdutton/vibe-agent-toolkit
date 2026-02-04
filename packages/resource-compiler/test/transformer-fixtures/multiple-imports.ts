// Test file for multiple import transformations
import * as Sample from './sample.md';
import * as Empty from './empty.md';
import { readFileSync } from 'node:fs';

// Only .md imports should be transformed
// Regular imports should remain unchanged

export function getSampleTitle() {
  return Sample.meta.title;
}

export function getEmptyContent() {
  return Empty.text;
}

export function readFile(path: string) {
  return readFileSync(path, 'utf-8');
}
