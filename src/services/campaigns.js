// src/services/campaigns.js
// ✅ V16.4.7 — Broadcast Inteligente (Produção)
// - Campanhas com filtro por plano
// - Envio apenas para usuários na janela 24h
// - Quem estiver fora da janela vira PENDENTE
// - Quando entrar na janela (novo inbound), envia automaticamente
// - Registro persistido: data, assunto, texto, planos alvo, total, enviados, pendentes, erros
// - Texto simples agora + campo para template futuro

import { sendWhatsAppText } from "./meta/whatsapp.js";
import { listWindow24hActive, nowMs } from "./window24h.js";
import { listUsers, getUserPlan, listUsersByPlan } from "./state.js";
import {
  redisGet,
  redisSet,
  redisLPush,
  redisLRange,
  redisLLen,
  redisExpire,
  redisSAdd,
  redisSMembers,
  redisSRem,
  redisSCard,
  redisIncrBy,
} from "./redis.js";

const CAMPAIGN_INDEX_KEY = "campaigns:index"; // LIST (ids, newest first)
const CAMPAIGN_META_PREFIX = "campaign:"; // campaign:{id}:meta (STRING)
const CAMPAIGN_SENT_PREFIX = "campaign:"; // campaign:{id}:sent (SET)
const CAMPAIGN_PENDING_PREFIX = "campaign:"; // campaign:{id}:pending (SET)
const CAMPAIGN_ERRORS_PREFIX = "campaign:"; // campaign:{id}:errors (LIST)
const CAMPAIGN_COUNTER_PREFIX = "campaign:"; // campaign:{id}:sentCount etc

const USER_PENDING_PREFIX = "user_pending_campaigns:"; // user_pending_campaigns:{waId} (SET campaignIds)

const TTL_SECONDS = 90 * 24 * 60 * 60; // 90 dias
const MAX_WINDOW_FETCH = 5000; // segurança

