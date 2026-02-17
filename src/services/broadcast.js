// src/services/broadcast.js
// ✅ V16.4.7 — Broadcast inteligente com campanhas:
// - Filtra por plano
// - Envia somente para usuários na janela 24h
// - Fora da janela: fica pendente
// - Ao entrar na janela (touch inbound): envia automaticamente
// - Registra campanhas e estatísticas (sent/pending/errors)

import {
  redisSet,
  redisGet,
  redisDel,
  redisSAdd,
  redisSRem,
  redisSIsMember,
  redisSMembers,
  redisSCard,
  redisLPush,
  redisLRange,
  redisLTrim,
  redisExpire,
} from "./redis.js";

import { listUsers, getUserPlan } from "./state.js";
import { listWindow24hActive, nowMs } from "./window24h.js";
import { sendWhatsAppText } from "./meta/whatsapp.js";
import { pushSystemAlert } from "./alerts.js";

const CAMPAIGNS_LIST_KEY = "campaigns:list"; // LIST de campaignId (newest first)
const PENDING_CAMPAIGNS_SET = "campaigns:pending:set"; // SET de campaignId com pendências
const CAMPAIGNS_TTL_SECONDS = 60 * 60 * 24 * 45; // 45 dias
const CAMPAIGNS_MAX_LIST = 300;

function safeStr(v) {
  return String(v ?? "").trim();
}

function normalizePlanTargets(planTargets) {
  if (!planTargets) return [];
  const arr = Array.isArray(planTargets) ? planTargets : [planTargets];
  return arr
    .map((p) => safeStr(p).toUpperCase())
    .filter(Boolean)
    .filter((p) => /^[A-Z0-9_]{3,40}$/.test(p));
}

function buildMessage({ subject, text }) {
  const s = safeStr(subject);
  const t = safeStr(text);
  if (s && t) return `*${s}*\n\n${t}`;
  if (s) return `*${s}*`;
  return t;
}


function campaignKeyMeta(id) {
  return `campaign:${id}:meta`;
}
function campaignKeySent(id) {
  return `campaign:${id}:sent`; // SET
}
function campaignKeyPending(id) {
  return `campaign:${id}:pending`; // SET
}
function campaignKeyErrors(id) {
  return `campaign:${id}:errors`; // LIST
}

