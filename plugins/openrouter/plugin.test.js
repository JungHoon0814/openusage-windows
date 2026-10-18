import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const CREDITS_URL = "https://openrouter.ai/api/v1/credits"
const KEY_URL = "https://openrouter.ai/api/v1/key"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

const CREDITS = { data: { total_credits: 25, total_usage: 7.5 } }
const KEY = {
  data: {
    label: "sk-or-v1-abc...xyz",
    usage_daily: 0,
    usage_weekly: 1.25,
    usage_monthly: 4.5,
    limit: 10,
    limit_remaining: 6,
    is_free_tier: false,
  },
}

const ok = (body) => ({ status: 200, bodyText: JSON.stringify(body) })

function mockApi(ctx, { credits = ok(CREDITS), key = ok(KEY) } = {}) {
  ctx.host.http.request.mockImplementation((req) => {
    if (req.url === CREDITS_URL) return typeof credits === "function" ? credits() : credits
    if (req.url === KEY_URL) return typeof key === "function" ? key() : key
    return { status: 404, bodyText: "" }
  })
}

const withEnv = (ctx, vars) => {
  ctx.host.env.get.mockImplementation((name) => (name in vars ? vars[name] : null))
}

const line = (result, label) => result.lines.find((l) => l.label === label)

describe("openrouter plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("throws when no key is configured", async () => {
    const ctx = makeCtx()
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("No OpenRouter API key.")
  })

  it("uses OPENROUTER_API_KEY as a Bearer token on both endpoints", async () => {
    const ctx = makeCtx()
    withEnv(ctx, { OPENROUTER_API_KEY: " sk-env " })
    mockApi(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const calls = ctx.host.http.request.mock.calls.map((c) => c[0])
    expect(calls.map((c) => c.url)).toEqual([CREDITS_URL, KEY_URL])
    expect(calls.every((c) => c.headers.Authorization === "Bearer sk-env")).toBe(true)
  })

  it("falls back to OPENROUTER_KEY", async () => {
    const ctx = makeCtx()
    withEnv(ctx, { OPENROUTER_KEY: "sk-alt" })
    mockApi(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer sk-alt")
  })

  it("prefers the config file over the environment", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText("~/.config/openusage/openrouter.json", JSON.stringify({ apiKey: "sk-file" }))
    withEnv(ctx, { OPENROUTER_API_KEY: "sk-env" })
    mockApi(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer sk-file")
  })

  it("reads api_key / key fields and plain-text key files", async () => {
    const cases = [
      ["~/.config/openusage/openrouter.json", JSON.stringify({ api_key: "sk-a" }), "sk-a"],
      ["~/.config/openrouter/key.json", JSON.stringify({ key: "sk-b" }), "sk-b"],
      ["~/.config/openrouter/key.json", "\n  sk-plain  \n", "sk-plain"],
    ]
    for (const [path, text, expected] of cases) {
      delete globalThis.__openusage_plugin
      vi.resetModules()
      const ctx = makeCtx()
      ctx.host.fs.writeText(path, text)
      mockApi(ctx)
      const plugin = await loadPlugin()
      plugin.probe(ctx)
      expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer " + expected)
    }
  })

  it("skips a JSON config without a key field and uses the next source", async () => {
    const ctx = makeCtx()
    ctx.host.fs.writeText("~/.config/openusage/openrouter.json", JSON.stringify({ other: "x" }))
    withEnv(ctx, { OPENROUTER_API_KEY: "sk-env" })
    mockApi(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer sk-env")
  })

  it("maps credits, balance, period spend, key limit, and plan", async () => {
    const ctx = makeCtx()
    withEnv(ctx, { OPENROUTER_API_KEY: "sk" })
    mockApi(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Pay as you go")
    expect(result.lines.map((l) => l.label)).toEqual([
      "Credits", "Balance", "Today", "This Week", "This Month", "Key Limit",
    ])
    expect(line(result, "Credits")).toMatchObject({
      type: "progress", used: 7.5, limit: 25, format: { kind: "dollars" },
    })
    expect(line(result, "Balance").value).toBe("$17.50")
    expect(line(result, "Today").value).toBe("$0.00")
    expect(line(result, "This Week").value).toBe("$1.25")
    expect(line(result, "This Month").value).toBe("$4.50")
    expect(line(result, "Key Limit")).toMatchObject({ used: 4, limit: 10, format: { kind: "dollars" } })
  })

  it("shows the free-tier plan and omits Key Limit for an uncapped key", async () => {
    const ctx = makeCtx()
    withEnv(ctx, { OPENROUTER_API_KEY: "sk" })
    mockApi(ctx, { key: ok({ data: { usage_daily: 0.1, limit: null, is_free_tier: true } }) })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Free tier")
    expect(line(result, "Key Limit")).toBeUndefined()
  })

  it("omits the Credits bar but keeps Balance when no credits were purchased", async () => {
    const ctx = makeCtx()
    withEnv(ctx, { OPENROUTER_API_KEY: "sk" })
    mockApi(ctx, { credits: ok({ data: { total_credits: 0, total_usage: 0 } }) })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(line(result, "Credits")).toBeUndefined()
    expect(line(result, "Balance").value).toBe("$0.00")
  })

  it("keeps credits metrics when the key endpoint fails", async () => {
    const ctx = makeCtx()
    withEnv(ctx, { OPENROUTER_API_KEY: "sk" })
    mockApi(ctx, { key: { status: 500, bodyText: "" } })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe(null)
    expect(result.lines.map((l) => l.label)).toEqual(["Credits", "Balance"])
  })

  it("keeps key metrics when the credits endpoint is forbidden", async () => {
    const ctx = makeCtx()
    withEnv(ctx, { OPENROUTER_API_KEY: "sk" })
    mockApi(ctx, { credits: { status: 403, bodyText: "" } })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(line(result, "Credits")).toBeUndefined()
    expect(line(result, "This Month").value).toBe("$4.50")
  })

  it("reports an invalid key when both endpoints reject it", async () => {
    const ctx = makeCtx()
    withEnv(ctx, { OPENROUTER_API_KEY: "sk" })
    mockApi(ctx, { credits: { status: 401, bodyText: "" }, key: { status: 401, bodyText: "" } })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("OpenRouter API key invalid.")
  })

  it("reports the HTTP status when no metrics load", async () => {
    const ctx = makeCtx()
    withEnv(ctx, { OPENROUTER_API_KEY: "sk" })
    mockApi(ctx, { credits: { status: 401, bodyText: "" }, key: { status: 502, bodyText: "" } })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("OpenRouter request failed (HTTP 502).")
  })

  it("reports a connection failure on network errors", async () => {
    const ctx = makeCtx()
    withEnv(ctx, { OPENROUTER_API_KEY: "sk" })
    const offline = () => {
      throw new Error("offline")
    }
    mockApi(ctx, { credits: offline, key: offline })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Couldn't reach OpenRouter.")
  })

  it("reports invalid data when responses lack a data object", async () => {
    const ctx = makeCtx()
    withEnv(ctx, { OPENROUTER_API_KEY: "sk" })
    mockApi(ctx, { credits: ok({ error: "x" }), key: { status: 200, bodyText: "not json" } })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("OpenRouter usage data unavailable.")
  })
})
