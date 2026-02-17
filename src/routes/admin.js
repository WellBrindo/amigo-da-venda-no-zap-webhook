// src/routes/admin.js
import { Router } from "express";

import {
  setUserStatus,
  setUserPlan,
  setUserQuotaUsed,
  setUserTrialUsed,
  getUserSnapshot,
  setLastPrompt,
} from "../services/state.js";

import {
  touch24hWindow,
  countWindow24hActive,
  listWindow24hActive,
  getLastInboundTs,
  nowMs,
} from "../services/window24h.js";

import { listPlans, upsertPlan, setPlanActive } from "../services/plans.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeWaId(v) {
  return String(v || "").replace(/\D+/g, "");
}

export function adminRouter() {
  const router = Router();

  // -------------------- INDEX --------------------
  router.get("/", async (req, res) => {
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; }
    .card { max-width: 980px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; }
    a { display: inline-block; margin: 6px 0; }
    .muted { color: #666; }
    code { background: #f6f6f6; padding: 2px 6px; border-radius: 6px; }
    .grid { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
    @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
    .pill { border:1px solid #eee; border-radius: 10px; padding: 10px 12px; margin: 6px 0; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Admin</h2>
    <p class="muted">Menu</p>

    <div class="grid">
      <div>
        <h3>Produto</h3>
        <a href="/admin/plans">💳 Planos</a><br/>
        <a href="/admin/window24h-ui">🕒 Janela 24h</a><br/>
      </div>

      <div>
        <h3>Atalhos técnicos</h3>
        <a href="/health">✅ Health</a><br/>
        <a href="/admin/redis-ping">🧠 Redis Ping</a><br/>
        <a href="/admin/state-test/get">🧪 State: get</a><br/>
        <a href="/admin/state-test/reset-trial">♻️ State: reset trial</a><br/>
        <a href="/admin/state-test/set">⚡ State: set demo ACTIVE</a><br/>
      </div>
    </div>

    <hr/>
    <div class="pill">
      <div class="muted"><b>Dica:</b> pra resetar o seu número, use:</div>
      <div><code>/admin/state-test/reset-trial?waId=5511960765975</code></div>
    </div>

    <p class="muted">Observação: o Admin usa Basic Auth (senha = ADMIN_SECRET).</p>
  </div>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // -------------------- PLANS UI --------------------
  router.get("/plans", async (req, res) => {
    const plans = await listPlans({ includeInactive: true });

    const rows = plans
      .map((p) => {
        const price = (Number(p.priceCents || 0) / 100).toFixed(2);
        return `<tr>
  <td><code>${escapeHtml(p.code)}</code></td>
  <td>${escapeHtml(p.name)}</td>
  <td>R$ ${escapeHtml(price)}</td>
  <td>${escapeHtml(String(p.monthlyQuota ?? ""))}</td>
  <td>${p.active ? "✅" : "❌"}</td>
  <td>
    <button onclick="togglePlan('${escapeHtml(p.code)}', ${p.active ? "false" : "true"})">
      ${p.active ? "Desativar" : "Ativar"}
    </button>
  </td>
</tr>`;
      })
      .join("\n");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Planos</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; }
    .card { max-width: 980px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; }
    table { width:100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #eee; padding: 10px; text-align:left; }
    input, select, button { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid #ddd; }
    button { cursor:pointer; background:white; }
    .row { display:flex; gap: 10px; flex-wrap: wrap; }
    .muted { color:#666; }
    .ok { background:#e9ffe9; padding:10px; border-radius:10px; border:1px solid #bfe8bf; }
    .err { background:#ffe9e9; padding:10px; border-radius:10px; border:1px solid #e8bfbf; }
  </style>
</head>
<body>
  <div class="card">
    <h2>💳 Planos</h2>
    <p><a href="/admin">⬅ Voltar</a></p>

    <h3>Criar/Editar</h3>
    <div class="row">
      <input id="code" placeholder="code (ex: DE_VEZ_EM_QUANDO)" style="min-width:260px"/>
      <input id="name" placeholder="nome (ex: De Vez em Quando)" style="min-width:260px"/>
      <input id="price" placeholder="preço (ex: 24.90)" style="width:160px"/>
      <input id="quota" placeholder="quota/mês (ex: 20)" style="width:160px"/>
      <select id="active">
        <option value="true">ativo</option>
        <option value="false">inativo</option>
      </select>
      <input id="description" placeholder="descrição (opcional)" style="min-width:260px"/>
      <button onclick="save()">Salvar</button>
    </div>

    <div id="msg" class="muted" style="margin:10px 0;"></div>

    <h3>Lista</h3>
    <table>
      <thead>
        <tr>
          <th>Code</th><th>Nome</th><th>Preço</th><th>Quota</th><th>Ativo</th><th>Ação</th>
        </tr>
      </thead>
      <tbody>
        ${rows || "<tr><td colspan='6' class='muted'>Nenhum plano</td></tr>"}
      </tbody>
    </table>
  </div>

<script>
async function save(){
  const code = document.getElementById("code").value.trim();
  const name = document.getElementById("name").value.trim();
  const price = document.getElementById("price").value.trim();
  const quota = document.getElementById("quota").value.trim();
  const active = document.getElementById("active").value === "true";
  const description = document.getElementById("description").value.trim();

  const priceCents = Math.round(Number(price) * 100);
  const payload = { code, name, priceCents, monthlyQuota: Number(quota), active, description };

  const msgEl = document.getElementById("msg");
  msgEl.innerHTML = "<span class='muted'>Salvando...</span>";

  const r = await fetch("/admin/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const j = await r.json();
  if (!j.ok) {
    msgEl.innerHTML = "<div class='err'>"+(j.error || "Erro")+"</div>";
    return;
  }
  msgEl.innerHTML = "<div class='ok'>✅ Salvo: "+j.plan.code+"</div>";
  setTimeout(() => location.reload(), 300);
}

async function togglePlan(code, active){
  const msgEl = document.getElementById("msg");
  msgEl.innerHTML = "<span class='muted'>Atualizando...</span>";

  const r = await fetch("/admin/plans/"+encodeURIComponent(code)+"/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active }),
  });

  const j = await r.json();
  if (!j.ok) {
    msgEl.innerHTML = "<div class='err'>"+(j.error || "Erro")+"</div>";
    return;
  }
  msgEl.innerHTML = "<div class='ok'>✅ Atualizado: "+j.plan.code+"</div>";
  setTimeout(() => location.reload(), 300);
}
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/plans.json", async (req, res) => {
    try {
      const plans = await listPlans({ includeInactive: true });
      return res.json({ ok: true, plans });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post("/plans", async (req, res) => {
    try {
      const plan = await upsertPlan(req.body || {});
      return res.json({ ok: true, plan });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post("/plans/:code/active", async (req, res) => {
    try {
      const active = Boolean
