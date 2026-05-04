# Lessons

## Heartbeat Run Failure Diagnostics

- `adapter_failed`: generic adapter execution failure. `stderr_excerpt` should include process stderr when present, otherwise the adapter's parsed API/client error message from JSON output.
- `codex_transient_upstream`: Codex local failure classified as retryable upstream pressure, rate limit, or weekly usage cap. `stderr_excerpt` should include the concrete Codex message, including any retry/reset text.
- `claude_transient_upstream`: Claude local failure classified as retryable upstream pressure, rate limit, or extra-usage cap. `stderr_excerpt` should include the concrete Claude result/error text, including any reset text.
- `claude_auth_required`: Claude local login/OAuth failure. `stderr_excerpt` should include the auth/login response body or parsed CLI message so expired OAuth is distinguishable from a generic adapter crash.
- `timeout`: adapter timeout. `stderr_excerpt` is whatever stderr arrived before the timeout; the error code carries the timeout classification.
