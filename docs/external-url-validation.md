# External URL Validation

The VAT Resources package supports optional validation of external URLs referenced in markdown documents. This feature helps maintain link integrity by detecting dead links, timeouts, and HTTP errors.

## Overview

External URL validation is **opt-in** via the `--check-external-urls` flag. When enabled, VAT:

1. Extracts all `http://` and `https://` URLs from markdown content
2. Checks each URL's availability via HTTP requests
3. Caches results to avoid redundant network calls
4. Reports issues: dead links (404/410), timeouts, or HTTP errors

**Key Benefits:**
- **Performance:** Filesystem-based cache with intelligent TTLs
- **Configurable:** Per-collection timeout, retry, and ignore patterns
- **Reliable:** Uses proven `markdown-link-check` library
- **CI-Friendly:** Deterministic caching for consistent builds

## Basic Usage

```bash
# Validate resources and check external URLs
vat resources validate docs/ --check-external-urls

# Output shows external URL issues
❌ docs/guide.md
   external_url_dead: https://example.com/old-page (404 Not Found)

# Use JSON format for CI integration
vat resources validate docs/ --check-external-urls --output json
```

## Configuration

Configure external URL validation in `vibe-agent-toolkit.config.yaml`:

```yaml
resources:
  collections:
    - path: docs/
      externalUrlValidation:
        enabled: true           # Enable by default for this collection
        timeout: 10000          # Request timeout in milliseconds (default: 10000)
        retryOn429: true        # Retry on 429 Too Many Requests (default: true)
        ignorePatterns:         # Regex patterns to skip validation
          - "localhost"
          - "127\\.0\\.0\\.1"
          - "example\\.com"
```

**Configuration Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `false` | Enable external URL checking for this collection |
| `timeout` | number | `10000` | HTTP request timeout in milliseconds |
| `retryOn429` | boolean | `true` | Retry on rate-limiting (429 status) |
| `ignorePatterns` | string[] | `[]` | Regex patterns to skip (e.g., localhost URLs) |

**Note:** CLI flag `--check-external-urls` overrides `enabled` config. When flag is present, validation runs regardless of config.

## Caching Behavior

External URL validation uses a filesystem-based cache to minimize network requests:

**Cache Location:** System temp directory (`<tmpdir>/.vat-cache/external-links.json`)
- No `.gitignore` entry needed (not in project directory)
- Automatically cleaned by OS periodically
- Shared across all projects (URLs are universal)

**Cache TTLs:**
- **Alive URLs (2xx status):** 24 hours
- **Dead URLs (4xx/5xx status):** 1 hour
- **Timeouts/Errors:** 1 hour

**Cache Strategy:**
- **Hit:** Use cached result if not expired
- **Miss:** Make HTTP request, cache new result
- **Expired:** Treat as cache miss, re-validate URL

**Example Cache Entry:**
```json
{
  "8be7c631ca29...": {
    "statusCode": 200,
    "statusMessage": "OK",
    "timestamp": 1770683496057
  }
}
```

**Cache Invalidation:**
- CLI flag: Use `--no-cache` to bypass cache
- Automatic: Entries expire based on TTL
- Per-URL: Cache is per-URL (hashed), not per-file

## Issue Types

External URL validation reports three issue types:

| Issue Type | Description | Example |
|------------|-------------|---------|
| `external_url_dead` | URL returns 4xx or 5xx status | `404 Not Found`, `410 Gone`, `500 Internal Server Error` |
| `external_url_timeout` | Request exceeds timeout limit | `Request timeout after 10000ms` |
| `external_url_error` | Network or protocol error | `ENOTFOUND`, `ECONNREFUSED`, `SSL certificate error` |

**JSON Output Format:**
```json
{
  "issues": [
    {
      "type": "external_url_dead",
      "severity": "error",
      "file": "docs/guide.md",
      "url": "https://example.com/missing",
      "message": "404 Not Found"
    }
  ]
}
```

## Performance Characteristics

**Initial Validation (Cold Cache):**
- **Time:** ~5-15 seconds per 10 URLs (network-bound)
- **Network:** 1 HTTP request per unique URL
- **Example:** 100 unique URLs = ~60 seconds max

**Subsequent Validations (Warm Cache):**
- **Time:** < 100ms for cache hits (disk-bound)
- **Network:** 0 requests for non-expired entries
- **Example:** 100 cached URLs = instant validation

**Optimization Tips:**
1. **Use `ignorePatterns`** to skip known-good domains (e.g., localhost)
2. **Commit cache** in CI for faster builds (if URLs rarely change)
3. **Run validation** during off-peak hours to avoid rate limits
4. **Increase timeout** for slow servers (max recommended: 30000ms)

