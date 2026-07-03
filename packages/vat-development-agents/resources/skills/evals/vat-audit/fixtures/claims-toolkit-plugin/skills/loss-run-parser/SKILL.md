---
name: loss-run-parser
description: Parse a workers'-comp loss run into normalized rows. Use when a user has a carrier loss-run PDF or spreadsheet and needs claims, paid, reserves, and incurred extracted per claim.
---

# Loss Run Parser

Normalize a carrier loss run into one row per claim with paid, reserve, and
incurred figures.

## Column mapping

Carrier column names vary. See [the column-mapping reference](references/column-aliases.md)
for the alias table covering the major carriers.

## Steps

1. Detect the header row and map carrier columns to the canonical schema.
2. Emit one normalized row per claim.
3. Report rows where paid + reserve does not tie to incurred.
