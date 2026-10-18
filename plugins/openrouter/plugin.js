(function () {
  const CREDITS_URL = "https://openrouter.ai/api/v1/credits"
  const KEY_URL = "https://openrouter.ai/api/v1/key"
  // Config file first, environment second: the file is what a user edits to rotate the key, so it
  // wins over a stale env value.
  const CONFIG_PATHS = ["~/.config/openusage/openrouter.json", "~/.config/openrouter/key.json"]
  const ENV_NAMES = ["OPENROUTER_API_KEY", "OPENROUTER_KEY"]

  const ERR_MISSING_KEY =
    "No OpenRouter API key. Set OPENROUTER_API_KEY or add it to ~/.config/openusage/openrouter.json."
  const ERR_INVALID_KEY = "OpenRouter API key invalid. Check your key at openrouter.ai/keys."
  const ERR_CONNECTION = "Couldn't reach OpenRouter. Check your connection."
  const ERR_INVALID_RESPONSE = "OpenRouter usage data unavailable. Try again later."

  // Accept a JSON object with apiKey / api_key / key, or a plain-text file holding only the key.
  function keyFromText(text) {
    if (typeof text !== "string") return null
    const trimmed = text.trim()
    if (!trimmed) return null
    let parsed = null
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      parsed = null
    }
    if (parsed && typeof parsed === "object") {
      for (const field of ["apiKey", "api_key", "key"]) {
        const value = parsed[field]
        if (typeof value === "string" && value.trim()) return value.trim()
      }
      return null
    }
    return trimmed.indexOf("{") === -1 ? trimmed : null
  }

  function loadApiKey(ctx) {
    for (const path of CONFIG_PATHS) {
      try {
        if (!ctx.host.fs.exists(path)) continue
        const key = keyFromText(ctx.host.fs.readText(path))
        if (key) return key
      } catch (e) {
        ctx.host.log.warn("reading " + path + " failed: " + String(e))
      }
    }
    for (const name of ENV_NAMES) {
      const value = ctx.host.env.get(name)
      if (typeof value === "string" && value.trim()) return value.trim()
    }
    return null
  }

  // Each endpoint is fetched independently so one failing doesn't hide the other's metrics.
  function fetchData(ctx, url, apiKey) {
    let resp
    try {
      resp = ctx.util.request({
        method: "GET",
        url,
        headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" },
        timeoutMs: 15000,
      })
    } catch (e) {
      ctx.host.log.warn("request to " + url + " failed: " + String(e))
      return { error: ERR_CONNECTION }
    }
    if (resp.status === 401 || resp.status === 403) return { authFailure: true }
    if (resp.status < 200 || resp.status >= 300) {
      return { error: "OpenRouter request failed (HTTP " + String(resp.status) + ")." }
    }
    const body = ctx.util.tryParseJson(resp.bodyText)
    const data = body && body.data
    if (!data || typeof data !== "object") return { error: ERR_INVALID_RESPONSE }
    return { data }
  }

  function readNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (typeof value === "string" && value.trim()) {
      const n = Number(value)
      return Number.isFinite(n) ? n : null
    }
    return null
  }

  function usd(amount) {
    return "$" + amount.toFixed(2)
  }

  function creditsLines(ctx, data) {
    const totalUsage = readNumber(data.total_usage)
    if (totalUsage === null) return []
    const used = Math.max(0, totalUsage)
    const totalCredits = Math.max(0, readNumber(data.total_credits) || 0)

    const lines = []
    if (totalCredits > 0) {
      lines.push(ctx.line.progress({
        label: "Credits",
        used,
        limit: totalCredits,
        format: { kind: "dollars" },
      }))
    }
    lines.push(ctx.line.text({ label: "Balance", value: usd(Math.max(0, totalCredits - used)) }))
    return lines
  }

  function keyLines(ctx, data) {
    const lines = []
    // A $0 period is a real zero, not missing data.
    const periods = [["usage_daily", "Today"], ["usage_weekly", "This Week"], ["usage_monthly", "This Month"]]
    for (const [field, label] of periods) {
      const amount = readNumber(data[field])
      if (amount !== null) lines.push(ctx.line.text({ label, value: usd(Math.max(0, amount)) }))
    }

    const limit = readNumber(data.limit)
    if (limit !== null && limit > 0) {
      const remaining = Math.max(0, readNumber(data.limit_remaining) || 0)
      lines.push(ctx.line.progress({
        label: "Key Limit",
        used: Math.max(0, limit - remaining),
        limit,
        format: { kind: "dollars" },
      }))
    }
    return lines
  }

  function probe(ctx) {
    const apiKey = loadApiKey(ctx)
    if (!apiKey) throw ERR_MISSING_KEY

    const credits = fetchData(ctx, CREDITS_URL, apiKey)
    const key = fetchData(ctx, KEY_URL, apiKey)

    let lines = []
    let plan = null
    if (credits.data) lines = lines.concat(creditsLines(ctx, credits.data))
    if (key.data) {
      lines = lines.concat(keyLines(ctx, key.data))
      if (typeof key.data.is_free_tier === "boolean") {
        plan = key.data.is_free_tier ? "Free tier" : "Pay as you go"
      }
    }
    if (lines.length > 0) return { plan, lines }

    if (credits.authFailure && key.authFailure) throw ERR_INVALID_KEY
    throw credits.error || key.error || ERR_INVALID_RESPONSE
  }

  globalThis.__openusage_plugin = { id: "openrouter", probe }
})()
