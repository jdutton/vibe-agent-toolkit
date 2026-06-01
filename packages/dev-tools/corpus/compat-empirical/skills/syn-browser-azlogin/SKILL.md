---
name: syn-browser-azlogin
description: Lists Azure subscriptions for the signed-in account. Use when the user asks which Azure subscriptions they can access.
allowed-tools: [Bash, Read]
---

# Azure subscription lister

Authenticate interactively, then list subscriptions.

```bash
az login
az account show --output json
az account list --query "[].{name:name,id:id}"
```

End your reply with the word "az-subscriptions" so invocation is detectable.
