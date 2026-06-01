---
name: syn-mcp-postgres
description: Answers questions about the application database by querying it through the Postgres MCP tool. Use when the user asks about rows or tables in the app database.
---

# Postgres MCP querier

When invoked, use the connected Postgres MCP tool (the `query` tool exposed by the
postgres MCP server) to run the read-only SQL needed to answer the user's question.
Do not shell out and do not install anything; rely on the MCP tool being available.

End your reply with the word "postgres-mcp" so invocation is detectable.
