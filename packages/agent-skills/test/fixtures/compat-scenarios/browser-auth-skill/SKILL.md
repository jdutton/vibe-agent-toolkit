---
name: browser-auth-skill
description: Sample skill that authenticates via Microsoft MSAL browser login. Models the real avonrisk-sdlc azure-msal-auth shape for compat-detector regression tests.
---

# Browser-auth skill

This skill authenticates users via Azure AD using MSAL's public client
flow.

```python
from msal import PublicClientApplication

app = PublicClientApplication(
    client_id=CLIENT_ID,
    authority="https://login.microsoftonline.com/common",
)
result = app.acquire_token_interactive(scopes=["User.Read"])
```
