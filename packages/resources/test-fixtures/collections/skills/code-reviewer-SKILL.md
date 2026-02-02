---
name: code-reviewer
description: Performs systematic code review of git commits against project standards and best practices
version: 1.0.0
model: claude-sonnet-4-5
tools:
  - git
  - read
  - grep
permissions:
  git: true
  filesystem: read
---

# Code Reviewer Skill

This skill performs comprehensive code review of git commits.

## Features

- Reviews code against clean code principles
- Checks for security vulnerabilities
- Validates test coverage
- Enforces style guidelines

## Usage

```bash
/code-review HEAD~1..HEAD
```

This is a valid SKILL.md file with correct frontmatter matching the skill-frontmatter schema.