## Best Practices

### Development Workflow

```bash
# Initial validation (slow, but caches results)
vat resources validate docs/ --check-external-urls

# Subsequent validations (fast, uses cache)
vat resources validate docs/ --check-external-urls
```

### CI/CD Integration

**Recommended: Use CLI flag (Simple)**
```yaml
# .github/workflows/validate.yml
- name: Validate resources with external URLs
  run: vat resources validate docs/ --check-external-urls
  # Cache is in system temp, automatically managed
```

**Alternative: Force fresh checks (Slower, but always current)**
```yaml
# .github/workflows/validate.yml
- name: Validate resources (no cache)
  run: vat resources validate docs/ --check-external-urls --no-cache
```

### Ignore Patterns

**Common Patterns:**
```yaml
externalUrlValidation:
  ignorePatterns:
    - "localhost"           # Local development servers
    - "127\\.0\\.0\\.1"     # Localhost IP
    - "example\\.com"       # Placeholder domains
    - "todo-api\\.example"  # Internal/mock APIs
    - "github\\.com/.+/compare" # GitHub compare URLs (often 404)
```

**Regex Tips:**
- Escape dots: `\\.` (matches literal `.`)
- Use anchors: `^https://internal\\.` (start of URL)
- Match subdomains: `.*\\.example\\.com` (any subdomain)

### Handling Rate Limits

If you encounter 429 (Too Many Requests):

1. **Enable retry** (default): `retryOn429: true`
2. **Increase timeout**: Allow time for retry backoff
3. **Use ignorePatterns**: Skip rate-limited domains
4. **Stagger validation**: Run validation less frequently

**Example:**
```yaml
externalUrlValidation:
  timeout: 15000        # Allow time for retry
  retryOn429: true      # Retry with exponential backoff
  ignorePatterns:
    - "rate-limited-api\\.example" # Skip known rate-limited domains
```

## Troubleshooting

### Issue: "All external URLs timing out"

**Cause:** Firewall or network restrictions blocking HTTP requests

**Solution:**
1. Test URL manually: `curl -I https://example.com`
2. Check network/VPN settings
3. Use `ignorePatterns` for inaccessible domains
4. Disable external URL validation in restricted environments

### Issue: "Cache not persisting between runs"

**Cause:** Cache directory (in system temp) not writable

**Solution:**
1. Verify system temp is writable
2. Check disk space
3. Use `--no-cache` flag to bypass cache if needed

### Issue: "Validation slow despite cache"

**Cause:** Cache entries expired or URLs changed

**Solution:**
1. Check cache hit rate: Look for "Using cached result" in debug logs
2. Increase TTL by modifying `CacheTTL` constants (requires code change)
3. Use `ignorePatterns` to skip frequently-changing URLs
4. Run validation less frequently (e.g., nightly instead of per-commit)

### Issue: "False positives for working URLs"

**Cause:** Server returns 4xx/5xx for automated requests (bot detection)

**Solution:**
1. Test URL in browser to confirm it works
2. Add to `ignorePatterns` if consistently flagged
3. Report issue if legitimate URL should work (might be server-side issue)
4. Use `retryOn429: true` for rate-limited APIs

### Issue: "SSL certificate errors"

**Cause:** Invalid or expired SSL certificates on target server

**Solution:**
1. Verify certificate: `openssl s_client -connect example.com:443`
2. Contact domain owner if certificate is expired
3. Add to `ignorePatterns` if certificate issue is known/persistent

## Implementation Details

**Library Used:** `markdown-link-check` (v3.x)
- Industry-standard link checker
- Handles redirects (3xx) automatically
- Supports custom headers and retry logic
- Well-maintained, battle-tested

**Cache Implementation:**
- **Format:** JSON file with URL → result mapping
- **Atomicity:** Write to temp file, then rename (crash-safe)
- **Concurrency:** Single-threaded validation (no race conditions)
- **Portability:** Works across all platforms (Windows/Linux/macOS)

**HTTP Request Behavior:**
- **Method:** HEAD (falls back to GET if HEAD not supported)
- **Redirects:** Followed automatically (max 5 hops)
- **User-Agent:** `vibe-agent-toolkit/x.x.x`
- **Timeout:** Configurable per collection (default: 10s)

**Error Handling:**
- **Network errors:** Reported as `external_url_error`
- **Timeouts:** Reported as `external_url_timeout`
- **HTTP errors:** Reported as `external_url_dead` (4xx/5xx)
- **Retries:** Automatic on 429 if `retryOn429: true`

## Related Documentation

- [Resources Validation](../packages/resources/README.md#validation)
