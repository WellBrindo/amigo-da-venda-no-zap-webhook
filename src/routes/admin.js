// src/routes/admin.js
import { Router } from "express";

import {
  setUserStatus,
  setUserPlan,
  setUserQuotaUsed,
  setUserTrialUsed,
  getUserSnapshot,
  listUsers,
  setTestimonialReviewStatus,
  clearLastPrompt, // ✅ V16.4.6: limpar via DEL (não SET "")
  setLastPrompt, // ✅ TESTE CONTROLADO: forçar setLastPrompt("")
  resetUserAsNew, // 🧹 reset total (número de teste)
  resetUserToTrial,
  getUserAdminEditableFields,
  updateUserAdminFields,
} from "../services/state.js";

import {
  touch24hWindow,
  countWindow24hActive,
  listWindow24hActive,
  getLastInboundTs,
  nowMs,
  clear24hWindowForUser,
} from "../services/window24h.js";

import {
  getGlobalDescriptionMetrics,
  getUserDescriptionMetrics,
  getGlobalLastNDays,
  getGlobalLastNMonths,
  getGlobalDaysRange,
  getUserLastNDays,
  getUserLastNMonths,
  getUserDaysRange,
  resetUserDescriptionMetrics,
  getFeedbackMetricsOverview,
  getMetricEventLastNDays,
  getConversionMetricsOverview,
  incMetricEvent,
} from "../services/metrics.js";

import { sendWhatsAppText } from "../services/meta/whatsapp.js";
import {
  listPlans,
  upsertPlan,
  setPlanActive,
  getPlansHealth,
  listSystemAlerts,
  getSystemAlertsCount,
  validateAdminUserPlanCode,
} from "../services/plans.js";
import {
  listSystemIncidents,
  getOpenIncidentsCount,
} from "../services/alerts.js";

import {
  listCoupons,
  getCoupon,
  upsertCoupon,
  setCouponActive,
  deleteCoupon,
  listCouponReservations,
  listCouponReportRows,
  getCouponUsageSummary,
} from "../services/coupons.js";

import {
  createCampaignAndDispatch,
  listCampaigns as listBroadcastCampaigns,
  getCampaign as getBroadcastCampaign,
  reprocessCampaignForActiveWindow,
} from "../services/broadcast.js";

import {
  createCampaign,
  updateCampaign,
  deleteCampaign,
  listCampaigns as listManagedCampaigns,
  getCampaign as getManagedCampaign,
  setCampaignActive,
  archiveCampaign,
  duplicateCampaign,
  simulateCampaignsForUser,
  CAMPAIGN_CATEGORY,
  CAMPAIGN_CHANNEL,
  CAMPAIGN_TRIGGER_TYPE,
  CAMPAIGN_MESSAGE_MODE,
  CAMPAIGN_CONFLICT_GROUP,
} from "../services/campaigns.js";

import {
  listCopyKeys,
  groupCatalog,
  getCopyResolved,
  getCopyRawGlobal,
  getCopyRawUser,
  setCopyGlobal,
  delCopyGlobal,
  setCopyUser,
  delCopyUser,
  DEFAULT_COPY,
} from "../services/copy.js";
import { listPayments, getSubscription, cancelSubscription, getAdminSubscriptionImpact } from "../services/asaas/client.js";
import { getAsaasWebhookAdminCoherenceWarnings } from "../services/asaas/webhook.js";
import { listAsaasEvents, recordAdminUserFinancialFieldChanged } from "../services/asaas/ledger.js";
import { getAdminUserEffectivePricingView } from "../services/pricing.js";

import { redisGet, redisSet, redisDel, getRedisHealthSnapshot } from "../services/redis.js";
import {
  logAdminAudit,
  listAdminAudit,
  getAdminAuditCount,
  logCampaignAudit,
  listCampaignAuditByCampaign,
  listOperationalAudit,
  getOperationalAuditCount,
  logUserAdminEditAudit,
} from "../services/audit.js";
import {
  listManagedAdmins,
  getManagedAdmin,
  upsertManagedAdmin,
  setManagedAdminActive,
  updateManagedAdminPassword,
  listAdminRoleDefinitions,
  listAdminPermissionDefinitions,
} from "../services/adminAccess.js";
import {
  getInternalUserIdByWaId,
  getUserIdentifiers,
  getPreferredOutboundRecipient,
  deleteIdentityForUser,
  listIdentityConflicts,
  getIdentityConflict,
  resolveIdentityConflictDecision,
  resolveAdminEditableUserRef,
} from "../services/identity.js";


function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}


// -----------------------------
// Concurrency-safe helper (evita tempestade de requests no Upstash em rotas do Admin)
// -----------------------------
async function mapLimit(items, limit, worker) {
  const arr = Array.isArray(items) ? items : [];
  const n = arr.length;
  if (n === 0) return [];
  const lim = Math.max(1, Math.min(Number(limit) || 1, n));
  const out = new Array(n);
  let cursor = 0;

  const runners = Array.from({ length: lim }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= n) break;
      out[i] = await worker(arr[i], i);
    }
  });

  await Promise.all(runners);
  return out;
}

function layoutBase({ title, activePath = "/admin", content = "", headExtra = "", scriptExtra = "" }) {
  const menu = renderSidebar(activePath);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title || "Admin")}</title>
  <link rel="icon" type="image/png" href="https://static.wixstatic.com/media/82d595_f278d1cb1322446fa19bae8399a2d502~mv2.png" />
  <style>
    :root{
      --bg:#f5f7fb;
      --card:#fff;
      --text:#111827;
      --muted:#6b7280;
      --border:#e5e7eb;
      --shadow: 0 6px 18px rgba(17,24,39,.06);
      --radius: 14px;
      --sidebar:#0f172a;
      --sidebar2:#111c35;
      --accent:#2563eb;
    }
    *{ box-sizing:border-box; }
    body{ margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:var(--bg); color:var(--text); }
    a{ color:var(--accent); text-decoration:none; }
    a:hover{ text-decoration:underline; }
    .app{ display:flex; min-height:100vh; }
    .side{
      width: 280px; flex: 0 0 280px;
      background: linear-gradient(180deg, var(--sidebar), var(--sidebar2));
      color:#e5e7eb; padding:18px 14px; position:sticky; top:0; height:100vh; overflow:auto;
      border-right: 1px solid rgba(255,255,255,.06);
    }
    .brand{ display:flex; gap:10px; align-items:center; padding:10px 10px 14px 10px; }
    .logo{
      width:36px; height:36px; border-radius: 10px;
      background: rgba(37,99,235,.18);
      display:flex; align-items:center; justify-content:center; font-weight:800;
    }
    .brand h1{ font-size:14px; margin:0; letter-spacing:.2px; }
    .brand .sub{ font-size:12px; color: rgba(229,231,235,.72); margin-top:2px; }
    .nav{ margin-top: 6px; }
    details{ border-radius: 12px; }
    details + details{ margin-top: 10px; }
    summary{
      cursor:pointer; list-style:none;
      padding:10px 10px; border-radius: 12px;
      display:flex; align-items:center; justify-content:space-between;
      color:#e5e7eb; font-weight:700; font-size:13px;
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.08);
    }
    summary::-webkit-details-marker{ display:none; }
    .nav a.item{
      display:flex; gap:10px; align-items:center;
      padding:9px 10px; margin:6px 2px 0 2px;
      border-radius: 12px;
      color: rgba(229,231,235,.86);
      border: 1px solid transparent;
      text-decoration:none;
    }
    .nav a.item:hover{ background: rgba(255,255,255,.08); }
    .nav a.item.active{
      background: rgba(37,99,235,.18);
      border-color: rgba(37,99,235,.35);
      color:#fff;
    }
    .nav .hint{ font-size:12px; color: rgba(229,231,235,.65); padding: 8px 10px 0 10px; }
    .main{ flex:1; padding: 22px 22px 40px 22px; }
    .topbar{
      display:flex; align-items:center; justify-content:space-between; gap:12px;
      max-width: 1180px; margin: 0 auto 16px auto;
    }
    .topbar h2{ margin:0; font-size:20px; letter-spacing:.2px; }
    .topbar .meta{ color:var(--muted); font-size:12px; }
    .wrap{ max-width: 1180px; margin: 0 auto; }
    .card{ background:var(--card); border:1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
    .card.pad{ padding:16px; }
    .grid{ display:grid; gap:12px; }
    .grid.cols2{ grid-template-columns: 1fr 1fr; }
    .grid.cols3{ grid-template-columns: repeat(3, 1fr); }
    @media (max-width: 980px){ .side{ display:none; } .grid.cols2,.grid.cols3{ grid-template-columns:1fr; } .main{ padding:16px; } }
    .kpi{ padding:14px; border-radius: 14px; border: 1px solid var(--border); background: #fff; }
    .kpi .t{ font-size:12px; color:var(--muted); font-weight:700; }
    .kpi .v{ font-size:26px; font-weight:800; margin-top:6px; }
    .muted{ color:var(--muted); }
    input, select, textarea, button{
      font: inherit; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border);
      background:#fff;
    }
    textarea{ width:100%; min-height: 140px; }
    button{ cursor:pointer; background:#fff; }
    button.primary{ background: rgba(37,99,235,.10); border-color: rgba(37,99,235,.35); }
    button.danger{ background: rgba(239,68,68,.10); border-color: rgba(239,68,68,.35); }
    .row{ display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    table{ width:100%; border-collapse: collapse; }
    th, td{ padding: 10px 8px; border-bottom: 1px solid var(--border); text-align:left; }
    code{ background:#f3f4f6; padding: 2px 6px; border-radius: 8px; }
    .pill{ display:inline-flex; gap:8px; align-items:center; padding: 6px 10px; border: 1px solid var(--border); border-radius: 999px; background:#fff; }
    
    .badge{ display:inline-flex; align-items:center; justify-content:center; padding: 2px 8px; border-radius:999px; border:1px solid var(--border); background:#fff; font-size:12px; font-weight:800; letter-spacing:.3px; }
    .badge.ok{ background:rgba(16,185,129,.12); color:#065f46; border-color:rgba(16,185,129,.28); }
    .badge.info{ background:rgba(37,99,235,.12); color:#1d4ed8; border-color:rgba(37,99,235,.28); }
    .badge.warn{ background:rgba(245,158,11,.14); color:#92400e; border-color:rgba(245,158,11,.28); }
    .badge.danger{ background:rgba(239,68,68,.12); color:#991b1b; border-color:rgba(239,68,68,.28); }
    .badge.soft{ font-weight:700; letter-spacing:0; }
.hr{ height:1px; background: var(--border); margin:14px 0; }
  </style>
  ${headExtra || ""}
</head>
<body>
  <div class="app">
    <aside class="side">
      ${menu}
    </aside>
    <main class="main">
      <div class="topbar">
        <div>
          <h2>${escapeHtml(title || "Admin")}</h2>
          <div class="meta">Amigo das Vendas · Admin</div>
        </div>
        <div class="meta"><a href="/health" style="color:inherit">/health</a> · <a href="/health-redis" style="color:inherit">/health-redis</a></div>
      </div>
      <div class="wrap">
        ${content || ""}
      </div>
    </main>
  </div>
  ${scriptExtra || ""}
  <script>
    (function(){
      if (typeof window === "undefined" || typeof fetch !== "function") return;
      const badgeEl = document.getElementById("identity-conflicts-badge");
      if (!badgeEl) return;
      fetch("/admin/identity-conflicts/pending-count", { headers: { "Accept": "application/json" } })
        .then((res) => res.ok ? res.json() : null)
        .then((data) => {
          const count = Number(data && data.count || 0) || 0;
          if (count > 0) {
            badgeEl.textContent = String(count > 99 ? "99+" : count);
            badgeEl.style.display = "inline-flex";
          } else {
            badgeEl.style.display = "none";
          }
        })
        .catch(() => { badgeEl.style.display = "none"; });
    })();
  </script>
</body>
</html>`;
}

function renderSidebar(activePath){
  const ap = String(activePath||"");
  const usersOpen = ap.startsWith("/admin/users") || ap.startsWith("/admin/window24h") || ap.startsWith("/admin/crm") || ap.startsWith("/admin/bulk") || ap.startsWith("/admin/feedback");
  const financeOpen = ap.startsWith("/admin/finance") || ap.startsWith("/admin/finance-");
  const systemOpen = ap.startsWith("/admin/alerts") || ap.startsWith("/admin/ops") || ap.startsWith("/admin/audit") || ap.startsWith("/admin/inconsistencies") || ap.startsWith("/admin/copy") || ap.startsWith("/admin/asaas-test") || ap.startsWith("/admin/settings") || ap.startsWith("/admin/admin-users") || ap.startsWith("/admin/identity-conflicts");
  const reportsOpen = ap.startsWith("/admin/reports");

  const item = (href, label, icon) => {
    const active = ap === href ? "active" : "";
    return `<a class="item ${active}" href="${href}"><span>${icon||"•"}</span><span>${escapeHtml(label)}</span></a>`;
  };
  const itemWithBadge = (href, label, icon, badgeId) => {
    const active = ap === href ? "active" : "";
    return `<a class="item ${active}" href="${href}"><span>${icon||"•"}</span><span style="display:flex; align-items:center; justify-content:space-between; width:100%; gap:8px;"><span>${escapeHtml(label)}</span><span id="${escapeHtml(badgeId)}" class="badge danger" style="display:none; min-width:24px; justify-content:center;">0</span></span></a>`;
  };

  // Cascata (details)
  return `
    <div class="brand">
      <div class="logo">AV</div>
      <div>
        <h1>Amigo das Vendas</h1>
        <div class="sub">Painel Admin</div>
      </div>
    </div>

    <nav class="nav">
      <div class="hint">Navegação</div>

      <details open>
        <summary>📊 Produto <span>▾</span></summary>
        ${item("/admin", "Início", "🏠")}
        ${item("/admin/dashboard", "Dashboard", "📈")}
        ${item("/admin/executive-ui", "Dashboard Executivo", "🧠")}
        ${item("/admin/plans", "Planos", "💳")}
        ${item("/admin/coupons", "Cupons", "🏷️")}
      </details>

      <details open>
        <summary>📣 Comunicação <span>▾</span></summary>
        ${item("/admin/broadcast-ui", "Broadcast", "📣")}
        ${item("/admin/campaigns-ui", "Campanhas", "📦")}
      </details>

      <details ${usersOpen ? "open" : ""}>
        <summary>👥 Usuários <span>▾</span></summary>
        ${item("/admin/crm-ui", "CRM de usuários", "🧭")}
        ${item("/admin/bulk-ui", "Ações em massa", "🧰")}
        ${item("/admin/feedback-ui", "Avaliações e depoimentos", "💚")}
        ${item("/admin/users-list-ui", "Lista de usuários", "📋")}
        ${item("/admin/users-ui", "Ações / Consulta", "👤")}
        ${item("/admin/window24h-ui", "Janela 24h", "🕒")}
      </details>

      <details ${financeOpen ? "open" : ""}>
        <summary>💰 Financeiro <span>▾</span></summary>
        ${item("/admin/finance-saas-ui", "Dashboard Financeiro SaaS", "📈")}
        ${item("/admin/finance-asaas-ui", "Asaas (Reconciliação)", "🧾")}
      </details>

      <details ${reportsOpen ? "open" : ""}>
        <summary>📑 Relatórios <span>▾</span></summary>
        ${item("/admin/reports-ui", "Relatórios e Exportação", "📑")}
        ${item("/admin/coupon-report-ui", "Relatório de Cupons", "🏷️")}
      </details>

      <details ${systemOpen ? "open" : ""}>
        <summary>⚙️ Sistema <span>▾</span></summary>
        ${item("/admin/alerts-ui", "Alertas", "🚨")}
        ${item("/admin/ops-ui", "Observabilidade Operacional", "🧠")}
        ${item("/admin/audit-ui", "Auditoria administrativa", "📚")}
        ${item("/admin/inconsistencies-ui", "Inconsistências", "🩺")}
        ${item("/admin/copy-ui", "Textos do Bot", "📝")}
        ${item("/admin/settings-ui", "Configurações Globais", "🛠️")}
        ${item("/admin/admin-users-ui", "Administradores e Acessos", "🛡️")}
        ${itemWithBadge("/admin/identity-conflicts-ui", "Conflitos de identidade", "🧩", "identity-conflicts-badge")}
        ${item("/admin/asaas-test-ui", "Asaas Teste", "🧪")}
      </details>

      <div class="hint" style="margin-top:10px;">Dica: o painel aceita o ADMIN_SECRET legado e também administradores gerenciados com perfis de acesso.</div>
    </nav>
  `;
}


async function resolveAdminUserRef(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return "";
  if (/^usr_\d+$/i.test(raw)) return raw;
  const mapped = await getInternalUserIdByWaId(raw).catch(() => "");
  return String(mapped || raw).trim();
}

async function requireUserRef(req) {
  const directUserId = String(req.query?.userId || "").trim();
  if (directUserId) return await resolveAdminUserRef(directUserId);

  const waId = String(req.query?.waId || "").trim();
  if (waId) return await resolveAdminUserRef(waId);

  const err = new Error("userId or waId required (ex: ?userId=usr_000001 or ?waId=5511...)");
  err.statusCode = 400;
  throw err;
}

async function requireBodyUserRef(req) {
  const directUserId = String(req.body?.userId || "").trim();
  if (directUserId) return await resolveAdminUserRef(directUserId);

  const waId = String(req.body?.waId || "").trim();
  if (waId) return await resolveAdminUserRef(waId);

  const err = new Error("userId or waId required");
  err.statusCode = 400;
  throw err;
}

const GLOBAL_SETTINGS_PREFIX = "cfg:global:";

const OPERATIONAL_ALERT_RECIPIENTS_KEY = `${GLOBAL_SETTINGS_PREFIX}alerts.operationalRecipients`;
const OPERATIONAL_ALERT_CHANNELS_KEY = `${GLOBAL_SETTINGS_PREFIX}alerts.operationalChannels`;
const OPERATIONAL_ALERT_COOLDOWNS_KEY = `${GLOBAL_SETTINGS_PREFIX}alerts.operationalCooldowns`;

const OPERATIONAL_ALERT_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const OPERATIONAL_ALERT_CHANNELS = ["WHATSAPP", "EMAIL"];

function normalizeOperationalAlertSeverity(value, fallback = "HIGH") {
  const normalized = String(value || "").trim().toUpperCase();
  return OPERATIONAL_ALERT_SEVERITIES.includes(normalized) ? normalized : fallback;
}

function normalizeOperationalAlertChannel(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return OPERATIONAL_ALERT_CHANNELS.includes(normalized) ? normalized : "";
}

function normalizeOperationalAlertRecipient(input = {}, index = 0) {
  const item = input && typeof input === "object" ? input : {};
  const channel = normalizeOperationalAlertChannel(item.channel);
  const contact = String(item.contact || "").trim();
  if (!channel || !contact) return null;
  return {
    id: String(item.id || `rcpt_${index + 1}`).trim(),
    name: String(item.name || item.label || contact).trim(),
    channel,
    contact,
    minSeverity: normalizeOperationalAlertSeverity(item.minSeverity || item.severity || "HIGH"),
    active: parseBoolInput(item.active, true),
  };
}

async function getOperationalAlertSettings() {
  const [recipientsRaw, channelsRaw, cooldownsRaw] = await Promise.all([
    redisGet(OPERATIONAL_ALERT_RECIPIENTS_KEY).catch(() => "[]"),
    redisGet(OPERATIONAL_ALERT_CHANNELS_KEY).catch(() => "{}"),
    redisGet(OPERATIONAL_ALERT_COOLDOWNS_KEY).catch(() => "{}"),
  ]);

  const recipientsParsed = (() => {
    try {
      const parsed = JSON.parse(String(recipientsRaw || "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();

  const channelsObj = (() => {
    try { return JSON.parse(String(channelsRaw || "{}")) || {}; } catch { return {}; }
  })();

  const cooldownsObj = (() => {
    try { return JSON.parse(String(cooldownsRaw || "{}")) || {}; } catch { return {}; }
  })();

  return {
    recipients: recipientsParsed.map((item, index) => normalizeOperationalAlertRecipient(item, index)).filter(Boolean),
    channels: {
      whatsapp: normalizeOperationalAlertSeverity(channelsObj.whatsapp || "CRITICAL", "CRITICAL"),
      email: normalizeOperationalAlertSeverity(channelsObj.email || "HIGH", "HIGH"),
      notifyResolution: parseBoolInput(channelsObj.notifyResolution, true),
    },
    cooldowns: {
      LOW: parseIntInput(cooldownsObj.LOW ?? cooldownsObj.low, 1800, { min: 0, max: 86400 }),
      MEDIUM: parseIntInput(cooldownsObj.MEDIUM ?? cooldownsObj.medium, 900, { min: 0, max: 86400 }),
      HIGH: parseIntInput(cooldownsObj.HIGH ?? cooldownsObj.high, 300, { min: 0, max: 86400 }),
      CRITICAL: parseIntInput(cooldownsObj.CRITICAL ?? cooldownsObj.critical, 60, { min: 0, max: 86400 }),
    },
  };
}

async function setOperationalAlertRecipients(recipients = []) {
  const normalized = (Array.isArray(recipients) ? recipients : [])
    .map((item, index) => normalizeOperationalAlertRecipient(item, index))
    .filter(Boolean);
  await redisSet(OPERATIONAL_ALERT_RECIPIENTS_KEY, JSON.stringify(normalized));
  return normalized;
}

async function setOperationalAlertMeta({ channels = null, cooldowns = null } = {}) {
  if (channels) {
    await redisSet(OPERATIONAL_ALERT_CHANNELS_KEY, JSON.stringify({
      whatsapp: normalizeOperationalAlertSeverity(channels.whatsapp || "CRITICAL", "CRITICAL"),
      email: normalizeOperationalAlertSeverity(channels.email || "HIGH", "HIGH"),
      notifyResolution: parseBoolInput(channels.notifyResolution, true),
    }));
  }
  if (cooldowns) {
    await redisSet(OPERATIONAL_ALERT_COOLDOWNS_KEY, JSON.stringify({
      LOW: parseIntInput(cooldowns.LOW ?? cooldowns.low, 1800, { min: 0, max: 86400 }),
      MEDIUM: parseIntInput(cooldowns.MEDIUM ?? cooldowns.medium, 900, { min: 0, max: 86400 }),
      HIGH: parseIntInput(cooldowns.HIGH ?? cooldowns.high, 300, { min: 0, max: 86400 }),
      CRITICAL: parseIntInput(cooldowns.CRITICAL ?? cooldowns.critical, 60, { min: 0, max: 86400 }),
    }));
  }
}

async function buildRedisOpsReadModel() {
  const snapshot = typeof getRedisHealthSnapshot === "function" ? (getRedisHealthSnapshot() || {}) : {};
  const incidents = await listSystemIncidents({ limit: 100 }).catch(() => []);
  const openCount = await getOpenIncidentsCount().catch(() => 0);
  const redisIncidents = (Array.isArray(incidents) ? incidents : []).filter((item) => {
    const hay = [
      item?.type,
      item?.module,
      item?.errorCode,
      item?.message,
      item?.impact,
    ].map((v) => String(v || "").toLowerCase()).join(" ");
    return hay.includes("redis");
  });
  const latestOpenIncident = redisIncidents
    .filter((item) => String(item?.status || "").toUpperCase() !== "RESOLVED")
    .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))[0] || null;

  const operational = await listOperationalAudit({ limit: 250 }).catch(() => []);
  const moduleMap = new Map();
  let lastRedisEvent = null;
  for (const item of Array.isArray(operational) ? operational : []) {
    const hay = [
      item?.event,
      item?.errorCode,
      item?.message,
      JSON.stringify(item?.meta || {}),
    ].map((v) => String(v || "").toLowerCase()).join(" ");
    if (!hay.includes("redis")) continue;
    const moduleName = String(item?.module || "unknown").trim() || "unknown";
    moduleMap.set(moduleName, Number(moduleMap.get(moduleName) || 0) + 1);
    if (!lastRedisEvent || String(item?.ts || "") > String(lastRedisEvent?.ts || "")) lastRedisEvent = item;
  }

  return {
    ok: true,
    snapshot,
    openIncidentsCount: Number(openCount || 0),
    latestOpenIncident,
    lastRedisEvent,
    recentByModule: Array.from(moduleMap.entries())
      .map(([module, count]) => ({ module, count }))
      .sort((a, b) => b.count - a.count || String(a.module).localeCompare(String(b.module)))
      .slice(0, 8),
  };
}


const GLOBAL_SETTINGS_CATALOG = [
  {
    key: "trial.maxDescriptions",
    label: "Limite de anúncios no teste gratuito",
    section: "Plano Trial",
    type: "int",
    defaultValue: 5,
    min: 1,
    max: 1000,
    help: "Define quantos anúncios um usuário pode gerar durante o período de teste gratuito. Se você aumentar esse número, os usuários poderão criar mais anúncios antes de precisar assinar um plano."
  },
  {
    key: "trial.maxRefinements",
    label: "Limite de melhorias do anúncio no teste",
    section: "Plano Trial",
    type: "int",
    defaultValue: 2,
    min: 0,
    max: 100,
    help: "Define quantas vezes o usuário pode pedir para o sistema melhorar ou ajustar um anúncio durante o teste gratuito."
  },
  {
    key: "flow.defaultTemplateMode",
    label: "Modo padrão de criação de anúncio",
    section: "Fluxo do Bot",
    type: "enum",
    defaultValue: "FIXED",
    options: ["FIXED", "FREE"],
    help: "Define como o anúncio será criado por padrão. FIXED = usa um modelo estruturado do sistema. FREE = permite texto mais livre e criativo."
  },
  {
    key: "flow.requireNameOnStart",
    label: "Solicitar nome do usuário no início",
    section: "Fluxo do Bot",
    type: "bool",
    defaultValue: true,
    help: "Se ativado, o bot sempre pedirá o nome do usuário antes de iniciar o fluxo de criação de anúncios."
  },
  {
    key: "feature.companyProfileWizard",
    label: "Ativar cadastro de dados da empresa",
    section: "Funcionalidades",
    type: "bool",
    defaultValue: true,
    help: "Se ativado, o sistema pedirá dados da empresa do usuário (nome do negócio, cidade, etc.) para melhorar os anúncios gerados."
  },
  {
    key: "feature.refinement",
    label: "Permitir melhoria automática de anúncios",
    section: "Funcionalidades",
    type: "bool",
    defaultValue: true,
    help: "Se ativado, o usuário pode pedir para o sistema melhorar ou ajustar o anúncio gerado."
  }
];


function settingRedisKey(key) {
  return `${GLOBAL_SETTINGS_PREFIX}${key}`;
}

function normalizeSettingValue(def, rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return def.defaultValue;
  }

  if (def.type === "bool") {
    if (typeof rawValue === "boolean") return rawValue;
    const v = String(rawValue).trim().toLowerCase();
    return v === "1" || v === "true" || v === "on" || v === "yes";
  }

  if (def.type === "int") {
    const n = Number(rawValue);
    let out = Number.isFinite(n) ? Math.trunc(n) : Number(def.defaultValue || 0);
    if (Number.isFinite(def.min)) out = Math.max(def.min, out);
    if (Number.isFinite(def.max)) out = Math.min(def.max, out);
    return out;
  }

  if (def.type === "enum") {
    const v = String(rawValue).trim();
    return Array.isArray(def.options) && def.options.includes(v) ? v : def.defaultValue;
  }

  return String(rawValue);
}

function serializeSettingValue(def, value) {
  if (def.type === "bool") return value ? "true" : "false";
  if (def.type === "int") return String(Math.trunc(Number(value) || 0));
  return String(value ?? "");
}

async function getResolvedGlobalSettings() {
  const rows = [];
  for (const def of GLOBAL_SETTINGS_CATALOG) {
    const raw = await redisGet(settingRedisKey(def.key));
    const resolved = normalizeSettingValue(def, raw);
    rows.push({
      ...def,
      value: resolved,
      storedValue: raw,
      isCustom: raw !== null && raw !== undefined,
    });
  }
  return rows;
}

function groupGlobalSettings(rows) {
  const groups = new Map();
  for (const row of rows) {
    const section = row.section || "Geral";
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(row);
  }
  return Array.from(groups.entries()).map(([section, items]) => ({ section, items }));
}

function limitText(value, max = 240) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function parseBasicAuthUser(req) {
  const auth = String(req?.headers?.authorization || "").trim();
  if (!auth.startsWith("Basic ")) return "admin";
  try {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const username = String(decoded.split(":")[0] || "").trim();
    return username || "admin";
  } catch (_) {
    return "admin";
  }
}

function getAdminActor(req) {
  const xfwd = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = xfwd || String(req?.ip || req?.socket?.remoteAddress || "").trim() || "unknown";
  const userAgent = limitText(req?.headers?.["user-agent"] || "", 180);
  return {
    type: "admin",
    user: parseBasicAuthUser(req),
    ip,
    userAgent,
  };
}

function buildAuditUserSnapshot(user) {
  const u = user || {};
  return {
    waId: String(u.waId || "").trim(),
    status: String(u.status || "").trim(),
    plan: String(u.plan || "").trim(),
    fullName: String(u.fullName || "").trim(),
    paymentMethod: String(u.paymentMethod || "").trim(),
    quotaUsed: Number(u.quotaUsed || 0),
    trialUsed: Number(u.trialUsed || 0),
    asaasCustomerId: String(u.asaasCustomerId || "").trim(),
    asaasSubscriptionId: String(u.asaasSubscriptionId || "").trim(),
    cardValidUntil: String(u.cardValidUntil || "").trim(),
    cardCanceledAt: String(u.cardCanceledAt || "").trim(),
  };
}

const CRM_USER_ADMIN_EDIT_STATUS = new Set([
  "TRIAL",
  "ACTIVE",
  "WAIT_NAME",
  "WAIT_PLAN",
  "WAIT_PAYMENT",
  "PAYMENT_PENDING",
  "WAIT_TEMPLATE_MODE",
  "WAIT_BILLING_CITY_STATE",
  "WAIT_BILLING_ADDRESS",
  "WAIT_COMPANY_PROFILE",
  "BLOCKED",
]);

const CRM_USER_ADMIN_EDIT_ALLOWED_FIELDS = new Set([
  "fullName",
  "status",
  "plan",
  "quotaUsed",
  "trialUsed",
  "templateMode",
  "paymentMethod",
  "billingCityState",
  "billingAddress",
  "doc",
  "docType",
  "docLast4",
  "asaasCustomerId",
  "asaasSubscriptionId",
  "cardValidUntil",
  "cardCanceledAt",
  "bizProfile",
  "pendingBizProfile",
  "activityMeta",
  "growthMeta",
  "selectedPlanCode",
  "selectedBillingCycle",
  "selectedCouponCode",
  "pricingQuote",
  "couponReservationId",
  "couponReservationCreatedAt",
  "checkoutCouponStatus",
  "checkoutDraft",
  "currentAdSession",
]);

function normalizeCrmEditString(value) {
  return String(value ?? "").trim();
}

function pickCrmUserAdminPatch(rawPatch = {}) {
  const src = rawPatch && typeof rawPatch === "object" && !Array.isArray(rawPatch) ? rawPatch : {};
  const patch = {};
  const rejectedFields = [];

  for (const [key, value] of Object.entries(src)) {
    if (!CRM_USER_ADMIN_EDIT_ALLOWED_FIELDS.has(key)) {
      rejectedFields.push({ field: key, reason: "field_not_allowed" });
      continue;
    }
    patch[key] = value;
  }

  return { patch, rejectedFields };
}

function validateCrmUserAdminPatch(patch = {}, planMap = new Map()) {
  const errors = [];
  const has = (field) => Object.prototype.hasOwnProperty.call(patch, field);

  if (has("status")) {
    const status = normalizeCrmEditString(patch.status).toUpperCase();
    if (status && !CRM_USER_ADMIN_EDIT_STATUS.has(status)) errors.push({ field: "status", reason: "invalid_status" });
  }
  if (has("templateMode")) {
    const templateMode = normalizeCrmEditString(patch.templateMode).toUpperCase();
    if (templateMode && !["FIXED", "FREE"].includes(templateMode)) errors.push({ field: "templateMode", reason: "invalid_template_mode" });
  }
  if (has("paymentMethod")) {
    const paymentMethod = normalizeCrmEditString(patch.paymentMethod).toUpperCase();
    if (paymentMethod && !["PIX", "CARD"].includes(paymentMethod)) errors.push({ field: "paymentMethod", reason: "invalid_payment_method" });
  }
  for (const field of ["quotaUsed", "trialUsed"]) {
    if (has(field)) {
      const n = Number(patch[field]);
      if (!Number.isFinite(n) || Math.trunc(n) < 0) errors.push({ field, reason: "invalid_non_negative_integer" });
    }
  }
  if (has("plan")) {
    const plan = normalizeCrmEditString(patch.plan).toUpperCase();
    if (plan && !planMap.has(plan)) errors.push({ field: "plan", reason: "plan_not_found" });
  }
  if (has("selectedPlanCode")) {
    const selectedPlanCode = normalizeCrmEditString(patch.selectedPlanCode).toUpperCase();
    if (selectedPlanCode && !planMap.has(selectedPlanCode)) errors.push({ field: "selectedPlanCode", reason: "plan_not_found" });
  }
  if (has("selectedBillingCycle")) {
    const selectedBillingCycle = normalizeCrmEditString(patch.selectedBillingCycle).toLowerCase();
    if (selectedBillingCycle && !["monthly", "annual"].includes(selectedBillingCycle)) errors.push({ field: "selectedBillingCycle", reason: "invalid_billing_cycle" });
  }
  const docType = patch?.doc && typeof patch.doc === "object" ? patch.doc.docType : patch.docType;
  const docLast4 = patch?.doc && typeof patch.doc === "object" ? patch.doc.docLast4 : patch.docLast4;
  if (has("doc") || has("docType")) {
    const t = normalizeCrmEditString(docType).toUpperCase();
    if (t && !["CPF", "CNPJ"].includes(t)) errors.push({ field: "docType", reason: "invalid_doc_type" });
  }
  if (has("doc") || has("docLast4")) {
    const last4 = normalizeCrmEditString(docLast4);
    if (last4 && !/^\d{4}$/.test(last4)) errors.push({ field: "docLast4", reason: "invalid_doc_last4" });
  }
  for (const field of ["cardValidUntil"]) {
    if (has(field)) {
      const value = normalizeCrmEditString(patch[field]);
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors.push({ field, reason: "invalid_date" });
    }
  }
  for (const field of ["cardCanceledAt", "couponReservationCreatedAt"]) {
    if (has(field)) {
      const value = normalizeCrmEditString(patch[field]);
      if (value && Number.isNaN(new Date(value).getTime())) errors.push({ field, reason: "invalid_timestamp" });
    }
  }

  return errors;
}

function buildCrmEditablePlanOptions(plans = []) {
  return (Array.isArray(plans) ? plans : [])
    .map((plan) => ({
      code: String(plan?.code || "").trim().toUpperCase(),
      name: String(plan?.name || plan?.label || plan?.code || "").trim(),
      active: plan?.active !== false,
    }))
    .filter((plan) => plan.code)
    .sort((a, b) => a.code.localeCompare(b.code));
}

function buildCrmUserEditAuditSnapshot(user) {
  const u = user || {};
  return {
    userId: String(u.userId || "").trim(),
    waId: String(u.waId || "").trim(),
    status: String(u.status || "").trim(),
    plan: String(u.plan || "").trim(),
    fullName: String(u.fullName || "").trim(),
    templateMode: String(u.templateMode || "").trim(),
    paymentMethod: String(u.paymentMethod || "").trim(),
    quotaUsed: Number(u.quotaUsed || 0),
    trialUsed: Number(u.trialUsed || 0),
    billingCityState: String(u.billingCityState || "").trim(),
    billingAddress: String(u.billingAddress || "").trim(),
    doc: u.doc && typeof u.doc === "object" ? {
      docType: String(u.doc.docType || "").trim(),
      docLast4: String(u.doc.docLast4 || "").trim(),
    } : { docType: "", docLast4: "" },
    asaasCustomerId: String(u.asaasCustomerId || "").trim(),
    asaasSubscriptionId: String(u.asaasSubscriptionId || "").trim(),
    cardValidUntil: String(u.cardValidUntil || "").trim(),
    cardCanceledAt: String(u.cardCanceledAt || "").trim(),
    selectedPlanCode: String(u.selectedPlanCode || "").trim(),
    selectedBillingCycle: String(u.selectedBillingCycle || "").trim(),
    selectedCouponCode: String(u.selectedCouponCode || "").trim(),
    checkoutCouponStatus: String(u.checkoutCouponStatus || "").trim(),
    hasBizProfile: !!u.bizProfile,
    hasPendingBizProfile: !!u.pendingBizProfile,
    hasPricingQuote: !!u.pricingQuote,
    hasCheckoutDraft: !!u.checkoutDraft,
    hasCurrentAdSession: !!u.currentAdSession,
  };
}

const CRM_USER_ADMIN_FINANCIAL_SENSITIVE_FIELDS = new Set([
  "plan",
  "paymentMethod",
  "asaasCustomerId",
  "asaasSubscriptionId",
  "cardValidUntil",
  "cardCanceledAt",
  "pricingQuote",
  "selectedPlanCode",
  "selectedBillingCycle",
  "selectedCouponCode",
  "couponReservationId",
  "couponReservationCreatedAt",
  "checkoutCouponStatus",
  "checkoutDraft",
]);

const CRM_USER_ADMIN_LEDGER_FINANCIAL_FIELDS = new Set([
  "plan",
  "paymentMethod",
  "asaasCustomerId",
  "asaasSubscriptionId",
  "cardValidUntil",
  "cardCanceledAt",
]);

function normalizeRejectedFieldItem(item) {
  if (!item || typeof item !== "object") {
    return { field: String(item || "").trim(), reason: "rejected" };
  }
  return {
    field: String(item.field || item.key || "").trim(),
    reason: String(item.reason || item.code || item.errorCode || "rejected").trim(),
    message: String(item.message || item.label || "").trim(),
  };
}

function formatRejectedFieldForAudit(item) {
  const normalized = normalizeRejectedFieldItem(item);
  return [normalized.field, normalized.reason, normalized.message].filter(Boolean).join(":");
}

function hasPatchOwn(patch, field) {
  return !!patch && typeof patch === "object" && Object.prototype.hasOwnProperty.call(patch, field);
}

function stripConflictBlockedFinancialFields(patch = {}, rejectedFields = []) {
  const next = { ...(patch && typeof patch === "object" ? patch : {}) };
  const rejected = Array.isArray(rejectedFields) ? [...rejectedFields] : [];
  for (const field of CRM_USER_ADMIN_FINANCIAL_SENSITIVE_FIELDS) {
    if (!hasPatchOwn(next, field)) continue;
    delete next[field];
    rejected.push({
      field,
      reason: "identity_conflict_sensitive_field_blocked",
      message: "Campo financeiro sensível bloqueado por conflito de identidade pendente.",
    });
  }
  return { patch: next, rejectedFields: rejected };
}

function mergeUserSnapshotForAdminPricing(before = {}, patch = {}) {
  const source = before && typeof before === "object" ? before : {};
  const updates = patch && typeof patch === "object" ? patch : {};
  const merged = { ...source, ...updates };
  if (hasPatchOwn(updates, "doc") && updates.doc && typeof updates.doc === "object") {
    merged.doc = {
      ...(source.doc && typeof source.doc === "object" ? source.doc : {}),
      ...updates.doc,
    };
  }
  return merged;
}

function summarizeAdminPricingViewForAudit(view = {}) {
  return {
    ok: Boolean(view?.ok),
    valid: Boolean(view?.valid),
    planCode: String(view?.planCode || ""),
    billingCycle: String(view?.billingCycle || ""),
    couponCode: String(view?.couponCode || ""),
    finalPrice: view?.finalPrice || null,
    warnings: Array.isArray(view?.warnings) ? view.warnings.slice(0, 10) : [],
  };
}

function summarizeAdminAsaasImpactForAudit(impact = {}) {
  return {
    ok: Boolean(impact?.ok),
    readOnly: Boolean(impact?.readOnly),
    hasAsaasCustomer: Boolean(impact?.hasAsaasCustomer),
    hasAsaasSubscription: Boolean(impact?.hasAsaasSubscription),
    changedFields: Array.isArray(impact?.changedFields) ? impact.changedFields : [],
    requiresManualFinancialAction: Boolean(impact?.impact?.requiresManualFinancialAction || impact?.impact?.requiresAsaasReview),
    warnings: Array.isArray(impact?.warnings) ? impact.warnings.slice(0, 10) : [],
  };
}

function summarizeAdminWebhookWarningsForAudit(warnings = {}) {
  return {
    ok: Boolean(warnings?.ok),
    readOnly: warnings?.readOnly !== false,
    changedFields: Array.isArray(warnings?.changedFields) ? warnings.changedFields : [],
    warnings: Array.isArray(warnings?.warnings) ? warnings.warnings.slice(0, 10) : [],
  };
}

function pickFinancialSnapshotForLedger(snapshot = {}) {
  const s = snapshot && typeof snapshot === "object" ? snapshot : {};
  return {
    plan: String(s.plan || "").trim(),
    paymentMethod: String(s.paymentMethod || "").trim(),
    asaasCustomerId: String(s.asaasCustomerId || "").trim(),
    asaasSubscriptionId: String(s.asaasSubscriptionId || "").trim(),
    cardValidUntil: String(s.cardValidUntil || "").trim(),
    cardCanceledAt: String(s.cardCanceledAt || "").trim(),
  };
}

function getChangedLedgerFinancialFields(changedFields = []) {
  return (Array.isArray(changedFields) ? changedFields : [])
    .map((field) => String(field || "").trim())
    .filter((field) => CRM_USER_ADMIN_LEDGER_FINANCIAL_FIELDS.has(field));
}

async function validateCrmAdminPlanFieldsWithCatalog(patch = {}) {
  const errors = [];
  const warnings = [];
  const nextPatch = { ...(patch && typeof patch === "object" ? patch : {}) };

  if (hasPatchOwn(nextPatch, "plan")) {
    const validation = await validateAdminUserPlanCode(nextPatch.plan, { allowEmpty: true, allowInactive: true });
    if (!validation?.ok) {
      errors.push({ field: "plan", reason: validation?.errorCode || "invalid_plan", message: validation?.message || "Plano inválido." });
    } else {
      nextPatch.plan = validation.planCode || "";
      if (validation.active === false && validation.exists) {
        warnings.push({ field: "plan", reason: "inactive_plan_allowed", message: validation.message || "Plano inativo permitido por compatibilidade administrativa." });
      }
    }
  }

  if (hasPatchOwn(nextPatch, "selectedPlanCode")) {
    const validation = await validateAdminUserPlanCode(nextPatch.selectedPlanCode, { allowEmpty: true, allowInactive: true });
    if (!validation?.ok) {
      errors.push({ field: "selectedPlanCode", reason: validation?.errorCode || "invalid_selected_plan", message: validation?.message || "Plano selecionado inválido." });
    } else {
      nextPatch.selectedPlanCode = validation.planCode || "";
      if (validation.active === false && validation.exists) {
        warnings.push({ field: "selectedPlanCode", reason: "inactive_selected_plan_allowed", message: validation.message || "Plano selecionado inativo permitido por compatibilidade administrativa." });
      }
    }
  }

  return { patch: nextPatch, errors, warnings };
}

function getAdminRequestSession(req) {
  if (req?.adminAuth && typeof req.adminAuth === "object") return req.adminAuth;
  const username = parseBasicAuthUser(req);
  return {
    username,
    displayName: username,
    role: "SUPER_ADMIN",
    permissions: ["*"],
    isLegacySharedSecret: true,
    authMode: "legacy_shared_secret",
  };
}

function adminHasPermission(session, permission) {
  const perms = Array.isArray(session?.permissions) ? session.permissions : [];
  if (session?.isLegacySharedSecret) return true;
  if (perms.includes("*")) return true;
  return perms.includes(String(permission || "").trim());
}

function getAdminRequiredPermission(pathname) {
  const path = String(pathname || "").trim();
  if (!path || path === "/" || path.startsWith("/dashboard") || path.startsWith("/executive")) return "dashboard.view";
  if (path.startsWith("/reports") || path.startsWith("/export") || path.startsWith("/coupon-report")) return "reports.view";
  if (path.startsWith("/users") || path.startsWith("/crm") || path.startsWith("/bulk") || path.startsWith("/window24h") || path.startsWith("/feedback")) return "users.manage";
  if (path.startsWith("/plans") || path.startsWith("/health-plans") || path.startsWith("/coupons")) return "plans.manage";
  if (path.startsWith("/finance") || path.startsWith("/api/finance") || path.startsWith("/asaas-test") || path.startsWith("/api/asaas")) return "finance.view";
  if (path.startsWith("/broadcast") || path.startsWith("/campaigns")) return "marketing.manage";
  if (path.startsWith("/copy")) return "copy.manage";
  if (path.startsWith("/settings")) return "settings.manage";
  if (path.startsWith("/alerts")) return "alerts.view";
  if (path.startsWith("/audit")) return "audit.view";
  if (path.startsWith("/inconsistencies")) return "inconsistencies.view";
  if (path.startsWith("/admin-users")) return "admin.manage";
  if (path.startsWith("/identity-conflicts")) return "admin.manage";
  if (path.startsWith("/state-test") || path.startsWith("/send-test")) return "admin.manage";
  return "dashboard.view";
}

function getPermissionMeta(permission) {
  const key = String(permission || "").trim();
  return (listAdminPermissionDefinitions() || []).find((item) => item.key === key) || {
    key,
    label: key || "Permissão",
    description: "Permissão operacional do Admin.",
  };
}

function renderAdminForbiddenPage(req, requiredPermission) {
  const session = getAdminRequestSession(req);
  const permissionMeta = getPermissionMeta(requiredPermission);
  const owned = Array.isArray(session?.permissions) ? session.permissions : [];
  return layoutBase({
    title: "Acesso restrito",
    activePath: "/admin",
    content: `
      <div class="card pad">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:16px;">
          <div>
            <h3 style="margin:0 0 8px 0;">🛡️ Acesso restrito</h3>
            <div class="muted">Seu perfil administrativo não possui autorização para acessar esta área.</div>
          </div>
          <div class="pill">Perfil atual: <b>${escapeHtml(String(session?.role || ""))}</b></div>
        </div>
        <div class="hr"></div>
        <div class="grid cols2">
          <div class="card pad">
            <div class="muted">Permissão necessária</div>
            <div style="font-size:18px; font-weight:800; margin-top:6px;">${escapeHtml(permissionMeta.label)}</div>
            <div class="muted" style="margin-top:6px;">${escapeHtml(permissionMeta.description || "")}</div>
            <div class="muted" style="font-size:12px; margin-top:6px;"><code>${escapeHtml(permissionMeta.key)}</code></div>
          </div>
          <div class="card pad">
            <div class="muted">Sessão atual</div>
            <div style="font-size:18px; font-weight:800; margin-top:6px;">${escapeHtml(String(session?.displayName || session?.username || "admin"))}</div>
            <div class="muted" style="margin-top:6px;">Usuário: <code>${escapeHtml(String(session?.username || ""))}</code></div>
            <div class="muted" style="margin-top:6px;">Autenticação: ${escapeHtml(String(session?.authMode || ""))}</div>
          </div>
        </div>
        <div class="hr"></div>
        <div class="muted" style="margin-bottom:8px;">Permissões recebidas nesta sessão</div>
        <div class="row">
          ${owned.length ? owned.map((item) => `<span class="badge soft">${escapeHtml(item)}</span>`).join("") : '<span class="badge warn">sem permissões</span>'}
        </div>
        <div class="hr"></div>
        <div class="row">
          <a class="pill" href="/admin">🏠 Voltar ao início</a>
          <a class="pill" href="/admin/admin-users-ui">🛡️ Administradores</a>
        </div>
      </div>
    `,
  });
}

async function safeRecordAdminAudit(req, entry) {
  try {
    await logAdminAudit({
      ...entry,
      actor: getAdminActor(req),
    });
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      tag: "admin_audit_failed",
      error: String(err?.message || err),
      action: String(entry?.action || ""),
      module: String(entry?.module || ""),
    }));
  }
}

async function safeRecordCampaignAudit(req, entry) {
  try {
    await logCampaignAudit({
      ...entry,
      actor: getAdminActor(req),
    });
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      tag: "campaign_admin_audit_failed",
      error: String(err?.message || err),
      action: String(entry?.action || ""),
      campaignId: String(entry?.campaignId || ""),
    }));
  }
}

function parseBoolInput(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

function parseIntInput(value, fallback = 0, { min = null, max = null } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  let n = Number(value);
  if (!Number.isFinite(n)) n = Number(fallback || 0);
  n = Math.trunc(n);
  if (Number.isFinite(min)) n = Math.max(min, n);
  if (Number.isFinite(max)) n = Math.min(max, n);
  return n;
}

function parseCsvList(value, { upper = false } = {}) {
  const source = Array.isArray(value) ? value.join(",") : String(value || "");
  const items = source
    .split(",")
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return Array.from(new Set(items.map((item) => (upper ? item.toUpperCase() : item))));
}

function campaignOptionEntries(record) {
  return Object.entries(record || {}).map(([value, label]) => ({ value, label }));
}

function renderSelectOptions(entries, currentValue = "") {
  const current = String(currentValue || "").trim();
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      const value = String(entry?.value || "").trim();
      const label = String(entry?.label || value).trim();
      const selected = value === current ? " selected" : "";
      return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");
}

function buildCampaignPayloadFromBody(body = {}) {
  return {
    code: String(body.code || "").trim(),
    name: String(body.name || "").trim(),
    description: String(body.description || "").trim(),
    category: String(body.category || "").trim(),
    channel: String(body.channel || "").trim(),
    messageMode: String(body.messageMode || "").trim(),
    copyKey: String(body.copyKey || "").trim(),
    inlineText: String(body.inlineText || "").trim(),
    priority: parseIntInput(body.priority, 100, { min: 0, max: 100000 }),
    conflictGroup: String(body.conflictGroup || "").trim(),
    triggerType: String(body.triggerType || "").trim(),
    triggerEvent: String(body.triggerEvent || "").trim(),
    delayMinutes: parseIntInput(body.delayMinutes, 0, { min: 0, max: 525600 }),
    cooldownHours: parseIntInput(body.cooldownHours, 24, { min: 0, max: 8760 }),
    sendOncePerUser: parseBoolInput(body.sendOncePerUser, false),
    maxSendsPerUser: parseIntInput(body.maxSendsPerUser, 1, { min: 1, max: 1000 }),
    requiredStatuses: parseCsvList(body.requiredStatuses, { upper: true }),
    excludedStatuses: parseCsvList(body.excludedStatuses, { upper: true }),
    requiredPlanCodes: parseCsvList(body.requiredPlanCodes, { upper: true }),
    excludedPlanCodes: parseCsvList(body.excludedPlanCodes, { upper: true }),
    requiresActivePlan: parseBoolInput(body.requiresActivePlan, false),
    requiresNoActivePlan: parseBoolInput(body.requiresNoActivePlan, false),
    requiresTrialEnded: parseBoolInput(body.requiresTrialEnded, false),
    requiresPlansViewed: parseBoolInput(body.requiresPlansViewed, false),
    requiresPaymentPending: parseBoolInput(body.requiresPaymentPending, false),
    requiresCheckoutStarted: parseBoolInput(body.requiresCheckoutStarted, false),
    requiresWindow24hOpen: parseBoolInput(body.requiresWindow24hOpen, true),
    minTrialUsed: parseIntInput(body.minTrialUsed, 0, { min: 0, max: 100000 }),
    maxTrialUsed: parseIntInput(body.maxTrialUsed, 0, { min: 0, max: 100000 }),
    minAdsCreated: parseIntInput(body.minAdsCreated, 0, { min: 0, max: 100000 }),
    maxAdsCreated: parseIntInput(body.maxAdsCreated, 0, { min: 0, max: 100000 }),
    minHoursSinceLastInbound: parseIntInput(body.minHoursSinceLastInbound, 0, { min: 0, max: 100000 }),
    maxHoursSinceLastInbound: parseIntInput(body.maxHoursSinceLastInbound, 0, { min: 0, max: 100000 }),
    minHoursSinceLastOutbound: parseIntInput(body.minHoursSinceLastOutbound, 0, { min: 0, max: 100000 }),
    maxHoursSinceLastOutbound: parseIntInput(body.maxHoursSinceLastOutbound, 0, { min: 0, max: 100000 }),
    blockIfInCheckout: parseBoolInput(body.blockIfInCheckout, false),
    blockIfPaymentPending: parseBoolInput(body.blockIfPaymentPending, false),
    blockIfBlocked: parseBoolInput(body.blockIfBlocked, true),
    businessHoursOnly: parseBoolInput(body.businessHoursOnly, false),
    timezone: String(body.timezone || "America/Sao_Paulo").trim(),
    startAt: String(body.startAt || "").trim(),
    endAt: String(body.endAt || "").trim(),
    isActive: parseBoolInput(body.isActive, true),
    notes: String(body.notes || "").trim(),
  };
}

function formatMoneyCents(cents) {
  const value = (Number(cents) || 0) / 100;
  try {
    return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  } catch (_) {
    return `R$ ${value.toFixed(2)}`;
  }
}

function normalizeExportFormat(value) {
  const format = String(value || "csv").trim().toLowerCase();
  if (format === "json") return "json";
  if (format === "excel" || format === "xlsx" || format === "xls") return "excel";
  if (format === "pdf") return "pdf";
  return "csv";
}

function csvCell(value) {
  if (value === null || value === undefined) return '""';
  const str = String(value).replace(/\r?\n/g, " ");
  return '"' + str.replace(/"/g, '""') + '"';
}

function rowsToCsv(rows, delimiter = ";") {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "";
  const sep = String(delimiter || ";");
  const headers = Array.from(new Set(list.flatMap((row) => Object.keys(row || {}))));
  const lines = [headers.map(csvCell).join(sep)];
  for (const row of list) {
    lines.push(headers.map((key) => csvCell(row?.[key] ?? "")).join(sep));
  }
  return lines.join("\n");
}

const EXPORT_FIELD_META = {
  waId: { label: "WA ID", width: 18, description: "Número do WhatsApp associado ao usuário dentro do sistema." },
  fullName: { label: "Nome", width: 24, description: "Nome completo salvo no cadastro do usuário." },
  status: { label: "Status", width: 14, description: "Estado atual do usuário no fluxo do produto, como TRIAL, ACTIVE ou BLOCKED." },
  plan: { label: "Plano", width: 18, description: "Código interno do plano atualmente vinculado ao usuário." },
  planName: { label: "Nome do plano", width: 22, description: "Nome comercial do plano do usuário." },
  planDescription: { label: "Descrição do plano", width: 26, description: "Descrição resumida do plano, normalmente com quota ou características principais." },
  paymentMethod: { label: "Pagamento", width: 14, description: "Método de pagamento salvo para o usuário, como CARD ou PIX." },
  quotaUsed: { label: "Uso mensal", width: 12, description: "Quantidade de descrições consumidas no ciclo mensal do plano." },
  trialUsed: { label: "Uso trial", width: 10, description: "Quantidade de descrições consumidas durante o período de teste." },
  templateMode: { label: "Template", width: 12, description: "Modo de geração do anúncio, como FIXED ou FREE." },
  billingCityState: { label: "Cidade/UF", width: 18, description: "Cidade e estado informados nos dados de cobrança do usuário." },
  billingAddress: { label: "Endereço", width: 24, description: "Endereço salvo para cobrança ou cadastro do usuário." },
  hasBizProfile: { label: "Perfil empresa", width: 12, description: "Indica se já existe perfil da empresa salvo para o usuário." },
  hasPendingBizProfile: { label: "Perfil pendente", width: 13, description: "Indica se há perfil da empresa pendente de confirmação ou complementação." },
  inWindow24h: { label: "Janela 24h", width: 11, description: "Indica se o usuário está com janela ativa de 24 horas no WhatsApp." },
  lastInboundTs: { label: "Últ. inbound", width: 15, description: "Timestamp da última mensagem recebida do usuário." },
  windowExpiresAt: { label: "Expira em", width: 15, description: "Timestamp estimado de expiração da janela de 24 horas." },
  issueCount: { label: "Qt. issues", width: 10, description: "Quantidade de inconsistências detectadas para o usuário." },
  issueKeys: { label: "Issues", width: 24, description: "Lista das chaves de inconsistência encontradas para o usuário." },
  asaasCustomerId: { label: "Cliente Asaas", width: 18, description: "Identificador do cliente no Asaas." },
  asaasSubscriptionId: { label: "Assinatura Asaas", width: 18, description: "Identificador da assinatura do usuário no Asaas." },
  cardValidUntil: { label: "Válido até", width: 14, description: "Data final de acesso após cancelamento de cartão, quando aplicável." },
  cardCanceledAt: { label: "Cancelado em", width: 14, description: "Data e hora em que a assinatura em cartão foi cancelada." },
  docType: { label: "Tipo doc", width: 10, description: "Tipo do documento salvo de forma mascarada, como CPF ou CNPJ." },
  docLast4: { label: "Doc final", width: 10, description: "Quatro últimos dígitos do documento mascarado." },
  bucketKey: { label: "Chave bucket", width: 16, description: "Chave interna da categoria de inconsistência." },
  label: { label: "Rótulo", width: 18, description: "Nome amigável do item ou métrica exportada." },
  severity: { label: "Severidade", width: 12, description: "Nível de criticidade da inconsistência ou evento." },
  description: { label: "Descrição", width: 30, description: "Texto explicativo resumindo o significado do item exportado." },
  id: { label: "ID", width: 14, description: "Identificador único do evento ou registro exportado." },
  ts: { label: "Timestamp", width: 22, description: "Data e hora em que o evento foi registrado." },
  module: { label: "Módulo", width: 18, description: "Módulo do admin que originou o evento." },
  action: { label: "Ação", width: 20, description: "Ação administrativa executada no sistema." },
  targetId: { label: "Alvo ID", width: 16, description: "Identificador do alvo principal afetado pela ação." },
  targetLabel: { label: "Alvo", width: 20, description: "Nome amigável do alvo afetado pela ação." },
  summary: { label: "Resumo", width: 28, description: "Resumo curto da ação ou do registro exportado." },
  actorUser: { label: "Admin", width: 18, description: "Usuário do painel que executou a ação." },
  actorIp: { label: "IP", width: 16, description: "Endereço IP associado à ação administrativa." },
  actorType: { label: "Tipo ator", width: 12, description: "Tipo do ator que originou o evento, normalmente admin." },
  before: { label: "Antes", width: 24, description: "Estado anterior resumido antes da ação." },
  after: { label: "Depois", width: 24, description: "Estado posterior resumido depois da ação." },
  meta: { label: "Meta", width: 24, description: "Metadados adicionais registrados junto ao evento." },
  section: { label: "Seção", width: 16, description: "Seção do relatório executivo à qual a métrica pertence." },
  metric: { label: "Métrica", width: 22, description: "Nome da métrica exportada." },
  value: { label: "Valor", width: 20, description: "Valor associado à métrica exportada." },
};

function humanizeHeader(key) {
  return String(key || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (m) => m.toUpperCase());
}

function getExportFieldMeta(key) {
  const normalized = String(key || '').trim();
  const meta = EXPORT_FIELD_META[normalized] || {};
  return {
    key: normalized,
    label: meta.label || humanizeHeader(normalized),
    width: Math.max(8, Math.min(Number(meta.width || 16), 32)),
    description: meta.description || ('Descrição do campo ' + humanizeHeader(normalized) + '.'),
  };
}

function buildGlossaryRows(headers) {
  return (Array.isArray(headers) ? headers : []).map((header) => {
    const meta = getExportFieldMeta(header);
    return { campo: meta.label, chave: meta.key, descricao: meta.description };
  });
}

function rowsToHtmlTable(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return '<table><tr><td>Sem dados</td></tr></table>';
  const headers = Array.from(new Set(list.flatMap((row) => Object.keys(row || {}))));
  const thead = '<tr>' + headers.map((header) => '<th style="background:#eef2ff; border:1px solid #cbd5e1; padding:6px 8px; text-align:left;">' + escapeHtml(getExportFieldMeta(header).label) + '</th>').join('') + '</tr>';
  const tbody = list.map((row) => '<tr>' + headers.map((header) => '<td style="border:1px solid #cbd5e1; padding:6px 8px; vertical-align:top;">' + escapeHtml(row?.[header] ?? '') + '</td>').join('') + '</tr>').join('');
  return '<table style="border-collapse:collapse; width:100%; font-family:Arial,sans-serif; font-size:12px;">' + thead + tbody + '</table>';
}

function rowsToExcelXml(rows, title = 'Exportação') {
  const list = Array.isArray(rows) ? rows : [];
  const headers = Array.from(new Set(list.flatMap((row) => Object.keys(row || {}))));
  const glossaryHtml = rowsToHtmlTable(buildGlossaryRows(headers));
  const html = rowsToHtmlTable(list);
  return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">' +
    '<head><meta charset="utf-8" /><title>' + escapeHtml(title) + '</title></head>' +
    '<body>' +
    '<h2 style="font-family:Arial,sans-serif; margin-bottom:6px;">' + escapeHtml(title) + '</h2>' +
    '<div style="font-family:Arial,sans-serif; color:#475569; margin-bottom:14px;">Gerado em ' + escapeHtml(new Date().toLocaleString('pt-BR')) + '</div>' +
    '<h3 style="font-family:Arial,sans-serif; margin:16px 0 8px;">Dicionário dos campos</h3>' + glossaryHtml +
    '<h3 style="font-family:Arial,sans-serif; margin:16px 0 8px;">Dados exportados</h3>' + html +
    '</body></html>';
}

function pdfEscape(value) {
  const normalized = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2012\u2013\u2014\u2015]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2022/g, '*');
  return normalized.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function normalizePdfCell(value) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  return text || '—';
}

function wrapPdfText(text, width) {
  const max = Math.max(8, Number(width || 20));
  const raw = normalizePdfCell(text);
  if (raw.length <= max) return [raw];
  const words = raw.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if ((current + ' ' + word).length <= max) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  const safe = [];
  for (const line of lines) {
    if (line.length <= max) safe.push(line);
    else {
      for (let i = 0; i < line.length; i += max) safe.push(line.slice(i, i + max));
    }
  }
  return safe.length ? safe : ['—'];
}

function padPdfCell(value, width) {
  const raw = String(value ?? '');
  const max = Math.max(4, Number(width || 10));
  if (raw.length === max) return raw;
  if (raw.length < max) return raw.padEnd(max, ' ');
  if (max <= 2) return raw.slice(0, max);
  return raw.slice(0, max - 1) + '…';
}

function buildPdfColumnGroups(headers, maxChars = 132) {
  const all = (Array.isArray(headers) ? headers : []).map((header) => getExportFieldMeta(header));
  const pinnedKeys = ['waId', 'fullName', 'status'];
  const pinned = all.filter((item) => pinnedKeys.includes(item.key));
  const remaining = all.filter((item) => !pinnedKeys.includes(item.key));
  const base = pinned.reduce((acc, item) => acc + item.width + 3, 0);
  const groups = [];
  let current = [];
  let used = base;
  for (const item of remaining) {
    const size = item.width + 3;
    if (current.length && used + size > maxChars) {
      groups.push([...pinned, ...current]);
      current = [item];
      used = base + size;
    } else {
      current.push(item);
      used += size;
    }
  }
  if (current.length || !groups.length) groups.push([...pinned, ...current]);
  return groups.filter((group) => group.length);
}

function rowsToPdfBuffer(title, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const headers = list.length ? Array.from(new Set(list.flatMap((row) => Object.keys(row || {})))) : [];
  const glossaryRows = buildGlossaryRows(headers);
  const columnGroups = buildPdfColumnGroups(headers, 132);
  const pages = [];
  const pageLineLimit = 40;
  const pushPage = (titleLine, lines) => {
    const content = lines.length ? lines : ['Sem dados disponíveis.'];
    for (let i = 0; i < content.length; i += pageLineLimit) {
      pages.push({ title: titleLine, lines: content.slice(i, i + pageLineLimit) });
    }
  };

  if (!list.length) {
    pushPage(String(title || 'Exportação'), [
      'Sem dados disponíveis.',
      '',
      'Dicionário dos campos',
      'Este relatório não possui colunas disponíveis nesta exportação.',
    ]);
  } else {
    columnGroups.forEach((group, groupIndex) => {
      const groupTitle = String(title || 'Exportação') + ' · Tabela ' + (groupIndex + 1) + '/' + columnGroups.length;
      const headerLine = group.map((item) => padPdfCell(item.label, item.width)).join(' | ');
      const divider = group.map((item) => '-'.repeat(item.width)).join('-+-');
      const lines = [
        'Gerado em: ' + new Date().toLocaleString('pt-BR'),
        'Campos exibidos: ' + group.map((item) => item.label).join(', '),
        '',
        headerLine,
        divider,
      ];

      for (const row of list) {
        const wrappedCells = group.map((item) => wrapPdfText(row?.[item.key] ?? '', item.width));
        const rowHeight = Math.max(...wrappedCells.map((parts) => parts.length));
        for (let lineIndex = 0; lineIndex < rowHeight; lineIndex += 1) {
          const visualLine = group.map((item, idx) => padPdfCell(wrappedCells[idx][lineIndex] || '', item.width)).join(' | ');
          lines.push(visualLine);
        }
        lines.push(divider);
      }
      pushPage(groupTitle, lines);
    });

    const glossaryLines = [
      'Gerado em: ' + new Date().toLocaleString('pt-BR'),
      'Este dicionário explica o significado de cada campo exportado.',
      '',
    ];
    glossaryRows.forEach((item) => {
      const label = item.campo + ' (' + item.chave + '): ';
      const wrapped = wrapPdfText(label + item.descricao, 124);
      wrapped.forEach((line) => glossaryLines.push(line));
      glossaryLines.push('');
    });
    pushPage(String(title || 'Exportação') + ' · Dicionário dos campos', glossaryLines);
  }

  const pageWidth = 842;
  const pageHeight = 595;
  const startY = 560;
  const fontSize = 8;
  const left = 26;

  const objects = [];
  const addObject = (content) => {
    objects.push(content);
    return objects.length;
  };

  const fontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');
  const pageIds = [];
  for (const page of pages) {
    let stream = 'BT\n/F1 ' + fontSize + ' Tf\n' + (fontSize + 4) + ' TL\n' + left + ' ' + startY + ' Td\n';
    stream += '(' + pdfEscape(page.title) + ') Tj\n';
    page.lines.forEach((line) => {
      stream += 'T* (' + pdfEscape(line) + ') Tj\n';
    });
    stream += 'ET';
    const contentId = addObject('<< /Length ' + Buffer.byteLength(stream, 'utf8') + ' >>\nstream\n' + stream + '\nendstream');
    const pageId = addObject('<< /Type /Page /Parent PAGES_ID 0 R /MediaBox [0 0 ' + pageWidth + ' ' + pageHeight + '] /Resources << /Font << /F1 ' + fontId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>');
    pageIds.push(pageId);
  }

  const kids = pageIds.map((id) => id + ' 0 R').join(' ');
  const pagesId = addObject('<< /Type /Pages /Kids [' + kids + '] /Count ' + pageIds.length + ' >>');
  const catalogId = addObject('<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    const content = objects[i].replace('PAGES_ID', String(pagesId));
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += (i + 1) + ' 0 obj\n' + content + '\nendobj\n';
  }
  const xrefStart = Buffer.byteLength(pdf, 'utf8');
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n';
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalogId + ' 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF';
  return Buffer.from(pdf, 'utf8');
}

function globalBuildPlanMap(plans) {
  return new Map(
    (Array.isArray(plans) ? plans : [])
      .map((plan) => {
        const code = String(plan?.code || '').trim().toUpperCase();
        return code ? [code, plan] : null;
      })
      .filter(Boolean)
  );
}

function globalDetectUserInconsistencyKeys(snap, lastInboundTs, now, planMap) {
  const keys = [];
  const status = String(snap?.status || '').trim().toUpperCase();
  const planCode = String(snap?.plan || '').trim().toUpperCase();
  const paymentMethod = String(snap?.paymentMethod || '').trim().toUpperCase();
  const asaasCustomerId = String(snap?.asaasCustomerId || '').trim();
  const asaasSubscriptionId = String(snap?.asaasSubscriptionId || '').trim();
  const fullName = String(snap?.fullName || '').trim();
  const quotaUsed = Number(snap?.quotaUsed || 0);
  const trialUsed = Number(snap?.trialUsed || 0);
  const planMeta = planCode ? planMap.get(planCode) : null;
  const hasPendingBizProfile = !!(snap?.pendingBizProfile && typeof snap.pendingBizProfile === 'object');

  if (status === 'ACTIVE' && !planCode) keys.push('activeWithoutPlan');
  if (status === 'TRIAL' && planCode) keys.push('trialWithPlan');
  if (planCode && !planMeta) keys.push('planNotFound');
  if (planMeta && !planMeta.active) keys.push('inactivePlanInUse');
  if (paymentMethod && !asaasCustomerId) keys.push('paymentWithoutCustomer');
  if (asaasSubscriptionId && !asaasCustomerId) keys.push('subscriptionWithoutCustomer');
  if (status === 'ACTIVE' && !asaasSubscriptionId) keys.push('activeWithoutSubscription');
  if (quotaUsed < 0) keys.push('quotaNegative');
  if (trialUsed < 0) keys.push('trialNegative');
  if (status === 'TRIAL' && quotaUsed > 0) keys.push('trialWithQuota');
  if (!fullName) keys.push('noName');
  if (lastInboundTs > now) keys.push('futureInbound');
  if (status === 'WAIT_PLAN' && asaasSubscriptionId) keys.push('waitPlanWithSubscription');
  if (snap?.cardCanceledAt && !snap?.cardValidUntil) keys.push('cardCanceledWithoutValidUntil');
  if (hasPendingBizProfile) keys.push('pendingBizProfile');
  return keys;
}

async function enrichUserForExport(waId, planMap, now) {
  const [snap, lastInboundTsRaw] = await Promise.all([getUserSnapshot(waId), getLastInboundTs(waId)]);
  const lastInboundTs = Number(lastInboundTsRaw || 0);
  const windowExpiresAt = lastInboundTs ? lastInboundTs + 24 * 60 * 60 * 1000 : 0;
  const inWindow = lastInboundTs ? now - lastInboundTs < 24 * 60 * 60 * 1000 : false;
  const planCode = String(snap?.plan || '').trim().toUpperCase();
  const planMeta = planCode ? planMap.get(planCode) : null;
  const issueKeys = globalDetectUserInconsistencyKeys(snap, lastInboundTs, now, planMap);
  return {
    waId: String(waId || ''),
    fullName: String(snap?.fullName || ''),
    status: String(snap?.status || ''),
    plan: String(snap?.plan || ''),
    planName: String(planMeta?.name || ''),
    planDescription: String(planMeta?.description || ''),
    paymentMethod: String(snap?.paymentMethod || ''),
    quotaUsed: Number(snap?.quotaUsed || 0),
    trialUsed: Number(snap?.trialUsed || 0),
    templateMode: String(snap?.templateMode || ''),
    billingCityState: String(snap?.billingCityState || ''),
    billingAddress: String(snap?.billingAddress || ''),
    asaasCustomerId: String(snap?.asaasCustomerId || ''),
    asaasSubscriptionId: String(snap?.asaasSubscriptionId || ''),
    cardValidUntil: String(snap?.cardValidUntil || ''),
    cardCanceledAt: String(snap?.cardCanceledAt || ''),
    doc: snap?.doc || { docType: '', docLast4: '' },
    bizProfile: snap?.bizProfile || null,
    pendingBizProfile: snap?.pendingBizProfile || null,
    hasBizProfile: !!(snap?.bizProfile && typeof snap.bizProfile === 'object'),
    hasPendingBizProfile: !!(snap?.pendingBizProfile && typeof snap.pendingBizProfile === 'object'),
    inWindow,
    lastInboundTs,
    windowExpiresAt,
    issueKeys,
    issueCount: issueKeys.length,
    snapshot: snap,
  };
}

function buildGlobalInconsistencyBucket(label, severity, description = '') {
  return { label, severity, description, count: 0, items: [] };
}

async function collectInconsistenciesForExport() {
  const usersRaw = await listUsers();
  const waIds = Array.isArray(usersRaw) ? usersRaw.slice().sort() : [];
  const plans = await listPlans({ includeInactive: true });
  const planMap = globalBuildPlanMap(plans);
  const buckets = {
    activeWithoutPlan: buildGlobalInconsistencyBucket('Assinante sem plano', 'danger', 'Usuário está ativo, mas não tem nenhum plano salvo.'),
    trialWithPlan: buildGlobalInconsistencyBucket('Trial com plano salvo', 'warn', 'Usuário ainda está no teste, mas já aparece com um plano preenchido.'),
    planNotFound: buildGlobalInconsistencyBucket('Plano não encontrado', 'danger', 'O plano salvo no usuário não existe mais no catálogo do sistema.'),
    inactivePlanInUse: buildGlobalInconsistencyBucket('Plano desativado em uso', 'warn', 'O usuário está vinculado a um plano que hoje está desativado.'),
    paymentWithoutCustomer: buildGlobalInconsistencyBucket('Pagamento sem cadastro Asaas', 'warn', 'Há forma de pagamento definida, mas falta o código do cliente no Asaas.'),
    subscriptionWithoutCustomer: buildGlobalInconsistencyBucket('Assinatura sem cliente Asaas', 'danger', 'Existe assinatura salva, mas não existe cliente correspondente no Asaas.'),
    activeWithoutSubscription: buildGlobalInconsistencyBucket('Assinante sem assinatura Asaas', 'danger', 'Usuário está ativo, mas não há assinatura registrada no Asaas.'),
    quotaNegative: buildGlobalInconsistencyBucket('Uso mensal negativo', 'danger', 'O contador de uso mensal ficou abaixo de zero, o que não deveria acontecer.'),
    trialNegative: buildGlobalInconsistencyBucket('Uso do trial negativo', 'danger', 'O contador de uso do teste ficou abaixo de zero, o que indica erro de dados.'),
    trialWithQuota: buildGlobalInconsistencyBucket('Trial usando quota de plano', 'warn', 'Usuário em teste aparece com consumo na quota mensal de assinante.'),
    noName: buildGlobalInconsistencyBucket('Usuário sem nome', 'info', 'Cadastro sem nome preenchido, o que dificulta suporte e cobrança.'),
    futureInbound: buildGlobalInconsistencyBucket('Mensagem com data futura', 'warn', 'A última mensagem recebida ficou registrada com horário no futuro.'),
    waitPlanWithSubscription: buildGlobalInconsistencyBucket('Aguardando plano com assinatura', 'warn', 'Usuário ainda está aguardando plano, mas já possui assinatura criada.'),
    cardCanceledWithoutValidUntil: buildGlobalInconsistencyBucket('Cancelado sem data final', 'warn', 'O cartão foi cancelado, mas não foi salva a data final de acesso.'),
    pendingBizProfile: buildGlobalInconsistencyBucket('Perfil da empresa pendente', 'info', 'Há dados da empresa aguardando confirmação ou finalização pelo usuário.'),
  };

  function pushIssue(bucketKey, snap, extra = {}) {
    const bucket = buckets[bucketKey];
    if (!bucket) return;
    bucket.items.push({
      waId: String(snap?.waId || extra.waId || ''),
      fullName: String(snap?.fullName || ''),
      status: String(snap?.status || ''),
      plan: String(snap?.plan || ''),
      paymentMethod: String(snap?.paymentMethod || ''),
      asaasCustomerId: String(snap?.asaasCustomerId || ''),
      asaasSubscriptionId: String(snap?.asaasSubscriptionId || ''),
      quotaUsed: Number(snap?.quotaUsed || 0),
      trialUsed: Number(snap?.trialUsed || 0),
      cardValidUntil: String(snap?.cardValidUntil || ''),
      cardCanceledAt: String(snap?.cardCanceledAt || ''),
      ...extra,
    });
    bucket.count = bucket.items.length;
  }

  const now = nowMs();
  await mapLimit(waIds, 20, async (waId) => {
    const user = await enrichUserForExport(waId, planMap, now);
    const snap = user.snapshot || {};
    const planMeta = user.plan ? planMap.get(String(user.plan || '').trim().toUpperCase()) : null;
    for (const key of user.issueKeys || []) {
      const extra = {};
      if (key === 'inactivePlanInUse') extra.planName = String(planMeta?.name || '');
      if (key === 'futureInbound') {
        extra.lastInboundTs = user.lastInboundTs;
        extra.nowMs = now;
      }
      if (key === 'pendingBizProfile') extra.pendingKeys = Object.keys(snap.pendingBizProfile || {});
      pushIssue(key, snap, extra);
    }
  });

  const summary = Object.entries(buckets).map(([key, bucket]) => ({ key, label: bucket.label, severity: bucket.severity, description: bucket.description, count: bucket.count }));
  const totalIssues = summary.reduce((acc, item) => acc + item.count, 0);
  return { ok: true, ts: Date.now(), usersCount: waIds.length, totalIssues, summary, items: buckets };
}

function sendExport(res, filenameBase, format, payload, options = {}) {
  const title = String(options?.title || filenameBase || 'Exportação');
  if (format === "json") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.json"`);
    return res.status(200).send(JSON.stringify(payload, null, 2));
  }

  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : Object.entries(payload || {}).map(([key, value]) => ({ key, value: typeof value === 'object' ? JSON.stringify(value) : String(value ?? '') }));

  if (format === "excel") {
    res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.xls"`);
    return res.status(200).send(rowsToExcelXml(rows, title));
  }

  if (format === "pdf") {
    const buffer = rowsToPdfBuffer(title, rows);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.pdf"`);
    return res.status(200).send(buffer);
  }

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.csv"`);
  return res.status(200).send("\uFEFF" + rowsToCsv(rows, ";"));
}

async function buildExportUsersRows() {
  const usersRaw = await listUsers();
  const waIds = Array.isArray(usersRaw) ? usersRaw.slice().sort() : [];
  const plans = await listPlans({ includeInactive: true });
  const planMap = globalBuildPlanMap(plans);
  const now = nowMs();
  const users = await mapLimit(waIds, 20, async (waId) => enrichUserForExport(waId, planMap, now));

  return users.map((user) => ({
    waId: String(user.waId || ""),
    fullName: String(user.fullName || ""),
    status: String(user.status || ""),
    plan: String(user.plan || ""),
    planName: String(user.planName || ""),
    planDescription: String(user.planDescription || ""),
    paymentMethod: String(user.paymentMethod || ""),
    quotaUsed: Number(user.quotaUsed || 0),
    trialUsed: Number(user.trialUsed || 0),
    templateMode: String(user.templateMode || ""),
    billingCityState: String(user.billingCityState || ""),
    billingAddress: String(user.billingAddress || ""),
    hasBizProfile: user.hasBizProfile ? "yes" : "no",
    hasPendingBizProfile: user.hasPendingBizProfile ? "yes" : "no",
    inWindow24h: user.inWindow ? "yes" : "no",
    lastInboundTs: Number(user.lastInboundTs || 0),
    windowExpiresAt: Number(user.windowExpiresAt || 0),
    issueCount: Number(user.issueCount || 0),
    issueKeys: (user.issueKeys || []).join(" | "),
    asaasCustomerId: String(user.asaasCustomerId || ""),
    asaasSubscriptionId: String(user.asaasSubscriptionId || ""),
    cardValidUntil: String(user.cardValidUntil || ""),
    cardCanceledAt: String(user.cardCanceledAt || ""),
    docType: String(user?.doc?.docType || ""),
    docLast4: String(user?.doc?.docLast4 || ""),
  }));
}

async function buildExportInconsistencyRows() {
  const data = await collectInconsistenciesForExport();
  const rows = [];
  for (const [key, bucket] of Object.entries(data.items || {})) {
    for (const item of bucket.items || []) {
      rows.push({
        bucketKey: key,
        label: String(bucket.label || ""),
        severity: String(bucket.severity || ""),
        description: String(bucket.description || ""),
        waId: String(item.waId || ""),
        fullName: String(item.fullName || ""),
        status: String(item.status || ""),
        plan: String(item.plan || ""),
        paymentMethod: String(item.paymentMethod || ""),
        asaasCustomerId: String(item.asaasCustomerId || ""),
        asaasSubscriptionId: String(item.asaasSubscriptionId || ""),
        quotaUsed: Number(item.quotaUsed || 0),
        trialUsed: Number(item.trialUsed || 0),
        cardValidUntil: String(item.cardValidUntil || ""),
        cardCanceledAt: String(item.cardCanceledAt || ""),
      });
    }
  }
  return rows;
}

async function buildExportAuditRows() {
  const items = await listAdminAudit({ limit: 1000 });
  return (Array.isArray(items) ? items : []).map((item) => ({
    id: String(item?.id || ""),
    ts: String(item?.ts || ""),
    module: String(item?.module || ""),
    action: String(item?.action || ""),
    waId: String(item?.waId || ""),
    targetId: String(item?.targetId || ""),
    targetLabel: String(item?.targetLabel || ""),
    summary: String(item?.summary || ""),
    actorUser: String(item?.actor?.user || ""),
    actorIp: String(item?.actor?.ip || ""),
    actorType: String(item?.actor?.type || ""),
    before: JSON.stringify(item?.before || {}),
    after: JSON.stringify(item?.after || {}),
    meta: JSON.stringify(item?.meta || {}),
  }));
}

function normalizeAdminBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return !!fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  return ["1", "true", "on", "yes", "sim"].includes(text);
}

function normalizeAdminInt(value, fallback = 0, { min = null, max = null } = {}) {
  let out = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : Math.trunc(Number(fallback) || 0);
  if (Number.isFinite(min)) out = Math.max(Number(min), out);
  if (Number.isFinite(max)) out = Math.min(Number(max), out);
  return out;
}

function parseAdminList(value) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)));
  }
  const text = String(value || "").trim();
  if (!text) return [];
  return Array.from(new Set(text.split(/[\n,;]+/).map((item) => String(item || "").trim()).filter(Boolean)));
}

function normalizeAdminCouponCode(value) {
  return String(value || "").trim().toUpperCase();
}

function parseAdminDateMs(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function formatDateTimeLabel(value) {
  const n = Number(value || 0);
  if (!n) return "";
  try {
    return new Date(n).toLocaleString("pt-BR");
  } catch (_) {
    return String(value || "");
  }
}

function formatCouponCycles(cycles) {
  const list = Array.isArray(cycles) ? cycles : [];
  if (!list.length) return "Todos";
  return list.map((cycle) => cycle === "annual" ? "Anual" : cycle === "monthly" ? "Mensal" : String(cycle || "")).join(", ");
}

function formatCouponPlans(plans) {
  const list = Array.isArray(plans) ? plans : [];
  return list.length ? list.join(", ") : "Todos";
}

function formatCouponDiscount(coupon) {
  const type = String(coupon?.discountType || "").trim();
  const percentValue = Number(coupon?.discountPercent ?? coupon?.discountValue ?? 0);
  const fixedValue = Number(coupon?.discountAmountCents ?? coupon?.discountValue ?? 0);
  const cap = Number(coupon?.discountCapCents ?? coupon?.discountCap ?? 0);
  if (type === "percent") {
    return cap > 0 ? `${percentValue}% (teto ${formatMoneyCents(cap)})` : `${percentValue}%`;
  }
  return formatMoneyCents(fixedValue);
}

function buildCouponFormInput(input = {}) {
  return {
    couponCode: normalizeAdminCouponCode(input.couponCode || input.code),
    name: String(input.name || "").trim(),
    description: String(input.description || "").trim(),
    active: normalizeAdminBool(input.active, true),
    discountType: String(input.discountType || "percent").trim().toLowerCase() === "fixed" ? "fixed" : "percent",
    discountValue: normalizeAdminInt(input.discountValue, 0, { min: 0 }),
    discountCap: normalizeAdminInt(input.discountCap, 0, { min: 0 }),
    eligiblePlanCodes: parseAdminList(input.eligiblePlanCodes || input.eligiblePlans || input.planCodes),
    eligibleBillingCycles: parseAdminList(input.eligibleBillingCycles || input.eligibleCycles || input.billingCycles)
      .map((cycle) => String(cycle || "").trim().toLowerCase())
      .filter((cycle) => cycle === "monthly" || cycle === "annual"),
    validFrom: parseAdminDateMs(input.validFrom),
    validUntil: parseAdminDateMs(input.validUntil),
    maxUsesTotal: normalizeAdminInt(input.maxUsesTotal, 0, { min: 0 }),
    maxUsesPerUser: normalizeAdminInt(input.maxUsesPerUser, 0, { min: 0 }),
    firstPurchaseOnly: normalizeAdminBool(input.firstPurchaseOnly, false),
    onlyWithoutActivePlan: normalizeAdminBool(input.onlyWithoutActivePlan, false),
    appliesTo: String(input.appliesTo || "first_charge_only").trim() === "entire_subscription" ? "entire_subscription" : "first_charge_only",
  };
}

async function buildCouponReportData(query = {}) {
  const [coupons, rows, reservations] = await Promise.all([
    listCoupons({ includeInactive: true, includeDeleted: false }).catch(() => []),
    listCouponReportRows({
      limit: normalizeAdminInt(query.limit, 1000, { min: 1, max: 5000 }),
      couponCode: normalizeAdminCouponCode(query.couponCode || ""),
      internalUserId: String(query.userId || query.internalUserId || "").trim(),
      status: String(query.status || "").trim(),
      planCode: String(query.planCode || "").trim().toUpperCase(),
      billingCycle: String(query.billingCycle || "").trim().toLowerCase(),
    }).catch(() => []),
    listCouponReservations({
      limit: normalizeAdminInt(query.limit, 1000, { min: 1, max: 5000 }),
      couponCode: normalizeAdminCouponCode(query.couponCode || ""),
      internalUserId: String(query.userId || query.internalUserId || "").trim(),
      status: String(query.status || "").trim(),
    }).catch(() => []),
  ]);

  const couponList = Array.isArray(coupons) ? coupons : [];
  const reportRows = Array.isArray(rows) ? rows : [];
  const reservationRows = Array.isArray(reservations) ? reservations : [];

  const summary = {
    totalCoupons: couponList.length,
    totalRows: reportRows.length,
    totalReservations: reservationRows.length,
    totalOriginalCents: 0,
    totalDiscountCents: 0,
    totalFinalCents: 0,
    byStatus: {},
    byCycle: {},
    byPlan: {},
  };

  for (const row of reportRows) {
    const status = String(row?.status || "").trim() || "unknown";
    const cycle = String(row?.billingCycle || "").trim() || "unknown";
    const planCode = String(row?.planCode || "").trim() || "unknown";
    summary.byStatus[status] = (summary.byStatus[status] || 0) + 1;
    summary.byCycle[cycle] = (summary.byCycle[cycle] || 0) + 1;
    summary.byPlan[planCode] = (summary.byPlan[planCode] || 0) + 1;
    summary.totalOriginalCents += Number(row?.originalCents || row?.basePriceCents || 0);
    summary.totalDiscountCents += Number(row?.discountCents || row?.discountAmountCents || 0);
    summary.totalFinalCents += Number(row?.finalCents || row?.finalPriceCents || 0);
  }

  const couponCards = [];
  for (const coupon of couponList) {
    const usage = await getCouponUsageSummary(normalizeAdminCouponCode(coupon?.couponCode || coupon?.code || "")).catch(() => null);
    couponCards.push({
      coupon,
      usage,
    });
  }

  return {
    ok: true,
    ts: Date.now(),
    summary,
    coupons: couponCards,
    rows: reportRows,
    reservations: reservationRows,
  };
}

async function buildExportCouponRows(query = {}) {
  const data = await buildCouponReportData(query);
  return (Array.isArray(data.rows) ? data.rows : []).map((row) => ({
    couponCode: String(row?.couponCode || ""),
    internalUserId: String(row?.internalUserId || ""),
    reservationId: String(row?.reservationId || row?.id || ""),
    status: String(row?.status || ""),
    planCode: String(row?.planCode || ""),
    billingCycle: String(row?.billingCycle || ""),
    appliesTo: String(row?.appliesTo || ""),
    originalCents: Number(row?.originalCents || row?.basePriceCents || 0),
    discountCents: Number(row?.discountCents || row?.discountAmountCents || 0),
    finalCents: Number(row?.finalCents || row?.finalPriceCents || 0),
    paymentId: String(row?.paymentId || ""),
    subscriptionId: String(row?.subscriptionId || ""),
    ts: String(row?.ts || row?.createdAt || row?.updatedAt || ""),
    meta: JSON.stringify(row?.meta || {}),
  }));
}

function buildReportsFallbackData(errorMessage = "") {
  return {
    ok: true,
    ts: Date.now(),
    warning: String(errorMessage || "").trim(),
    executive: {
      ok: true,
      ts: Date.now(),
      overview: { totalUsers: 0, activeUsers: 0, trialUsers: 0, paymentPendingUsers: 0, waitPlanUsers: 0, blockedUsers: 0, activeSharePct: 0, trialToPaidPct: 0 },
      revenue: { mrrCents: 0, avgTicketCents: 0, activePaidUsers: 0 },
      usage: { descriptionsToday: 0, descriptionsMonth: 0, dayLabel: "", monthLabel: "", window24hCount: 0, avgDescriptionsPerActive: 0 },
      quality: { withName: 0, withBizProfile: 0, withPendingBizProfile: 0, withAsaasCustomer: 0, withAsaasSubscription: 0, withBilling: 0, issueUsers: 0, profileCoveragePct: 0, nameCoveragePct: 0, inconsistencyPct: 0 },
      statusCounts: { TRIAL: 0, ACTIVE: 0, WAIT_PLAN: 0, PAYMENT_PENDING: 0, BLOCKED: 0, UNKNOWN: 0 },
      payments: [],
      plans: [],
      cities: [],
      inconsistencies: { ok: true, ts: Date.now(), usersCount: 0, totalIssues: 0, summary: [], items: {} },
    },
    audit: {
      totalStored: 0,
      recentCount: 0,
      modules: [],
      actions: [],
      items: [],
    },
  };
}

async function buildReportsCenterData(executiveBuilder) {
  const executivePromise = typeof executiveBuilder === "function"
    ? executiveBuilder()
    : Promise.resolve(buildReportsFallbackData("Executive builder unavailable").executive);

  const [executive, auditItems, auditTotal] = await Promise.all([
    executivePromise,
    listAdminAudit({ limit: 30 }),
    getAdminAuditCount(),
  ]);

  const recentAudit = Array.isArray(auditItems) ? auditItems : [];
  const moduleCounts = new Map();
  const actionCounts = new Map();
  for (const item of recentAudit) {
    const moduleName = String(item?.module || "—").trim() || "—";
    const actionName = String(item?.action || "—").trim() || "—";
    moduleCounts.set(moduleName, (moduleCounts.get(moduleName) || 0) + 1);
    actionCounts.set(actionName, (actionCounts.get(actionName) || 0) + 1);
  }

  const modules = Array.from(moduleCounts.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  const actions = Array.from(actionCounts.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name)).slice(0, 10);

  return {
    ok: true,
    ts: Date.now(),
    executive,
    audit: {
      totalStored: Number(auditTotal || 0),
      recentCount: recentAudit.length,
      modules,
      actions,
      items: recentAudit,
    },
  };
}

function buildExecutiveExportRows(data) {
  const rows = [];
  const overview = data?.executive?.overview || {};
  const revenue = data?.executive?.revenue || {};
  const usage = data?.executive?.usage || {};
  const quality = data?.executive?.quality || {};
  const pushMetric = (section, metric, value) => rows.push({ section, metric, value });
  pushMetric("overview", "totalUsers", overview.totalUsers || 0);
  pushMetric("overview", "activeUsers", overview.activeUsers || 0);
  pushMetric("overview", "trialUsers", overview.trialUsers || 0);
  pushMetric("overview", "paymentPendingUsers", overview.paymentPendingUsers || 0);
  pushMetric("overview", "waitPlanUsers", overview.waitPlanUsers || 0);
  pushMetric("overview", "blockedUsers", overview.blockedUsers || 0);
  pushMetric("overview", "activeSharePct", overview.activeSharePct || 0);
  pushMetric("overview", "trialToPaidPct", overview.trialToPaidPct || 0);
  pushMetric("revenue", "mrrCents", revenue.mrrCents || 0);
  pushMetric("revenue", "mrrFormatted", formatMoneyCents(revenue.mrrCents || 0));
  pushMetric("revenue", "avgTicketCents", revenue.avgTicketCents || 0);
  pushMetric("revenue", "avgTicketFormatted", formatMoneyCents(revenue.avgTicketCents || 0));
  pushMetric("usage", "descriptionsToday", usage.descriptionsToday || 0);
  pushMetric("usage", "descriptionsMonth", usage.descriptionsMonth || 0);
  pushMetric("usage", "window24hCount", usage.window24hCount || 0);
  pushMetric("usage", "avgDescriptionsPerActive", usage.avgDescriptionsPerActive || 0);
  pushMetric("quality", "withName", quality.withName || 0);
  pushMetric("quality", "withBizProfile", quality.withBizProfile || 0);
  pushMetric("quality", "withPendingBizProfile", quality.withPendingBizProfile || 0);
  pushMetric("quality", "withAsaasCustomer", quality.withAsaasCustomer || 0);
  pushMetric("quality", "withAsaasSubscription", quality.withAsaasSubscription || 0);
  pushMetric("quality", "withBilling", quality.withBilling || 0);
  pushMetric("quality", "issueUsers", quality.issueUsers || 0);
  pushMetric("quality", "profileCoveragePct", quality.profileCoveragePct || 0);
  pushMetric("quality", "nameCoveragePct", quality.nameCoveragePct || 0);
  pushMetric("quality", "inconsistencyPct", quality.inconsistencyPct || 0);
  return rows;
}

function normalizeOperationalLevel(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["fatal", "error", "danger"].includes(text)) return "error";
  if (["warn", "warning"].includes(text)) return "warn";
  if (["info", "debug", "notice"].includes(text)) return "info";
  return text || "info";
}

function normalizeOperationalModule(value) {
  const text = String(value || "").trim();
  return text || "unknown";
}

function normalizeOperationalStep(value) {
  return String(value || "").trim();
}

function normalizeOperationalMessage(value) {
  return limitText(String(value || "").trim(), 220);
}

function summarizeOperationalHealth({ modules = [], errorsCount = 0, warningsCount = 0, financial = {} } = {}) {
  const topErrorModule = (Array.isArray(modules) ? modules : []).find((item) => Number(item?.errorCount || 0) > 0);
  const totalFinancialFailures = Number(financial?.recentFailures || 0) + Number(financial?.recentInconsistencies || 0);
  let level = "ok";
  const notes = [];

  if (errorsCount > 0 || totalFinancialFailures > 0) {
    level = "warning";
    notes.push(`Há ${errorsCount} erro(s) operacionais recente(s) e ${totalFinancialFailures} ocorrência(s) financeira(s) sensível(is).`);
  }
  if (errorsCount >= 10 || totalFinancialFailures >= 10) {
    level = "danger";
    notes.unshift("O sistema apresenta volume relevante de falhas recentes e exige leitura operacional prioritária.");
  }
  if (topErrorModule) {
    notes.push(`Módulo mais afetado: ${topErrorModule.module} (${topErrorModule.errorCount} erro(s)).`);
  }
  if (warningsCount > 0) {
    notes.push(`Há ${warningsCount} ocorrência(s) em nível de atenção.`);
  }
  if (!notes.length) {
    notes.push("Sem falhas operacionais recentes relevantes dentro da janela consultada.");
  }

  return {
    level,
    notes,
    summary: notes[0] || "Leitura operacional indisponível.",
  };
}

async function buildOperationalReadModel() {
  let operationalItems = [];
  let operationalError = "";
  let operationalStored = 0;
  try {
    const [items, totalStored] = await Promise.all([
      typeof listOperationalAudit === "function" ? listOperationalAudit({ limit: 200 }) : [],
      typeof getOperationalAuditCount === "function" ? getOperationalAuditCount() : 0,
    ]);
    operationalItems = Array.isArray(items) ? items : [];
    operationalStored = Number(totalStored || 0);
  } catch (err) {
    operationalError = String(err?.message || err);
    operationalItems = [];
    operationalStored = 0;
  }

  let financialItems = [];
  let financialError = "";
  try {
    const ledger = await listAsaasEvents({ limit: 120, offset: 0 });
    financialItems = Array.isArray(ledger?.items) ? ledger.items : [];
  } catch (err) {
    financialError = String(err?.message || err);
    financialItems = [];
  }

  const moduleMap = new Map();
  const recentErrors = [];
  const recentEvents = [];
  let errorsCount = 0;
  let warningsCount = 0;

  for (const raw of operationalItems) {
    const moduleName = normalizeOperationalModule(raw?.module);
    const level = normalizeOperationalLevel(raw?.level);
    const event = String(raw?.event || "").trim();
    const ts = String(raw?.ts || "").trim();
    const step = normalizeOperationalStep(raw?.step);
    const message = normalizeOperationalMessage(raw?.message || raw?.summary || raw?.reason || raw?.errorCode);
    const userId = String(raw?.userId || "").trim();
    const waId = String(raw?.waId || "").trim();
    const status = String(raw?.status || "").trim();
    const errorCode = String(raw?.errorCode || "").trim();

    const prev = moduleMap.get(moduleName) || {
      module: moduleName,
      count: 0,
      errorCount: 0,
      warnCount: 0,
      infoCount: 0,
      lastTs: "",
      lastEvent: "",
      lastLevel: "",
    };
    prev.count += 1;
    if (level === "error") prev.errorCount += 1;
    else if (level === "warn") prev.warnCount += 1;
    else prev.infoCount += 1;
    if (!prev.lastTs || (ts && ts > prev.lastTs)) {
      prev.lastTs = ts;
      prev.lastEvent = event;
      prev.lastLevel = level;
    }
    moduleMap.set(moduleName, prev);

    const normalized = {
      ts,
      module: moduleName,
      level,
      event,
      step,
      message,
      userId,
      waId,
      status,
      errorCode,
      meta: raw?.meta && typeof raw.meta === "object" ? raw.meta : {},
    };

    recentEvents.push(normalized);
    if (level === "error") {
      errorsCount += 1;
      recentErrors.push(normalized);
    } else if (level === "warn") {
      warningsCount += 1;
      recentErrors.push(normalized);
    }
  }

  const modules = Array.from(moduleMap.values())
    .sort((a, b) => {
      if (b.errorCount !== a.errorCount) return b.errorCount - a.errorCount;
      if (b.warnCount !== a.warnCount) return b.warnCount - a.warnCount;
      if (b.count !== a.count) return b.count - a.count;
      return String(a.module).localeCompare(String(b.module));
    });

  const financialCategories = new Map();
  const financialStatuses = new Map();
  let financialFailures = 0;
  let financialInconsistencies = 0;
  for (const item of financialItems) {
    const category = String(item?.category || item?.eventType || item?.event || "unknown").trim() || "unknown";
    const status = String(item?.status || item?.payment?.status || item?.subscription?.status || "unknown").trim() || "unknown";
    financialCategories.set(category, (financialCategories.get(category) || 0) + 1);
    financialStatuses.set(status, (financialStatuses.get(status) || 0) + 1);
    if (item?.isFailure) financialFailures += 1;
    if (item?.isInconsistency) financialInconsistencies += 1;
  }

  const financial = {
    totalEvents: financialItems.length,
    recentFailures: financialFailures,
    recentInconsistencies: financialInconsistencies,
    categories: Array.from(financialCategories.entries()).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    statuses: Array.from(financialStatuses.entries()).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
    latest: financialItems.slice(0, 20).map((item) => ({
      ts: String(item?.ts || ""),
      event: String(item?.event || ""),
      eventType: String(item?.eventType || ""),
      category: String(item?.category || ""),
      status: String(item?.status || item?.payment?.status || item?.subscription?.status || ""),
      severity: String(item?.severity || ""),
      isFailure: Boolean(item?.isFailure),
      isInconsistency: Boolean(item?.isInconsistency),
      userId: String(item?.userId || ""),
      waId: String(item?.waId || ""),
      paymentId: String(item?.paymentId || item?.payment?.id || ""),
      subscriptionId: String(item?.subscriptionId || item?.subscription?.id || ""),
      couponCode: String(item?.couponCode || item?.couponLedger?.couponCode || ""),
      summary: String(item?.summary || item?.message || item?.event || ""),
      message: String(item?.message || item?.summary || ""),
    })),
    error: financialError || undefined,
  };

  return {
    ok: !operationalError,
    error: operationalError || undefined,
    totalStored: operationalStored,
    recentCount: operationalItems.length,
    errorsCount,
    warningsCount,
    modules,
    recentEvents: recentEvents.slice(0, 25),
    recentErrors: recentErrors.slice(0, 15),
    financial,
    health: summarizeOperationalHealth({ modules, errorsCount, warningsCount, financial }),
  };
}

function parseOpsPeriodHours(value) {
  const text = String(value || "24h").trim().toLowerCase();
  if (text === "72h" || text === "3d") return 72;
  if (text === "7d") return 24 * 7;
  if (text === "30d") return 24 * 30;
  return 24;
}

function safeOpsDateMs(ts) {
  const ms = Date.parse(String(ts || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function inOpsWindow(ts, nowMsValue, hours) {
  const ms = safeOpsDateMs(ts);
  if (!ms) return true;
  return (nowMsValue - ms) <= (hours * 60 * 60 * 1000);
}

function opsBadgeClass(level) {
  const normalized = normalizeOperationalLevel(level);
  if (normalized === "error") return "danger";
  if (normalized === "warn") return "warn";
  if (normalized === "ok") return "ok";
  return "info";
}

function humanizeOpsModule(moduleName) {
  const key = normalizeOperationalModule(moduleName);
  const map = {
    flow: "Flow",
    webhook_route: "Webhook",
    meta_whatsapp: "Meta / WhatsApp",
    asaas_client: "Asaas Client",
    asaas_webhook: "Asaas Webhook",
    campaigns: "Campanhas",
    broadcast: "Broadcast",
    pricing: "Pricing",
    state: "State",
    server: "Server",
    asaas_ledger: "Ledger Asaas",
    admin: "Admin",
  };
  return map[key] || key;
}

function deriveOperationalAlerts({ operational = {}, filters = {} } = {}) {
  const alerts = [];
  const recentErrors = Array.isArray(operational.recentErrors) ? operational.recentErrors : [];
  const modules = Array.isArray(operational.modules) ? operational.modules : [];
  const financial = operational.financial || {};
  const nowIso = new Date().toISOString();

  function pushAlert(payload) {
    alerts.push({
      id: String(payload.id || `alert_${alerts.length + 1}`),
      level: String(payload.level || "info"),
      title: String(payload.title || "Alerta operacional"),
      summary: String(payload.summary || ""),
      module: String(payload.module || "system"),
      reason: String(payload.reason || ""),
      recommendedAction: String(payload.recommendedAction || "Revisar eventos recentes no painel operacional."),
      count: Number(payload.count || 0),
      firstSeenAt: String(payload.firstSeenAt || nowIso),
      lastSeenAt: String(payload.lastSeenAt || nowIso),
      meta: payload.meta && typeof payload.meta === "object" ? payload.meta : {},
    });
  }

  const topModule = modules.find((item) => Number(item?.errorCount || 0) > 0);
  if (topModule && Number(topModule.errorCount || 0) >= 3) {
    pushAlert({
      id: `module_hotspot_${topModule.module}`,
      level: Number(topModule.errorCount || 0) >= 10 ? "danger" : "warn",
      title: `Alta concentração de erros em ${humanizeOpsModule(topModule.module)}`,
      summary: `${humanizeOpsModule(topModule.module)} concentrou ${topModule.errorCount} erro(s) na janela consultada.`,
      module: topModule.module,
      reason: "Volume de falhas acima do esperado no módulo.",
      recommendedAction: `Abrir os eventos recentes de ${humanizeOpsModule(topModule.module)} e validar a última ocorrência em ${formatDateTimeLabel(Date.parse(String(topModule.lastTs || ""))) || topModule.lastTs || "tempo não disponível"}.`,
      count: Number(topModule.errorCount || 0),
      firstSeenAt: String(topModule.lastTs || nowIso),
      lastSeenAt: String(topModule.lastTs || nowIso),
    });
  }

  const financialFailures = Number(financial.recentFailures || 0) + Number(financial.recentInconsistencies || 0);
  if (financialFailures > 0) {
    pushAlert({
      id: "financial_failures",
      level: financialFailures >= 5 ? "danger" : "warn",
      title: "Ocorrências financeiras recentes",
      summary: `Foram detectadas ${financialFailures} ocorrência(s) financeiras sensíveis na janela consultada.`,
      module: "asaas_financial",
      reason: "Falhas, expirações ou inconsistências financeiras recentes no ledger.",
      recommendedAction: "Revisar a leitura financeira operacional e validar pagamentos falhados, expirados e inconsistências.",
      count: financialFailures,
      firstSeenAt: String((financial.latest && financial.latest[financial.latest.length - 1]?.ts) || nowIso),
      lastSeenAt: String(financial.latest?.[0]?.ts || nowIso),
    });
  }

  const campaignErrors = recentErrors.filter((item) => ["campaigns", "broadcast"].includes(String(item?.module || "")));
  if (campaignErrors.length > 0) {
    pushAlert({
      id: "campaign_runtime_issue",
      level: campaignErrors.length >= 5 ? "danger" : "warn",
      title: "Campanhas com falhas operacionais",
      summary: `${campaignErrors.length} evento(s) de erro/atenção relacionados a campanhas foram encontrados.`,
      module: "campaigns",
      reason: "Erros ou avisos recentes nos módulos de campanhas/broadcast.",
      recommendedAction: "Revisar campanhas recentes, conflitos e últimos envios no painel operacional.",
      count: campaignErrors.length,
      firstSeenAt: String(campaignErrors[campaignErrors.length - 1]?.ts || nowIso),
      lastSeenAt: String(campaignErrors[0]?.ts || nowIso),
    });
  }

  const metaErrors = recentErrors.filter((item) => String(item?.module || "") === "meta_whatsapp");
  if (metaErrors.length > 0) {
    pushAlert({
      id: "meta_whatsapp_issue",
      level: metaErrors.length >= 5 ? "danger" : "warn",
      title: "Falhas recentes na integração Meta / WhatsApp",
      summary: `${metaErrors.length} evento(s) de erro/atenção foram encontrados na integração Meta / WhatsApp.`,
      module: "meta_whatsapp",
      reason: "Possível impacto em envio de mensagens ou autenticação do provedor.",
      recommendedAction: "Validar últimos envios e erros do módulo Meta / WhatsApp.",
      count: metaErrors.length,
      firstSeenAt: String(metaErrors[metaErrors.length - 1]?.ts || nowIso),
      lastSeenAt: String(metaErrors[0]?.ts || nowIso),
    });
  }

  const webhookErrors = recentErrors.filter((item) => String(item?.module || "") === "webhook_route");
  if (webhookErrors.length > 0) {
    pushAlert({
      id: "webhook_route_issue",
      level: webhookErrors.length >= 5 ? "danger" : "warn",
      title: "Falhas recentes no webhook de entrada",
      summary: `${webhookErrors.length} evento(s) de erro/atenção foram encontrados no webhook de entrada.`,
      module: "webhook_route",
      reason: "Possível impacto em ingestão de mensagens ou processamento inicial do fluxo.",
      recommendedAction: "Revisar parsing, dedupe e erros recentes do webhook.",
      count: webhookErrors.length,
      firstSeenAt: String(webhookErrors[webhookErrors.length - 1]?.ts || nowIso),
      lastSeenAt: String(webhookErrors[0]?.ts || nowIso),
    });
  }

  const fatalEvents = recentErrors.filter((item) => String(item?.level || "") === "error" && /fatal|uncaughtexception|unhandledrejection/i.test(`${item?.event || ""} ${item?.message || ""}`));
  if (fatalEvents.length > 0) {
    pushAlert({
      id: "fatal_runtime_issue",
      level: "danger",
      title: "Evento fatal recente detectado",
      summary: `${fatalEvents.length} evento(s) com sinal de falha fatal foram encontrados.`,
      module: String(fatalEvents[0]?.module || "server"),
      reason: "Há indícios de erro fatal ou exceção não tratada no runtime.",
      recommendedAction: "Priorizar a revisão dos eventos fatais e checar estabilidade do processo no Render.",
      count: fatalEvents.length,
      firstSeenAt: String(fatalEvents[fatalEvents.length - 1]?.ts || nowIso),
      lastSeenAt: String(fatalEvents[0]?.ts || nowIso),
    });
  }

  return alerts;
}

function buildOperationalExecutiveSummary({ operational = {}, alerts = [] } = {}) {
  const health = operational.health || {};
  const errorsCount = Number(operational.errorsCount || 0);
  const warningsCount = Number(operational.warningsCount || 0);
  const financialFailures = Number(operational?.financial?.recentFailures || 0) + Number(operational?.financial?.recentInconsistencies || 0);
  const criticalAlerts = alerts.filter((item) => String(item?.level || "") === "danger");
  const warningAlerts = alerts.filter((item) => String(item?.level || "") === "warn");

  if (criticalAlerts.length > 0) {
    return `Crítico: ${criticalAlerts[0]?.summary || 'há falhas operacionais relevantes exigindo atenção imediata.'}`;
  }
  if (warningAlerts.length > 0) {
    return `Atenção: ${warningAlerts[0]?.summary || 'foram identificados sinais de degradação operacional.'}`;
  }
  if (errorsCount === 0 && financialFailures === 0) {
    return "Sistema saudável nas últimas 24h, sem falhas operacionais relevantes na janela consultada.";
  }
  if (warningsCount > 0) {
    return `Atenção: ${warningsCount} aviso(s) operacional(is) foram registrados recentemente, sem concentração crítica de falhas.`;
  }
  return String(health.summary || "Leitura operacional disponível, sem alertas inteligentes ativos.");
}

async function buildOperationalDashboardData(filters = {}) {
  const periodHours = parseOpsPeriodHours(filters.period);
  const moduleFilter = normalizeOperationalModule(filters.module || "");
  const levelFilter = normalizeOperationalLevel(filters.level || "");
  const onlyFailures = parseBoolInput(filters.onlyFailures, false);
  const onlyInconsistencies = parseBoolInput(filters.onlyInconsistencies, false);
  const query = String(filters.query || filters.search || "").trim().toLowerCase();
  const nowValue = nowMs();

  const base = await buildOperationalReadModel();
  const allEvents = Array.isArray(base.recentEvents) ? base.recentEvents : [];
  const filteredEvents = allEvents.filter((item) => {
    if (!inOpsWindow(item?.ts, nowValue, periodHours)) return false;
    if (moduleFilter && moduleFilter !== "unknown" && normalizeOperationalModule(item?.module) !== moduleFilter) return false;
    if (levelFilter && levelFilter !== "info" && normalizeOperationalLevel(item?.level) !== levelFilter) return false;
    if (onlyFailures && !["error", "warn"].includes(normalizeOperationalLevel(item?.level))) return false;
    if (query) {
      const hay = [item?.module, item?.event, item?.message, item?.userId, item?.waId, item?.status, item?.errorCode]
        .map((v) => String(v || "").toLowerCase())
        .join(" ");
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  const moduleMap = new Map();
  let errorsCount = 0;
  let warningsCount = 0;
  for (const item of filteredEvents) {
    const moduleName = normalizeOperationalModule(item?.module);
    const level = normalizeOperationalLevel(item?.level);
    const prev = moduleMap.get(moduleName) || { module: moduleName, count: 0, errorCount: 0, warnCount: 0, infoCount: 0, lastTs: "", lastEvent: "", lastLevel: "" };
    prev.count += 1;
    if (level === "error") { prev.errorCount += 1; errorsCount += 1; }
    else if (level === "warn") { prev.warnCount += 1; warningsCount += 1; }
    else prev.infoCount += 1;
    if (!prev.lastTs || String(item?.ts || "") > prev.lastTs) {
      prev.lastTs = String(item?.ts || "");
      prev.lastEvent = String(item?.event || "");
      prev.lastLevel = level;
    }
    moduleMap.set(moduleName, prev);
  }
  const failuresByModule = Array.from(moduleMap.values()).sort((a,b)=> (b.errorCount-a.errorCount) || (b.warnCount-a.warnCount) || (b.count-a.count) || String(a.module).localeCompare(String(b.module))).slice(0,10);

  const financeBase = base.financial || {};
  const financeLatest = Array.isArray(financeBase.latest) ? financeBase.latest : [];
  const financialLatest = financeLatest.filter((item) => {
    if (!inOpsWindow(item?.ts, nowValue, periodHours)) return false;
    if (onlyInconsistencies && !item?.isInconsistency) return false;
    if (onlyFailures && !(item?.isFailure || item?.isInconsistency)) return false;
    if (query) {
      const hay = [item?.event, item?.eventType, item?.category, item?.status, item?.userId, item?.waId, item?.paymentId, item?.subscriptionId, item?.couponCode, item?.summary]
        .map((v) => String(v || "").toLowerCase())
        .join(" ");
      if (!hay.includes(query)) return false;
    }
    return true;
  });
  const financial = {
    totalEvents: financialLatest.length,
    recentFailures: financialLatest.filter((item) => item?.isFailure).length,
    recentInconsistencies: financialLatest.filter((item) => item?.isInconsistency).length,
    latest: financialLatest.slice(0, 20),
  };

  const campaignEvents = filteredEvents.filter((item) => ["campaigns", "broadcast"].includes(normalizeOperationalModule(item?.module)));
  const campaignSummary = {
    recentEvents: campaignEvents.length,
    errors: campaignEvents.filter((item) => normalizeOperationalLevel(item?.level) === "error").length,
    warnings: campaignEvents.filter((item) => normalizeOperationalLevel(item?.level) === "warn").length,
    latestFailure: campaignEvents.find((item) => ["error", "warn"].includes(normalizeOperationalLevel(item?.level))) || null,
  };

  const operational = {
    ok: base.ok,
    error: base.error,
    totalStored: base.totalStored,
    recentCount: filteredEvents.length,
    errorsCount,
    warningsCount,
    modules: failuresByModule,
    recentEvents: filteredEvents.slice(0, 100),
    recentErrors: filteredEvents.filter((item) => ["error", "warn"].includes(normalizeOperationalLevel(item?.level))).slice(0, 20),
    financial,
    campaignSummary,
    health: summarizeOperationalHealth({ modules: failuresByModule, errorsCount, warningsCount, financial }),
  };

  const alerts = deriveOperationalAlerts({ operational, filters });
  const executiveSummary = buildOperationalExecutiveSummary({ operational, alerts });
  const lastFatal = operational.recentErrors.find((item) => /fatal|uncaughtexception|unhandledrejection/i.test(`${item?.event || ""} ${item?.message || ""}`)) || null;
  const mostUnstableModule = failuresByModule[0] || null;
  const latestFinancialInconsistency = financial.latest.find((item) => item?.isInconsistency) || null;

  return {
    ok: operational.ok,
    generatedAt: new Date().toISOString(),
    filters: {
      period: String(filters.period || "24h"),
      module: String(filters.module || ""),
      level: String(filters.level || ""),
      onlyFailures,
      onlyInconsistencies,
      query: String(filters.query || filters.search || ""),
    },
    summary: {
      totalEvents: operational.recentCount,
      totalErrors: operational.errorsCount,
      totalWarnings: operational.warningsCount,
      totalFinancialEvents: financial.totalEvents,
      totalFinancialFailures: financial.recentFailures,
      totalFinancialInconsistencies: financial.recentInconsistencies,
      modulesWithErrors: failuresByModule.filter((item) => Number(item?.errorCount || 0) > 0).length,
      executiveSummary,
      lastErrorAt: operational.recentErrors[0]?.ts || "",
    },
    health: operational.health,
    failuresByModule,
    alerts,
    recentEvents: operational.recentEvents,
    recentErrors: operational.recentErrors,
    financial,
    campaignSummary,
    highlights: {
      lastFatal,
      mostUnstableModule,
      latestFinancialInconsistency,
      latestCampaignFailure: campaignSummary.latestFailure,
    },
  };
}


function formatAdminDateTime(value) {
  const n = Number(value || 0);
  if (!n) return "";
  try {
    return new Date(n).toLocaleString("pt-BR");
  } catch {
    return String(value || "");
  }
}

function summarizeObjectKeys(value) {
  if (!value || typeof value !== "object") return "";
  const keys = Object.keys(value);
  return keys.length ? keys.join(", ") : "";
}

function normalizeIdentityConflictActionInput(value) {
  const action = String(value || "").trim().toLowerCase();
  const allowed = new Set([
    "merge_into_wa_user",
    "merge_into_bsuid_user",
    "reassign_aliases",
    "separate_users",
    "block_wa_user",
    "block_bsuid_user",
    "dismiss",
    "archive",
  ]);
  return allowed.has(action) ? action : "";
}

async function loadIdentityConflictUserComparison(conflict) {
  const waUserId = String(conflict?.waUserId || "").trim();
  const bsuidUserId = String(conflict?.bsuidUserId || "").trim();
  const ids = Array.from(new Set([waUserId, bsuidUserId].filter(Boolean)));
  const snapshots = new Map();

  await mapLimit(ids, 2, async (userId) => {
    const [snapshot, identifiers, outbound] = await Promise.all([
      getUserSnapshot(userId).catch(() => null),
      getUserIdentifiers(userId).catch(() => null),
      getPreferredOutboundRecipient(userId).catch(() => null),
    ]);
    snapshots.set(userId, { snapshot, identifiers, outbound });
  });

  const buildSide = (userId) => {
    const entry = snapshots.get(userId) || {};
    const snap = entry.snapshot || {};
    const identifiers = entry.identifiers || {};
    const outbound = entry.outbound || {};
    return {
      userId,
      fullName: String(snap?.fullName || "").trim(),
      status: String(snap?.status || "").trim(),
      plan: String(snap?.plan || "").trim(),
      paymentMethod: String(snap?.paymentMethod || "").trim(),
      asaasCustomerId: String(snap?.asaasCustomerId || "").trim(),
      asaasSubscriptionId: String(snap?.asaasSubscriptionId || "").trim(),
      quotaUsed: Number(snap?.quotaUsed || 0),
      trialUsed: Number(snap?.trialUsed || 0),
      billingCityState: String(snap?.billingCityState || "").trim(),
      billingAddress: String(snap?.billingAddress || "").trim(),
      lastPrompt: String(snap?.lastPrompt || "").trim(),
      aliases: {
        waId: String(identifiers?.waId || "").trim(),
        bsuid: String(identifiers?.bsuid || "").trim(),
        primaryDeliveryId: String(identifiers?.primaryDeliveryId || "").trim(),
      },
      outbound: {
        recipient: String(outbound?.recipient || "").trim(),
        channel: String(outbound?.channel || "").trim(),
      },
      bizProfileKeys: summarizeObjectKeys(snap?.bizProfile),
      pendingBizProfileKeys: summarizeObjectKeys(snap?.pendingBizProfile),
    };
  };

  return {
    waSide: buildSide(waUserId),
    bsuidSide: buildSide(bsuidUserId),
  };
}

function renderIdentityConflictSideCard(title, side, highlight = false) {
  const s = side || {};
  return `
    <div class="card pad" style="border-color:${highlight ? 'rgba(37,99,235,.35)' : 'var(--border)'};">
      <div class="row" style="justify-content:space-between; align-items:flex-start;">
        <div>
          <div class="muted">${escapeHtml(title)}</div>
          <div style="font-size:18px; font-weight:800; margin-top:6px;">${escapeHtml(s.fullName || 'Sem nome')}</div>
          <div class="muted" style="margin-top:4px;"><code>${escapeHtml(s.userId || '')}</code></div>
        </div>
        <div class="badge ${String(s.status || '').toUpperCase() === 'ACTIVE' ? 'ok' : 'info'}">${escapeHtml(s.status || 'SEM STATUS')}</div>
      </div>
      <div class="hr"></div>
      <div class="grid cols2">
        <div><div class="muted">Plano</div><div><b>${escapeHtml(s.plan || '—')}</b></div></div>
        <div><div class="muted">Pagamento</div><div><b>${escapeHtml(s.paymentMethod || '—')}</b></div></div>
        <div><div class="muted">Assinatura Asaas</div><div><code>${escapeHtml(s.asaasSubscriptionId || '—')}</code></div></div>
        <div><div class="muted">Cliente Asaas</div><div><code>${escapeHtml(s.asaasCustomerId || '—')}</code></div></div>
        <div><div class="muted">Quota usada</div><div><b>${escapeHtml(String(s.quotaUsed || 0))}</b></div></div>
        <div><div class="muted">Trial usado</div><div><b>${escapeHtml(String(s.trialUsed || 0))}</b></div></div>
      </div>
      <div class="hr"></div>
      <div class="grid cols2">
        <div><div class="muted">WA ID</div><div><code>${escapeHtml(s.aliases?.waId || '—')}</code></div></div>
        <div><div class="muted">BSUID</div><div><code>${escapeHtml(s.aliases?.bsuid || '—')}</code></div></div>
        <div><div class="muted">Primary delivery</div><div><code>${escapeHtml(s.aliases?.primaryDeliveryId || '—')}</code></div></div>
        <div><div class="muted">Destino preferido</div><div><code>${escapeHtml(s.outbound?.recipient || '—')}</code></div></div>
        <div><div class="muted">Canal preferido</div><div>${escapeHtml(s.outbound?.channel || '—')}</div></div>
        <div><div class="muted">Identificador</div><div><code>${escapeHtml(s.userId || '—')}</code></div></div>
      </div>
      <div class="hr"></div>
      <div class="grid cols2">
        <div><div class="muted">Cidade/UF</div><div>${escapeHtml(s.billingCityState || '—')}</div></div>
        <div><div class="muted">Endereço</div><div>${escapeHtml(s.billingAddress || '—')}</div></div>
        <div><div class="muted">Perfil empresa</div><div>${escapeHtml(s.bizProfileKeys || '—')}</div></div>
        <div><div class="muted">Perfil pendente</div><div>${escapeHtml(s.pendingBizProfileKeys || '—')}</div></div>
      </div>
    </div>`;
}

export function adminRouter() {
  const router = Router();

  router.use((req, res, next) => {
    const requiredPermission = getAdminRequiredPermission(req.path || "/");
    if (!requiredPermission) return next();
    const session = getAdminRequestSession(req);
    if (adminHasPermission(session, requiredPermission)) return next();
    if (String(req.headers.accept || "").includes("text/html")) {
      return res.status(403).send(renderAdminForbiddenPage(req, requiredPermission));
    }
    return res.status(403).json({
      ok: false,
      error: "forbidden",
      requiredPermission,
      profile: String(session?.role || ""),
      username: String(session?.username || ""),
    });
  });

  // ===================== Dashboard (Métricas consolidadas) =====================
  // ✅ V16.4.9 — Dashboard consolidado (global + por usuário)
  function toInt(v, def = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : def;
  }

  async function mapLimitDashboard(items, limit, fn) {
    const arr = Array.isArray(items) ? items : [];
    const lim = Math.max(1, toInt(limit, 10));
    const out = new Array(arr.length);
    let i = 0;

    async function worker() {
      while (i < arr.length) {
        const idx = i++;
        try {
          out[idx] = await fn(arr[idx], idx);
        } catch (e) {
          out[idx] = { __error: true, message: String(e?.message || e) };
        }
      }
    }

    const workers = [];
    for (let w = 0; w < Math.min(lim, arr.length); w++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }


  function buildInconsistencyBucket(label, severity, description = "") {
    return { label, severity, description, count: 0, items: [] };
  }

  function buildPlanMap(plans) {
    return new Map(
      (Array.isArray(plans) ? plans : [])
        .map((plan) => {
          const code = String(plan?.code || "").trim().toUpperCase();
          return code ? [code, plan] : null;
        })
        .filter(Boolean)
    );
  }

  function getCrmStatusCounters() {
    return {
      TRIAL: 0,
      ACTIVE: 0,
      WAIT_PLAN: 0,
      PAYMENT_PENDING: 0,
      BLOCKED: 0,
      UNKNOWN: 0,
    };
  }

  function detectUserInconsistencyKeys(snap, lastInboundTs, now, planMap) {
    const keys = [];
    const status = String(snap?.status || "").trim().toUpperCase();
    const planCode = String(snap?.plan || "").trim().toUpperCase();
    const paymentMethod = String(snap?.paymentMethod || "").trim().toUpperCase();
    const asaasCustomerId = String(snap?.asaasCustomerId || "").trim();
    const asaasSubscriptionId = String(snap?.asaasSubscriptionId || "").trim();
    const fullName = String(snap?.fullName || "").trim();
    const quotaUsed = Number(snap?.quotaUsed || 0);
    const trialUsed = Number(snap?.trialUsed || 0);
    const planMeta = planCode ? planMap.get(planCode) : null;
    const hasPendingBizProfile = !!(snap?.pendingBizProfile && typeof snap.pendingBizProfile === "object");

    if (status === "ACTIVE" && !planCode) keys.push("activeWithoutPlan");
    if (status === "TRIAL" && planCode) keys.push("trialWithPlan");
    if (planCode && !planMeta) keys.push("planNotFound");
    if (planMeta && !planMeta.active) keys.push("inactivePlanInUse");
    if (paymentMethod && !asaasCustomerId) keys.push("paymentWithoutCustomer");
    if (asaasSubscriptionId && !asaasCustomerId) keys.push("subscriptionWithoutCustomer");
    if (status === "ACTIVE" && !asaasSubscriptionId) keys.push("activeWithoutSubscription");
    if (quotaUsed < 0) keys.push("quotaNegative");
    if (trialUsed < 0) keys.push("trialNegative");
    if (status === "TRIAL" && quotaUsed > 0) keys.push("trialWithQuota");
    if (!fullName) keys.push("noName");
    if (lastInboundTs > now) keys.push("futureInbound");
    if (status === "WAIT_PLAN" && asaasSubscriptionId) keys.push("waitPlanWithSubscription");
    if (snap?.cardCanceledAt && !snap?.cardValidUntil) keys.push("cardCanceledWithoutValidUntil");
    if (hasPendingBizProfile) keys.push("pendingBizProfile");

    return keys;
  }

  async function enrichUserForCrm(waId, planMap, now) {
    const [snap, lastInboundTsRaw] = await Promise.all([
      getUserSnapshot(waId),
      getLastInboundTs(waId),
    ]);

    const lastInboundTs = Number(lastInboundTsRaw || 0);
    const windowExpiresAt = lastInboundTs ? lastInboundTs + 24 * 60 * 60 * 1000 : 0;
    const inWindow = lastInboundTs ? now - lastInboundTs < 24 * 60 * 60 * 1000 : false;
    const planCode = String(snap?.plan || "").trim().toUpperCase();
    const planMeta = planCode ? planMap.get(planCode) : null;
    const issueKeys = detectUserInconsistencyKeys(snap, lastInboundTs, now, planMap);

    return {
      waId: String(waId || ""),
      fullName: String(snap?.fullName || ""),
      status: String(snap?.status || ""),
      plan: String(snap?.plan || ""),
      planName: String(planMeta?.name || ""),
      planDescription: String(planMeta?.description || ""),
      paymentMethod: String(snap?.paymentMethod || ""),
      quotaUsed: Number(snap?.quotaUsed || 0),
      trialUsed: Number(snap?.trialUsed || 0),
      templateMode: String(snap?.templateMode || ""),
      billingCityState: String(snap?.billingCityState || ""),
      billingAddress: String(snap?.billingAddress || ""),
      asaasCustomerId: String(snap?.asaasCustomerId || ""),
      asaasSubscriptionId: String(snap?.asaasSubscriptionId || ""),
      cardValidUntil: String(snap?.cardValidUntil || ""),
      cardCanceledAt: String(snap?.cardCanceledAt || ""),
      doc: snap?.doc || { docType: "", docLast4: "" },
      bizProfile: snap?.bizProfile || null,
      pendingBizProfile: snap?.pendingBizProfile || null,
      hasBizProfile: !!(snap?.bizProfile && typeof snap.bizProfile === "object"),
      hasPendingBizProfile: !!(snap?.pendingBizProfile && typeof snap.pendingBizProfile === "object"),
      inWindow,
      lastInboundTs,
      windowExpiresAt,
      issueKeys,
      issueCount: issueKeys.length,
      snapshot: snap,
    };
  }

  async function collectInconsistencies() {
    const usersRaw = await listUsers();
    const waIds = Array.isArray(usersRaw) ? usersRaw.slice().sort() : [];
    const plans = await listPlans({ includeInactive: true });
    const planMap = buildPlanMap(plans);

    const buckets = {
      activeWithoutPlan: buildInconsistencyBucket("Assinante sem plano", "danger", "Usuário está ativo, mas não tem nenhum plano salvo."),
      trialWithPlan: buildInconsistencyBucket("Trial com plano salvo", "warn", "Usuário ainda está no teste, mas já aparece com um plano preenchido."),
      planNotFound: buildInconsistencyBucket("Plano não encontrado", "danger", "O plano salvo no usuário não existe mais no catálogo do sistema."),
      inactivePlanInUse: buildInconsistencyBucket("Plano desativado em uso", "warn", "O usuário está vinculado a um plano que hoje está desativado."),
      paymentWithoutCustomer: buildInconsistencyBucket("Pagamento sem cadastro Asaas", "warn", "Há forma de pagamento definida, mas falta o código do cliente no Asaas."),
      subscriptionWithoutCustomer: buildInconsistencyBucket("Assinatura sem cliente Asaas", "danger", "Existe assinatura salva, mas não existe cliente correspondente no Asaas."),
      activeWithoutSubscription: buildInconsistencyBucket("Assinante sem assinatura Asaas", "danger", "Usuário está ativo, mas não há assinatura registrada no Asaas."),
      quotaNegative: buildInconsistencyBucket("Uso mensal negativo", "danger", "O contador de uso mensal ficou abaixo de zero, o que não deveria acontecer."),
      trialNegative: buildInconsistencyBucket("Uso do trial negativo", "danger", "O contador de uso do teste ficou abaixo de zero, o que indica erro de dados."),
      trialWithQuota: buildInconsistencyBucket("Trial usando quota de plano", "warn", "Usuário em teste aparece com consumo na quota mensal de assinante."),
      noName: buildInconsistencyBucket("Usuário sem nome", "info", "Cadastro sem nome preenchido, o que dificulta suporte e cobrança."),
      futureInbound: buildInconsistencyBucket("Mensagem com data futura", "warn", "A última mensagem recebida ficou registrada com horário no futuro."),
      waitPlanWithSubscription: buildInconsistencyBucket("Aguardando plano com assinatura", "warn", "Usuário ainda está aguardando plano, mas já possui assinatura criada."),
      cardCanceledWithoutValidUntil: buildInconsistencyBucket("Cancelado sem data final", "warn", "O cartão foi cancelado, mas não foi salva a data final de acesso."),
      pendingBizProfile: buildInconsistencyBucket("Perfil da empresa pendente", "info", "Há dados da empresa aguardando confirmação ou finalização pelo usuário."),
    };

    function pushIssue(bucketKey, snap, extra = {}) {
      const bucket = buckets[bucketKey];
      if (!bucket) return;
      bucket.items.push({
        waId: String(snap?.waId || extra.waId || ""),
        fullName: String(snap?.fullName || ""),
        status: String(snap?.status || ""),
        plan: String(snap?.plan || ""),
        paymentMethod: String(snap?.paymentMethod || ""),
        asaasCustomerId: String(snap?.asaasCustomerId || ""),
        asaasSubscriptionId: String(snap?.asaasSubscriptionId || ""),
        quotaUsed: Number(snap?.quotaUsed || 0),
        trialUsed: Number(snap?.trialUsed || 0),
        cardValidUntil: String(snap?.cardValidUntil || ""),
        cardCanceledAt: String(snap?.cardCanceledAt || ""),
        ...extra,
      });
      bucket.count = bucket.items.length;
    }

    const now = nowMs();

    await mapLimit(waIds, 20, async (waId) => {
      const user = await enrichUserForCrm(waId, planMap, now);
      const snap = user.snapshot || {};
      const planMeta = user.plan ? planMap.get(String(user.plan || "").trim().toUpperCase()) : null;

      for (const key of user.issueKeys || []) {
        const extra = {};
        if (key === "inactivePlanInUse") extra.planName = String(planMeta?.name || "");
        if (key === "futureInbound") {
          extra.lastInboundTs = user.lastInboundTs;
          extra.nowMs = now;
        }
        if (key === "pendingBizProfile") extra.pendingKeys = Object.keys(snap.pendingBizProfile || {});
        pushIssue(key, snap, extra);
      }
    });

    const summary = Object.entries(buckets).map(([key, bucket]) => ({
      key,
      label: bucket.label,
      severity: bucket.severity,
      description: bucket.description,
      count: bucket.count,
    }));

    const totalIssues = summary.reduce((acc, item) => acc + item.count, 0);

    return {
      ok: true,
      ts: Date.now(),
      usersCount: waIds.length,
      totalIssues,
      summary,
      items: buckets,
    };
  }

  async function buildExecutiveDashboardData() {
    const [usersRaw, global, window24hCount, systemPlans, inconsistencyData, operational] = await Promise.all([
      listUsers(),
      getGlobalDescriptionMetrics(),
      countWindow24hActive(),
      listPlans({ includeInactive: true }),
      collectInconsistencies(),
      buildOperationalReadModel(),
    ]);

    const waIds = Array.isArray(usersRaw) ? usersRaw.slice().sort() : [];
    const now = nowMs();
    const planMap = buildPlanMap(systemPlans);
    const users = await mapLimit(waIds, 20, async (waId) => enrichUserForCrm(waId, planMap, now));

    const statusCounts = getCrmStatusCounters();
    const paymentCounts = { CARD: 0, PIX: 0, NONE: 0, OTHER: 0 };
    const planCounts = new Map();
    const cityCounts = new Map();

    let activePaidUsers = 0;
    let totalMrrCents = 0;
    let withName = 0;
    let withBizProfile = 0;
    let withPendingBizProfile = 0;
    let withAsaasCustomer = 0;
    let withAsaasSubscription = 0;
    let withBilling = 0;
    let issueUsers = 0;

    for (const user of users) {
      const status = String(user?.status || "").trim().toUpperCase();
      if (statusCounts[status] === undefined) statusCounts.UNKNOWN += 1;
      else statusCounts[status] += 1;

      const payment = String(user?.paymentMethod || "").trim().toUpperCase();
      if (payment === "CARD") paymentCounts.CARD += 1;
      else if (payment === "PIX") paymentCounts.PIX += 1;
      else if (!payment) paymentCounts.NONE += 1;
      else paymentCounts.OTHER += 1;

      if (user?.fullName) withName += 1;
      if (user?.hasBizProfile) withBizProfile += 1;
      if (user?.hasPendingBizProfile) withPendingBizProfile += 1;
      if (user?.asaasCustomerId) withAsaasCustomer += 1;
      if (user?.asaasSubscriptionId) withAsaasSubscription += 1;
      if (user?.billingCityState || user?.billingAddress) withBilling += 1;
      if ((user?.issueCount || 0) > 0) issueUsers += 1;

      const city = String(user?.billingCityState || "").trim();
      if (city) cityCounts.set(city, (cityCounts.get(city) || 0) + 1);

      const planCode = String(user?.plan || "").trim().toUpperCase();
      const planMeta = planCode ? planMap.get(planCode) : null;
      if (planCode) {
        const prev = planCounts.get(planCode) || {
          code: planCode,
          name: String(planMeta?.name || planCode),
          description: String(planMeta?.description || ""),
          priceCents: Number(planMeta?.priceCents || 0),
          count: 0,
          mrrCents: 0,
        };
        prev.count += 1;
        if (status === "ACTIVE" && Number.isFinite(Number(planMeta?.priceCents))) {
          prev.mrrCents += Number(planMeta?.priceCents || 0);
        }
        planCounts.set(planCode, prev);
      }

      if (status === "ACTIVE" && planMeta) {
        activePaidUsers += 1;
        totalMrrCents += Number(planMeta?.priceCents || 0);
      }
    }

    const totalUsers = users.length;
    const activeUsers = statusCounts.ACTIVE || 0;
    const trialUsers = statusCounts.TRIAL || 0;
    const paymentPendingUsers = statusCounts.PAYMENT_PENDING || 0;
    const waitPlanUsers = statusCounts.WAIT_PLAN || 0;
    const blockedUsers = statusCounts.BLOCKED || 0;
    const avgTicketCents = activePaidUsers ? Math.round(totalMrrCents / activePaidUsers) : 0;
    const avgDescriptionsPerActive = activeUsers ? Number((Number(global?.monthCount || 0) / activeUsers).toFixed(2)) : 0;
    const conversionBase = activeUsers + trialUsers;
    const trialToPaidPct = conversionBase > 0 ? Number(((activeUsers / conversionBase) * 100).toFixed(1)) : 0;
    const baseActivationPct = totalUsers > 0 ? Number(((activeUsers / totalUsers) * 100).toFixed(1)) : 0;
    const profileCoveragePct = totalUsers > 0 ? Number(((withBizProfile / totalUsers) * 100).toFixed(1)) : 0;
    const nameCoveragePct = totalUsers > 0 ? Number(((withName / totalUsers) * 100).toFixed(1)) : 0;
    const inconsistencyPct = totalUsers > 0 ? Number(((issueUsers / totalUsers) * 100).toFixed(1)) : 0;

    const plans = Array.from(planCounts.values()).sort((a, b) => {
      if (b.mrrCents !== a.mrrCents) return b.mrrCents - a.mrrCents;
      if (b.count !== a.count) return b.count - a.count;
      return String(a.code).localeCompare(String(b.code));
    });

    const cities = Array.from(cityCounts.entries())
      .map(([city, count]) => ({ city, count }))
      .sort((a, b) => (b.count - a.count) || String(a.city).localeCompare(String(b.city)))
      .slice(0, 8);

    const payments = [
      { type: "CARD", count: paymentCounts.CARD },
      { type: "PIX", count: paymentCounts.PIX },
      { type: "Sem método", count: paymentCounts.NONE },
      { type: "Outro", count: paymentCounts.OTHER },
    ];

    return {
      ok: true,
      ts: Date.now(),
      overview: {
        totalUsers,
        activeUsers,
        trialUsers,
        paymentPendingUsers,
        waitPlanUsers,
        blockedUsers,
        activeSharePct: baseActivationPct,
        trialToPaidPct,
      },
      revenue: {
        mrrCents: totalMrrCents,
        avgTicketCents,
        activePaidUsers,
      },
      usage: {
        descriptionsToday: Number(global?.dayCount || 0),
        descriptionsMonth: Number(global?.monthCount || 0),
        dayLabel: String(global?.day || ""),
        monthLabel: String(global?.month || ""),
        window24hCount: Number(window24hCount || 0),
        avgDescriptionsPerActive,
      },
      quality: {
        withName,
        withBizProfile,
        withPendingBizProfile,
        withAsaasCustomer,
        withAsaasSubscription,
        withBilling,
        issueUsers,
        profileCoveragePct,
        nameCoveragePct,
        inconsistencyPct,
      },
      statusCounts,
      payments,
      plans,
      cities,
      inconsistencies: inconsistencyData,
      operational,
    };
  }

  function feedbackResponseLabel(value) {
    const v = String(value || "").trim();
    if (v === "1") return "Muito";
    if (v === "2") return "Mais ou menos";
    if (v === "3") return "Não";
    return "";
  }

  async function buildFeedbackCenterData() {
    const users = await listUsers();
    const snapshots = await mapLimitDashboard(users, 25, async (waId) => {
      const snap = await getUserSnapshot(waId);
      return snap;
    });

    const items = [];
    const summary = {
      usersScanned: users.length,
      feedbackAsked: 0,
      feedbackAnswered: 0,
      positive: 0,
      neutral: 0,
      negative: 0,
      comments: 0,
      testimonials: 0,
      consented: 0,
      pendingReview: 0,
      approved: 0,
      rejected: 0,
      published: 0,
      internalOnly: 0,
    };

    for (const snap of snapshots) {
      if (!snap || snap.__error) continue;
      const meta = snap.growthMeta && typeof snap.growthMeta === 'object' ? snap.growthMeta : {};
      const feedbackResponse = String(meta.feedbackResponse || '').trim();
      const feedbackComment = String(meta.feedbackComment || '').trim();
      const testimonialText = String(meta.testimonialText || '').trim();
      const testimonialConsent = String(meta.testimonialConsent || '').trim().toUpperCase();
      const testimonialStatus = String(meta.testimonialStatus || '').trim().toUpperCase();
      const hasAny = Boolean(
        meta.feedbackAskedAt ||
        meta.feedbackAnsweredAt ||
        feedbackResponse ||
        feedbackComment ||
        meta.testimonialAskedAt ||
        testimonialText ||
        testimonialConsent
      );
      if (!hasAny) continue;

      if (meta.feedbackAskedAt) summary.feedbackAsked += 1;
      if (meta.feedbackAnsweredAt || feedbackResponse) summary.feedbackAnswered += 1;
      if (feedbackResponse === '1') summary.positive += 1;
      if (feedbackResponse === '2') summary.neutral += 1;
      if (feedbackResponse === '3') summary.negative += 1;
      if (feedbackComment) summary.comments += 1;
      if (testimonialText) summary.testimonials += 1;
      if (testimonialConsent === 'YES') summary.consented += 1;
      if (testimonialStatus === 'PENDING_REVIEW') summary.pendingReview += 1;
      if (testimonialStatus === 'APPROVED') summary.approved += 1;
      if (testimonialStatus === 'REJECTED') summary.rejected += 1;
      if (testimonialStatus === 'PUBLISHED') summary.published += 1;
      if (testimonialStatus === 'INTERNAL_ONLY') summary.internalOnly += 1;

      const latestAt = [
        meta.testimonialStatusUpdatedAt,
        meta.testimonialConsentAt,
        meta.testimonialTextAt,
        meta.feedbackCommentAt,
        meta.feedbackAnsweredAt,
        meta.feedbackAskedAt,
      ].map((value) => String(value || '').trim()).filter(Boolean).sort().slice(-1)[0] || '';

      items.push({
        waId: String(snap.waId || ''),
        fullName: String(snap.fullName || ''),
        companyName: String(snap?.bizProfile?.companyName || ''),
        feedbackResponse,
        feedbackResponseLabel: feedbackResponseLabel(feedbackResponse),
        feedbackAnsweredAt: String(meta.feedbackAnsweredAt || ''),
        feedbackComment,
        feedbackCommentAt: String(meta.feedbackCommentAt || ''),
        testimonialText,
        testimonialTextAt: String(meta.testimonialTextAt || meta.testimonialReceivedAt || ''),
        testimonialConsent,
        testimonialConsentAt: String(meta.testimonialConsentAt || ''),
        testimonialDisplayMode: String(meta.testimonialDisplayMode || ''),
        testimonialDisplayName: String(meta.testimonialDisplayName || ''),
        testimonialStatus,
        testimonialStatusUpdatedAt: String(meta.testimonialStatusUpdatedAt || ''),
        latestAt,
      });
    }

    items.sort((a, b) => String(b.latestAt || '').localeCompare(String(a.latestAt || '')));

    const answeredBase = summary.feedbackAnswered || 0;
    const pct = (count) => answeredBase > 0 ? Number(((Number(count || 0) / answeredBase) * 100).toFixed(1)) : 0;

    let metrics = { ok: false };
    let metricsTimeline = { ok: false };
    try {
      const [overview, answeredTimeline] = await Promise.all([
        getFeedbackMetricsOverview(),
        getMetricEventLastNDays('feedback_answered', 30),
      ]);
      metrics = overview;
      metricsTimeline = answeredTimeline;
    } catch (_) {
      // best-effort: o centro continua funcionando mesmo sem telemetria dedicada
    }

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      summary: {
        ...summary,
        positivePct: pct(summary.positive),
        neutralPct: pct(summary.neutral),
        negativePct: pct(summary.negative),
      },
      metrics,
      metricsTimeline,
      items,
    };
  }

  router.get("/executive/data", async (req, res) => {
    try {
      const data = await buildExecutiveDashboardData();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/executive-ui", async (req, res) => {
    const inner = `
      <div class="card pad" style="margin-bottom:14px;">
        <div class="row" style="justify-content:space-between; align-items:flex-start;">
          <div>
            <h3 style="margin:0 0 6px 0;">🧠 Dashboard Executivo SaaS</h3>
            <div class="muted">Visão gerencial do produto: base de usuários, receita estimada, uso do sistema e saúde operacional.</div>
          </div>
          <div class="row">
            <a class="pill" href="/admin/dashboard">Dashboard operacional</a>
            <a class="pill" href="/admin/inconsistencies-ui">Inconsistências</a>
            <button type="button" class="primary" id="reloadExecutiveBtn">Atualizar</button>
          </div>
        </div>
      </div>

      <div class="grid cols3">
        <div class="kpi"><div class="t">Usuários totais</div><div class="v" id="exTotalUsers">—</div><div class="muted" id="exActiveShare">—</div></div>
        <div class="kpi"><div class="t">Assinantes ativos</div><div class="v" id="exActiveUsers">—</div><div class="muted" id="exTrialToPaid">—</div></div>
        <div class="kpi"><div class="t">MRR estimado</div><div class="v" id="exMrr">—</div><div class="muted" id="exAvgTicket">—</div></div>
      </div>

      <div class="grid cols3" style="margin-top:12px;">
        <div class="kpi"><div class="t">Descrições hoje</div><div class="v" id="exDescToday">—</div><div class="muted" id="exDescTodayLabel">—</div></div>
        <div class="kpi"><div class="t">Descrições no mês</div><div class="v" id="exDescMonth">—</div><div class="muted" id="exDescMonthLabel">—</div></div>
        <div class="kpi"><div class="t">Usuários ativos 24h</div><div class="v" id="ex24hUsers">—</div><div class="muted" id="exAvgUsage">—</div></div>
      </div>

      <div class="grid cols3" style="margin-top:12px;">
        <div class="kpi"><div class="t">Perfis com empresa salva</div><div class="v" id="exBizProfiles">—</div><div class="muted" id="exBizProfilesPct">—</div></div>
        <div class="kpi"><div class="t">Cadastros com nome</div><div class="v" id="exWithName">—</div><div class="muted" id="exWithNamePct">—</div></div>
        <div class="kpi"><div class="t">Usuários com inconsistência</div><div class="v" id="exIssueUsers">—</div><div class="muted" id="exIssuePct">—</div></div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <h4 style="margin:0;">Distribuição da base</h4>
            <span class="muted">Status atuais</span>
          </div>
          <div class="hr"></div>
          <div id="statusPills"></div>
          <div class="hr"></div>
          <div id="paymentPills"></div>
        </div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <h4 style="margin:0;">Saúde operacional</h4>
            <a class="pill" href="/admin/audit-ui">Auditoria</a>
          </div>
          <div class="hr"></div>
          <div id="healthPills"></div>
        </div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <h4 style="margin:0;">Planos e MRR</h4>
            <span class="muted">Ranking atual</span>
          </div>
          <div class="hr"></div>
          <div style="overflow:auto;">
            <table>
              <thead>
                <tr>
                  <th>Plano</th>
                  <th>Usuários</th>
                  <th>MRR</th>
                  <th>Descrição</th>
                </tr>
              </thead>
              <tbody id="plansRows"><tr><td colspan="4" class="muted">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <h4 style="margin:0;">Top cidades / região</h4>
            <span class="muted">billingCityState</span>
          </div>
          <div class="hr"></div>
          <div style="overflow:auto;">
            <table>
              <thead>
                <tr>
                  <th>Local</th>
                  <th>Usuários</th>
                </tr>
              </thead>
              <tbody id="citiesRows"><tr><td colspan="2" class="muted">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card pad" style="margin-top:14px;">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h4 style="margin:0;">Resumo de inconsistências</h4>
            <div class="muted">Leitura consolidada do painel de inconsistências.</div>
          </div>
          <a class="pill" href="/admin/inconsistencies-ui">Abrir painel completo</a>
        </div>
        <div class="hr"></div>
        <div style="overflow:auto;">
          <table>
            <thead>
              <tr>
                <th>Indicador</th>
                <th>Nível</th>
                <th>Qtd.</th>
                <th>Descrição</th>
              </tr>
            </thead>
            <tbody id="issuesRows"><tr><td colspan="4" class="muted">Carregando...</td></tr></tbody>
          </table>
        </div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <h4 style="margin:0;">Eventos operacionais recentes</h4>
            <span class="muted">Runtime do sistema</span>
          </div>
          <div class="hr"></div>
          <div style="overflow:auto;">
            <table>
              <thead>
                <tr><th>Quando</th><th>Módulo</th><th>Nível</th><th>Evento</th><th>Resumo</th></tr>
              </thead>
              <tbody id="exOpsRows"><tr><td colspan="5" class="muted">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>
        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <h4 style="margin:0;">Módulos com falhas recentes</h4>
            <span class="muted">Leitura operacional</span>
          </div>
          <div class="hr"></div>
          <div style="overflow:auto;">
            <table>
              <thead>
                <tr><th>Módulo</th><th>Ocorrências</th><th>Erros</th><th>Atenções</th><th>Último evento</th></tr>
              </thead>
              <tbody id="exModulesRows"><tr><td colspan="5" class="muted">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card pad" style="margin-top:14px;">
        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="executiveRaw" style="white-space:pre-wrap; overflow:auto; max-height:360px;"></pre>
        </details>
      </div>
    `;

    const scriptExtra = `
      <script>
        (function(){
          function esc(value){
            return String(value ?? '')
              .replaceAll('&','&amp;')
              .replaceAll('<','&lt;')
              .replaceAll('>','&gt;')
              .replaceAll('"','&quot;')
              .replaceAll("'",'&#39;');
          }
          function setText(id, value){
            const el = document.getElementById(id);
            if (el) el.textContent = String(value ?? '—');
          }
          function fmtBRL(cents){
            const v = (Number(cents) || 0) / 100;
            try { return v.toLocaleString('pt-BR', { style:'currency', currency:'BRL' }); }
            catch (_) { return 'R$ ' + v.toFixed(2); }
          }
          function fmtPct(value){
            const n = Number(value || 0);
            return n.toFixed(1).replace('.', ',') + '%';
          }
          function severityBadge(severity){
            const s = String(severity || 'soft').toLowerCase();
            const cls = ['danger','warn','info','ok'].includes(s) ? s : 'soft';
            const label = cls === 'danger' ? 'Crítico' : cls === 'warn' ? 'Atenção' : cls === 'info' ? 'Info' : 'OK';
            return '<span class="badge ' + cls + '">' + label + '</span>';
          }
          function renderPills(containerId, items, formatter){
            const el = document.getElementById(containerId);
            if (!el) return;
            if (!Array.isArray(items) || !items.length) {
              el.innerHTML = '<span class="muted">Sem dados.</span>';
              return;
            }
            el.innerHTML = items.map(function(item){ return formatter(item); }).join(' ');
          }
          function renderTableRows(containerId, rowsHtml, emptyColspan, emptyText){
            const el = document.getElementById(containerId);
            if (!el) return;
            el.innerHTML = rowsHtml || '<tr><td colspan="' + String(emptyColspan) + '" class="muted">' + esc(emptyText || 'Sem dados.') + '</td></tr>';
          }
          async function loadExecutive(){
            const response = await fetch('/admin/executive/data');
            const data = await response.json().catch(function(){ return {}; });
            document.getElementById('executiveRaw').textContent = JSON.stringify(data, null, 2);
            if (!response.ok || !data.ok) {
              renderTableRows('plansRows', '', 4, 'Erro ao carregar dashboard executivo.');
              renderTableRows('citiesRows', '', 2, 'Erro ao carregar dashboard executivo.');
              renderTableRows('issuesRows', '', 4, 'Erro ao carregar dashboard executivo.');
              return;
            }

            const overview = data.overview || {};
            const revenue = data.revenue || {};
            const usage = data.usage || {};
            const quality = data.quality || {};
            const statusCounts = data.statusCounts || {};
            const payments = Array.isArray(data.payments) ? data.payments : [];
            const plans = Array.isArray(data.plans) ? data.plans : [];
            const cities = Array.isArray(data.cities) ? data.cities : [];
            const issues = Array.isArray(data?.inconsistencies?.summary) ? data.inconsistencies.summary : [];

            setText('exTotalUsers', overview.totalUsers || 0);
            setText('exActiveShare', 'Ativação da base: ' + fmtPct(overview.activeSharePct || 0));
            setText('exActiveUsers', overview.activeUsers || 0);
            setText('exTrialToPaid', 'Conversão trial → pago: ' + fmtPct(overview.trialToPaidPct || 0));
            setText('exMrr', fmtBRL(revenue.mrrCents || 0));
            setText('exAvgTicket', 'Ticket médio: ' + fmtBRL(revenue.avgTicketCents || 0));

            setText('exDescToday', usage.descriptionsToday || 0);
            setText('exDescTodayLabel', usage.dayLabel ? ('Dia ' + usage.dayLabel) : 'Sem referência');
            setText('exDescMonth', usage.descriptionsMonth || 0);
            setText('exDescMonthLabel', usage.monthLabel ? ('Mês ' + usage.monthLabel) : 'Sem referência');
            setText('ex24hUsers', usage.window24hCount || 0);
            setText('exAvgUsage', 'Média por ativo: ' + String(usage.avgDescriptionsPerActive || 0).replace('.', ','));

            setText('exBizProfiles', quality.withBizProfile || 0);
            setText('exBizProfilesPct', 'Cobertura: ' + fmtPct(quality.profileCoveragePct || 0));
            setText('exWithName', quality.withName || 0);
            setText('exWithNamePct', 'Cobertura: ' + fmtPct(quality.nameCoveragePct || 0));
            setText('exIssueUsers', quality.issueUsers || 0);
            setText('exIssuePct', 'Base afetada: ' + fmtPct(quality.inconsistencyPct || 0));

            renderPills('statusPills', [
              { label: 'TRIAL', value: statusCounts.TRIAL || 0 },
              { label: 'ACTIVE', value: statusCounts.ACTIVE || 0 },
              { label: 'WAIT_PLAN', value: statusCounts.WAIT_PLAN || 0 },
              { label: 'PAYMENT_PENDING', value: statusCounts.PAYMENT_PENDING || 0 },
              { label: 'BLOCKED', value: statusCounts.BLOCKED || 0 },
              { label: 'UNKNOWN', value: statusCounts.UNKNOWN || 0 }
            ], function(item){
              return '<span class="pill"><b>' + esc(item.label) + '</b>: ' + esc(item.value) + '</span>';
            });

            renderPills('paymentPills', payments, function(item){
              return '<span class="pill"><b>' + esc(item.type) + '</b>: ' + esc(item.count) + '</span>';
            });

            renderPills('healthPills', [
              { label: 'Com Asaas Customer', value: quality.withAsaasCustomer || 0 },
              { label: 'Com assinatura Asaas', value: quality.withAsaasSubscription || 0 },
              { label: 'Com billing preenchido', value: quality.withBilling || 0 },
              { label: 'Perfil pendente', value: quality.withPendingBizProfile || 0 }
            ], function(item){
              return '<span class="pill"><b>' + esc(item.label) + '</b>: ' + esc(item.value) + '</span>';
            });

            const plansRows = plans.map(function(item){
              return '<tr>' +
                '<td><b>' + esc(item.name || item.code || '—') + '</b><div class="muted" style="font-size:12px;">' + esc(item.code || '') + '</div></td>' +
                '<td>' + esc(item.count || 0) + '</td>' +
                '<td>' + esc(fmtBRL(item.mrrCents || 0)) + '</td>' +
                '<td>' + esc(item.description || '—') + '</td>' +
              '</tr>';
            }).join('');
            renderTableRows('plansRows', plansRows, 4, 'Nenhum plano encontrado.');

            const citiesRows = cities.map(function(item){
              return '<tr><td>' + esc(item.city || '—') + '</td><td><b>' + esc(item.count || 0) + '</b></td></tr>';
            }).join('');
            renderTableRows('citiesRows', citiesRows, 2, 'Nenhuma cidade/região preenchida.');

            const issuesRows = issues.map(function(item){
              return '<tr>' +
                '<td><b>' + esc(item.label || '') + '</b></td>' +
                '<td>' + severityBadge(item.severity) + '</td>' +
                '<td><b>' + esc(item.count || 0) + '</b></td>' +
                '<td>' + esc(item.description || '') + '</td>' +
              '</tr>';
            }).join('');
            renderTableRows('issuesRows', issuesRows, 4, 'Nenhuma inconsistência encontrada.');

            const ops = data.operational || {};
            const opRows = (Array.isArray(ops.recentEvents) ? ops.recentEvents : []).map(function(item){
              return '<tr>' +
                '<td><code>' + esc(item.ts || '') + '</code></td>' +
                '<td><b>' + esc(item.module || '—') + '</b></td>' +
                '<td>' + severityBadge(item.level) + '</td>' +
                '<td>' + esc(item.event || '—') + '</td>' +
                '<td>' + esc(item.message || item.step || item.errorCode || '—') + '</td>' +
              '</tr>';
            }).join('');
            renderTableRows('exOpsRows', opRows, 5, 'Sem eventos operacionais recentes.');

            const moduleRows = (Array.isArray(ops.modules) ? ops.modules : []).slice(0, 10).map(function(item){
              return '<tr>' +
                '<td><b>' + esc(item.module || '—') + '</b></td>' +
                '<td>' + esc(item.count || 0) + '</td>' +
                '<td><b>' + esc(item.errorCount || 0) + '</b></td>' +
                '<td>' + esc(item.warnCount || 0) + '</td>' +
                '<td>' + esc(item.lastEvent || '—') + '</td>' +
              '</tr>';
            }).join('');
            renderTableRows('exModulesRows', moduleRows, 5, 'Sem módulos com atividade operacional relevante.');
          }

          document.addEventListener('DOMContentLoaded', function(){
            const reloadBtn = document.getElementById('reloadExecutiveBtn');
            if (reloadBtn) reloadBtn.addEventListener('click', loadExecutive);
            loadExecutive();
          });
        })();
      </script>
    `;

    const html = layoutBase({
      title: "Dashboard Executivo",
      activePath: "/admin/executive-ui",
      content: inner,
      scriptExtra,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/ops/data", async (req, res) => {
    try {
      const data = await buildOperationalDashboardData({
        period: req.query?.period,
        module: req.query?.module,
        level: req.query?.level,
        onlyFailures: req.query?.onlyFailures,
        onlyInconsistencies: req.query?.onlyInconsistencies,
        query: req.query?.q || req.query?.query,
      });
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/ops-ui", async (req, res) => {
    const inner = `
      <div class="card pad" style="margin-bottom:14px;">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
          <div>
            <h3 style="margin:0 0 6px 0;">🧠 Observabilidade Operacional</h3>
            <div class="muted">Este painel mostra eventos reais de execução do sistema, separando métricas, auditoria administrativa e comportamento técnico do runtime.</div>
          </div>
          <div class="row">
            <a class="pill" href="/admin/dashboard">Dashboard</a>
            <a class="pill" href="/admin/finance-asaas-ui">Financeiro Asaas</a>
            <a class="pill" href="/admin/audit-ui">Auditoria administrativa</a>
            <button type="button" class="primary" id="reloadOpsBtn">Atualizar</button>
          </div>
        </div>
      </div>

      <div id="redisOpsBanner" class="card pad" style="margin-bottom:12px; display:none; border-color:rgba(239,68,68,.28); background:rgba(254,242,242,.95);">
        <div class="row" style="justify-content:space-between; align-items:center; gap:12px;">
          <div>
            <div style="font-weight:800;">🚨 Saúde Redis / Modo degradado</div>
            <div class="muted" id="redisOpsBannerText">Detectando status do Redis…</div>
          </div>
          <span id="redisOpsBannerBadge" class="badge danger">DEGRADED</span>
        </div>
      </div>

      <div class="card pad" style="margin-bottom:12px;">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
          <div>
            <h3 style="margin:0 0 6px 0;">🧠 Saúde Redis / Modo degradado</h3>
            <div class="muted">Snapshot atual da camada resiliente do Redis, com último incidente aberto e distribuição recente por módulo.</div>
          </div>
          <div class="row">
            <span id="redisHealthStatus" class="badge soft">HEALTHY</span>
            <span id="redisOpenIncidents" class="badge info">0 abertos</span>
          </div>
        </div>
        <div class="hr"></div>
        <div class="grid cols3">
          <div class="kpi"><div class="t">Status atual</div><div class="v" id="redisHealthStatusValue">—</div></div>
          <div class="kpi"><div class="t">Último erro</div><div class="v" style="font-size:16px;" id="redisHealthLastError">—</div></div>
          <div class="kpi"><div class="t">Último incidente aberto</div><div class="v" style="font-size:16px;" id="redisHealthLatestIncident">—</div></div>
        </div>
        <div class="hr"></div>
        <div class="grid cols2">
          <div class="card pad">
            <div style="font-weight:700; margin-bottom:8px;">Detalhes do snapshot</div>
            <div class="muted" id="redisHealthDetails">Carregando…</div>
          </div>
          <div class="card pad">
            <div style="font-weight:700; margin-bottom:8px;">Contagem recente por módulo</div>
            <div id="redisHealthModules" class="muted">Carregando…</div>
          </div>
        </div>
      </div>

      <div class="card pad" style="margin-bottom:12px;">
        <div class="row" style="gap:8px; align-items:flex-end;">
          <div>
            <div class="muted" style="font-size:12px; margin-bottom:4px;">Período</div>
            <select id="opsPeriod">
              <option value="24h">Últimas 24h</option>
              <option value="72h">Últimos 3 dias</option>
              <option value="7d">Últimos 7 dias</option>
              <option value="30d">Últimos 30 dias</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px; margin-bottom:4px;">Módulo</div>
            <select id="opsModule">
              <option value="">Todos</option>
              <option value="flow">Flow</option>
              <option value="webhook_route">Webhook</option>
              <option value="meta_whatsapp">Meta / WhatsApp</option>
              <option value="asaas_client">Asaas Client</option>
              <option value="asaas_webhook">Asaas Webhook</option>
              <option value="campaigns">Campanhas</option>
              <option value="broadcast">Broadcast</option>
              <option value="pricing">Pricing</option>
              <option value="state">State</option>
              <option value="server">Server</option>
              <option value="asaas_ledger">Ledger Asaas</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px; margin-bottom:4px;">Nível</div>
            <select id="opsLevel">
              <option value="">Todos</option>
              <option value="error">Erro</option>
              <option value="warn">Aviso</option>
              <option value="info">Info</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px; margin-bottom:4px;">Buscar</div>
            <input id="opsQuery" placeholder="userId, paymentId, campaignId..." />
          </div>
          <label class="pill"><input type="checkbox" id="opsOnlyFailures" style="margin-right:6px;" /> Somente falhas</label>
          <label class="pill"><input type="checkbox" id="opsOnlyInconsistencies" style="margin-right:6px;" /> Somente inconsistências</label>
          <button type="button" id="applyOpsFilters" class="primary">Aplicar</button>
        </div>
      </div>

      <div class="card pad" style="margin-bottom:12px;">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
          <div>
            <h4 style="margin:0 0 6px 0;">Resumo automático</h4>
            <div class="muted" id="opsExecutiveSummary">Carregando leitura operacional...</div>
          </div>
          <div class="pill" id="opsHealthPill">Saúde operacional: —</div>
        </div>
      </div>

      <div class="grid cols3">
        <div class="kpi"><div class="t">Eventos recentes</div><div class="v" id="opsTotalEvents">—</div><div class="muted">Leitura operacional na janela consultada</div></div>
        <div class="kpi"><div class="t">Erros recentes</div><div class="v" id="opsTotalErrors">—</div><div class="muted">Falhas em runtime</div></div>
        <div class="kpi"><div class="t">Warnings recentes</div><div class="v" id="opsTotalWarnings">—</div><div class="muted">Eventos que exigem atenção</div></div>
      </div>
      <div class="grid cols3" style="margin-top:12px;">
        <div class="kpi"><div class="t">Falhas financeiras</div><div class="v" id="opsFinanceFailures">—</div><div class="muted">Pagamentos/expirações recentes</div></div>
        <div class="kpi"><div class="t">Inconsistências financeiras</div><div class="v" id="opsFinanceInconsistencies">—</div><div class="muted">Ledger operacional</div></div>
        <div class="kpi"><div class="t">Módulos com erro</div><div class="v" id="opsModulesWithErrors">—</div><div class="muted">Hotspots operacionais</div></div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Alertas automáticos inteligentes</h4><span class="muted">Derivados dos eventos reais</span></div>
          <div class="hr"></div>
          <div id="opsAlertsList" class="grid"></div>
        </div>
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Destaques rápidos</h4><span class="muted">Resumo executivo</span></div>
          <div class="hr"></div>
          <div id="opsHighlights"></div>
        </div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Falhas por módulo</h4><span class="muted">Top 10</span></div>
          <div class="hr"></div>
          <div style="overflow:auto;"><table><thead><tr><th>Módulo</th><th>Erros</th><th>Avisos</th><th>Último evento</th><th>Severidade</th></tr></thead><tbody id="opsModulesBody"><tr><td colspan="5" class="muted">Carregando...</td></tr></tbody></table></div>
        </div>
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Campanhas sob ótica operacional</h4><span class="muted">Runtime recente</span></div>
          <div class="hr"></div>
          <div id="opsCampaignSummary"></div>
        </div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Últimos erros / avisos</h4><span class="muted">Máx. 20</span></div>
          <div class="hr"></div>
          <div style="overflow:auto;"><table><thead><tr><th>Tempo</th><th>Módulo</th><th>Evento</th><th>Nível</th><th>Status</th><th>Resumo</th></tr></thead><tbody id="opsErrorsBody"><tr><td colspan="6" class="muted">Carregando...</td></tr></tbody></table></div>
        </div>
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Últimos eventos operacionais</h4><span class="muted">Máx. 100</span></div>
          <div class="hr"></div>
          <div style="overflow:auto;"><table><thead><tr><th>Tempo</th><th>Módulo</th><th>Evento</th><th>Nível</th><th>Status</th><th>Usuário</th></tr></thead><tbody id="opsEventsBody"><tr><td colspan="6" class="muted">Carregando...</td></tr></tbody></table></div>
        </div>
      </div>

      <div class="card pad" style="margin-top:14px;">
        <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Leitura financeira operacional</h4><span class="muted">Ledger / Asaas</span></div>
        <div class="hr"></div>
        <div class="grid cols3" style="margin-bottom:10px;">
          <div class="pill">Eventos: <b id="opsFinTotal">—</b></div>
          <div class="pill">Falhas: <b id="opsFinFailures">—</b></div>
          <div class="pill">Inconsistências: <b id="opsFinInconsistencies">—</b></div>
        </div>
        <div style="overflow:auto;"><table><thead><tr><th>Tempo</th><th>Evento</th><th>Categoria</th><th>Status</th><th>Severidade</th><th>Referência</th><th>Resumo</th></tr></thead><tbody id="opsFinancialBody"><tr><td colspan="7" class="muted">Carregando...</td></tr></tbody></table></div>
      </div>
    `;

    const scriptExtra = `
      <script>
        (function(){
          function esc(v){ return String(v ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;'); }
          function badge(level){
            const normalized = String(level || '').toLowerCase();
            if (normalized === 'danger' || normalized === 'error') return '<span class="badge danger">ERRO</span>';
            if (normalized === 'warn' || normalized === 'warning') return '<span class="badge warn">AVISO</span>';
            if (normalized === 'ok') return '<span class="badge ok">OK</span>';
            return '<span class="badge info">INFO</span>';
          }
          function fmt(value){
            if (!value) return '—';
            try { return new Date(value).toLocaleString('pt-BR'); } catch(_) { return String(value); }
          }
          function humanModule(value){
            const key = String(value || '').trim();
            const map = { flow:'Flow', webhook_route:'Webhook', meta_whatsapp:'Meta / WhatsApp', asaas_client:'Asaas Client', asaas_webhook:'Asaas Webhook', campaigns:'Campanhas', broadcast:'Broadcast', pricing:'Pricing', state:'State', server:'Server', asaas_ledger:'Ledger Asaas' };
            return map[key] || key || '—';
          }
          async function loadRedisHealth(){
            const res = await fetch('/admin/ops/redis-health');
            const data = await res.json().catch(()=>({}));
            if (!res.ok || data.ok === false) throw new Error(data.error || 'Falha ao carregar saúde Redis');
            const snapshot = data.snapshot || {};
            const latest = data.latestOpenIncident || null;
            const lastEvent = data.lastRedisEvent || null;
            const modules = Array.isArray(data.recentByModule) ? data.recentByModule : [];
            const status = String(snapshot.status || 'HEALTHY').trim().toUpperCase() || 'HEALTHY';
            const statusClass = status === 'DOWN' ? 'danger' : (status === 'DEGRADED' ? 'warn' : 'ok');
            document.getElementById('redisHealthStatus').innerHTML = '<span class="badge ' + statusClass + '">' + esc(status) + '</span>';
            document.getElementById('redisHealthStatusValue').textContent = status;
            document.getElementById('redisOpenIncidents').textContent = String(Number(data.openIncidentsCount || 0) || 0) + ' abertos';
            document.getElementById('redisHealthLastError').textContent = String(snapshot.lastErrorCode || snapshot.lastErrorMessage || '—');
            document.getElementById('redisHealthLatestIncident').textContent = latest ? String((latest.module || 'redis') + ' · ' + (latest.step || latest.errorCode || latest.status || 'OPEN')) : 'Nenhum';
            document.getElementById('redisHealthDetails').innerHTML =
              '<div><b>Resumo:</b> ' + esc(snapshot.summary || '—') + '</div>' +
              '<div class="muted" style="margin-top:6px;">Último comando com falha: <code>' + esc(snapshot.lastFailingCommand || '—') + '</code></div>' +
              '<div class="muted" style="margin-top:6px;">Último evento: ' + esc(lastEvent ? ((lastEvent.module || 'unknown') + ' · ' + (lastEvent.step || lastEvent.event || 'runtime')) : '—') + '</div>' +
              '<div class="muted" style="margin-top:6px;">Impacto: ' + esc(latest?.impact || latest?.message || '—') + '</div>';
            document.getElementById('redisHealthModules').innerHTML = modules.length
              ? '<table><thead><tr><th>Módulo</th><th>Ocorrências recentes</th></tr></thead><tbody>' + modules.map(function(item){
                  return '<tr><td>' + esc(item.module || 'unknown') + '</td><td><b>' + esc(item.count || 0) + '</b></td></tr>';
                }).join('') + '</tbody></table>'
              : '<div class="muted">Nenhuma ocorrência recente vinculada a Redis.</div>';
            const banner = document.getElementById('redisOpsBanner');
            if (status === 'DOWN' || status === 'DEGRADED') {
              banner.style.display = 'block';
              document.getElementById('redisOpsBannerText').textContent = snapshot.summary || 'Redis em modo degradado.';
              document.getElementById('redisOpsBannerBadge').textContent = status;
              document.getElementById('redisOpsBannerBadge').className = 'badge ' + (status === 'DOWN' ? 'danger' : 'warn');
            } else {
              banner.style.display = 'none';
            }
          }
          async function loadOps(){
            const p = new URLSearchParams();
            const period = document.getElementById('opsPeriod').value;
            const module = document.getElementById('opsModule').value;
            const level = document.getElementById('opsLevel').value;
            const query = document.getElementById('opsQuery').value;
            if (period) p.set('period', period);
            if (module) p.set('module', module);
            if (level) p.set('level', level);
            if (query) p.set('q', query);
            if (document.getElementById('opsOnlyFailures').checked) p.set('onlyFailures', '1');
            if (document.getElementById('opsOnlyInconsistencies').checked) p.set('onlyInconsistencies', '1');
            const res = await fetch('/admin/ops/data?' + p.toString());
            const data = await res.json();
            if (!res.ok || data.ok === false) throw new Error(data.error || 'Falha ao carregar observabilidade operacional');
            await loadRedisHealth();

            const summary = data.summary || {};
            const health = data.health || {};
            document.getElementById('opsExecutiveSummary').textContent = summary.executiveSummary || 'Sem leitura resumida.';
            document.getElementById('opsHealthPill').innerHTML = 'Saúde operacional: ' + badge(health.level || 'info') + ' <span class="muted">' + esc(health.summary || 'Sem leitura disponível') + '</span>';
            document.getElementById('opsTotalEvents').textContent = summary.totalEvents ?? 0;
            document.getElementById('opsTotalErrors').textContent = summary.totalErrors ?? 0;
            document.getElementById('opsTotalWarnings').textContent = summary.totalWarnings ?? 0;
            document.getElementById('opsFinanceFailures').textContent = summary.totalFinancialFailures ?? 0;
            document.getElementById('opsFinanceInconsistencies').textContent = summary.totalFinancialInconsistencies ?? 0;
            document.getElementById('opsModulesWithErrors').textContent = summary.modulesWithErrors ?? 0;
            document.getElementById('opsFinTotal').textContent = data?.financial?.totalEvents ?? 0;
            document.getElementById('opsFinFailures').textContent = data?.financial?.recentFailures ?? 0;
            document.getElementById('opsFinInconsistencies').textContent = data?.financial?.recentInconsistencies ?? 0;

            const alerts = Array.isArray(data.alerts) ? data.alerts : [];
            document.getElementById('opsAlertsList').innerHTML = alerts.length ? alerts.map(function(item){
              return '<div class="card pad">' +
                '<div class="row" style="justify-content:space-between; align-items:flex-start; gap:10px;">' +
                  '<div><div style="font-weight:800;">' + esc(item.title || 'Alerta') + '</div><div class="muted" style="margin-top:4px;">' + esc(item.summary || '') + '</div></div>' +
                  '<div>' + badge(item.level) + '</div>' +
                '</div>' +
                '<div class="hr"></div>' +
                '<div class="muted">Módulo: <b>' + esc(humanModule(item.module)) + '</b> · Ocorrências: <b>' + esc(item.count || 0) + '</b></div>' +
                '<div class="muted" style="margin-top:4px;">Ação sugerida: ' + esc(item.recommendedAction || 'Revisar detalhes operacionais.') + '</div>' +
              '</div>';
            }).join('') : '<div class="muted">Nenhum alerta automático ativo na janela consultada.</div>';

            const highlights = data.highlights || {};
            const hl = [];
            if (highlights.lastFatal) hl.push('<div class="pill">Último fatal: <b>' + esc(humanModule(highlights.lastFatal.module)) + '</b> · ' + esc(fmt(highlights.lastFatal.ts)) + '</div>');
            if (highlights.mostUnstableModule) hl.push('<div class="pill">Módulo mais instável: <b>' + esc(humanModule(highlights.mostUnstableModule.module)) + '</b> · ' + esc(highlights.mostUnstableModule.errorCount || 0) + ' erro(s)</div>');
            if (highlights.latestFinancialInconsistency) hl.push('<div class="pill">Última inconsistência financeira: <b>' + esc(highlights.latestFinancialInconsistency.eventType || highlights.latestFinancialInconsistency.event || 'financeiro') + '</b></div>');
            if (highlights.latestCampaignFailure) hl.push('<div class="pill">Última falha de campanha: <b>' + esc(humanModule(highlights.latestCampaignFailure.module)) + '</b> · ' + esc(fmt(highlights.latestCampaignFailure.ts)) + '</div>');
            document.getElementById('opsHighlights').innerHTML = hl.length ? '<div class="row">' + hl.join('') + '</div>' : '<div class="muted">Sem destaques críticos no momento.</div>';

            const modules = Array.isArray(data.failuresByModule) ? data.failuresByModule : [];
            document.getElementById('opsModulesBody').innerHTML = modules.length ? modules.map(function(item){
              return '<tr>' +
                '<td>' + esc(humanModule(item.module)) + '</td>' +
                '<td>' + esc(item.errorCount || 0) + '</td>' +
                '<td>' + esc(item.warnCount || 0) + '</td>' +
                '<td>' + esc(item.lastEvent || '—') + '<div class="muted">' + esc(fmt(item.lastTs)) + '</div></td>' +
                '<td>' + badge(item.lastLevel || 'info') + '</td>' +
              '</tr>';
            }).join('') : '<tr><td colspan="5" class="muted">Sem falhas por módulo na janela consultada.</td></tr>';

            const campaign = data.campaignSummary || {};
            document.getElementById('opsCampaignSummary').innerHTML = '<div class="grid cols2">' +
              '<div class="pill">Eventos recentes: <b>' + esc(campaign.recentEvents || 0) + '</b></div>' +
              '<div class="pill">Erros: <b>' + esc(campaign.errors || 0) + '</b></div>' +
              '<div class="pill">Avisos: <b>' + esc(campaign.warnings || 0) + '</b></div>' +
              '<div class="pill">Última falha: <b>' + esc(campaign.latestFailure ? fmt(campaign.latestFailure.ts) : '—') + '</b></div>' +
            '</div>';

            const recentErrors = Array.isArray(data.recentErrors) ? data.recentErrors : [];
            document.getElementById('opsErrorsBody').innerHTML = recentErrors.length ? recentErrors.map(function(item){
              return '<tr>' +
                '<td>' + esc(fmt(item.ts)) + '</td>' +
                '<td>' + esc(humanModule(item.module)) + '</td>' +
                '<td>' + esc(item.event || '—') + '</td>' +
                '<td>' + badge(item.level || 'info') + '</td>' +
                '<td>' + esc(item.status || '—') + '</td>' +
                '<td>' + esc(item.message || item.errorCode || '—') + '</td>' +
              '</tr>';
            }).join('') : '<tr><td colspan="6" class="muted">Sem erros ou avisos recentes na janela consultada.</td></tr>';

            const recentEvents = Array.isArray(data.recentEvents) ? data.recentEvents : [];
            document.getElementById('opsEventsBody').innerHTML = recentEvents.length ? recentEvents.map(function(item){
              return '<tr>' +
                '<td>' + esc(fmt(item.ts)) + '</td>' +
                '<td>' + esc(humanModule(item.module)) + '</td>' +
                '<td>' + esc(item.event || '—') + '</td>' +
                '<td>' + badge(item.level || 'info') + '</td>' +
                '<td>' + esc(item.status || '—') + '</td>' +
                '<td>' + esc(item.userId || item.waId || '—') + '</td>' +
              '</tr>';
            }).join('') : '<tr><td colspan="6" class="muted">Sem eventos recentes na janela consultada.</td></tr>';

            const fin = data.financial || {};
            const finRows = Array.isArray(fin.latest) ? fin.latest : [];
            document.getElementById('opsFinancialBody').innerHTML = finRows.length ? finRows.map(function(item){
              const ref = item.paymentId || item.subscriptionId || item.userId || item.waId || '—';
              return '<tr>' +
                '<td>' + esc(fmt(item.ts)) + '</td>' +
                '<td>' + esc(item.eventType || item.event || '—') + '</td>' +
                '<td>' + esc(item.category || '—') + '</td>' +
                '<td>' + esc(item.status || '—') + '</td>' +
                '<td>' + badge(item.severity || (item.isFailure ? 'error' : (item.isInconsistency ? 'warn' : 'info'))) + '</td>' +
                '<td>' + esc(ref) + '</td>' +
                '<td>' + esc(item.summary || item.message || '—') + '</td>' +
              '</tr>';
            }).join('') : '<tr><td colspan="7" class="muted">Sem eventos financeiros operacionais na janela consultada.</td></tr>';
          }

          document.getElementById('reloadOpsBtn').addEventListener('click', loadOps);
          document.getElementById('applyOpsFilters').addEventListener('click', loadOps);
          loadOps().catch(function(err){
            document.getElementById('opsExecutiveSummary').textContent = String(err?.message || err || 'Falha ao carregar observabilidade operacional.');
          });
        })();
      </script>
    `;

    const html = layoutBase({ title: "Observabilidade Operacional", activePath: "/admin/ops-ui", content: inner, scriptExtra });
    return res.status(200).send(html);
  });

  router.get("/dashboard/data", async (req, res) => {
    const waId = String(req.query?.waId || "").trim();

    const global = await getGlobalDescriptionMetrics();
    const window24hCount = await countWindow24hActive();

    // ✅ V16.5.0 — Catálogo de planos do sistema (para exibir nomes/valores no dashboard)
    let systemPlans = [];
    let systemPlansError = "";
    try {
      systemPlans = await listPlans();
    } catch (e) {
      systemPlansError = String(e?.message || e);
      systemPlans = [];
    }

    let users = [];
    let usersError = "";
    try {
      users = await listUsers();
    } catch (e) {
      usersError = String(e?.message || e);
      users = [];
    }

    const totalUsers = users.length;

    // Status breakdown (best-effort)
    const statuses = {
      TRIAL: 0,
      ACTIVE: 0,
      WAIT_PLAN: 0,
      PAYMENT_PENDING: 0,
      BLOCKED: 0,
      UNKNOWN: 0,
    };

    // Plano breakdown (best-effort)
    const plans = {}; // { CODE: count }

    const snapshots = await mapLimitDashboard(users, 25, async (id) => {
      const snap = await getUserSnapshot(id);
      return snap || {};
    });

    for (const s of snapshots) {
      const st = String(s?.status || "").toUpperCase() || "UNKNOWN";
      if (statuses[st] === undefined) statuses.UNKNOWN++;
      else statuses[st]++;

      const p = String(s?.plan || "").toUpperCase().trim();
      if (p) plans[p] = (plans[p] || 0) + 1;
    }

    // User section (optional)
    let user = null;
    if (waId) {
      const snap = await getUserSnapshot(waId);
      const metrics = await getUserDescriptionMetrics(waId);
      user = { snapshot: snap || {}, metrics };
    }

    const funnel = await buildDashboardFunnelData().catch((err) => ({
      ok: false,
      error: String(err?.message || err),
      overview: { ok: false, events: {} },
      timelines: {},
      rates: { day: {}, month: {} },
    }));

    const operational = await buildOperationalReadModel().catch((err) => ({
      ok: false,
      error: String(err?.message || err),
      totalStored: 0,
      recentCount: 0,
      errorsCount: 0,
      warningsCount: 0,
      modules: [],
      recentEvents: [],
      recentErrors: [],
      financial: { totalEvents: 0, recentFailures: 0, recentInconsistencies: 0, categories: [], statuses: [], latest: [] },
      health: { level: "warning", notes: [String(err?.message || err)], summary: String(err?.message || err) },
    }));

    res.json({
      ok: true,
      ts: Date.now(),
      global,
      funnel,
      window24hCount,
      systemPlans,
      systemPlansError: systemPlansError || undefined,
      users: {
        total: totalUsers,
        statuses,
        plans,
        error: usersError || undefined,
      },
      operational,
      user,
    });
  });

  

  const DASHBOARD_FUNNEL_PRIMARY_EVENTS = [
    "trial_started",
    "first_ad_generated",
    "plans_viewed",
    "checkout_started",
    "payment_confirmed",
    "plan_activated",
  ];

  const DASHBOARD_FUNNEL_CAMPAIGN_EVENTS = [
    "campaign_received",
    "campaign_clicked_intent",
    "campaign_conversion_attributed",
  ];

  const DASHBOARD_FUNNEL_EVENTS = [
    ...DASHBOARD_FUNNEL_PRIMARY_EVENTS,
    ...DASHBOARD_FUNNEL_CAMPAIGN_EVENTS,
  ];

  function pctSafe(current, base) {
    const a = Number(current || 0);
    const b = Number(base || 0);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
    return Number(((a / b) * 100).toFixed(1));
  }

  function buildDashboardFunnelRates(events = {}) {
    const trialDay = Number(events?.trial_started?.dayCount || 0);
    const firstAdDay = Number(events?.first_ad_generated?.dayCount || 0);
    const plansDay = Number(events?.plans_viewed?.dayCount || 0);
    const checkoutDay = Number(events?.checkout_started?.dayCount || 0);
    const paidDay = Number(events?.payment_confirmed?.dayCount || 0);
    const activeDay = Number(events?.plan_activated?.dayCount || 0);
    const campaignReceivedDay = Number(events?.campaign_received?.dayCount || 0);
    const campaignClickedDay = Number(events?.campaign_clicked_intent?.dayCount || 0);
    const campaignConvertedDay = Number(events?.campaign_conversion_attributed?.dayCount || 0);

    const trialMonth = Number(events?.trial_started?.monthCount || 0);
    const firstAdMonth = Number(events?.first_ad_generated?.monthCount || 0);
    const plansMonth = Number(events?.plans_viewed?.monthCount || 0);
    const checkoutMonth = Number(events?.checkout_started?.monthCount || 0);
    const paidMonth = Number(events?.payment_confirmed?.monthCount || 0);
    const activeMonth = Number(events?.plan_activated?.monthCount || 0);
    const campaignReceivedMonth = Number(events?.campaign_received?.monthCount || 0);
    const campaignClickedMonth = Number(events?.campaign_clicked_intent?.monthCount || 0);
    const campaignConvertedMonth = Number(events?.campaign_conversion_attributed?.monthCount || 0);

    return {
      day: {
        trialToFirstAd: pctSafe(firstAdDay, trialDay),
        firstAdToPlans: pctSafe(plansDay, firstAdDay),
        plansToCheckout: pctSafe(checkoutDay, plansDay),
        checkoutToPayment: pctSafe(paidDay, checkoutDay),
        paymentToActivation: pctSafe(activeDay, paidDay),
        campaignReceiveToIntent: pctSafe(campaignClickedDay, campaignReceivedDay),
        campaignIntentToAttributed: pctSafe(campaignConvertedDay, campaignClickedDay),
      },
      month: {
        trialToFirstAd: pctSafe(firstAdMonth, trialMonth),
        firstAdToPlans: pctSafe(plansMonth, firstAdMonth),
        plansToCheckout: pctSafe(checkoutMonth, plansMonth),
        checkoutToPayment: pctSafe(paidMonth, checkoutMonth),
        paymentToActivation: pctSafe(activeMonth, paidMonth),
        campaignReceiveToIntent: pctSafe(campaignClickedMonth, campaignReceivedMonth),
        campaignIntentToAttributed: pctSafe(campaignConvertedMonth, campaignClickedMonth),
      },
    };
  }

  function buildDashboardFunnelIntegrity(events = {}) {
    const primaryEventKeys = [
      "trial_started",
      "first_ad_generated",
      "plans_viewed",
      "checkout_started",
      "payment_confirmed",
      "plan_activated",
    ];
    const campaignEventKeys = [
      "campaign_received",
      "campaign_clicked_intent",
      "campaign_conversion_attributed",
    ];

    const missingPrimary = primaryEventKeys.filter((key) => !events?.[key]);
    const availableCampaign = campaignEventKeys.filter((key) => Boolean(events?.[key]));
    const missingCampaign = campaignEventKeys.filter((key) => !events?.[key]);

    let level = "ok";
    if (missingPrimary.length) level = "warning";
    if (missingPrimary.length >= 2) level = "critical";

    const notes = [
      "Leitura operacional baseada em eventos instrumentados no backend.",
      missingPrimary.length
        ? `Etapas principais ausentes no overview: ${missingPrimary.join(", ")}.`
        : "Todas as etapas principais do funil estão disponíveis no overview.",
      availableCampaign.length
        ? `Apoio de campanhas disponível para: ${availableCampaign.join(", ")}.`
        : "Métricas de campanhas ainda não aparecem neste overview.",
      missingCampaign.length
        ? "Atribuição de campanhas depende da instrumentação disponível nos pontos reais de clique/intenção e conversão atribuída."
        : "As métricas de campanhas disponíveis devem ser lidas como apoio operacional, não como atribuição oficial de negócio.",
    ];

    return {
      level,
      missingPrimary,
      availableCampaign,
      missingCampaign,
      notes,
    };
  }

  async function buildDashboardFunnelData() {
    const overview = await getConversionMetricsOverview();
    const timelines = {};
    for (const eventName of DASHBOARD_FUNNEL_EVENTS) {
      try {
        timelines[eventName] = await getMetricEventLastNDays(eventName, 30);
      } catch (err) {
        timelines[eventName] = { ok: false, error: String(err?.message || err) };
      }
    }

    return {
      ok: true,
      overview,
      timelines,
      rates: buildDashboardFunnelRates(overview?.events || {}),
      integrity: buildDashboardFunnelIntegrity(overview?.events || {}),
      labels: {
        primary: "Etapas principais do funil",
        campaigns: "Apoio / campanhas",
        interpretation: "Taxas simples operacionais (não são taxa oficial de negócio)",
      },
    };
  }

  // ✅ Histórico do Dashboard (global + opcional por usuário)
  // GET /admin/dashboard/history?days=30&months=12&start=YYYY-MM-DD&end=YYYY-MM-DD&waId=...
  router.get("/dashboard/history", async (req, res) => {
    try {
      const waId = String(req.query?.waId || "").trim();
      const days = Number(req.query?.days || 30);
      const months = Number(req.query?.months || 12);
      const start = String(req.query?.start || "").trim();
      const end = String(req.query?.end || "").trim();

      // Global daily
      let globalDays;
      if (start && end) globalDays = await getGlobalDaysRange({ start, end });
      else globalDays = await getGlobalLastNDays(days);

      // Global monthly (sempre últimos N meses)
      const globalMonths = await getGlobalLastNMonths(months);

      // User series (optional)
      let user = null;
      if (waId) {
        let userDays;
        if (start && end) userDays = await getUserDaysRange({ waId, start, end });
        else userDays = await getUserLastNDays(waId, days);
        const userMonths = await getUserLastNMonths(waId, months);
        user = { waId, days: userDays, months: userMonths };
      }

      return res.json({
        ok: true,
        params: { waId: waId || undefined, days, months, start: start || undefined, end: end || undefined },
        global: { days: globalDays, months: globalMonths },
        user,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });
router.get("/dashboard", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">📊 Dashboard</h3>
            <div class="muted">Métricas globais, histórico (30d/12m) e opcional por usuário.</div>
          </div>
          <div class="muted">Dica: use <code>waId</code> para ver o individual.</div>
        </div>

        <div class="hr"></div>

        <div class="row">
          <input id="waId" placeholder="waId (opcional) ex: 5511..." style="min-width:320px" />
          <button class="primary" onclick="loadAll()">Atualizar</button>
        </div>

        <div class="row" style="margin-top:10px;">
          <input id="days" type="number" min="1" max="365" value="30" style="width:120px;" />
          <span class="muted">dias</span>
          <input id="months" type="number" min="1" max="36" value="12" style="width:120px;" />
          <span class="muted">meses</span>
          <span class="muted" style="margin-left:8px;">ou intervalo:</span>
          <input id="start" type="date" />
          <input id="end" type="date" />
          <button onclick="applyRange()">Aplicar</button>
          <button onclick="resetRange()">Reset</button>
        </div>

        <div class="hr"></div>

        <div class="grid cols3">
          <div class="kpi">
            <div class="t">Descrições hoje (global)</div>
            <div class="v" id="kpiDay">—</div>
            <div class="muted" id="kpiDayLabel"></div>
          </div>
          <div class="kpi">
            <div class="t">Descrições no mês (global)</div>
            <div class="v" id="kpiMonth">—</div>
            <div class="muted" id="kpiMonthLabel"></div>
          </div>
          <div class="kpi">
            <div class="t">Usuários na janela 24h</div>
            <div class="v" id="kpi24h">—</div>
            <div class="muted">últimas 24 horas (inbound)</div>
          </div>
        </div>

        <div class="hr"></div>

        <h4 style="margin:0 0 6px 0;">Usuários</h4>
        <div class="row">
          <span class="pill">👥 Total de Usuários: <b id="uTotal">—</b></span>
          <span class="pill">🧪 Em Teste: <b id="uTrial">—</b></span>
          <span class="pill">🟢 Assinantes Ativos: <b id="uActive">—</b></span>
          <span class="pill">⏳ Aguardando Plano: <b id="uWait">—</b></span>
          <span class="pill">💳 Pagamento Pendente: <b id="uPayPend">—</b></span>
          <span class="pill">🔒 Bloqueados: <b id="uBlocked">—</b></span>
          <span class="pill">⚠️ Inconsistentes: <b id="uUnknown">—</b></span>
        </div>
        <div id="usersError" class="muted" style="margin-top:8px;"></div>

        <div class="hr"></div>

        <h4 style="margin:0 0 8px 0;">Planos (contagem)</h4>
        <div id="plans"></div>

        <div class="hr"></div>

        <div class="grid cols2">
          <div class="card pad">
            <div class="row" style="justify-content:space-between;">
              <h4 style="margin:0;">Série diária (Global)</h4>
              <div class="muted" id="daysLabel"></div>
            </div>
            <canvas id="chartDays" width="900" height="240" style="width:100%; border:1px solid var(--border); border-radius:12px;"></canvas>
            <div id="daysTable"></div>
          </div>

          <div class="card pad">
            <div class="row" style="justify-content:space-between;">
              <h4 style="margin:0;">Série mensal (Global)</h4>
              <div class="muted" id="monthsLabel"></div>
            </div>
            <canvas id="chartMonths" width="900" height="240" style="width:100%; border:1px solid var(--border); border-radius:12px;"></canvas>
            <div id="monthsTable"></div>
          </div>
        </div>

        <div class="hr"></div>

        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:8px;">
          <div>
            <h4 style="margin:0 0 6px 0;">Funil de conversão</h4>
            <div class="muted" id="funnelNarrative">Leitura operacional do funil principal e dos sinais auxiliares de campanhas.</div>
          </div>
          <div class="pill" id="funnelIntegrityPill">Integridade do funil: —</div>
        </div>

        <div class="card pad" style="margin-bottom:12px;">
          <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
            <div>
              <h4 style="margin:0 0 6px 0;">Etapas principais do funil</h4>
              <div class="muted">Eventos operacionais centrais da jornada: trial, criação do 1º anúncio, visão de planos, checkout, pagamento e ativação.</div>
            </div>
            <div class="muted">Hoje / mês</div>
          </div>
          <div class="grid cols3" style="margin-top:12px;">
            <div class="kpi"><div class="t">Trial iniciado</div><div class="v" id="fTrial">—</div><div class="muted" id="fTrialMonth">—</div></div>
            <div class="kpi"><div class="t">1º anúncio gerado</div><div class="v" id="fFirstAd">—</div><div class="muted" id="fFirstAdMonth">—</div></div>
            <div class="kpi"><div class="t">Planos visualizados</div><div class="v" id="fPlans">—</div><div class="muted" id="fPlansMonth">—</div></div>
            <div class="kpi"><div class="t">Checkout iniciado</div><div class="v" id="fCheckout">—</div><div class="muted" id="fCheckoutMonth">—</div></div>
            <div class="kpi"><div class="t">Pagamento confirmado</div><div class="v" id="fPayment">—</div><div class="muted" id="fPaymentMonth">—</div></div>
            <div class="kpi"><div class="t">Plano ativado</div><div class="v" id="fActivated">—</div><div class="muted" id="fActivatedMonth">—</div></div>
          </div>
        </div>

        <div class="card pad" style="margin-bottom:12px;">
          <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
            <div>
              <h4 style="margin:0 0 6px 0;">Apoio / campanhas</h4>
              <div class="muted">Métricas auxiliares de recebimento, intenção e conversão atribuída. Devem ser lidas como apoio operacional, não como atribuição oficial de negócio.</div>
            </div>
            <div class="muted">Disponível conforme instrumentação do backend</div>
          </div>
          <div class="grid cols3" style="margin-top:12px;">
            <div class="kpi"><div class="t">Campanhas recebidas</div><div class="v" id="fCampaignReceived">—</div><div class="muted" id="fCampaignReceivedMonth">—</div></div>
            <div class="kpi"><div class="t">Intenção após campanha</div><div class="v" id="fCampaignIntent">—</div><div class="muted" id="fCampaignIntentMonth">—</div></div>
            <div class="kpi"><div class="t">Conversão atribuída</div><div class="v" id="fCampaignConverted">—</div><div class="muted" id="fCampaignConvertedMonth">—</div></div>
          </div>
          <div class="row" style="margin-top:10px; gap:8px; flex-wrap:wrap;">
            <span class="pill">Hoje · Recebimento → intenção: <b id="rateDayCampaignReceiveIntent">—</b></span>
            <span class="pill">Hoje · Intenção → conversão atribuída: <b id="rateDayCampaignIntentConversion">—</b></span>
            <span class="pill">Mês · Recebimento → intenção: <b id="rateMonthCampaignReceiveIntent">—</b></span>
            <span class="pill">Mês · Intenção → conversão atribuída: <b id="rateMonthCampaignIntentConversion">—</b></span>
          </div>
        </div>

        <div class="card pad" style="margin-top:12px;">
          <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
            <div>
              <h4 style="margin:0 0 6px 0;">Taxas simples do funil</h4>
              <div class="muted" id="funnelInterpretation">Leitura operacional baseada nos eventos reais já instrumentados no backend.</div>
            </div>
            <div class="muted" id="funnelMeta">Últimos 30 dias por evento</div>
          </div>
          <div class="row" style="margin-top:10px; gap:8px; flex-wrap:wrap;">
            <span class="pill">Hoje · Trial → 1º anúncio: <b id="rateDayTrialFirst">—</b></span>
            <span class="pill">Hoje · 1º anúncio → planos: <b id="rateDayFirstPlans">—</b></span>
            <span class="pill">Hoje · Planos → checkout: <b id="rateDayPlansCheckout">—</b></span>
            <span class="pill">Hoje · Checkout → pagamento: <b id="rateDayCheckoutPayment">—</b></span>
            <span class="pill">Hoje · Pagamento → ativação: <b id="rateDayPaymentActivation">—</b></span>
          </div>
          <div class="row" style="margin-top:8px; gap:8px; flex-wrap:wrap;">
            <span class="pill">Mês · Trial → 1º anúncio: <b id="rateMonthTrialFirst">—</b></span>
            <span class="pill">Mês · 1º anúncio → planos: <b id="rateMonthFirstPlans">—</b></span>
            <span class="pill">Mês · Planos → checkout: <b id="rateMonthPlansCheckout">—</b></span>
            <span class="pill">Mês · Checkout → pagamento: <b id="rateMonthCheckoutPayment">—</b></span>
            <span class="pill">Mês · Pagamento → ativação: <b id="rateMonthPaymentActivation">—</b></span>
          </div>
          <div class="muted" id="funnelNotes" style="margin-top:10px;"></div>
        </div>

        <div class="grid cols2" style="margin-top:12px;">
          <div class="card pad">
            <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Funil principal · últimos 30 dias</h4><div class="muted" id="funnelDaysLabel"></div></div>
            <canvas id="chartFunnelDays" width="900" height="240" style="width:100%; border:1px solid var(--border); border-radius:12px;"></canvas>
            <div id="funnelDaysTable"></div>
          </div>
          <div class="card pad">
            <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Resumo operacional</h4><div class="muted">Etapas principais e apoio</div></div>
            <div id="funnelSummaryTable"></div>
          </div>
        </div>

        <div class="hr"></div>

        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:8px;">
          <div>
            <h4 style="margin:0 0 6px 0;">Observabilidade operacional</h4>
            <div class="muted">Separação entre auditoria administrativa, métricas do funil e eventos reais de runtime do sistema.</div>
          </div>
          <div class="row" style="gap:8px; flex-wrap:wrap; justify-content:flex-end;">
            <span class="pill">Eventos salvos: <b id="opsStored">—</b></span>
            <span class="pill">Falhas recentes: <b id="opsErrors">—</b></span>
            <span class="pill">Atenções recentes: <b id="opsWarns">—</b></span>
            <span class="pill" id="opsHealthPill">Saúde operacional: —</span>
          </div>
        </div>

        <div class="grid cols3" style="margin-top:12px;">
          <div class="kpi"><div class="t">Eventos operacionais recentes</div><div class="v" id="opsRecentCount">—</div><div class="muted">Janela consultada do runtime</div></div>
          <div class="kpi"><div class="t">Falhas financeiras recentes</div><div class="v" id="opsFinancialFailures">—</div><div class="muted">Confirmações, falhas, expirações e inconsistências</div></div>
          <div class="kpi"><div class="t">Inconsistências financeiras</div><div class="v" id="opsFinancialInconsistencies">—</div><div class="muted">Ledger operacional do Asaas</div></div>
        </div>

        <div class="grid cols2" style="margin-top:12px;">
          <div class="card pad">
            <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Falhas por módulo</h4><div class="muted">Runtime recente</div></div>
            <div class="hr"></div>
            <div style="overflow:auto;"><table><thead><tr><th>Módulo</th><th>Total</th><th>Erros</th><th>Atenções</th><th>Último evento</th></tr></thead><tbody id="opsModulesRows"><tr><td colspan="5" class="muted">Carregando...</td></tr></tbody></table></div>
          </div>
          <div class="card pad">
            <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Erros recentes</h4><div class="muted">Eventos operacionais</div></div>
            <div class="hr"></div>
            <div style="overflow:auto;"><table><thead><tr><th>Quando</th><th>Módulo</th><th>Nível</th><th>Etapa</th><th>Resumo</th></tr></thead><tbody id="opsErrorsRows"><tr><td colspan="5" class="muted">Carregando...</td></tr></tbody></table></div>
          </div>
        </div>

        <div class="grid cols2" style="margin-top:12px;">
          <div class="card pad">
            <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Eventos operacionais recentes</h4><div class="muted">Visão geral do runtime</div></div>
            <div class="hr"></div>
            <div style="overflow:auto;"><table><thead><tr><th>Quando</th><th>Módulo</th><th>Evento</th><th>Nível</th><th>Resumo</th></tr></thead><tbody id="opsEventsRows"><tr><td colspan="5" class="muted">Carregando...</td></tr></tbody></table></div>
          </div>
          <div class="card pad">
            <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Leitura financeira operacional</h4><div class="muted">Asaas + ledger</div></div>
            <div class="hr"></div>
            <div class="row" style="gap:8px; flex-wrap:wrap; margin-bottom:10px;">
              <span class="pill">Eventos Asaas: <b id="opsFinanceTotal">—</b></span>
              <span class="pill">Falhas: <b id="opsFinanceFailures">—</b></span>
              <span class="pill">Inconsistências: <b id="opsFinanceInconsistencies">—</b></span>
            </div>
            <div style="overflow:auto;"><table><thead><tr><th>Quando</th><th>Categoria</th><th>Status</th><th>Ref</th><th>Resumo</th></tr></thead><tbody id="opsFinanceRows"><tr><td colspan="5" class="muted">Carregando...</td></tr></tbody></table></div>
          </div>
        </div>

        <div class="hr"></div>

        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="raw" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <script>
        function esc(s){
          return String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'","&#39;");
        }
        function qs(){
          const waId = (document.getElementById('waId').value || '').trim();
          const days = (document.getElementById('days').value || '30').trim();
          const months = (document.getElementById('months').value || '12').trim();
          const start = (document.getElementById('start').value || '').trim();
          const end = (document.getElementById('end').value || '').trim();
          const p = new URLSearchParams();
          if(waId) p.set('waId', waId);
          if(start && end){ p.set('start', start); p.set('end', end); }
          else { p.set('days', days); }
          p.set('months', months);
          return p.toString();
        }
        function resetRange(){
          document.getElementById('days').value = 30;
          document.getElementById('months').value = 12;
          document.getElementById('start').value = '';
          document.getElementById('end').value = '';
          loadAll();
        }
        function applyRange(){ loadAll(); }

        function drawLine(canvasId, points, labelKey){
          const c = document.getElementById(canvasId);
          if(!c) return;
          const ctx = c.getContext('2d');
          const w = c.width, h = c.height;
          ctx.clearRect(0,0,w,h);

          if(!points || !points.length){
            ctx.fillText('Sem dados', 10, 20);
            return;
          }

          const vals = points.map(p => Number(p.count||0));
          const max = Math.max(1, ...vals);
          const min = Math.min(0, ...vals);

          const padL = 36, padR = 10, padT = 10, padB = 24;
          const iw = w - padL - padR;
          const ih = h - padT - padB;

          ctx.beginPath();
          ctx.moveTo(padL, padT);
          ctx.lineTo(padL, padT + ih);
          ctx.lineTo(padL + iw, padT + ih);
          ctx.strokeStyle = "#94a3b8";
          ctx.stroke();

          ctx.beginPath();
          points.forEach((p, i) => {
            const x = padL + (iw * (i / Math.max(1, points.length - 1)));
            const v = Number(p.count||0);
            const y = padT + ih - (ih * ((v - min) / (max - min || 1)));
            if(i===0) ctx.moveTo(x,y);
            else ctx.lineTo(x,y);
          });
          ctx.strokeStyle = "#2563eb";
          ctx.lineWidth = 2;
          ctx.stroke();

          ctx.fillStyle = "#64748b";
          ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
          ctx.fillText(String(points[0][labelKey] || ''), padL, h - 8);
          const last = points[points.length-1];
          const lastLabel = String(last[labelKey] || '');
          const tw = ctx.measureText(lastLabel).width;
          ctx.fillText(lastLabel, w - padR - tw, h - 8);
          ctx.fillText(String(max), 6, 16);
        }

        function renderMiniTable(containerId, points, labelKey){
          const el = document.getElementById(containerId);
          if(!el) return;
          if(!points || !points.length){ el.innerHTML = '<span class="muted">Sem dados.</span>'; return; }
          const last = points.slice(-10);
          const rows = last.map(p => '<tr><td><code>'+esc(p[labelKey])+'</code></td><td><b>'+esc(p.count)+'</b></td></tr>').join('');
          el.innerHTML = '<table><thead><tr><th>Período</th><th>Qtd</th></tr></thead><tbody>'+rows+'</tbody></table><div class="muted">Mostrando últimos 10 pontos.</div>';
        }

        function fmtRate(v){ return (v === null || v === undefined || Number.isNaN(Number(v))) ? '—' : (String(v).replace('.', ',') + '%'); }
        function fmtCountLabel(dayCount, monthCount){ return 'Hoje: ' + (dayCount ?? 0) + ' · Mês: ' + (monthCount ?? 0); }
        function integrityBadge(level){
          if(level === 'critical') return '<span class="badge danger">Integridade crítica</span>';
          if(level === 'warning') return '<span class="badge warn">Integridade parcial</span>';
          return '<span class="badge ok">Integridade operacional OK</span>';
        }
        function operationalBadge(level){
          const normalized = String(level || 'info').toLowerCase();
          const cls = normalized === 'error' || normalized === 'fatal' ? 'danger' : (normalized === 'warn' || normalized === 'warning' ? 'warn' : (normalized === 'ok' ? 'ok' : 'info'));
          const label = cls === 'danger' ? 'Erro' : (cls === 'warn' ? 'Atenção' : (cls === 'ok' ? 'OK' : 'Info'));
          return '<span class="badge ' + cls + '">' + label + '</span>';
        }
        function renderOperationalRows(containerId, rowsHtml, colspan, emptyText){
          renderTableRows(containerId, rowsHtml, colspan, emptyText);
        }

        function renderFunnelSummary(events){
          const el = document.getElementById('funnelSummaryTable');
          if(!el) return;
          const primaryRows = [
            ['trial_started','Trial iniciado'],
            ['first_ad_generated','1º anúncio gerado'],
            ['plans_viewed','Planos visualizados'],
            ['checkout_started','Checkout iniciado'],
            ['payment_confirmed','Pagamento confirmado'],
            ['plan_activated','Plano ativado'],
          ].map(([key,label]) => {
            const item = events?.[key] || {};
            return '<tr><td>'+esc(label)+'</td><td><b>'+esc(item.dayCount ?? 0)+'</b></td><td><b>'+esc(item.monthCount ?? 0)+'</b></td></tr>';
          }).join('');
          const campaignRows = [
            ['campaign_received','Campanhas recebidas'],
            ['campaign_clicked_intent','Intenção após campanha'],
            ['campaign_conversion_attributed','Conversão atribuída'],
          ].map(([key,label]) => {
            const item = events?.[key] || {};
            return '<tr><td>'+esc(label)+'</td><td><b>'+esc(item.dayCount ?? 0)+'</b></td><td><b>'+esc(item.monthCount ?? 0)+'</b></td></tr>';
          }).join('');
          el.innerHTML = ''+
            '<div class="muted" style="margin-bottom:8px;">Etapas principais</div>'+
            '<table><thead><tr><th>Etapa</th><th>Hoje</th><th>Mês</th></tr></thead><tbody>'+primaryRows+'</tbody></table>'+
            '<div class="hr"></div>'+
            '<div class="muted" style="margin-bottom:8px;">Apoio / campanhas</div>'+
            '<table><thead><tr><th>Métrica</th><th>Hoje</th><th>Mês</th></tr></thead><tbody>'+campaignRows+'</tbody></table>';
        }

        function renderFunnelTimeline(timelines){
          const seriesNames = ['trial_started','first_ad_generated','plans_viewed','checkout_started','payment_confirmed','plan_activated'];
          const palette = ['#2563eb','#16a34a','#7c3aed','#f59e0b','#dc2626','#0f766e'];
          const labels = ((timelines?.trial_started?.points)||[]).map(p => String(p.day||''));
          const canvas = document.getElementById('chartFunnelDays');
          if(!canvas) return;
          const ctx = canvas.getContext('2d');
          const w = canvas.width, h = canvas.height;
          ctx.clearRect(0,0,w,h);
          if(!labels.length){
            ctx.fillText('Sem dados', 10, 20);
            document.getElementById('funnelDaysTable').innerHTML = '<span class="muted">Sem dados.</span>';
            return;
          }
          const padL=36,padR=10,padT=10,padB=24;
          const iw=w-padL-padR, ih=h-padT-padB;
          const allValues=[];
          seriesNames.forEach(name => ((timelines?.[name]?.points)||[]).forEach(p => allValues.push(Number(p.count||0))));
          const max=Math.max(1,...allValues);
          ctx.beginPath();
          ctx.moveTo(padL,padT); ctx.lineTo(padL,padT+ih); ctx.lineTo(padL+iw,padT+ih);
          ctx.strokeStyle='#94a3b8'; ctx.stroke();
          seriesNames.forEach((name, idx) => {
            const points=(timelines?.[name]?.points)||[];
            if(!points.length) return;
            ctx.beginPath();
            points.forEach((p,i)=>{
              const x=padL+(iw*(i/Math.max(1,points.length-1)));
              const y=padT+ih-(ih*((Number(p.count||0))/max));
              if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
            });
            ctx.strokeStyle=palette[idx%palette.length]; ctx.lineWidth=2; ctx.stroke();
          });
          ctx.fillStyle='#64748b'; ctx.font='12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
          ctx.fillText(String(labels[0]||''), padL, h-8);
          const lastLabel=String(labels[labels.length-1]||'');
          const tw=ctx.measureText(lastLabel).width;
          ctx.fillText(lastLabel, w-padR-tw, h-8);
          ctx.fillText(String(max), 6, 16);
          const rows = labels.slice(-10).map((day, indexFromEnd) => {
            const idx = labels.length - Math.min(10, labels.length) + indexFromEnd;
            const cols = seriesNames.map(name => '<td><b>'+esc((((timelines?.[name]?.points)||[])[idx]?.count ?? 0))+'</b></td>').join('');
            return '<tr><td><code>'+esc(day)+'</code></td>'+cols+'</tr>';
          }).join('');
          document.getElementById('funnelDaysTable').innerHTML = '<table><thead><tr><th>Dia</th><th>Trial</th><th>1º anúncio</th><th>Planos</th><th>Checkout</th><th>Pagamento</th><th>Ativação</th></tr></thead><tbody>'+rows+'</tbody></table><div class="muted">Mostrando últimos 10 pontos do funil principal.</div>';
        }

        async function loadHistory(){
          const query = qs();
          const r = await fetch('/admin/dashboard/history?' + query);
          const j = await r.json().catch(()=>({}));
          const gd = j?.global?.days;
          const gm = j?.global?.months;

          const gdPts = gd?.points || [];
          const gmPts = gm?.points || [];

          document.getElementById('daysLabel').textContent = gd?.ok ? (gd.start + ' → ' + gd.end) : ('⚠️ ' + (gd?.error||''));
          document.getElementById('monthsLabel').textContent = gm?.ok ? (gm.start + ' → ' + gm.end) : ('⚠️ ' + (gm?.error||''));

          drawLine('chartDays', gdPts, 'day');
          drawLine('chartMonths', gmPts, 'month');
          renderMiniTable('daysTable', gdPts, 'day');
          renderMiniTable('monthsTable', gmPts, 'month');

          return j;
        }

        async function loadAll(){
          const waId = (document.getElementById('waId').value || '').trim();
          const url = waId ? '/admin/dashboard/data?waId=' + encodeURIComponent(waId) : '/admin/dashboard/data';
          const r = await fetch(url);
          const j = await r.json().catch(()=>({}));
          document.getElementById('raw').textContent = JSON.stringify(j, null, 2);

          const g = j.global || {};
          document.getElementById('kpiDay').textContent = g.dayCount ?? '0';
          document.getElementById('kpiDayLabel').textContent = g.day ? ('Dia: ' + g.day) : '';
          document.getElementById('kpiMonth').textContent = g.monthCount ?? '0';
          document.getElementById('kpiMonthLabel').textContent = g.month ? ('Mês: ' + g.month) : '';
          document.getElementById('kpi24h').textContent = j.window24hCount ?? '0';

          const u = (j.users || {});
          document.getElementById('uTotal').textContent = u.total ?? '0';
          const st = u.statuses || {};
          document.getElementById('uTrial').textContent = st.TRIAL ?? '0';
          document.getElementById('uActive').textContent = st.ACTIVE ?? '0';
          document.getElementById('uWait').textContent = st.WAIT_PLAN ?? '0';
          document.getElementById('uPayPend').textContent = st.PAYMENT_PENDING ?? '0';
          document.getElementById('uBlocked').textContent = st.BLOCKED ?? '0';
          document.getElementById('uUnknown').textContent = st.UNKNOWN ?? '0';
          document.getElementById('usersError').textContent = u.error ? ('⚠️ users:index: ' + u.error) : '';

          const plans = u.plans || {};
          const sysPlans = Array.isArray(j.systemPlans) ? j.systemPlans : [];
          const byCode = {};
          for (const p of sysPlans) {
            const code = String(p?.code || '').toUpperCase().trim();
            if (code) byCode[code] = p;
          }
          function fmtBRL(cents){
            const v = (Number(cents)||0)/100;
            try { return v.toLocaleString('pt-BR', {style:'currency', currency:'BRL'}); } catch { return 'R$ ' + v.toFixed(2); }
          }
          const planHtml = Object.keys(plans).sort().map(k => {
            const meta = byCode[String(k||'').toUpperCase().trim()];
            const label = meta ? (esc(meta.name || '') + ' · ' + fmtBRL(meta.priceCents) + ' · ' + esc(meta.description || (meta.monthlyQuota ? (meta.monthlyQuota + ' descrições/mês') : ''))) : '';
            const extra = label ? ('<div class="muted" style="font-size:12px;margin-top:2px;">' + label + '</div>') : '';
            return '<span class="pill"><code>'+esc(k)+'</code>: <b>'+plans[k]+'</b>' + extra + '</span>';
          }).join(' ');
          document.getElementById('plans').innerHTML = planHtml || '<span class="muted">Sem dados.</span>';

          const funnel = j.funnel || {};
          const fe = funnel?.overview?.events || {};
          const integrity = funnel?.integrity || {};
          const labelsMeta = funnel?.labels || {};
          document.getElementById('fTrial').textContent = fe?.trial_started?.dayCount ?? '0';
          document.getElementById('fTrialMonth').textContent = fmtCountLabel(fe?.trial_started?.dayCount ?? 0, fe?.trial_started?.monthCount ?? 0);
          document.getElementById('fFirstAd').textContent = fe?.first_ad_generated?.dayCount ?? '0';
          document.getElementById('fFirstAdMonth').textContent = fmtCountLabel(fe?.first_ad_generated?.dayCount ?? 0, fe?.first_ad_generated?.monthCount ?? 0);
          document.getElementById('fPlans').textContent = fe?.plans_viewed?.dayCount ?? '0';
          document.getElementById('fPlansMonth').textContent = fmtCountLabel(fe?.plans_viewed?.dayCount ?? 0, fe?.plans_viewed?.monthCount ?? 0);
          document.getElementById('fCheckout').textContent = fe?.checkout_started?.dayCount ?? '0';
          document.getElementById('fCheckoutMonth').textContent = fmtCountLabel(fe?.checkout_started?.dayCount ?? 0, fe?.checkout_started?.monthCount ?? 0);
          document.getElementById('fPayment').textContent = fe?.payment_confirmed?.dayCount ?? '0';
          document.getElementById('fPaymentMonth').textContent = fmtCountLabel(fe?.payment_confirmed?.dayCount ?? 0, fe?.payment_confirmed?.monthCount ?? 0);
          document.getElementById('fActivated').textContent = fe?.plan_activated?.dayCount ?? '0';
          document.getElementById('fActivatedMonth').textContent = fmtCountLabel(fe?.plan_activated?.dayCount ?? 0, fe?.plan_activated?.monthCount ?? 0);
          document.getElementById('fCampaignReceived').textContent = fe?.campaign_received?.dayCount ?? '0';
          document.getElementById('fCampaignReceivedMonth').textContent = fmtCountLabel(fe?.campaign_received?.dayCount ?? 0, fe?.campaign_received?.monthCount ?? 0);
          document.getElementById('fCampaignIntent').textContent = fe?.campaign_clicked_intent?.dayCount ?? '0';
          document.getElementById('fCampaignIntentMonth').textContent = fmtCountLabel(fe?.campaign_clicked_intent?.dayCount ?? 0, fe?.campaign_clicked_intent?.monthCount ?? 0);
          document.getElementById('fCampaignConverted').textContent = fe?.campaign_conversion_attributed?.dayCount ?? '0';
          document.getElementById('fCampaignConvertedMonth').textContent = fmtCountLabel(fe?.campaign_conversion_attributed?.dayCount ?? 0, fe?.campaign_conversion_attributed?.monthCount ?? 0);
          const rates = funnel?.rates || {};
          document.getElementById('rateDayTrialFirst').textContent = fmtRate(rates?.day?.trialToFirstAd);
          document.getElementById('rateDayFirstPlans').textContent = fmtRate(rates?.day?.firstAdToPlans);
          document.getElementById('rateDayPlansCheckout').textContent = fmtRate(rates?.day?.plansToCheckout);
          document.getElementById('rateDayCheckoutPayment').textContent = fmtRate(rates?.day?.checkoutToPayment);
          document.getElementById('rateDayPaymentActivation').textContent = fmtRate(rates?.day?.paymentToActivation);
          document.getElementById('rateMonthTrialFirst').textContent = fmtRate(rates?.month?.trialToFirstAd);
          document.getElementById('rateMonthFirstPlans').textContent = fmtRate(rates?.month?.firstAdToPlans);
          document.getElementById('rateMonthPlansCheckout').textContent = fmtRate(rates?.month?.plansToCheckout);
          document.getElementById('rateMonthCheckoutPayment').textContent = fmtRate(rates?.month?.checkoutToPayment);
          document.getElementById('rateMonthPaymentActivation').textContent = fmtRate(rates?.month?.paymentToActivation);
          document.getElementById('rateDayCampaignReceiveIntent').textContent = fmtRate(rates?.day?.campaignReceiveToIntent);
          document.getElementById('rateDayCampaignIntentConversion').textContent = fmtRate(rates?.day?.campaignIntentToAttributed);
          document.getElementById('rateMonthCampaignReceiveIntent').textContent = fmtRate(rates?.month?.campaignReceiveToIntent);
          document.getElementById('rateMonthCampaignIntentConversion').textContent = fmtRate(rates?.month?.campaignIntentToAttributed);
          document.getElementById('funnelMeta').textContent = funnel?.ok === false ? ('⚠️ ' + (funnel?.error || 'Falha ao carregar funil')) : 'Últimos 30 dias por evento';
          document.getElementById('funnelInterpretation').textContent = labelsMeta?.interpretation || 'Leitura operacional baseada nos eventos reais já instrumentados no backend.';
          document.getElementById('funnelNarrative').textContent = ((labelsMeta?.primary || 'Etapas principais do funil') + ' + ' + (labelsMeta?.campaigns || 'Apoio / campanhas') + ' com leitura operacional e tecnicamente honesta.');
          document.getElementById('funnelIntegrityPill').innerHTML = integrityBadge(integrity?.level) + ' <span class="muted">' + esc((integrity?.missingPrimary||[]).length ? ((integrity?.missingPrimary||[]).length + ' etapa(s) principal(is) ausente(s)') : 'sem lacunas principais no overview') + '</span>';
          document.getElementById('funnelNotes').textContent = Array.isArray(integrity?.notes) ? integrity.notes.join(' ') : 'As taxas do funil são operacionais e devem ser interpretadas com contexto.';
          document.getElementById('funnelDaysLabel').textContent = (((funnel?.timelines||{}).trial_started||{}).start && ((funnel?.timelines||{}).trial_started||{}).end) ? ((((funnel?.timelines||{}).trial_started||{}).start) + ' → ' + (((funnel?.timelines||{}).trial_started||{}).end)) : '';
          renderFunnelSummary(fe);
          renderFunnelTimeline(funnel?.timelines || {});

          const operational = j.operational || {};
          const health = operational.health || {};
          document.getElementById('opsStored').textContent = operational.totalStored ?? 0;
          document.getElementById('opsErrors').textContent = operational.errorsCount ?? 0;
          document.getElementById('opsWarns').textContent = operational.warningsCount ?? 0;
          document.getElementById('opsRecentCount').textContent = operational.recentCount ?? 0;
          document.getElementById('opsFinancialFailures').textContent = operational?.financial?.recentFailures ?? 0;
          document.getElementById('opsFinancialInconsistencies').textContent = operational?.financial?.recentInconsistencies ?? 0;
          document.getElementById('opsFinanceTotal').textContent = operational?.financial?.totalEvents ?? 0;
          document.getElementById('opsFinanceFailures').textContent = operational?.financial?.recentFailures ?? 0;
          document.getElementById('opsFinanceInconsistencies').textContent = operational?.financial?.recentInconsistencies ?? 0;
          document.getElementById('opsHealthPill').innerHTML = 'Saúde operacional: ' + operationalBadge(health.level || 'info') + ' <span class="muted">' + esc(health.summary || 'Sem leitura consolidada.') + '</span>';

          const modulesRows = (Array.isArray(operational.modules) ? operational.modules : []).slice(0, 12).map(function(item){
            return '<tr>' +
              '<td><b>' + esc(item.module || '—') + '</b></td>' +
              '<td>' + esc(item.count || 0) + '</td>' +
              '<td><b>' + esc(item.errorCount || 0) + '</b></td>' +
              '<td>' + esc(item.warnCount || 0) + '</td>' +
              '<td>' + esc(item.lastEvent || '—') + '</td>' +
            '</tr>';
          }).join('');
          renderOperationalRows('opsModulesRows', modulesRows, 5, 'Sem atividade operacional relevante por módulo.');

          const recentErrorsRows = (Array.isArray(operational.recentErrors) ? operational.recentErrors : []).map(function(item){
            return '<tr>' +
              '<td><code>' + esc(item.ts || '') + '</code></td>' +
              '<td><b>' + esc(item.module || '—') + '</b></td>' +
              '<td>' + operationalBadge(item.level) + '</td>' +
              '<td>' + esc(item.step || '—') + '</td>' +
              '<td>' + esc(item.message || item.errorCode || item.event || '—') + '</td>' +
            '</tr>';
          }).join('');
          renderOperationalRows('opsErrorsRows', recentErrorsRows, 5, 'Sem erros operacionais recentes.');

          const recentEventsRows = (Array.isArray(operational.recentEvents) ? operational.recentEvents : []).map(function(item){
            return '<tr>' +
              '<td><code>' + esc(item.ts || '') + '</code></td>' +
              '<td><b>' + esc(item.module || '—') + '</b></td>' +
              '<td>' + esc(item.event || '—') + '</td>' +
              '<td>' + operationalBadge(item.level) + '</td>' +
              '<td>' + esc(item.message || item.step || item.errorCode || '—') + '</td>' +
            '</tr>';
          }).join('');
          renderOperationalRows('opsEventsRows', recentEventsRows, 5, 'Sem eventos operacionais recentes.');

          const financeRows = (Array.isArray(operational?.financial?.latest) ? operational.financial.latest : []).map(function(item){
            const ref = item.paymentId || item.subscriptionId || item.couponCode || item.userId || '—';
            return '<tr>' +
              '<td><code>' + esc(item.ts || '') + '</code></td>' +
              '<td><b>' + esc(item.category || item.eventType || item.event || '—') + '</b></td>' +
              '<td>' + esc(item.status || (item.isFailure ? 'failure' : 'ok') || '—') + '</td>' +
              '<td><code>' + esc(ref) + '</code></td>' +
              '<td>' + esc(item.summary || item.message || '—') + '</td>' +
            '</tr>';
          }).join('');
          renderOperationalRows('opsFinanceRows', financeRows, 5, 'Sem eventos financeiros operacionais recentes.');

          const hist = await loadHistory();
          return { j, hist };
        }

        loadAll();
      </script>
    `;
    const html = layoutBase({ title: "Dashboard", activePath: "/admin/dashboard", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });
  /* NOTE: bloco duplicado/corrompido removido (mantido comentado para preservar histórico de linhas).

  // labels (first/last)
  ctx.fillText(String(points[0][labelKey] || ''), padL, h - 8);
  const last = points[points.length-1];
  const lastLabel = String(last[labelKey] || '');
  const tw = ctx.measureText(lastLabel).width;
  ctx.fillText(lastLabel, w - padR - tw, h - 8);

  // max value
  ctx.fillText(String(max), 6, 16);
}

function renderMiniTable(containerId, points, labelKey){
  const el = document.getElementById(containerId);
  if(!el) return;
  if(!points || !points.length){ el.innerHTML = '<span class="muted">Sem dados.</span>'; return; }
  const last = points.slice(-10);
  const rows = last.map(p => '<tr><td><code>'+esc(p[labelKey])+'</code></td><td><b>'+esc(p.count)+'</b></td></tr>').join('');
  el.innerHTML = '<table><thead><tr><th>Período</th><th>Qtd</th></tr></thead><tbody>'+rows+'</tbody></table><div class="muted">Mostrando últimos 10 pontos.</div>';
}

async function loadHistory(){
  const query = qs();
  const url = '/admin/dashboard/history?' + query;
  const r = await fetch(url);
  const j = await r.json().catch(()=>({}));

  const gd = j?.global?.days;
  const gm = j?.global?.months;

  const gdPts = gd?.points || [];
  const gmPts = gm?.points || [];

  document.getElementById('daysLabel').textContent = gd?.ok ? ('Período: ' + gd.start + ' → ' + gd.end) : ('⚠️ ' + (gd?.error||''));
  document.getElementById('monthsLabel').textContent = gm?.ok ? ('Período: ' + gm.start + ' → ' + gm.end) : ('⚠️ ' + (gm?.error||''));

  drawLine('chartDays', gdPts, 'day');
  drawLine('chartMonths', gmPts, 'month');
  renderMiniTable('daysTable', gdPts, 'day');
  renderMiniTable('monthsTable', gmPts, 'month');

  const u = j?.user;
  const ud = u?.days;
  const um = u?.months;
  const udPts = ud?.points || [];
  const umPts = um?.points || [];
  document.getElementById('userDaysLabel').textContent = ud?.ok ? ('Período: ' + ud.start + ' → ' + ud.end) : '—';
  document.getElementById('userMonthsLabel').textContent = um?.ok ? ('Período: ' + um.start + ' → ' + um.end) : '—';

  drawLine('chartUserDays', udPts, 'day');
  drawLine('chartUserMonths', umPts, 'month');
  renderMiniTable('userDaysTable', udPts, 'day');
  renderMiniTable('userMonthsTable', umPts, 'month');
}


async function load(){ const waId = (document.getElementById('waId').value || '').trim();
  const url = waId ? '/admin/dashboard/data?waId=' + encodeURIComponent(waId) : '/admin/dashboard/data';
  const r = await fetch(url);
  const j = await r.json();
  document.getElementById('raw').textContent = JSON.stringify(j, null, 2);

  const g = j.global || {};
  document.getElementById('kpiDay').textContent = g.dayCount ?? '0';
  document.getElementById('kpiDayLabel').textContent = g.day ? ('Dia: ' + g.day) : '';
  document.getElementById('kpiMonth').textContent = g.monthCount ?? '0';
  document.getElementById('kpiMonthLabel').textContent = g.month ? ('Mês: ' + g.month) : '';
  document.getElementById('kpi24h').textContent = j.window24hCount ?? '0';

  const u = (j.users || {});
  document.getElementById('uTotal').textContent = u.total ?? '0';
  const st = u.statuses || {};
  document.getElementById('uTrial').textContent = st.TRIAL ?? '0';
  document.getElementById('uActive').textContent = st.ACTIVE ?? '0';
  document.getElementById('uWait').textContent = st.WAIT_PLAN ?? '0';
  document.getElementById('uPayPend').textContent = st.PAYMENT_PENDING ?? '0';
  document.getElementById('uBlocked').textContent = st.BLOCKED ?? '0';
  document.getElementById('uUnknown').textContent = st.UNKNOWN ?? '0';

  const err = u.error ? ('⚠️ users:index: ' + u.error) : '';
  document.getElementById('usersError').textContent = err;

  const plans = u.plans || {};
  const sysPlans = Array.isArray(j.systemPlans) ? j.systemPlans : [];
  const byCode = {};
  for (const p of sysPlans) {
    const code = String(p?.code || '').toUpperCase().trim();
    if (code) byCode[code] = p;
  }

  function fmtBRL(cents){
    const v = (Number(cents)||0)/100;
    try { return v.toLocaleString('pt-BR', {style:'currency', currency:'BRL'}); } catch { return 'R$ ' + v.toFixed(2); }
  }

  const planHtml = Object.keys(plans).sort().map(k => {
    const meta = byCode[String(k||'').toUpperCase().trim()];
    const label = meta ? (esc(meta.name || '') + ' · ' + fmtBRL(meta.priceCents) + ' · ' + esc(meta.description || (meta.monthlyQuota ? (meta.monthlyQuota + ' descrições/mês') : ''))) : '';
    const extra = label ? ('<div class="muted" style="font-size:12px;margin-top:2px;">' + label + '</div>') : '';
    return '<span class="pill"><code>'+esc(k)+'</code>: <b>'+plans[k]+'</b>' + extra + '</span>';
  }).join(' ');
  document.getElementById('plans').innerHTML = planHtml || '<span class="muted">Sem dados.</span>';

  const user = j.user;
  if (!user) {
    document.getElementById('userBox').innerHTML = '<span class="muted">Informe um waId acima para ver métricas individuais.</span>';
  } else {
    const sm = user.snapshot || {};
    const um = user.metrics || {};
    const box = \`
      <div class="kpi" style="margin-top:10px;">
        <h3>Usuário <code>\${esc(sm.waId || waId)}</code></h3>
        <div class="muted">status: <b>\${esc(sm.status || '—')}</b> · plano atual: <b>\${esc(sm.plan || '—')}</b></div>
        \${(() => {
          const sysPlans = Array.isArray(j.systemPlans) ? j.systemPlans : [];
          const code = String(sm.plan || '').toUpperCase().trim();
          const meta = sysPlans.find(p => String(p?.code || '').toUpperCase().trim() === code);
          if (!meta) return '';
          const price = (() => { const v=(Number(meta.priceCents)||0)/100; try { return v.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); } catch { return 'R$ '+v.toFixed(2);} })();
          const desc = meta.description || (meta.monthlyQuota ? (meta.monthlyQuota + ' descrições/mês') : '');
          return '<div class="muted" style="margin-top:6px;">Plano: <b>' + esc(meta.name || meta.code || '') + '</b> · ' + esc(price) + (desc ? (' · ' + esc(desc)) : '') + '</div>';
        })()}
        <div style="margin-top:10px;" class="row">
          <div class="pill">Descrições hoje: <b>\${um.dayCount ?? 0}</b></div>
          <div class="pill">Descrições mês: <b>\${um.monthCount ?? 0}</b></div>
          <div class="pill">quotaUsed: <b>\${esc(sm.quotaUsed ?? '—')}</b></div>
          <div class="pill">trialUsed: <b>\${esc(sm.trialUsed ?? '—')}</b></div>
        </div>
      </div>\`;
    document.getElementById('userBox').innerHTML = box;
  }
  await loadHistory();
}

load();
</script>
</body>
</html>`;
    res.type("html").send(html);
  */
router.get("/", async (req, res) => {
    const html = layoutBase({
      title: "Início",
      activePath: "/admin",
      content: `
        <div class="grid cols2">
          <div class="card pad">
            <h3 style="margin:0 0 6px 0;">Painel</h3>
            <div class="muted">Ações principais e atalhos organizados.</div>
            <div class="hr"></div>
            <div class="grid cols2">
              <a class="card pad" href="/admin/dashboard" style="display:block;">
                <div class="muted" style="font-weight:700;">📊 Dashboard</div>
                <div class="muted">Métricas globais, histórico e usuário.</div>
              </a>
              <a class="card pad" href="/admin/executive-ui" style="display:block;">
                <div class="muted" style="font-weight:700;">🧠 Dashboard Executivo</div>
                <div class="muted">Visão gerencial de base, receita e saúde.</div>
              </a>
              <a class="card pad" href="/admin/users-ui" style="display:block;">
                <div class="muted" style="font-weight:700;">👥 Usuários</div>
                <div class="muted">Consulta e ações por waId.</div>
              </a>
              <a class="card pad" href="/admin/bulk-ui" style="display:block;">
                <div class="muted" style="font-weight:700;">🧰 Ações em massa</div>
                <div class="muted">Operações em lote para usuários filtrados.</div>
              </a>
              <a class="card pad" href="/admin/plans" style="display:block;">
                <div class="muted" style="font-weight:700;">💳 Planos</div>
                <div class="muted">Gerenciar catálogo e ativação.</div>
              </a>
              <a class="card pad" href="/admin/broadcast-ui" style="display:block;">
                <div class="muted" style="font-weight:700;">📣 Broadcast</div>
                <div class="muted">Criar envios por plano e janela.</div>
              </a>
              <a class="card pad" href="/admin/finance-saas-ui" style="display:block;">
                <div class="muted" style="font-weight:700;">📈 Dashboard Financeiro SaaS</div>
                <div class="muted">MRR, ARR, conversão, cobertura Asaas e visão de receita.</div>
              </a>
              <a class="card pad" href="/admin/reports-ui" style="display:block;">
                <div class="muted" style="font-weight:700;">📑 Relatórios e Exportação</div>
                <div class="muted">Relatórios gerenciais, gráficos e downloads do sistema.</div>
              </a>
            </div>
          </div>

          <div class="card pad">
            <h3 style="margin:0 0 6px 0;">Sistema</h3>
            <div class="muted">Saúde e diagnóstico rápido.</div>
            <div class="hr"></div>
            <div class="row">
              <a class="pill" href="/health">✅ Health</a>
              <a class="pill" href="/health-redis">🧠 Health Redis</a>
              <a class="pill" href="/admin/health-plans">🧾 Health Planos (JSON)</a>
              <a class="pill" href="/admin/alerts-ui">🚨 Alertas</a>
              <a class="pill" href="/admin/audit-ui">📚 Auditoria</a>
              <a class="pill" href="/admin/ops-ui">🧠 Observabilidade Operacional</a>
              <a class="pill" href="/admin/executive-ui">🧠 Dashboard Executivo</a>
              <a class="pill" href="/admin/reports-ui">📑 Relatórios</a>
              <a class="pill" href="/admin/asaas-test-ui">🧪 Asaas Teste</a>
            </div>
            <div class="hr"></div>
            <div class="muted">Observação: ações avançadas estão nas seções do menu.</div>
          </div>
        </div>
      `,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });


  router.get("/ops/redis-health", async (req, res) => {
    try {
      const data = await buildRedisOpsReadModel();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/settings/operational-alerts", async (req, res) => {
    try {
      const data = await getOperationalAlertSettings();
      return res.json({ ok: true, ...data });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/settings/operational-alerts", async (req, res) => {
    try {
      const recipients = await setOperationalAlertRecipients(req.body?.recipients);
      await setOperationalAlertMeta({
        channels: req.body?.channels,
        cooldowns: req.body?.cooldowns,
      });
      const resolved = await getOperationalAlertSettings();
      await safeRecordAdminAudit(req, {
        module: "settings",
        action: "SET_OPERATIONAL_ALERTS",
        targetId: "operational_alerts",
        targetLabel: "Alertas Operacionais",
        summary: "Atualizou os destinatários e regras de alertas operacionais.",
        before: {},
        after: {
          recipientsCount: recipients.length,
          channels: resolved.channels,
          cooldowns: resolved.cooldowns,
        },
        meta: { recipients },
      });
      return res.json({ ok: true, ...resolved });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // -----------------------------
  // 🛠️ Configurações Globais
  // -----------------------------
  router.get("/settings", async (req, res) => {
    try {
      const rows = await getResolvedGlobalSettings();
      return res.json({ ok: true, items: rows });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/settings", async (req, res) => {
    try {
      const key = String(req.body?.key || "").trim();
      const def = GLOBAL_SETTINGS_CATALOG.find((item) => item.key === key);
      if (!def) return res.status(400).json({ ok: false, error: "invalid setting key" });

      const beforeStored = await redisGet(settingRedisKey(def.key));
      const normalized = normalizeSettingValue(def, req.body?.value);
      await redisSet(settingRedisKey(def.key), serializeSettingValue(def, normalized));
      await safeRecordAdminAudit(req, {
        module: "settings",
        action: "SET_GLOBAL_SETTING",
        targetId: def.key,
        targetLabel: def.label,
        summary: `Atualizou a configuração global ${def.key}.`,
        before: { storedValue: beforeStored },
        after: { value: normalized },
        meta: { key: def.key, type: def.type },
      });

      return res.json({ ok: true, key: def.key, value: normalized });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/settings/reset", async (req, res) => {
    try {
      const key = String(req.body?.key || "").trim();
      const def = GLOBAL_SETTINGS_CATALOG.find((item) => item.key === key);
      if (!def) return res.status(400).json({ ok: false, error: "invalid setting key" });

      const beforeStored = await redisGet(settingRedisKey(def.key));
      await redisDel(settingRedisKey(def.key));
      await safeRecordAdminAudit(req, {
        module: "settings",
        action: "RESET_GLOBAL_SETTING",
        targetId: def.key,
        targetLabel: def.label,
        summary: `Resetou a configuração global ${def.key} para o padrão.`,
        before: { storedValue: beforeStored },
        after: { value: def.defaultValue, reset: true },
        meta: { key: def.key },
      });
      return res.json({ ok: true, key: def.key, value: def.defaultValue, reset: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/settings-ui", async (req, res) => {
    const rows = await getResolvedGlobalSettings();
    const groups = groupGlobalSettings(rows);
    const operationalAlerts = await getOperationalAlertSettings();

    const cards = groups.map(({ section, items }) => {
      const body = items.map((row) => {
        const inputHtml = (() => {
          if (row.type === "bool") {
            return `<label class="pill"><input type="checkbox" data-setting-input="${escapeHtml(row.key)}" ${row.value ? "checked" : ""} /> Ativo</label>`;
          }
          if (row.type === "enum") {
            const options = (row.options || []).map((opt) => `<option value="${escapeHtml(opt)}" ${String(opt) === String(row.value) ? "selected" : ""}>${escapeHtml(opt)}</option>`).join("");
            return `<select data-setting-input="${escapeHtml(row.key)}">${options}</select>`;
          }
          if (row.type === "int") {
            const min = Number.isFinite(row.min) ? ` min="${escapeHtml(String(row.min))}"` : "";
            const max = Number.isFinite(row.max) ? ` max="${escapeHtml(String(row.max))}"` : "";
            return `<input type="number" data-setting-input="${escapeHtml(row.key)}" value="${escapeHtml(String(row.value))}"${min}${max} />`;
          }
          return `<input type="text" data-setting-input="${escapeHtml(row.key)}" value="${escapeHtml(String(row.value || ""))}" />`;
        })();

        return `
          <tr>
            <td>
              <div><b>${escapeHtml(row.label)}</b></div>
              <div class="muted" style="font-size:12px;">${escapeHtml(row.key)}</div>
              <div class="muted" style="font-size:12px;margin-top:4px;">${escapeHtml(row.help || "")}</div>
            </td>
            <td>${inputHtml}</td>
            <td><code>${escapeHtml(String(row.defaultValue ?? ""))}</code></td>
            <td>${row.isCustom ? '<span class="badge warn">custom</span>' : '<span class="badge soft">default</span>'}</td>
            <td>
              <div class="row">
                <button type="button" class="primary" data-save-setting="${escapeHtml(row.key)}">Salvar</button>
                <button type="button" data-reset-setting="${escapeHtml(row.key)}">Resetar</button>
              </div>
            </td>
          </tr>
        `;
      }).join("");

      return `
        <div class="card pad" style="margin-bottom:14px;">
          <div class="row" style="justify-content:space-between;">
            <div>
              <h3 style="margin:0 0 6px 0;">${escapeHtml(section)}</h3>
              <div class="muted">Configurações globais persistidas no Redis.</div>
            </div>
          </div>
          <div class="hr"></div>
          <table>
            <thead>
              <tr>
                <th>Configuração</th>
                <th>Valor atual</th>
                <th>Padrão</th>
                <th>Origem</th>
                <th>Ação</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      `;
    }).join("");

    const html = layoutBase({
      title: "Configurações Globais",
      activePath: "/admin/settings-ui",
      content: `
        <div class="card pad" style="margin-bottom:14px;">
          <div class="row" style="justify-content:space-between;">
            <div>
              <h3 style="margin:0 0 6px 0;">🛠️ Configurações Globais</h3>
              <div class="muted">Controle operacional centralizado do sistema. Essas regras não substituem os planos; elas complementam o comportamento global.</div>
            </div>
            <div class="pill">Persistência: <b>Redis</b></div>
          </div>
        </div>
        ${cards}
        <div class="card pad" style="margin-bottom:14px;">
          <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
            <div>
              <h3 style="margin:0 0 6px 0;">🚨 Alertas Operacionais</h3>
              <div class="muted">Cadastre os destinatários que receberão alertas imediatos por WhatsApp e e-mail quando houver incidentes operacionais.</div>
            </div>
            <div class="pill">Destinatários ativos: <b>${escapeHtml(String((operationalAlerts.recipients || []).filter((item) => item && item.active).length))}</b></div>
          </div>
          <div class="hr"></div>
          <div class="grid cols2">
            <div class="card pad">
              <div style="font-weight:700; margin-bottom:8px;">Destinatários</div>
              <div class="muted" style="font-size:12px; margin-bottom:8px;">Informe nome, canal, contato, severidade mínima e se o destinatário está ativo.</div>
              <div id="operationalAlertRecipients"></div>
              <div class="row" style="margin-top:10px;">
                <button type="button" id="addOperationalRecipientBtn">Adicionar destinatário</button>
                <button type="button" class="primary" id="saveOperationalAlertsBtn">Salvar alertas operacionais</button>
              </div>
            </div>
            <div class="card pad">
              <div style="font-weight:700; margin-bottom:8px;">Regras por canal e cooldown</div>
              <div class="grid">
                <label>WhatsApp mínimo
                  <select id="operationalAlertWhatsappMin">${OPERATIONAL_ALERT_SEVERITIES.map((item) => `<option value="${escapeHtml(item)}" ${operationalAlerts.channels.whatsapp === item ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select>
                </label>
                <label>E-mail mínimo
                  <select id="operationalAlertEmailMin">${OPERATIONAL_ALERT_SEVERITIES.map((item) => `<option value="${escapeHtml(item)}" ${operationalAlerts.channels.email === item ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select>
                </label>
                <label class="pill"><input type="checkbox" id="operationalAlertNotifyResolution" ${operationalAlerts.channels.notifyResolution ? "checked" : ""} /> Notificar resolução do incidente</label>
                <div class="grid cols2">
                  <label>Cooldown LOW (s)<input type="number" id="cooldownLow" value="${escapeHtml(String(operationalAlerts.cooldowns.LOW || 1800))}" min="0" max="86400" /></label>
                  <label>Cooldown MEDIUM (s)<input type="number" id="cooldownMedium" value="${escapeHtml(String(operationalAlerts.cooldowns.MEDIUM || 900))}" min="0" max="86400" /></label>
                  <label>Cooldown HIGH (s)<input type="number" id="cooldownHigh" value="${escapeHtml(String(operationalAlerts.cooldowns.HIGH || 300))}" min="0" max="86400" /></label>
                  <label>Cooldown CRITICAL (s)<input type="number" id="cooldownCritical" value="${escapeHtml(String(operationalAlerts.cooldowns.CRITICAL || 60))}" min="0" max="86400" /></label>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="card pad">
          <details>
            <summary class="muted">Ver JSON resolvido</summary>
            <pre id="settingsRaw" style="white-space:pre-wrap;">${escapeHtml(JSON.stringify(rows, null, 2))}</pre>
          </details>
        </div>
      `,
      scriptExtra: `
        <script>
          (function(){
            const operationalAlertRecipientsState = [];
            const operationalRecipientSeed = [];
            function recipientTemplate(item){
              const row = item || {};
              return '<div class="card pad" data-operational-recipient-row style="margin-bottom:8px;">' +
                '<div class="grid cols2">' +
                  '<label>Nome<input type="text" data-recipient-field="name" value="' + String(row.name || '').replaceAll('"','&quot;') + '" placeholder="Ex.: Wellington" /></label>' +
                  '<label>Contato<input type="text" data-recipient-field="contact" value="' + String(row.contact || '').replaceAll('"','&quot;') + '" placeholder="Email ou 55DDXXXXXXXXX" /></label>' +
                  '<label>Canal<select data-recipient-field="channel">' +
                    '<option value="WHATSAPP"' + ((row.channel||'') === 'WHATSAPP' ? ' selected' : '') + '>WHATSAPP</option>' +
                    '<option value="EMAIL"' + ((row.channel||'') === 'EMAIL' ? ' selected' : '') + '>EMAIL</option>' +
                  '</select></label>' +
                  '<label>Severidade mínima<select data-recipient-field="minSeverity">' +
                    ["LOW", "MEDIUM", "HIGH", "CRITICAL"].map(function(opt){
                      return '<option value="' + opt + '"' + ((row.minSeverity||'HIGH') === opt ? ' selected' : '') + '>' + opt + '</option>';
                    }).join('') +
                  '</select></label>' +
                '</div>' +
                '<div class="row" style="margin-top:8px; justify-content:space-between;">' +
                  '<label class="pill"><input type="checkbox" data-recipient-field="active"' + (row.active === false ? '' : ' checked') + ' /> Ativo</label>' +
                  '<button type="button" data-remove-operational-recipient="1">Remover</button>' +
                '</div>' +
              '</div>';
            }
            function renderOperationalRecipients(){
              const host = document.getElementById('operationalAlertRecipients');
              if (!host) return;
              if (!operationalAlertRecipientsState.length) {
                operationalAlertRecipientsState.push({ name:'', contact:'', channel:'WHATSAPP', minSeverity:'HIGH', active:true });
              }
              host.innerHTML = operationalAlertRecipientsState.map(function(item){
                return recipientTemplate(item);
              }).join('');
            }
            function collectOperationalRecipients(){
              return Array.from(document.querySelectorAll('[data-operational-recipient-row]')).map(function(row){
                return {
                  name: row.querySelector('[data-recipient-field="name"]').value,
                  contact: row.querySelector('[data-recipient-field="contact"]').value,
                  channel: row.querySelector('[data-recipient-field="channel"]').value,
                  minSeverity: row.querySelector('[data-recipient-field="minSeverity"]').value,
                  active: !!row.querySelector('[data-recipient-field="active"]').checked,
                };
              }).filter(function(item){ return String(item.contact || '').trim(); });
            }
            async function postJson(url, body){
              const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
              const j = await r.json().catch(()=>({}));
              return { r, j };
            }
            function readSettingValue(key){
              const el = document.querySelector('[data-setting-input="' + CSS.escape(key) + '"]');
              if (!el) return '';
              if (el.type === 'checkbox') return !!el.checked;
              return el.value;
            }
            async function saveSetting(key){
              const value = readSettingValue(key);
              const out = await postJson('/admin/settings', { key, value });
              if (!out.r.ok || !out.j.ok) {
                alert('Falha ao salvar configuração.');
                return;
              }
              window.location.reload();
            }
            async function resetSetting(key){
              const out = await postJson('/admin/settings/reset', { key });
              if (!out.r.ok || !out.j.ok) {
                alert('Falha ao resetar configuração.');
                return;
              }
              window.location.reload();
            }
            async function saveOperationalAlerts(){
              const recipients = collectOperationalRecipients();
              const body = {
                recipients,
                channels: {
                  whatsapp: document.getElementById('operationalAlertWhatsappMin').value,
                  email: document.getElementById('operationalAlertEmailMin').value,
                  notifyResolution: !!document.getElementById('operationalAlertNotifyResolution').checked,
                },
                cooldowns: {
                  LOW: document.getElementById('cooldownLow').value,
                  MEDIUM: document.getElementById('cooldownMedium').value,
                  HIGH: document.getElementById('cooldownHigh').value,
                  CRITICAL: document.getElementById('cooldownCritical').value,
                },
              };
              const out = await postJson('/admin/settings/operational-alerts', body);
              if (!out.r.ok || !out.j.ok) {
                alert('Falha ao salvar alertas operacionais.');
                return;
              }
              window.location.reload();
            }
            operationalAlertRecipientsState.splice(0, operationalAlertRecipientsState.length, ...${JSON.stringify(operationalAlerts.recipients || [])});
            renderOperationalRecipients();
            document.addEventListener('click', function(ev){
              if (ev.target.closest('#addOperationalRecipientBtn')) {
                operationalAlertRecipientsState.push({ name:'', contact:'', channel:'WHATSAPP', minSeverity:'HIGH', active:true });
                renderOperationalRecipients();
                return;
              }
              if (ev.target.closest('#saveOperationalAlertsBtn')) {
                saveOperationalAlerts();
                return;
              }
              if (ev.target.closest('[data-remove-operational-recipient]')) {
                const rows = Array.from(document.querySelectorAll('[data-operational-recipient-row]'));
                const current = ev.target.closest('[data-operational-recipient-row]');
                const index = rows.indexOf(current);
                if (index >= 0) {
                  operationalAlertRecipientsState.splice(index, 1);
                  renderOperationalRecipients();
                }
                return;
              }
              const saveBtn = ev.target.closest('[data-save-setting]');
              if (saveBtn) {
                saveSetting(saveBtn.getAttribute('data-save-setting'));
                return;
              }
              const resetBtn = ev.target.closest('[data-reset-setting]');
              if (resetBtn) {
                resetSetting(resetBtn.getAttribute('data-reset-setting'));
              }
            });
          })();
        </script>
      `,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // -----------------------------
  // 👥 Usuários — Lista (UI)
  // -----------------------------
  router.get("/admin-users/data", async (req, res) => {
    try {
      const [admins, roles, permissions] = await Promise.all([
        listManagedAdmins(),
        Promise.resolve(listAdminRoleDefinitions()),
        Promise.resolve(listAdminPermissionDefinitions()),
      ]);
      return res.json({
        ok: true,
        ts: Date.now(),
        currentAdmin: getAdminRequestSession(req),
        counts: {
          total: admins.length,
          active: admins.filter((item) => item.isActive).length,
          inactive: admins.filter((item) => !item.isActive).length,
          superAdmins: admins.filter((item) => item.isActive && item.role === "SUPER_ADMIN").length,
        },
        roles,
        permissions,
        admins,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/admin-users/upsert", async (req, res) => {
    try {
      const username = String(req.body?.username || "").trim().toLowerCase();
      const displayName = String(req.body?.displayName || "").trim();
      const role = String(req.body?.role || "").trim().toUpperCase();
      const password = String(req.body?.password || "");
      const isActive = req.body?.isActive === undefined ? true : ["1", "true", "on", true].includes(req.body?.isActive);
      const before = await getManagedAdmin(username);
      const adminsBefore = await listManagedAdmins();
      const activeSuperAdminsBefore = adminsBefore.filter((item) => item.isActive && item.role === "SUPER_ADMIN").length;
      if (before && before.isActive && before.role === "SUPER_ADMIN" && (!isActive || role !== "SUPER_ADMIN") && activeSuperAdminsBefore <= 1) {
        return res.status(400).send(layoutBase({
          title: "Administradores e Acessos",
          activePath: "/admin/admin-users-ui",
          content: `<div class="card pad"><h3 style="margin-top:0;">Operação bloqueada</h3><div class="muted">É obrigatório manter pelo menos um SUPER_ADMIN ativo.</div><div class="hr"></div><a class="pill" href="/admin/admin-users-ui">Voltar</a></div>`,
        }));
      }
      const saved = await upsertManagedAdmin({ username, displayName, role, password, isActive });
      await safeRecordAdminAudit(req, {
        module: "admin_access",
        action: before ? "UPDATE_ADMIN_USER" : "CREATE_ADMIN_USER",
        targetId: saved.username,
        targetLabel: saved.displayName || saved.username,
        summary: before ? `Atualizou o administrador ${saved.username}.` : `Criou o administrador ${saved.username}.`,
        before: before || {},
        after: saved,
        meta: { role: saved.role, isActive: saved.isActive, passwordChanged: Boolean(password) },
      });
      return res.redirect("/admin/admin-users-ui?saved=1");
    } catch (err) {
      return res.status(500).send(layoutBase({
        title: "Administradores e Acessos",
        activePath: "/admin/admin-users-ui",
        content: `<div class="card pad"><h3 style="margin-top:0;">Erro ao salvar administrador</h3><div class="muted">${escapeHtml(String(err?.message || err))}</div><div class="hr"></div><a class="pill" href="/admin/admin-users-ui">Voltar</a></div>`,
      }));
    }
  });

  router.post("/admin-users/toggle", async (req, res) => {
    try {
      const username = String(req.body?.username || "").trim().toLowerCase();
      const isActive = ["1", "true", "on", true].includes(req.body?.isActive);
      const before = await getManagedAdmin(username);
      if (!before) {
        return res.status(404).send(layoutBase({
          title: "Administradores e Acessos",
          activePath: "/admin/admin-users-ui",
          content: `<div class="card pad"><h3 style="margin-top:0;">Administrador não encontrado</h3><div class="hr"></div><a class="pill" href="/admin/admin-users-ui">Voltar</a></div>`,
        }));
      }
      const adminsBefore = await listManagedAdmins();
      const activeSuperAdminsBefore = adminsBefore.filter((item) => item.isActive && item.role === "SUPER_ADMIN").length;
      if (before.isActive && before.role === "SUPER_ADMIN" && !isActive && activeSuperAdminsBefore <= 1) {
        return res.status(400).send(layoutBase({
          title: "Administradores e Acessos",
          activePath: "/admin/admin-users-ui",
          content: `<div class="card pad"><h3 style="margin-top:0;">Operação bloqueada</h3><div class="muted">É obrigatório manter pelo menos um SUPER_ADMIN ativo.</div><div class="hr"></div><a class="pill" href="/admin/admin-users-ui">Voltar</a></div>`,
        }));
      }
      const saved = await setManagedAdminActive(username, isActive);
      await safeRecordAdminAudit(req, {
        module: "admin_access",
        action: saved.isActive ? "ENABLE_ADMIN_USER" : "DISABLE_ADMIN_USER",
        targetId: saved.username,
        targetLabel: saved.displayName || saved.username,
        summary: saved.isActive ? `Reativou o administrador ${saved.username}.` : `Desativou o administrador ${saved.username}.`,
        before,
        after: saved,
        meta: { role: saved.role, isActive: saved.isActive },
      });
      return res.redirect("/admin/admin-users-ui?toggled=1");
    } catch (err) {
      return res.status(500).send(layoutBase({
        title: "Administradores e Acessos",
        activePath: "/admin/admin-users-ui",
        content: `<div class="card pad"><h3 style="margin-top:0;">Erro ao atualizar status</h3><div class="muted">${escapeHtml(String(err?.message || err))}</div><div class="hr"></div><a class="pill" href="/admin/admin-users-ui">Voltar</a></div>`,
      }));
    }
  });

  router.post("/admin-users/password", async (req, res) => {
    try {
      const username = String(req.body?.username || "").trim().toLowerCase();
      const password = String(req.body?.password || "");
      const before = await getManagedAdmin(username);
      if (!before) return res.status(404).json({ ok: false, error: "Administrador não encontrado." });
      const saved = await updateManagedAdminPassword(username, password);
      await safeRecordAdminAudit(req, {
        module: "admin_access",
        action: "RESET_ADMIN_PASSWORD",
        targetId: saved.username,
        targetLabel: saved.displayName || saved.username,
        summary: `Atualizou a senha do administrador ${saved.username}.`,
        before,
        after: { username: saved.username, role: saved.role, isActive: saved.isActive, updatedAt: saved.updatedAt },
        meta: { passwordChanged: true },
      });
      return res.json({ ok: true, admin: saved });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/admin-users-ui", async (req, res) => {
    try {
      const [admins, roles, permissions] = await Promise.all([
        listManagedAdmins(),
        Promise.resolve(listAdminRoleDefinitions()),
        Promise.resolve(listAdminPermissionDefinitions()),
      ]);
      const currentAdmin = getAdminRequestSession(req);
      const roleOptions = roles.map((role) => `<option value="${escapeHtml(role.key)}">${escapeHtml(role.label)}</option>`).join("");
      const adminRows = admins.map((admin) => {
        const roleMeta = roles.find((item) => item.key === admin.role) || { label: admin.role, description: "" };
        return `
          <tr>
            <td>
              <div><b>${escapeHtml(admin.displayName || admin.username)}</b></div>
              <div class="muted" style="font-size:12px;"><code>${escapeHtml(admin.username)}</code></div>
            </td>
            <td>
              <span class="badge info">${escapeHtml(roleMeta.label)}</span>
              <div class="muted" style="font-size:12px; margin-top:4px;">${escapeHtml(roleMeta.description || "")}</div>
            </td>
            <td>${admin.isActive ? '<span class="badge ok">ativo</span>' : '<span class="badge warn">inativo</span>'}</td>
            <td>
              <div class="muted" style="font-size:12px;">Criado em ${escapeHtml(String(admin.createdAt || "—"))}</div>
              <div class="muted" style="font-size:12px;">Atualizado em ${escapeHtml(String(admin.updatedAt || "—"))}</div>
            </td>
            <td>
              <div class="row" style="gap:8px;">
                <button type="button" class="primary" data-admin-edit='${escapeHtml(JSON.stringify(admin))}'>Editar</button>
                <form method="POST" action="/admin/admin-users/toggle" style="display:inline; margin:0;">
                  <input type="hidden" name="username" value="${escapeHtml(admin.username)}" />
                  <input type="hidden" name="isActive" value="${admin.isActive ? "0" : "1"}" />
                  <button type="submit">${admin.isActive ? "Desativar" : "Ativar"}</button>
                </form>
                <button type="button" data-admin-password="${escapeHtml(admin.username)}">Senha</button>
              </div>
            </td>
          </tr>
        `;
      }).join("");
      const roleCards = roles.map((role) => `
        <div class="card pad">
          <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
            <div>
              <div style="font-weight:800; font-size:16px;">${escapeHtml(role.label)}</div>
              <div class="muted" style="margin-top:4px;">${escapeHtml(role.description || "")}</div>
            </div>
            <div class="pill">${escapeHtml(role.key)}</div>
          </div>
          <div class="hr"></div>
          <div class="row" style="gap:8px;">
            ${(role.permissions || []).map((perm) => {
              const meta = getPermissionMeta(perm);
              return `<span class="badge soft" title="${escapeHtml(meta.description || "")}">${escapeHtml(meta.label)}</span>`;
            }).join("")}
          </div>
        </div>
      `).join("");
      const permissionRows = permissions.map((perm) => `
        <tr>
          <td><b>${escapeHtml(perm.label)}</b><div class="muted" style="font-size:12px;"><code>${escapeHtml(perm.key)}</code></div></td>
          <td>${escapeHtml(perm.description || "")}</td>
        </tr>
      `).join("");
      const html = layoutBase({
        title: "Administradores e Acessos",
        activePath: "/admin/admin-users-ui",
        content: `
          <div class="grid cols3" style="margin-bottom:14px;">
            <div class="kpi"><div class="t">Administradores gerenciados</div><div class="v">${admins.length}</div></div>
            <div class="kpi"><div class="t">Administradores ativos</div><div class="v">${admins.filter((item) => item.isActive).length}</div></div>
            <div class="kpi"><div class="t">Perfis disponíveis</div><div class="v">${roles.length}</div></div>
          </div>
          <div class="card pad" style="margin-bottom:14px;">
            <div class="row" style="justify-content:space-between; align-items:flex-start; gap:16px;">
              <div>
                <h3 style="margin:0 0 6px 0;">🛡️ Gestão de administradores e perfis de acesso</h3>
                <div class="muted">Esta camada convive com o <code>ADMIN_SECRET</code> legado. O segredo legado continua com acesso total, mas agora você pode criar usuários administrativos dedicados com perfis específicos por área.</div>
              </div>
              <div class="pill">Sessão atual: <b>${escapeHtml(String(currentAdmin.displayName || currentAdmin.username || "admin"))}</b></div>
            </div>
            <div class="hr"></div>
            <div class="grid cols3">
              <div class="card pad">
                <div class="muted">Usuário autenticado</div>
                <div style="font-size:18px; font-weight:800; margin-top:6px;">${escapeHtml(String(currentAdmin.username || "admin"))}</div>
                <div class="muted" style="margin-top:6px;">${escapeHtml(String(currentAdmin.displayName || ""))}</div>
              </div>
              <div class="card pad">
                <div class="muted">Perfil atual</div>
                <div style="font-size:18px; font-weight:800; margin-top:6px;">${escapeHtml(String(currentAdmin.role || "SUPER_ADMIN"))}</div>
                <div class="muted" style="margin-top:6px;">Modo: ${escapeHtml(String(currentAdmin.authMode || "legacy_shared_secret"))}</div>
              </div>
              <div class="card pad">
                <div class="muted">Permissões da sessão</div>
                <div class="row" style="margin-top:10px; gap:8px;">
                  ${(Array.isArray(currentAdmin.permissions) ? currentAdmin.permissions : []).map((item) => `<span class="badge soft">${escapeHtml(item)}</span>`).join("") || '<span class="badge soft">*</span>'}
                </div>
              </div>
            </div>
          </div>
          <div class="card pad" style="margin-bottom:14px;">
            <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
              <div>
                <h3 style="margin:0 0 6px 0;">Cadastrar ou editar administrador</h3>
                <div class="muted">Use um usuário exclusivo para cada pessoa. Ao editar, deixe a senha em branco para mantê-la como está.</div>
              </div>
              <div class="pill">Proteção adicional por perfil</div>
            </div>
            <div class="hr"></div>
            <form method="POST" action="/admin/admin-users/upsert" id="adminUserForm" class="grid cols2">
              <div>
                <div class="muted" style="font-size:12px; margin-bottom:4px;">Usuário de login</div>
                <input type="text" name="username" id="adminUsername" placeholder="ex.: financeiro" minlength="3" maxlength="40" required />
              </div>
              <div>
                <div class="muted" style="font-size:12px; margin-bottom:4px;">Nome de exibição</div>
                <input type="text" name="displayName" id="adminDisplayName" placeholder="Ex.: Financeiro Simetria" required />
              </div>
              <div>
                <div class="muted" style="font-size:12px; margin-bottom:4px;">Perfil</div>
                <select name="role" id="adminRole" required>${roleOptions}</select>
              </div>
              <div>
                <div class="muted" style="font-size:12px; margin-bottom:4px;">Senha</div>
                <input type="password" name="password" id="adminPassword" placeholder="mínimo 8 caracteres" minlength="8" />
              </div>
              <div class="row" style="align-items:center; gap:10px;">
                <label class="pill"><input type="checkbox" name="isActive" id="adminIsActive" value="1" checked /> Ativo</label>
                <span class="muted" style="font-size:12px;">Desative em vez de apagar para preservar o histórico de auditoria.</span>
              </div>
              <div class="row" style="justify-content:flex-end; gap:10px;">
                <button type="button" id="adminFormReset">Novo</button>
                <button type="submit" class="primary">Salvar administrador</button>
              </div>
            </form>
          </div>
          <div class="card pad" style="margin-bottom:14px;">
            <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
              <div>
                <h3 style="margin:0 0 6px 0;">Administradores cadastrados</h3>
                <div class="muted">Perfis com credenciais próprias para o Admin. O ADMIN_SECRET legado continua funcionando como contingência total.</div>
              </div>
              <a class="pill" href="/admin/admin-users/data">Ver JSON</a>
            </div>
            <div class="hr"></div>
            <table>
              <thead>
                <tr>
                  <th>Administrador</th>
                  <th>Perfil</th>
                  <th>Status</th>
                  <th>Registro</th>
                  <th>Ações</th>
                </tr>
              </thead>
              <tbody>${adminRows || '<tr><td colspan="5"><div class="muted">Nenhum administrador gerenciado cadastrado ainda. Você pode começar criando o primeiro sem perder o ADMIN_SECRET legado.</div></td></tr>'}</tbody>
            </table>
          </div>
          <div class="grid cols2" style="margin-bottom:14px;">
            <div class="card pad">
              <h3 style="margin:0 0 6px 0;">Perfis disponíveis</h3>
              <div class="muted">Cada perfil agrupa permissões coerentes com a função operacional do Admin.</div>
              <div class="hr"></div>
              <div class="grid">${roleCards}</div>
            </div>
            <div class="card pad">
              <h3 style="margin:0 0 6px 0;">Catálogo de permissões</h3>
              <div class="muted">Essas permissões são aplicadas automaticamente conforme o perfil escolhido.</div>
              <div class="hr"></div>
              <table>
                <thead><tr><th>Permissão</th><th>Descrição</th></tr></thead>
                <tbody>${permissionRows}</tbody>
              </table>
            </div>
          </div>
        `,
        scriptExtra: `
          <script>
            (function(){
              const resetButton = document.getElementById('adminFormReset');
              const usernameEl = document.getElementById('adminUsername');
              const displayNameEl = document.getElementById('adminDisplayName');
              const roleEl = document.getElementById('adminRole');
              const passwordEl = document.getElementById('adminPassword');
              const activeEl = document.getElementById('adminIsActive');
              const editButtons = document.querySelectorAll('[data-admin-edit]');
              const passwordButtons = document.querySelectorAll('[data-admin-password]');
              function resetForm(){
                usernameEl.value = '';
                displayNameEl.value = '';
                roleEl.selectedIndex = 0;
                passwordEl.value = '';
                activeEl.checked = true;
                usernameEl.readOnly = false;
                usernameEl.focus();
              }
              resetButton?.addEventListener('click', resetForm);
              editButtons.forEach(function(btn){
                btn.addEventListener('click', function(){
                  try {
                    const payload = JSON.parse(btn.getAttribute('data-admin-edit') || '{}');
                    usernameEl.value = payload.username || '';
                    displayNameEl.value = payload.displayName || '';
                    roleEl.value = payload.role || 'SUPORTE';
                    passwordEl.value = '';
                    activeEl.checked = !!payload.isActive;
                    usernameEl.readOnly = true;
                    displayNameEl.focus();
                  } catch (_) {
                    alert('Não foi possível preparar a edição do administrador.');
                  }
                });
              });
              passwordButtons.forEach(function(btn){
                btn.addEventListener('click', async function(){
                  const username = btn.getAttribute('data-admin-password') || '';
                  const password = window.prompt('Nova senha para ' + username + ' (mínimo 8 caracteres):');
                  if (!password) return;
                  const response = await fetch('/admin/admin-users/password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                  });
                  const data = await response.json().catch(function(){ return {}; });
                  if (!response.ok || !data.ok) {
                    alert((data && data.error) || 'Não foi possível atualizar a senha.');
                    return;
                  }
                  alert('Senha atualizada com sucesso.');
                });
              });
            })();
          </script>
        `,
      });
      return res.status(200).send(html);
    } catch (err) {
      return res.status(500).send(layoutBase({
        title: "Administradores e Acessos",
        activePath: "/admin/admin-users-ui",
        content: `<div class="card pad"><h3 style="margin-top:0;">Erro ao carregar a gestão de administradores</h3><div class="muted">${escapeHtml(String(err?.message || err))}</div><div class="hr"></div><a class="pill" href="/admin">Voltar ao início</a></div>`,
      }));
    }
  });

  router.get("/users-list-ui", async (req, res) => {
    const content = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">Lista de usuários</h3>
            <div class="muted">Visualize rapidamente: Nome, waId, plano e janela 24h. Expanda cada linha para ver os dados completos do usuário.</div>
          </div>
          <div class="row">
            <button type="button" id="usersReloadTop">Recarregar</button>
          </div>
        </div>

        <div class="hr"></div>

        <div class="row" style="gap:10px; flex-wrap:wrap;">
          <input id="uSearch" placeholder="Buscar por nome ou waId..." style="min-width:320px" />
          <input id="uLimit" type="number" min="1" max="500" value="200" style="width:110px" />
          <button type="button" class="primary" id="usersLoadBtn">Carregar</button>
          <div class="muted" id="uMeta" style="margin-left:auto;"></div>
        </div>

        <div class="hr"></div>

        <div style="overflow:auto;">
          <table class="table" style="min-width:900px;">
            <thead>
              <tr>
                <th>Nome</th>
                <th>waId</th>
                <th>Status</th>
                <th>Plano</th>
                <th>Janela 24h</th>
                <th style="width:140px;">Ações</th>
              </tr>
            </thead>
            <tbody id="uTbody">
              <tr><td colspan="6" class="muted">Carregando...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    const scriptExtra = `
      <script>
        document.addEventListener("DOMContentLoaded", function(){
          const state = {
            users: [],
            meta: { total: 0, offset: 0, limit: 200 }
          };

          const els = {
            search: document.getElementById("uSearch"),
            limit: document.getElementById("uLimit"),
            tbody: document.getElementById("uTbody"),
            meta: document.getElementById("uMeta"),
            reloadTop: document.getElementById("usersReloadTop"),
            loadBtn: document.getElementById("usersLoadBtn"),
          };

          function esc(value){
            return String(value ?? "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#39;");
          }

          function fmtTs(ts){
            if (!ts) return "—";
            const d = new Date(Number(ts));
            if (Number.isNaN(d.getTime())) return "—";
            return d.toLocaleString("pt-BR");
          }

          function windowLabel(user){
            if (!user || !user.lastInboundTs) return "—";
            if (user.inWindow) {
              return "Ativa (até " + fmtTs(user.windowExpiresAt) + ")";
            }
            return "Fora (última inbound em " + fmtTs(user.lastInboundTs) + ")";
          }

          function setTbody(html){
            if (els.tbody) els.tbody.innerHTML = html;
          }

          async function fetchJson(url, opt){
            const response = await fetch(url, opt);
            const json = await response.json().catch(() => ({}));
            return { response, json };
          }

          function getFilteredUsers(){
            const q = String(els.search?.value || "").trim().toLowerCase();
            if (!q) return state.users.slice();
            return state.users.filter(function(user){
              const name = String(user?.fullName || "").toLowerCase();
              const wa = String(user?.waId || "");
              return name.includes(q) || wa.includes(q);
            });
          }

          function renderUsers(){
            const filtered = getFilteredUsers();

            if (els.meta) {
              els.meta.textContent = String(filtered.length) + " exibidos • Total base: " + String(state.meta.total || 0);
            }

            if (!filtered.length) {
              setTbody('<tr><td colspan="6" class="muted">Nenhum usuário encontrado.</td></tr>');
              return;
            }

            const rows = [];
            filtered.forEach(function(user){
              const waId = String(user?.waId || "").trim();
              const expId = "user-exp-" + waId;
              rows.push(
                '<tr data-wa-id="' + esc(waId) + '">' +
                  '<td>' + esc(user?.fullName || "—") + '</td>' +
                  '<td><code>' + esc(waId) + '</code></td>' +
                  '<td>' + esc(user?.status || "—") + '</td>' +
                  '<td>' + esc(user?.plan || "—") + '</td>' +
                  '<td>' + esc(windowLabel(user)) + '</td>' +
                  '<td>' +
                    '<div class="row">' +
                      '<button type="button" data-action="toggle-user" data-wa-id="' + esc(waId) + '">Expandir</button>' +
                      '<button type="button" data-action="open-actions" data-wa-id="' + esc(waId) + '">Abrir</button>' +
                    '</div>' +
                  '</td>' +
                '</tr>'
              );
              rows.push(
                '<tr id="' + esc(expId) + '" data-expand-row="1" data-wa-id="' + esc(waId) + '" style="display:none;">' +
                  '<td colspan="6"><div class="muted">Carregando...</div></td>' +
                '</tr>'
              );
            });

            setTbody(rows.join(""));
          }

          async function reloadUsers(){
            const limit = Math.max(1, Math.min(500, Number(els.limit?.value || 200) || 200));
            setTbody('<tr><td colspan="6" class="muted">Carregando...</td></tr>');

            try {
              const out = await fetchJson("/admin/users/list?limit=" + encodeURIComponent(limit));
              if (!out.response.ok || !out.json.ok) {
                setTbody('<tr><td colspan="6" class="muted">Erro ao carregar usuários.</td></tr>');
                return;
              }

              state.users = Array.isArray(out.json.items) ? out.json.items : [];
              state.meta = {
                total: Number(out.json.total || 0),
                offset: Number(out.json.offset || 0),
                limit: Number(out.json.limit || limit)
              };
              renderUsers();
            } catch (_) {
              setTbody('<tr><td colspan="6" class="muted">Erro ao carregar usuários.</td></tr>');
            }
          }

          function buildDetailsHtml(snapshot, inWindow){
            const s = snapshot || {};
            const docLine = (s.doc && s.doc.docType) ? (s.doc.docType + " • " + (s.doc.docLast4 || "")) : "—";
            return '' +
              '<div class="row" style="justify-content:space-between; align-items:flex-start;">' +
                '<div>' +
                  '<div><b>' + esc(s.fullName || "—") + '</b> <span class="muted">(' + esc(s.waId || "") + ')</span></div>' +
                  '<div class="muted">Status: <b>' + esc(s.status || "—") + '</b> • Plano: <b>' + esc(s.plan || "—") + '</b> • Janela 24h: <b>' + esc(inWindow ? "Ativa" : "Fora") + '</b></div>' +
                '</div>' +
                '<div class="row">' +
                  '<button type="button" data-action="open-actions" data-wa-id="' + esc(s.waId || "") + '">Abrir nas ações</button>' +
                  '<button type="button" data-action="close-user" data-wa-id="' + esc(s.waId || "") + '">Fechar</button>' +
                '</div>' +
              '</div>' +
              '<div class="hr"></div>' +
              '<div class="grid cols2">' +
                '<div class="kpi">' +
                  '<div class="t">Dados pessoais</div>' +
                  '<div class="muted">Nome: <b>' + esc(s.fullName || "—") + '</b></div>' +
                  '<div class="muted">Documento: <b>' + esc(docLine) + '</b></div>' +
                  '<div class="muted">Cidade/UF: <b>' + esc(s.billingCityState || "—") + '</b></div>' +
                  '<div class="muted">Endereço: <b>' + esc(s.billingAddress || "—") + '</b></div>' +
                '</div>' +
                '<div class="kpi">' +
                  '<div class="t">Assinatura / Cobrança</div>' +
                  '<div class="muted">Status: <b>' + esc(s.status || "—") + '</b></div>' +
                  '<div class="muted">Plano: <b>' + esc(s.plan || "—") + '</b></div>' +
                  '<div class="muted">Pagamento: <b>' + esc(s.paymentMethod || "—") + '</b></div>' +
                  '<div class="muted">Asaas Customer: <code>' + esc(s.asaasCustomerId || "—") + '</code></div>' +
                  '<div class="muted">Asaas Subscription: <code>' + esc(s.asaasSubscriptionId || "—") + '</code></div>' +
                '</div>' +
              '</div>' +
              '<div class="hr"></div>' +
              '<details>' +
                '<summary class="muted">Ver JSON completo (inclui perfil da empresa)</summary>' +
                '<pre style="white-space:pre-wrap;">' + esc(JSON.stringify(s, null, 2)) + '</pre>' +
              '</details>';
          }

          async function toggleUserRow(waId){
            const row = document.getElementById("user-exp-" + String(waId || ""));
            if (!row) return;

            const isHidden = row.style.display === "none";
            if (!isHidden) {
              row.style.display = "none";
              return;
            }

            row.style.display = "";
            row.querySelector("td").innerHTML = '<div class="muted">Carregando...</div>';

            try {
              const out = await fetchJson("/admin/users/details?waId=" + encodeURIComponent(waId));
              if (!out.response.ok || !out.json.ok) {
                row.querySelector("td").innerHTML = '<div class="muted">Erro ao carregar detalhes.</div>';
                return;
              }
              row.querySelector("td").innerHTML = buildDetailsHtml(out.json.snapshot || {}, !!out.json.inWindow);
            } catch (_) {
              row.querySelector("td").innerHTML = '<div class="muted">Erro ao carregar detalhes.</div>';
            }
          }

          function openActions(waId){
            window.location.href = "/admin/users-ui?waId=" + encodeURIComponent(waId);
          }

          if (els.search) {
            els.search.addEventListener("input", renderUsers);
          }
          if (els.reloadTop) {
            els.reloadTop.addEventListener("click", reloadUsers);
          }
          if (els.loadBtn) {
            els.loadBtn.addEventListener("click", reloadUsers);
          }
          if (els.tbody) {
            els.tbody.addEventListener("click", function(ev){
              const button = ev.target.closest("button[data-action]");
              if (!button) return;
              const action = button.getAttribute("data-action");
              const waId = button.getAttribute("data-wa-id") || "";
              if (!waId) return;

              if (action === "toggle-user") {
                toggleUserRow(waId);
                return;
              }
              if (action === "close-user") {
                const row = document.getElementById("user-exp-" + waId);
                if (row) row.style.display = "none";
                return;
              }
              if (action === "open-actions") {
                openActions(waId);
              }
            });
          }

          reloadUsers();
        });
      </script>
    `;

    const html = layoutBase({
      title: "Usuários • Lista",
      activePath: "/admin/users-list-ui",
      content,
      scriptExtra,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // -----------------------------
  // 👥 Usuários — Ações/Consulta (UI)
  // -----------------------------
  router.get("/users-ui", async (req, res) => {
    const html = layoutBase({
      title: "Usuários • Ações",
      activePath: "/admin/users-ui",
      content: `
        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <div>
              <h3 style="margin:0 0 6px 0;">Ações por waId</h3>
              <div class="muted">Consulta e comandos operacionais, sem depender de URLs “soltas”.</div>
            </div>
            <div class="muted">Ex.: <code>5511960765975</code></div>
          </div>

          <div class="hr"></div>

          <div class="row">
            <input id="waId" placeholder="waId (somente números) ex: 5511..." style="min-width:320px" />
            <button class="primary" onclick="loadSnapshot()">Consultar</button>
            <button onclick="touchWindow()">Touch Janela 24h</button>
            <button onclick="sendTest()">Enviar 'oi'</button>
          </div>

          <div class="row" style="margin-top:10px;">
            <button class="danger" onclick="resetTrial()">Reset TRIAL</button>
            <button class="danger" onclick="resetUser()">Reset TOTAL (como novo)</button>
            <button onclick="setStatus('ACTIVE')">Forçar ACTIVE</button>
            <button onclick="setStatus('BLOCKED')">Forçar BLOCKED</button>
            <button onclick="clearPrompt()">Limpar lastPrompt</button>
          </div>

          <div class="hr"></div>
          <div class="grid cols2">
            <div class="kpi">
              <div class="t">Status</div>
              <div class="v" id="kStatus">—</div>
              <div class="muted" id="kPlan">Plano: —</div>
            </div>
            <div class="kpi">
              <div class="t">Uso</div>
              <div class="v" id="kUsage">—</div>
              <div class="muted" id="kUsage2">—</div>
            </div>
          </div>

          <div class="hr"></div>
          <details>
            <summary class="muted">Ver JSON bruto</summary>
            <pre id="out" style="white-space:pre-wrap;"></pre>
          </details>
        </div>

        <script>
          function waId(){
            return (document.getElementById('waId').value || '').trim();
          }
          async function fetchJson(url, opt){
            const r = await fetch(url, opt);
            const j = await r.json().catch(()=>({}));
            return { r, j };
          }
          function renderUser(j){
            const snap = j?.user || j?.userSnapshot || j?.user?.snapshot || j?.snapshot || {};
            document.getElementById('kStatus').textContent = snap.status || '—';
            document.getElementById('kPlan').textContent = 'Plano: ' + (snap.plan || '—');

            const quotaUsed = Number(snap.quotaUsed ?? 0);
            const trialUsed = Number(snap.trialUsed ?? 0);
            const quotaStr = (snap.status === 'TRIAL')
              ? (trialUsed + ' (trialUsed)')
              : (quotaUsed + ' (quotaUsed)');

            document.getElementById('kUsage').textContent = quotaStr;
            document.getElementById('kUsage2').textContent = 'templatePrompted: ' + String(snap.templatePrompted ?? '—');

            document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          }

          async function loadSnapshot(){
            const id = waId(); if(!id){ alert('Informe o waId'); return; }
            const {r,j} = await fetchJson('/admin/users/snapshot?waId=' + encodeURIComponent(id));
            if(!r.ok || !j.ok){ alert('Falha ao consultar.'); document.getElementById('out').textContent = JSON.stringify(j, null, 2); return; }
            renderUser(j);
          }

          async function touchWindow(){
            const id = waId(); if(!id){ alert('Informe o waId'); return; }
            const {j} = await fetchJson('/admin/window24h/touch?waId=' + encodeURIComponent(id));
            document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          }

          async function resetTrial(){
            const id = waId(); if(!id){ alert('Informe o waId'); return; }
            if(!confirm('Resetar TRIAL (status TRIAL, plan vazio, quotaUsed/trialUsed = 0, limpa lastPrompt)?')) return;
            const {j} = await fetchJson('/admin/state-test/reset-trial?waId=' + encodeURIComponent(id));
            document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          }

          async function resetUser(){
            const id = waId(); if(!id){ alert('Informe o waId'); return; }
            if(!confirm('RESET TOTAL: remove estado, métricas, janela 24h e overrides de copy. Confirmar?')) return;
            const {j} = await fetchJson('/admin/state-test/reset-user?waId=' + encodeURIComponent(id));
            document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          }

          async function sendTest(){
            const id = waId(); if(!id){ alert('Informe o waId'); return; }
            const {j} = await fetchJson('/admin/send-test?waId=' + encodeURIComponent(id));
            document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          }

          async function setStatus(st){
            const id = waId(); if(!id){ alert('Informe o waId'); return; }
            const {j} = await fetchJson('/admin/users/status', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ waId:id, status:st }) });
            document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          }

          async function clearPrompt(){
            const id = waId(); if(!id){ alert('Informe o waId'); return; }
            const {j} = await fetchJson('/admin/users/clear-lastprompt?waId=' + encodeURIComponent(id));
            document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          }

          // Carrega snapshot se waId vier na query string (opcional)
          (function init(){
            const p = new URLSearchParams(location.search);
            const id = (p.get('waId')||'').trim();
            if(id){ document.getElementById('waId').value = id; loadSnapshot(); }
          })();
        </script>
      `,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // APIs de usuário (para UI clean, sem depender de múltiplas URLs)
    router.get("/users/list", async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 200)));
      const offset = Math.max(0, Number(req.query?.offset || 0));

      const idsRaw = await listUsers();
      const ids = Array.isArray(idsRaw) ? idsRaw.slice() : [];
      ids.sort();

      const slice = ids.slice(offset, offset + limit);
      const now = nowMs();

      const items = await mapLimit(
        slice,
        20,
        async (userId) => {
          const [snap, lastInboundTsRaw, identifiers] = await Promise.all([
            getUserSnapshot(userId),
            getLastInboundTs(userId),
            getUserIdentifiers(userId).catch(() => null),
          ]);

          const lastInboundTs = Number(lastInboundTsRaw) || 0;
          const inWindow = lastInboundTs ? now - lastInboundTs < 24 * 60 * 60 * 1000 : false;
          const windowExpiresAt = lastInboundTs ? lastInboundTs + 24 * 60 * 60 * 1000 : 0;

          return {
            userId,
            waId: identifiers?.waId || snap.waId || "",
            bsuid: identifiers?.bsuid || "",
            fullName: snap.fullName || "",
            plan: snap.plan || "",
            status: snap.status || "",
            inWindow,
            lastInboundTs,
            windowExpiresAt,
          };
        }
      );

      return res.status(200).json({
        ok: true,
        total: ids.length,
        offset,
        limit,
        items,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  router.get("/users/snapshot", async (req, res) => {
    try {
      const userId = await requireUserRef(req);
      const [snap, identifiers] = await Promise.all([
        getUserSnapshot(userId),
        getUserIdentifiers(userId).catch(() => null),
      ]);
      const now = nowMs();
      const lastInboundTs = await getLastInboundTs(userId);
      const inWindow = lastInboundTs ? now - Number(lastInboundTs) < 24 * 60 * 60 * 1000 : false;
      const windowExpiresAt = lastInboundTs ? Number(lastInboundTs) + 24 * 60 * 60 * 1000 : 0;

      return res.status(200).json({
        ok: true,
        userId,
        waId: identifiers?.waId || snap.waId || "",
        bsuid: identifiers?.bsuid || "",
        inWindow,
        lastInboundTs: Number(lastInboundTs) || 0,
        windowExpiresAt,
        snapshot: snap,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  router.get("/users/details", async (req, res) => {
    try {
      const userId = await requireUserRef(req);
      const [snap, identifiers] = await Promise.all([
        getUserSnapshot(userId),
        getUserIdentifiers(userId).catch(() => null),
      ]);
      const now = nowMs();
      const lastInboundTs = await getLastInboundTs(userId);
      const inWindow = lastInboundTs ? now - Number(lastInboundTs) < 24 * 60 * 60 * 1000 : false;
      const windowExpiresAt = lastInboundTs ? Number(lastInboundTs) + 24 * 60 * 60 * 1000 : 0;

      return res.status(200).json({
        ok: true,
        userId,
        waId: identifiers?.waId || snap.waId || "",
        bsuid: identifiers?.bsuid || "",
        inWindow,
        lastInboundTs: Number(lastInboundTs) || 0,
        windowExpiresAt,
        snapshot: snap,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

router.post("/users/status", async (req, res) => {
    try {
      const userId = await requireBodyUserRef(req);
      const status = String(req.body?.status || "").trim();
      if (!status) return res.status(400).json({ ok: false, error: "status required" });
      const [beforeUser, identifiers] = await Promise.all([
        getUserSnapshot(userId),
        getUserIdentifiers(userId).catch(() => null),
      ]);
      await setUserStatus(userId, status);
      const user = await getUserSnapshot(userId);
      await safeRecordAdminAudit(req, {
        module: "users",
        action: "SET_USER_STATUS",
        waId: identifiers?.waId || beforeUser?.waId || "",
        targetId: userId,
        summary: `Alterou o status do usuário ${userId} para ${status}.`,
        before: buildAuditUserSnapshot(beforeUser),
        after: buildAuditUserSnapshot(user),
        meta: { status, userId },
      });
      return res.json({ ok: true, userId, waId: identifiers?.waId || user.waId || "", status, user });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  router.get("/users/clear-lastprompt", async (req, res) => {
    try {
      const userId = await requireUserRef(req);
      const [beforeUser, identifiers] = await Promise.all([
        getUserSnapshot(userId),
        getUserIdentifiers(userId).catch(() => null),
      ]);
      await clearLastPrompt(userId);
      const user = await getUserSnapshot(userId);
      await safeRecordAdminAudit(req, {
        module: "users",
        action: "CLEAR_LAST_PROMPT",
        waId: identifiers?.waId || beforeUser?.waId || "",
        targetId: userId,
        summary: `Limpou o último prompt salvo do usuário ${userId}.`,
        before: { lastPrompt: limitText(beforeUser?.lastPrompt || "", 500) },
        after: { lastPrompt: limitText(user?.lastPrompt || "", 500) },
      });
      return res.json({ ok: true, userId, waId: identifiers?.waId || user.waId || "", action: "clearLastPrompt", user });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

// -----------------------------
  // Planos
  // -----------------------------
  router.get("/plans", async (req, res) => {
    const plans = await listPlans({ includeInactive: true });

    const rows = plans
      .map((p) => {
        const code = escapeHtml(String(p?.code || "").trim());
        const name = escapeHtml(String(p?.name || "").trim());
        const monthly = p?.billingOptions?.monthly || {
          priceCents: p?.priceCents || 0,
          quota: p?.monthlyQuota || 0,
          maxRefinements: p?.maxRefinements || 0,
          description: p?.description || "",
          displayLabel: "",
          enabled: true,
        };
        const annual = p?.billingOptions?.annual || {
          priceCents: p?.annualPriceCents || 0,
          quota: p?.annualQuota || 0,
          maxRefinements: p?.annualMaxRefinements ?? p?.maxRefinements ?? 0,
          description: p?.annualDescription || "",
          displayLabel: "",
          enabled: p?.annualEnabled ?? true,
        };
        const monthlyPrice = escapeHtml(formatMoneyCents(monthly.priceCents || 0));
        const annualPrice = escapeHtml(formatMoneyCents(annual.priceCents || 0));
        const monthlyQuota = escapeHtml(String(monthly.quota ?? ""));
        const annualQuota = escapeHtml(String(annual.quota ?? ""));
        const monthlyRefinements = escapeHtml(String(monthly.maxRefinements ?? p?.maxRefinements ?? ""));
        const annualRefinements = escapeHtml(String(annual.maxRefinements ?? p?.maxRefinements ?? ""));
        const monthlyDescription = escapeHtml(String(monthly.description ?? p?.description ?? ""));
        const annualDescription = escapeHtml(String(annual.description ?? p?.annualDescription ?? ""));
        const monthlyDisplayLabel = escapeHtml(String(monthly.displayLabel ?? ""));
        const annualDisplayLabel = escapeHtml(String(annual.displayLabel ?? ""));
        const active = Boolean(p?.active);
        const annualEnabled = Boolean(annual?.enabled ?? true);
        return `<tr
          data-code="${code}"
          data-name="${name}"
          data-active="${active ? "true" : "false"}"
          data-pricecents="${escapeHtml(String(monthly.priceCents || 0))}"
          data-monthlyquota="${monthlyQuota}"
          data-maxrefinements="${monthlyRefinements}"
          data-description="${monthlyDescription}"
          data-monthlydisplaylabel="${monthlyDisplayLabel}"
          data-annualenabled="${annualEnabled ? "true" : "false"}"
          data-annualpricecents="${escapeHtml(String(annual.priceCents || 0))}"
          data-annualquota="${annualQuota}"
          data-annualmaxrefinements="${annualRefinements}"
          data-annualdescription="${annualDescription}"
          data-annualdisplaylabel="${annualDisplayLabel}"
        >
          <td><code>${code}</code></td>
          <td>${name}</td>
          <td>${active ? '<span class="badge ok">Ativo</span>' : '<span class="badge danger">Inativo</span>'}</td>
          <td>
            <div><b>${monthlyPrice}</b></div>
            <div class="muted">${monthlyQuota} descrições/mês · ${monthlyRefinements} ref.</div>
            <div class="muted">${monthlyDescription || "—"}</div>
            <div class="muted">Label: ${monthlyDisplayLabel || "—"}</div>
          </td>
          <td>
            <div>${annualEnabled ? '<span class="badge ok">Anual habilitado</span>' : '<span class="badge warn">Anual desabilitado</span>'}</div>
            <div style="margin-top:6px;"><b>${annualPrice}</b></div>
            <div class="muted">${annualQuota} descrições/ano · ${annualRefinements} ref.</div>
            <div class="muted">${annualDescription || "—"}</div>
            <div class="muted">Label: ${annualDisplayLabel || "—"}</div>
          </td>
          <td>
            <div class="row">
              <button onclick="editRow(this)">Editar</button>
              <button onclick="toggle('${code}', ${active ? "false" : "true"})">
                ${active ? "Desativar" : "Ativar"}
              </button>
            </div>
          </td>
        </tr>`;
      })
      .join("");

    const annualEnabledCount = plans.filter((plan) => Boolean(plan?.billingOptions?.annual?.enabled ?? plan?.annualEnabled ?? true)).length;
    const inactiveCount = plans.filter((plan) => !plan?.active).length;

    const inner = `
      <div class="grid cols3" style="margin-bottom:12px;">
        <div class="kpi">
          <div class="t">Planos cadastrados</div>
          <div class="v">${plans.length}</div>
          <div class="muted">Total de códigos disponíveis no catálogo.</div>
        </div>
        <div class="kpi">
          <div class="t">Planos com anual habilitado</div>
          <div class="v">${annualEnabledCount}</div>
          <div class="muted">Oferta anual pronta para checkout e pricing.</div>
        </div>
        <div class="kpi">
          <div class="t">Planos inativos</div>
          <div class="v">${inactiveCount}</div>
          <div class="muted">Continuam visíveis aqui, mas não aparecem no menu ativo do produto.</div>
        </div>
      </div>

      <div class="card pad">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:16px;">
          <div>
            <h3 style="margin:0 0 6px 0;">💳 Planos</h3>
            <div class="muted">Gerencie o catálogo completo de planos, incluindo todos os campos do ciclo mensal e todos os campos do ciclo anual.</div>
          </div>
          <div class="muted">Valores em centavos · Ex.: R$ 24,90 = <code>2490</code></div>
        </div>

        <div class="hr"></div>

        <div class="grid cols3" style="margin-bottom:12px;">
          <div class="card pad">
            <div style="font-weight:800; margin-bottom:6px;">📌 Code do plano</div>
            <div class="muted">Identificador técnico usado pelo sistema inteiro. Evite trocar o code de um plano já existente em produção.</div>
          </div>
          <div class="card pad">
            <div style="font-weight:800; margin-bottom:6px;">📅 Ciclo mensal</div>
            <div class="muted">Representa preço, quota, refinamentos e descrição do uso mês a mês.</div>
          </div>
          <div class="card pad">
            <div style="font-weight:800; margin-bottom:6px;">🗓️ Ciclo anual</div>
            <div class="muted">Permite habilitar/desabilitar a oferta anual e definir preço, quota anual, descrição anual, refinamentos anuais e label própria.</div>
          </div>
        </div>

        <div class="grid cols2">
          <div class="card pad">
            <h4 style="margin:0 0 10px 0;">Dados gerais do plano</h4>
            <div class="grid">
              <label>
                <div class="muted" style="margin-bottom:4px;">Code do plano</div>
                <input id="code" placeholder="Ex.: DE_VEZ_EM_QUANDO" style="width:100%" />
              </label>
              <label>
                <div class="muted" style="margin-bottom:4px;">Nome comercial</div>
                <input id="name" placeholder="Ex.: De Vez em Quando" style="width:100%" />
              </label>
              <label>
                <div class="row" style="justify-content:space-between; width:100%;">
                  <span class="muted">Plano ativo no catálogo</span>
                  <input id="active" type="checkbox" checked />
                </div>
                <div class="muted" style="font-size:12px; margin-top:6px;">Quando desativado, o plano permanece salvo, mas deixa de aparecer no catálogo ativo.</div>
              </label>
            </div>
          </div>

          <div class="card pad">
            <h4 style="margin:0 0 10px 0;">Orientações importantes</h4>
            <div class="muted" style="margin-bottom:8px;">• <b>priceCents</b> e <b>annualPriceCents</b> definem os valores oficiais usados pelo pricing.</div>
            <div class="muted" style="margin-bottom:8px;">• <b>monthlyQuota</b> e <b>annualQuota</b> são contadores separados. O anual deve refletir o total do ano, não o valor mensal.</div>
            <div class="muted" style="margin-bottom:8px;">• <b>Display label</b> permite ajustar o texto exibido no checkout, como “R$ 298,80/ano”.</div>
            <div class="muted">• <b>Anual habilitado</b> controla se o ciclo anual fica disponível para escolha do usuário.</div>
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid cols2">
          <div class="card pad">
            <h4 style="margin:0 0 10px 0;">Ciclo mensal</h4>
            <div class="grid">
              <label>
                <div class="muted" style="margin-bottom:4px;">Preço mensal (centavos)</div>
                <input id="priceCents" placeholder="Ex.: 2490" style="width:100%" />
              </label>
              <label>
                <div class="muted" style="margin-bottom:4px;">Quota mensal</div>
                <input id="monthlyQuota" placeholder="Ex.: 20" style="width:100%" />
              </label>
              <label>
                <div class="muted" style="margin-bottom:4px;">Refinamentos mensais</div>
                <input id="maxRefinements" placeholder="Ex.: 2" style="width:100%" />
              </label>
              <label>
                <div class="muted" style="margin-bottom:4px;">Descrição mensal</div>
                <input id="description" placeholder="Ex.: 20 descrições/mês" style="width:100%" />
              </label>
              <label>
                <div class="muted" style="margin-bottom:4px;">Label mensal exibida</div>
                <input id="monthlyDisplayLabel" placeholder="Ex.: R$ 24,90/mês" style="width:100%" />
              </label>
            </div>
          </div>

          <div class="card pad">
            <h4 style="margin:0 0 10px 0;">Ciclo anual</h4>
            <div class="grid">
              <label>
                <div class="row" style="justify-content:space-between; width:100%;">
                  <span class="muted">Oferta anual habilitada</span>
                  <input id="annualEnabled" type="checkbox" checked />
                </div>
                <div class="muted" style="font-size:12px; margin-top:6px;">Desative apenas se quiser ocultar a contratação anual sem apagar seus dados.</div>
              </label>
              <label>
                <div class="muted" style="margin-bottom:4px;">Preço anual (centavos)</div>
                <input id="annualPriceCents" placeholder="Ex.: 29880" style="width:100%" />
              </label>
              <label>
                <div class="muted" style="margin-bottom:4px;">Quota anual</div>
                <input id="annualQuota" placeholder="Ex.: 240" style="width:100%" />
              </label>
              <label>
                <div class="muted" style="margin-bottom:4px;">Refinamentos anuais</div>
                <input id="annualMaxRefinements" placeholder="Ex.: 2" style="width:100%" />
              </label>
              <label>
                <div class="muted" style="margin-bottom:4px;">Descrição anual</div>
                <input id="annualDescription" placeholder="Ex.: 240 descrições/ano" style="width:100%" />
              </label>
              <label>
                <div class="muted" style="margin-bottom:4px;">Label anual exibida</div>
                <input id="annualDisplayLabel" placeholder="Ex.: R$ 298,80/ano" style="width:100%" />
              </label>
            </div>
          </div>
        </div>

        <div class="hr"></div>

        <div class="row">
          <button class="primary" onclick="create()">Salvar plano</button>
          <button onclick="clearPlanForm()">Limpar formulário</button>
        </div>

        <div class="hr"></div>

        <div style="overflow:auto;">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Nome</th>
                <th>Status</th>
                <th>Mensal</th>
                <th>Anual</th>
                <th>Ação</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>

        <div class="hr"></div>
        <details>
          <summary class="muted">Ver resposta</summary>
          <pre id="msg" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <script>
        function byId(id){
          return document.getElementById(id);
        }

        function readIntField(id){
          return Number((byId(id)?.value || '0').trim());
        }

        function clearPlanForm(){
          byId('code').value = '';
          byId('name').value = '';
          byId('active').checked = true;
          byId('priceCents').value = '';
          byId('monthlyQuota').value = '';
          byId('maxRefinements').value = '';
          byId('description').value = '';
          byId('monthlyDisplayLabel').value = '';
          byId('annualEnabled').checked = true;
          byId('annualPriceCents').value = '';
          byId('annualQuota').value = '';
          byId('annualMaxRefinements').value = '';
          byId('annualDescription').value = '';
          byId('annualDisplayLabel').value = '';
          const msg = byId('msg');
          if (msg) msg.textContent = 'Formulário limpo.';
        }

        async function create(){
          const body = {
            code: (byId('code').value||'').trim(),
            name: (byId('name').value||'').trim(),
            active: !!byId('active').checked,
            priceCents: readIntField('priceCents'),
            monthlyQuota: readIntField('monthlyQuota'),
            maxRefinements: readIntField('maxRefinements'),
            description: (byId('description').value||'').trim(),
            monthlyDisplayLabel: (byId('monthlyDisplayLabel').value||'').trim(),
            annualEnabled: !!byId('annualEnabled').checked,
            annualPriceCents: readIntField('annualPriceCents'),
            annualQuota: readIntField('annualQuota'),
            annualMaxRefinements: readIntField('annualMaxRefinements'),
            annualDescription: (byId('annualDescription').value||'').trim(),
            annualDisplayLabel: (byId('annualDisplayLabel').value||'').trim(),
          };
          const r = await fetch('/admin/plans', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
          const j = await r.json().catch(()=>({}));
          byId('msg').textContent = JSON.stringify(j, null, 2);
          if(j.ok) setTimeout(()=>location.reload(), 250);
        }

        function editRow(btn){
          try{
            const tr = btn.closest('tr');
            if(!tr) return;
            byId('code').value = tr.getAttribute('data-code') || '';
            byId('name').value = tr.getAttribute('data-name') || '';
            byId('active').checked = (tr.getAttribute('data-active') || 'false') === 'true';
            byId('priceCents').value = tr.getAttribute('data-pricecents') || '';
            byId('monthlyQuota').value = tr.getAttribute('data-monthlyquota') || '';
            byId('maxRefinements').value = tr.getAttribute('data-maxrefinements') || '';
            byId('description').value = tr.getAttribute('data-description') || '';
            byId('monthlyDisplayLabel').value = tr.getAttribute('data-monthlydisplaylabel') || '';
            byId('annualEnabled').checked = (tr.getAttribute('data-annualenabled') || 'true') === 'true';
            byId('annualPriceCents').value = tr.getAttribute('data-annualpricecents') || '';
            byId('annualQuota').value = tr.getAttribute('data-annualquota') || '';
            byId('annualMaxRefinements').value = tr.getAttribute('data-annualmaxrefinements') || '';
            byId('annualDescription').value = tr.getAttribute('data-annualdescription') || '';
            byId('annualDisplayLabel').value = tr.getAttribute('data-annualdisplaylabel') || '';
            const msg = byId('msg');
            if(msg) msg.textContent = 'Editando plano: ' + (tr.getAttribute('data-code')||'');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }catch(e){
            console.error(e);
          }
        }

        async function toggle(code, active){
          const r = await fetch('/admin/plans/'+encodeURIComponent(code)+'/active', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({active}) });
          const j = await r.json().catch(()=>({}));
          byId('msg').textContent = JSON.stringify(j, null, 2);
          if(j.ok) setTimeout(()=>location.reload(), 250);
        }
      </script>
    `;

    const html = layoutBase({ title: "Planos", activePath: "/admin/plans", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });


  router.post("/plans", async (req, res) => {
    try {
      const input = req.body || {};
      const plan = await upsertPlan(input);
      await safeRecordAdminAudit(req, {
        module: "plans",
        action: "UPSERT_PLAN",
        targetId: String(plan?.code || "").trim(),
        targetLabel: String(plan?.name || "").trim(),
        summary: `Criou ou atualizou o plano ${String(plan?.code || "").trim()}.`,
        after: plan,
        meta: { code: String(plan?.code || "").trim() },
      });
      return res.json({ ok: true, plan });
    } catch (err) {
      return res.status(400).json({ ok: false, error: err.message });
    }
  });


router.get("/coupons", async (req, res) => {
  const [coupons, plans] = await Promise.all([
    listCoupons({ includeInactive: true, includeDeleted: false }).catch(() => []),
    listPlans({ includeInactive: true }).catch(() => []),
  ]);

  const planOptions = (Array.isArray(plans) ? plans : [])
    .map((plan) => {
      const code = escapeHtml(String(plan?.code || "").trim().toUpperCase());
      const name = escapeHtml(String(plan?.name || "").trim());
      return `<option value="${code}">${code}${name ? " · " + name : ""}</option>`;
    })
    .join("");

  const rows = (Array.isArray(coupons) ? coupons : [])
    .map((coupon) => {
      const code = escapeHtml(String(coupon?.couponCode || "").trim().toUpperCase());
      const name = escapeHtml(String(coupon?.name || "").trim());
      const description = escapeHtml(String(coupon?.description || "").trim());
      const active = Boolean(coupon?.active);
      const rawDiscountType = String(coupon?.discountType || "").trim();
      const discountType = escapeHtml(rawDiscountType);
      const normalizedDiscountValue = rawDiscountType === "percent"
        ? Number(coupon?.discountPercent ?? coupon?.discountValue ?? 0)
        : Number(coupon?.discountAmountCents ?? coupon?.discountValue ?? 0);
      const normalizedDiscountCap = Number(coupon?.discountCapCents ?? coupon?.discountCap ?? 0);
      const discountValue = escapeHtml(String(normalizedDiscountValue || 0));
      const discountCap = escapeHtml(String(normalizedDiscountCap || 0));
      const planCodes = escapeHtml((Array.isArray(coupon?.eligiblePlanCodes) ? coupon.eligiblePlanCodes : []).join(", "));
      const billingCycles = escapeHtml((Array.isArray(coupon?.eligibleBillingCycles) ? coupon.eligibleBillingCycles : []).join(", "));
      const validFrom = coupon?.validFrom ? formatDateTimeLabel(coupon.validFrom) : "";
      const validUntil = coupon?.validUntil ? formatDateTimeLabel(coupon.validUntil) : "";
      const maxUsesTotal = escapeHtml(String(coupon?.maxUsesTotal || 0));
      const maxUsesPerUser = escapeHtml(String(coupon?.maxUsesPerUser || 0));
      const firstPurchaseOnly = coupon?.firstPurchaseOnly ? "yes" : "no";
      const onlyWithoutActivePlan = coupon?.onlyWithoutActivePlan ? "yes" : "no";
      const appliesTo = escapeHtml(String(coupon?.appliesTo || "first_charge_only"));
      return `<tr
        data-coupon-code="${code}"
        data-name="${name}"
        data-description="${description}"
        data-active="${active ? "1" : "0"}"
        data-discount-type="${discountType}"
        data-discount-value="${discountValue}"
        data-discount-cap="${discountCap}"
        data-plan-codes="${planCodes}"
        data-billing-cycles="${billingCycles}"
        data-valid-from="${escapeHtml(String(coupon?.validFrom || ""))}"
        data-valid-until="${escapeHtml(String(coupon?.validUntil || ""))}"
        data-max-uses-total="${maxUsesTotal}"
        data-max-uses-per-user="${maxUsesPerUser}"
        data-first-purchase-only="${coupon?.firstPurchaseOnly ? "1" : "0"}"
        data-only-without-active-plan="${coupon?.onlyWithoutActivePlan ? "1" : "0"}"
        data-applies-to="${appliesTo}"
      >
        <td><code>${code}</code></td>
        <td>${name}</td>
        <td>${active ? "✅" : "❌"}</td>
        <td>${escapeHtml(formatCouponDiscount(coupon))}</td>
        <td>${escapeHtml(formatCouponCycles(coupon?.eligibleBillingCycles))}</td>
        <td>${escapeHtml(formatCouponPlans(coupon?.eligiblePlanCodes))}</td>
        <td>${escapeHtml(firstPurchaseOnly)}</td>
        <td>${escapeHtml(onlyWithoutActivePlan)}</td>
        <td>${escapeHtml(appliesTo)}</td>
        <td>${escapeHtml(validFrom)}${validFrom && validUntil ? " → " : ""}${escapeHtml(validUntil)}</td>
        <td>
          <button type="button" onclick="loadCouponRow(this)">Editar</button>
          <button type="button" onclick="toggleCoupon('${code}', ${active ? "false" : "true"})">${active ? "Desativar" : "Ativar"}</button>
          <button type="button" class="danger" onclick="removeCoupon('${code}')">Excluir</button>
        </td>
      </tr>`;
    })
    .join("");

  const inner = `
    <div class="card pad">
      <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
        <div>
          <h3 style="margin:0 0 6px 0;">🏷️ Cupons</h3>
          <div class="muted">Cadastro, atualização, ativação, inativação e exclusão lógica dos cupons do produto.</div>
        </div>
        <div class="row">
          <a class="pill" href="/admin/coupon-report-ui">Relatório de Cupons</a>
          <a class="pill" href="/admin/reports-ui">Central de Relatórios</a>
        </div>
      </div>

      <div class="hr"></div>

      <div class="grid cols2">
        <div>
          <label class="muted">Código do cupom</label>
          <input id="couponCode" placeholder="Ex.: BEMVINDO10" style="width:100%;" />
        </div>
        <div>
          <label class="muted">Nome interno</label>
          <input id="couponName" placeholder="Ex.: Campanha Boas-vindas" style="width:100%;" />
        </div>
        <div style="grid-column:1 / -1;">
          <label class="muted">Descrição interna</label>
          <textarea id="couponDescription" style="min-height:90px;"></textarea>
        </div>

        <div>
          <label class="muted">Tipo de desconto</label>
          <select id="couponDiscountType" style="width:100%;">
            <option value="percent">Percentual</option>
            <option value="fixed">Valor fixo</option>
          </select>
        </div>
        <div>
          <label class="muted">Valor do desconto</label>
          <input id="couponDiscountValue" type="number" min="0" step="1" placeholder="Ex.: 10 ou 2000" style="width:100%;" />
        </div>
        <div>
          <label class="muted">Teto do desconto (centavos, opcional)</label>
          <input id="couponDiscountCap" type="number" min="0" step="1" placeholder="Ex.: 5000" style="width:100%;" />
        </div>
        <div>
          <label class="muted">Aplicação do desconto</label>
          <select id="couponAppliesTo" style="width:100%;">
            <option value="first_charge_only">Apenas na primeira cobrança</option>
            <option value="entire_subscription">Em toda a assinatura</option>
          </select>
        </div>

        <div style="grid-column:1 / -1;">
          <label class="muted">Planos elegíveis (múltipla seleção + campo livre)</label>
          <div class="row" style="align-items:flex-start;">
            <select id="couponPlanOptions" multiple size="6" style="min-width:280px; flex:1;">${planOptions}</select>
            <textarea id="couponEligiblePlanCodes" placeholder="Opcional: informe códigos separados por vírgula, ponto e vírgula ou nova linha." style="min-height:120px; flex:1;"></textarea>
          </div>
        </div>

        <div style="grid-column:1 / -1;">
          <label class="muted">Ciclos elegíveis</label>
          <div class="row">
            <label class="pill"><input id="couponCycleMonthly" type="checkbox" value="monthly" /> Mensal</label>
            <label class="pill"><input id="couponCycleAnnual" type="checkbox" value="annual" /> Anual</label>
          </div>
        </div>

        <div>
          <label class="muted">Válido a partir de (ISO ou data/hora do navegador)</label>
          <input id="couponValidFrom" type="datetime-local" style="width:100%;" />
        </div>
        <div>
          <label class="muted">Válido até</label>
          <input id="couponValidUntil" type="datetime-local" style="width:100%;" />
        </div>
        <div>
          <label class="muted">Limite total de usos</label>
          <input id="couponMaxUsesTotal" type="number" min="0" step="1" placeholder="0 = sem limite" style="width:100%;" />
        </div>
        <div>
          <label class="muted">Limite de usos por usuário</label>
          <input id="couponMaxUsesPerUser" type="number" min="0" step="1" placeholder="0 = sem limite" style="width:100%;" />
        </div>

        <div style="grid-column:1 / -1;">
          <div class="row">
            <label class="pill"><input id="couponActive" type="checkbox" checked /> Ativo</label>
            <label class="pill"><input id="couponFirstPurchaseOnly" type="checkbox" /> Somente primeira contratação</label>
            <label class="pill"><input id="couponOnlyWithoutActivePlan" type="checkbox" /> Somente sem plano ativo</label>
          </div>
        </div>
      </div>

      <div class="hr"></div>

      <div class="row">
        <button type="button" class="primary" onclick="saveCoupon()">Criar / Atualizar</button>
        <button type="button" onclick="resetCouponForm()">Limpar formulário</button>
      </div>

      <div class="hr"></div>

      <div style="overflow:auto;">
        <table>
          <thead>
            <tr>
              <th>Código</th>
              <th>Nome</th>
              <th>Ativo</th>
              <th>Desconto</th>
              <th>Ciclos</th>
              <th>Planos</th>
              <th>1ª contratação</th>
              <th>Sem plano ativo</th>
              <th>Aplicação</th>
              <th>Validade</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="11" class="muted">Nenhum cupom cadastrado.</td></tr>'}</tbody>
        </table>
      </div>

      <div class="hr"></div>
      <details>
        <summary class="muted">Resposta da API</summary>
        <pre id="couponMsg" style="white-space:pre-wrap;"></pre>
      </details>
    </div>

    <script>
      function q(id){ return document.getElementById(id); }
      function toLocalDateTimeInputValue(value){
        const raw = String(value || '').trim();
        if(!raw) return '';
        const dt = new Date(raw);
        if(Number.isNaN(dt.getTime())) return '';
        const yyyy = dt.getFullYear();
        const mm = String(dt.getMonth()+1).padStart(2,'0');
        const dd = String(dt.getDate()).padStart(2,'0');
        const hh = String(dt.getHours()).padStart(2,'0');
        const mi = String(dt.getMinutes()).padStart(2,'0');
        return \`\${yyyy}-\${mm}-\${dd}T\${hh}:\${mi}\`;
      }
      function readSelectedPlanCodes(){
        const values = new Set();
        const textareaValues = String(q('couponEligiblePlanCodes').value || '')
          .split(/[\\r\\n,;]+/)
          .map((item)=>String(item || '').trim().toUpperCase())
          .filter(Boolean);
        textareaValues.forEach((v)=>values.add(v));

        const selected = Array.from(q('couponPlanOptions').selectedOptions || [])
          .map((opt)=>String(opt.value || '').trim().toUpperCase())
          .filter(Boolean);
        selected.forEach((v)=>values.add(v));
        return Array.from(values);
      }
      function writeSelectedPlanCodes(list){
        const values = Array.isArray(list) ? list.map((item)=>String(item || '').trim().toUpperCase()).filter(Boolean) : [];
        q('couponEligiblePlanCodes').value = values.join(', ');
        Array.from(q('couponPlanOptions').options || []).forEach((opt)=>{
          opt.selected = values.includes(String(opt.value || '').trim().toUpperCase());
        });
      }
      function readEligibleCycles(){
        const out = [];
        if(q('couponCycleMonthly').checked) out.push('monthly');
        if(q('couponCycleAnnual').checked) out.push('annual');
        return out;
      }
      function writeEligibleCycles(list){
        const values = Array.isArray(list) ? list : [];
        q('couponCycleMonthly').checked = values.includes('monthly');
        q('couponCycleAnnual').checked = values.includes('annual');
      }
      function resetCouponForm(){
        q('couponCode').value = '';
        q('couponName').value = '';
        q('couponDescription').value = '';
        q('couponDiscountType').value = 'percent';
        q('couponDiscountValue').value = '';
        q('couponDiscountCap').value = '';
        q('couponAppliesTo').value = 'first_charge_only';
        q('couponValidFrom').value = '';
        q('couponValidUntil').value = '';
        q('couponMaxUsesTotal').value = '';
        q('couponMaxUsesPerUser').value = '';
        q('couponActive').checked = true;
        q('couponFirstPurchaseOnly').checked = false;
        q('couponOnlyWithoutActivePlan').checked = false;
        writeEligibleCycles([]);
        writeSelectedPlanCodes([]);
        q('couponMsg').textContent = '';
      }
      function loadCouponRow(btn){
        const tr = btn.closest('tr');
        if(!tr) return;
        q('couponCode').value = tr.dataset.couponCode || '';
        q('couponName').value = tr.dataset.name || '';
        q('couponDescription').value = tr.dataset.description || '';
        q('couponDiscountType').value = tr.dataset.discountType || 'percent';
        q('couponDiscountValue').value = tr.dataset.discountValue || '';
        q('couponDiscountCap').value = tr.dataset.discountCap || '';
        q('couponAppliesTo').value = tr.dataset.appliesTo || 'first_charge_only';
        q('couponValidFrom').value = toLocalDateTimeInputValue(tr.dataset.validFrom || '');
        q('couponValidUntil').value = toLocalDateTimeInputValue(tr.dataset.validUntil || '');
        q('couponMaxUsesTotal').value = tr.dataset.maxUsesTotal || '';
        q('couponMaxUsesPerUser').value = tr.dataset.maxUsesPerUser || '';
        q('couponActive').checked = String(tr.dataset.active || '') === '1';
        q('couponFirstPurchaseOnly').checked = String(tr.dataset.firstPurchaseOnly || '') === '1';
        q('couponOnlyWithoutActivePlan').checked = String(tr.dataset.onlyWithoutActivePlan || '') === '1';
        writeEligibleCycles(String(tr.dataset.billingCycles || '').split(',').map((item)=>item.trim()).filter(Boolean));
        writeSelectedPlanCodes(String(tr.dataset.planCodes || '').split(',').map((item)=>item.trim()).filter(Boolean));
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      async function saveCoupon(){
        const body = {
          couponCode: String(q('couponCode').value || '').trim().toUpperCase(),
          name: String(q('couponName').value || '').trim(),
          description: String(q('couponDescription').value || '').trim(),
          active: !!q('couponActive').checked,
          discountType: String(q('couponDiscountType').value || 'percent').trim(),
          discountValue: Number(q('couponDiscountValue').value || 0),
          discountCap: Number(q('couponDiscountCap').value || 0),
          eligiblePlanCodes: readSelectedPlanCodes(),
          eligibleBillingCycles: readEligibleCycles(),
          validFrom: q('couponValidFrom').value || '',
          validUntil: q('couponValidUntil').value || '',
          maxUsesTotal: Number(q('couponMaxUsesTotal').value || 0),
          maxUsesPerUser: Number(q('couponMaxUsesPerUser').value || 0),
          firstPurchaseOnly: !!q('couponFirstPurchaseOnly').checked,
          onlyWithoutActivePlan: !!q('couponOnlyWithoutActivePlan').checked,
          appliesTo: String(q('couponAppliesTo').value || 'first_charge_only').trim(),
        };
        const r = await fetch('/admin/coupons', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(()=>({ ok:false, error:'Falha ao ler resposta' }));
        q('couponMsg').textContent = JSON.stringify(j, null, 2);
        if(j && j.ok) window.location.reload();
      }
      async function toggleCoupon(code, active){
        const r = await fetch('/admin/coupons/' + encodeURIComponent(code) + '/active', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: !!active }),
        });
        const j = await r.json().catch(()=>({ ok:false, error:'Falha ao ler resposta' }));
        q('couponMsg').textContent = JSON.stringify(j, null, 2);
        if(j && j.ok) window.location.reload();
      }
      async function removeCoupon(code){
        if(!confirm('Tem certeza que deseja excluir logicamente o cupom ' + code + '?')) return;
        const r = await fetch('/admin/coupons/' + encodeURIComponent(code) + '/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const j = await r.json().catch(()=>({ ok:false, error:'Falha ao ler resposta' }));
        q('couponMsg').textContent = JSON.stringify(j, null, 2);
        if(j && j.ok) window.location.reload();
      }
    </script>
  `;

  const html = layoutBase({ title: "Cupons", activePath: "/admin/coupons", content: inner });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html);
});

router.post("/coupons", async (req, res) => {
  try {
    const input = buildCouponFormInput(req.body || {});
    if (!input.couponCode) {
      return res.status(400).json({ ok: false, error: "couponCode required" });
    }
    const before = await getCoupon(input.couponCode).catch(() => null);
    const coupon = await upsertCoupon(input);
    await safeRecordAdminAudit(req, {
      module: "coupons",
      action: before ? "UPSERT_COUPON" : "CREATE_COUPON",
      targetId: String(coupon?.couponCode || input.couponCode || "").trim(),
      targetLabel: String(coupon?.name || "").trim(),
      summary: before
        ? `Atualizou o cupom ${String(coupon?.couponCode || input.couponCode || "").trim()}.`
        : `Criou o cupom ${String(coupon?.couponCode || input.couponCode || "").trim()}.`,
      before: before || {},
      after: coupon,
      meta: { couponCode: String(coupon?.couponCode || input.couponCode || "").trim() },
    });
    return res.json({ ok: true, coupon });
  } catch (err) {
    return res.status(400).json({ ok: false, error: String(err?.message || err) });
  }
});

router.post("/coupons/:code/active", async (req, res) => {
  try {
    const code = normalizeAdminCouponCode(req.params.code);
    const active = normalizeAdminBool(req.body?.active, true);
    const before = await getCoupon(code).catch(() => null);
    const coupon = await setCouponActive(code, active);
    await safeRecordAdminAudit(req, {
      module: "coupons",
      action: "SET_COUPON_ACTIVE",
      targetId: String(coupon?.couponCode || code || "").trim(),
      targetLabel: String(coupon?.name || "").trim(),
      summary: `${active ? "Ativou" : "Desativou"} o cupom ${String(coupon?.couponCode || code || "").trim()}.`,
      before: before || {},
      after: coupon,
      meta: { active },
    });
    return res.json({ ok: true, coupon });
  } catch (err) {
    return res.status(400).json({ ok: false, error: String(err?.message || err) });
  }
});

router.post("/coupons/:code/delete", async (req, res) => {
  try {
    const code = normalizeAdminCouponCode(req.params.code);
    const before = await getCoupon(code).catch(() => null);
    const coupon = await deleteCoupon(code);
    await safeRecordAdminAudit(req, {
      module: "coupons",
      action: "DELETE_COUPON",
      targetId: String(coupon?.couponCode || code || "").trim(),
      targetLabel: String(coupon?.name || "").trim(),
      summary: `Removeu logicamente o cupom ${String(coupon?.couponCode || code || "").trim()}.`,
      before: before || {},
      after: coupon || {},
      meta: { deleted: true },
    });
    return res.json({ ok: true, coupon });
  } catch (err) {
    return res.status(400).json({ ok: false, error: String(err?.message || err) });
  }
});

// -----------------------------
// ✅ Health Planos
// -----------------------------

  router.get("/health-plans", async (req, res) => {
    const h = await getPlansHealth({ includeInactive: true });
    return res.json({ ok: true, health: h });
  });

  // -----------------------------
  // ✅ Alertas do Sistema (UI + APIs)
  // -----------------------------
  router.get("/alerts-count", async (req, res) => {
    const count = await getSystemAlertsCount();
    return res.json({ ok: true, count });
  });

  router.get("/alerts", async (req, res) => {
    try {
      const limit = Number(req.query?.limit || 50);
      const items = await listSystemAlerts(limit);
      const incidents = await listSystemIncidents({ limit });
      const openIncidentsCount = await getOpenIncidentsCount();
      return res.json({
        ok: true,
        count: Array.isArray(items) ? items.length : 0,
        items: Array.isArray(items) ? items : [],
        incidents: Array.isArray(incidents) ? incidents : [],
        openIncidentsCount: Number(openIncidentsCount || 0),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/alerts-ui", async (req, res) => {
    const inner = `
      <div class="card pad" style="margin-bottom:14px;">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">🚨 Alertas</h3>
            <div class="muted">Incidentes operacionais e histórico legado de alertas do sistema.</div>
          </div>
          <div class="row">
            <span id="alertsOpenIncidents" class="badge warn">0 abertos</span>
            <button class="primary" onclick="load()">Atualizar</button>
          </div>
        </div>
      </div>

      <div class="card pad" style="margin-bottom:12px;">
        <div style="font-weight:700; margin-bottom:8px;">Incidentes Redis / operacionais</div>
        <div id="incidentsOut" class="muted">Carregando…</div>
      </div>

      <div class="card pad">
        <div style="font-weight:700; margin-bottom:8px;">Histórico legado de alertas</div>
        <div id="out" class="muted">Carregando…</div>
        <div class="hr"></div>
        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="raw" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <script>
        function esc(s){
          return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
        }
        function sevBadge(v){
          const n = String(v||'').toUpperCase();
          const cls = n === 'CRITICAL' ? 'danger' : (n === 'HIGH' ? 'warn' : (n === 'MEDIUM' ? 'info' : 'soft'));
          return '<span class="badge ' + cls + '">' + esc(n || 'LOW') + '</span>';
        }
        async function load(){
          const r = await fetch('/admin/alerts');
          const j = await r.json().catch(()=>({}));
          document.getElementById('raw').textContent = JSON.stringify(j, null, 2);
          document.getElementById('alertsOpenIncidents').textContent = String(Number(j.openIncidentsCount || 0) || 0) + ' abertos';

          const incidents = Array.isArray(j.incidents) ? j.incidents : [];
          document.getElementById('incidentsOut').innerHTML = incidents.length
            ? '<table><thead><tr><th>Severidade</th><th>Status</th><th>Módulo</th><th>Ocorrências</th><th>Último envio</th><th>Canais</th><th>Resumo</th></tr></thead><tbody>' +
              incidents.map(function(it){
                return '<tr>' +
                  '<td>' + sevBadge(it.severity) + '</td>' +
                  '<td><code>' + esc(it.status || '') + '</code></td>' +
                  '<td>' + esc(it.module || it.type || '') + '</td>' +
                  '<td>' + esc(it.occurrences || 0) + '</td>' +
                  '<td><code>' + esc(it.lastNotifiedAt || it.updatedAt || '') + '</code></td>' +
                  '<td>' + esc(Array.isArray(it.notifyChannels) ? it.notifyChannels.join(', ') : '') + '</td>' +
                  '<td style="max-width:420px; white-space:pre-wrap;">' + esc(it.message || it.impact || '') + '</td>' +
                '</tr>';
              }).join('') + '</tbody></table>'
            : '<div class="muted">Nenhum incidente operacional registrado.</div>';

          const items = Array.isArray(j.items) ? j.items : [];
          document.getElementById('out').innerHTML = items.length
            ? '<table><thead><tr><th>Quando</th><th>Evento</th><th>Detalhes</th></tr></thead><tbody>' +
              items.map(function(it){
                return '<tr>' +
                  '<td><code>'+esc(it.ts||'')+'</code></td>' +
                  '<td>'+esc(it.event||'')+'</td>' +
                  '<td style="max-width:640px; white-space:pre-wrap;">'+esc((it.message||'') || JSON.stringify(it.payload||{}))+'</td>' +
                '</tr>';
              }).join('') + '</tbody></table>'
            : '<div class="muted">Nenhum alerta legado registrado.</div>';
        }
        load();
      </script>
    `;
    const html = layoutBase({ title: "Alertas", activePath: "/admin/alerts-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/audit/list", async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 100) || 100));
      const pull = Math.max(limit, Math.min(1500, Number(req.query?.pull || limit * 4) || (limit * 4)));
      const q = String(req.query?.q || "").trim().toLowerCase();
      const moduleFilter = String(req.query?.module || "ALL").trim().toUpperCase();
      const actionFilter = String(req.query?.action || "ALL").trim().toUpperCase();
      const waIdFilter = String(req.query?.waId || "").trim();
      const items = await listAdminAudit({ limit: pull });
      const totalStored = await getAdminAuditCount();

      const modules = Array.from(new Set(items.map((item) => String(item?.module || "").trim()).filter(Boolean))).sort();
      const actions = Array.from(new Set(items.map((item) => String(item?.action || "").trim()).filter(Boolean))).sort();

      const filtered = items.filter((item) => {
        const moduleValue = String(item?.module || "").trim().toUpperCase();
        const actionValue = String(item?.action || "").trim().toUpperCase();
        const waIdValue = String(item?.waId || item?.targetId || "").trim();
        if (moduleFilter !== "ALL" && moduleValue !== moduleFilter) return false;
        if (actionFilter !== "ALL" && actionValue !== actionFilter) return false;
        if (waIdFilter && waIdValue !== waIdFilter) return false;
        if (q) {
          const hay = [
            item?.id,
            item?.module,
            item?.action,
            item?.summary,
            item?.waId,
            item?.targetId,
            item?.targetLabel,
            item?.actor?.user,
          ].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      return res.status(200).json({
        ok: true,
        totalStored,
        pulled: items.length,
        filteredCount: filtered.length,
        modules,
        actions,
        items: filtered.slice(0, limit),
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/audit-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
          <div>
            <h3 style="margin:0 0 6px 0;">📚 Auditoria administrativa</h3>
            <div class="muted">Rastreie alterações feitas no painel: usuário, configurações, planos, textos do bot e ações operacionais.</div>
          </div>
          <div class="row" style="gap:8px;">
            <button type="button" class="primary" id="auditRefreshBtn">Atualizar</button>
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid cols3" style="align-items:end;">
          <div>
            <div class="muted" style="margin-bottom:6px;">Busca</div>
            <input id="auditQ" placeholder="ação, usuário, resumo ou módulo" />
          </div>
          <div>
            <div class="muted" style="margin-bottom:6px;">Módulo</div>
            <select id="auditModule"><option value="ALL">Todos</option></select>
          </div>
          <div>
            <div class="muted" style="margin-bottom:6px;">Ação</div>
            <select id="auditAction"><option value="ALL">Todas</option></select>
          </div>
          <div>
            <div class="muted" style="margin-bottom:6px;">waId</div>
            <input id="auditWaId" placeholder="5511... (opcional)" />
          </div>
          <div>
            <div class="muted" style="margin-bottom:6px;">Itens exibidos</div>
            <input id="auditLimit" type="number" min="20" max="500" value="100" />
          </div>
          <div class="row" style="align-items:center; gap:8px;">
            <button type="button" class="primary" id="auditApplyBtn">Aplicar filtros</button>
            <button type="button" id="auditClearBtn">Limpar</button>
          </div>
        </div>

        <div class="hr"></div>

        <div class="row" style="gap:8px; flex-wrap:wrap;">
          <span class="pill">Eventos salvos: <b id="auditTotalStored">—</b></span>
          <span class="pill">Eventos lidos: <b id="auditPulled">—</b></span>
          <span class="pill">Filtrados: <b id="auditFiltered">—</b></span>
        </div>

        <div class="hr"></div>

        <div id="auditTableWrap" class="muted">Carregando…</div>
      </div>

      <div id="auditModal" style="display:none; position:fixed; inset:0; background:rgba(15,23,42,.45); z-index:60; padding:24px;">
        <div class="card" style="max-width:980px; margin:0 auto; max-height:calc(100vh - 48px); overflow:auto;">
          <div class="pad">
            <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
              <div>
                <h3 style="margin:0 0 6px 0;">Detalhes do evento</h3>
                <div class="muted" id="auditModalSub">—</div>
              </div>
              <button type="button" id="auditModalClose">Fechar</button>
            </div>
            <div class="hr"></div>
            <pre id="auditModalPre" style="white-space:pre-wrap; overflow:auto; max-height:70vh;"></pre>
          </div>
        </div>
      </div>
    `;

    const html = layoutBase({
      title: "Auditoria administrativa",
      activePath: "/admin/audit-ui",
      content: inner,
      scriptExtra: `
        <script>
          (function(){
            const state = { items: [] };
            const els = {
              q: document.getElementById('auditQ'),
              module: document.getElementById('auditModule'),
              action: document.getElementById('auditAction'),
              waId: document.getElementById('auditWaId'),
              limit: document.getElementById('auditLimit'),
              tableWrap: document.getElementById('auditTableWrap'),
              totalStored: document.getElementById('auditTotalStored'),
              pulled: document.getElementById('auditPulled'),
              filtered: document.getElementById('auditFiltered'),
              modal: document.getElementById('auditModal'),
              modalPre: document.getElementById('auditModalPre'),
              modalSub: document.getElementById('auditModalSub'),
            };

            function esc(value){
              return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'", '&#39;');
            }

            function fillSelect(el, values, current){
              if (!el) return;
              const keep = String(current || 'ALL');
              const options = ['<option value="ALL">Todos</option>'];
              (Array.isArray(values) ? values : []).forEach(function(value){
                const v = String(value || '').trim();
                if (!v) return;
                options.push('<option value="' + esc(v) + '"' + (v === keep ? ' selected' : '') + '>' + esc(v) + '</option>');
              });
              el.innerHTML = options.join('');
            }

            function readFilters(){
              return {
                q: String(els.q?.value || '').trim(),
                module: String(els.module?.value || 'ALL').trim(),
                action: String(els.action?.value || 'ALL').trim(),
                waId: String(els.waId?.value || '').trim(),
                limit: String(els.limit?.value || '100').trim(),
              };
            }

            function buildQuery(){
              const params = new URLSearchParams();
              const filters = readFilters();
              Object.keys(filters).forEach(function(key){
                const value = filters[key];
                if (key === 'limit') { params.set('limit', value || '100'); return; }
                if (value && value !== 'ALL') params.set(key, value);
              });
              return params.toString();
            }

            async function fetchJson(url){
              const response = await fetch(url);
              const json = await response.json().catch(() => ({}));
              return { response, json };
            }

            function openModal(item){
              els.modalPre.textContent = JSON.stringify(item || {}, null, 2);
              els.modalSub.textContent = [item?.ts, item?.module, item?.action].filter(Boolean).join(' • ') || '—';
              els.modal.style.display = 'block';
            }

            function closeModal(){
              els.modal.style.display = 'none';
            }

            function renderTable(items){
              if (!Array.isArray(items) || !items.length) {
                els.tableWrap.innerHTML = '<div class="muted">Nenhum evento encontrado.</div>';
                return;
              }
              const rows = items.map(function(item, index){
                const actor = item?.actor?.user || 'admin';
                const target = item?.waId || item?.targetId || item?.targetLabel || '—';
                const summary = item?.summary || '—';
                return '<tr>' +
                  '<td><code>' + esc(item?.ts || '') + '</code></td>' +
                  '<td>' + esc(item?.module || '') + '</td>' +
                  '<td>' + esc(item?.action || '') + '</td>' +
                  '<td><code>' + esc(target) + '</code></td>' +
                  '<td style="max-width:420px; white-space:pre-wrap;">' + esc(summary) + '</td>' +
                  '<td>' + esc(actor) + '</td>' +
                  '<td><button type="button" data-action="open-audit" data-index="' + index + '">Ver detalhes</button></td>' +
                '</tr>';
              }).join('');
              els.tableWrap.innerHTML = '<div style="overflow:auto;"><table style="min-width:980px;"><thead><tr><th>Quando</th><th>Módulo</th><th>Ação</th><th>Alvo</th><th>Resumo</th><th>Responsável</th><th>Ação</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
            }

            async function loadAudit(){
              els.tableWrap.innerHTML = '<div class="muted">Carregando…</div>';
              const query = buildQuery();
              const { response, json } = await fetchJson('/admin/audit/list?' + query);
              if (!response.ok || !json.ok) {
                els.tableWrap.innerHTML = '<div class="muted">Erro ao carregar auditoria.</div>';
                return;
              }
              state.items = Array.isArray(json.items) ? json.items : [];
              els.totalStored.textContent = String(json.totalStored || 0);
              els.pulled.textContent = String(json.pulled || 0);
              els.filtered.textContent = String(json.filteredCount || 0);
              fillSelect(els.module, json.modules || [], readFilters().module);
              fillSelect(els.action, json.actions || [], readFilters().action);
              renderTable(state.items);
            }

            document.getElementById('auditRefreshBtn').addEventListener('click', loadAudit);
            document.getElementById('auditApplyBtn').addEventListener('click', loadAudit);
            document.getElementById('auditClearBtn').addEventListener('click', function(){
              els.q.value = '';
              els.module.value = 'ALL';
              els.action.value = 'ALL';
              els.waId.value = '';
              els.limit.value = '100';
              loadAudit();
            });
            els.tableWrap.addEventListener('click', function(ev){
              const btn = ev.target.closest('[data-action="open-audit"]');
              if (!btn) return;
              const idx = Number(btn.getAttribute('data-index') || -1);
              if (idx < 0 || idx >= state.items.length) return;
              openModal(state.items[idx]);
            });
            document.getElementById('auditModalClose').addEventListener('click', closeModal);
            els.modal.addEventListener('click', function(ev){ if (ev.target === els.modal) closeModal(); });
            document.addEventListener('keydown', function(ev){ if (ev.key === 'Escape' && els.modal.style.display === 'block') closeModal(); });
            document.addEventListener('DOMContentLoaded', loadAudit);
            loadAudit();
          })();
        </script>
      `,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/crm/list", async (req, res) => {
    try {
      const q = String(req.query?.q || "").trim().toLowerCase();
      const statusFilter = String(req.query?.status || "ALL").trim().toUpperCase();
      const planFilter = String(req.query?.plan || "ALL").trim().toUpperCase();
      const paymentFilter = String(req.query?.paymentMethod || "ALL").trim().toUpperCase();
      const hasName = String(req.query?.hasName || "ALL").trim().toUpperCase();
      const hasSubscription = String(req.query?.hasSubscription || "ALL").trim().toUpperCase();
      const hasBizProfile = String(req.query?.hasBizProfile || "ALL").trim().toUpperCase();
      const hasInconsistency = String(req.query?.hasInconsistency || "ALL").trim().toUpperCase();
      const inWindowFilter = String(req.query?.inWindow || "ALL").trim().toUpperCase();
      const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 200) || 200));

      const usersRaw = await listUsers();
      const waIds = Array.isArray(usersRaw) ? usersRaw.slice().sort() : [];
      const plans = await listPlans({ includeInactive: true });
      const planMap = buildPlanMap(plans);
      const now = nowMs();

      const enriched = await mapLimit(waIds, 20, async (waId) => enrichUserForCrm(waId, planMap, now));
      const validItems = Array.isArray(enriched) ? enriched.filter((item) => item && !item.__error) : [];
      const statusSummary = getCrmStatusCounters();

      for (const item of validItems) {
        const st = String(item?.status || "").trim().toUpperCase() || "UNKNOWN";
        if (statusSummary[st] === undefined) statusSummary.UNKNOWN++;
        else statusSummary[st]++;
      }

      const filtered = validItems.filter((item) => {
        if (!item) return false;
        if (q) {
          const hay = [item.waId, item.fullName, item.plan, item.planName, item.billingCityState].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (statusFilter !== "ALL" && String(item.status || "").toUpperCase() !== statusFilter) return false;
        if (planFilter !== "ALL" && String(item.plan || "").toUpperCase() !== planFilter) return false;
        if (paymentFilter !== "ALL" && String(item.paymentMethod || "").toUpperCase() !== paymentFilter) return false;
        if (hasName === "YES" && !String(item.fullName || "").trim()) return false;
        if (hasName === "NO" && String(item.fullName || "").trim()) return false;
        if (hasSubscription === "YES" && !String(item.asaasSubscriptionId || "").trim()) return false;
        if (hasSubscription === "NO" && String(item.asaasSubscriptionId || "").trim()) return false;
        if (hasBizProfile === "YES" && !item.hasBizProfile) return false;
        if (hasBizProfile === "NO" && item.hasBizProfile) return false;
        if (hasInconsistency === "YES" && !(Number(item.issueCount || 0) > 0)) return false;
        if (hasInconsistency === "NO" && Number(item.issueCount || 0) > 0) return false;
        if (inWindowFilter === "YES" && !item.inWindow) return false;
        if (inWindowFilter === "NO" && item.inWindow) return false;
        return true;
      });

      const planCodes = Array.from(new Set(validItems.map((item) => String(item.plan || "").trim().toUpperCase()).filter(Boolean))).sort();

      return res.status(200).json({
        ok: true,
        totalUsers: waIds.length,
        filteredCount: filtered.length,
        limit,
        availablePlans: planCodes,
        statusSummary,
        items: filtered.slice(0, limit),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  router.get("/crm/user", async (req, res) => {
    try {
      const rawRef = String(req.query?.userId || req.query?.waId || "").trim();
      if (!rawRef) return res.status(400).json({ ok: false, error: "userId or waId required" });

      const userId = await resolveAdminUserRef(rawRef);
      const plans = await listPlans({ includeInactive: true });
      const planMap = buildPlanMap(plans);
      const user = await enrichUserForCrm(userId, planMap, nowMs());
      const editable = typeof getUserAdminEditableFields === "function"
        ? await getUserAdminEditableFields(userId).catch(() => null)
        : null;
      return res.status(200).json({
        ok: true,
        user: {
          ...user,
          editableFields: editable || null,
        },
        availablePlans: buildCrmEditablePlanOptions(plans),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  router.post("/crm/user/update", async (req, res) => {
    try {
      const session = getAdminRequestSession(req);
      if (!adminHasPermission(session, "users.edit") && !adminHasPermission(session, "users.manage")) {
        return res.status(403).json({ ok: false, error: "forbidden", requiredPermission: "users.edit" });
      }

      const actor = getAdminActor(req);
      const identity = await resolveAdminEditableUserRef({
        internalUserId: req.body?.internalUserId,
        userId: req.body?.userId,
        waId: req.body?.waId,
      });

      if (!identity?.ok || !identity?.internalUserId) {
        return res.status(400).json({
          ok: false,
          error: identity?.errorCode || "admin_user_ref_not_resolved",
          message: identity?.message || "Não foi possível resolver o usuário para edição administrativa.",
          identity,
        });
      }

      const internalUserId = String(identity.internalUserId || "").trim();
      const rawPatch = req.body?.patch && typeof req.body.patch === "object" ? req.body.patch : req.body || {};
      const picked = pickCrmUserAdminPatch(rawPatch);
      const plans = await listPlans({ includeInactive: true });
      const planMap = buildPlanMap(plans);
      const localValidationErrors = validateCrmUserAdminPatch(picked.patch, planMap);
      if (localValidationErrors.length) {
        return res.status(400).json({
          ok: false,
          error: "invalid_user_edit_patch",
          validationErrors: localValidationErrors,
          rejectedFields: picked.rejectedFields,
        });
      }

      const planValidation = await validateCrmAdminPlanFieldsWithCatalog(picked.patch);
      if (planValidation.errors.length) {
        return res.status(400).json({
          ok: false,
          error: "invalid_user_plan_patch",
          validationErrors: planValidation.errors,
          rejectedFields: [...picked.rejectedFields, ...planValidation.errors],
          identity,
        });
      }

      let finalPatch = planValidation.patch;
      let rejectedFields = [...picked.rejectedFields, ...planValidation.warnings];
      if (identity.blockSensitiveOps) {
        const stripped = stripConflictBlockedFinancialFields(finalPatch, rejectedFields);
        finalPatch = stripped.patch;
        rejectedFields = stripped.rejectedFields;
      }

      const beforeSnapshot = await getUserSnapshot(internalUserId);
      const predictedSnapshot = mergeUserSnapshotForAdminPricing(beforeSnapshot, finalPatch);
      const pricingViewBefore = await getAdminUserEffectivePricingView(beforeSnapshot, { source: "admin_crm_user_update_before" }).catch((error) => ({
        ok: false,
        valid: false,
        source: "admin_crm_user_update_before",
        warnings: [{ code: "pricing_view_before_failed", message: String(error?.message || error), severity: "warn" }],
      }));
      const pricingView = await getAdminUserEffectivePricingView(predictedSnapshot, { source: "admin_crm_user_update_after" }).catch((error) => ({
        ok: false,
        valid: false,
        source: "admin_crm_user_update_after",
        warnings: [{ code: "pricing_view_after_failed", message: String(error?.message || error), severity: "warn" }],
      }));
      const asaasImpact = getAdminSubscriptionImpact(beforeSnapshot, finalPatch);
      const webhookWarnings = getAsaasWebhookAdminCoherenceWarnings(beforeSnapshot, finalPatch);

      const result = await updateUserAdminFields(internalUserId, finalPatch, {
        source: "admin_crm_user_update",
        actor,
      });

      const afterSnapshot = await getUserSnapshot(internalUserId);
      const changedFields = Array.isArray(result?.changedFields) ? result.changedFields : [];
      rejectedFields = [
        ...rejectedFields,
        ...(Array.isArray(result?.rejectedFields) ? result.rejectedFields : []),
      ];

      const auditBefore = buildCrmUserEditAuditSnapshot(result?.before || beforeSnapshot || {});
      const auditAfter = buildCrmUserEditAuditSnapshot(result?.after || afterSnapshot || {});
      await logUserAdminEditAudit({
        module: "crm_user_edit",
        action: "update_user_admin_fields",
        internalUserId,
        userId: internalUserId,
        waId: String(identity.waId || afterSnapshot?.waId || beforeSnapshot?.waId || ""),
        targetId: internalUserId,
        targetLabel: String(afterSnapshot?.fullName || afterSnapshot?.waId || identity.waId || internalUserId),
        summary: `Edição administrativa de usuário: ${changedFields.length} campo(s) alterado(s).`,
        actor,
        before: auditBefore,
        after: auditAfter,
        changedFields,
        rejectedFields: rejectedFields.map(formatRejectedFieldForAudit),
        meta: {
          source: "admin_crm_user_update",
          pricingViewBefore: summarizeAdminPricingViewForAudit(pricingViewBefore),
          pricingView: summarizeAdminPricingViewForAudit(pricingView),
          asaasImpact: summarizeAdminAsaasImpactForAudit(asaasImpact),
          webhookWarnings: summarizeAdminWebhookWarningsForAudit(webhookWarnings),
          identityStatus: {
            conflict: Boolean(identity.conflict),
            conflictId: String(identity.conflictId || ""),
            conflictStatus: String(identity.conflictStatus || ""),
            blockSensitiveOps: Boolean(identity.blockSensitiveOps),
            allowProfileEdit: identity.allowProfileEdit !== false,
            source: String(identity.source || ""),
          },
        },
      });

      const ledgerFinancialFields = getChangedLedgerFinancialFields(changedFields);
      let ledgerReference = null;
      if (ledgerFinancialFields.length) {
        ledgerReference = await recordAdminUserFinancialFieldChanged({
          userId: internalUserId,
          waId: String(identity.waId || afterSnapshot?.waId || beforeSnapshot?.waId || ""),
          actor,
          changedFields: ledgerFinancialFields,
          before: pickFinancialSnapshotForLedger(beforeSnapshot),
          after: pickFinancialSnapshotForLedger(afterSnapshot),
          summary: "Alteração administrativa de campo financeiro do usuário.",
          meta: {
            source: "admin_crm_user_update",
            doesNotRepresentPayment: true,
            doesNotChangeSubscription: true,
            requiresManualAsaasReview: Boolean(asaasImpact?.impact?.requiresManualFinancialAction || asaasImpact?.impact?.requiresAsaasReview),
          },
        }).catch((error) => ({ ok: false, error: String(error?.message || error) }));
      }

      return res.status(200).json({
        ok: true,
        userId: internalUserId,
        internalUserId,
        changedFields,
        rejectedFields,
        snapshot: afterSnapshot,
        pricingView,
        asaasImpact,
        webhookWarnings,
        identity: {
          ok: Boolean(identity.ok),
          internalUserId,
          waId: identity.waId || null,
          source: identity.source || "",
          conflict: Boolean(identity.conflict),
          conflictId: String(identity.conflictId || ""),
          conflictStatus: String(identity.conflictStatus || ""),
          blockSensitiveOps: Boolean(identity.blockSensitiveOps),
          allowProfileEdit: identity.allowProfileEdit !== false,
          message: String(identity.message || ""),
        },
        ledgerReference,
      });
    } catch (e) {
      return res.status(e?.statusCode || 500).json({ ok: false, error: String(e?.message || e) });
    }
  });


  router.get("/bulk/list", async (req, res) => {
    try {
      const q = String(req.query?.q || "").trim().toLowerCase();
      const statusFilter = String(req.query?.status || "ALL").trim().toUpperCase();
      const planFilter = String(req.query?.plan || "ALL").trim().toUpperCase();
      const limit = Math.max(1, Math.min(500, Number(req.query?.limit || 200) || 200));

      const usersRaw = await listUsers();
      const waIds = Array.isArray(usersRaw) ? usersRaw.slice().sort() : [];
      const plans = await listPlans({ includeInactive: true });
      const planMap = buildPlanMap(plans);
      const now = nowMs();
      const enriched = await mapLimit(waIds, 20, async (waId) => enrichUserForCrm(waId, planMap, now));
      const validItems = Array.isArray(enriched) ? enriched.filter((item) => item && !item.__error) : [];

      const filtered = validItems.filter((item) => {
        if (!item) return false;
        if (q) {
          const hay = [item.waId, item.fullName, item.plan, item.planName, item.billingCityState, item.paymentMethod].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        if (statusFilter !== "ALL" && String(item.status || "").toUpperCase() !== statusFilter) return false;
        if (planFilter !== "ALL" && String(item.plan || "").toUpperCase() !== planFilter) return false;
        return true;
      });

      const availablePlans = Array.from(new Set((Array.isArray(plans) ? plans : []).map((plan) => String(plan?.code || "").trim().toUpperCase()).filter(Boolean))).sort();

      return res.status(200).json({
        ok: true,
        totalUsers: waIds.length,
        filteredCount: filtered.length,
        availablePlans,
        limit,
        items: filtered.slice(0, limit),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  router.post("/bulk/apply", async (req, res) => {
    try {
      const operation = String(req.body?.operation || "").trim().toUpperCase();
      const waIdsRaw = Array.isArray(req.body?.waIds) ? req.body.waIds : [];
      const userIds = Array.from(new Set((await Promise.all(
        waIdsRaw.map((value) => resolveAdminUserRef(String(value || "").trim()))
      )).filter(Boolean)));
      const value = String(req.body?.value || "").trim();

      if (!operation) return res.status(400).json({ ok: false, error: "operation required" });
      if (!userIds.length) return res.status(400).json({ ok: false, error: "waIds required" });

      const plans = await listPlans({ includeInactive: true });
      const planMap = buildPlanMap(plans);
      const normalizedPlan = String(value || "").trim().toUpperCase();
      const allowedStatus = new Set(["TRIAL", "ACTIVE", "WAIT_PLAN", "PAYMENT_PENDING", "BLOCKED"]);
      const normalizedStatus = String(value || "").trim().toUpperCase();

      if (operation === "SET_PLAN" && normalizedPlan && !planMap.get(normalizedPlan)) {
        return res.status(400).json({ ok: false, error: "invalid plan" });
      }
      if (operation === "SET_STATUS" && !allowedStatus.has(normalizedStatus)) {
        return res.status(400).json({ ok: false, error: "invalid status" });
      }

      const results = [];

      for (const userId of userIds) {
        try {
          const [beforeUser, identifiers] = await Promise.all([
            getUserSnapshot(userId),
            getUserIdentifiers(userId).catch(() => null),
          ]);
          let summary = "";
          let meta = { operation, userId };

          if (operation === "SET_STATUS") {
            await setUserStatus(userId, normalizedStatus);
            summary = `Alterou o status do usuário ${userId} para ${normalizedStatus}.`;
            meta = { ...meta, status: normalizedStatus };
          } else if (operation === "BLOCK_USERS") {
            await setUserStatus(userId, "BLOCKED");
            summary = `Bloqueou o usuário ${userId}.`;
          } else if (operation === "UNBLOCK_TO_TRIAL") {
            await resetUserToTrial(userId);
            summary = `Desbloqueou o usuário ${userId} retornando para TRIAL.`;
          } else if (operation === "SET_PLAN") {
            await setUserPlan(userId, normalizedPlan);
            summary = `Alterou o plano do usuário ${userId} para ${normalizedPlan}.`;
            meta = { ...meta, plan: normalizedPlan };
          } else if (operation === "CLEAR_PLAN") {
            await setUserPlan(userId, "");
            summary = `Removeu o plano salvo do usuário ${userId}.`;
          } else if (operation === "RESET_TRIAL") {
            await resetUserToTrial(userId);
            summary = `Resetou o usuário ${userId} para o estado de trial.`;
          } else if (operation === "CLEAR_QUOTA") {
            await setUserQuotaUsed(userId, 0);
            summary = `Zerou o uso mensal do usuário ${userId}.`;
          } else if (operation === "CLEAR_TRIAL_USED") {
            await setUserTrialUsed(userId, 0);
            summary = `Zerou o uso de trial do usuário ${userId}.`;
          } else {
            return res.status(400).json({ ok: false, error: "unsupported operation" });
          }

          const afterUser = await getUserSnapshot(userId);
          await safeRecordAdminAudit(req, {
            module: "bulk",
            action: operation,
            waId: identifiers?.waId || beforeUser?.waId || "",
            targetId: userId,
            summary,
            before: buildAuditUserSnapshot(beforeUser),
            after: buildAuditUserSnapshot(afterUser),
            meta,
          });

          results.push({
            ok: true,
            userId,
            waId: identifiers?.waId || afterUser?.waId || "",
            status: String(afterUser?.status || ""),
            plan: String(afterUser?.plan || ""),
          });
        } catch (err) {
          results.push({ ok: false, userId, error: String(err?.message || err) });
        }
      }

      return res.status(200).json({
        ok: true,
        operation,
        count: results.length,
        results,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  router.get("/bulk-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">🧰 Ações em massa</h3>
            <div class="muted">Selecione usuários filtrados e aplique operações em lote com segurança.</div>
          </div>
          <div class="row">
            <a class="pill" href="/admin/crm-ui">CRM</a>
            <a class="pill" href="/admin/users-list-ui">Lista simples</a>
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid cols3">
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Busca</div>
            <input id="bulkQ" placeholder="Nome, waId, plano, cidade ou pagamento..." />
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Status</div>
            <select id="bulkStatus">
              <option value="ALL">Todos</option>
              <option value="TRIAL">TRIAL</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="WAIT_PLAN">WAIT_PLAN</option>
              <option value="PAYMENT_PENDING">PAYMENT_PENDING</option>
              <option value="BLOCKED">BLOCKED</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Plano</div>
            <select id="bulkPlanFilter"><option value="ALL">Todos</option></select>
          </div>
        </div>

        <div class="row" style="margin-top:12px;">
          <input id="bulkLimit" type="number" min="1" max="500" value="200" style="width:120px;" />
          <button class="primary" type="button" id="bulkReloadBtn">Atualizar</button>
          <button type="button" id="bulkResetBtn">Limpar filtros</button>
          <button type="button" id="bulkSelectFilteredBtn">Selecionar filtrados</button>
          <button type="button" id="bulkClearSelectionBtn">Limpar seleção</button>
          <div id="bulkMeta" class="muted" style="margin-left:auto;"></div>
        </div>

        <div class="hr"></div>

        <div class="card pad" style="margin-bottom:14px;">
          <div class="row" style="justify-content:space-between; gap:12px;">
            <div>
              <h4 style="margin:0;">Operação em lote</h4>
              <div class="muted">Tudo que for executado aqui impactará todos os usuários selecionados.</div>
            </div>
            <div class="pill">Selecionados: <b id="bulkSelectedCount">0</b></div>
          </div>
          <div class="hr"></div>
          <div class="grid cols3">
            <div>
              <div class="muted" style="font-size:12px;margin-bottom:6px;">Ação</div>
              <select id="bulkOperation">
                <option value="SET_STATUS">Alterar status</option>
                <option value="BLOCK_USERS">Bloquear usuários</option>
                <option value="UNBLOCK_TO_TRIAL">Desbloquear para trial</option>
                <option value="SET_PLAN">Alterar plano</option>
                <option value="CLEAR_PLAN">Remover plano</option>
                <option value="RESET_TRIAL">Resetar trial</option>
                <option value="CLEAR_QUOTA">Zerar uso mensal</option>
                <option value="CLEAR_TRIAL_USED">Zerar uso do teste</option>
              </select>
            </div>
            <div id="bulkStatusValueWrap">
              <div class="muted" style="font-size:12px;margin-bottom:6px;">Novo status</div>
              <select id="bulkStatusValue">
                <option value="TRIAL">TRIAL</option>
                <option value="ACTIVE">ACTIVE</option>
                <option value="WAIT_PLAN">WAIT_PLAN</option>
                <option value="PAYMENT_PENDING">PAYMENT_PENDING</option>
                <option value="BLOCKED">BLOCKED</option>
              </select>
            </div>
            <div id="bulkPlanValueWrap" style="display:none;">
              <div class="muted" style="font-size:12px;margin-bottom:6px;">Novo plano</div>
              <select id="bulkPlanValue"><option value="">Selecione...</option></select>
            </div>
          </div>
          <div class="row" style="margin-top:12px;">
            <button class="primary" type="button" id="bulkApplyBtn">Aplicar ação</button>
            <div class="muted">As operações são registradas na auditoria administrativa.</div>
          </div>
        </div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between; gap:12px;">
            <div>
              <h4 style="margin:0;">Usuários filtrados</h4>
              <div class="muted">Selecione os usuários na tabela antes de aplicar a operação.</div>
            </div>
          </div>
          <div class="hr"></div>
          <div style="overflow:auto;">
            <table style="min-width:1040px;">
              <thead>
                <tr>
                  <th><input id="bulkToggleVisible" type="checkbox" /></th>
                  <th>Nome</th>
                  <th>waId</th>
                  <th>Status</th>
                  <th>Plano</th>
                  <th>Pagamento</th>
                  <th>Janela 24h</th>
                  <th>Inconsistências</th>
                </tr>
              </thead>
              <tbody id="bulkTbody"><tr><td colspan="8" class="muted">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>

        <div class="card pad" style="margin-top:14px;">
          <details>
            <summary class="muted">Ver JSON da última execução</summary>
            <pre id="bulkResult" style="white-space:pre-wrap; overflow:auto; max-height:360px;">{}</pre>
          </details>
        </div>
      </div>
    `;

    const scriptExtra = `
      <script>
        document.addEventListener("DOMContentLoaded", function(){
          const state = {
            data: null,
            selected: new Set(),
          };

          const els = {
            q: document.getElementById("bulkQ"),
            status: document.getElementById("bulkStatus"),
            planFilter: document.getElementById("bulkPlanFilter"),
            limit: document.getElementById("bulkLimit"),
            reloadBtn: document.getElementById("bulkReloadBtn"),
            resetBtn: document.getElementById("bulkResetBtn"),
            selectFilteredBtn: document.getElementById("bulkSelectFilteredBtn"),
            clearSelectionBtn: document.getElementById("bulkClearSelectionBtn"),
            meta: document.getElementById("bulkMeta"),
            selectedCount: document.getElementById("bulkSelectedCount"),
            operation: document.getElementById("bulkOperation"),
            statusValueWrap: document.getElementById("bulkStatusValueWrap"),
            statusValue: document.getElementById("bulkStatusValue"),
            planValueWrap: document.getElementById("bulkPlanValueWrap"),
            planValue: document.getElementById("bulkPlanValue"),
            applyBtn: document.getElementById("bulkApplyBtn"),
            tbody: document.getElementById("bulkTbody"),
            result: document.getElementById("bulkResult"),
            toggleVisible: document.getElementById("bulkToggleVisible"),
          };

          function esc(value){
            return String(value ?? "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#39;");
          }

          function fmtTs(ts){
            if (!ts) return "—";
            const d = new Date(Number(ts));
            if (Number.isNaN(d.getTime())) return "—";
            return d.toLocaleString("pt-BR");
          }

          function windowLabel(user){
            if (!user || !user.lastInboundTs) return "—";
            return user.inWindow ? ("Ativa até " + fmtTs(user.windowExpiresAt)) : ("Fora (última em " + fmtTs(user.lastInboundTs) + ")");
          }

          function setResult(value){
            if (els.result) els.result.textContent = JSON.stringify(value ?? {}, null, 2);
          }

          async function fetchJson(url, opt){
            const response = await fetch(url, opt);
            const json = await response.json().catch(function(){ return {}; });
            return { response, json };
          }

          function buildQuery(){
            const params = new URLSearchParams();
            const q = String(els.q?.value || "").trim();
            const status = String(els.status?.value || "ALL").trim();
            const plan = String(els.planFilter?.value || "ALL").trim();
            const limit = String(els.limit?.value || "200").trim();
            if (q) params.set("q", q);
            if (status) params.set("status", status);
            if (plan) params.set("plan", plan);
            if (limit) params.set("limit", limit);
            return params.toString();
          }

          function syncSelectionCounter(){
            if (els.selectedCount) els.selectedCount.textContent = String(state.selected.size);
          }

          function syncActionInputs(){
            const op = String(els.operation?.value || "").trim().toUpperCase();
            if (els.statusValueWrap) els.statusValueWrap.style.display = op === "SET_STATUS" ? "block" : "none";
            if (els.planValueWrap) els.planValueWrap.style.display = op === "SET_PLAN" ? "block" : "none";
          }

          function fillPlanOptions(plans){
            const list = Array.isArray(plans) ? plans : [];
            const options = ['<option value="ALL">Todos</option>'].concat(list.map(function(code){ return '<option value="' + esc(code) + '">' + esc(code) + '</option>'; }));
            if (els.planFilter) els.planFilter.innerHTML = options.join("");
            if (els.planValue) {
              els.planValue.innerHTML = '<option value="">Selecione...</option>' + list.map(function(code){ return '<option value="' + esc(code) + '">' + esc(code) + '</option>'; }).join("");
            }
          }

          function renderRows(items){
            if (!els.tbody) return;
            const rows = Array.isArray(items) ? items : [];
            if (!rows.length) {
              els.tbody.innerHTML = '<tr><td colspan="8" class="muted">Nenhum usuário encontrado.</td></tr>';
              return;
            }
            els.tbody.innerHTML = rows.map(function(user){
              const waId = String(user?.waId || "").trim();
              const checked = state.selected.has(waId) ? ' checked' : '';
              const issues = Number(user?.issueCount || 0);
              const issueBadge = issues > 0 ? '<span class="badge warn">' + esc(issues) + '</span>' : '<span class="badge ok">0</span>';
              return '<tr>' +
                '<td><input type="checkbox" data-action="toggle-user" data-waid="' + esc(waId) + '"' + checked + ' /></td>' +
                '<td><b>' + esc(user?.fullName || '—') + '</b></td>' +
                '<td><code>' + esc(waId) + '</code></td>' +
                '<td>' + esc(user?.status || '—') + '</td>' +
                '<td>' + esc(user?.plan || '—') + '</td>' +
                '<td>' + esc(user?.paymentMethod || '—') + '</td>' +
                '<td>' + esc(windowLabel(user)) + '</td>' +
                '<td>' + issueBadge + '</td>' +
              '</tr>';
            }).join("");
          }

          async function loadBulk(){
            if (els.tbody) els.tbody.innerHTML = '<tr><td colspan="8" class="muted">Carregando...</td></tr>';
            const out = await fetchJson('/admin/bulk/list?' + buildQuery());
            setResult(out.json);
            if (!out.response.ok || !out.json.ok) {
              if (els.tbody) els.tbody.innerHTML = '<tr><td colspan="8" class="muted">Erro ao carregar usuários.</td></tr>';
              return;
            }
            state.data = out.json;
            fillPlanOptions(out.json.availablePlans || []);
            renderRows(out.json.items || []);
            if (els.meta) els.meta.textContent = String(out.json.filteredCount || 0) + ' filtrados • Base: ' + String(out.json.totalUsers || 0);
            syncSelectionCounter();
          }

          async function applyBulk(){
            const waIds = Array.from(state.selected.values());
            if (!waIds.length) {
              alert('Selecione pelo menos um usuário.');
              return;
            }
            const operation = String(els.operation?.value || '').trim().toUpperCase();
            let value = '';
            if (operation === 'SET_STATUS') value = String(els.statusValue?.value || '').trim();
            if (operation === 'SET_PLAN') value = String(els.planValue?.value || '').trim();
            if (operation === 'SET_PLAN' && !value) {
              alert('Selecione um plano.');
              return;
            }
            const out = await fetchJson('/admin/bulk/apply', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ operation, waIds, value }),
            });
            setResult(out.json);
            if (!out.response.ok || !out.json.ok) {
              alert('Falha ao executar a ação em massa.');
              return;
            }
            await loadBulk();
          }

          if (els.reloadBtn) els.reloadBtn.addEventListener('click', loadBulk);
          if (els.resetBtn) els.resetBtn.addEventListener('click', function(){
            if (els.q) els.q.value = '';
            if (els.status) els.status.value = 'ALL';
            if (els.planFilter) els.planFilter.value = 'ALL';
            if (els.limit) els.limit.value = '200';
            loadBulk();
          });
          if (els.selectFilteredBtn) els.selectFilteredBtn.addEventListener('click', function(){
            const items = Array.isArray(state.data?.items) ? state.data.items : [];
            items.forEach(function(user){
              const waId = String(user?.waId || '').trim();
              if (waId) state.selected.add(waId);
            });
            renderRows(items);
            syncSelectionCounter();
          });
          if (els.clearSelectionBtn) els.clearSelectionBtn.addEventListener('click', function(){
            state.selected.clear();
            renderRows(state.data?.items || []);
            syncSelectionCounter();
          });
          if (els.operation) els.operation.addEventListener('change', syncActionInputs);
          if (els.applyBtn) els.applyBtn.addEventListener('click', applyBulk);
          if (els.toggleVisible) els.toggleVisible.addEventListener('change', function(ev){
            const checked = !!ev.target.checked;
            const items = Array.isArray(state.data?.items) ? state.data.items : [];
            items.forEach(function(user){
              const waId = String(user?.waId || '').trim();
              if (!waId) return;
              if (checked) state.selected.add(waId);
              else state.selected.delete(waId);
            });
            renderRows(items);
            syncSelectionCounter();
          });
          if (els.tbody) els.tbody.addEventListener('change', function(ev){
            const target = ev.target;
            if (!(target instanceof HTMLInputElement)) return;
            if (target.getAttribute('data-action') !== 'toggle-user') return;
            const waId = String(target.getAttribute('data-waid') || '').trim();
            if (!waId) return;
            if (target.checked) state.selected.add(waId);
            else state.selected.delete(waId);
            syncSelectionCounter();
          });

          syncActionInputs();
          loadBulk();
        });
      </script>
    `;

    const html = layoutBase({
      title: "Ações em Massa",
      activePath: "/admin/bulk-ui",
      content: inner,
      scriptExtra,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/crm-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">🧭 CRM de usuários</h3>
            <div class="muted">Central única para localizar usuários, filtrar contas e abrir uma ficha completa com assinatura, uso, empresa e inconsistências.</div>
          </div>
          <div class="row">
            <a class="pill" href="/admin/users-list-ui">Lista simples</a>
            <a class="pill" href="/admin/users-ui">Ações por waId</a>
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid cols3">
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Busca</div>
            <input id="crmQ" placeholder="Nome, waId, plano ou cidade..." />
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Status</div>
            <select id="crmStatus">
              <option value="ALL">Todos</option>
              <option value="TRIAL">TRIAL</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="WAIT_PLAN">WAIT_PLAN</option>
              <option value="PAYMENT_PENDING">PAYMENT_PENDING</option>
              <option value="BLOCKED">BLOCKED</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Plano</div>
            <select id="crmPlan"><option value="ALL">Todos</option></select>
          </div>
        </div>

        <div class="grid cols3" style="margin-top:12px;">
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Pagamento</div>
            <select id="crmPayment">
              <option value="ALL">Todos</option>
              <option value="CARD">CARD</option>
              <option value="PIX">PIX</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Tem nome</div>
            <select id="crmHasName">
              <option value="ALL">Todos</option>
              <option value="YES">Sim</option>
              <option value="NO">Não</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Tem assinatura Asaas</div>
            <select id="crmHasSubscription">
              <option value="ALL">Todos</option>
              <option value="YES">Sim</option>
              <option value="NO">Não</option>
            </select>
          </div>
        </div>

        <div class="grid cols3" style="margin-top:12px;">
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Tem perfil da empresa</div>
            <select id="crmHasBizProfile">
              <option value="ALL">Todos</option>
              <option value="YES">Sim</option>
              <option value="NO">Não</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Tem inconsistência</div>
            <select id="crmHasInconsistency">
              <option value="ALL">Todos</option>
              <option value="YES">Sim</option>
              <option value="NO">Não</option>
            </select>
          </div>
          <div>
            <div class="muted" style="font-size:12px;margin-bottom:6px;">Janela 24h ativa</div>
            <select id="crmInWindow">
              <option value="ALL">Todos</option>
              <option value="YES">Sim</option>
              <option value="NO">Não</option>
            </select>
          </div>
        </div>

        <div class="row" style="margin-top:12px;">
          <input id="crmLimit" type="number" min="1" max="500" value="200" style="width:120px;" />
          <button class="primary" type="button" id="crmReloadBtn">Atualizar</button>
          <button type="button" id="crmResetBtn">Limpar filtros</button>
          <div id="crmMeta" class="muted" style="margin-left:auto;"></div>
        </div>

        <div class="hr"></div>

        <div class="row" id="crmSummary" style="gap:8px; flex-wrap:wrap;"></div>

        <div class="hr"></div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between; gap:12px;">
            <div>
              <h4 style="margin:0;">Usuários filtrados</h4>
              <div class="muted">Use os filtros para localizar a conta e abra a ficha completa em uma janela maior.</div>
            </div>
            <div class="muted">A ficha agora abre em pop-up para não cortar o conteúdo.</div>
          </div>
          <div class="hr"></div>
          <div style="overflow:auto;">
            <table style="min-width:1000px;">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>waId</th>
                  <th>Status</th>
                  <th>Plano</th>
                  <th>Pagamento</th>
                  <th>Janela 24h</th>
                  <th>Inconsistências</th>
                  <th>Ação</th>
                </tr>
              </thead>
              <tbody id="crmTbody">
                <tr><td colspan="8" class="muted">Carregando...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div id="crmModal" class="crm-modal" aria-hidden="true">
          <div class="crm-modal-backdrop" data-action="close-crm-modal"></div>
          <div class="crm-modal-panel" role="dialog" aria-modal="true" aria-labelledby="crmModalTitle">
            <div class="crm-modal-header">
              <div>
                <h4 id="crmModalTitle" style="margin:0;">Ficha do usuário</h4>
                <div class="muted">Visão consolidada da conta</div>
              </div>
              <button type="button" id="crmCloseModalBtn">Fechar</button>
            </div>
            <div class="hr"></div>
            <div id="crmDetail" class="crm-modal-body muted">Selecione um usuário na tabela para abrir a ficha completa.</div>
          </div>
        </div>
      </div>
    `;

    const scriptExtra = `
      <script>
        document.addEventListener("DOMContentLoaded", function(){
          const state = {
            lastData: null,
            currentUser: null,
            currentAvailablePlans: []
          };

          const els = {
            q: document.getElementById("crmQ"),
            status: document.getElementById("crmStatus"),
            plan: document.getElementById("crmPlan"),
            payment: document.getElementById("crmPayment"),
            hasName: document.getElementById("crmHasName"),
            hasSubscription: document.getElementById("crmHasSubscription"),
            hasBizProfile: document.getElementById("crmHasBizProfile"),
            hasInconsistency: document.getElementById("crmHasInconsistency"),
            inWindow: document.getElementById("crmInWindow"),
            limit: document.getElementById("crmLimit"),
            reloadBtn: document.getElementById("crmReloadBtn"),
            resetBtn: document.getElementById("crmResetBtn"),
            meta: document.getElementById("crmMeta"),
            summary: document.getElementById("crmSummary"),
            tbody: document.getElementById("crmTbody"),
            detail: document.getElementById("crmDetail"),
            modal: document.getElementById("crmModal"),
            modalTitle: document.getElementById("crmModalTitle"),
            closeModalBtn: document.getElementById("crmCloseModalBtn"),
          };

          function esc(value){
            return String(value ?? "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#39;");
          }

          function fmtTs(ts){
            if (!ts) return "—";
            const d = new Date(Number(ts));
            if (Number.isNaN(d.getTime())) return "—";
            return d.toLocaleString("pt-BR");
          }

          function fmtIssueCount(n){
            const v = Number(n || 0);
            if (v <= 0) return '<span class="badge ok">sem pendências</span>';
            if (v === 1) return '<span class="badge warn">1 pendência</span>';
            return '<span class="badge danger">' + esc(v) + ' pendências</span>';
          }

          function openDetailModal(title){
            if (els.modalTitle) els.modalTitle.textContent = title || "Ficha do usuário";
            if (els.modal) {
              els.modal.classList.add("open");
              els.modal.setAttribute("aria-hidden", "false");
              document.body.style.overflow = "hidden";
            }
          }

          function closeDetailModal(){
            if (els.modal) {
              els.modal.classList.remove("open");
              els.modal.setAttribute("aria-hidden", "true");
              document.body.style.overflow = "";
            }
          }

          function readFilters(){
            return {
              q: String(els.q?.value || "").trim(),
              status: String(els.status?.value || "ALL").trim(),
              plan: String(els.plan?.value || "ALL").trim(),
              paymentMethod: String(els.payment?.value || "ALL").trim(),
              hasName: String(els.hasName?.value || "ALL").trim(),
              hasSubscription: String(els.hasSubscription?.value || "ALL").trim(),
              hasBizProfile: String(els.hasBizProfile?.value || "ALL").trim(),
              hasInconsistency: String(els.hasInconsistency?.value || "ALL").trim(),
              inWindow: String(els.inWindow?.value || "ALL").trim(),
              limit: String(els.limit?.value || "200").trim(),
            };
          }

          async function fetchJson(url, opt){
            const response = await fetch(url, opt);
            const json = await response.json().catch(() => ({}));
            return { response, json };
          }

          function buildQuery(){
            const params = new URLSearchParams();
            const filters = readFilters();
            Object.keys(filters).forEach(function(key){
              const value = filters[key];
              if (key === "limit") {
                params.set(key, value || "200");
                return;
              }
              if (value && value !== "ALL") params.set(key, value);
            });
            return params.toString();
          }

          function renderSummary(data){
            const st = data?.statusSummary || {};
            const cards = [
              ["Total filtrado", data?.filteredCount ?? 0],
              ["Total base", data?.totalUsers ?? 0],
              ["TRIAL", st.TRIAL ?? 0],
              ["ACTIVE", st.ACTIVE ?? 0],
              ["WAIT_PLAN", st.WAIT_PLAN ?? 0],
              ["PAYMENT_PENDING", st.PAYMENT_PENDING ?? 0],
              ["BLOCKED", st.BLOCKED ?? 0]
            ];
            els.summary.innerHTML = cards.map(function(card){
              return '<span class="pill">' + esc(card[0]) + ': <b>' + esc(card[1]) + '</b></span>';
            }).join("");
            els.meta.textContent = String(data?.filteredCount ?? 0) + " usuário(s) exibidos";
          }

          function syncPlanOptions(plans){
            const current = String(els.plan?.value || "ALL").trim();
            const options = ['<option value="ALL">Todos</option>'];
            (Array.isArray(plans) ? plans : []).forEach(function(plan){
              options.push('<option value="' + esc(plan) + '">' + esc(plan) + '</option>');
            });
            els.plan.innerHTML = options.join("");
            const exists = Array.from(els.plan.options).some(function(opt){ return opt.value === current; });
            els.plan.value = exists ? current : "ALL";
          }

          function renderTable(items){
            const rows = Array.isArray(items) ? items : [];
            if (!rows.length) {
              els.tbody.innerHTML = '<tr><td colspan="8" class="muted">Nenhum usuário encontrado para os filtros aplicados.</td></tr>';
              return;
            }

            els.tbody.innerHTML = rows.map(function(user){
              const waId = String(user?.waId || "").trim();
              const planLabel = user.planName ? (String(user.plan || "") + " · " + String(user.planName || "")) : (user.plan || "—");
              const win = user.inWindow
                ? ("Ativa até " + fmtTs(user.windowExpiresAt))
                : (user.lastInboundTs ? ("Fora desde " + fmtTs(user.lastInboundTs)) : "—");

              return '' +
                '<tr data-wa-id="' + esc(waId) + '">' +
                  '<td>' + esc(user?.fullName || "—") + '</td>' +
                  '<td><code>' + esc(waId) + '</code></td>' +
                  '<td>' + esc(user?.status || "—") + '</td>' +
                  '<td>' + esc(planLabel || "—") + '</td>' +
                  '<td>' + esc(user?.paymentMethod || "—") + '</td>' +
                  '<td>' + esc(win) + '</td>' +
                  '<td>' + fmtIssueCount(user?.issueCount) + '</td>' +
                  '<td><button type="button" data-action="open-crm-user" data-wa-id="' + esc(waId) + '">Abrir ficha</button></td>' +
                '</tr>';
            }).join("");
          }

          function crmFieldValue(user, field){
            const source = (user && user.editableFields && typeof user.editableFields === "object") ? user.editableFields : (user || {});
            if (field.indexOf(".") > -1) {
              return field.split(".").reduce(function(acc, part){ return acc && typeof acc === "object" ? acc[part] : undefined; }, source);
            }
            return source[field];
          }

          function crmTextInput(id, label, value, type){
            return '<div><div class="muted" style="font-size:12px;margin-bottom:6px;">' + esc(label) + '</div><input id="' + esc(id) + '" type="' + esc(type || "text") + '" value="' + esc(value || "") + '" /></div>';
          }

          function crmNumberInput(id, label, value){
            const n = Number(value || 0);
            return '<div><div class="muted" style="font-size:12px;margin-bottom:6px;">' + esc(label) + '</div><input id="' + esc(id) + '" type="number" min="0" step="1" value="' + esc(Number.isFinite(n) ? Math.trunc(n) : 0) + '" /></div>';
          }

          function crmSelectInput(id, label, value, options){
            const cur = String(value || "").trim();
            const html = (options || []).map(function(opt){
              const val = String(opt.value ?? opt).trim();
              const text = String(opt.label ?? opt).trim();
              return '<option value="' + esc(val) + '"' + (val === cur ? ' selected' : '') + '>' + esc(text) + '</option>';
            }).join("");
            return '<div><div class="muted" style="font-size:12px;margin-bottom:6px;">' + esc(label) + '</div><select id="' + esc(id) + '">' + html + '</select></div>';
          }

          function crmJsonTextArea(id, label, value){
            const text = value ? JSON.stringify(value, null, 2) : "";
            return '<div><div class="muted" style="font-size:12px;margin-bottom:6px;">' + esc(label) + '</div><textarea id="' + esc(id) + '" spellcheck="false" style="min-height:120px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">' + esc(text) + '</textarea></div>';
          }

          function readJsonField(id, label){
            const el = document.getElementById(id);
            const raw = String(el && el.value || "").trim();
            if (!raw) return { ok: true, value: null };
            try {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, value: parsed };
              return { ok: false, error: label + " deve ser um objeto JSON ou vazio." };
            } catch (err) {
              return { ok: false, error: label + " possui JSON inválido: " + String(err && err.message || err) };
            }
          }

          function getInputValue(id){
            const el = document.getElementById(id);
            return String(el && el.value || "").trim();
          }

          function getIntValue(id){
            const n = Number(getInputValue(id));
            return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
          }

          function buildPlanSelectOptions(user){
            const seen = new Set();
            const options = [{ value: "", label: "— sem plano —" }];
            const current = String(user && user.plan || "").trim().toUpperCase();
            if (current) {
              seen.add(current);
              options.push({ value: current, label: current + " (atual)" });
            }
            (state.currentAvailablePlans || []).forEach(function(plan){
              const code = String(plan && plan.code || "").trim().toUpperCase();
              if (!code || seen.has(code)) return;
              seen.add(code);
              options.push({ value: code, label: code + (plan.name ? " — " + plan.name : "") + (plan.active === false ? " (inativo)" : "") });
            });
            return options;
          }

          function normalizeCrmFeedbackWarnings(list){
            if (!Array.isArray(list)) return [];
            return list.map(function(item){
              if (typeof item === "string") return item;
              if (item && typeof item === "object") return String(item.message || item.reason || item.code || JSON.stringify(item));
              return String(item || "");
            }).filter(Boolean);
          }

          function renderCrmSaveFeedback(user){
            const feedback = state.lastSaveFeedback;
            if (!feedback || !feedback.ok) return "";
            const currentId = String(user && (user.userId || user.waId) || "");
            const feedbackId = String(feedback.internalUserId || feedback.userId || "");
            if (feedbackId && currentId && feedbackId !== currentId && String(user && user.waId || "") !== String(feedback.snapshot && feedback.snapshot.waId || "")) return "";
            const warnings = [];
            warnings.push.apply(warnings, normalizeCrmFeedbackWarnings(feedback.pricingView && feedback.pricingView.warnings));
            warnings.push.apply(warnings, normalizeCrmFeedbackWarnings(feedback.asaasImpact && feedback.asaasImpact.warnings));
            warnings.push.apply(warnings, normalizeCrmFeedbackWarnings(feedback.webhookWarnings && feedback.webhookWarnings.warnings));
            if (feedback.identity && feedback.identity.conflict) warnings.push("Conflito de identidade pendente: campos financeiros sensíveis podem ter sido bloqueados.");
            const rejected = Array.isArray(feedback.rejectedFields) ? feedback.rejectedFields : [];
            const rejectedHtml = rejected.length
              ? '<div style="margin-top:8px;"><b>Campos rejeitados/avisos:</b><ul style="margin:6px 0 0 18px;">' + rejected.map(function(item){
                  if (item && typeof item === "object") return '<li><code>' + esc(item.field || "campo") + '</code> — ' + esc(item.message || item.reason || "rejeitado") + '</li>';
                  return '<li>' + esc(String(item || "")) + '</li>';
                }).join("") + '</ul></div>'
              : '';
            const warningsHtml = warnings.length
              ? '<div style="margin-top:8px;"><b>Warnings:</b><ul style="margin:6px 0 0 18px;">' + warnings.map(function(item){ return '<li>' + esc(item) + '</li>'; }).join("") + '</ul></div>'
              : '';
            return '' +
              '<div class="card pad" style="border-color:rgba(16,185,129,.35); background:rgba(16,185,129,.06); margin-bottom:12px;">' +
                '<span class="badge ok soft">Alterações salvas</span>' +
                '<span class="muted" style="margin-left:8px;">' + esc((feedback.changedFields || []).length) + ' campo(s) alterado(s).</span>' +
                warningsHtml +
                rejectedHtml +
              '</div>';
          }

          function renderEditForm(user){
            if (!user) return;
            state.currentUser = user;
            const doc = user.doc || {};
            const planOptions = buildPlanSelectOptions(user);
            const statusOptions = ["TRIAL", "ACTIVE", "WAIT_NAME", "WAIT_PLAN", "WAIT_PAYMENT", "PAYMENT_PENDING", "WAIT_TEMPLATE_MODE", "WAIT_BILLING_CITY_STATE", "WAIT_BILLING_ADDRESS", "WAIT_COMPANY_PROFILE", "BLOCKED"].map(function(v){ return { value: v, label: v }; });
            const templateOptions = [{ value: "FIXED", label: "FIXED" }, { value: "FREE", label: "FREE" }];
            const paymentOptions = [{ value: "", label: "—" }, { value: "PIX", label: "PIX" }, { value: "CARD", label: "CARD" }];
            const billingCycleOptions = [{ value: "", label: "—" }, { value: "monthly", label: "monthly" }, { value: "annual", label: "annual" }];
            const docTypeOptions = [{ value: "", label: "—" }, { value: "CPF", label: "CPF" }, { value: "CNPJ", label: "CNPJ" }];

            els.detail.innerHTML = '' +
              '<div class="row" style="justify-content:space-between; align-items:flex-start;">' +
                '<div>' +
                  '<h3 style="margin:0 0 6px 0;">Editar usuário</h3>' +
                  '<div class="muted"><code>' + esc(user.userId || user.waId || "") + '</code></div>' +
                '</div>' +
                '<div class="row">' +
                  '<button type="button" class="primary" data-action="save-crm-user-edit">Salvar alterações</button>' +
                  '<button type="button" data-action="cancel-crm-user-edit">Cancelar</button>' +
                '</div>' +
              '</div>' +
              '<div class="hr"></div>' +
              '<div class="badge warn soft" style="white-space:normal; line-height:1.5;">Alterações financeiras avançadas, como valor individual de mensalidade, somente serão aplicadas quando também refletidas na assinatura/cobrança correspondente.</div>' +
              '<div id="crmEditMsg" class="muted" style="margin-top:10px;"></div>' +
              '<div class="hr"></div>' +
              '<h4 style="margin:0 0 10px 0;">Conta</h4>' +
              '<div class="grid cols2">' +
                crmTextInput("crmEditFullName", "Nome", user.fullName || "") +
                crmSelectInput("crmEditStatus", "Status", user.status || "TRIAL", statusOptions) +
                crmSelectInput("crmEditPlan", "Plano", user.plan || "", planOptions) +
                crmSelectInput("crmEditTemplateMode", "Template", user.templateMode || "FIXED", templateOptions) +
              '</div>' +
              '<div class="hr"></div>' +
              '<h4 style="margin:0 0 10px 0;">Uso</h4>' +
              '<div class="grid cols2">' +
                crmNumberInput("crmEditQuotaUsed", "quotaUsed", user.quotaUsed || 0) +
                crmNumberInput("crmEditTrialUsed", "trialUsed", user.trialUsed || 0) +
              '</div>' +
              '<div class="hr"></div>' +
              '<h4 style="margin:0 0 10px 0;">Cobrança</h4>' +
              '<div class="grid cols2">' +
                crmSelectInput("crmEditPaymentMethod", "Pagamento", user.paymentMethod || "", paymentOptions) +
                crmTextInput("crmEditAsaasCustomerId", "Asaas Customer", user.asaasCustomerId || "") +
                crmTextInput("crmEditAsaasSubscriptionId", "Asaas Subscription", user.asaasSubscriptionId || "") +
                crmTextInput("crmEditCardValidUntil", "Válido até", user.cardValidUntil || "", "date") +
                crmTextInput("crmEditCardCanceledAt", "Cancelado em", user.cardCanceledAt || "") +
                crmSelectInput("crmEditSelectedBillingCycle", "Ciclo selecionado", user.selectedBillingCycle || "", billingCycleOptions) +
                crmSelectInput("crmEditSelectedPlanCode", "Plano selecionado", user.selectedPlanCode || "", planOptions) +
                crmTextInput("crmEditSelectedCouponCode", "Cupom selecionado", user.selectedCouponCode || "") +
                crmTextInput("crmEditCouponReservationId", "Reserva de cupom", user.couponReservationId || "") +
                crmTextInput("crmEditCouponReservationCreatedAt", "Reserva criada em", user.couponReservationCreatedAt || "") +
                crmTextInput("crmEditCheckoutCouponStatus", "Status do cupom no checkout", user.checkoutCouponStatus || "") +
              '</div>' +
              '<div class="hr"></div>' +
              '<h4 style="margin:0 0 10px 0;">Cadastro</h4>' +
              '<div class="grid cols2">' +
                crmTextInput("crmEditBillingCityState", "Cidade/UF", user.billingCityState || "") +
                crmTextInput("crmEditBillingAddress", "Endereço", user.billingAddress || "") +
                crmSelectInput("crmEditDocType", "Documento - tipo", doc.docType || "", docTypeOptions) +
                crmTextInput("crmEditDocLast4", "Documento - últimos 4 dígitos", doc.docLast4 || "", "text") +
              '</div>' +
              '<div class="hr"></div>' +
              '<h4 style="margin:0 0 10px 0;">Perfil da empresa</h4>' +
              '<div class="grid cols2">' +
                crmJsonTextArea("crmEditBizProfile", "Perfil salvo", user.bizProfile || null) +
                crmJsonTextArea("crmEditPendingBizProfile", "Perfil pendente", user.pendingBizProfile || null) +
              '</div>' +
              '<div class="hr"></div>' +
              '<h4 style="margin:0 0 10px 0;">Operacional</h4>' +
              '<div class="grid cols2">' +
                crmJsonTextArea("crmEditActivityMeta", "activityMeta", user.activityMeta || {}) +
                crmJsonTextArea("crmEditGrowthMeta", "growthMeta", user.growthMeta || {}) +
                crmJsonTextArea("crmEditPricingQuote", "pricingQuote", user.pricingQuote || null) +
                crmJsonTextArea("crmEditCheckoutDraft", "checkoutDraft", user.checkoutDraft || null) +
                crmJsonTextArea("crmEditCurrentAdSession", "currentAdSession", user.currentAdSession || null) +
              '</div>';
          }

          function buildEditPatchFromForm(){
            const jsonFields = [
              ["crmEditBizProfile", "Perfil salvo", "bizProfile"],
              ["crmEditPendingBizProfile", "Perfil pendente", "pendingBizProfile"],
              ["crmEditActivityMeta", "activityMeta", "activityMeta"],
              ["crmEditGrowthMeta", "growthMeta", "growthMeta"],
              ["crmEditPricingQuote", "pricingQuote", "pricingQuote"],
              ["crmEditCheckoutDraft", "checkoutDraft", "checkoutDraft"],
              ["crmEditCurrentAdSession", "currentAdSession", "currentAdSession"],
            ];
            const patch = {
              fullName: getInputValue("crmEditFullName"),
              status: getInputValue("crmEditStatus"),
              plan: getInputValue("crmEditPlan"),
              quotaUsed: getIntValue("crmEditQuotaUsed"),
              trialUsed: getIntValue("crmEditTrialUsed"),
              templateMode: getInputValue("crmEditTemplateMode"),
              paymentMethod: getInputValue("crmEditPaymentMethod"),
              billingCityState: getInputValue("crmEditBillingCityState"),
              billingAddress: getInputValue("crmEditBillingAddress"),
              doc: {
                docType: getInputValue("crmEditDocType"),
                docLast4: getInputValue("crmEditDocLast4"),
              },
              asaasCustomerId: getInputValue("crmEditAsaasCustomerId"),
              asaasSubscriptionId: getInputValue("crmEditAsaasSubscriptionId"),
              cardValidUntil: getInputValue("crmEditCardValidUntil"),
              cardCanceledAt: getInputValue("crmEditCardCanceledAt"),
              selectedPlanCode: getInputValue("crmEditSelectedPlanCode"),
              selectedBillingCycle: getInputValue("crmEditSelectedBillingCycle"),
              selectedCouponCode: getInputValue("crmEditSelectedCouponCode"),
              couponReservationId: getInputValue("crmEditCouponReservationId"),
              couponReservationCreatedAt: getInputValue("crmEditCouponReservationCreatedAt"),
              checkoutCouponStatus: getInputValue("crmEditCheckoutCouponStatus"),
            };
            for (const item of jsonFields) {
              const parsed = readJsonField(item[0], item[1]);
              if (!parsed.ok) return { ok: false, error: parsed.error };
              patch[item[2]] = parsed.value;
            }
            return { ok: true, patch: patch };
          }

          async function saveCrmUserEdit(){
            const msg = document.getElementById("crmEditMsg");
            const user = state.currentUser || {};
            const built = buildEditPatchFromForm();
            if (!built.ok) {
              if (msg) msg.innerHTML = '<span class="badge danger soft">' + esc(built.error) + '</span>';
              return;
            }
            if (msg) msg.innerHTML = '<span class="badge info soft">Salvando alterações...</span>';
            const out = await fetchJson("/admin/crm/user/update", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ userId: user.userId || user.waId || "", waId: user.waId || "", patch: built.patch })
            });
            if (!out.response.ok || !out.json.ok) {
              const err = out.json && (out.json.error || JSON.stringify(out.json.validationErrors || out.json));
              if (msg) msg.innerHTML = '<span class="badge danger soft">Falha ao salvar: ' + esc(err || "erro desconhecido") + '</span>';
              return;
            }
            state.lastSaveFeedback = out.json;
            if (msg) msg.innerHTML = '<span class="badge ok soft">Alterações salvas. Recarregando ficha...</span>';
            await loadCrm();
            await loadCrmUser(user.waId || user.userId || out.json.userId || "");
          }

          function renderDetail(user){
            if (!user) {
              els.detail.innerHTML = '<div class="muted">Usuário não encontrado.</div>';
              openDetailModal("Ficha do usuário");
              return;
            }

            const doc = user.doc && user.doc.docType ? (user.doc.docType + " • " + (user.doc.docLast4 || "")) : "—";
            const bizProfile = user.bizProfile
              ? '<pre style="white-space:pre-wrap;">' + esc(JSON.stringify(user.bizProfile, null, 2)) + '</pre>'
              : '<div class="muted">Nenhum perfil salvo.</div>';
            const pendingBiz = user.pendingBizProfile
              ? '<pre style="white-space:pre-wrap;">' + esc(JSON.stringify(user.pendingBizProfile, null, 2)) + '</pre>'
              : '<div class="muted">Nenhum dado pendente.</div>';
            const issues = Array.isArray(user.issueKeys) && user.issueKeys.length
              ? '<div class="row" style="gap:6px; flex-wrap:wrap;">' + user.issueKeys.map(function(key){
                  return '<span class="badge warn soft">' + esc(key) + '</span>';
                }).join("") + '</div>'
              : '<span class="badge ok">Sem inconsistências</span>';

            state.currentUser = user;

            els.detail.innerHTML = '' +
              '<div class="row" style="justify-content:space-between; align-items:flex-start;">' +
                '<div>' +
                  '<h3 style="margin:0 0 6px 0;">' + esc(user.fullName || "Sem nome") + '</h3>' +
                  '<div class="muted"><code>' + esc(user.waId || "") + '</code></div>' +
                '</div>' +
                '<div class="row">' +
                  '<button type="button" class="primary" data-action="edit-crm-user">Editar</button>' +
                  '<a class="pill" href="/admin/users-ui?waId=' + encodeURIComponent(user.waId || "") + '">Ações</a>' +
                  '<a class="pill" href="/admin/inconsistencies-ui">Inconsistências</a>' +
                '</div>' +
              '</div>' +
              '<div class="hr"></div>' +
              renderCrmSaveFeedback(user) +
              '<div class="grid cols2">' +
                '<div class="kpi">' +
                  '<div class="t">Conta</div>' +
                  '<div class="muted">Status: <b>' + esc(user.status || "—") + '</b></div>' +
                  '<div class="muted">Plano: <b>' + esc(user.plan || "—") + '</b></div>' +
                  '<div class="muted">Nome do plano: <b>' + esc(user.planName || "—") + '</b></div>' +
                  '<div class="muted">Template: <b>' + esc(user.templateMode || "—") + '</b></div>' +
                '</div>' +
                '<div class="kpi">' +
                  '<div class="t">Uso</div>' +
                  '<div class="muted">quotaUsed: <b>' + esc(user.quotaUsed) + '</b></div>' +
                  '<div class="muted">trialUsed: <b>' + esc(user.trialUsed) + '</b></div>' +
                  '<div class="muted">Janela 24h: <b>' + esc(user.inWindow ? "Ativa" : "Fora") + '</b></div>' +
                  '<div class="muted">Última inbound: <b>' + esc(fmtTs(user.lastInboundTs)) + '</b></div>' +
                '</div>' +
              '</div>' +
              '<div class="hr"></div>' +
              '<div class="grid cols2">' +
                '<div class="kpi">' +
                  '<div class="t">Cobrança</div>' +
                  '<div class="muted">Pagamento: <b>' + esc(user.paymentMethod || "—") + '</b></div>' +
                  '<div class="muted">Asaas Customer: <code>' + esc(user.asaasCustomerId || "—") + '</code></div>' +
                  '<div class="muted">Asaas Subscription: <code>' + esc(user.asaasSubscriptionId || "—") + '</code></div>' +
                  '<div class="muted">Cancelado em: <b>' + esc(user.cardCanceledAt || "—") + '</b></div>' +
                  '<div class="muted">Válido até: <b>' + esc(user.cardValidUntil || "—") + '</b></div>' +
                '</div>' +
                '<div class="kpi">' +
                  '<div class="t">Cadastro</div>' +
                  '<div class="muted">Documento: <b>' + esc(doc) + '</b></div>' +
                  '<div class="muted">Cidade/UF: <b>' + esc(user.billingCityState || "—") + '</b></div>' +
                  '<div class="muted">Endereço: <b>' + esc(user.billingAddress || "—") + '</b></div>' +
                '</div>' +
              '</div>' +
              '<div class="hr"></div>' +
              '<div><b>Inconsistências encontradas</b></div>' +
              '<div style="margin-top:8px;">' + issues + '</div>' +
              '<div class="hr"></div>' +
              '<details open><summary><b>Perfil da empresa salvo</b></summary>' + bizProfile + '</details>' +
              '<div class="hr"></div>' +
              '<details><summary><b>Perfil da empresa pendente</b></summary>' + pendingBiz + '</details>' +
              '<div class="hr"></div>' +
              '<details><summary><b>JSON completo</b></summary><pre style="white-space:pre-wrap;">' + esc(JSON.stringify(user.snapshot || {}, null, 2)) + '</pre></details>';

            openDetailModal(user.fullName || user.waId || "Ficha do usuário");
          }

          async function loadCrm(){
            const out = await fetchJson("/admin/crm/list?" + buildQuery());
            if (!out.response.ok || !out.json.ok) {
              els.tbody.innerHTML = '<tr><td colspan="8" class="muted">Falha ao carregar CRM.</td></tr>';
              els.detail.innerHTML = '<div class="muted">Falha ao carregar dados.</div>';
              return;
            }

            state.lastData = out.json;
            syncPlanOptions(out.json.availablePlans);
            renderSummary(out.json);
            renderTable(out.json.items);
          }

          async function loadCrmUser(waId){
            if (!waId) return;
            const out = await fetchJson("/admin/crm/user?waId=" + encodeURIComponent(waId));
            if (!out.response.ok || !out.json.ok) {
              els.detail.innerHTML = '<div class="muted">Falha ao carregar a ficha do usuário.</div>';
              openDetailModal("Ficha do usuário");
              return;
            }
            state.currentAvailablePlans = Array.isArray(out.json.availablePlans) ? out.json.availablePlans : [];
            renderDetail(out.json.user);
          }

          function resetCrmFilters(){
            if (els.q) els.q.value = "";
            if (els.status) els.status.value = "ALL";
            if (els.plan) els.plan.value = "ALL";
            if (els.payment) els.payment.value = "ALL";
            if (els.hasName) els.hasName.value = "ALL";
            if (els.hasSubscription) els.hasSubscription.value = "ALL";
            if (els.hasBizProfile) els.hasBizProfile.value = "ALL";
            if (els.hasInconsistency) els.hasInconsistency.value = "ALL";
            if (els.inWindow) els.inWindow.value = "ALL";
            if (els.limit) els.limit.value = "200";
            loadCrm();
          }

          if (els.reloadBtn) {
            els.reloadBtn.addEventListener("click", loadCrm);
          }
          if (els.resetBtn) {
            els.resetBtn.addEventListener("click", resetCrmFilters);
          }
          if (els.tbody) {
            els.tbody.addEventListener("click", function(ev){
              const button = ev.target.closest("button[data-action='open-crm-user']");
              if (!button) return;
              loadCrmUser(button.getAttribute("data-wa-id") || "");
            });
          }
          if (els.modal) {
            els.modal.addEventListener("click", function(ev){
              if (ev.target.closest("[data-action='close-crm-modal']")) {
                closeDetailModal();
                return;
              }
              if (ev.target.closest("[data-action='edit-crm-user']")) {
                renderEditForm(state.currentUser);
                return;
              }
              if (ev.target.closest("[data-action='cancel-crm-user-edit']")) {
                renderDetail(state.currentUser);
                return;
              }
              if (ev.target.closest("[data-action='save-crm-user-edit']")) {
                saveCrmUserEdit();
              }
            });
          }
          if (els.closeModalBtn) {
            els.closeModalBtn.addEventListener("click", closeDetailModal);
          }
          document.addEventListener("keydown", function(ev){
            if (ev.key === "Escape") closeDetailModal();
          });

          const params = new URLSearchParams(window.location.search);
          const waId = String(params.get("waId") || "").trim();
          if (waId && els.q) els.q.value = waId;

          loadCrm().then(function(){
            if (waId) loadCrmUser(waId);
          });
        });
      </script>
    `;

    const headExtra = `
      <style>
        .crm-modal{ position:fixed; inset:0; display:none; align-items:center; justify-content:center; padding:24px; z-index:60; }
        .crm-modal.open{ display:flex; }
        .crm-modal-backdrop{ position:absolute; inset:0; background:rgba(15,23,42,.55); }
        .crm-modal-panel{ position:relative; width:min(1120px, calc(100vw - 32px)); max-height:calc(100vh - 48px); overflow:auto; background:#fff; border:1px solid var(--border); border-radius:18px; box-shadow:0 20px 48px rgba(15,23,42,.22); padding:18px; }
        .crm-modal-header{ display:flex; align-items:flex-start; justify-content:space-between; gap:12px; position:sticky; top:0; background:#fff; padding-bottom:4px; z-index:1; }
        .crm-modal-body{ min-height:120px; }
        .crm-modal-panel .grid.cols2{ grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .crm-modal-panel pre{ max-width:100%; overflow:auto; background:#f8fafc; border:1px solid var(--border); border-radius:12px; padding:12px; }
        @media (max-width: 980px){
          .crm-modal{ padding:12px; }
          .crm-modal-panel{ width:calc(100vw - 24px); max-height:calc(100vh - 24px); padding:14px; }
          .crm-modal-panel .grid.cols2{ grid-template-columns:1fr; }
          .crm-modal-header{ position:static; }
        }
      </style>
    `;

    const html = layoutBase({
      title: "CRM de Usuários",
      activePath: "/admin/crm-ui",
      content: inner,
      headExtra,
      scriptExtra,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/reports/data", async (req, res) => {
    try {
      const data = await buildReportsCenterData(buildExecutiveDashboardData);
      return res.status(200).json(data);
    } catch (err) {
      const message = String(err?.message || err);
      return res.status(200).json(buildReportsFallbackData(message));
    }
  });

  router.get("/export/users", async (req, res) => {
    try {
      const format = normalizeExportFormat(req.query?.format);
      const rows = await buildExportUsersRows();
      if (format === "json") {
        return sendExport(res, "amigo_usuarios", "json", { ok: true, exportedAt: new Date().toISOString(), count: rows.length, items: rows });
      }
      return sendExport(res, "amigo_usuarios", format, rows, { title: "Usuários do CRM" });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/export/inconsistencies", async (req, res) => {
    try {
      const format = normalizeExportFormat(req.query?.format);
      const rows = await buildExportInconsistencyRows();
      if (format === "json") {
        return sendExport(res, "amigo_inconsistencias", "json", { ok: true, exportedAt: new Date().toISOString(), count: rows.length, items: rows });
      }
      return sendExport(res, "amigo_inconsistencias", format, rows, { title: "Inconsistências" });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/export/audit", async (req, res) => {
    try {
      const format = normalizeExportFormat(req.query?.format);
      const rows = await buildExportAuditRows();
      if (format === "json") {
        return sendExport(res, "amigo_auditoria", "json", { ok: true, exportedAt: new Date().toISOString(), count: rows.length, items: rows });
      }
      return sendExport(res, "amigo_auditoria", format, rows, { title: "Auditoria Administrativa" });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/export/executive", async (req, res) => {
    try {
      const format = normalizeExportFormat(req.query?.format);
      const data = await buildReportsCenterData(buildExecutiveDashboardData);
      if (format === "json") {
        return sendExport(res, "amigo_relatorio_executivo", "json", data);
      }

      const rows = buildExecutiveExportRows(data);
      return sendExport(res, "amigo_relatorio_executivo", format, rows, { title: "Relatório Executivo" });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/export/finance-saas", async (req, res) => {
    try {
      const format = normalizeExportFormat(req.query?.format);
      const data = await buildFinanceSaasDashboardData();
      if (format === "json") {
        return sendExport(res, "amigo_financeiro_saas", "json", data);
      }

      const rows = buildFinanceSaasExportRows(data);
      return sendExport(res, "amigo_financeiro_saas", format, rows, { title: "Dashboard Financeiro SaaS" });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });


  router.get("/export/coupons", async (req, res) => {
    try {
      const format = normalizeExportFormat(req.query?.format);
      const rows = await buildExportCouponRows(req.query || {});
      if (format === "json") {
        return sendExport(res, "amigo_cupons", "json", { ok: true, exportedAt: new Date().toISOString(), count: rows.length, items: rows });
      }
      return sendExport(res, "amigo_cupons", format, rows, { title: "Relatório de Cupons" });
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/coupon-report/data", async (req, res) => {
    try {
      const data = await buildCouponReportData(req.query || {});
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/coupon-report-ui", async (req, res) => {
    const inner = `
      <div class="card pad" style="margin-bottom:14px;">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
          <div>
            <h3 style="margin:0 0 6px 0;">🏷️ Relatório de Cupons</h3>
            <div class="muted">Visão consolidada de cupons, reservas, status, impacto financeiro e exportação.</div>
          </div>
          <div class="row">
            <a class="pill" href="/admin/coupons">Produto → Cupons</a>
            <a class="pill" href="/admin/reports-ui">Central de Relatórios</a>
            <button type="button" class="primary" id="couponReportReloadBtn">Atualizar</button>
          </div>
        </div>
      </div>

      <div class="grid cols3">
        <div class="kpi"><div class="t">Cupons cadastrados</div><div class="v" id="crTotalCoupons">—</div><div class="muted">Base ativa + inativa</div></div>
        <div class="kpi"><div class="t">Reservas registradas</div><div class="v" id="crTotalReservations">—</div><div class="muted">Inclui reservas e usos</div></div>
        <div class="kpi"><div class="t">Desconto concedido</div><div class="v" id="crDiscount">—</div><div class="muted" id="crRevenue">—</div></div>
      </div>

      <div class="card pad" style="margin-top:14px;">
        <div class="row" style="justify-content:space-between;">
          <h4 style="margin:0;">Exportações rápidas</h4>
          <span class="muted">CSV, Excel, PDF ou JSON</span>
        </div>
        <div class="hr"></div>
        <div class="row">
          <a class="pill" href="/admin/export/coupons?format=csv">CSV</a>
          <a class="pill" href="/admin/export/coupons?format=excel">Excel</a>
          <a class="pill" href="/admin/export/coupons?format=pdf">PDF</a>
          <a class="pill" href="/admin/export/coupons?format=json">JSON</a>
        </div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Resumo por cupom</h4><span class="muted">Uso e elegibilidade</span></div>
          <div class="hr"></div>
          <div style="overflow:auto;"><table><thead><tr><th>Código</th><th>Nome</th><th>Ativo</th><th>Desconto</th><th>Ciclos</th><th>Planos</th><th>Reservas</th><th>Confirmados</th></tr></thead><tbody id="couponSummaryRows"><tr><td colspan="8" class="muted">Carregando...</td></tr></tbody></table></div>
        </div>
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Eventos recentes</h4><span class="muted">Últimas movimentações</span></div>
          <div class="hr"></div>
          <div style="overflow:auto;"><table><thead><tr><th>Data</th><th>Cupom</th><th>Status</th><th>Plano</th><th>Ciclo</th><th>Desconto</th><th>Valor Final</th></tr></thead><tbody id="couponReportRows"><tr><td colspan="7" class="muted">Carregando...</td></tr></tbody></table></div>
        </div>
      </div>

      <script>
        function moneyCents(v){
          try{
            return new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format((Number(v||0))/100);
          }catch(_){
            return 'R$ ' + (((Number(v||0))/100).toFixed(2));
          }
        }
        function esc(s){
          return String(s ?? '').replace(/[&<>"']/g, (m)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
        }
        async function loadCouponReport(){
          const r = await fetch('/admin/coupon-report/data');
          const j = await r.json().catch(()=>({ ok:false, rows:[], coupons:[], summary:{} }));
          const summary = j.summary || {};
          document.getElementById('crTotalCoupons').textContent = String(summary.totalCoupons || 0);
          document.getElementById('crTotalReservations').textContent = String(summary.totalReservations || 0);
          document.getElementById('crDiscount').textContent = moneyCents(summary.totalDiscountCents || 0);
          document.getElementById('crRevenue').textContent = 'Valor final: ' + moneyCents(summary.totalFinalCents || 0);

          const couponRows = Array.isArray(j.coupons) ? j.coupons : [];
          document.getElementById('couponSummaryRows').innerHTML = couponRows.length ? couponRows.map((item)=>{
            const coupon = item.coupon || {};
            const usage = item.usage || {};
            return '<tr>'
              + '<td><code>' + esc(coupon.couponCode || coupon.code || '') + '</code></td>'
              + '<td>' + esc(coupon.name || '') + '</td>'
              + '<td>' + (coupon.active ? '✅' : '❌') + '</td>'
              + '<td>' + esc(coupon.discountType === 'percent' ? ((coupon.discountValue||0) + '%' + ((coupon.discountCap||0) ? ' (teto ' + moneyCents(coupon.discountCap||0) + ')' : '')) : moneyCents(coupon.discountValue||0)) + '</td>'
              + '<td>' + esc((coupon.eligibleBillingCycles||[]).join(', ') || 'Todos') + '</td>'
              + '<td>' + esc((coupon.eligiblePlanCodes||[]).join(', ') || 'Todos') + '</td>'
              + '<td>' + esc(String(usage.totalReservations || 0)) + '</td>'
              + '<td>' + esc(String(usage.confirmedReservations || 0)) + '</td>'
              + '</tr>';
          }).join('') : '<tr><td colspan="8" class="muted">Nenhum cupom encontrado.</td></tr>';

          const reportRows = Array.isArray(j.rows) ? j.rows : [];
          document.getElementById('couponReportRows').innerHTML = reportRows.length ? reportRows.slice(0, 80).map((row)=>{
            return '<tr>'
              + '<td>' + esc(row.ts || row.createdAt || '') + '</td>'
              + '<td><code>' + esc(row.couponCode || '') + '</code></td>'
              + '<td>' + esc(row.status || '') + '</td>'
              + '<td>' + esc(row.planCode || '') + '</td>'
              + '<td>' + esc(row.billingCycle || '') + '</td>'
              + '<td>' + esc(moneyCents(row.discountCents || row.discountAmountCents || 0)) + '</td>'
              + '<td>' + esc(moneyCents(row.finalCents || row.finalPriceCents || 0)) + '</td>'
              + '</tr>';
          }).join('') : '<tr><td colspan="7" class="muted">Nenhum evento de cupom encontrado.</td></tr>';
        }
        document.getElementById('couponReportReloadBtn').addEventListener('click', loadCouponReport);
        loadCouponReport();
      </script>
    `;
    const html = layoutBase({ title: "Relatório de Cupons", activePath: "/admin/coupon-report-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/reports-ui", async (req, res) => {
    const inner = `
      <div class="card pad" style="margin-bottom:14px;">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
          <div>
            <h3 style="margin:0 0 6px 0;">📑 Central de Relatórios e Exportação</h3>
            <div class="muted">Relatórios executivos, visão operacional da base e exportação de dados do sistema.</div>
          </div>
          <div class="row">
            <a class="pill" href="/admin/executive-ui">Dashboard Executivo</a>
            <a class="pill" href="/admin/finance-saas-ui">Financeiro SaaS</a>
            <a class="pill" href="/admin/audit-ui">Auditoria</a>
            <a class="pill" href="/admin/inconsistencies-ui">Inconsistências</a>
            <a class="pill" href="/admin/coupon-report-ui">Relatório de Cupons</a>
            <button type="button" class="primary" id="reportsReloadBtn">Atualizar</button>
          </div>
        </div>
      </div>

      <div class="grid cols3">
        <div class="kpi"><div class="t">Usuários totais</div><div class="v" id="rpTotalUsers">—</div><div class="muted" id="rpActiveShare">—</div></div>
        <div class="kpi"><div class="t">MRR estimado</div><div class="v" id="rpMrr">—</div><div class="muted" id="rpAvgTicket">—</div></div>
        <div class="kpi"><div class="t">Auditoria armazenada</div><div class="v" id="rpAuditTotal">—</div><div class="muted" id="rpAuditRecent">—</div></div>
      </div>

      <div class="grid cols3" style="margin-top:12px;">
        <div class="kpi"><div class="t">Descrições no mês</div><div class="v" id="rpDescMonth">—</div><div class="muted" id="rp24hUsers">—</div></div>
        <div class="kpi"><div class="t">Perfis com empresa salva</div><div class="v" id="rpBizProfiles">—</div><div class="muted" id="rpBizCoverage">—</div></div>
        <div class="kpi"><div class="t">Usuários com inconsistência</div><div class="v" id="rpIssueUsers">—</div><div class="muted" id="rpIssuePct">—</div></div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <h4 style="margin:0;">Exportações rápidas</h4>
            <span class="muted">CSV, Excel, PDF ou JSON</span>
          </div>
          <div class="hr"></div>
          <div class="grid cols2">
            <div class="card pad">
              <b>Usuários do CRM</b>
              <div class="muted" style="margin:6px 0 10px 0;">Base completa dos usuários com status, plano, pagamento e saúde.</div>
              <div class="row">
                <a class="pill" href="/admin/export/users?format=csv">CSV</a>
                <a class="pill" href="/admin/export/users?format=excel">Excel</a>
                <a class="pill" href="/admin/export/users?format=pdf">PDF</a>
                <a class="pill" href="/admin/export/users?format=json">JSON</a>
              </div>
            </div>
            <div class="card pad">
              <b>Inconsistências</b>
              <div class="muted" style="margin:6px 0 10px 0;">Ocorrências operacionais detalhadas por usuário.</div>
              <div class="row">
                <a class="pill" href="/admin/export/inconsistencies?format=csv">CSV</a>
                <a class="pill" href="/admin/export/inconsistencies?format=excel">Excel</a>
                <a class="pill" href="/admin/export/inconsistencies?format=pdf">PDF</a>
                <a class="pill" href="/admin/export/inconsistencies?format=json">JSON</a>
              </div>
            </div>
            <div class="card pad">
              <b>Auditoria administrativa</b>
              <div class="muted" style="margin:6px 0 10px 0;">Eventos mais recentes do painel administrativo.</div>
              <div class="row">
                <a class="pill" href="/admin/export/audit?format=csv">CSV</a>
                <a class="pill" href="/admin/export/audit?format=excel">Excel</a>
                <a class="pill" href="/admin/export/audit?format=pdf">PDF</a>
                <a class="pill" href="/admin/export/audit?format=json">JSON</a>
              </div>
            </div>
            <div class="card pad">
              <b>Resumo executivo</b>
              <div class="muted" style="margin:6px 0 10px 0;">Indicadores consolidados para acompanhamento gerencial.</div>
              <div class="row">
                <a class="pill" href="/admin/export/executive?format=csv">CSV</a>
                <a class="pill" href="/admin/export/executive?format=excel">Excel</a>
                <a class="pill" href="/admin/export/executive?format=pdf">PDF</a>
                <a class="pill" href="/admin/export/executive?format=json">JSON</a>
              </div>
            </div>
            <div class="card pad">
              <b>Relatório de Cupons</b>
              <div class="muted" style="margin:6px 0 10px 0;">Uso de cupons, reservas, confirmações, falhas e impacto financeiro.</div>
              <div class="row" style="margin-bottom:10px;">
                <a class="pill" href="/admin/coupon-report-ui">Abrir relatório</a>
              </div>
              <div class="row">
                <a class="pill" href="/admin/export/coupons?format=csv">CSV</a>
                <a class="pill" href="/admin/export/coupons?format=excel">Excel</a>
                <a class="pill" href="/admin/export/coupons?format=pdf">PDF</a>
                <a class="pill" href="/admin/export/coupons?format=json">JSON</a>
              </div>
            </div>
            <div class="card pad">
              <b>Dashboard Financeiro SaaS</b>
              <div class="muted" style="margin:6px 0 10px 0;">MRR, ARR, conversão, métodos de pagamento, top planos, top cidades, top estados, evolução mensal e pagamentos recentes.</div>
              <div class="row" style="margin-bottom:10px;">
                <a class="pill" href="/admin/finance-saas-ui">Abrir dashboard</a>
              </div>
              <div class="row">
                <a class="pill" href="/admin/export/finance-saas?format=csv">CSV</a>
                <a class="pill" href="/admin/export/finance-saas?format=excel">Excel</a>
                <a class="pill" href="/admin/export/finance-saas?format=pdf">PDF</a>
                <a class="pill" href="/admin/export/finance-saas?format=json">JSON</a>
              </div>
            </div>
          </div>
        </div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between;">
            <h4 style="margin:0;">Resumo operacional</h4>
            <span class="muted">Status e cobertura</span>
          </div>
          <div class="hr"></div>
          <canvas id="reportsStatusChart" width="900" height="280" style="width:100%; border:1px solid var(--border); border-radius:12px;"></canvas>
          <div class="hr"></div>
          <canvas id="reportsPlansChart" width="900" height="280" style="width:100%; border:1px solid var(--border); border-radius:12px;"></canvas>
        </div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Planos e MRR</h4><span class="muted">Ranking atual</span></div>
          <div class="hr"></div>
          <div style="overflow:auto;"><table><thead><tr><th>Plano</th><th>Usuários</th><th>MRR</th><th>Descrição</th></tr></thead><tbody id="reportsPlansRows"><tr><td colspan="4" class="muted">Carregando...</td></tr></tbody></table></div>
        </div>
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Top cidades / região</h4><span class="muted">billingCityState</span></div>
          <div class="hr"></div>
          <div style="overflow:auto;"><table><thead><tr><th>Local</th><th>Usuários</th></tr></thead><tbody id="reportsCitiesRows"><tr><td colspan="2" class="muted">Carregando...</td></tr></tbody></table></div>
        </div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Módulos mais auditados</h4><span class="muted">Últimos eventos</span></div>
          <div class="hr"></div>
          <div id="reportsModulePills" class="muted">Carregando...</div>
          <div class="hr"></div>
          <div id="reportsActionPills" class="muted">Carregando...</div>
        </div>
        <div class="card pad">
          <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Resumo de inconsistências</h4><span class="muted">Painel consolidado</span></div>
          <div class="hr"></div>
          <div style="overflow:auto;"><table><thead><tr><th>Indicador</th><th>Nível</th><th>Qtd.</th></tr></thead><tbody id="reportsIssuesRows"><tr><td colspan="3" class="muted">Carregando...</td></tr></tbody></table></div>
        </div>
      </div>

      <div class="card pad" style="margin-top:14px;">
        <div class="row" style="justify-content:space-between;"><h4 style="margin:0;">Últimos eventos de auditoria</h4><span class="muted">Leitura rápida</span></div>
        <div class="hr"></div>
        <div style="overflow:auto;"><table><thead><tr><th>Quando</th><th>Módulo</th><th>Ação</th><th>Alvo</th><th>Resumo</th><th>Responsável</th></tr></thead><tbody id="reportsAuditRows"><tr><td colspan="6" class="muted">Carregando...</td></tr></tbody></table></div>
      </div>

      <div class="card pad" style="margin-top:14px;">
        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="reportsRaw" style="white-space:pre-wrap; overflow:auto; max-height:360px;"></pre>
        </details>
      </div>
    `;

    const scriptExtra = `
      <script>
        document.addEventListener("DOMContentLoaded", function(){
          function esc(value){
            return String(value ?? "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#39;");
          }
          function setText(id, value){
            const el = document.getElementById(id);
            if (el) el.textContent = String(value ?? "—");
          }
          function fmtBRL(cents){
            const value = (Number(cents) || 0) / 100;
            try { return value.toLocaleString("pt-BR", { style:"currency", currency:"BRL" }); }
            catch (_) { return "R$ " + value.toFixed(2); }
          }
          function fmtPct(value){
            const n = Number(value || 0);
            return n.toFixed(1).replace(".", ",") + "%";
          }
          function fmtTs(value){
            if (!value) return "—";
            const d = new Date(value);
            if (Number.isNaN(d.getTime())) return String(value);
            return d.toLocaleString("pt-BR");
          }
          function severityBadge(severity){
            const s = String(severity || "soft").toLowerCase();
            const cls = ["danger","warn","info","ok"].includes(s) ? s : "soft";
            const label = cls === "danger" ? "Crítico" : cls === "warn" ? "Atenção" : cls === "info" ? "Info" : "OK";
            return '<span class="badge ' + cls + '">' + label + '</span>';
          }
          function renderPills(containerId, items, formatter){
            const el = document.getElementById(containerId);
            if (!el) return;
            if (!Array.isArray(items) || !items.length) {
              el.innerHTML = '<span class="muted">Sem dados.</span>';
              return;
            }
            el.innerHTML = items.map(function(item){ return formatter(item); }).join(' ');
          }
          function drawBarChart(canvasId, labels, values){
            const canvas = document.getElementById(canvasId);
            if (!canvas) return;
            const ctx = canvas.getContext("2d");
            const w = canvas.width;
            const h = canvas.height;
            ctx.clearRect(0, 0, w, h);
            if (!labels.length) {
              ctx.fillStyle = "#64748b";
              ctx.font = "14px system-ui";
              ctx.fillText("Sem dados", 12, 22);
              return;
            }
            const max = Math.max(1, ...values.map(function(v){ return Number(v || 0); }));
            const pad = { top: 20, right: 12, bottom: 56, left: 40 };
            const innerW = w - pad.left - pad.right;
            const innerH = h - pad.top - pad.bottom;
            const step = innerW / labels.length;
            const barW = Math.max(24, Math.min(84, step * 0.62));
            ctx.strokeStyle = "#cbd5e1";
            ctx.beginPath();
            ctx.moveTo(pad.left, pad.top);
            ctx.lineTo(pad.left, pad.top + innerH);
            ctx.lineTo(pad.left + innerW, pad.top + innerH);
            ctx.stroke();
            labels.forEach(function(label, index){
              const value = Number(values[index] || 0);
              const x = pad.left + step * index + (step - barW) / 2;
              const barH = innerH * (value / max);
              const y = pad.top + innerH - barH;
              ctx.fillStyle = "rgba(37,99,235,.28)";
              ctx.strokeStyle = "rgba(37,99,235,.60)";
              ctx.lineWidth = 1;
              ctx.beginPath();
              if (typeof ctx.roundRect === "function") {
                ctx.roundRect(x, y, barW, barH, 10);
              } else {
                ctx.rect(x, y, barW, barH);
              }
              ctx.fill();
              ctx.stroke();
              ctx.fillStyle = "#0f172a";
              ctx.font = "12px system-ui";
              const valLabel = String(value);
              const valW = ctx.measureText(valLabel).width;
              ctx.fillText(valLabel, x + (barW - valW) / 2, Math.max(14, y - 6));
              const shortLabel = String(label || "").length > 14 ? String(label).slice(0, 14) + "…" : String(label || "");
              const labelW = ctx.measureText(shortLabel).width;
              ctx.fillText(shortLabel, x + (barW - labelW) / 2, pad.top + innerH + 18);
            });
          }
          async function loadReports(){
            const response = await fetch("/admin/reports/data");
            const data = await response.json().catch(function(){ return {}; });
            document.getElementById("reportsRaw").textContent = JSON.stringify(data, null, 2);
            if (!response.ok || !data.ok) {
              document.getElementById("reportsModulePills").innerHTML = '<span class="muted">Falha ao carregar os dados.</span>';
              document.getElementById("reportsActionPills").innerHTML = '<span class="muted">Falha ao carregar os dados.</span>';
              document.getElementById("reportsPlansRows").innerHTML = '<tr><td colspan="4" class="muted">Falha ao carregar os dados.</td></tr>';
              document.getElementById("reportsCitiesRows").innerHTML = '<tr><td colspan="2" class="muted">Falha ao carregar os dados.</td></tr>';
              document.getElementById("reportsIssuesRows").innerHTML = '<tr><td colspan="3" class="muted">Falha ao carregar os dados.</td></tr>';
              document.getElementById("reportsAuditRows").innerHTML = '<tr><td colspan="6" class="muted">Falha ao carregar os dados.</td></tr>';
              return;
            }
            const executive = data.executive || {};
            const overview = executive.overview || {};
            const revenue = executive.revenue || {};
            const usage = executive.usage || {};
            const quality = executive.quality || {};
            const plans = Array.isArray(executive.plans) ? executive.plans : [];
            const cities = Array.isArray(executive.cities) ? executive.cities : [];
            const issues = Array.isArray(executive?.inconsistencies?.summary) ? executive.inconsistencies.summary : [];
            const audit = data.audit || {};
            const auditItems = Array.isArray(audit.items) ? audit.items : [];
            if (data.warning) {
              document.getElementById("reportsModulePills").innerHTML = '<span class="badge warn">Modo contingência</span> <span class="muted">' + esc(data.warning) + '</span>';
            }
            const modules = Array.isArray(audit.modules) ? audit.modules : [];
            const actions = Array.isArray(audit.actions) ? audit.actions : [];

            setText("rpTotalUsers", overview.totalUsers || 0);
            setText("rpActiveShare", "Ativação da base: " + fmtPct(overview.activeSharePct || 0));
            setText("rpMrr", fmtBRL(revenue.mrrCents || 0));
            setText("rpAvgTicket", "Ticket médio: " + fmtBRL(revenue.avgTicketCents || 0));
            setText("rpAuditTotal", audit.totalStored || 0);
            setText("rpAuditRecent", "Últimos eventos carregados: " + (audit.recentCount || 0));
            setText("rpDescMonth", usage.descriptionsMonth || 0);
            setText("rp24hUsers", "Usuários ativos 24h: " + String(usage.window24hCount || 0));
            setText("rpBizProfiles", quality.withBizProfile || 0);
            setText("rpBizCoverage", "Cobertura: " + fmtPct(quality.profileCoveragePct || 0));
            setText("rpIssueUsers", quality.issueUsers || 0);
            setText("rpIssuePct", "Impacto: " + fmtPct(quality.inconsistencyPct || 0));

            drawBarChart("reportsStatusChart", Object.keys(executive.statusCounts || {}), Object.values(executive.statusCounts || {}));
            drawBarChart("reportsPlansChart", plans.slice(0, 6).map(function(plan){ return plan.name || plan.code || "Plano"; }), plans.slice(0, 6).map(function(plan){ return plan.count || 0; }));

            const plansRows = plans.map(function(plan){
              return '<tr>' +
                '<td><b>' + esc(plan.name || plan.code || "—") + '</b><div class="muted"><code>' + esc(plan.code || "") + '</code></div></td>' +
                '<td>' + esc(plan.count || 0) + '</td>' +
                '<td>' + esc(fmtBRL(plan.mrrCents || 0)) + '</td>' +
                '<td>' + esc(plan.description || "—") + '</td>' +
              '</tr>';
            }).join('');
            document.getElementById("reportsPlansRows").innerHTML = plansRows || '<tr><td colspan="4" class="muted">Sem dados.</td></tr>';

            const citiesRows = cities.map(function(item){
              return '<tr><td>' + esc(item.city || "—") + '</td><td>' + esc(item.count || 0) + '</td></tr>';
            }).join('');
            document.getElementById("reportsCitiesRows").innerHTML = citiesRows || '<tr><td colspan="2" class="muted">Sem dados.</td></tr>';

            renderPills("reportsModulePills", modules, function(item){
              return '<span class="pill">' + esc(item.name || "—") + ': <b>' + esc(item.count || 0) + '</b></span>';
            });
            renderPills("reportsActionPills", actions, function(item){
              return '<span class="pill">' + esc(item.name || "—") + ': <b>' + esc(item.count || 0) + '</b></span>';
            });

            const issueRows = issues.map(function(issue){
              return '<tr>' +
                '<td><b>' + esc(issue.label || "—") + '</b></td>' +
                '<td>' + severityBadge(issue.severity) + '</td>' +
                '<td><b>' + esc(issue.count || 0) + '</b></td>' +
              '</tr>';
            }).join('');
            document.getElementById("reportsIssuesRows").innerHTML = issueRows || '<tr><td colspan="3" class="muted">Sem inconsistências.</td></tr>';

            const auditRows = auditItems.map(function(item){
              return '<tr>' +
                '<td><code>' + esc(fmtTs(item.ts)) + '</code></td>' +
                '<td>' + esc(item.module || "—") + '</td>' +
                '<td>' + esc(item.action || "—") + '</td>' +
                '<td><code>' + esc(item.waId || item.targetId || "—") + '</code></td>' +
                '<td style="max-width:420px; white-space:pre-wrap;">' + esc(item.summary || "—") + '</td>' +
                '<td>' + esc(item?.actor?.user || "admin") + '</td>' +
              '</tr>';
            }).join('');
            document.getElementById("reportsAuditRows").innerHTML = auditRows || '<tr><td colspan="6" class="muted">Sem eventos recentes.</td></tr>';
          }

          const reloadBtn = document.getElementById("reportsReloadBtn");
          if (reloadBtn) reloadBtn.addEventListener("click", loadReports);
          loadReports();
        });
      </script>
    `;

    const html = layoutBase({
      title: "Relatórios e Exportação",
      activePath: "/admin/reports-ui",
      content: inner,
      scriptExtra,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/feedback/data", async (req, res) => {
    try {
      const data = await buildFeedbackCenterData();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/feedback/review-status", async (req, res) => {
    try {
      const userId = await requireBodyUserRef(req);
      const status = String(req.body?.status || "").trim().toUpperCase();
      if (!["PENDING_REVIEW", "APPROVED", "REJECTED", "PUBLISHED", "INTERNAL_ONLY"].includes(status)) {
        return res.status(400).json({ ok: false, error: "invalid status" });
      }
      const [beforeUser, identifiers] = await Promise.all([
        getUserSnapshot(userId),
        getUserIdentifiers(userId).catch(() => null),
      ]);
      const beforeStatus = String(beforeUser?.growthMeta?.testimonialStatus || "").trim().toUpperCase();
      await setTestimonialReviewStatus(userId, status);
      if (status !== beforeStatus) {
        if (status === 'APPROVED') await incMetricEvent('testimonial_review_approved', { userId });
        if (status === 'REJECTED') await incMetricEvent('testimonial_review_rejected', { userId });
        if (status === 'PUBLISHED') await incMetricEvent('testimonial_review_published', { userId });
      }
      const user = await getUserSnapshot(userId);
      await safeRecordAdminAudit(req, {
        module: "feedback",
        action: "SET_TESTIMONIAL_STATUS",
        waId: identifiers?.waId || beforeUser?.waId || "",
        targetId: userId,
        summary: `Atualizou o status do depoimento de ${userId} para ${status}.`,
        before: buildAuditUserSnapshot(beforeUser),
        after: buildAuditUserSnapshot(user),
        meta: { status, userId },
      });
      return res.json({ ok: true, userId, waId: identifiers?.waId || user.waId || "", status, user });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/feedback-ui", async (req, res) => {
    const inner = `
      <div class="card pad" style="margin-bottom:14px;">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
          <div>
            <h3 style="margin:0 0 6px 0;">💚 Avaliações e depoimentos</h3>
            <div class="muted">Acompanhe a satisfação dos usuários, comentários livres e depoimentos coletados pelo WhatsApp.</div>
          </div>
          <button class="primary" id="feedbackReloadBtn">Atualizar</button>
        </div>
      </div>

      <div class="grid cols-4" style="margin-bottom:14px;">
        <div class="card pad"><div class="t">Feedbacks respondidos</div><div class="v" id="fbAnswered">—</div><div class="muted" id="fbAsked">—</div></div>
        <div class="card pad"><div class="t">Satisfação positiva</div><div class="v" id="fbPositivePct">—</div><div class="muted" id="fbPositiveRaw">—</div></div>
        <div class="card pad"><div class="t">Depoimentos recebidos</div><div class="v" id="fbTestimonials">—</div><div class="muted" id="fbConsented">—</div></div>
        <div class="card pad"><div class="t">Fila de revisão</div><div class="v" id="fbPending">—</div><div class="muted" id="fbPublished">—</div></div>
      </div>

      <div class="card pad" style="margin-bottom:14px;">
        <div class="row" style="gap:8px; flex-wrap:wrap; margin-bottom:10px;">
          <span class="pill">🙂 Positivos: <b id="fbPositiveCount">—</b></span>
          <span class="pill">😐 Neutros: <b id="fbNeutralCount">—</b></span>
          <span class="pill">🙁 Negativos: <b id="fbNegativeCount">—</b></span>
          <span class="pill">💬 Comentários: <b id="fbComments">—</b></span>
          <span class="pill">✅ Autorizados: <b id="fbAuthorized">—</b></span>
        </div>
        <div class="muted">Os depoimentos autorizados entram como <b>PENDENTE_REVIEW</b> até alguém aprovar no Admin.</div>
        <div class="muted" id="fbMetricsNote" style="margin-top:8px;">Telemetria dedicada de feedback: carregando…</div>
      </div>

      <div class="card pad">
        <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:10px;">
          <h4 style="margin:0;">Registros coletados</h4>
          <input id="feedbackFilter" type="text" placeholder="Filtrar por nome, empresa, número ou trecho do comentário" style="min-width:280px;" />
        </div>
        <div style="overflow:auto;">
          <table>
            <thead>
              <tr>
                <th>Quando</th>
                <th>Usuário</th>
                <th>Avaliação</th>
                <th>Comentário</th>
                <th>Depoimento</th>
                <th>Uso público</th>
                <th>Status</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody id="feedbackRows"><tr><td colspan="8" class="muted">Carregando…</td></tr></tbody>
          </table>
        </div>
      </div>
    `;

    const scriptExtra = `
      <script>
        (function(){
          function esc(v){
            return String(v == null ? '' : v)
              .replaceAll('&','&amp;')
              .replaceAll('<','&lt;')
              .replaceAll('>','&gt;')
              .replaceAll('"','&quot;')
              .replaceAll("'", '&#39;');
          }
          function fmtTs(v){
            const s = String(v || '');
            if (!s) return '—';
            const d = new Date(s);
            if (Number.isNaN(d.getTime())) return esc(s);
            return d.toLocaleString('pt-BR');
          }
          function setText(id, value){
            const el = document.getElementById(id);
            if (el) el.textContent = String(value == null ? '' : value);
          }
          function reviewButtons(item){
            if (!(item && item.testimonialText && item.testimonialConsent === 'YES')) return '—';
            const actions = [
              ['APPROVED', '✅ Aprovar'],
              ['REJECTED', '⛔ Rejeitar'],
              ['PUBLISHED', '🚀 Publicado']
            ];
            return actions.map(function(entry){
              const disabled = item.testimonialStatus === entry[0] ? 'disabled' : '';
              return '<button class="pill" data-waid="' + esc(item.waId) + '" data-status="' + esc(entry[0]) + '" ' + disabled + '>' + esc(entry[1]) + '</button>';
            }).join(' ');
          }
          let allItems = [];
          async function load(){
            const r = await fetch('/admin/feedback/data');
            const j = await r.json();
            const summary = j.summary || {};
            allItems = Array.isArray(j.items) ? j.items : [];
            setText('fbAnswered', summary.feedbackAnswered || 0);
            setText('fbAsked', 'Perguntados: ' + String(summary.feedbackAsked || 0));
            setText('fbPositivePct', String(summary.positivePct || 0).replace('.', ',') + '%');
            setText('fbPositiveRaw', String(summary.positive || 0) + ' positivos');
            setText('fbTestimonials', summary.testimonials || 0);
            setText('fbConsented', 'Autorizados: ' + String(summary.consented || 0));
            setText('fbPending', summary.pendingReview || 0);
            setText('fbPublished', 'Publicados: ' + String(summary.published || 0));
            setText('fbPositiveCount', summary.positive || 0);
            setText('fbNeutralCount', summary.neutral || 0);
            setText('fbNegativeCount', summary.negative || 0);
            setText('fbComments', summary.comments || 0);
            setText('fbAuthorized', summary.consented || 0);
            const metrics = j.metrics && j.metrics.ok ? j.metrics : null;
            const events = metrics && metrics.events ? metrics.events : {};
            const answeredDay = Number(((events.feedback_answered || {}).dayCount) || 0);
            const answeredMonth = Number(((events.feedback_answered || {}).monthCount) || 0);
            const createdMonth = Number(((events.testimonial_created || {}).monthCount) || 0);
            const consentMonth = Number(((events.testimonial_consent_yes || {}).monthCount) || 0);
            setText('fbMetricsNote', metrics ? ('Telemetria dedicada: ' + answeredDay + ' respostas hoje • ' + answeredMonth + ' respostas no mês • ' + createdMonth + ' depoimentos no mês • ' + consentMonth + ' autorizações no mês') : 'Telemetria dedicada indisponível no momento.');
            renderRows();
          }
          function renderRows(){
            const q = String((document.getElementById('feedbackFilter') || {}).value || '').trim().toLowerCase();
            const rows = allItems.filter(function(item){
              if (!q) return true;
              const hay = [item.waId, item.fullName, item.companyName, item.feedbackComment, item.testimonialText, item.testimonialDisplayName, item.feedbackResponseLabel, item.testimonialStatus].join(' ').toLowerCase();
              return hay.includes(q);
            }).map(function(item){
              const who = item.fullName || item.companyName || item.waId || '—';
              const company = item.companyName ? '<div class="muted">' + esc(item.companyName) + '</div>' : '';
              const comment = item.feedbackComment ? '<div style="white-space:pre-wrap; max-width:320px;">' + esc(item.feedbackComment) + '</div>' : '<span class="muted">—</span>';
              const testimonial = item.testimonialText ? '<div style="white-space:pre-wrap; max-width:320px;">' + esc(item.testimonialText) + '</div>' + (item.testimonialDisplayName ? '<div class="muted">Exibição: ' + esc(item.testimonialDisplayName) + '</div>' : '') : '<span class="muted">—</span>';
              const usage = item.testimonialConsent === 'YES' ? 'Sim' : item.testimonialConsent === 'NO' ? 'Não' : '—';
              const status = item.testimonialStatus || '—';
              return '<tr>' +
                '<td><code>' + fmtTs(item.latestAt) + '</code></td>' +
                '<td><div><b>' + esc(who) + '</b></div>' + company + '<div class="muted"><code>' + esc(item.waId || '—') + '</code></div></td>' +
                '<td>' + esc(item.feedbackResponseLabel || '—') + '</td>' +
                '<td>' + comment + '</td>' +
                '<td>' + testimonial + '</td>' +
                '<td>' + esc(usage) + '</td>' +
                '<td><span class="pill">' + esc(status) + '</span></td>' +
                '<td>' + reviewButtons(item) + '</td>' +
              '</tr>';
            }).join('');
            document.getElementById('feedbackRows').innerHTML = rows || '<tr><td colspan="8" class="muted">Nenhum feedback encontrado.</td></tr>';
            Array.from(document.querySelectorAll('#feedbackRows button[data-waid]')).forEach(function(btn){
              btn.addEventListener('click', async function(){
                const waId = this.getAttribute('data-waid');
                const status = this.getAttribute('data-status');
                this.disabled = true;
                try {
                  const r = await fetch('/admin/feedback/review-status', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ waId: waId, status: status }) });
                  const j = await r.json();
                  if (!j.ok) throw new Error(j.error || 'Falha ao atualizar');
                  await load();
                } catch (err) {
                  alert(String(err && err.message ? err.message : err));
                  this.disabled = false;
                }
              });
            });
          }
          const reloadBtn = document.getElementById('feedbackReloadBtn');
          if (reloadBtn) reloadBtn.addEventListener('click', load);
          const filter = document.getElementById('feedbackFilter');
          if (filter) filter.addEventListener('input', renderRows);
          load();
        })();
      </script>
    `;

    const html = layoutBase({
      title: "Avaliações e depoimentos",
      activePath: "/admin/feedback-ui",
      content: inner,
      scriptExtra,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/inconsistencies", async (req, res) => {
    try {
      const data = await collectInconsistencies();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/inconsistencies-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">🩺 Painel de Inconsistências</h3>
            <div class="muted">Diagnóstico operacional dos usuários e assinaturas. O painel apenas lê dados; não corrige nada automaticamente.</div>
          </div>
          <button class="primary" onclick="load()">Atualizar</button>
        </div>

        <div class="hr"></div>

        <div class="row">
          <span class="pill">👥 Usuários analisados: <b id="usersCount">—</b></span>
          <span class="pill">⚠️ Total de ocorrências: <b id="issuesCount">—</b></span>
        </div>

        <div class="hr"></div>

        <div id="summary" class="muted">Carregando…</div>

        <div class="hr"></div>

        <div id="details" class="muted">Carregando…</div>

        <div class="hr"></div>
        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="raw" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <script>
        function esc(s){
          return String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
        }

        function sevClass(sev){
          const v = String(sev || '').toLowerCase();
          if(v === 'danger') return 'danger';
          if(v === 'warn') return 'warn';
          if(v === 'ok') return 'ok';
          return 'info';
        }

        function renderSummary(summary){
          const root = document.getElementById('summary');
          if(!Array.isArray(summary) || !summary.length){
            root.innerHTML = '<div class="muted">Nenhuma regra configurada.</div>';
            return;
          }

          const html = '<table><thead><tr><th>Item</th><th>Descrição</th><th>Nível</th><th>Quantidade</th></tr></thead><tbody>' +
            summary.map(item => {
              return '<tr>' +
                '<td><b>' + esc(item.label || item.key || '') + '</b></td>' +
                '<td class="muted" style="max-width:520px; white-space:pre-wrap;">' + esc(item.description || '—') + '</td>' +
                '<td><span class="badge ' + sevClass(item.severity) + '">' + esc(item.severity || 'info') + '</span></td>' +
                '<td><b>' + esc(item.count || 0) + '</b></td>' +
              '</tr>';
            }).join('') +
            '</tbody></table>';

          root.innerHTML = html;
        }

        function renderDetails(data){
          const root = document.getElementById('details');
          const summary = Array.isArray(data?.summary) ? data.summary : [];
          const items = data?.items && typeof data.items === 'object' ? data.items : {};
          const visible = summary.filter(item => Number(item.count || 0) > 0);

          if(!visible.length){
            root.innerHTML = '<div class="muted">Nenhuma inconsistência encontrada no momento.</div>';
            return;
          }

          const sections = visible.map(item => {
            const bucket = items[item.key] || {};
            const list = Array.isArray(bucket.items) ? bucket.items : [];
            const rows = list.map(row => {
              const href = '/admin/users-ui?waId=' + encodeURIComponent(row.waId || '');
              const extraParts = [];
              if(row.plan) extraParts.push('plano: ' + row.plan);
              if(row.paymentMethod) extraParts.push('payment: ' + row.paymentMethod);
              if(row.asaasCustomerId) extraParts.push('customer: ' + row.asaasCustomerId);
              if(row.asaasSubscriptionId) extraParts.push('subscription: ' + row.asaasSubscriptionId);
              if(typeof row.lastInboundTs === 'number' && row.lastInboundTs > 0) extraParts.push('lastInboundTs: ' + row.lastInboundTs);
              if(row.cardCanceledAt) extraParts.push('cancelado em: ' + row.cardCanceledAt);
              if(row.cardValidUntil) extraParts.push('válido até: ' + row.cardValidUntil);
              if(Array.isArray(row.pendingKeys) && row.pendingKeys.length) extraParts.push('pendingKeys: ' + row.pendingKeys.join(', '));
              return '<tr>' +
                '<td><a href="' + href + '"><code>' + esc(row.waId || '') + '</code></a></td>' +
                '<td>' + esc(row.fullName || '—') + '</td>' +
                '<td>' + esc(row.status || '—') + '</td>' +
                '<td>' + esc(row.plan || '—') + '</td>' +
                '<td style="max-width:520px; white-space:pre-wrap;">' + esc(extraParts.join(' • ') || '—') + '</td>' +
              '</tr>';
            }).join('');

            return '<div class="card pad" style="margin-bottom:12px;">' +
              '<div class="row" style="justify-content:space-between;">' +
                '<div><b>' + esc(item.label || item.key || '') + '</b></div>' +
                '<span class="badge ' + sevClass(item.severity) + '">' + esc(item.count || 0) + '</span>' +
              '</div>' +
              '<div class="muted" style="margin-top:6px;">' + esc(item.description || '—') + '</div>' +
              '<div class="muted" style="margin-top:6px;">Nível: <b>' + esc(item.severity || 'info') + '</b></div>' +
              '<div class="hr"></div>' +
              '<div style="overflow:auto;">' +
                '<table style="min-width:760px;"><thead><tr><th>waId</th><th>Nome</th><th>Status</th><th>Plano</th><th>Detalhes</th></tr></thead><tbody>' + rows + '</tbody></table>' +
              '</div>' +
            '</div>';
          }).join('');

          root.innerHTML = sections;
        }

        async function load(){
          const r = await fetch('/admin/inconsistencies');
          const j = await r.json().catch(()=>({}));
          document.getElementById('raw').textContent = JSON.stringify(j, null, 2);
          document.getElementById('usersCount').textContent = String(j?.usersCount ?? '0');
          document.getElementById('issuesCount').textContent = String(j?.totalIssues ?? '0');

          if(!j?.ok){
            document.getElementById('summary').innerHTML = '<div class="muted">Falha ao carregar inconsistências.</div>';
            document.getElementById('details').innerHTML = '<div class="muted">' + esc(j?.error || 'Erro desconhecido.') + '</div>';
            return;
          }

          renderSummary(j.summary);
          renderDetails(j);
        }

        load();
      </script>
    `;
    const html = layoutBase({ title: "Painel de Inconsistências", activePath: "/admin/inconsistencies-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // ===================== Textos do Bot (Copy) =====================
  // ✅ V16.6.0 — Editor de mensagens (global + por usuário)
  router.get("/copy-ui", async (req, res) => {
    const requestedUserId = String(req.query?.userId || "").trim();
    const requestedWaId = String(req.query?.waId || "").trim();
    const copyUserId = requestedUserId
      ? await resolveAdminUserRef(requestedUserId)
      : requestedWaId
        ? await resolveAdminUserRef(requestedWaId)
        : "";
    const identifiers = copyUserId ? await getUserIdentifiers(copyUserId).catch(() => null) : null;
    const waId = String(identifiers?.waId || requestedWaId || "").trim();
    const groups = groupCatalog();

    // Pré-carrega valores (evita várias requisições na UI)
    const catalogFlat = Object.values(groups).flat();
    const rows = await Promise.all(
      catalogFlat.map(async (row) => {
        const key = row.key;
        const resolved = await getCopyResolved(key, { waId: copyUserId || null });
        const rawGlobal = await getCopyRawGlobal(key);
        const rawUser = copyUserId ? await getCopyRawUser(copyUserId, key) : null;
        const defaultText = String(DEFAULT_COPY[String(key || "").trim().toUpperCase()] ?? "");

        return {
          category: row.category,
          key,
          label: row.label || key,
          resolvedText: resolved.text,
          resolvedSource: resolved.source,
          defaultText,
          globalText: rawGlobal !== null && rawGlobal !== undefined && String(rawGlobal) !== "" ? String(rawGlobal) : defaultText,
          hasGlobalOverride: rawGlobal !== null && rawGlobal !== undefined && String(rawGlobal) !== "",
          userText: copyUserId ? (rawUser !== null && rawUser !== undefined && String(rawUser) !== "" ? String(rawUser) : "") : "",
          hasUserOverride: copyUserId ? (rawUser !== null && rawUser !== undefined && String(rawUser) !== "") : false,
        };
      })
    );

    // Monta HTML por categoria
    const byCat = {};
    for (const r of rows) {
      if (!byCat[r.category]) byCat[r.category] = [];
      byCat[r.category].push(r);
    }

    const inner = `
      <div class="row" style="justify-content:space-between; align-items:flex-end; gap:16px;">
        <div style="min-width:320px;">
          <h2 style="margin:0 0 6px 0;">📝 Textos do Bot</h2>
          <div class="muted">Edite mensagens padrão sem mexer no código. Override global e por usuário (opcional).</div>
        </div>

        <form method="GET" action="/admin/copy-ui" class="row" style="gap:8px; align-items:flex-end; margin:0; flex-wrap:wrap; justify-content:flex-end;">
          <div>
            <div class="muted" style="font-size:12px; margin-bottom:6px;">waId ou userId (opcional)</div>
            <input name="waId" value="${escapeHtml(waId || copyUserId)}" placeholder="5511... ou usr_000001" style="min-width:220px;" />
            ${copyUserId ? `<input type="hidden" name="userId" value="${escapeHtml(copyUserId)}" />` : ""}
          </div>
          <button class="primary" type="submit">Carregar</button>
          <a class="btn" href="/admin/copy-ui">Limpar</a>
        </form>
      </div>

      <div class="hr"></div>

      <div class="row" style="gap:10px; align-items:flex-end; flex-wrap:wrap;">
        <div style="flex:1; min-width:260px;">
          <div class="muted" style="font-size:12px; margin-bottom:6px;">Buscar (key ou título)</div>
          <input id="copySearch" placeholder="Ex.: FLOW_ASK_NAME, OpenAI, pagamento..." style="width:100%;" />
        </div>

        <div style="min-width:220px;">
          <div class="muted" style="font-size:12px; margin-bottom:6px;">Categoria</div>
          <select id="copyCategory" style="width:100%;">
            <option value="">Todas</option>
            ${Object.keys(byCat).map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}
          </select>
        </div>

        <div class="pill" style="margin-left:auto;">
          <span class="muted">Visíveis:</span>
          <strong id="copyVisibleCount">0</strong>
        </div>
      </div>

      <div class="hr"></div>

      <div class="grid" style="grid-template-columns:1fr;">
        ${Object.entries(byCat).map(([cat, items]) => {
          return `
            <div class="card pad copy-cat" data-copy-category="${escapeHtml(cat)}">
              <div class="row" style="justify-content:space-between;">
                <div>
                  <h3 style="margin:0 0 4px 0;">${escapeHtml(cat)}</h3>
                  <div class="muted">Chaves: ${items.length}</div>
                </div>
              </div>
              <div class="hr"></div>
              ${items.map((it) => {
                const badge = it.resolvedSource === "USER"
                  ? "<span class=\"badge\" style=\"background:rgba(16,185,129,.15); color:#065f46; border-color:rgba(16,185,129,.35)\">USER</span>"
                  : it.resolvedSource === "GLOBAL"
                    ? "<span class=\"badge\" style=\"background:rgba(37,99,235,.15); color:#1d4ed8; border-color:rgba(37,99,235,.35)\">GLOBAL</span>"
                    : it.resolvedSource === "DEFAULT"
                      ? "<span class=\"badge\">DEFAULT</span>"
                      : "<span class=\"badge\" style=\"background:rgba(239,68,68,.12); color:#991b1b; border-color:rgba(239,68,68,.28)\">MISSING</span>";

                return `
                  <div class="copy-item" data-copy-category="${escapeHtml(it.category)}" data-copy-key="${escapeHtml(it.key)}" data-copy-label="${escapeHtml(it.label)}" data-copy-source="${escapeHtml(it.resolvedSource)}" style="margin-bottom:18px;">
                    <div class="row" style="justify-content:space-between; align-items:center;">
                      <div>
                        <div style="font-weight:800;">${escapeHtml(it.label)} <span class="muted" style="font-weight:700;">(${escapeHtml(it.key)})</span></div>
                        <div class="muted" style="margin-top:2px;">Em uso: ${badge}</div>
                      </div>
                    </div>

                    <div class="row" style="gap:16px; align-items:flex-start; margin-top:10px;">
                      <div style="flex:1;">
                        <div class="muted" style="font-size:12px; margin-bottom:6px;">Global (edite e salve)</div>
                        <form method="POST" action="/admin/copy/set-global" style="margin:0;">
                          <input type="hidden" name="key" value="${escapeHtml(it.key)}" />
                          <textarea name="value" style="min-height:120px;">${escapeHtml(it.globalText)}</textarea>
                          <div class="row" style="justify-content:space-between; margin-top:8px;">
                            <div class="muted" style="font-size:12px;">
                              ${it.hasGlobalOverride ? "Override global ativo." : "Usando default (sem override)."}
                            </div>
                            <div class="row" style="gap:8px;">
                              <button class="primary" type="submit">Salvar Global</button>
                              <button class="btn" type="submit" formaction="/admin/copy/del-global">Resetar Global</button>
                            </div>
                          </div>
                        </form>
                      </div>

                      ${waId ? `
                        <div style="flex:1;">
                          <div class="muted" style="font-size:12px; margin-bottom:6px;">Usuário (${escapeHtml(waId || copyUserId)})${copyUserId && waId ? ` · <code>${escapeHtml(copyUserId)}</code>` : ""}</div>
                          <form method="POST" action="/admin/copy/set-user" style="margin:0;">
                            <input type="hidden" name="key" value="${escapeHtml(it.key)}" />
                            <input type="hidden" name="userId" value="${escapeHtml(copyUserId)}" />
                            <input type="hidden" name="waId" value="${escapeHtml(waId)}" />
                            <textarea name="value" style="min-height:120px;" placeholder="(opcional) override só para este usuário…">${escapeHtml(it.userText)}</textarea>
                            <div class="row" style="justify-content:space-between; margin-top:8px;">
                              <div class="muted" style="font-size:12px;">
                                ${it.hasUserOverride ? "Override USER ativo." : "Sem override por usuário."}
                              </div>
                              <div class="row" style="gap:8px;">
                                <button class="primary" type="submit">Salvar Usuário</button>
                                <button class="btn" type="submit" formaction="/admin/copy/del-user">Resetar Usuário</button>
                              </div>
                            </div>
                          </form>
                        </div>
                      ` : ""}
                    </div>

                    <details style="margin-top:10px;">
                      <summary class="muted">Ver texto resolvido (o que o usuário recebe)</summary>
                      <pre style="white-space:pre-wrap; margin-top:10px;">${escapeHtml(it.resolvedText)}</pre>
                      <div class="muted" style="font-size:12px; margin-top:6px;">
                        Dica: placeholders como {{count}}, {{planName}} e {{planPrice}} são preservados no editor e só são resolvidos na execução do fluxo.
                      </div>
                    </details>

                    <div class="hr"></div>
                  </div>
                `;
              }).join("")}
            </div>
          `;
        }).join("")}
      </div>


      <script>
        (function(){
          const searchEl = document.getElementById('copySearch');
          const catEl = document.getElementById('copyCategory');
          const countEl = document.getElementById('copyVisibleCount');

          function norm(v){ return String(v || '').toLowerCase().trim(); }

          function apply(){
            const q = norm(searchEl ? searchEl.value : '');
            const cat = String(catEl ? catEl.value : '').trim();

            let visible = 0;

            const catCards = Array.from(document.querySelectorAll('.copy-cat'));
            for (const card of catCards){
              const cardCat = card.getAttribute('data-copy-category') || '';
              const showCat = !cat || cardCat === cat;

              let anyItemVisible = false;
              const items = Array.from(card.querySelectorAll('.copy-item'));
              for (const it of items){
                const k = norm(it.getAttribute('data-copy-key'));
                const l = norm(it.getAttribute('data-copy-label'));
                const matchQ = !q || k.includes(q) || l.includes(q);

                const show = showCat && matchQ;
                it.style.display = show ? '' : 'none';
                if (show){ anyItemVisible = true; visible++; }
              }

              card.style.display = (showCat && anyItemVisible) ? '' : 'none';
            }

            if (countEl) countEl.textContent = String(visible);
          }

          if (searchEl) searchEl.addEventListener('input', apply);
          if (catEl) catEl.addEventListener('change', apply);

          // tecla "/" foca busca
          document.addEventListener('keydown', (e) => {
            if (e.key === '/' && searchEl && document.activeElement !== searchEl) {
              e.preventDefault();
              searchEl.focus();
            }
          });

          apply();
        })();
      </script>

    `;

    const html = layoutBase({ title: "Textos do Bot", activePath: "/admin/copy-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
  });

  router.post("/copy/set-global", async (req, res) => {
    const key = String(req.body?.key || "").trim();
    const value = String(req.body?.value || "");
    if (!key) {
      return res.status(400).json({ ok: false, error: "key required" });
    }
    await setCopyGlobal(key, value);
    await safeRecordAdminAudit(req, {
      module: "copy",
      action: "SET_COPY_GLOBAL",
      targetId: key,
      summary: `Atualizou o texto global ${key}.`,
      after: { key, valueLength: value.length },
    });
    res.redirect("/admin/copy-ui");
  });

  router.post("/copy/del-global", async (req, res) => {
    const key = String(req.body?.key || "").trim();
    if (!key) {
      return res.status(400).json({ ok: false, error: "key required" });
    }
    await delCopyGlobal(key);
    await safeRecordAdminAudit(req, {
      module: "copy",
      action: "DEL_COPY_GLOBAL",
      targetId: key,
      summary: `Resetou o texto global ${key}.`,
      after: { key, reset: true },
    });
    res.redirect("/admin/copy-ui");
  });

  router.post("/copy/set-user", async (req, res) => {
    const key = String(req.body?.key || "").trim();
    const userId = await requireBodyUserRef(req);
    const value = String(req.body?.value || "");
    if (!key) {
      return res.status(400).json({ ok: false, error: "key required" });
    }
    const identifiers = await getUserIdentifiers(userId).catch(() => null);
    await setCopyUser(userId, key, value);
    await safeRecordAdminAudit(req, {
      module: "copy",
      action: "SET_COPY_USER",
      waId: identifiers?.waId || "",
      targetId: key,
      summary: `Atualizou o texto ${key} para o usuário ${userId}.`,
      after: { key, userId, valueLength: value.length },
    });
    res.redirect(`/admin/copy-ui?userId=${encodeURIComponent(userId)}&waId=${encodeURIComponent(identifiers?.waId || "")}`);
  });

  router.post("/copy/del-user", async (req, res) => {
    const key = String(req.body?.key || "").trim();
    const userId = await requireBodyUserRef(req);
    if (!key) {
      return res.status(400).json({ ok: false, error: "key required" });
    }
    const identifiers = await getUserIdentifiers(userId).catch(() => null);
    await delCopyUser(userId, key);
    await safeRecordAdminAudit(req, {
      module: "copy",
      action: "DEL_COPY_USER",
      waId: identifiers?.waId || "",
      targetId: key,
      summary: `Resetou o texto ${key} do usuário ${userId}.`,
      after: { key, userId, reset: true },
    });
    res.redirect(`/admin/copy-ui?userId=${encodeURIComponent(userId)}&waId=${encodeURIComponent(identifiers?.waId || "")}`);
  });



  // -----------------------------
  // Janela 24h (UI já existente)
  // -----------------------------
  
  function parseBillingCityStateParts(value) {
    const raw = String(value || "").trim();
    if (!raw) return { city: "", state: "" };
    const normalized = raw.replace(/\s+/g, " ").trim();
    let city = normalized;
    let state = "";

    if (normalized.includes("/")) {
      const parts = normalized.split("/");
      city = String(parts.slice(0, -1).join("/") || "").trim() || normalized;
      state = String(parts[parts.length - 1] || "").trim().toUpperCase();
    } else if (normalized.includes("-")) {
      const parts = normalized.split("-");
      city = String(parts.slice(0, -1).join("-") || "").trim() || normalized;
      state = String(parts[parts.length - 1] || "").trim().toUpperCase();
    } else if (/,\s*[A-Za-z]{2}$/.test(normalized)) {
      const match = normalized.match(/^(.*),\s*([A-Za-z]{2})$/);
      if (match) {
        city = String(match[1] || "").trim() || normalized;
        state = String(match[2] || "").trim().toUpperCase();
      }
    }

    state = /^[A-Z]{2}$/.test(state) ? state : "";
    return { city, state };
  }

  function getSeriesLabel(item, fallbackIndex = 0) {
    return String(item?.month || item?.label || item?.key || item?.day || item?.date || fallbackIndex + 1 || "");
  }

  function getSeriesCount(item) {
    return Number(item?.count ?? item?.value ?? item?.total ?? item?.qty ?? 0) || 0;
  }

  function eventLooksFinancial(evt) {
    const raw = String(evt?.event || evt?.type || evt?.kind || "").toUpperCase();
    if (!raw) return false;
    return raw.includes("PAYMENT") || raw.includes("INVOICE") || raw.includes("BILLING") || raw.includes("RECEIVED") || raw.includes("CONFIRMED") || raw.includes("SUBSCRIPTION");
  }

  function normalizeLedgerPaymentItem(evt) {
    const eventName = String(evt?.event || evt?.type || evt?.kind || "").trim();
    const when = String(evt?.receivedAt || evt?.dateCreated || evt?.createdAt || evt?.ts || evt?.paymentDate || evt?.dueDate || "").trim();
    const payload = evt?.payload && typeof evt.payload === "object" ? evt.payload : {};
    const payment = evt?.payment && typeof evt.payment === "object"
      ? evt.payment
      : payload?.payment && typeof payload.payment === "object"
        ? payload.payment
        : payload;
    const customer = evt?.customer && typeof evt.customer === "object"
      ? evt.customer
      : payload?.customer && typeof payload.customer === "object"
        ? payload.customer
        : {};

    const paymentId = String(evt?.paymentId || payment?.id || payload?.paymentId || evt?.id || evt?.externalReference || "").trim();
    const subscriptionId = String(evt?.subscriptionId || payment?.subscription || payload?.subscription || payload?.subscriptionId || "").trim();
    const status = String(evt?.status || payment?.status || payload?.status || eventName || "").trim();
    const description = String(
      evt?.description ||
      payment?.description ||
      payload?.description ||
      payload?.invoiceUrl ||
      payment?.invoiceUrl ||
      eventName ||
      ""
    ).trim();
    const customerName = String(
      evt?.customerName ||
      customer?.name ||
      payload?.customerName ||
      payment?.name ||
      payload?.name ||
      ""
    ).trim();

    const valueRaw = evt?.value ?? payment?.value ?? payload?.value ?? payload?.netValue ?? payment?.netValue ?? null;
    const value = valueRaw === null || valueRaw === undefined || valueRaw === "" ? null : Number(valueRaw || 0);

    return {
      when,
      event: eventName,
      paymentId,
      subscriptionId,
      status,
      value,
      customerName,
      description,
    };
  }

  async function buildFinanceSaasDashboardData() {
    const [usersRaw, global, globalMonths, window24hCount, systemPlans, inconsistencyData, ledgerRaw] = await Promise.all([
      listUsers(),
      getGlobalDescriptionMetrics(),
      getGlobalLastNMonths(12),
      countWindow24hActive(),
      listPlans({ includeInactive: true }),
      collectInconsistencies(),
      listAsaasEvents({ limit: 80, offset: 0 }),
    ]);

    const waIds = Array.isArray(usersRaw) ? usersRaw.slice().sort() : [];
    const now = nowMs();
    const planMap = buildPlanMap(systemPlans);
    const users = await mapLimit(waIds, 20, async (waId) => enrichUserForCrm(waId, planMap, now));

    const statusCounts = {};
    const paymentCounts = { CARD: 0, PIX: 0, NONE: 0, OTHER: 0 };
    const planBuckets = new Map();
    const cityCounts = new Map();
    const stateCounts = new Map();

    let activeUsers = 0;
    let trialUsers = 0;
    let paidUsers = 0;
    let blockedUsers = 0;
    let paymentPendingUsers = 0;
    let waitPlanUsers = 0;
    let canceledUsers = 0;
    let usersWithName = 0;
    let usersWithBilling = 0;
    let usersWithAsaasCustomer = 0;
    let usersWithSubscription = 0;
    let billableBase = 0;
    let billableCovered = 0;
    let activeSubscriptionBase = 0;
    let activeSubscriptionCovered = 0;
    let totalMrrCents = 0;
    let totalUsageCounter = 0;

    for (const user of users) {
      const status = String(user?.status || "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
      statusCounts[status] = (statusCounts[status] || 0) + 1;

      const paymentMethod = String(user?.paymentMethod || "").trim().toUpperCase();
      if (paymentMethod === "CARD") paymentCounts.CARD += 1;
      else if (paymentMethod === "PIX") paymentCounts.PIX += 1;
      else if (!paymentMethod) paymentCounts.NONE += 1;
      else paymentCounts.OTHER += 1;

      if (user?.fullName) usersWithName += 1;
      if (user?.billingCityState || user?.billingAddress) usersWithBilling += 1;
      if (user?.asaasCustomerId) usersWithAsaasCustomer += 1;
      if (user?.asaasSubscriptionId) usersWithSubscription += 1;

      if (status === "ACTIVE") activeUsers += 1;
      else if (status === "TRIAL") trialUsers += 1;
      else if (status === "BLOCKED") blockedUsers += 1;
      else if (status === "PAYMENT_PENDING") paymentPendingUsers += 1;
      else if (status === "WAIT_PLAN") waitPlanUsers += 1;
      else if (status === "CANCELED") canceledUsers += 1;

      if (user?.cardCanceledAt) canceledUsers += 1;

      const isBillable = !!(paymentMethod || status === "ACTIVE" || status === "PAYMENT_PENDING" || user?.asaasCustomerId || user?.asaasSubscriptionId);
      if (isBillable) {
        billableBase += 1;
        if (user?.asaasCustomerId) billableCovered += 1;
      }

      if (status === "ACTIVE") {
        activeSubscriptionBase += 1;
        if (user?.asaasSubscriptionId) activeSubscriptionCovered += 1;
      }

      const location = parseBillingCityStateParts(user?.billingCityState || "");
      if (location.city) cityCounts.set(location.city, (cityCounts.get(location.city) || 0) + 1);
      if (location.state) stateCounts.set(location.state, (stateCounts.get(location.state) || 0) + 1);

      const planCode = String(user?.plan || "").trim().toUpperCase();
      const planMeta = planCode ? planMap.get(planCode) : null;
      const usageCounter = status === "TRIAL" ? Number(user?.trialUsed || 0) : Number(user?.quotaUsed || 0);
      totalUsageCounter += usageCounter;

      if (planCode) {
        const current = planBuckets.get(planCode) || {
          code: planCode,
          name: String(planMeta?.name || planCode),
          description: String(planMeta?.description || ""),
          priceCents: Number(planMeta?.priceCents || 0),
          active: !!planMeta?.active,
          count: 0,
          activeCount: 0,
          trialCount: 0,
          revenueUsers: 0,
          monthlyUsage: 0,
          mrrCents: 0,
          arrCents: 0,
        };
        current.count += 1;
        current.monthlyUsage += usageCounter;
        if (status === "ACTIVE") current.activeCount += 1;
        if (status === "TRIAL") current.trialCount += 1;
        if (status === "ACTIVE" && Number(planMeta?.priceCents || 0) > 0) {
          current.revenueUsers += 1;
          current.mrrCents += Number(planMeta?.priceCents || 0);
          totalMrrCents += Number(planMeta?.priceCents || 0);
        }
        current.arrCents = current.mrrCents * 12;
        planBuckets.set(planCode, current);
      }

      if (status === "ACTIVE" && planMeta && Number(planMeta?.priceCents || 0) > 0) {
        paidUsers += 1;
      }
    }

    const totalUsers = users.length;
    const arrCents = totalMrrCents * 12;
    const avgTicketCents = paidUsers > 0 ? Math.round(totalMrrCents / paidUsers) : 0;
    const conversionBase = activeUsers + trialUsers;
    const trialToPaidPct = conversionBase > 0 ? Number(((activeUsers / conversionBase) * 100).toFixed(1)) : 0;
    const billableCoveragePct = billableBase > 0 ? Number(((billableCovered / billableBase) * 100).toFixed(1)) : 0;
    const subscriptionCoveragePct = activeSubscriptionBase > 0 ? Number(((activeSubscriptionCovered / activeSubscriptionBase) * 100).toFixed(1)) : 0;
    const billingCoveragePct = totalUsers > 0 ? Number(((usersWithBilling / totalUsers) * 100).toFixed(1)) : 0;
    const nameCoveragePct = totalUsers > 0 ? Number(((usersWithName / totalUsers) * 100).toFixed(1)) : 0;
    const asaasCoveragePct = totalUsers > 0 ? Number(((usersWithAsaasCustomer / totalUsers) * 100).toFixed(1)) : 0;
    const active24hPct = totalUsers > 0 ? Number(((Number(window24hCount || 0) / totalUsers) * 100).toFixed(1)) : 0;
    const avgMonthlyUsage = activeUsers > 0 ? Number((Number(global?.monthCount || 0) / activeUsers).toFixed(2)) : 0;

    const plans = Array.from(planBuckets.values())
      .map((item) => ({
        ...item,
        avgUsagePerUser: item.count > 0 ? Number((item.monthlyUsage / item.count).toFixed(2)) : 0,
      }))
      .sort((a, b) => (b.mrrCents - a.mrrCents) || (b.count - a.count) || String(a.code).localeCompare(String(b.code)));

    const cities = Array.from(cityCounts.entries())
      .map(([city, count]) => ({ city, count }))
      .sort((a, b) => (b.count - a.count) || String(a.city).localeCompare(String(b.city)))
      .slice(0, 10);

    const states = Array.from(stateCounts.entries())
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => (b.count - a.count) || String(a.state).localeCompare(String(b.state)))
      .slice(0, 10);

    const monthlyUsage = (Array.isArray(globalMonths) ? globalMonths : []).map((item, index) => ({
      label: getSeriesLabel(item, index),
      descriptions: getSeriesCount(item),
      mrrCents: totalMrrCents,
      arrCents,
    }));

    const statusSeries = Object.entries(statusCounts)
      .map(([label, count]) => ({ label, count, pct: totalUsers > 0 ? Number(((count / totalUsers) * 100).toFixed(1)) : 0 }))
      .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label)));

    const paymentMethods = [
      { label: 'CARD', count: paymentCounts.CARD },
      { label: 'PIX', count: paymentCounts.PIX },
      { label: 'SEM MÉTODO', count: paymentCounts.NONE },
      { label: 'OUTROS', count: paymentCounts.OTHER },
    ];

    const ledgerItems = Array.isArray(ledgerRaw?.items) ? ledgerRaw.items : [];
    const recentPayments = ledgerItems
      .filter((evt) => eventLooksFinancial(evt))
      .map((evt) => normalizeLedgerPaymentItem(evt))
      .filter((item) => item.when || item.paymentId || item.subscriptionId || item.event)
      .sort((a, b) => String(b.when).localeCompare(String(a.when)))
      .slice(0, 20);

    const ledgerMetrics = {
      totalEvents: ledgerItems.length,
      financialEvents: recentPayments.length,
      latestEventAt: recentPayments.length ? String(recentPayments[0].when || "") : "",
    };

    return {
      ok: true,
      ts: Date.now(),
      headline: {
        totalUsers,
        activeUsers,
        trialUsers,
        paidUsers,
        blockedUsers,
        paymentPendingUsers,
        waitPlanUsers,
        canceledUsers,
        mrrCents: totalMrrCents,
        arrCents,
        avgTicketCents,
        trialToPaidPct,
        billableCoveragePct,
        subscriptionCoveragePct,
        billingCoveragePct,
        asaasCoveragePct,
        nameCoveragePct,
        active24hCount: Number(window24hCount || 0),
        active24hPct,
        avgMonthlyUsage,
        descriptionsMonth: Number(global?.monthCount || 0),
        descriptionsToday: Number(global?.dayCount || 0),
        monthLabel: String(global?.month || ""),
        dayLabel: String(global?.day || ""),
      },
      quality: {
        usersWithName,
        usersWithBilling,
        usersWithAsaasCustomer,
        usersWithSubscription,
        totalUsageCounter,
      },
      series: {
        monthlyUsage,
        statusSeries,
        paymentMethods,
      },
      plans,
      cities,
      states,
      recentPayments,
      ledger: ledgerMetrics,
      inconsistencies: inconsistencyData,
    };
  }

  function buildFinanceSaasExportRows(data) {
    const rows = [];
    const headline = data?.headline || {};
    const quality = data?.quality || {};
    const ledger = data?.ledger || {};
    const plans = Array.isArray(data?.plans) ? data.plans : [];
    const cities = Array.isArray(data?.cities) ? data.cities : [];
    const states = Array.isArray(data?.states) ? data.states : [];
    const statusSeries = Array.isArray(data?.series?.statusSeries) ? data.series.statusSeries : [];
    const paymentMethods = Array.isArray(data?.series?.paymentMethods) ? data.series.paymentMethods : [];
    const monthlyUsage = Array.isArray(data?.series?.monthlyUsage) ? data.series.monthlyUsage : [];
    const recentPayments = Array.isArray(data?.recentPayments) ? data.recentPayments : [];
    const inconsistencies = Array.isArray(data?.inconsistencies?.summary) ? data.inconsistencies.summary : [];

    function push(section, metric, value, detail = '', rank = '') {
      rows.push({ section, metric, value, detail, rank });
    }

    push('headline', 'totalUsers', Number(headline.totalUsers || 0));
    push('headline', 'activeUsers', Number(headline.activeUsers || 0));
    push('headline', 'trialUsers', Number(headline.trialUsers || 0));
    push('headline', 'paidUsers', Number(headline.paidUsers || 0));
    push('headline', 'blockedUsers', Number(headline.blockedUsers || 0));
    push('headline', 'paymentPendingUsers', Number(headline.paymentPendingUsers || 0));
    push('headline', 'waitPlanUsers', Number(headline.waitPlanUsers || 0));
    push('headline', 'canceledUsers', Number(headline.canceledUsers || 0));
    push('headline', 'mrrCents', Number(headline.mrrCents || 0), formatMoneyCents(headline.mrrCents || 0));
    push('headline', 'arrCents', Number(headline.arrCents || 0), formatMoneyCents(headline.arrCents || 0));
    push('headline', 'avgTicketCents', Number(headline.avgTicketCents || 0), formatMoneyCents(headline.avgTicketCents || 0));
    push('headline', 'trialToPaidPct', Number(headline.trialToPaidPct || 0), 'Conversão trial → pago');
    push('headline', 'billableCoveragePct', Number(headline.billableCoveragePct || 0), 'Cobertura de cobrança');
    push('headline', 'subscriptionCoveragePct', Number(headline.subscriptionCoveragePct || 0), 'Cobertura de assinaturas');
    push('headline', 'billingCoveragePct', Number(headline.billingCoveragePct || 0), 'Cobertura de billing');
    push('headline', 'asaasCoveragePct', Number(headline.asaasCoveragePct || 0), 'Cobertura Asaas');
    push('headline', 'nameCoveragePct', Number(headline.nameCoveragePct || 0), 'Cobertura de nomes');
    push('headline', 'active24hCount', Number(headline.active24hCount || 0));
    push('headline', 'active24hPct', Number(headline.active24hPct || 0), 'Base ativa na janela de 24h');
    push('headline', 'avgMonthlyUsage', Number(headline.avgMonthlyUsage || 0));
    push('headline', 'descriptionsMonth', Number(headline.descriptionsMonth || 0), String(headline.monthLabel || ''));
    push('headline', 'descriptionsToday', Number(headline.descriptionsToday || 0), String(headline.dayLabel || ''));

    push('quality', 'usersWithName', Number(quality.usersWithName || 0));
    push('quality', 'usersWithBilling', Number(quality.usersWithBilling || 0));
    push('quality', 'usersWithAsaasCustomer', Number(quality.usersWithAsaasCustomer || 0));
    push('quality', 'usersWithSubscription', Number(quality.usersWithSubscription || 0));
    push('quality', 'totalUsageCounter', Number(quality.totalUsageCounter || 0));

    push('ledger', 'totalEvents', Number(ledger.totalEvents || 0));
    push('ledger', 'financialEvents', Number(ledger.financialEvents || 0));
    push('ledger', 'latestEventAt', String(ledger.latestEventAt || ''));

    plans.forEach((item, index) => {
      push('plans', String(item.name || item.code || 'Plano'), Number(item.mrrCents || 0), 'Usuários: ' + Number(item.count || 0) + ' · Uso médio: ' + String(item.avgUsagePerUser || 0).replace('.', ','), String(index + 1));
    });
    cities.forEach((item, index) => {
      push('cities', String(item.city || '—'), Number(item.count || 0), 'Top cidades', String(index + 1));
    });
    states.forEach((item, index) => {
      push('states', String(item.state || '—'), Number(item.count || 0), 'Top estados', String(index + 1));
    });
    statusSeries.forEach((item, index) => {
      push('statusSeries', String(item.label || '—'), Number(item.count || 0), 'Participação: ' + Number(item.pct || 0) + '%', String(index + 1));
    });
    paymentMethods.forEach((item, index) => {
      push('paymentMethods', String(item.label || '—'), Number(item.count || 0), 'Método salvo', String(index + 1));
    });
    monthlyUsage.forEach((item, index) => {
      push('monthlyUsage', String(item.label || '—'), Number(item.descriptions || 0), 'MRR referência: ' + formatMoneyCents(item.mrrCents || 0), String(index + 1));
    });
    recentPayments.forEach((item, index) => {
      push('recentPayments', String(item.when || item.paymentId || item.subscriptionId || '—'), item.value === null || item.value === undefined ? '' : Number(item.value || 0), [item.event, item.status, item.customerName].filter(Boolean).join(' · '), String(index + 1));
    });
    inconsistencies.forEach((item, index) => {
      push('inconsistencies', String(item.label || '—'), Number(item.count || 0), 'Severidade: ' + String(item.severity || '—'), String(index + 1));
    });

    return rows;
  }

  router.get("/finance-saas-data", async (req, res) => {
    try {
      const data = await buildFinanceSaasDashboardData();
      return res.json(data);
    } catch (err) {
      return res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/finance-saas-ui", async (req, res) => {
    const inner = `
      <div class="card pad" style="margin-bottom:14px;">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
          <div>
            <h3 style="margin:0 0 6px 0;">📈 Dashboard Financeiro SaaS</h3>
            <div class="muted">Visão financeira consolidada: MRR, ARR, conversão, cobertura Asaas, composição da base e eventos recentes do faturamento.</div>
          </div>
          <div class="row" style="gap:8px; flex-wrap:wrap;">
            <a class="pill" href="/admin/plans">💳 Planos</a>
            <a class="pill" href="/admin/finance-asaas-ui">🧾 Reconciliação Asaas</a>
            <a class="pill" href="/admin/inconsistencies-ui">🩺 Inconsistências</a>
            <button type="button" class="primary" id="financeReloadBtn">Atualizar</button>
          </div>
        </div>
      </div>

      <div class="grid cols3">
        <div class="kpi"><div class="t">MRR estimado</div><div class="v" id="finMrr">—</div><div class="muted" id="finArrHint">—</div></div>
        <div class="kpi"><div class="t">ARR estimado</div><div class="v" id="finArr">—</div><div class="muted" id="finAvgTicket">—</div></div>
        <div class="kpi"><div class="t">Conversão trial → pago</div><div class="v" id="finConversion">—</div><div class="muted" id="finBaseUsers">—</div></div>
      </div>

      <div class="grid cols3" style="margin-top:12px;">
        <div class="kpi"><div class="t">Base ativa na janela 24h</div><div class="v" id="fin24h">—</div><div class="muted" id="fin24hHint">—</div></div>
        <div class="kpi"><div class="t">Cobertura Asaas</div><div class="v" id="finAsaasCoverage">—</div><div class="muted" id="finBillingCoverage">—</div></div>
        <div class="kpi"><div class="t">Cobertura de assinaturas</div><div class="v" id="finSubCoverage">—</div><div class="muted" id="finUsageAvg">—</div></div>
      </div>

      <div class="grid cols3" style="margin-top:12px;">
        <div class="kpi"><div class="t">Usuários pagos</div><div class="v" id="finPaidUsers">—</div><div class="muted" id="finPaidHint">—</div></div>
        <div class="kpi"><div class="t">Usuários trial</div><div class="v" id="finTrialUsers">—</div><div class="muted" id="finStatusHint">—</div></div>
        <div class="kpi"><div class="t">Usuários cancelados</div><div class="v" id="finCanceledUsers">—</div><div class="muted" id="finLedgerHint">—</div></div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between; gap:8px; flex-wrap:wrap;">
            <div>
              <h4 style="margin:0;">Composição atual da base</h4>
              <div class="muted">Status do funil comercial e operacional.</div>
            </div>
            <span class="badge info">Tempo real</span>
          </div>
          <div class="hr"></div>
          <div id="finStatusChart"></div>
        </div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between; gap:8px; flex-wrap:wrap;">
            <div>
              <h4 style="margin:0;">Métodos de pagamento</h4>
              <div class="muted">Cobrança atual cadastrada na base.</div>
            </div>
            <span class="badge soft">Distribuição</span>
          </div>
          <div class="hr"></div>
          <div id="finPaymentChart"></div>
        </div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between; gap:8px; flex-wrap:wrap;">
            <div>
              <h4 style="margin:0;">Receita por plano</h4>
              <div class="muted">MRR atual distribuído por plano ativo na base.</div>
            </div>
            <span class="badge ok">Receita recorrente</span>
          </div>
          <div class="hr"></div>
          <div id="finPlanRevenueChart"></div>
        </div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between; gap:8px; flex-wrap:wrap;">
            <div>
              <h4 style="margin:0;">Evolução operacional</h4>
              <div class="muted">Descrições por mês + referência da receita recorrente atual.</div>
            </div>
            <span class="badge warn">Últimos 12 meses</span>
          </div>
          <div class="hr"></div>
          <div id="finMonthlyUsageChart"></div>
        </div>
      </div>

      <div class="grid cols3" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between; gap:8px; flex-wrap:wrap;">
            <div>
              <h4 style="margin:0;">Planos com maior MRR</h4>
              <div class="muted">Ranking financeiro atual.</div>
            </div>
            <span class="badge soft">Top planos</span>
          </div>
          <div class="hr"></div>
          <div style="overflow:auto;">
            <table>
              <thead>
                <tr><th>Plano</th><th>Usuários</th><th>MRR</th><th>Uso médio</th></tr>
              </thead>
              <tbody id="finPlansRows"><tr><td colspan="4" class="muted">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between; gap:8px; flex-wrap:wrap;">
            <div>
              <h4 style="margin:0;">Top cidades</h4>
              <div class="muted">billingCityState com maior concentração.</div>
            </div>
            <span class="badge soft">Localização</span>
          </div>
          <div class="hr"></div>
          <div style="overflow:auto;">
            <table>
              <thead>
                <tr><th>Cidade</th><th>Usuários</th></tr>
              </thead>
              <tbody id="finCitiesRows"><tr><td colspan="2" class="muted">Carregando...</td></tr></tbody>
            </table>
          </div>
          <div class="hr"></div>
          <div style="overflow:auto;">
            <table>
              <thead>
                <tr><th>UF</th><th>Usuários</th></tr>
              </thead>
              <tbody id="finStatesRows"><tr><td colspan="2" class="muted">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between; gap:8px; flex-wrap:wrap;">
            <div>
              <h4 style="margin:0;">Pagamentos recentes (Asaas)</h4>
              <div class="muted">Normalizados a partir do ledger de webhooks.</div>
            </div>
            <span class="badge info">Asaas</span>
          </div>
          <div class="hr"></div>
          <div style="overflow:auto; max-height:430px;">
            <table>
              <thead>
                <tr><th>Quando</th><th>Status</th><th>Valor</th><th>Cliente</th></tr>
              </thead>
              <tbody id="finPaymentsRows"><tr><td colspan="4" class="muted">Carregando...</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="grid cols2" style="margin-top:14px;">
        <div class="card pad">
          <div class="row" style="justify-content:space-between; gap:8px; flex-wrap:wrap;">
            <div>
              <h4 style="margin:0;">Cobertura e saúde de cobrança</h4>
              <div class="muted">Indicadores rápidos de integridade financeira da base.</div>
            </div>
            <span class="badge warn">Saúde</span>
          </div>
          <div class="hr"></div>
          <div id="finHealthPills"></div>
        </div>

        <div class="card pad">
          <details>
            <summary class="muted">Ver JSON bruto</summary>
            <pre id="finRaw" style="white-space:pre-wrap; overflow:auto; max-height:360px;"></pre>
          </details>
        </div>
      </div>
    `;

    const headExtra = `
      <style>
        .fin-bars{ display:grid; gap:10px; }
        .fin-bar{ display:grid; gap:6px; }
        .fin-bar__top{ display:flex; justify-content:space-between; gap:10px; align-items:center; font-size:13px; }
        .fin-bar__track{ width:100%; height:12px; border-radius:999px; background:#e5e7eb; overflow:hidden; }
        .fin-bar__fill{ height:100%; border-radius:999px; background:linear-gradient(90deg, rgba(37,99,235,.95), rgba(16,185,129,.92)); }
        .fin-mini{ font-size:12px; color:#6b7280; }
      </style>
    `;

    const scriptExtra = `
      <script>
        (function(){
          function esc(value){
            return String(value ?? '')
              .replaceAll('&','&amp;')
              .replaceAll('<','&lt;')
              .replaceAll('>','&gt;')
              .replaceAll('"','&quot;')
              .replaceAll("'",'&#39;');
          }
          function setText(id, value){
            const el = document.getElementById(id);
            if (el) el.textContent = String(value ?? '—');
          }
          function fmtBRL(cents){
            const v = (Number(cents) || 0) / 100;
            try { return v.toLocaleString('pt-BR', { style:'currency', currency:'BRL' }); }
            catch (_) { return 'R$ ' + v.toFixed(2); }
          }
          function fmtMoney(value){
            const n = Number(value || 0);
            try { return n.toLocaleString('pt-BR', { style:'currency', currency:'BRL' }); }
            catch (_) { return 'R$ ' + n.toFixed(2); }
          }
          function fmtPct(value){
            return Number(value || 0).toFixed(1).replace('.', ',') + '%';
          }
          function fmtNum(value){
            return Number(value || 0).toLocaleString('pt-BR');
          }
          function renderTableRows(containerId, rowsHtml, emptyColspan, emptyText){
            const el = document.getElementById(containerId);
            if (!el) return;
            el.innerHTML = rowsHtml || '<tr><td colspan="' + String(emptyColspan) + '" class="muted">' + esc(emptyText || 'Sem dados.') + '</td></tr>';
          }
          function renderBars(containerId, items, options){
            const el = document.getElementById(containerId);
            if (!el) return;
            const rows = Array.isArray(items) ? items : [];
            if (!rows.length) {
              el.innerHTML = '<div class="muted">Sem dados suficientes.</div>';
              return;
            }
            const max = rows.reduce(function(acc, item){ return Math.max(acc, Number(options.value(item) || 0)); }, 0) || 1;
            el.innerHTML = '<div class="fin-bars">' + rows.map(function(item){
              const value = Number(options.value(item) || 0);
              const pct = Math.max(2, Math.round((value / max) * 100));
              const meta = typeof options.meta === 'function' ? options.meta(item) : '';
              return '' +
                '<div class="fin-bar">' +
                  '<div class="fin-bar__top">' +
                    '<div><b>' + esc(options.label(item)) + '</b>' + (meta ? ('<div class="fin-mini">' + esc(meta) + '</div>') : '') + '</div>' +
                    '<div><b>' + esc(options.display(item)) + '</b></div>' +
                  '</div>' +
                  '<div class="fin-bar__track"><div class="fin-bar__fill" style="width:' + pct + '%;"></div></div>' +
                '</div>';
            }).join('') + '</div>';
          }
          function renderHealthPills(containerId, items){
            const el = document.getElementById(containerId);
            if (!el) return;
            if (!Array.isArray(items) || !items.length) {
              el.innerHTML = '<span class="muted">Sem dados.</span>';
              return;
            }
            el.innerHTML = items.map(function(item){
              return '<span class="pill"><b>' + esc(item.label) + '</b>: ' + esc(item.value) + '</span>';
            }).join(' ');
          }
          async function loadFinance(){
            const response = await fetch('/admin/finance-saas-data');
            const data = await response.json().catch(function(){ return {}; });
            document.getElementById('finRaw').textContent = JSON.stringify(data, null, 2);
            if (!response.ok || !data.ok) {
              renderTableRows('finPlansRows', '', 4, 'Erro ao carregar dashboard financeiro.');
              renderTableRows('finCitiesRows', '', 2, 'Erro ao carregar dashboard financeiro.');
              renderTableRows('finStatesRows', '', 2, 'Erro ao carregar dashboard financeiro.');
              renderTableRows('finPaymentsRows', '', 4, 'Erro ao carregar dashboard financeiro.');
              return;
            }

            const headline = data.headline || {};
            const plans = Array.isArray(data.plans) ? data.plans : [];
            const cities = Array.isArray(data.cities) ? data.cities : [];
            const states = Array.isArray(data.states) ? data.states : [];
            const recentPayments = Array.isArray(data.recentPayments) ? data.recentPayments : [];
            const statusSeries = Array.isArray(data?.series?.statusSeries) ? data.series.statusSeries : [];
            const paymentMethods = Array.isArray(data?.series?.paymentMethods) ? data.series.paymentMethods : [];
            const monthlyUsage = Array.isArray(data?.series?.monthlyUsage) ? data.series.monthlyUsage : [];
            const issueSummary = Array.isArray(data?.inconsistencies?.summary) ? data.inconsistencies.summary : [];

            setText('finMrr', fmtBRL(headline.mrrCents || 0));
            setText('finArrHint', 'Base mensal recorrente estimada');
            setText('finArr', fmtBRL(headline.arrCents || 0));
            setText('finAvgTicket', 'Ticket médio: ' + fmtBRL(headline.avgTicketCents || 0));
            setText('finConversion', fmtPct(headline.trialToPaidPct || 0));
            setText('finBaseUsers', 'Total base: ' + fmtNum(headline.totalUsers || 0));

            setText('fin24h', fmtNum(headline.active24hCount || 0));
            setText('fin24hHint', 'Cobertura da base: ' + fmtPct(headline.active24hPct || 0));
            setText('finAsaasCoverage', fmtPct(headline.asaasCoveragePct || 0));
            setText('finBillingCoverage', 'Cobrança coberta: ' + fmtPct(headline.billableCoveragePct || 0));
            setText('finSubCoverage', fmtPct(headline.subscriptionCoveragePct || 0));
            setText('finUsageAvg', 'Uso médio mensal: ' + String(headline.avgMonthlyUsage || 0).replace('.', ','));

            setText('finPaidUsers', fmtNum(headline.paidUsers || 0));
            setText('finPaidHint', 'Ativos pagos com plano válido');
            setText('finTrialUsers', fmtNum(headline.trialUsers || 0));
            setText('finStatusHint', 'Ativos: ' + fmtNum(headline.activeUsers || 0) + ' · Bloqueados: ' + fmtNum(headline.blockedUsers || 0));
            setText('finCanceledUsers', fmtNum(headline.canceledUsers || 0));
            setText('finLedgerHint', 'Eventos financeiros no ledger: ' + fmtNum(data?.ledger?.financialEvents || 0));

            renderBars('finStatusChart', statusSeries, {
              label: function(item){ return item.label || '—'; },
              value: function(item){ return item.count || 0; },
              display: function(item){ return fmtNum(item.count || 0) + ' · ' + fmtPct(item.pct || 0); },
              meta: function(item){ return 'Participação na base'; }
            });

            renderBars('finPaymentChart', paymentMethods, {
              label: function(item){ return item.label || '—'; },
              value: function(item){ return item.count || 0; },
              display: function(item){ return fmtNum(item.count || 0); },
              meta: function(item){ return 'Método salvo'; }
            });

            renderBars('finPlanRevenueChart', plans.slice(0, 8), {
              label: function(item){ return (item.name || item.code || '—') + ' (' + (item.code || '—') + ')'; },
              value: function(item){ return item.mrrCents || 0; },
              display: function(item){ return fmtBRL(item.mrrCents || 0); },
              meta: function(item){ return 'Usuários: ' + fmtNum(item.count || 0) + ' · Uso médio: ' + String(item.avgUsagePerUser || 0).replace('.', ','); }
            });

            renderBars('finMonthlyUsageChart', monthlyUsage, {
              label: function(item){ return item.label || '—'; },
              value: function(item){ return item.descriptions || 0; },
              display: function(item){ return fmtNum(item.descriptions || 0) + ' descrições'; },
              meta: function(item){ return 'MRR de referência: ' + fmtBRL(item.mrrCents || 0); }
            });

            const plansRows = plans.map(function(item){
              return '<tr>' +
                '<td><b>' + esc(item.name || item.code || '—') + '</b><div class="muted" style="font-size:12px;">' + esc(item.code || '') + '</div></td>' +
                '<td>' + esc(fmtNum(item.count || 0)) + '</td>' +
                '<td>' + esc(fmtBRL(item.mrrCents || 0)) + '</td>' +
                '<td>' + esc(String(item.avgUsagePerUser || 0).replace('.', ',')) + '</td>' +
              '</tr>';
            }).join('');
            renderTableRows('finPlansRows', plansRows, 4, 'Nenhum plano encontrado.');

            const citiesRows = cities.map(function(item){
              return '<tr><td>' + esc(item.city || '—') + '</td><td><b>' + esc(fmtNum(item.count || 0)) + '</b></td></tr>';
            }).join('');
            renderTableRows('finCitiesRows', citiesRows, 2, 'Nenhuma cidade preenchida.');

            const statesRows = states.map(function(item){
              return '<tr><td>' + esc(item.state || '—') + '</td><td><b>' + esc(fmtNum(item.count || 0)) + '</b></td></tr>';
            }).join('');
            renderTableRows('finStatesRows', statesRows, 2, 'Nenhum estado preenchido.');

            const paymentsRows = recentPayments.map(function(item){
              const desc = [item.event, item.description].filter(Boolean).join(' · ');
              const value = item.value === null || item.value === undefined || Number.isNaN(Number(item.value)) ? '—' : fmtMoney(item.value);
              return '<tr>' +
                '<td><code>' + esc(item.when || '—') + '</code><div class="muted" style="font-size:12px;">' + esc(desc || 'Evento financeiro') + '</div></td>' +
                '<td>' + esc(item.status || '—') + '<div class="muted" style="font-size:12px;">' + esc(item.paymentId || item.subscriptionId || '—') + '</div></td>' +
                '<td><b>' + esc(value) + '</b></td>' +
                '<td>' + esc(item.customerName || '—') + '</td>' +
              '</tr>';
            }).join('');
            renderTableRows('finPaymentsRows', paymentsRows, 4, 'Nenhum evento financeiro recente localizado no ledger.');

            renderHealthPills('finHealthPills', [
              { label: 'Com billing', value: fmtPct(headline.billingCoveragePct || 0) },
              { label: 'Com nome', value: fmtPct(headline.nameCoveragePct || 0) },
              { label: 'Com cliente Asaas', value: fmtNum(data?.quality?.usersWithAsaasCustomer || 0) },
              { label: 'Com assinatura Asaas', value: fmtNum(data?.quality?.usersWithSubscription || 0) },
              { label: 'Descrições no mês', value: fmtNum(headline.descriptionsMonth || 0) },
              { label: 'Inconsistências', value: fmtNum(issueSummary.reduce(function(acc, item){ return acc + Number(item.count || 0); }, 0)) },
            ]);
          }

          document.addEventListener('DOMContentLoaded', function(){
            const reloadBtn = document.getElementById('financeReloadBtn');
            if (reloadBtn) reloadBtn.addEventListener('click', loadFinance);
            loadFinance();
          });
        })();
      </script>
    `;

    const html = layoutBase({
      title: "Dashboard Financeiro SaaS",
      activePath: "/admin/finance-saas-ui",
      content: inner,
      headExtra,
      scriptExtra,
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // ===================== Financeiro • Asaas (UI + APIs) =====================
  // Página: Reconciliação + Histórico (Ledger de webhooks)
  router.get("/finance-asaas-ui", async (req, res) => {
    const inner = `
      <div class="row" style="justify-content:space-between; align-items:flex-end; gap:16px;">
        <div>
          <h2 style="margin:0 0 6px 0;">💰 Financeiro — Asaas</h2>
          <div class="muted">Reconciliação rápida por usuário + histórico dos eventos recebidos via webhook (ledger).</div>
        </div>
        <div class="row" style="gap:8px; flex-wrap:wrap; justify-content:flex-end;">
          <a class="pill" href="/admin/asaas-test-ui">🧪 Asaas Teste</a>
        </div>
      </div>

      <div class="grid" style="margin-top:14px; grid-template-columns: 1.2fr 0.8fr; gap:14px;">
        <div class="card pad">
          <h3 style="margin:0 0 8px 0;">🔎 Reconciliação por usuário</h3>
          <div class="muted" style="margin-bottom:10px;">Informe o waId (55DDXXXXXXXXX) para consultar status/plano + dados do Asaas.</div>

          <div class="row" style="gap:8px; flex-wrap:wrap;">
            <input id="waId" class="input" placeholder="Ex: 5511980000000" style="min-width:260px; flex:1;" />
            <button class="primary" onclick="loadUser()">Buscar</button>
          </div>

          <div class="hr"></div>

          <div id="userOut" class="muted">Nenhuma consulta ainda.</div>

          <div class="hr"></div>
          <details>
            <summary class="muted">Ver JSON bruto</summary>
            <pre id="userRaw" style="white-space:pre-wrap;"></pre>
          </details>
        </div>

        <div class="card pad">
          <div class="row" style="justify-content:space-between; align-items:flex-end; gap:12px;">
            <div>
              <h3 style="margin:0 0 8px 0;">📜 Histórico (Ledger)</h3>
              <div class="muted">Eventos recentes recebidos do Asaas com leitura operacional do ledger.</div>
            </div>
            <div class="row" style="gap:8px; flex-wrap:wrap; justify-content:flex-end;">
              <label class="pill"><input id="eventsOnlyFailures" type="checkbox" style="margin-right:6px;" /> Somente falhas</label>
              <label class="pill"><input id="eventsOnlyInconsistencies" type="checkbox" style="margin-right:6px;" /> Inconsistências</label>
              <button class="ghost" onclick="loadEvents()">Atualizar</button>
            </div>
          </div>

          <div class="row" style="gap:8px; flex-wrap:wrap; margin-top:8px;">
            <span class="pill">Total: <b id="eventsTotal">—</b></span>
            <span class="pill">Falhas: <b id="eventsFailures">—</b></span>
            <span class="pill">Inconsistências: <b id="eventsInconsistencies">—</b></span>
          </div>

          <div class="hr"></div>
          <div id="eventsOut" class="muted">Carregando…</div>

          <div class="hr"></div>
          <details>
            <summary class="muted">Ver JSON bruto</summary>
            <pre id="eventsRaw" style="white-space:pre-wrap;"></pre>
          </details>
        </div>
      </div>

      <div id="modal" class="modal" style="display:none;">
        <div class="modal__backdrop" onclick="hideModal()"></div>
        <div class="modal__card">
          <div class="row" style="justify-content:space-between; align-items:center;">
            <h3 id="modalTitle" style="margin:0;">Aviso</h3>
            <button class="ghost" onclick="hideModal()">Fechar</button>
          </div>
          <div class="hr"></div>
          <pre id="modalBody" style="white-space:pre-wrap; margin:0;"></pre>
        </div>
      </div>

      <style>
        .modal { position:fixed; inset:0; z-index:9999; }
        .modal__backdrop { position:absolute; inset:0; background:rgba(0,0,0,.35); }
        .modal__card { position:relative; width:min(920px, calc(100% - 24px)); margin:42px auto; background:#fff; border-radius:14px; padding:14px; box-shadow:0 14px 40px rgba(0,0,0,.22); }
        pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size:12px; }
      </style>

      <script>
        function esc(s){
          return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
        }
        function showModal(title, obj){
          document.getElementById('modalTitle').textContent = title || 'Aviso';
          document.getElementById('modalBody').textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
          document.getElementById('modal').style.display = 'block';
        }
        function hideModal(){
          document.getElementById('modal').style.display = 'none';
        }

        async function loadEvents(){
          const onlyFailures = !!document.getElementById('eventsOnlyFailures')?.checked;
          const onlyInconsistencies = !!document.getElementById('eventsOnlyInconsistencies')?.checked;
          const p = new URLSearchParams({ limit: '50', offset: '0' });
          if (onlyFailures) p.set('onlyFailures', 'true');
          if (onlyInconsistencies) p.set('onlyInconsistencies', 'true');
          const r = await fetch('/admin/api/finance/asaas/events?' + p.toString());
          const j = await r.json().catch(()=>({}));
          document.getElementById('eventsRaw').textContent = JSON.stringify(j, null, 2);

          const items = Array.isArray(j.items) ? j.items : [];
          document.getElementById('eventsTotal').textContent = String(items.length);
          document.getElementById('eventsFailures').textContent = String(items.filter(it => !!it.isFailure).length);
          document.getElementById('eventsInconsistencies').textContent = String(items.filter(it => !!it.isInconsistency).length);
          if(!items.length){
            document.getElementById('eventsOut').innerHTML = '<div class="muted">Nenhum evento registrado.</div>';
            return;
          }

          const html = '<table><thead><tr><th>Quando</th><th>Evento</th><th>Categoria</th><th>Status</th><th>Nível</th><th>Ref</th><th>Resumo</th></tr></thead><tbody>' +
            items.map(it => {
              const when = it.ts || it.receivedAt || it.dateCreated || it.createdAt || '';
              const ev = it.event || it.type || it.kind || '';
              const category = it.category || it.eventType || '—';
              const status = it.status || it.payment?.status || it.subscription?.status || '—';
              const severity = it.severity || (it.isFailure ? 'error' : (it.isInconsistency ? 'warn' : 'info'));
              const ref = it.paymentId || it.payment?.id || it.subscriptionId || it.subscription?.id || it.invoiceId || it.id || it.externalReference || '';
              const summary = it.summary || it.message || it.couponCode || it.couponLedger?.couponCode || '—';
              return '<tr>' +
                '<td><code>'+esc(when)+'</code></td>' +
                '<td>'+esc(ev)+'</td>' +
                '<td><b>'+esc(category)+'</b></td>' +
                '<td>'+esc(status)+'</td>' +
                '<td>'+esc(severity)+'</td>' +
                '<td><code>'+esc(ref)+'</code></td>' +
                '<td>'+esc(summary)+'</td>' +
              '</tr>';
            }).join('') +
            '</tbody></table>';

          document.getElementById('eventsOut').innerHTML = html;
        }

        async function loadUser(){
          const waId = String(document.getElementById('waId').value || '').trim();
          if(!waId){
            showModal('Atenção', 'Informe o waId.');
            return;
          }
          const r = await fetch('/admin/api/finance/asaas/user?waId=' + encodeURIComponent(waId));
          const j = await r.json().catch(()=>({ ok:false, error:'Falha ao ler resposta'}));
          document.getElementById('userRaw').textContent = JSON.stringify(j, null, 2);

          if(!j.ok){
            document.getElementById('userOut').innerHTML = '<div class="muted">Erro: '+esc(j.error||'')+'</div>';
            return;
          }

          const u = j.user || {};
          const sub = j.subscription || null;
          const pays = Array.isArray(j.payments?.data) ? j.payments.data : (Array.isArray(j.payments?.items) ? j.payments.items : []);
          const subStatus = sub && sub.status ? sub.status : (u.asaasSubscriptionId ? '(não encontrado)' : '—');

          const cancelBtn = (sub && sub.id) ? '<button class="danger" style="margin-left:8px;" onclick="cancelSub(\\''+esc(sub.id)+'\\', \\''+esc(u.waId)+'\\')">Cancelar assinatura</button>' : '';

          const html =
            '<div class="row" style="justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">' +
              '<div>' +
                '<div><b>Nome:</b> '+esc(u.fullName||'—')+'</div>' +
                '<div><b>waId:</b> <code>'+esc(u.waId||'')+'</code></div>' +
                '<div><b>Status:</b> '+esc(u.status||'')+'</div>' +
                '<div><b>Plano:</b> '+esc(u.plan||'')+'</div>' +
                '<div><b>Forma de pagamento:</b> '+esc(u.paymentMethod||'—')+'</div>' +
                '<div><b>Documento:</b> '+esc(u.doc?.docType ? (u.doc.docType+' • ****'+(u.doc.docLast4||'')) : '—')+'</div>' +
              '</div>' +
              '<div>' +
                '<div><b>Asaas Customer:</b> <code>'+esc(u.asaasCustomerId||'—')+'</code></div>' +
                '<div><b>Asaas Subscription:</b> <code>'+esc(u.asaasSubscriptionId||'—')+'</code></div>' +
                '<div><b>Status assinatura:</b> '+esc(subStatus) + cancelBtn + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="hr"></div>' +
            '<div><b>Pagamentos (recentes)</b></div>' +
            (pays.length
              ? ('<table><thead><tr><th>Data</th><th>Status</th><th>Valor</th><th>Id</th></tr></thead><tbody>' +
                 pays.slice(0, 12).map(p => {
                   const d = p.dateCreated || p.createdAt || '';
                   const st = p.status || '';
                   const v = (p.value !== undefined && p.value !== null) ? String(p.value) : '';
                   const id = p.id || '';
                   return '<tr><td><code>'+esc(d)+'</code></td><td>'+esc(st)+'</td><td>'+esc(v)+'</td><td><code>'+esc(id)+'</code></td></tr>';
                 }).join('') +
               '</tbody></table>')
              : '<div class="muted">Nenhum pagamento encontrado para este usuário.</div>'
            );

          document.getElementById('userOut').innerHTML = html;
        }

        async function cancelSub(subId, waId){
          if(!confirm('Cancelar a assinatura no Asaas?')){
            return;
          }
          const r = await fetch('/admin/api/finance/asaas/cancel-subscription', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscriptionId: subId, waId })
          });
          const j = await r.json().catch(()=>({ ok:false, error:'Falha ao ler resposta'}));
          showModal('Resultado', j);
          if(j.ok){
            await loadUser();
          }
        }

        loadEvents();
      </script>
    `;

    const html = layoutBase({ title: "Financeiro — Asaas", activePath: "/admin/finance-asaas-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  // APIs (JSON)
  router.get("/api/finance/asaas/events", async (req, res) => {
    const userId = await resolveAdminUserRef(String(req.query?.userId || req.query?.waId || "").trim());
    const limit = Number(req.query?.limit || 50);
    const offset = Number(req.query?.offset || 0);
    const eventType = String(req.query?.eventType || "").trim();
    const couponCode = String(req.query?.couponCode || "").trim();
    const paymentId = String(req.query?.paymentId || "").trim();
    const subscriptionId = String(req.query?.subscriptionId || "").trim();
    const onlyFailures = normalizeAdminBool(req.query?.onlyFailures, false);
    const onlyInconsistencies = normalizeAdminBool(req.query?.onlyInconsistencies, false);
    const data = await listAsaasEvents({ userId, limit, offset, eventType, couponCode, paymentId, subscriptionId, onlyFailures, onlyInconsistencies });
    return res.json(data);
  });

  router.get("/api/finance/asaas/user", async (req, res) => {
    try {
      const userId = await requireUserRef(req);
      const [user, identifiers] = await Promise.all([
        getUserSnapshot(userId),
        getUserIdentifiers(userId).catch(() => null),
      ]);

      let subscription = null;
      if (user.asaasSubscriptionId) {
        try {
          subscription = await getSubscription(user.asaasSubscriptionId);
        } catch (e) {
          subscription = null;
        }
      }

      const payments = user.asaasCustomerId
        ? await listPayments({ customerId: user.asaasCustomerId, limit: 20, offset: 0 })
        : (user.asaasSubscriptionId ? await listPayments({ subscriptionId: user.asaasSubscriptionId, limit: 20, offset: 0 }) : { data: [] });

      return res.json({ ok: true, userId, waId: identifiers?.waId || user.waId || "", user, subscription, payments });
    } catch (e) {
      const msg = String(e?.message || e || "Erro").slice(0, 300);
      return res.status(Number(e?.statusCode || 500)).json({ ok: false, error: msg });
    }
  });

  router.post("/api/finance/asaas/cancel-subscription", async (req, res) => {
    try {
      const subscriptionId = String(req.body?.subscriptionId || "").trim();
      const userId = await resolveAdminUserRef(String(req.body?.userId || req.body?.waId || "").trim());
      const identifiers = userId ? await getUserIdentifiers(userId).catch(() => null) : null;

      let subId = subscriptionId;
      if (!subId && userId) {
        const u = await getUserSnapshot(userId);
        subId = String(u.asaasSubscriptionId || "").trim();
      }

      if (!subId) {
        return res.status(400).json({ ok: false, error: "subscriptionId ausente." });
      }

      const out = await cancelSubscription(subId);
      await safeRecordAdminAudit(req, {
        module: "finance",
        action: "CANCEL_ASAAS_SUBSCRIPTION",
        waId: identifiers?.waId || "",
        targetId: subId,
        summary: `Solicitou o cancelamento da assinatura ${subId}.`,
        after: { canceled: true, response: out },
        meta: { userId: userId || "", waId: identifiers?.waId || "" },
      });
      return res.json({ ok: true, canceled: out, userId, waId: identifiers?.waId || "" });
    } catch (e) {
      const msg = String(e?.message || e || "Erro").slice(0, 300);
      return res.status(Number(e?.statusCode || 500)).json({ ok: false, error: msg });
    }
  });

  // ===================== Asaas Teste (UI + API) =====================
  router.get("/asaas-test-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
          <div>
            <h2 style="margin:0 0 6px 0;">🧪 Asaas Teste</h2>
            <div class="muted">Teste de conectividade usando a mesma chave/ambiente do backend (sem expor dados sensíveis).</div>
          </div>
          <div class="row" style="gap:8px;">
            <button class="primary" onclick="run()">Testar agora</button>
          </div>
        </div>

        <div class="hr"></div>
        <div id="out" class="muted">Clique em “Testar agora”.</div>

        <div class="hr"></div>
        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="raw" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <div id="modal" class="modal" style="display:none;">
        <div class="modal__backdrop" onclick="hideModal()"></div>
        <div class="modal__card">
          <div class="row" style="justify-content:space-between; align-items:center;">
            <h3 style="margin:0;">Resultado</h3>
            <button class="ghost" onclick="hideModal()">Fechar</button>
          </div>
          <div class="hr"></div>
          <pre id="modalBody" style="white-space:pre-wrap; margin:0;"></pre>
        </div>
      </div>

      <style>
        .modal { position:fixed; inset:0; z-index:9999; }
        .modal__backdrop { position:absolute; inset:0; background:rgba(0,0,0,.35); }
        .modal__card { position:relative; width:min(820px, calc(100% - 24px)); margin:42px auto; background:#fff; border-radius:14px; padding:14px; box-shadow:0 14px 40px rgba(0,0,0,.22); }
      </style>

      <script>
        function esc(s){
          return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
        }
        function showModal(obj){
          document.getElementById('modalBody').textContent = JSON.stringify(obj, null, 2);
          document.getElementById('modal').style.display = 'block';
        }
        function hideModal(){
          document.getElementById('modal').style.display = 'none';
        }
        async function run(){
          const r = await fetch('/admin/api/asaas/test');
          const j = await r.json().catch(()=>({ ok:false, error:'Falha ao ler resposta' }));
          document.getElementById('raw').textContent = JSON.stringify(j, null, 2);
          document.getElementById('out').innerHTML = j.ok
            ? '<div><b>✅ OK</b> — Consegui falar com o Asaas.</div>'
            : '<div><b>❌ Falha</b> — '+esc(j.error||'')+'</div>';
          showModal(j);
        }
      </script>
    `;
    const html = layoutBase({ title: "Asaas Teste", activePath: "/admin/asaas-test-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/api/asaas/test", async (req, res) => {
    try {
      const out = await listPayments({ limit: 1, offset: 0 });
      return res.json({ ok: true, sampleCount: Array.isArray(out?.data) ? out.data.length : 0 });
    } catch (e) {
      const msg = String(e?.message || e || "Erro").slice(0, 300);
      return res.status(500).json({ ok: false, error: msg });
    }
  });


router.get("/window24h-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">🕒 Janela 24h</h3>
            <div class="muted">Usuários que falaram com o bot nas últimas 24 horas (regra da janela do WhatsApp).</div>
          </div>
          <button class="primary" onclick="load()">Atualizar</button>
        </div>

        <div class="hr"></div>

        <div class="row">
          <input id="filter" placeholder="filtrar por waId (contém)" style="min-width:320px" />
          <button onclick="load()">Aplicar filtro</button>
        </div>

        <div class="hr"></div>

        <div class="row">
          <span class="pill">Total: <b id="total">—</b></span>
          <span class="pill">Agora: <b id="now">—</b></span>
        </div>

        <div class="hr"></div>

        <div id="list" class="muted">Carregando…</div>

        <div class="hr"></div>
        <details>
          <summary class="muted">Ver JSON bruto</summary>
          <pre id="raw" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <script>
        function esc(s){
          return String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
        }
        async function load(){
          const f = (document.getElementById('filter').value||'').trim();
          const r = await fetch('/admin/window24h' + (f ? ('?filter=' + encodeURIComponent(f)) : ''));
          const j = await r.json().catch(()=>({}));
          document.getElementById('raw').textContent = JSON.stringify(j, null, 2);

          document.getElementById('total').textContent = String(j.count ?? 0);
          document.getElementById('now').textContent = new Date().toLocaleString('pt-BR');

          const users = Array.isArray(j.users) ? j.users : [];
          if(!users.length){
            document.getElementById('list').innerHTML = '<div class="muted">Nenhum usuário na janela.</div>';
            return;
          }

          const html = '<table><thead><tr><th>waId</th><th>Last Seen</th><th>Ações</th></tr></thead><tbody>' +
            users.map(u => {
              return '<tr>' +
                '<td><code>'+esc(u.waId||'')+'</code></td>' +
                '<td>'+esc(u.lastSeen||'')+'</td>' +
                '<td class="row">' +
                  '<a class="pill" href="/admin/users-ui?waId='+encodeURIComponent(u.waId||'')+'">abrir</a>' +
                  '<a class="pill" href="/admin/send-test?waId='+encodeURIComponent(u.waId||'')+'">send-test</a>' +
                '</td>' +
              '</tr>';
            }).join('') +
            '</tbody></table>';

          document.getElementById('list').innerHTML = html;
        }
        load();
      </script>
    `;
    const html = layoutBase({ title: "Janela 24h", activePath: "/admin/window24h-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });


  // -----------------------------
  // ✅ Broadcast UI
  // -----------------------------
  router.get("/broadcast-ui", async (req, res) => {
    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between;">
          <div>
            <h3 style="margin:0 0 6px 0;">📣 Broadcast</h3>
            <div class="muted">Cria uma campanha e dispara automaticamente apenas para usuários na janela 24h. Quem estiver fora fica pendente e será enviado ao entrar na janela.</div>
          </div>
          <a class="pill" href="/admin/campaigns-ui">📦 Ver campanhas</a>
        </div>

        <div class="hr"></div>

        <div class="row">
          <label class="pill">Plano alvo:
            <select id="plan">
              <option value="">(todos os planos)</option>
              <option value="DE_VEZ_EM_QUANDO">DE_VEZ_EM_QUANDO</option>
              <option value="SEMPRE_POR_PERTO">SEMPRE_POR_PERTO</option>
              <option value="MELHOR_AMIGO">MELHOR_AMIGO</option>
            </select>
          </label>
        </div>

        <div style="margin-top:10px;">
          <input id="subject" placeholder="Assunto interno (ex: Promo fevereiro)" style="min-width:420px; width:100%;" />
        </div>

        <div style="margin-top:10px;">
          <textarea id="message" placeholder="Mensagem do broadcast (texto)"></textarea>
        </div>

        <div class="row" style="margin-top:10px;">
          <button class="primary" onclick="send()">Criar campanha e enviar (24h)</button>
          <span id="status" class="muted"></span>
        </div>

        <div class="hr"></div>
        <details>
          <summary class="muted">Ver resposta</summary>
          <pre id="out" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <script>
        async function send(){
          const plan = (document.getElementById('plan').value||'').trim();
          const subject = (document.getElementById('subject').value||'').trim();
          const text = (document.getElementById('message').value||'').trim();
          if(!subject){ alert('Informe o assunto'); return; }
          if(!text){ alert('Escreva a mensagem'); return; }

          const body = { subject, text, planTargets: plan ? [plan] : [] };

          document.getElementById('status').textContent = 'Enviando...';
          const r = await fetch('/admin/campaigns', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
          const j = await r.json().catch(()=>({}));
          document.getElementById('out').textContent = JSON.stringify(j, null, 2);
          document.getElementById('status').textContent = j.ok ? '✅ Campanha criada e disparo iniciado' : ('⚠️ ' + (j.error||'erro'));
        }
      </script>
    `;
    const html = layoutBase({ title: "Broadcast", activePath: "/admin/broadcast-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });



  // -----------------------------
  // ✅ Campanhas (UI + APIs)
  // -----------------------------
  
  router.get("/campaigns-ui", async (req, res) => {
    const categoryOptions = renderSelectOptions(campaignOptionEntries(CAMPAIGN_CATEGORY), "");
    const channelOptions = renderSelectOptions(campaignOptionEntries(CAMPAIGN_CHANNEL), "");
    const triggerTypeOptions = renderSelectOptions(campaignOptionEntries(CAMPAIGN_TRIGGER_TYPE), "");
    const messageModeOptions = renderSelectOptions(campaignOptionEntries(CAMPAIGN_MESSAGE_MODE), "copy_key");
    const conflictGroupOptions = renderSelectOptions(campaignOptionEntries(CAMPAIGN_CONFLICT_GROUP), "");

    const inner = `
      <div class="card pad">
        <div class="row" style="justify-content:space-between; align-items:flex-start;">
          <div>
            <h3 style="margin:0 0 6px 0;">📦 Campanhas</h3>
            <div class="muted">Gerencie o motor de campanhas sem deploy. Aqui você pode criar, editar, duplicar, ativar, arquivar e simular campanhas.</div>
          </div>
          <div class="row">
            <button class="primary" onclick="loadCampaigns()">Atualizar</button>
            <a class="pill" href="/admin/broadcast-ui">📣 Broadcast legado</a>
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid cols2">
          <div class="card pad">
            <h4 style="margin:0 0 10px 0;">Nova campanha</h4>
            <div class="grid">
              <input id="cp_name" placeholder="Nome da campanha" />
              <input id="cp_code" placeholder="Código estável (ex: TRIAL_CONVERSION_20H)" />
              <textarea id="cp_description" placeholder="Descrição interna"></textarea>

              <label class="muted">Categoria</label>
              <select id="cp_category">${categoryOptions}</select>

              <label class="muted">Canal</label>
              <select id="cp_channel">${channelOptions}</select>

              <label class="muted">Modo da mensagem</label>
              <select id="cp_messageMode">${messageModeOptions}</select>

              <input id="cp_copyKey" placeholder="copyKey (quando messageMode = copy_key)" />
              <textarea id="cp_inlineText" placeholder="Texto inline (quando messageMode = inline_text)"></textarea>

              <div class="grid cols3">
                <div><label class="muted">Prioridade</label><input id="cp_priority" type="number" value="100" /></div>
                <div><label class="muted">Delay (min)</label><input id="cp_delayMinutes" type="number" value="0" /></div>
                <div><label class="muted">Cooldown (h)</label><input id="cp_cooldownHours" type="number" value="24" /></div>
              </div>

              <label class="muted">Grupo de conflito</label>
              <select id="cp_conflictGroup">${conflictGroupOptions}</select>

              <label class="muted">Tipo de gatilho</label>
              <select id="cp_triggerType">${triggerTypeOptions}</select>

              <input id="cp_triggerEvent" placeholder="Evento do gatilho (opcional)" />

              <div class="grid cols2">
                <input id="cp_requiredStatuses" placeholder="requiredStatuses (csv)" />
                <input id="cp_excludedStatuses" placeholder="excludedStatuses (csv)" />
                <input id="cp_requiredPlanCodes" placeholder="requiredPlanCodes (csv)" />
                <input id="cp_excludedPlanCodes" placeholder="excludedPlanCodes (csv)" />
              </div>

              <div class="grid cols3">
                <div><label class="muted">Min trial</label><input id="cp_minTrialUsed" type="number" value="0" /></div>
                <div><label class="muted">Max trial</label><input id="cp_maxTrialUsed" type="number" value="0" /></div>
                <div><label class="muted">Max envios/usuário</label><input id="cp_maxSendsPerUser" type="number" value="1" /></div>
              </div>

              <div class="grid cols2">
                <label class="pill"><input id="cp_isActive" type="checkbox" checked /> Ativa</label>
                <label class="pill"><input id="cp_sendOncePerUser" type="checkbox" /> Enviar apenas uma vez por usuário</label>
                <label class="pill"><input id="cp_requiresWindow24hOpen" type="checkbox" checked /> Exigir janela 24h</label>
                <label class="pill"><input id="cp_requiresActivePlan" type="checkbox" /> Exigir plano ativo</label>
                <label class="pill"><input id="cp_requiresNoActivePlan" type="checkbox" /> Exigir sem plano ativo</label>
                <label class="pill"><input id="cp_requiresTrialEnded" type="checkbox" /> Exigir trial encerrado</label>
                <label class="pill"><input id="cp_requiresPlansViewed" type="checkbox" /> Exigir planos vistos</label>
                <label class="pill"><input id="cp_requiresCheckoutStarted" type="checkbox" /> Exigir checkout iniciado</label>
                <label class="pill"><input id="cp_requiresPaymentPending" type="checkbox" /> Exigir pagamento pendente</label>
                <label class="pill"><input id="cp_blockIfInCheckout" type="checkbox" /> Bloquear se estiver em checkout</label>
                <label class="pill"><input id="cp_blockIfPaymentPending" type="checkbox" /> Bloquear se houver pagamento pendente</label>
                <label class="pill"><input id="cp_blockIfBlocked" type="checkbox" checked /> Bloquear usuário bloqueado</label>
                <label class="pill"><input id="cp_businessHoursOnly" type="checkbox" /> Somente em horário comercial</label>
              </div>

              <input id="cp_startAt" placeholder="Início (ISO opcional)" />
              <input id="cp_endAt" placeholder="Fim (ISO opcional)" />
              <input id="cp_timezone" value="America/Sao_Paulo" placeholder="Timezone" />
              <textarea id="cp_notes" placeholder="Observações internas"></textarea>

              <div class="row">
                <button id="cp_save_btn" class="primary" onclick="createManagedCampaign()">Salvar campanha</button>
                <button id="cp_cancel_btn" onclick="cancelCampaignEditing()" style="display:none;">Cancelar edição</button>
                <span id="cp_status" class="muted"></span>
              </div>
            </div>
          </div>

          <div class="card pad">
            <h4 style="margin:0 0 10px 0;">Simulação</h4>
            <div class="grid">
              <input id="sim_userRef" placeholder="userId ou waId" />
              <input id="sim_campaignId" placeholder="campaignId opcional" />
              <button class="primary" onclick="simulateCampaign()">Simular elegibilidade</button>
              <pre id="sim_out" style="white-space:pre-wrap; min-height:200px;"></pre>
            </div>
          </div>
        </div>

        <div class="hr"></div>
        <div id="campaigns_list" class="muted">Carregando campanhas…</div>

        <div class="hr"></div>
        <details>
          <summary class="muted">JSON bruto</summary>
          <pre id="campaigns_raw" style="white-space:pre-wrap;"></pre>
        </details>
      </div>

      <script>
        function esc(s){
          return String(s ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
        }
        let editingCampaignId = "";

        function boolVal(id){ return !!document.getElementById(id)?.checked; }
        function strVal(id){ return String(document.getElementById(id)?.value || '').trim(); }
        function numVal(id){ const v = Number(document.getElementById(id)?.value || 0); return Number.isFinite(v) ? Math.trunc(v) : 0; }
        function setStatus(msg, kind){
          const el = document.getElementById('cp_status');
          if(!el) return;
          el.textContent = msg || '';
          el.style.color = kind === 'error' ? '#991b1b' : kind === 'success' ? '#065f46' : kind === 'info' ? '#1d4ed8' : '';
        }
        function setSaveButtonBusy(isBusy){
          const btn = document.getElementById('cp_save_btn');
          if(!btn) return;
          btn.disabled = !!isBusy;
          btn.textContent = isBusy ? (editingCampaignId ? 'Atualizando...' : 'Salvando...') : (editingCampaignId ? 'Atualizar campanha' : 'Salvar campanha');
        }
        function syncEditingUi(){
          const cancelBtn = document.getElementById('cp_cancel_btn');
          const saveBtn = document.getElementById('cp_save_btn');
          if(cancelBtn) cancelBtn.style.display = editingCampaignId ? '' : 'none';
          if(saveBtn) saveBtn.textContent = editingCampaignId ? 'Atualizar campanha' : 'Salvar campanha';
        }
        function resetCampaignForm(){
          const defaults = {
            cp_name: '',
            cp_code: '',
            cp_description: '',
            cp_category: '',
            cp_channel: '',
            cp_messageMode: 'copy_key',
            cp_copyKey: '',
            cp_inlineText: '',
            cp_priority: '100',
            cp_delayMinutes: '0',
            cp_cooldownHours: '24',
            cp_conflictGroup: '',
            cp_triggerType: '',
            cp_triggerEvent: '',
            cp_requiredStatuses: '',
            cp_excludedStatuses: '',
            cp_requiredPlanCodes: '',
            cp_excludedPlanCodes: '',
            cp_minTrialUsed: '0',
            cp_maxTrialUsed: '0',
            cp_maxSendsPerUser: '1',
            cp_startAt: '',
            cp_endAt: '',
            cp_timezone: 'America/Sao_Paulo',
            cp_notes: ''
          };
          Object.keys(defaults).forEach((id) => {
            const el = document.getElementById(id);
            if(el) el.value = defaults[id];
          });
          const checks = {
            cp_isActive: true,
            cp_sendOncePerUser: false,
            cp_requiresWindow24hOpen: true,
            cp_requiresActivePlan: false,
            cp_requiresNoActivePlan: false,
            cp_requiresTrialEnded: false,
            cp_requiresPlansViewed: false,
            cp_requiresCheckoutStarted: false,
            cp_requiresPaymentPending: false,
            cp_blockIfInCheckout: false,
            cp_blockIfPaymentPending: false,
            cp_blockIfBlocked: true,
            cp_businessHoursOnly: false
          };
          Object.keys(checks).forEach((id) => {
            const el = document.getElementById(id);
            if(el) el.checked = !!checks[id];
          });
        }
        function clearCampaignEditing(shouldResetForm = true){
          editingCampaignId = '';
          syncEditingUi();
          if(shouldResetForm) resetCampaignForm();
        }
        function cancelCampaignEditing(){
          clearCampaignEditing(true);
          setStatus('Edição cancelada.', 'info');
        }
        function csvVal(arr, upper){
          const base = Array.isArray(arr) ? arr : [];
          const items = base.map((item) => String(item || '').trim()).filter(Boolean);
          return upper ? items.map((item) => item.toUpperCase()).join(',') : items.join(',');
        }
        function populateCampaignForm(campaign){
          const c = campaign || {};
          const setVal = (id, value) => {
            const el = document.getElementById(id);
            if(el) el.value = value == null ? '' : String(value);
          };
          const setChecked = (id, value) => {
            const el = document.getElementById(id);
            if(el) el.checked = !!value;
          };
          setVal('cp_name', c.name || '');
          setVal('cp_code', c.code || '');
          setVal('cp_description', c.description || '');
          setVal('cp_category', c.category || '');
          setVal('cp_channel', c.channel || '');
          setVal('cp_messageMode', c.messageMode || 'copy_key');
          setVal('cp_copyKey', c.copyKey || '');
          setVal('cp_inlineText', c.inlineText || '');
          setVal('cp_priority', c.priority ?? 100);
          setVal('cp_delayMinutes', c.delayMinutes ?? 0);
          setVal('cp_cooldownHours', c.cooldownHours ?? 24);
          setVal('cp_conflictGroup', c.conflictGroup || '');
          setVal('cp_triggerType', c.triggerType || '');
          setVal('cp_triggerEvent', c.triggerEvent || '');
          setVal('cp_requiredStatuses', csvVal(c.requiredStatuses, true));
          setVal('cp_excludedStatuses', csvVal(c.excludedStatuses, true));
          setVal('cp_requiredPlanCodes', csvVal(c.requiredPlanCodes, true));
          setVal('cp_excludedPlanCodes', csvVal(c.excludedPlanCodes, true));
          setVal('cp_minTrialUsed', c.minTrialUsed ?? 0);
          setVal('cp_maxTrialUsed', c.maxTrialUsed ?? 0);
          setVal('cp_maxSendsPerUser', c.maxSendsPerUser ?? 1);
          setChecked('cp_isActive', c.isActive);
          setChecked('cp_sendOncePerUser', c.sendOncePerUser);
          setChecked('cp_requiresWindow24hOpen', c.requiresWindow24hOpen);
          setChecked('cp_requiresActivePlan', c.requiresActivePlan);
          setChecked('cp_requiresNoActivePlan', c.requiresNoActivePlan);
          setChecked('cp_requiresTrialEnded', c.requiresTrialEnded);
          setChecked('cp_requiresPlansViewed', c.requiresPlansViewed);
          setChecked('cp_requiresCheckoutStarted', c.requiresCheckoutStarted);
          setChecked('cp_requiresPaymentPending', c.requiresPaymentPending);
          setChecked('cp_blockIfInCheckout', c.blockIfInCheckout);
          setChecked('cp_blockIfPaymentPending', c.blockIfPaymentPending);
          setChecked('cp_blockIfBlocked', c.blockIfBlocked);
          setChecked('cp_businessHoursOnly', c.businessHoursOnly);
          setVal('cp_startAt', c.startAt || '');
          setVal('cp_endAt', c.endAt || '');
          setVal('cp_timezone', c.timezone || 'America/Sao_Paulo');
          setVal('cp_notes', c.notes || '');
        }
        function buildPayload(){
          return {
            name: strVal('cp_name'),
            code: strVal('cp_code'),
            description: strVal('cp_description'),
            category: strVal('cp_category'),
            channel: strVal('cp_channel'),
            messageMode: strVal('cp_messageMode'),
            copyKey: strVal('cp_copyKey'),
            inlineText: strVal('cp_inlineText'),
            priority: numVal('cp_priority'),
            delayMinutes: numVal('cp_delayMinutes'),
            cooldownHours: numVal('cp_cooldownHours'),
            conflictGroup: strVal('cp_conflictGroup'),
            triggerType: strVal('cp_triggerType'),
            triggerEvent: strVal('cp_triggerEvent'),
            requiredStatuses: strVal('cp_requiredStatuses'),
            excludedStatuses: strVal('cp_excludedStatuses'),
            requiredPlanCodes: strVal('cp_requiredPlanCodes'),
            excludedPlanCodes: strVal('cp_excludedPlanCodes'),
            minTrialUsed: numVal('cp_minTrialUsed'),
            maxTrialUsed: numVal('cp_maxTrialUsed'),
            maxSendsPerUser: numVal('cp_maxSendsPerUser'),
            isActive: boolVal('cp_isActive'),
            sendOncePerUser: boolVal('cp_sendOncePerUser'),
            requiresWindow24hOpen: boolVal('cp_requiresWindow24hOpen'),
            requiresActivePlan: boolVal('cp_requiresActivePlan'),
            requiresNoActivePlan: boolVal('cp_requiresNoActivePlan'),
            requiresTrialEnded: boolVal('cp_requiresTrialEnded'),
            requiresPlansViewed: boolVal('cp_requiresPlansViewed'),
            requiresCheckoutStarted: boolVal('cp_requiresCheckoutStarted'),
            requiresPaymentPending: boolVal('cp_requiresPaymentPending'),
            blockIfInCheckout: boolVal('cp_blockIfInCheckout'),
            blockIfPaymentPending: boolVal('cp_blockIfPaymentPending'),
            blockIfBlocked: boolVal('cp_blockIfBlocked'),
            businessHoursOnly: boolVal('cp_businessHoursOnly'),
            startAt: strVal('cp_startAt'),
            endAt: strVal('cp_endAt'),
            timezone: strVal('cp_timezone'),
            notes: strVal('cp_notes'),
          };
        }

        async function createManagedCampaign(){
          const payload = buildPayload();
          if(!payload.name){ alert('Informe o nome da campanha.'); return; }
          if(!payload.code){ alert('Informe o código da campanha.'); return; }
          if(payload.messageMode === 'copy_key' && !payload.copyKey){ alert('Informe a copyKey da campanha.'); return; }
          if(payload.messageMode === 'inline_text' && !payload.inlineText){ alert('Informe o texto inline da campanha.'); return; }

          const isEditing = !!editingCampaignId;
          setSaveButtonBusy(true);
          setStatus(isEditing ? 'Atualizando campanha...' : 'Salvando campanha...', 'info');
          try {
            const target = isEditing ? ('/admin/campaigns/' + encodeURIComponent(editingCampaignId)) : '/admin/campaigns';
            const method = isEditing ? 'PUT' : 'POST';
            const r = await fetch(target, {
              method,
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify(payload)
            });
            const j = await r.json().catch(()=>({}));
            document.getElementById('campaigns_raw').textContent = JSON.stringify(j, null, 2);

            if(!r.ok || !j?.ok){
              setStatus('Erro: ' + String(j?.error || 'desconhecido'), 'error');
              return;
            }

            setStatus(String(j?.message || (isEditing ? 'Campanha atualizada com sucesso.' : 'Campanha cadastrada com sucesso.')), 'success');
            clearCampaignEditing(true);
            await loadCampaigns();
          } catch (err) {
            setStatus('Erro: ' + String(err?.message || err || 'desconhecido'), 'error');
          } finally {
            setSaveButtonBusy(false);
            syncEditingUi();
          }
        }

        async function loadCampaigns(){
          const listEl = document.getElementById('campaigns_list');
          if(listEl) listEl.innerHTML = '<div class="muted">Carregando campanhas...</div>';
          try {
            const r = await fetch('/admin/campaigns?mode=managed&limit=100');
            const j = await r.json().catch(()=>({}));
            document.getElementById('campaigns_raw').textContent = JSON.stringify(j, null, 2);

            if(!r.ok || j?.ok === false){
              const errorText = 'Falha ao carregar campanhas: ' + String(j?.error || 'desconhecido');
              if(listEl) listEl.innerHTML = '<div class="badge danger">' + esc(errorText) + '</div>';
              return;
            }

            const items = Array.isArray(j?.campaigns) ? j.campaigns : Array.isArray(j?.items) ? j.items : [];
            if(!items.length){
              if(listEl) listEl.innerHTML = '<div class="muted">Nenhuma campanha cadastrada.</div>';
              return;
            }

            const html = '<table><thead><tr><th>Nome</th><th>Código</th><th>Categoria</th><th>Ativa</th><th>Prioridade</th><th>Canal</th><th>Ações</th></tr></thead><tbody>' +
              items.map((it) => {
                const id = esc(it.id || '');
                const meta = it || {};
                return '<tr>' +
                  '<td><b>' + esc(meta.name || '') + '</b><div class="muted">' + esc(meta.description || '') + '</div></td>' +
                  '<td><code>' + esc(meta.code || '') + '</code></td>' +
                  '<td>' + esc(meta.category || '') + '</td>' +
                  '<td>' + (meta.isActive ? '<span class="badge ok">ATIVA</span>' : '<span class="badge warn">INATIVA</span>') + '</td>' +
                  '<td>' + esc(meta.priority || 0) + '</td>' +
                  '<td>' + esc(meta.channel || '') + '</td>' +
                  '<td class="row">' +
                    '<a class="pill" href="#" onclick="detailsCampaign(&quot;' + id + '&quot;);return false;">detalhes</a>' +
                    '<a class="pill" href="#" onclick="editCampaignUi(&quot;' + id + '&quot;);return false;">editar</a>' +
                    '<a class="pill" href="#" onclick="toggleCampaign(&quot;' + id + '&quot;,' + (!meta.isActive ? 'true' : 'false') + ');return false;">' + (meta.isActive ? 'desativar' : 'ativar') + '</a>' +
                    '<a class="pill" href="#" onclick="duplicateCampaignUi(&quot;' + id + '&quot;);return false;">duplicar</a>' +
                    '<a class="pill" href="#" onclick="archiveCampaignUi(&quot;' + id + '&quot;);return false;">arquivar</a>' +
                    '<a class="pill" href="#" onclick="deleteCampaignUi(&quot;' + id + '&quot;);return false;">excluir</a>' +
                  '</td>' +
                '</tr>';
              }).join('') +
              '</tbody></table>';
            if(listEl) listEl.innerHTML = html;
          } catch (err) {
            if(listEl) listEl.innerHTML = '<div class="badge danger">' + esc('Falha ao carregar campanhas: ' + String(err?.message || err || 'desconhecido')) + '</div>';
          }
        }

        async function detailsCampaign(id){
          const r = await fetch('/admin/campaigns/' + encodeURIComponent(id));
          const j = await r.json().catch(()=>({}));
          document.getElementById('campaigns_raw').textContent = JSON.stringify(j, null, 2);
          alert('Detalhes carregados no JSON bruto.');
        }

        async function editCampaignUi(id){
          const r = await fetch('/admin/campaigns/' + encodeURIComponent(id));
          const j = await r.json().catch(()=>({}));
          document.getElementById('campaigns_raw').textContent = JSON.stringify(j, null, 2);
          if(!r.ok || !j?.ok || !j?.campaign){
            setStatus('Erro: ' + String(j?.error || 'não foi possível carregar a campanha'), 'error');
            return;
          }
          editingCampaignId = String(j.campaign.id || id || '');
          populateCampaignForm(j.campaign);
          syncEditingUi();
          setStatus('Editando campanha: ' + String(j.campaign.code || editingCampaignId), 'info');
        }

        async function toggleCampaign(id, active){
          const r = await fetch('/admin/campaigns/' + encodeURIComponent(id) + '/active', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ isActive: !!active })
          });
          const j = await r.json().catch(()=>({}));
          document.getElementById('campaigns_raw').textContent = JSON.stringify(j, null, 2);
          setStatus(!r.ok || j?.ok === false ? ('Erro: ' + String(j?.error || 'desconhecido')) : 'Campanha atualizada com sucesso.', !r.ok || j?.ok === false ? 'error' : 'success');
          await loadCampaigns();
        }

        async function duplicateCampaignUi(id){
          const r = await fetch('/admin/campaigns/' + encodeURIComponent(id) + '/duplicate', { method:'POST' });
          const j = await r.json().catch(()=>({}));
          document.getElementById('campaigns_raw').textContent = JSON.stringify(j, null, 2);
          setStatus(!r.ok || j?.ok === false ? ('Erro: ' + String(j?.error || 'desconhecido')) : 'Campanha duplicada com sucesso.', !r.ok || j?.ok === false ? 'error' : 'success');
          await loadCampaigns();
        }

        async function archiveCampaignUi(id){
          if(!confirm('Arquivar esta campanha?')) return;
          const r = await fetch('/admin/campaigns/' + encodeURIComponent(id) + '/archive', { method:'POST' });
          const j = await r.json().catch(()=>({}));
          document.getElementById('campaigns_raw').textContent = JSON.stringify(j, null, 2);
          setStatus(!r.ok || j?.ok === false ? ('Erro: ' + String(j?.error || 'desconhecido')) : 'Campanha arquivada com sucesso.', !r.ok || j?.ok === false ? 'error' : 'success');
          await loadCampaigns();
        }

        async function deleteCampaignUi(id){
          if(!confirm('Tem certeza que deseja excluir permanentemente esta campanha?')) return;
          const r = await fetch('/admin/campaigns/' + encodeURIComponent(id), { method:'DELETE' });
          const j = await r.json().catch(()=>({}));
          document.getElementById('campaigns_raw').textContent = JSON.stringify(j, null, 2);
          if(!r.ok || j?.ok === false){
            setStatus('Erro: ' + String(j?.error || 'desconhecido'), 'error');
            return;
          }
          if(editingCampaignId && editingCampaignId === String(id || '')) clearCampaignEditing(true);
          setStatus(String(j?.message || 'Campanha excluída com sucesso.'), 'success');
          await loadCampaigns();
        }

        async function simulateCampaign(){
          const userRef = strVal('sim_userRef');
          const campaignId = strVal('sim_campaignId');
          if(!userRef){ alert('Informe userId ou waId para simular.'); return; }
          const r = await fetch('/admin/campaigns/simulate', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ userRef, campaignId })
          });
          const j = await r.json().catch(()=>({}));
          document.getElementById('sim_out').textContent = JSON.stringify(j, null, 2);
        }

        syncEditingUi();
        loadCampaigns();
      </script>
    `;
    const html = layoutBase({ title: "Campanhas", activePath: "/admin/campaigns-ui", content: inner });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  });

  router.get("/campaigns", async (req, res) => {
    try {
      const mode = String(req.query?.mode || "managed").trim().toLowerCase();
      const limit = Number(req.query?.limit || 100);

      if (mode === "legacy") {
        const data = await listBroadcastCampaigns(limit);
        return res.json({
          ok: true,
          ...(data && typeof data === "object" ? data : {}),
        });
      }

      const data = await listManagedCampaigns({ includeInactive: true, limit });
      return res.json({
        ok: true,
        campaigns: Array.isArray(data?.campaigns) ? data.campaigns : [],
        total: Number(data?.total || 0),
      });
    } catch (err) {
      return res.status(400).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.get("/campaigns/:id", async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      const managed = await getManagedCampaign(id).catch(() => null);
      if (managed?.campaign) {
        const audit = await listCampaignAuditByCampaign(id, { limit: 50 }).catch(() => []);
        return res.json({ ok: true, campaign: managed.campaign, audit });
      }

      const legacy = await getBroadcastCampaign(id);
      return res.json(legacy);
    } catch (err) {
      return res.status(404).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/campaigns", async (req, res) => {
    try {
      const body = req.body || {};
      const actor = getAdminActor(req);

      const isLegacyBroadcast = String(body.subject || "").trim() || String(body.text || "").trim();
      if (isLegacyBroadcast) {
        const subject = String(body.subject || "").trim();
        const text = String(body.text || "").trim();
        const planTargets = body?.planTargets || null;

        const result = await createCampaignAndDispatch({
          subject,
          text,
          planTargets,
          mode: "TEXT",
        });

        await safeRecordAdminAudit(req, {
          module: "marketing",
          action: "CREATE_BROADCAST_CAMPAIGN",
          summary: `Criou broadcast legado ${String(result?.campaign?.id || "")}.`,
          targetId: String(result?.campaign?.id || ""),
          meta: { subject, planTargets },
        });

        return res.json(result);
      }

      const payload = buildCampaignPayloadFromBody(body);
      const created = await createCampaign(payload, { actor });

      await safeRecordCampaignAudit(req, {
        campaignId: created?.campaign?.id || "",
        campaignCode: created?.campaign?.code || "",
        action: "CREATE",
        notes: "Campanha criada pelo Admin.",
        after: created?.campaign || {},
      });

      return res.json({
        ok: true,
        message: "Campanha cadastrada com sucesso.",
        campaign: created?.campaign || null,
      });
    } catch (err) {
      return res.status(400).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.put("/campaigns/:id", async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      const actor = getAdminActor(req);
      const current = await getManagedCampaign(id);
      if (!current?.campaign) return res.status(404).json({ ok: false, error: "campaign not found" });

      const patch = buildCampaignPayloadFromBody(req.body || {});
      const updated = await updateCampaign(id, patch, { actor });

      await safeRecordCampaignAudit(req, {
        campaignId: id,
        campaignCode: updated?.campaign?.code || current?.campaign?.code || "",
        action: "UPDATE",
        notes: "Campanha atualizada pelo Admin.",
        before: current?.campaign || {},
        after: updated?.campaign || {},
      });

      return res.json({
        ok: true,
        message: "Campanha atualizada com sucesso.",
        campaign: updated?.campaign || null,
      });
    } catch (err) {
      return res.status(400).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/campaigns/:id/active", async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      const isActive = !!req.body?.isActive;
      const actor = getAdminActor(req);
      const current = await getManagedCampaign(id);
      if (!current?.campaign) return res.status(404).json({ ok: false, error: "campaign not found" });

      const updated = await setCampaignActive(id, isActive, { actor });

      await safeRecordCampaignAudit(req, {
        campaignId: id,
        campaignCode: updated?.campaign?.code || current?.campaign?.code || "",
        action: isActive ? "ACTIVATE" : "DEACTIVATE",
        notes: isActive ? "Campanha ativada pelo Admin." : "Campanha desativada pelo Admin.",
        before: current?.campaign || {},
        after: updated?.campaign || {},
      });

      return res.json(updated);
    } catch (err) {
      return res.status(400).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/campaigns/:id/archive", async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      const actor = getAdminActor(req);
      const current = await getManagedCampaign(id);
      if (!current?.campaign) return res.status(404).json({ ok: false, error: "campaign not found" });

      const updated = await archiveCampaign(id, { actor });

      await safeRecordCampaignAudit(req, {
        campaignId: id,
        campaignCode: updated?.campaign?.code || current?.campaign?.code || "",
        action: "ARCHIVE",
        notes: "Campanha arquivada pelo Admin.",
        before: current?.campaign || {},
        after: updated?.campaign || {},
      });

      return res.json(updated);
    } catch (err) {
      return res.status(400).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/campaigns/:id/duplicate", async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      const actor = getAdminActor(req);
      const duplicated = await duplicateCampaign(id, { actor });

      await safeRecordCampaignAudit(req, {
        campaignId: duplicated?.campaign?.id || "",
        campaignCode: duplicated?.campaign?.code || "",
        action: "DUPLICATE",
        notes: `Campanha duplicada a partir de ${id}.`,
        after: duplicated?.campaign || {},
        meta: { sourceCampaignId: id },
      });

      return res.json(duplicated);
    } catch (err) {
      return res.status(400).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.delete("/campaigns/:id", async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      const actor = getAdminActor(req);
      const current = await getManagedCampaign(id);
      if (!current?.campaign) return res.status(404).json({ ok: false, error: "campaign not found" });

      const deleted = await deleteCampaign(id, { actor });

      await safeRecordCampaignAudit(req, {
        campaignId: id,
        campaignCode: current?.campaign?.code || "",
        action: "DELETE",
        notes: "Campanha excluída permanentemente pelo Admin.",
        before: current?.campaign || {},
        after: {},
      });

      return res.json({
        ok: true,
        message: "Campanha excluída com sucesso.",
        deleted: deleted?.deleted === true,
      });
    } catch (err) {
      return res.status(400).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/campaigns/simulate", async (req, res) => {
    try {
      const userRef = String(req.body?.userRef || "").trim();
      const campaignId = String(req.body?.campaignId || "").trim();
      if (!userRef) return res.status(400).json({ ok: false, error: "userRef required" });

      const userId = await resolveAdminUserRef(userRef);
      const user = await getUserSnapshot(userId);
      const simulation = await simulateCampaignsForUser(
        { userId },
        { userId, user, campaignIds: campaignId ? [campaignId] : [] },
        { includeInactive: true }
      );

      await safeRecordCampaignAudit(req, {
        campaignId: campaignId,
        campaignCode: "",
        action: "SIMULATE",
        notes: `Simulação executada para ${userId}.`,
        meta: { userId, campaignId },
      });

      return res.json({ ok: true, userId, simulation });
    } catch (err) {
      return res.status(400).json({ ok: false, error: String(err?.message || err) });
    }
  });

  router.post("/campaigns/:id/reprocess-window24h", async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      const result = await reprocessCampaignForActiveWindow(id, { limit: 5000 });
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // -----------------------------
  // Testes / State (mantidos)
  // -----------------------------
  router.get("/state-test/reset-trial", async (req, res) => {
    try {
      const userId = await requireUserRef(req);
      const [beforeUser, identifiers] = await Promise.all([
        getUserSnapshot(userId),
        getUserIdentifiers(userId).catch(() => null),
      ]);
      await setUserStatus(userId, "TRIAL");
      await setUserPlan(userId, "");
      await setUserQuotaUsed(userId, 0);
      await setUserTrialUsed(userId, 0);
      await clearLastPrompt(userId);

      const user = await getUserSnapshot(userId);
      await safeRecordAdminAudit(req, {
        module: "state",
        action: "RESET_USER_TRIAL",
        waId: identifiers?.waId || beforeUser?.waId || "",
        targetId: userId,
        summary: `Resetou o usuário ${userId} para TRIAL.`,
        before: buildAuditUserSnapshot(beforeUser),
        after: buildAuditUserSnapshot(user),
      });
      return res.json({ ok: true, action: "reset-trial", userId, waId: identifiers?.waId || user.waId || "", user });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  // 🧹 Reset TOTAL (número de teste): remove estado, identidade, métricas, janela 24h e overrides de copy
  router.get('/state-test/reset-user', async (req, res) => {
    try {
      const userId = await requireUserRef(req);
      const [beforeUser, identifiers] = await Promise.all([
        getUserSnapshot(userId),
        getUserIdentifiers(userId).catch(() => null),
      ]);

      const st = await resetUserAsNew(userId);
      const identity = await deleteIdentityForUser(userId).catch((err) => ({ ok: false, error: String(err?.message || err) }));

      const w = identifiers?.waId
        ? await clear24hWindowForUser(identifiers.waId).catch((err) => ({ ok: false, error: String(err?.message || err) }))
        : { ok: false, skipped: true, reason: "missing_waId_alias" };

      const m = await resetUserDescriptionMetrics(userId, { days: 120, months: 18 }).catch((err) => ({ ok: false, error: String(err?.message || err) }));

      let copyDeleted = 0;
      let copyKeys = [];
      try {
        copyKeys = await listCopyKeys();
        for (const k of (copyKeys || [])) {
          await delCopyUser(userId, k).catch(() => null);
          copyDeleted++;
          if (identifiers?.waId && identifiers.waId !== userId) {
            await delCopyUser(identifiers.waId, k).catch(() => null);
            copyDeleted++;
          }
        }
      } catch (err) {
        // ignore (best-effort)
      }

      await safeRecordAdminAudit(req, {
        module: "state",
        action: "RESET_USER_TOTAL",
        waId: identifiers?.waId || beforeUser?.waId || "",
        targetId: userId,
        summary: `Executou reset total do usuário ${userId}.`,
        before: buildAuditUserSnapshot(beforeUser),
        after: { reset: true },
        meta: {
          userId,
          state: st,
          identity,
          window24h: w,
          metrics: m,
          copyDeleted,
        },
      });
      return res.json({
        ok: true,
        action: 'reset-user-total',
        userId,
        waId: identifiers?.waId || beforeUser?.waId || "",
        state: st,
        identity,
        window24h: w,
        metrics: m,
        copy: { ok: true, keys: copyKeys?.length || 0, deleted: copyDeleted },
        note: 'Reset TOTAL concluído. O usuário só será recriado quando voltar a interagir com o sistema.',
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  router.get("/state-test/set-lastprompt-empty", async (req, res) => {
    try {
      const userId = await requireUserRef(req);
      await setLastPrompt(userId, "");
      const [user, identifiers] = await Promise.all([
        getUserSnapshot(userId),
        getUserIdentifiers(userId).catch(() => null),
      ]);
      return res.json({ ok: true, action: "set-lastprompt-empty", userId, waId: identifiers?.waId || user.waId || "", user });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  router.get("/state-test/get", async (req, res) => {
    try {
      const userId = await requireUserRef(req);
      const [user, identifiers] = await Promise.all([
        getUserSnapshot(userId),
        getUserIdentifiers(userId).catch(() => null),
      ]);
      return res.json({ ok: true, userId, waId: identifiers?.waId || user.waId || "", user });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  router.get("/window24h/touch", async (req, res) => {
    try {
      const userId = await requireUserRef(req);
      const identifiers = await getUserIdentifiers(userId).catch(() => null);
      if (!identifiers?.waId) {
        return res.status(400).json({ ok: false, error: "waId alias not found for user" });
      }
      await touch24hWindow(identifiers.waId, nowMs());
      const ts = await getLastInboundTs(identifiers.waId);
      return res.json({
        ok: true,
        action: "touch24hWindow",
        user: {
          userId,
          waId: identifiers.waId,
          lastInboundAtMs: ts,
          windowEndsAtMs: ts ? ts + 24 * 60 * 60 * 1000 : null,
        },
      });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });

  router.get("/window24h", async (req, res) => {
    const items = await listWindow24hActive({ limit: 500 });
    return res.json({ ok: true, nowMs: nowMs(), count: items.length, returned: items.length, items });
  });

  router.get("/send-test", async (req, res) => {
    try {
      const userId = await requireUserRef(req);
      const text = String(req.query.text || "oi");
      const recipient = await getPreferredOutboundRecipient(userId);
      const meta = await sendWhatsAppText({ recipient, text });
      return res.json({ ok: true, userId, sentTo: recipient?.recipient || "", text, meta });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  });


  router.get("/identity-conflicts/pending-count", async (req, res) => {
    try {
      const items = await listIdentityConflicts({ status: "PENDING_REVIEW", limit: 1000 });
      return res.json({ ok: true, count: Array.isArray(items) ? items.length : 0 });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || String(err), count: 0 });
    }
  });

  router.get("/identity-conflicts/data", async (req, res) => {
    try {
      const status = String(req.query?.status || "PENDING_REVIEW").trim().toUpperCase();
      const limit = Math.max(1, Math.min(Number(req.query?.limit || 200), 1000));
      const items = await listIdentityConflicts({ status, limit });
      return res.json({ ok: true, status, count: Array.isArray(items) ? items.length : 0, items });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  });

  router.get("/identity-conflicts-ui", async (req, res) => {
    try {
      const status = String(req.query?.status || "PENDING_REVIEW").trim().toUpperCase();
      const items = await listIdentityConflicts({ status, limit: 300 });
      const rows = (Array.isArray(items) ? items : []).map((item) => `
        <tr>
          <td><a href="/admin/identity-conflicts-ui/${encodeURIComponent(item.conflictId)}"><code>${escapeHtml(item.conflictId)}</code></a></td>
          <td><code>${escapeHtml(item.waId || '—')}</code></td>
          <td><code>${escapeHtml(item.bsuid || '—')}</code></td>
          <td><code>${escapeHtml(item.waUserId || '—')}</code></td>
          <td><code>${escapeHtml(item.bsuidUserId || '—')}</code></td>
          <td>${escapeHtml(formatAdminDateTime(item.detectedAt) || '—')}</td>
          <td>${escapeHtml(formatAdminDateTime(item.lastSeenAt) || '—')}</td>
          <td>${escapeHtml(String(item.timesDetected || 0))}</td>
          <td><span class="badge ${item.status === 'PENDING_REVIEW' ? 'danger' : 'info'}">${escapeHtml(item.status || '—')}</span></td>
        </tr>`).join('');

      return res.send(layoutBase({
        title: 'Conflitos de identidade',
        activePath: '/admin/identity-conflicts-ui',
        content: `
          <div class="grid cols3" style="margin-bottom:12px;">
            <div class="kpi"><div class="t">Pendentes</div><div class="v">${escapeHtml(String((items || []).length))}</div></div>
            <div class="kpi"><div class="t">Status filtrado</div><div class="v" style="font-size:20px;">${escapeHtml(status)}</div></div>
            <div class="kpi"><div class="t">Ação</div><div class="v" style="font-size:18px;"><a href="/admin/identity-conflicts-ui?status=PENDING_REVIEW">Atualizar</a></div></div>
          </div>
          <div class="card pad">
            <div class="row" style="justify-content:space-between; margin-bottom:10px;">
              <div>
                <h3 style="margin:0;">Central de Conflitos de Identidade</h3>
                <div class="muted" style="margin-top:6px;">Casos pendentes de revisão manual. A conversa do usuário continua, mas operações sensíveis ficam bloqueadas até a decisão administrativa.</div>
              </div>
              <form method="get" action="/admin/identity-conflicts-ui" class="row">
                <select name="status">
                  ${renderSelectOptions([
                    { value: 'PENDING_REVIEW', label: 'PENDENTE' },
                    { value: 'RESOLVED', label: 'RESOLVIDO' },
                    { value: 'DISMISSED', label: 'DISPENSADO' },
                    { value: 'ARCHIVED', label: 'ARQUIVADO' },
                  ], status)}
                </select>
                <button class="primary" type="submit">Filtrar</button>
              </form>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Conflict ID</th>
                  <th>WA ID</th>
                  <th>BSUID</th>
                  <th>Usuário WA</th>
                  <th>Usuário BSUID</th>
                  <th>Detectado em</th>
                  <th>Última ocorrência</th>
                  <th>Ocorrências</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                ${rows || '<tr><td colspan="9" class="muted">Nenhum conflito encontrado.</td></tr>'}
              </tbody>
            </table>
          </div>
        `,
      }));
    } catch (err) {
      return res.status(500).send(layoutBase({ title: 'Conflitos de identidade', activePath: '/admin/identity-conflicts-ui', content: `<div class="card pad"><h3>Erro ao carregar</h3><div class="muted">${escapeHtml(err?.message || String(err))}</div></div>` }));
    }
  });

  router.get("/identity-conflicts-ui/:conflictId", async (req, res) => {
    try {
      const conflictId = String(req.params?.conflictId || '').trim();
      const conflict = await getIdentityConflict(conflictId);
      if (!conflict) {
        return res.status(404).send(layoutBase({ title: 'Conflito não encontrado', activePath: '/admin/identity-conflicts-ui', content: `<div class="card pad"><h3>Conflito não encontrado</h3><div class="muted">ID informado: <code>${escapeHtml(conflictId)}</code></div></div>` }));
      }
      const comparison = await loadIdentityConflictUserComparison(conflict);
      const waSide = comparison.waSide || {};
      const bsuidSide = comparison.bsuidSide || {};

      return res.send(layoutBase({
        title: `Conflito ${conflict.conflictId}`,
        activePath: '/admin/identity-conflicts-ui',
        content: `
          <div class="card pad" style="margin-bottom:12px;">
            <div class="row" style="justify-content:space-between; align-items:flex-start; gap:12px;">
              <div>
                <h3 style="margin:0;">Conflito ${escapeHtml(conflict.conflictId)}</h3>
                <div class="muted" style="margin-top:6px;">Status atual: <span class="badge ${conflict.status === 'PENDING_REVIEW' ? 'danger' : 'info'}">${escapeHtml(conflict.status || '—')}</span></div>
              </div>
              <div class="row">
                <span class="pill">Detectado em: <b>${escapeHtml(formatAdminDateTime(conflict.detectedAt) || '—')}</b></span>
                <span class="pill">Última ocorrência: <b>${escapeHtml(formatAdminDateTime(conflict.lastSeenAt) || '—')}</b></span>
                <span class="pill">Ocorrências: <b>${escapeHtml(String(conflict.timesDetected || 0))}</b></span>
              </div>
            </div>
            <div class="hr"></div>
            <div class="grid cols2">
              <div><div class="muted">WA ID</div><div><code>${escapeHtml(conflict.waId || '—')}</code></div></div>
              <div><div class="muted">BSUID</div><div><code>${escapeHtml(conflict.bsuid || '—')}</code></div></div>
              <div><div class="muted">Review decision</div><div>${escapeHtml(conflict.reviewDecision || '—')}</div></div>
              <div><div class="muted">Revisado por</div><div>${escapeHtml(conflict.reviewedBy || '—')}</div></div>
              <div><div class="muted">Operações sensíveis bloqueadas</div><div><span class="badge ${conflict.blockSensitiveOps ? 'danger' : 'ok'}">${conflict.blockSensitiveOps ? 'SIM' : 'NÃO'}</span></div></div>
              <div><div class="muted">Conversa permitida</div><div><span class="badge ${conflict.allowConversation === false ? 'danger' : 'ok'}">${conflict.allowConversation === false ? 'NÃO' : 'SIM'}</span></div></div>
              <div><div class="muted">Observações</div><div>${escapeHtml(conflict.notes || '—')}</div></div>
              <div><div class="muted">Revisado em</div><div>${escapeHtml(formatAdminDateTime(conflict.reviewedAt) || '—')}</div></div>
            </div>
          </div>
          <div class="grid cols2" style="margin-bottom:12px;">
            ${renderIdentityConflictSideCard('Usuário do WA ID', waSide, true)}
            ${renderIdentityConflictSideCard('Usuário do BSUID', bsuidSide, false)}
          </div>
          <div class="card pad">
            <h3 style="margin-top:0;">Ações manuais</h3>
            <div class="muted" style="margin-bottom:10px;">Escolha a ação adequada para resolver o caso. As ações executam a regra administrativa real da Central e registram auditoria.</div>
            <form method="post" action="/admin/identity-conflicts/resolve" class="grid" style="gap:14px;">
              <input type="hidden" name="conflictId" value="${escapeHtml(conflict.conflictId)}" />
              <div class="grid cols2">
                <div>
                  <label>Ação</label>
                  <select name="action" required>
                    ${renderSelectOptions([
                      { value: 'merge_into_wa_user', label: 'Unir no usuário do WA ID' },
                      { value: 'merge_into_bsuid_user', label: 'Unir no usuário do BSUID' },
                      { value: 'reassign_aliases', label: 'Reatribuir aliases' },
                      { value: 'separate_users', label: 'Separar definitivamente' },
                      { value: 'block_wa_user', label: 'Bloquear usuário do WA ID' },
                      { value: 'block_bsuid_user', label: 'Bloquear usuário do BSUID' },
                      { value: 'dismiss', label: 'Ignorar / dismiss' },
                      { value: 'archive', label: 'Arquivar' },
                    ])}
                  </select>
                </div>
                <div>
                  <label>Resumo da decisão atual</label>
                  <div class="pill" style="min-height:42px; align-items:center;">${escapeHtml(conflict.reviewDecision || 'Sem decisão anterior')}</div>
                </div>
                <div>
                  <label>Destino do WA ID</label>
                  <select name="waAliasTargetUserId">
                    ${renderSelectOptions([
                      { value: waSide.userId, label: `WA user · ${waSide.userId}` },
                      { value: bsuidSide.userId, label: `BSUID user · ${bsuidSide.userId}` },
                    ], waSide.userId)}
                  </select>
                </div>
                <div>
                  <label>Destino do BSUID</label>
                  <select name="bsuidAliasTargetUserId">
                    ${renderSelectOptions([
                      { value: waSide.userId, label: `WA user · ${waSide.userId}` },
                      { value: bsuidSide.userId, label: `BSUID user · ${bsuidSide.userId}` },
                    ], bsuidSide.userId)}
                  </select>
                </div>
              </div>
              <div>
                <label>Observação administrativa</label>
                <textarea name="notes" placeholder="Descreva a decisão tomada, contexto e impactos.">${escapeHtml(conflict.notes || '')}</textarea>
              </div>
              <div class="row">
                <button class="primary" type="submit">Salvar decisão</button>
                <a class="pill" href="/admin/identity-conflicts-ui">Voltar à lista</a>
              </div>
            </form>
          </div>
        `,
      }));
    } catch (err) {
      return res.status(500).send(layoutBase({ title: 'Conflito de identidade', activePath: '/admin/identity-conflicts-ui', content: `<div class="card pad"><h3>Erro ao carregar conflito</h3><div class="muted">${escapeHtml(err?.message || String(err))}</div></div>` }));
    }
  });

  router.post("/identity-conflicts/resolve", async (req, res) => {
    try {
      const conflictId = String(req.body?.conflictId || '').trim();
      const action = normalizeIdentityConflictActionInput(req.body?.action);
      const notes = String(req.body?.notes || '').trim();
      const reviewedBy = parseBasicAuthUser(req);
      const waAliasTargetUserId = String(req.body?.waAliasTargetUserId || '').trim();
      const bsuidAliasTargetUserId = String(req.body?.bsuidAliasTargetUserId || '').trim();

      if (!conflictId) return res.status(400).send('conflictId required');
      if (!action) return res.status(400).send('invalid action');

      const current = await getIdentityConflict(conflictId);
      if (!current) return res.status(404).send('identity conflict not found');

      const validTargets = new Set([String(current.waUserId || '').trim(), String(current.bsuidUserId || '').trim()].filter(Boolean));
      if (action === 'reassign_aliases') {
        if (waAliasTargetUserId && !validTargets.has(waAliasTargetUserId)) return res.status(400).send('invalid waAliasTargetUserId');
        if (bsuidAliasTargetUserId && !validTargets.has(bsuidAliasTargetUserId)) return res.status(400).send('invalid bsuidAliasTargetUserId');
        if (!waAliasTargetUserId && !bsuidAliasTargetUserId) return res.status(400).send('alias target required');
      }

      const result = await resolveIdentityConflictDecision(conflictId, action, {
        reviewedBy,
        notes,
        moveWaIdToUserId: waAliasTargetUserId,
        moveBsuidToUserId: bsuidAliasTargetUserId,
        waTargetUserId: waAliasTargetUserId,
        bsuidTargetUserId: bsuidAliasTargetUserId,
      });

      if (result?.requiresAdminStateAction && result?.blockedUserId) {
        await setUserStatus(result.blockedUserId, result.nextStatus || 'BLOCKED');
      }

      const updatedConflict = result?.conflict?.conflictId ? result.conflict : await getIdentityConflict(conflictId);

      await safeRecordAdminAudit(req, {
        module: 'IDENTITY_CONFLICT',
        action: 'IDENTITY_CONFLICT_REVIEWED',
        targetId: conflictId,
        targetLabel: 'identity_conflict',
        summary: `Conflito ${conflictId} revisado com ação ${action}.`,
        before: current,
        after: updatedConflict || result || {},
        meta: {
          action,
          waUserId: current.waUserId,
          bsuidUserId: current.bsuidUserId,
          blockedUserId: String(result?.blockedUserId || ''),
          requiresAdminStateAction: Boolean(result?.requiresAdminStateAction),
          waAliasTargetUserId,
          bsuidAliasTargetUserId,
        },
      });

      return res.redirect(`/admin/identity-conflicts-ui/${encodeURIComponent(conflictId)}`);
    } catch (err) {
      return res.status(err.statusCode || 500).send(layoutBase({ title: 'Conflitos de identidade', activePath: '/admin/identity-conflicts-ui', content: `<div class="card pad"><h3>Erro ao aplicar ação</h3><div class="muted">${escapeHtml(err?.message || String(err))}</div><div class="hr"></div><a class="pill" href="/admin/identity-conflicts-ui">Voltar</a></div>` }));
    }
  });

  return router;
}

// --- safety init for users list UI ---
if (typeof reloadUsers === 'function') {
  window.reloadUsers = reloadUsers;
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => { try { reloadUsers(); } catch(e) {} });
  }
}
