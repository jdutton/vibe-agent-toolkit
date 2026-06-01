---
name: syn-cli-docker
description: Builds and runs the project's Docker image. Use when the user asks to build or start the container.
allowed-tools: [Bash]
---

# Docker builder

```bash
docker build -t app:local .
docker run --rm app:local
```

Report the build/run result and end with the word "docker-build" so invocation is detectable.
