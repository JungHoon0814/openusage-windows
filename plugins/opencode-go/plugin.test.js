import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCtx } from "../test-helpers.js";

const DATA_DIR = "~/.local/share/opencode";
const AUTH_PATH = DATA_DIR + "/auth.json";
const DB_PATH = DATA_DIR + "/opencode.db";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const NOW = "2026-03-06T12:00:00.000Z";

const loadPlugin = async () => {
  await import("./plugin.js");
  return globalThis.__openusage_plugin;
};

function setAuth(ctx, value = "go-key", path = AUTH_PATH) {
  ctx.host.fs.writeText(
    path,
    JSON.stringify({ "opencode-go": { type: "api-key", key: value } }),
  );
}

function addDb(ctx, path = DB_PATH) {
  ctx.host.fs.writeText(path, "");
}

const noSuchTable = (name) => new Error("sqlite error: no such table: " + name);

// Per-database SQL fakes. Each db: { imported, goKey, credentialError, tables, history }.
function mockSqlite(ctx, dbs) {
  ctx.host.sqlite.query.mockImplementation((path, sql) => {
    const db = dbs[path];
    if (!db) throw new Error("unexpected db " + path);
    const text = String(sql);
    if (text.includes("FROM migration")) {
      if (!db.imported) throw noSuchTable("migration");
      return JSON.stringify([{ imported: 1 }]);
    }
    if (text.includes("FROM credential")) {
      if (db.credentialError) throw db.credentialError;
      return JSON.stringify(db.goKey ? [{ key: db.goKey }] : []);
    }
    if (text.includes("sqlite_master")) {
      return JSON.stringify((db.tables || []).map((name) => ({ name })));
    }
    if (text.includes("SELECT 1 AS present")) {
      return JSON.stringify(db.history ? [{ present: 1 }] : []);
    }
    throw new Error("unexpected sql " + text);
  });
}

function usageBody(overrides = {}) {
  return {
    usage: Object.assign(
      {
        rolling: { percent: 25, resetsAt: "2026-03-06T14:30:00.000Z" },
        weekly: { percent: 40, resetsAt: "2026-03-09T00:00:00.000Z" },
        monthly: { percent: 7.5, resetsAt: "2026-03-25T07:53:16.000Z" },
      },
      overrides,
    ),
  };
}

function mockUsage(ctx, resp) {
  ctx.host.http.request.mockImplementation((req) => {
    if (req.url !== USAGE_URL) return { status: 404, bodyText: "" };
    return typeof resp === "function" ? resp(req) : resp;
  });
}

const ok = (body, headers = {}) => ({ status: 200, headers, bodyText: JSON.stringify(body) });

