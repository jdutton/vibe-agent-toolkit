---
name: external-cli-skill-with-allow
description: Sample skill wrapping the Azure `az` CLI, paired with a vibe-agent-toolkit.config.yaml exercising validation.allow suppression for the expected compat codes.
allowed-tools: [Bash, Read]
---

# External-CLI skill (with allow)

Query Azure resources via the `az` CLI.

```bash
az account list --output json
az vm list --query "[].{name:name,rg:resourceGroup}"
```