function safeStr(v) {
  return String(v ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  // timestamp + aleatório curto
  return `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function keyMeta(id) {
  return `${CAMPAIGN_META_PREFIX}${id}:meta`;
}
function keySent(id) {
  return `${CAMPAIGN_SENT_PREFIX}${id}:sent`;
}
function keyPending(id) {
  return `${CAMPAIGN_PENDING_PREFIX}${id}:pending`;
}
function keyErrors(id) {
  return `${CAMPAIGN_ERRORS_PREFIX}${id}:errors`;
}
function keyCounter(id, name) {
  return `${CAMPAIGN_COUNTER_PREFIX}${id}:${name}`;
}
function keyUserPending(waId) {
  return `${USER_PENDING_PREFIX}${safeStr(waId)}`;
}

function normalizePlanCodes(planCodes) {
  const arr = Array.isArray(planCodes) ? planCodes : [];
  return Array.from(
    new Set(
      arr
        .map((c) => safeStr(c).toUpperCase())
        .filter(Boolean)
        .filter((c) => /^[A-Z0-9_]{3,40}$/.test(c))
    )
  );
}

function buildMessage({ subject, text }) {
  const s = safeStr(subject);
  const t = safeStr(text);
  if (s && t) return `*${s}*\n\n${t}`;
  if (s) return `*${s}*`;
  return t;
}

async function persistCampaignMeta(id, meta) {
  await redisSet(keyMeta(id), JSON.stringify(meta));
  await redisExpire(keyMeta(id), TTL_SECONDS);
  await redisExpire(keySent(id), TTL_SECONDS);
  await redisExpire(keyPending(id), TTL_SECONDS);
  await redisExpire(keyErrors(id), TTL_SECONDS);
  await redisExpire(keyCounter(id, "sentCount"), TTL_SECONDS);
  await redisExpire(keyCounter(id, "pendingCount"), TTL_SECONDS);
  await redisExpire(keyCounter(id, "errorCount"), TTL_SECONDS);
  await redisExpire(CAMPAIGN_INDEX_KEY, TTL_SECONDS);
}

async function pushCampaignError(id, payload) {
  const item = { ts: nowIso(), ...payload };
  await redisLPush(keyErrors(id), JSON.stringify(item));
  await redisExpire(keyErrors(id), TTL_SECONDS);
  await redisIncrBy(keyCounter(id, "errorCount"), 1);
}

async function setCounter(id, name, value) {
  await redisSet(keyCounter(id, name), String(Math.max(0, Number(value) || 0)));
  await redisExpire(keyCounter(id, name), TTL_SECONDS);
}

async function getCounter(id, name) {
  const v = await redisGet(keyCounter(id, name));
  return Number(v || 0) || 0;
}

async function getCampaignMeta(id) {
  const raw = await redisGet(keyMeta(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve público alvo.
 * Estável e barato:
 * - Se houver índice plan_users:{plan} com dados, usa ele
 * - Senão faz fallback varrendo users:index + getUserPlan (mais caro, mas funciona)
 */
async function resolveTargetUsers({ planCodes }) {
  const codes = normalizePlanCodes(planCodes);
  if (codes.length === 0) {
    return listUsers();
  }

  const collected = new Set();

  for (const c of codes) {
    const ids = await listUsersByPlan(c);
    if (ids && ids.length > 0) {
      ids.forEach((x) => collected.add(String(x)));
    } else {
      // fallback (compatível com base legada)
      const all = await listUsers();
      for (const waId of all) {
        const p = await getUserPlan(waId);
        if (p === c) collected.add(String(waId));
      }
    }
  }

  return Array.from(collected);
}

/**
 * Cria campanha e já faz dispatch:
 * - quem está na janela 24h -> envia agora
 * - quem não está -> marca como pendente e será enviado quando entrar na janela
 */
export async function createAndDispatchCampaign({
  subject,
  text,
  planCodes = [],
  messageType = "TEXT", // futuro: "TEMPLATE"
  template = null,      // reservado
} = {}) {
  const id = makeId();

  const meta = {
    id,
    createdAt: nowIso(),
    subject: safeStr(subject),
    text: safeStr(text),
    messageType: safeStr(messageType || "TEXT"),
    template, // reservado (futuro)
    planCodes: normalizePlanCodes(planCodes), // [] = todos
  };

  const targets = await resolveTargetUsers({ planCodes: meta.planCodes });

  // Index de campanhas
  await redisLPush(CAMPAIGN_INDEX_KEY, id);
  await redisExpire(CAMPAIGN_INDEX_KEY, TTL_SECONDS);

  // counters iniciais
  await setCounter(id, "sentCount", 0);
  await setCounter(id, "pendingCount", 0);
  await setCounter(id, "errorCount", 0);

  // guarda meta
  await persistCampaignMeta(id, meta);

  // janela 24h (1 fetch só)
  const windowUsers = await listWindow24hActive({ tsMs: nowMs(), limit: MAX_WINDOW_FETCH });
  const windowSet = new Set((windowUsers || []).map(String));

  const msg = buildMessage({ subject: meta.subject, text: meta.text });
  const total = targets.length;

  let sent = 0;
  let pending = 0;

  for (const waId of targets) {
    const idStr = String(waId);
    const inWindow = windowSet.has(idStr);

    if (inWindow) {
      try {
        await sendWhatsAppText({ to: idStr, text: msg });
        await redisSAdd(keySent(id), idStr);
        sent += 1;
      } catch (err) {
        await pushCampaignError(id, {
          waId: idStr,
          stage: "send_now",
          error: safeStr(err?.message || err),
        });
      }
    } else {
      // pendente
      await redisSAdd(keyPending(id), idStr);
      await redisSAdd(keyUserPending(idStr), id);
      await redisExpire(keyUserPending(idStr), TTL_SECONDS);
      pending += 1;
    }
  }

  await setCounter(id, "sentCount", sent);
  await setCounter(id, "pendingCount", pending);

  const result = {
    ok: true,
    campaignId: id,
    totalUsers: total,
    sentNow: sent,
    pending,
  };

  return result;
}

export async function listCampaignIds({ limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  const raw = await redisLRange(CAMPAIGN_INDEX_KEY, 0, lim - 1);
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((x) => String(x)).filter(Boolean);
}

export async function listCampaigns({ limit = 50 } = {}) {
  const ids = await listCampaignIds({ limit });
  const items = [];
  for (const id of ids) {
    const meta = await getCampaignMeta(id);
    if (!meta) continue;
    const sentCount = await getCounter(id, "sentCount");
    const pendingCount = await getCounter(id, "pendingCount");
    const errorCount = await getCounter(id, "errorCount");
    items.push({ ...meta, counts: { sentCount, pendingCount, errorCount } });
  }
  return items;
}

export async function getCampaignDetails(id) {
  const meta = await getCampaignMeta(id);
  if (!meta) return null;

  const sentCount = await getCounter(id, "sentCount");
  const pendingCount = await getCounter(id, "pendingCount");
  const errorCount = await getCounter(id, "errorCount");

  const errorsRaw = await redisLRange(keyErrors(id), 0, 49);
  const errors = (Array.isArray(errorsRaw) ? errorsRaw : [])
    .map((s) => {
      try {
        return JSON.parse(String(s));
      } catch {
        return { ts: nowIso(), raw: safeStr(s) };
      }
    });

  return {
    ...meta,
    counts: { sentCount, pendingCount, errorCount },
    errors,
  };
}

/**
 * Chamado quando o usuário entra na janela 24h (ou seja, mandou inbound).
 * Envia automaticamente campanhas pendentes desse usuário.
 */
export async function processPendingCampaignsForUser(waId) {
  const idStr = safeStr(waId);
  if (!idStr) return { ok: true, processed: 0 };

  const pendingCampaignIds = await redisSMembers(keyUserPending(idStr));
  const ids = Array.isArray(pendingCampaignIds) ? pendingCampaignIds.map(String).filter(Boolean) : [];

  if (ids.length === 0) return { ok: true, processed: 0 };

  let processed = 0;

  for (const campaignId of ids) {
    const meta = await getCampaignMeta(campaignId);
    if (!meta) {
      // campanha sumiu, limpa referência
      await redisSRem(keyUserPending(idStr), campaignId);
      continue;
    }

    const msg = buildMessage({ subject: meta.subject, text: meta.text });

    try {
      await sendWhatsAppText({ to: idStr, text: msg });

      // move de pending -> sent
      await redisSRem(keyPending(campaignId), idStr);
      await redisSAdd(keySent(campaignId), idStr);

      // atualiza contadores (barato)
      await redisIncrBy(keyCounter(campaignId, "sentCount"), 1);
      await redisIncrBy(keyCounter(campaignId, "pendingCount"), -1);

      // remove pendência do usuário
      await redisSRem(keyUserPending(idStr), campaignId);

      processed += 1;
    } catch (err) {
      await pushCampaignError(campaignId, {
        waId: idStr,
        stage: "send_pending_on_window",
        error: safeStr(err?.message || err),
      });
      // mantém pendente (não remove)
    }
  }

  return { ok: true, processed };
}
