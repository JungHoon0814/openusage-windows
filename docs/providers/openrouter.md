# OpenRouter

Tracks [OpenRouter](https://openrouter.ai) credit balance and API key spend. Ported from the upstream Swift provider.

## Overview

- **Protocol:** REST (plain JSON), the public OpenRouter API
- **Base URL:** `https://openrouter.ai/api/v1`
- **Auth:** an OpenRouter API key, sent as `Authorization: Bearer <key>`
- **Units:** US dollars

## Setup

1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Give OpenUsage the key in one of these places. The first one found wins:
   1. `~/.config/openusage/openrouter.json`
   2. `~/.config/openrouter/key.json`
   3. the `OPENROUTER_API_KEY` environment variable
   4. the `OPENROUTER_KEY` environment variable

   On Windows `~` is your user folder (`%USERPROFILE%`), so the first path is `C:\Users\<you>\.config\openusage\openrouter.json`. The file can be JSON with an `apiKey`, `api_key` or `key` field, or a plain-text file that holds only the key:

   ```json
   { "apiKey": "sk-or-v1-..." }
   ```

   To use an environment variable instead, set it for your user and restart OpenUsage:

   ```powershell
   [Environment]::SetEnvironmentVariable("OPENROUTER_API_KEY", "sk-or-v1-...", "User")
   ```

3. Enable the OpenRouter plugin in OpenUsage settings. It is off by default.

The config files win over the environment, so editing the file is how you rotate a key.

## Endpoints

Both endpoints are fetched on every refresh, independently: if one fails, the other's lines still show.

### GET /credits

```json
{ "data": { "total_credits": 25, "total_usage": 7.5 } }
```

### GET /key

```json
{
  "data": {
    "usage_daily": 0,
    "usage_weekly": 1.25,
    "usage_monthly": 4.5,
    "limit": 10,
    "limit_remaining": 6,
    "is_free_tier": false
  }
}
```

## Displayed Lines

| Line | Source | Description |
|------|--------|-------------|
| Credits | `/credits` | Spend (`total_usage`) against purchased credits (`total_credits`); hidden when nothing was purchased |
| Balance | `/credits` | `total_credits - total_usage` |
| Today / This Week / This Month | `/key` | `usage_daily` / `usage_weekly` / `usage_monthly`; $0 is shown as $0.00, not as missing |
| Key Limit | `/key` | Spent against the key's cap (`limit - limit_remaining`); only when the key has a cap |

The plan label is "Free tier" or "Pay as you go", from `is_free_tier`.

## Errors

| Condition | Message |
|-----------|---------|
| No key found | "No OpenRouter API key. Set OPENROUTER_API_KEY or add it to ~/.config/openusage/openrouter.json." |
| Both endpoints return 401/403 | "OpenRouter API key invalid. Check your key at openrouter.ai/keys." |
| Other HTTP error and no lines loaded | "OpenRouter request failed (HTTP {status})." |
| Network error | "Couldn't reach OpenRouter. Check your connection." |
| Response without a `data` object | "OpenRouter usage data unavailable. Try again later." |