describe("opencode-go plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin;
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ships plugin metadata with links and expected line layout", () => {
    const manifest = JSON.parse(readFileSync("plugins/opencode-go/plugin.json", "utf8"));

    expect(manifest.id).toBe("opencode-go");
    expect(manifest.name).toBe("OpenCode Go");
    expect(manifest.links).toEqual([
      { label: "Console", url: "https://opencode.ai/auth" },
      { label: "Docs", url: "https://opencode.ai/docs/go/" },
    ]);
    expect(manifest.lines).toEqual([
      { type: "progress", label: "Session", scope: "overview", primaryOrder: 1 },
      { type: "progress", label: "Weekly", scope: "overview", period: "weekly" },
      { type: "progress", label: "Monthly", scope: "detail" },
    ]);
  });

  it("throws when neither a key nor local Go history is present", async () => {
    const ctx = makeCtx();
    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go not detected.");
  });

  it("maps the official usage API to Session / Weekly / Monthly meters", async () => {
    const ctx = makeCtx();
    setAuth(ctx);
    mockUsage(ctx, ok(usageBody()));

    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);

    const req = ctx.host.http.request.mock.calls[0][0];
    expect(req.method).toBe("GET");
    expect(req.headers.Authorization).toBe("Bearer go-key");
    expect(result.plan).toBe("Go");
    expect(result.lines).toEqual([
      expect.objectContaining({
        label: "Session", used: 25, limit: 100, format: { kind: "percent" },
        resetsAt: "2026-03-06T14:30:00.000Z", periodDurationMs: 5 * 60 * 60 * 1000,
      }),
      expect.objectContaining({
        label: "Weekly", used: 40, resetsAt: "2026-03-09T00:00:00.000Z",
        periodDurationMs: 7 * 24 * 60 * 60 * 1000,
      }),
      expect.objectContaining({
        label: "Monthly", used: 7.5, resetsAt: "2026-03-25T07:53:16.000Z",
        periodDurationMs: 30 * 24 * 60 * 60 * 1000,
      }),
    ]);
  });

  it("clamps percentages to 0..100", async () => {
    const ctx = makeCtx();
    setAuth(ctx);
    mockUsage(ctx, ok(usageBody({
      rolling: { percent: 140, resetsAt: "2026-03-06T14:30:00.000Z" },
      weekly: { percent: -5, resetsAt: "2026-03-09T00:00:00.000Z" },
    })));

    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    expect(result.lines[0].used).toBe(100);
    expect(result.lines[1].used).toBe(0);
  });

  it("drops the placeholder rolling reset of an unstarted session", async () => {
    const ctx = makeCtx();
    setAuth(ctx);
    // Server clock (Date header) is authoritative; local clock is 1 minute off.
    mockUsage(ctx, ok(
      usageBody({ rolling: { percent: 0, resetsAt: "2026-03-06T17:01:00.000Z" } }),
      { date: "Fri, 06 Mar 2026 12:01:00 GMT" },
    ));

    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    expect(result.lines[0].used).toBe(0);
    expect(result.lines[0].resetsAt).toBeUndefined();
    expect(result.lines[1].resetsAt).toBe("2026-03-09T00:00:00.000Z");
  });

  it("keeps the rolling reset for a sub-1% session that has started", async () => {
    const ctx = makeCtx();
    setAuth(ctx);
    mockUsage(ctx, ok(usageBody({ rolling: { percent: 0, resetsAt: "2026-03-06T15:00:00.000Z" } })));

    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);
    expect(result.lines[0].resetsAt).toBe("2026-03-06T15:00:00.000Z");
  });

  it("reports a rejected key on 401", async () => {
    const ctx = makeCtx();
    setAuth(ctx);
    mockUsage(ctx, { status: 401, bodyText: "" });

    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go key was rejected.");
  });

  it("reports a missing subscription on a 403 EntitlementError", async () => {
    const ctx = makeCtx();
    setAuth(ctx);
    mockUsage(ctx, {
      status: 403,
      bodyText: JSON.stringify({ type: "error", error: { type: "EntitlementError", message: "no" } }),
    });

    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow("No OpenCode Go subscription on this key.");
  });

  it("reports other HTTP errors with their status", async () => {
    const ctx = makeCtx();
    setAuth(ctx);
    mockUsage(ctx, { status: 403, bodyText: "<html>blocked</html>" });

    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow("Usage request failed (HTTP 403).");
  });

  it("reports connection failures and invalid bodies", async () => {
    const ctx = makeCtx();
    setAuth(ctx);
    mockUsage(ctx, () => {
      throw new Error("offline");
    });
    let plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow("Usage request failed. Check your connection.");

    delete globalThis.__openusage_plugin;
    vi.resetModules();
    const ctx2 = makeCtx();
    setAuth(ctx2);
    mockUsage(ctx2, ok(usageBody({ weekly: { percent: "lots", resetsAt: "nope" } })));
    plugin = await loadPlugin();
    expect(() => plugin.probe(ctx2)).toThrow("Usage response invalid.");
  });

  it("reads the key from an OpenCode 2 credential table once credentials are imported", async () => {
    const ctx = makeCtx();
    setAuth(ctx, "stale-file-key");
    addDb(ctx);
    mockSqlite(ctx, { [DB_PATH]: { imported: true, goKey: " db-key " } });
    mockUsage(ctx, ok(usageBody()));

    const plugin = await loadPlugin();
    plugin.probe(ctx);
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer db-key");
  });

  it("respects an OpenCode 2 logout instead of reviving the imported auth.json", async () => {
    const ctx = makeCtx();
    setAuth(ctx, "stale-file-key");
    addDb(ctx);
    mockSqlite(ctx, { [DB_PATH]: { imported: true, goKey: null } });

    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go not detected.");
    expect(ctx.host.http.request).not.toHaveBeenCalled();
  });

  it("keeps reading auth.json for OpenCode 1 databases without the import migration", async () => {
    const ctx = makeCtx();
    setAuth(ctx, "file-key");
    addDb(ctx);
    mockSqlite(ctx, { [DB_PATH]: { imported: false } });
    mockUsage(ctx, ok(usageBody()));

    const plugin = await loadPlugin();
    plugin.probe(ctx);
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer file-key");
  });

  it("checks every channel database, sorted, ignoring WAL sidecars", async () => {
    const ctx = makeCtx();
    const nextDb = DATA_DIR + "/opencode-next.db";
    addDb(ctx);
    addDb(ctx, nextDb);
    addDb(ctx, DATA_DIR + "/opencode.db-wal");
    mockSqlite(ctx, {
      [nextDb]: { imported: true, goKey: "next-key" },
      [DB_PATH]: { imported: true, goKey: null },
    });
    mockUsage(ctx, ok(usageBody()));

    const plugin = await loadPlugin();
    plugin.probe(ctx);

    const paths = [...new Set(ctx.host.sqlite.query.mock.calls.map((c) => c[0]))];
    expect(paths).toEqual([nextDb]);
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer next-key");
  });

  it("surfaces an unreadable credential table instead of treating it as logged out", async () => {
    const ctx = makeCtx();
    addDb(ctx);
    mockSqlite(ctx, { [DB_PATH]: { imported: true, credentialError: new Error("disk I/O error") } });

    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow("Couldn't read OpenCode's credentials.");
  });

  it("surfaces a malformed auth.json", async () => {
    const ctx = makeCtx();
    ctx.host.fs.writeText(AUTH_PATH, "{not json");

    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow("Couldn't read OpenCode's credentials.");
  });

  it("uses OPENCODE_DATA_DIR, then XDG_DATA_HOME", async () => {
    const ctx = makeCtx();
    ctx.host.env.get.mockImplementation((name) =>
      name === "OPENCODE_DATA_DIR" ? "D:/oc-data/" : name === "XDG_DATA_HOME" ? "D:/xdg" : null,
    );
    setAuth(ctx, "override-key", "D:/oc-data/auth.json");
    mockUsage(ctx, ok(usageBody()));
    let plugin = await loadPlugin();
    plugin.probe(ctx);
    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer override-key");

    delete globalThis.__openusage_plugin;
    vi.resetModules();
    const ctx2 = makeCtx();
    ctx2.host.env.get.mockImplementation((name) => (name === "XDG_DATA_HOME" ? "D:/xdg" : null));
    setAuth(ctx2, "xdg-key", "D:/xdg/opencode/auth.json");
    mockUsage(ctx2, ok(usageBody()));
    plugin = await loadPlugin();
    plugin.probe(ctx2);
    expect(ctx2.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer xdg-key");
  });

  it("shows a soft empty state when Go history exists but there is no key", async () => {
    const ctx = makeCtx();
    addDb(ctx);
    mockSqlite(ctx, { [DB_PATH]: { imported: false, tables: ["message", "session_message"], history: true } });

    const plugin = await loadPlugin();
    const result = plugin.probe(ctx);

    expect(result).toEqual({
      plan: null,
      lines: [{ type: "badge", label: "Status", text: "No usage data", color: "#a3a3a3" }],
    });
    const historySql = ctx.host.sqlite.query.mock.calls
      .map((c) => String(c[1]))
      .find((sql) => sql.includes("SELECT 1 AS present"));
    expect(historySql).toContain("FROM message");
    expect(historySql).toContain("FROM session_message");
    expect(historySql).toContain("json_extract(data, '$.model.providerID')");
    expect(historySql).toContain("type = 'compaction'");
  });

  it("does not probe history tables that don't exist", async () => {
    const ctx = makeCtx();
    addDb(ctx);
    mockSqlite(ctx, { [DB_PATH]: { imported: false, tables: [] } });

    const plugin = await loadPlugin();
    expect(() => plugin.probe(ctx)).toThrow("OpenCode Go not detected.");
    expect(
      ctx.host.sqlite.query.mock.calls.some((c) => String(c[1]).includes("SELECT 1 AS present")),
    ).toBe(false);
  });
});
