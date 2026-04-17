---
name: external-cli-skill
description: Sample skill wrapping the Azure `az` CLI. Models the real avonrisk-sdlc azure-inventory shape for compat-detector regression tests.
allowed-tools: [Bash, Read]
---

# External-CLI skill

Query Azure resources via the `az` CLI.

```bash
az login
az account list --output json
az vm list --query "[].{name:name,rg:resourceGroup}"
```
