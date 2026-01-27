# Test Photo Fixtures

This directory contains test images for the photo analyzer agent.

## Directory Structure

- **cats/** - Valid cat photos for positive testing
- **not-cats/** - Non-cat images for negative testing (dogs, other animals)
- **cat-like/** - Ambiguous cases (stuffed animals, statues, art)

## Adding Images

Place your downloaded cat photos in the appropriate subdirectory, then process them:

```bash
# From the package root
bun run process-images ~/Downloads/cat-photos test/fixtures/photos/cats
```

## Image Requirements

- **Source**: Unsplash or other free-license sources
- **Formats**: JPG, PNG, or WebP
- **Size**: Will be resized to 512px wide (~50-100KB)
- **Naming**: Use descriptive filenames with keywords (see main README)

## Current Fixtures

<!-- Add list of fixtures here after processing -->

None yet - awaiting image processing.
