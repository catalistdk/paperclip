# Runbook: BOARD_KEY Expiry Rotation

**Trigger:** P1 alert titled `BOARD_KEY "<name>" expires in Nh` fired via Telegram/Pushover.  
**Risk:** Once expired, all board API calls using that key return `401 Unauthorized`, blocking CI/CD write traffic silently.

---

## 1. Acknowledge the alert

The `dedupeKey` in the alert message identifies the specific key (format: `board_key_expiry:<uuid>`). Note the key `id` from the alert body — you will need it.

The alert will re-fire at most once every 6 hours per key until the key is rotated or revoked.

---

## 2. Identify the expiring key

Run the following query against the Paperclip database to confirm the key details:

```sql
SELECT
  id,
  user_id,
  name,
  expires_at,
  last_used_at,
  EXTRACT(EPOCH FROM (expires_at - now())) / 3600 AS hours_remaining
FROM board_api_keys
WHERE
  revoked_at IS NULL
  AND expires_at < now() + INTERVAL '7 days'
ORDER BY expires_at ASC;
```

Or via the Paperclip board API (requires an operator-level key):

```bash
curl -s -H "Authorization: Bearer <OPERATOR_KEY>" \
  http://localhost:3100/api/board/api-keys | jq '.[] | select(.expiresAt != null)'
```

---

## 3. Create a replacement key

Use the Paperclip board CLI or UI to create a new key for the same user/purpose:

```bash
# Via CLI (if available)
paperclip board api-keys create --name "<same-name>-rotated-$(date +%Y%m)"

# Or via the Paperclip settings UI → Board API Keys → New Key
```

Copy the new key value — it is shown only once.

---

## 4. Update consuming systems

Update the key in **every system that uses it**. Common locations:

- GitHub Actions secrets (`PAPERCLIP_BOARD_KEY` or equivalent)
- CI/CD pipeline environment variables
- Local developer `.env` files (notify team)
- Any scheduled task or webhook that calls the Paperclip board API

Verify the new key works **before** revoking the old one:

```bash
curl -s -H "Authorization: Bearer <NEW_KEY>" \
  http://localhost:3100/api/board/health
# Expected: 200 OK
```

---

## 5. Revoke the old key

Once the new key is confirmed working, revoke the expiring key to stop future alerts for it:

```bash
# Via board API
curl -s -X POST \
  -H "Authorization: Bearer <OPERATOR_KEY>" \
  http://localhost:3100/api/board/api-keys/<OLD_KEY_ID>/revoke
```

Or via the Paperclip settings UI → Board API Keys → Revoke.

---

## 6. Verify the alert clears

The next hourly expiry check will no longer find the revoked key. The alert dedupe state for `board_key_expiry:<id>` will be pruned automatically once the key no longer appears in the expiry window query.

To manually clear the dedupe state immediately (e.g. to stop alert spam for an already-handled key):

```bash
# Read current state
cat ~/.paperclip/board-key-expiry-dedupe.json

# Remove the entry for the specific key id and save, or delete the file entirely
# to reset all dedupe state (safe — it will rebuild on next tick)
rm ~/.paperclip/board-key-expiry-dedupe.json
```

---

## Alert frequency reference

| Scenario | Alert cadence |
|---|---|
| Key expiring, no action taken | Every 6 hours per key |
| Key revoked | No further alerts (revoked keys excluded from query) |
| Key rotated (old key still active) | Continues until old key revoked or expired |
| Key already expired | Alert continues with "EXPIRED Nh ago" in title |

---

## Related

- Service: `server/src/services/board-key-expiry-alarm.ts`
- Config env vars:
  - `BOARD_KEY_EXPIRY_ALERT_ENABLED` — set `false` to disable (default: `true`)
  - `BOARD_KEY_EXPIRY_ALERT_INTERVAL_MS` — check cadence in ms (default: `3600000` = 1h)
- Dedupe state file: `~/.paperclip/board-key-expiry-dedupe.json`
- Parent issue: VER-1405 / VER-1406
