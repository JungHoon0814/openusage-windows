# Grok

Tracks Grok Build credit usage from the local Grok CLI login.

> Reverse-engineered, undocumented API. May change without notice.

## Overview

- **Protocol:** REST (plain JSON)
- **Base URL:** `https://cli-chat-proxy.grok.com/v1`
- **Auth:** cached Grok CLI token from `~/.grok/auth.json`
- **Refresh:** Grok CLI refresh token from the same file
- **Usage unit:** percent of the shared weekly credit pool
- **Plan source:** `GET /settings` (`subscription_tier_display`)
- **Reset period:** `currentPeriod` from the credits billing response

## Setup

1. Install and sign in to the Grok CLI:

```bash
grok login
```

2. Enable the Grok plugin in OpenUsage settings.

OpenUsage reads the same local auth file that the Grok CLI uses. Access tokens are refreshed automatically before expiry when a `refresh_token` is present. If refresh fails, run `grok login` again.

## Endpoint

### GET /billing?format=credits

Returns the shared weekly credit pool and pay-as-you-go cap. This is the same call the Grok CLI makes.

#### Headers

| Header | Required | Value |
|--------|----------|-------|
| Authorization | yes | `Bearer <token from ~/.grok/auth.json>` |
| X-XAI-Token-Auth | yes | `xai-grok-cli` |
| Accept | yes | `application/json` |

#### Response

The body is proto-JSON, so zero-valued fields are omitted: a missing `creditUsagePercent` means 0%, and a missing `onDemandCap` means pay-as-you-go is disabled.

```json
{
  "config": {
    "creditUsagePercent": 99.0,
    "currentPeriod": {
      "type": "USAGE_PERIOD_TYPE_WEEKLY",
      "start": "2026-07-03T04:01:09.238389+00:00",
      "end": "2026-07-10T04:01:09.238389+00:00"
    },
    "onDemandCap": { "val": 2500 },
    "isUnifiedBillingUser": true
  }
}
```

Used fields:

- `creditUsagePercent`: weekly pool usage, 0 to 100
- `currentPeriod.type`: the Weekly line is shown only for `USAGE_PERIOD_TYPE_WEEKLY`
- `currentPeriod.start` and `currentPeriod.end`: the period length and reset time
- `onDemandCap.val`: pay-as-you-go cap; `0` or absent means disabled

A team principal gets `412` with an `error` containing "no personal team". That is not treated as a failure: the card shows a "Team account" status instead.

### GET /settings

Returns remote CLI settings. OpenUsage reads `subscription_tier_display` from this response and shows it as the provider plan label, for example `SuperGrok Heavy`.

## Displayed Lines

| Line | Description |
|------|-------------|
| Weekly limit | Percent of the shared weekly credit pool used |
| Pay as you go | Disabled, or the configured pay-as-you-go cap |
| Status / Note | Shown instead of the above for team accounts (no personal quota) |

## Errors

| Condition | Message |
|-----------|---------|
| Missing auth file | "Grok not logged in. Run `grok login`." |
| Expired token with no refresh token | "Grok auth expired. Run `grok login` again." |
| Refresh token rejected | "Grok auth expired. Run `grok login` again." |
| 401/403 after retry | "Grok auth expired. Run `grok login` again." |
| HTTP error | "Grok billing request failed (HTTP {status}). Try again later." |
| Network error | "Grok billing request failed. Check your connection." |
| Invalid response | "Grok billing response changed." |
