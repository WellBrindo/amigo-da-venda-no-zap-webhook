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

import { sendWhatsAppText } from "../services/meta/whatsapp.js";

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
    .card{max-width:1040px; padding:16px 18px; border:1px solid #e5e7eb; border-radius:12px;}
    a{display:inline-block; margin:6px 10px 0 0; text-decoration:none; padding:10px 12px; border:1px solid #e5e7eb; border-radius:10px;}
    a:hover{background:#f3f4f6;}
    .muted{color:#6b7280; font-size:14px;}
    input{padding:10px 12px; border:1px solid #e5e7eb; border-radius:10px; width:320px;}
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
    <div class="muted">Redis ✅ | State ✅ | Janela 24h ✅ | Webhook ✅ | Envio WhatsApp ✅</div>

    <div class="row">
      <a href="/health">✅ Health</a>
      <a href="/health-redis">🧠 Health Redis</a>
      <a href="/admin/window24h">⏱ Janela 24h (JSON)</a>
    </div>

    <hr />

    <h3>🧪 Usuário (State + Janela)</h3>
    <div class="muted">Digite um waId e use os botões abaixo.</div>

    <div class="row">
      <input id="waid" placeholder="Ex: 5511999999999" />
      <button onclick="goSet()">Set (demo ACTIVE)</button>
      <button onclick="goGet()">Get (snapshot)</button>
      <button onclick="goTouch()">Touch 24h (simula inbound)</button>
      <button onclick="goResetTrial()">Resetar para TRIAL</button>
    </div>

    <div class="muted" style="margin-top:10px;">
      <b>Set (demo)</b> grava: <code>ACTIVE</code>, plano <code>DE_VEZ_EM_QUANDO</code>, quotaUsed <code>1</code>, trialUsed <code>0</code>.<br/>
      <b>Resetar para TRIAL</b> grava: <code>TRIAL</code>, plano vazio, quotaUsed <code>0</code>, trialUsed <code>0</code>.
    </div>

    <hr />

    <h3>📩 Enviar mensagem (teste)</h3>
    <div class="muted">Envia uma mensagem de texto para o waId informado usando WhatsApp Cloud API.</div>

    <div class="row">
      <input id="msg" placeholder="Texto da mensagem..." />
      <button onclick="goSend()">Enviar</button>
    </div>

    <div class="muted" style="margin-top:10px;">
      Isso chama: <code>/admin/send-test?waId=...&text=...</code>
    </div>

    <script>
      function getWaid(){
        return document.getElementById('waid').value.trim();
      }
      function getMsg(){
        return document.getElementById('msg').value.trim();
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
      function goResetTrial(){
        const waId = getWaid();
        if(!waId){ alert("Digite o waId"); return; }
        window.location.href = "/admin/state-test/reset-trial?waId=" + encodeURIComponent(waId);
      }
      function goSend(){
        const waId = getWaid();
        const text = getMsg();
        if(!waId){ alert("Digite o waId"); return; }
        if(!text){ alert("Digite a mensagem"); return; }
        window.location.href = "/admin/send-test?waId=" + encodeURIComponent(waId) + "&text=" + encodeURIComponent(text);
      }
    </script>
  </div>
</body>
</html>`);
  });

  // SET demo ACTIVE
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

  // RESET para TRIAL (para testar fluxo 1/5)
  router.get("/state-test/reset-trial", async (req, res) => {
    try {
      const waId = String(req.query.waId || "").trim();
      if (!waId) return res.status(400).json({ ok: false, error: "Missing waId" });

      await setUserStatus(waId, "TRIAL");
      await setUserPlan(waId, "");
      await setUserQuotaUsed(waId, 0);
      await setUserTrialUsed(waId, 0);

      const snap = await getUserSnapshot(waId);
      res.json({ ok: true, action: "reset-trial", user: snap });
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

  // Envio de mensagem (teste)
  router.get("/send-test", async (req, res) => {
    try {
      const waId = String(req.query.waId || "").trim();
      const text = String(req.query.text || "").trim();

      if (!waId) return res.status(400).json({ ok: false, error: "Missing waId" });
      if (!text) return res.status(400).json({ ok: false, error: "Missing text" });

      const data = await sendWhatsAppText({ to: waId, text });

      res.json({
        ok: true,
        sentTo: waId,
        text,
        meta: data,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
