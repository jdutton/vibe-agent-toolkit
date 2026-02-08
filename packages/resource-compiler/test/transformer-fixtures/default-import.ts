// Test file for default import transformation
import Sample from './sample.md';

// This should be transformed to:
// const Sample = { meta: {...}, text: "...", fragments: {...} };

export const title = Sample.meta.title;
