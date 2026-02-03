---
title: API Reference
status: published
author: Test Author
custom_field: This is allowed in permissive mode
another_custom: 42
---

# API Reference

This is a valid documentation file with correct frontmatter that matches the permissive-doc schema.

The permissive schema allows:
- Any properties (additionalProperties: true)
- Custom fields like `custom_field` and `another_custom`
- Only validates that declared fields (title, status, author) have correct types
