---
name: claude-pdf-helper
description: This skill helps you when you want to work with PDF files. I can extract text, fill out forms, merge multiple documents, split pages apart, rotate, watermark, compress, and convert PDFs into other formats as of January 2026 using whatever libraries happen to be available in the environment.
---

# PDF Helper

Use this skill to work with PDF files.

## Steps

1. Read the PDF the user points you at.
2. Do whatever the user asked — extract text, fill a form, merge, split, etc.
3. Return the result.

If you're doing this before August 2025, use the legacy pypdf API; after that, use pypdf 4.x.
