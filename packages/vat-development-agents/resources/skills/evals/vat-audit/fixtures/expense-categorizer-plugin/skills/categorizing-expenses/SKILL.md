---
name: categorizing-expenses
description: Categorize expense-report line items into GL accounts. Use when a user has an expense export and needs each line mapped to a general-ledger code, with low-confidence matches flagged for review.
---

# Categorizing Expenses

Map each expense line to a general-ledger account, flagging anything the rules
cannot place with confidence.

## GL code reference

Use [the GL code table](references/gl-codes.md) to resolve category names to
account numbers.

## Steps

1. Read the expense export and identify the description and amount columns.
2. Match each line to a GL code using the reference table.
3. Flag low-confidence matches for human review rather than guessing.
