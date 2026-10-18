(function () {
  const PROVIDER_ID = "opencode-go";
  const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
  const SESSION_MS = 5 * 60 * 60 * 1000;
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
  // OpenCode rounds resets to whole seconds and HTTP Date headers carry whole seconds, so a
  // zero-usage rolling reset within 2s of exactly 5h out is the "not started" placeholder.
  const PLACEHOLDER_RESET_TOLERANCE_MS = 2000;
  // OpenCode 2 imports auth.json into each channel database once; after that the database's
  // credential table is authoritative and a logout must not be revived by the stale file.
  const CREDENTIALS_IMPORTED_SQL =
    "SELECT 1 AS imported FROM migration WHERE id = '20260805200742_import_legacy_credentials' LIMIT 1";
  const GO_KEY_SQL = `
    SELECT json_extract(value, '$.key') AS key
    FROM credential
    WHERE integration_id = 'opencode-go' AND (active IS NULL OR active = 1)
    ORDER BY active DESC, time_updated DESC, id DESC
    LIMIT 1
  `;
  const MESSAGE_TABLES_SQL =
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'session_message')";
  // OpenCode 1 writes `message` rows with a flat providerID and role; OpenCode 2 writes
  // `session_message` rows with a `type` column and a nested `$.model`.
  const PROVIDER_ID_EXPR =
    "COALESCE(json_extract(data, '$.model.providerID'), json_extract(data, '$.providerID'))";
  const HISTORY_FILTERS = {
    message: "json_extract(data, '$.role') = 'assistant'",
    session_message:
      "(type = 'assistant' OR (type = 'compaction' AND json_extract(data, '$.status') = 'completed'))",
  };

  const ERR_NOT_DETECTED =
    "OpenCode Go not detected. Log in with OpenCode Go or use it locally first.";
  const ERR_CREDENTIALS_UNREADABLE =
    "Couldn't read OpenCode's credentials. Check the data directory's permissions or log into OpenCode Go again.";
  const ERR_UNAUTHORIZED = "OpenCode Go key was rejected. Log into OpenCode Go again.";
  const ERR_NO_SUBSCRIPTION = "No OpenCode Go subscription on this key.";
  const ERR_CONNECTION = "Usage request failed. Check your connection.";
  const ERR_INVALID_RESPONSE = "Usage response invalid. Try again later.";

  function trimSlashes(path) {
    return path.replace(/[\\/]+$/, "");
  }

  // Mirrors OpenCode: OPENCODE_DATA_DIR, then $XDG_DATA_HOME/opencode, then ~/.local/share/opencode.
  function dataDirectory(ctx) {
    const override = ctx.host.env.get("OPENCODE_DATA_DIR");
    if (typeof override === "string" && override.trim()) return trimSlashes(override.trim());
    const xdg = ctx.host.env.get("XDG_DATA_HOME");
    if (typeof xdg === "string" && xdg.trim()) return trimSlashes(xdg.trim()) + "/opencode";
    return "~/.local/share/opencode";
  }

  // OpenCode partitions its database by release channel (opencode.db, opencode-next.db, ...).
  // The .db suffix excludes the -wal/-shm sidecars.
  function databasePaths(ctx, dir) {
    let names;
    try {
      names = ctx.host.fs.listDir(dir);
    } catch (e) {
      if (ctx.host.fs.exists(dir)) ctx.host.log.warn("opencode data dir unreadable: " + String(e));
      return [];
    }
    if (!Array.isArray(names)) return [];
    return names
      .filter((name) => name.indexOf("opencode") === 0 && /\.db$/.test(name))
      .sort()
      .map((name) => dir + "/" + name);
  }

  function query(ctx, path, sql) {
    const raw = ctx.host.sqlite.query(path, sql);
    const rows = Array.isArray(raw) ? raw : ctx.util.tryParseJson(raw);
    if (!Array.isArray(rows)) throw new Error("sqlite query returned non-array result");
    return rows;
  }

  function isMissingTable(e) {
    return String(e && e.message ? e.message : e).toLowerCase().indexOf("no such table") !== -1;
  }

  function credentialsImported(ctx, path) {
    try {
      return query(ctx, path, CREDENTIALS_IMPORTED_SQL).length > 0;
    } catch (e) {
      if (isMissingTable(e)) return false;
      throw e;
    }
  }

  // Returns the opencode-go key or null. Throws ERR_CREDENTIALS_UNREADABLE when a database or
  // auth.json exists but can't be read, so broken storage is never mistaken for a logout.
  function loadGoKey(ctx, dir, dbPaths) {
    let hasCredentialTable = false;
    let failure = null;
    for (const path of dbPaths) {
      try {
        if (!credentialsImported(ctx, path)) continue;
        const rows = query(ctx, path, GO_KEY_SQL);
        hasCredentialTable = true;
        const key = rows[0] && typeof rows[0].key === "string" ? rows[0].key.trim() : "";
        if (key) return key;
      } catch (e) {
        if (isMissingTable(e)) continue;
        failure = e;
      }
    }
    if (failure) {
      ctx.host.log.warn("opencode credential table unreadable: " + String(failure));
      throw ERR_CREDENTIALS_UNREADABLE;
    }
    if (hasCredentialTable) return null;

    const authPath = dir + "/auth.json";
    if (!ctx.host.fs.exists(authPath)) return null;
    let parsed;
    try {
      parsed = ctx.util.tryParseJson(ctx.host.fs.readText(authPath));
    } catch (e) {
      ctx.host.log.warn("opencode auth read failed: " + String(e));
      throw ERR_CREDENTIALS_UNREADABLE;
    }
    if (!parsed || typeof parsed !== "object") {
      ctx.host.log.warn("opencode auth file is not valid json");
      throw ERR_CREDENTIALS_UNREADABLE;
    }
    const entry = parsed[PROVIDER_ID];
    const key = entry && typeof entry.key === "string" ? entry.key.trim() : "";
    return key || null;
  }

  function hasGoHistory(ctx, dbPaths) {
    for (const path of dbPaths) {
      try {
        const tables = query(ctx, path, MESSAGE_TABLES_SQL)
          .map((row) => row && row.name)
          .filter((name) => HISTORY_FILTERS[name]);
        if (tables.length === 0) continue;
        const sql = tables
          .map((table) => `
            SELECT 1 AS present FROM ${table}
            WHERE json_valid(data)
              AND ${HISTORY_FILTERS[table]}
              AND ${PROVIDER_ID_EXPR} = '${PROVIDER_ID}'
              AND json_type(data, '$.cost') IN ('integer', 'real')
          `)
          .join(" UNION ALL ") + " LIMIT 1";
        if (query(ctx, path, sql).length > 0) return true;
      } catch (e) {
        ctx.host.log.warn("opencode history probe failed for " + path + ": " + String(e));
      }
    }
    return false;
  }

  function readNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim()) {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  function windowLine(ctx, raw, label, periodMs, capturedAtMs, dropsPlaceholderReset) {
    const percent = raw && typeof raw === "object" ? readNumber(raw.percent) : null;
    const resetIso = raw && typeof raw === "object" ? ctx.util.toIso(raw.resetsAt) : null;
    const resetMs = resetIso ? Date.parse(resetIso) : NaN;
    if (percent === null || !Number.isFinite(resetMs)) throw ERR_INVALID_RESPONSE;

    const used = Math.max(0, Math.min(100, percent));
    const opts = { label, used, limit: 100, format: { kind: "percent" }, periodDurationMs: periodMs };
    // With no calls in the rolling window the API answers resetsAt = now + 5h on every request.
    // Drop that placeholder so the row reads "Not started" instead of a fake countdown. Weekly and
    // monthly resets are real calendar instants, so they keep theirs.
    const isPlaceholder = dropsPlaceholderReset && used === 0 &&
      Math.abs(resetMs - capturedAtMs - periodMs) <= PLACEHOLDER_RESET_TOLERANCE_MS;
    if (!isPlaceholder) opts.resetsAt = resetIso;
    return ctx.line.progress(opts);
  }

  function fetchGoMeters(ctx, apiKey) {
    let resp;
    try {
      resp = ctx.util.request({
        method: "GET",
        url: USAGE_URL,
        headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" },
        timeoutMs: 15000,
      });
    } catch (e) {
      ctx.host.log.warn("opencode go usage request failed: " + String(e));
      return { error: ERR_CONNECTION };
    }

    const body = ctx.util.tryParseJson(resp.bodyText);
    if (resp.status === 401) return { error: ERR_UNAUTHORIZED };
    if (resp.status === 403 && body && body.error && body.error.type === "EntitlementError") {
      return { error: ERR_NO_SUBSCRIPTION };
    }
    if (resp.status < 200 || resp.status >= 300) {
      return { error: "Usage request failed (HTTP " + String(resp.status) + "). Try again later." };
    }

    const usage = body && body.usage;
    if (!usage || typeof usage !== "object") return { error: ERR_INVALID_RESPONSE };
    // Compare against the server's clock when it sends one, so local clock skew can't break the
    // placeholder check.
    const headers = resp.headers || {};
    const serverMs = Date.parse(headers.date || headers.Date || "");
    const capturedAtMs = Number.isFinite(serverMs) ? serverMs : Date.now();
    try {
      return {
        lines: [
          windowLine(ctx, usage.rolling, "Session", SESSION_MS, capturedAtMs, true),
          windowLine(ctx, usage.weekly, "Weekly", WEEK_MS, capturedAtMs, false),
          windowLine(ctx, usage.monthly, "Monthly", MONTH_MS, capturedAtMs, false),
        ],
      };
    } catch (e) {
      return { error: typeof e === "string" ? e : ERR_INVALID_RESPONSE };
    }
  }

  function probe(ctx) {
    const dir = dataDirectory(ctx);
    const dbPaths = databasePaths(ctx, dir);

    let apiKey = null;
    let authError = null;
    try {
      apiKey = loadGoKey(ctx, dir, dbPaths);
    } catch (e) {
      authError = e;
    }

    if (apiKey) {
      const go = fetchGoMeters(ctx, apiKey);
      if (go.lines) return { plan: "Go", lines: go.lines };
      throw go.error;
    }
    if (authError) throw authError;

    // Go was used on this machine but there is no key to ask the usage API with.
    if (hasGoHistory(ctx, dbPaths)) {
      return {
        plan: null,
        lines: [ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" })],
      };
    }
    throw ERR_NOT_DETECTED;
  }

  globalThis.__openusage_plugin = { id: PROVIDER_ID, probe };
})();
