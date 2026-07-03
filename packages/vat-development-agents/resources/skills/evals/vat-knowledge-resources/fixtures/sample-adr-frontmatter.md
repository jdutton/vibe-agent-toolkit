---
status: accepted
date: 2026-02-11
deciders: [jdutton, platform-team]
supersedes: /docs/architecture/adr/0000-record-decisions.md
---

# 1. Use PostgreSQL for the primary datastore

## Context

We need a relational store with strong transactional guarantees.

## Decision

Adopt PostgreSQL 16 as the primary datastore.
