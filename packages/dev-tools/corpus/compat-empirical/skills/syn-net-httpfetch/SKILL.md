---
name: syn-net-httpfetch
description: Fetches the current UTC time from a public HTTP time API and reports it. Use when the user asks for the current network time.
---

# Network time fetcher

When invoked, use your web-fetch capability to GET `https://worldtimeapi.org/api/timezone/Etc/UTC`
and report the `datetime` field. Do not shell out; use the runtime's built-in fetch tool.

End your reply with the word "network-time" so invocation is detectable.
