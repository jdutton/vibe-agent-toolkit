---
name: compat-browser-auth
description: Pins what the text detectors report for this fixture. It exists only for tests.
---
# Browser auth

[bundled](references/bundled.md)

Python: from msal import PublicClientApplication
Node one: import x from "@azure/msal-node"
Node two: require("@azure/msal-browser")
Node three: "@azure/msal-common"
Prose az login is matched anywhere on a line start or after a space: az login
Chained: true;az login
gcloud auth login
aws sso login
Opening: webbrowser.open("https://example.test")
Not a match: az-login and gcloud auth logout
