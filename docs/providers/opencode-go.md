# OpenCode Go

> Reads your OpenCode Go plan windows from OpenCode's official usage API, using the `opencode-go` key OpenCode already saved on this machine.

## Overview

- **Endpoint:** `GET https://opencode.ai/zen/go/v1/usage` with `Authorization: Bearer <opencode-go key>`
- **Provider ID:** `opencode-go`
- **Usage scope:** account-wide (the same numbers as the OpenCode dashboard), not just this machine

## Data directory

Resolved the same way OpenCode does:

1. `OPENCODE_DATA_DIR`
2. `$XDG_DATA_HOME/opencode`
3. `~/.local/share/opencode` (on Windows, `%USERPROFILE%\.local\share\opencode`)

OpenCode keeps one database per release channel (`opencode.db`, `opencode-next.db`, ...). Every `opencode*.db` file in the data directory is read; the `-wal` / `-shm` sidecars are skipped.

## Key discovery

- **OpenCode 2** stores the key in each channel database's `credential` table (`integration_id = 'opencode-go'`, the active or most recently updated row). The first database that has a key wins.
- **OpenCode 2 imports `auth.json` once.** When a database contains the `20260805200742_import_legacy_credentials` migration, its `credential` table is authoritative. If that table has no key, you logged out, and the old `auth.json` is ignored.
- **OpenCode 1** databases have no such migration, so `auth.json` (`"opencode-go": { "key": ... }`) is still read.
- A database or `auth.json` that exists but can't be read is reported as an error, not treated as logged out.

## Displayed Lines

The response is `{ "usage": { "rolling", "weekly", "monthly" } }`, each with `percent` (0-100) and `resetsAt` (ISO time).

| Line | Source | Period |
|------|--------|--------|
| Session | `usage.rolling` | 5 hours |
| Weekly | `usage.weekly` | 7 days |
| Monthly | `usage.monthly` | 30 days |

When nothing has been used in the rolling window, the API returns `resetsAt` exactly 5 hours from now on every request. That placeholder is dropped, so Session reads "Not started" instead of a countdown that never moves. The check uses the response's `Date` header when present, so a wrong local clock doesn't affect it. A sub-1% session that has started keeps its real reset time.

The plan label "Go" is shown only when the API call succeeds.

## Detection without a key

If there is no key but local history contains `opencode-go` assistant messages with a numeric `cost` (OpenCode 1 `message` or OpenCode 2 `session_message`), the card stays visible with a grey `Status: No usage data` badge. With neither a key nor history, the plugin reports "OpenCode Go not detected".

## Errors

| Condition | Message |
|-----------|---------|
| No key and no history | "OpenCode Go not detected. Log in with OpenCode Go or use it locally first." |
| Credentials unreadable | "Couldn't read OpenCode's credentials. ..." |
| HTTP 401 | "OpenCode Go key was rejected. Log into OpenCode Go again." |
| HTTP 403 with `error.type = "EntitlementError"` | "No OpenCode Go subscription on this key." |
| Other HTTP error | "Usage request failed (HTTP {status}). Try again later." |
| Network error | "Usage request failed. Check your connection." |
| Missing or malformed `usage` windows | "Usage response invalid. Try again later." |

Local Go and Zen spend tiles (Today / Yesterday / Last 30 Days) are not shown yet; see item 5 of the [upstream sync plan](../upstream-sync-plan.md).
