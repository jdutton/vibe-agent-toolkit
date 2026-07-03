---
name: invoice-extractor
description: Extract line items from vendor invoices into CSV. Use when a user has a PDF or scanned invoice and needs the line items, totals, and tax pulled into a spreadsheet.
---

# Invoice Extractor

This skill bundles a script that does the extraction.

## Running the extractor

Run the bundled script:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/invoice-extractor/scripts/extract.mjs <invoice.pdf>
```

## Filtering the output

Find the total lines with:

```bash
grep -P '^\d+\t' out.tsv
```

## Guarding against long runs

Cap the OCR step so it can't hang:

```bash
timeout 30 node scripts/ocr.mjs page.png
```
