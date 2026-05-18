---
defaults: &defaults
  retries: 3
  timeout: 30
prod:
  <<: *defaults
  host: example.com
---
# Body
