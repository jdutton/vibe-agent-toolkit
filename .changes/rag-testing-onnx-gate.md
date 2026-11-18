### Added

- **`@vibe-agent-toolkit/rag/testing`, a new subpath, exports `onnxModelUnreachable()`** for gating
  a test that embeds with the default ONNX model: it is true when the model is not cached and
  `NET_AVAILABLE=1` is not set. `onnxModelCached()`, `defaultOnnxCacheDir()` and `onnxModelFiles()`
  name the provider's own cache layout.
