---
name: extracting-tables
description: Extract tables from PDF reports into CSV. Use when a user has a PDF financial report and needs the tabular data pulled into a spreadsheet.
version: 2.1.0
category: data-extraction
linkFollowDepth: 1
excludeReferencesFromBundle:
  rules:
    - patterns: ["**/concepts/**"]
      template: "Search the knowledge base for: {{link.text}}"
---

# Extracting Tables

Pull tabular data out of PDF financial reports and write it to CSV.

## Steps

1. Open the PDF the user points you at.
2. Detect the table regions on each page.
3. Write the extracted rows to a CSV file.

## Related

For verifying the packaged result before shipping, see [the audit skill](./vat-audit.md).

## References

- [PDF table-detection concepts](./concepts/pdf-structure.md)
