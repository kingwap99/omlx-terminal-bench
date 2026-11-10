function norm(cfg) {
  /* accept either the whole app config or just its .omlx section */
  return cfg && cfg.omlx ? cfg.omlx : cfg || {};
}

function headers(cfg) {
  cfg = norm(cfg);
  const h = { "content-type": "application/json" };
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

async function req(cfg, pathname, opts = {}) {
  const c = norm(cfg);
  const url = c.baseUrl.replace(/\/+$/, "") + pathname;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: headers(cfg),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`oMLX ${res.status} ${pathname}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export async function listModels(cfg) {
  const data = await req(cfg, "/v1/models");
  const models = (data?.data || []).filter((m) => m.object === "model" || m.id);
  return models.map((m) => ({
    id: m.id,
    maxModelLen: m.max_model_len ?? m.capabilities?.context_length ?? null,
    ownedBy: m.owned_by ?? null,
    apiTypes: m.api_types ?? null,
  }));
}

export async function modelsStatus(cfg) {
  try {
    const data = await req(cfg, "/v1/models/status");
    const map = {};
    for (const m of data?.models || []) {
      map[m.id] = {
        loaded: !!m.loaded,
        isLoading: !!m.is_loading,
        loadingStartedAt: m.loading_started_at ?? null,
        estimatedSize: m.estimated_size ?? null,
        actualSize: m.actual_size ?? null,
        maxContextWindow: m.max_context_window ?? null,
        maxTokens: m.max_tokens ?? null,
        modelType: m.model_type ?? null,
        pinned: !!m.pinned,
      };
    }
    return { byModel: map, finalCeiling: data?.final_ceiling ?? null, currentModelMemory: data?.current_model_memory ?? null, loadedCount: data?.loaded_count ?? null };
  } catch {
    return { byModel: {} };
  }
}

export async function health(cfg) {
  return req(cfg, "/health", { timeoutMs: 8000 });
}

export async function deviceInfo(cfg) {
  return req(cfg, "/admin/api/device-info", { timeoutMs: 8000 });
}

export async function serverStats(cfg) {
  return req(cfg, "/admin/api/stats", { timeoutMs: 8000 });
}

export async function loadModel(cfg, id) {
  return req(cfg, `/v1/models/${encodeURIComponent(id)}/load`, { method: "POST", timeoutMs: 30000 });
}

export async function unloadModel(cfg, id) {
  return req(cfg, `/v1/models/${encodeURIComponent(id)}/unload`, { method: "POST", timeoutMs: 30000 });
}

export async function preloadCheck(cfg, id, timeoutMs = 600000) {
  const t0 = Date.now();
  const data = await req(
    cfg,
    "/v1/chat/completions",
    {
      method: "POST",
      timeoutMs,
      body: {
        model: id,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 4,
        stream: false,
      },
    }
  );
  return { ok: true, seconds: (Date.now() - t0) / 1000, model: data?.model ?? id };
}

/* Snapshot of everything we can record about the benchmark host. */
export async function machineSnapshot(cfg) {
  const snap = { capturedAt: new Date().toISOString(), source: norm(cfg).baseUrl };
  try {
    const info = await deviceInfo(cfg);
    snap.chip = [info.chip_name, info.chip_variant].filter(Boolean).join(" ");
    snap.chipName = info.chip_name ?? null;
    snap.chipVariant = info.chip_variant ?? null;
    snap.memoryGb = info.memory_gb ?? null;
    snap.gpuCores = info.gpu_cores ?? null;
  } catch (e) {
    snap.deviceInfoError = String(e.message || e);
  }
  try {
    const st = await serverStats(cfg);
    snap.omlxVersion = st.version ?? null;
    snap.engines = st.engines ?? null;
    snap.uptimeSecondsAtCapture = st.uptime_seconds ?? null;
  } catch (e) {
    snap.statsError = String(e.message || e);
  }
  try {
    const h = await health(cfg);
    snap.enginePool = h.engine_pool ?? null;
    snap.defaultModel = h.default_model ?? null;
  } catch {
    /* ignore */
  }
  try {
    const s = await modelsStatus(cfg);
    snap.loadedCountAtCapture = s.loadedCount ?? null;
  } catch {
    /* ignore */
  }
  return snap;
}
