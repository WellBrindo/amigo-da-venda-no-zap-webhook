import { Router } from "express";
import {
  setUserStatus,
  setUserPlan,
  setUserQuotaUsed,
  setUserTrialUsed,
  getUserSnapshot,
} from "../services/state.js";

import {
  touch24hWindow,
  countWindow24hActive,
  listWindow24hActive,
  getLastInboundTs,
  nowMs,
} from "../services/window24h.js";

export function adminRouter() {
  const router = Router();

  router.get("/", (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin - Amigo das Vendas</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; margin:24px;}
    .card{max-width:920px; padding:16px 18px; border:1px solid #e5e7eb; border-radius:12px;}
    a{display:inline-block; margin:6px 10px 0 0; text-decoration:none; padding:10px 12px; border:1px solid #e5e7eb; border-radius:10px;}
    a:hover{background:#f3f4f6;}
    .muted{color:#6b7280; font-size:14px;}
    input{padding:10px 12px; border:1px solid #e5e7eb; border-radius:10px; width:300px;}
    button{padding:10px 12px; border:1px solid #e5e7eb; border-radius:10px; background:#fff; cursor:pointer;}
    button:hover{background:#f3f4f6;}
    .row{margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;}
    code{background:#f3f4f6; padding:2px 6px; border-radius:6px;}
    hr{margin:16px 0; border:none; border-top:1px solid #e5e7eb;}
  </style>
</head>
<body>
  <div class="card">
    <h2>📊 Admin (V16 Modular)</h2>
    <div class="muted">Teste modular: Redis ✅ | State ✅ | Janela 24h (agora) ✅</div>

    <div class="row">
      <a href="/health">✅ Health</a>
      <a href="/health-redis">🧠 Health Redis</a>
      <a href="/admin/window24h">⏱ Janela 24h (JSON)</a>
    </div>

    <hr />

    <h3>🧪 Teste de State (manual)</h3>
    <div class="muted">Digite um waId e use os botões abaixo.</div>

    <div class="row">
      <input id="waid" placeholder="Ex: 5511999999999" />
      <button onclick="goSet()">Set (demo)</button>
      <button onclick="goGet()">Get (snapshot)</button>
      <button onclick="goTouch()">Touch 24h (simula inbound)</button>
    </div>

    <div class="muted" style="margin-top:10px;">
      <b>Set</b> grava: <code>ACTIVE</code>, plano <code>DE_VEZ_EM_QUANDO</code>, quotaUsed <code>1</code>, trialUsed <code>0</code>.
      <br/>
      <b>Touch 24h</b> grava: <code>last_inbound_ts</code> e atualiza <code>z:window24h</code>.
    </div>

    <script>
      function getWaid(){
        const v = document.getElementById('waid').value.trim();
        return v;
      }
      function goSet(){
        const waId = getWaid();
        if(!waId){ alert("Digite o waId"); return; }
        window.location.href = "/admin/state-test/set?waId=" + encodeURIComponent(waId);
      }
      function goGet(){
        const waId = getWaid();
        if(!waId){ alert("Digite o waId"); return; }
        window.location.href = "/admin/state-test/get?waId=" + encodeURIComponent(waId);
      }
      function goTouch(){
        const waId = getWaid();
        if(!waId){ alert("Digite o waId"); return; }
        window.location.href = "/admin/window24h/touch?waId=" + encodeURIComponent(waId);
      }
    </script>
  </div>
</body>
</html>`);
  });

  // SET demo
  router.get("/state-test/set", async (req, res) => {
    try {
      const waId = String(req.query.waId || "").trim();
      if (!waId) return res.status(400).json({ ok: false, error: "Missing waId" });

      await setUserStatus(waId, "ACTIVE");
      await setUserPlan(waId, "DE_VEZ_EM_QUANDO");
      await setUserQuotaUsed(waId, 1);
      await setUserTrialUsed(waId, 0);

      const snap = await getUserSnapshot(waId);
      res.json({ ok: true, action: "set-demo", user: snap });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET snapshot
  router.get("/state-test/get", async (req, res) => {
    try {
      const waId = String(req.query.waId || "").trim();
      if (!waId) return res.status(400).json({ ok: false, error: "Missing waId" });

      const snap = await getUserSnapshot(waId);
      res.json({ ok: true, user: snap });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Touch window 24h (simula inbound)
  router.get("/window24h/touch", async (req, res) => {
    try {
      const waId = String(req.query.waId || "").trim();
      if (!waId) return res.status(400).json({ ok: false, error: "Missing waId" });

      const ts = nowMs();
      const r = await touch24hWindow(waId, ts);
      const lastInbound = await getLastInboundTs(waId);

      res.json({
        ok: true,
        action: "touch24hWindow",
        user: {
          waId,
          lastInboundAtMs: lastInbound,
          windowEndsAtMs: r.windowEndsAtMs,
        },
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // JSON: janela 24h
  router.get("/window24h", async (req, res) => {
    try {
      const limit = Number(req.query.limit || 500);
      const now = nowMs();
      const count = await countWindow24hActive(now);
      const waIds = await listWindow24hActive(now, limit);

      res.json({
        ok: true,
        nowMs: now,
        count,
        returned: waIds.length,
        items: waIds.map((waId) => ({ waId })),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
