// Test file for namespace import transformation
import * as Sample from './sample.md';

// This should be transformed to:
// const Sample = { meta: {...}, text: "...", fragments: {...} };

export function getTitle() {
  return Sample.meta.title;
}

export function getIntro() {
  return Sample.fragments.introduction.text;
}
