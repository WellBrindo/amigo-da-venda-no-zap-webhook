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

import { sendWhatsAppText } from "../services/meta/whatsapp.js";
import { listPlans, upsertPlan, setPlanActive, formatBRLFromCents } from "../services/plans.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
        <a href="/admin/window24h">/admin/window24h (JSON)</a><br/>
        <a href="/admin/window24h/touch">/admin/window24h/touch (touch)</a><br/>
        <a href="/admin/state-test/get">/admin/state-test/get (state demo)</a><br/>
      </div>
    </div>

    <hr/>
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

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Planos</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; }
    .card { max-width: 1100px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
    th { background: #fafafa; }
    input, textarea, button, select { font: inherit; }
    input, textarea, select { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 10px; }
    textarea { min-height: 70px; }
    button { padding: 9px 12px; border: 1px solid #ddd; border-radius: 10px; cursor: pointer; background: white; }
    button.primary { border-color: #222; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 900px) { .row { grid-template-columns: 1fr; } }
    .muted { color: #666; }
    .pill { display:inline-block; padding:2px 8px; border:1px solid #ddd; border-radius:999px; font-size: 12px; }
    .right { text-align:right; }
    .actions { display:flex; gap:8px; flex-wrap:wrap; }
    .topbar { display:flex; justify-content:space-between; align-items:center; gap: 12px; flex-wrap:wrap; }
    .err { color: #b00020; white-space: pre-wrap; }
    .ok { color: #0a7a2a; }
  </style>
</head>
<body>
  <div class="card">
    <div class="topbar">
      <div>
        <h2>💳 Planos</h2>
        <div class="muted">Edite preços/quotas/descrições sem mexer no código.</div>
      </div>
      <div>
        <a href="/admin">⬅ Voltar</a>
      </div>
    </div>

    <hr/>

    <h3>Criar / atualizar plano</h3>
    <div class="row">
      <div>
        <label>Código (ex: MELHOR_AMIGO)</label>
        <input id="code" placeholder="DE_VEZ_EM_QUANDO" />
      </div>
      <div>
        <label>Nome</label>
        <input id="name" placeholder="Melhor Amigo" />
      </div>
    </div>

    <div class="row" style="margin-top:12px;">
      <div>
        <label>Preço (R$)</label>
        <input id="price" placeholder="49.90" />
      </div>
      <div>
        <label>Quota mensal (descrições/mês)</label>
        <input id="quota" placeholder="200" />
      </div>
    </div>

    <div class="row" style="margin-top:12px;">
      <div>
        <label>Ativo?</label>
        <select id="active">
          <option value="true" selected>Sim</option>
          <option value="false">Não</option>
        </select>
      </div>
      <div>
        <label>Descrição</label>
        <input id="description" placeholder="200 descrições/mês" />
      </div>
    </div>

    <div style="margin-top:12px;" class="actions">
      <button class="primary" onclick="savePlan()">Salvar</button>
      <button onclick="clearForm()">Limpar</button>
    </div>

    <div id="msg" style="margin-top:10px;"></div>

    <hr/>

    <h3>Planos cadastrados</h3>
    <div class="muted">Dica: clique em “Editar” para preencher o formulário.</div>

    <table>
      <thead>
        <tr>
          <th>Code</th>
          <th>Nome</th>
          <th>Preço</th>
          <th>Quota</th>
          <th>Status</th>
          <th>Descrição</th>
          <th class="right">Ações</th>
        </tr>
      </thead>
      <tbody id="tbody">
        ${plans.map(p => `
          <tr data-code="${escapeHtml(p.code)}">
            <td><code>${escapeHtml(p.code)}</code></td>
            <td>${escapeHtml(p.name)}</td>
            <td>${escapeHtml(formatBRLFromCents(p.priceCents))}</td>
            <td>${escapeHtml(String(p.monthlyQuota))}</td>
            <td>${p.active ? '<span class="pill">Ativo</span>' : '<span class="pill">Inativo</span>'}</td>
            <td>${escapeHtml(p.description || "")}</td>
            <td class="right">
              <div class="actions" style="justify-content:flex-end;">
                <button onclick="editPlan('${escapeHtml(p.code)}')">Editar</button>
                ${p.active
                  ? `<button onclick="togglePlan('${escapeHtml(p.code)}', false)">Desativar</button>`
                  : `<button onclick="togglePlan('${escapeHtml(p.code)}', true)">Ativar</button>`
                }
              </div>
            </td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  </div>

<script>
function clearForm(){
  document.getElementById("code").value = "";
  document.getElementById("name").value = "";
  document.getElementById("price").value = "";
  document.getElementById("quota").value = "";
  document.getElementById("active").value = "true";
  document.getElementById("description").value = "";
  document.getElementById("msg").innerHTML = "";
}

async function editPlan(code){
  const r = await fetch("/admin/plans.json");
  const j = await r.json();
  const p = (j.plans || []).find(x => x.code === code);
  if (!p) return;

  document.getElementById("code").value = p.code;
  document.getElementById("name").value = p.name;
  document.getElementById("price").value = (Number(p.priceCents || 0) / 100).toFixed(2);
  document.getElementById("quota").value = String(p.monthlyQuota || 0);
  document.getElementById("active").value = p.active ? "true" : "false";
  document.getElementById("description").value = p.description || "";
  document.getElementById("msg").innerHTML = "<span class='muted'>Editando: "+p.code+"</span>";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function savePlan(){
  const code = document.getElementById("code").value.trim();
  const name = document.getElementById("name").value.trim();
  const price = document.getElementById("price").value.trim().replace(",", ".");
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
      const active = Boolean(req.body?.active);
      const plan = await setPlanActive(req.params.code, active);
      return res.json({ ok: true, plan });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });

  // -------------------- 24h WINDOW UI (simple) --------------------
  router.get("/window24h-ui", async (req, res) => {
    const count = await countWindow24hActive();
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Janela 24h</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; }
    .card { max-width: 980px; border: 1px solid #e5e5e5; border-radius: 12px; padding: 18px; }
    button { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid #ddd; cursor:pointer; background:white; }
    pre { background:#f6f6f6; padding: 12px; border-radius: 12px; overflow:auto; }
    .muted { color:#666; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🕒 Janela 24h</h2>
    <div class="muted">Usuários dentro da janela de 24 horas (útil para evitar custo de mensagem).</div>
    <p><a href="/admin">⬅ Voltar</a></p>
    <p><b>Ativos agora:</b> ${escapeHtml(String(count))}</p>

    <button onclick="load()">Carregar lista (JSON)</button>
    <pre id="out"></pre>
  </div>

<script>
async function load(){
  const r = await fetch("/admin/window24h");
  const j = await r.json();
  document.getElementById("out").textContent = JSON.stringify(j, null, 2);
}
</script>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // -------------------- Existing technical endpoints --------------------
  router.get("/state-test/set", async (req, res) => {
    const waId = String(req.query.waId || "5511960765975");
    await setUserStatus(waId, "ACTIVE");
    await setUserPlan(waId, "DE_VEZ_EM_QUANDO");
    await setUserQuotaUsed(waId, 1);
    await setUserTrialUsed(waId, 0);
    const user = await getUserSnapshot(waId);
    return res.json({ ok: true, action: "set-demo", user });
  });

  router.get("/state-test/reset-trial", async (req, res) => {
    const waId = String(req.query.waId || "5511960765975");
    await setUserStatus(waId, "TRIAL");
    await setUserPlan(waId, "");
    await setUserQuotaUsed(waId, 0);
    await setUserTrialUsed(waId, 0);
    await setLastPrompt(waId, "Quero mudar o texto");
    const user = await getUserSnapshot(waId);
    return res.json({ ok: true, action: "reset-trial", user });
  });

  router.get("/state-test/get", async (req, res) => {
    const waId = String(req.query.waId || "5511960765975");
    const user = await getUserSnapshot(waId);
    return res.json({ ok: true, user });
  });

  router.get("/window24h/touch", async (req, res) => {
    const waId = String(req.query.waId || "5511960765975");
    await touch24hWindow(waId, nowMs());
    const ts = await getLastInboundTs(waId);
    return res.json({
      ok: true,
      action: "touch24hWindow",
      user: {
        waId,
        lastInboundAtMs: ts,
        windowEndsAtMs: ts ? ts + 24 * 60 * 60 * 1000 : null,
      },
    });
  });

  router.get("/window24h", async (req, res) => {
    const items = await listWindow24hActive({ limit: 500 });
    return res.json({ ok: true, nowMs: nowMs(), count: items.length, returned: items.length, items });
  });

  router.get("/send-test", async (req, res) => {
    const waId = String(req.query.waId || "5511960765975");
    const text = String(req.query.text || "oi");
    const meta = await sendWhatsAppText(waId, text);
    return res.json({ ok: true, sentTo: waId, text, meta });
  });

  return router;
}
