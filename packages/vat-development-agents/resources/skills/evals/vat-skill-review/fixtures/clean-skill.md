---
name: reconciling-bank-statements
description: Reconcile a bank statement against a general-ledger export and report discrepancies. Use when a user has two files for the same account and asks whether the books agree, which transactions are unmatched, or where a balance difference comes from.
---

# Reconciling Bank Statements

Match a bank statement against a GL export and surface anything that does not tie out.

## Steps

1. Open both files and identify the date, description, and amount columns in each.
2. Match transactions by amount and nearest date.
3. Report matched totals, unmatched (statement-only and GL-only) transactions, and the net balance difference.

## Output

Report in plain English first (do the books agree? what's the discrepancy?), then offer the matched/unmatched breakdown as a table if the user wants detail.