function makeCampaignId() {
  return `cp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

async function setWithTTL(key, value, ttlSeconds = CAMPAIGNS_TTL_SECONDS) {
  await redisSet(key, value);
  await redisExpire(key, ttlSeconds);
}

async function ensureCampaignTTL(id) {
  // garante TTL nas principais estruturas
  const ttl = CAMPAIGNS_TTL_SECONDS;
  try {
    await redisExpire(campaignKeyMeta(id), ttl);
    await redisExpire(campaignKeyErrors(id), ttl);
    // Sets não têm EXPIRE por member, mas podemos expirar a key
    await redisExpire(campaignKeySent(id), ttl);
    await redisExpire(campaignKeyPending(id), ttl);
  } catch (_) {
    // best effort
  }
}

async function addCampaignToList(id) {
  await redisLPush(CAMPAIGNS_LIST_KEY, id);
  await redisLTrim(CAMPAIGNS_LIST_KEY, 0, CAMPAIGNS_MAX_LIST - 1);
  await redisExpire(CAMPAIGNS_LIST_KEY, CAMPAIGNS_TTL_SECONDS);
}

async function recordError(id, waId, errorMsg) {
  const entry = {
    ts: new Date().toISOString(),
    waId: safeStr(waId),
    error: safeStr(errorMsg).slice(0, 500),
  };
  await redisLPush(campaignKeyErrors(id), JSON.stringify(entry));
  await redisLTrim(campaignKeyErrors(id), 0, 199);
  await ensureCampaignTTL(id);
}

async function computeTargetsByPlan({ planTargets = [] }) {
  const targets = await listUsers(); // waIds
  const plansFilter = normalizePlanTargets(planTargets);

  if (plansFilter.length === 0) {
    return targets;
  }

  const filtered = [];
  // leitura simples e segura (sem paralelismo agressivo)
  for (const waId of targets) {
    try {
      const p = await getUserPlan(waId);
      if (plansFilter.includes(String(p || "").toUpperCase())) {
        filtered.push(waId);
      }
    } catch (_) {
      // se der erro em um usuário específico, ignora — campanha não pode quebrar
    }
  }
  return filtered;
}

export async function createCampaignAndDispatch({
  subject,
  text,
  planTargets, // array ou string
  mode = "TEXT", // futuro: TEMPLATE
}) {
  const subj = safeStr(subject);
  const body = safeStr(text);
  if (!subj && !body) throw new Error("Missing subject or text");

  const id = makeCampaignId();
  const createdAt = new Date().toISOString();

  const targetWaIds = await computeTargetsByPlan({ planTargets });
  const windowWaIds = await listWindow24hActive(nowMs(), 20000); // limite alto, mas safe
  const windowSet = new Set((windowWaIds || []).map((x) => String(x)));

  const sendNow = [];
  const pending = [];

  for (const waId of targetWaIds) {
    if (windowSet.has(String(waId))) sendNow.push(String(waId));
    else pending.push(String(waId));
  }

  const meta = {
    id,
    createdAt,
    subject: subj,
    mode,
    planTargets: normalizePlanTargets(planTargets),
    text: body, // por enquanto texto simples
    totals: {
      totalTargets: targetWaIds.length,
      sendNow: sendNow.length,
      pending: pending.length,
    },
  };

  await setWithTTL(campaignKeyMeta(id), JSON.stringify(meta));
  await addCampaignToList(id);

  if (sendNow.length > 0) {
    // envia agora + registra sent
    for (const waId of sendNow) {
      try {
        const msg = buildMessage({ subject: subj, text: body });
      await sendWhatsAppText({ to: waId, text: msg });
        await redisSAdd(campaignKeySent(id), waId);
      } catch (err) {
        await recordError(id, waId, err?.message || err);
      }
    }
  }

  if (pending.length > 0) {
    await redisSAdd(campaignKeyPending(id), pending);
    await redisSAdd(PENDING_CAMPAIGNS_SET, id);
  }

  await ensureCampaignTTL(id);

  // alerta “informativo” (opcional) — ajuda no log do Render
  await pushSystemAlert("CAMPAIGN_CREATED", {
    id,
    totalTargets: targetWaIds.length,
    sendNow: sendNow.length,
    pending: pending.length,
    planTargets: meta.planTargets,
    mode,
  });

  return await getCampaign(id);
}

export async function getCampaign(id) {
  const raw = await redisGet(campaignKeyMeta(id));
  const meta = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;

  const [sentCount, pendingCount] = await Promise.all([
    redisSCard(campaignKeySent(id)).catch(() => 0),
    redisSCard(campaignKeyPending(id)).catch(() => 0),
  ]);

  // errorsCount = tamanho da lista (aproximação via LRANGE pequeno)
  const errs = await redisLRange(campaignKeyErrors(id), 0, 199).catch(() => []);
  const errorsCount = Array.isArray(errs) ? errs.length : 0;

  return {
    ok: true,
    campaign: {
      id,
      meta,
      stats: {
        sent: Number(sentCount || 0),
        pending: Number(pendingCount || 0),
        errors: Number(errorsCount || 0),
      },
    },
  };
}

export async function listCampaigns(limit = 30) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 30));
  const ids = await redisLRange(CAMPAIGNS_LIST_KEY, 0, lim - 1);
  const arr = Array.isArray(ids) ? ids : [];

  const out = [];
  for (const id of arr) {
    const c = await getCampaign(String(id));
    if (c?.campaign) out.push(c.campaign);
  }

  return { ok: true, count: out.length, campaigns: out };
}

/**
 * ✅ Auto-send pendências quando o usuário entra na janela 24h
 * Chame isso no webhook inbound (após touch24hWindow).
 */

/**
 * ✅ Reprocessa uma campanha APENAS para usuários que já estão na janela 24h AGORA.
 * - Não toca em usuários fora da janela.
 * - Só tenta reenviar para waIds que ainda estão pendentes nessa campanha.
 */
export async function reprocessCampaignForActiveWindow(campaignId, { limit = 5000 } = {}) {
  const id = safeStr(campaignId);
  if (!id) throw new Error("campaignId required");

  const rawMeta = await redisGet(campaignKeyMeta(id)).catch(() => "");
  let meta = null;
  try {
    meta = rawMeta ? JSON.parse(rawMeta) : null;
  } catch {
    meta = null;
  }
  if (!meta) throw new Error("campaign meta not found");

  // lista waIds ativos na janela
  const windowWaIds = await listWindow24hActive(nowMs(), Number(limit || 5000));
  const windowList = Array.isArray(windowWaIds) ? windowWaIds.map((x) => String(x)) : [];
  const windowSet = new Set(windowList);

  // pendentes atuais da campanha
  const pendingWaIds = await redisSMembers(campaignKeyPending(id)).catch(() => []);
  const pendList = Array.isArray(pendingWaIds) ? pendingWaIds.map((x) => String(x)) : [];

  let attempted = 0;
  let sent = 0;
  let errors = 0;

  const subj = safeStr(meta?.subject);
  const text = safeStr(meta?.text);
  const msg = buildMessage({ subject: subj, text });

  if (!msg) {
    throw new Error("campaign message empty");
  }

  for (const waId of pendList) {
    if (!waId) continue;
    if (!windowSet.has(waId)) continue; // 🔒 apenas janela 24h

    attempted += 1;
    try {
      await sendWhatsAppText({ to: waId, text: msg });
      await redisSAdd(campaignKeySent(id), waId);
      await redisSRem(campaignKeyPending(id), waId);
      sent += 1;
    } catch (err) {
      errors += 1;
      await recordError(id, waId, err?.message || err);
    }
  }

  // se zerou pendências na campanha, remove do índice global
  const pendingLeft = await redisSCard(campaignKeyPending(id)).catch(() => 0);
  if (Number(pendingLeft || 0) === 0) {
    await redisSRem(PENDING_CAMPAIGNS_SET, id).catch(() => 0);
  }

  await ensureCampaignTTL(id);

  return {
    ok: true,
    campaignId: id,
    windowActive: windowList.length,
    pendingBefore: pendList.length,
    attempted,
    sent,
    errors,
    pendingAfter: Number(pendingLeft || 0),
  };
}

export async function processPendingForWaId(waId) {
  const id = safeStr(waId);
  if (!id) return { ok: true, processed: 0 };

  const pendingCampaigns = await redisSMembers(PENDING_CAMPAIGNS_SET).catch(() => []);
  const list = Array.isArray(pendingCampaigns) ? pendingCampaigns : [];

  let processed = 0;

  for (const cpIdRaw of list) {
    const cpId = safeStr(cpIdRaw);
    if (!cpId) continue;

    // está pendente nessa campanha?
    const isPending = await redisSIsMember(campaignKeyPending(cpId), id).catch(() => 0);
    if (!Number(isPending)) continue;

    // lê meta (pega texto)
    const rawMeta = await redisGet(campaignKeyMeta(cpId)).catch(() => "");
    let meta = null;
    try {
      meta = rawMeta ? JSON.parse(rawMeta) : null;
    } catch {
      meta = null;
    }

    const subj = safeStr(meta?.subject);
    const text = safeStr(meta?.text);
    const msg = buildMessage({ subject: subj, text });

    if (!msg) {
      // meta corrompida — remove do pending e registra erro
      await redisSRem(campaignKeyPending(cpId), id).catch(() => 0);
      await recordError(cpId, id, "Campaign meta missing subject/text (auto-send skipped)");
      processed += 1;
      continue;
    }

    try {
      await sendWhatsAppText({ to: id, text: msg });
      await redisSAdd(campaignKeySent(cpId), id);
      await redisSRem(campaignKeyPending(cpId), id);
      processed += 1;
    } catch (err) {
      await recordError(cpId, id, err?.message || err);
      // mantém pendente para tentar de novo quando o usuário voltar a falar
    }

    // se zerou pendências na campanha, remove do índice global
    const pendingLeft = await redisSCard(campaignKeyPending(cpId)).catch(() => 0);
    if (Number(pendingLeft || 0) === 0) {
      await redisSRem(PENDING_CAMPAIGNS_SET, cpId).catch(() => 0);
    }

    await ensureCampaignTTL(cpId);
  }

  return { ok: true, waId: id, processed };
}
