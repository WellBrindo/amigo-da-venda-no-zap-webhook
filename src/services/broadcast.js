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

import {
  listUsers,
  getUserPlan,
  getUserStatus,
  getActivityMeta,
  setActivityMeta,
  getPostAdIdleMeta,
  markPostAdIdleReminderSent,
  getGrowthMeta,
  markAdOfDaySent,
  resetCheckoutCouponState,
} from "./state.js";
import { listWindow24hActive, nowMs, getLastInboundTs } from "./window24h.js";
import { sendWhatsAppText } from "./meta/whatsapp.js";
import { getCopyText } from "./copy.js";
import { pushSystemAlert } from "./alerts.js";
import { getInternalUserIdByWaId, getPreferredOutboundRecipient } from "./identity.js";
import {
  listExpiredPendingCouponReservations,
  expireCouponReservation,
  markCouponRemovedMessageSent,
} from "./coupons.js";

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

async function getRecipientForUser(userId) {
  const id = safeStr(userId);
  if (!id) return null;
  const outbound = await getPreferredOutboundRecipient(id).catch(() => null);
  const recipient = safeStr(outbound?.recipient);
  if (!recipient) return null;
  return { userId: id, recipient, channel: safeStr(outbound?.channel || "WHATSAPP") };
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
  const targets = await listUsers(); // internalUserIds
  const plansFilter = normalizePlanTargets(planTargets);

  if (plansFilter.length === 0) {
    return targets;
  }

  const filtered = [];
  // leitura simples e segura (sem paralelismo agressivo)
  for (const userId of targets) {
    try {
      const p = await getUserPlan(userId);
      if (plansFilter.includes(String(p || "").toUpperCase())) {
        filtered.push(userId);
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

  const targetUserIds = await computeTargetsByPlan({ planTargets });
  const windowWaIds = await listWindow24hActive(nowMs(), 20000); // limite alto, mas safe
  const windowSet = new Set((windowWaIds || []).map((x) => String(x)));

  const sendNow = [];
  const pending = [];

  for (const userId of targetUserIds) {
    const recipientInfo = await getRecipientForUser(userId);
    if (!recipientInfo?.recipient) {
      await recordError(id, userId, "Missing outbound recipient for campaign target");
      continue;
    }
    if (windowSet.has(String(recipientInfo.recipient))) sendNow.push(recipientInfo);
    else pending.push(String(userId));
  }

  const meta = {
    id,
    createdAt,
    subject: subj,
    mode,
    planTargets: normalizePlanTargets(planTargets),
    text: body, // por enquanto texto simples
    totals: {
      totalTargets: targetUserIds.length,
      sendNow: sendNow.length,
      pending: pending.length,
    },
  };

  await setWithTTL(campaignKeyMeta(id), JSON.stringify(meta));
  await addCampaignToList(id);

  if (sendNow.length > 0) {
    // envia agora + registra sent
    for (const entry of sendNow) {
      const userId = safeStr(entry?.userId);
      const recipient = safeStr(entry?.recipient);
      try {
        const msg = buildMessage({ subject: subj, text: body });
        await sendWhatsAppText({ to: recipient, text: msg });
        await redisSAdd(campaignKeySent(id), userId);
      } catch (err) {
        await recordError(id, userId || recipient, err?.message || err);
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
    totalTargets: targetUserIds.length,
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

  // pendentes atuais da campanha (internalUserIds)
  const pendingUserIds = await redisSMembers(campaignKeyPending(id)).catch(() => []);
  const pendList = Array.isArray(pendingUserIds) ? pendingUserIds.map((x) => String(x)) : [];

  let attempted = 0;
  let sent = 0;
  let errors = 0;

  const subj = safeStr(meta?.subject);
  const text = safeStr(meta?.text);
  const msg = buildMessage({ subject: subj, text });

  if (!msg) {
    throw new Error("campaign message empty");
  }

  for (const userId of pendList) {
    if (!userId) continue;
    const recipientInfo = await getRecipientForUser(userId);
    const recipient = safeStr(recipientInfo?.recipient);
    if (!recipient) {
      errors += 1;
      await recordError(id, userId, "Missing outbound recipient for pending campaign user");
      continue;
    }
    if (!windowSet.has(recipient)) continue; // 🔒 apenas janela 24h

    attempted += 1;
    try {
      await sendWhatsAppText({ to: recipient, text: msg });
      await redisSAdd(campaignKeySent(id), userId);
      await redisSRem(campaignKeyPending(id), userId);
      sent += 1;
    } catch (err) {
      errors += 1;
      await recordError(id, userId, err?.message || err);
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
  const inboundWaId = safeStr(waId);
  if (!inboundWaId) return { ok: true, processed: 0 };

  const userId = await getInternalUserIdByWaId(inboundWaId).catch(() => null);
  const id = safeStr(userId);
  if (!id) return { ok: true, waId: inboundWaId, processed: 0 };

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

    const recipientInfo = await getRecipientForUser(id);
    const recipient = safeStr(recipientInfo?.recipient);
    if (!recipient) {
      await recordError(cpId, id, "Missing outbound recipient for pending campaign user");
      continue;
    }

    try {
      await sendWhatsAppText({ to: recipient, text: msg });
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

  return { ok: true, waId: inboundWaId, userId: id, processed };
}

const AUTOMATION_TZ = "America/Sao_Paulo";
const DAILY_AD_TARGET_HOUR = 10;
const DAILY_AD_MIN_REMAINING_MS = 30 * 60 * 1000;
const DAILY_AD_MAX_REMAINING_MS = 6 * 60 * 60 * 1000;
const IDLE_REMINDER_DELAY_MS = 5 * 60 * 1000;
const COUPON_EXPIRATION_CHECK_LIMIT = 200;
const COUPON_REMOVAL_MESSAGE_KEY = "FLOW_COUPON_REMOVED_TIMEOUT";
const COUPON_REMOVAL_FALLBACK = [
  "Seu cupom de desconto foi removido porque o pagamento não foi confirmado dentro do prazo.",
  "Se quiser, você pode escolher novamente seu plano e aplicar um novo cupom válido na contratação.",
].join("\n\n");

function getTzParts(inputMs = nowMs(), timeZone = AUTOMATION_TZ) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(inputMs)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year || 0),
    month: Number(parts.month || 0),
    day: Number(parts.day || 0),
    hour: Number(parts.hour || 0),
    minute: Number(parts.minute || 0),
    second: Number(parts.second || 0),
    date: `${parts.year || "0000"}-${parts.month || "00"}-${parts.day || "00"}`,
  };
}

function previousTzDate(inputMs = nowMs(), timeZone = AUTOMATION_TZ) {
  const parts = getTzParts(inputMs, timeZone);
  const utcMidnight = Date.UTC(parts.year, Math.max(0, parts.month - 1), parts.day);
  return getTzParts(utcMidnight - 24 * 60 * 60 * 1000, timeZone).date;
}

function isDailyAdEligibleStatus(status) {
  return status === "TRIAL" || status === "ACTIVE";
}

function isIdleEligibleStatus(status) {
  return String(status || "").startsWith("WAIT_") || status === "PAYMENT_PENDING";
}

async function sendCopyMessage(userId, key, vars = {}) {
  const id = safeStr(userId);
  const text = await getCopyText(key, { waId: id, vars });
  if (!String(text || "").trim()) return false;
  const recipientInfo = await getRecipientForUser(id);
  const recipient = safeStr(recipientInfo?.recipient);
  if (!recipient) return false;
  await sendWhatsAppText({ to: recipient, text: String(text) });
  return true;
}

function normalizeCopyResult(text, key = "") {
  const value = safeStr(text);
  if (!value) return "";
  if (key && value === key) return "";
  return value;
}

async function getCouponRemovalMessage(userId, reservation = null) {
  const id = safeStr(userId);
  const vars = {
    couponCode: safeStr(reservation?.couponCode),
    planCode: safeStr(reservation?.planCode),
    billingCycle: safeStr(reservation?.billingCycle),
  };

  try {
    const text = await getCopyText(COUPON_REMOVAL_MESSAGE_KEY, { waId: id, userId: id, vars });
    return normalizeCopyResult(text, COUPON_REMOVAL_MESSAGE_KEY) || COUPON_REMOVAL_FALLBACK;
  } catch (_) {
    return COUPON_REMOVAL_FALLBACK;
  }
}

async function processExpiredCouponReservations({ now = nowMs(), limit = COUPON_EXPIRATION_CHECK_LIMIT } = {}) {
  const expired = await listExpiredPendingCouponReservations({ now, limit }).catch(() => []);
  const rows = Array.isArray(expired) ? expired : [];

  let expiredCount = 0;
  let messageSentCount = 0;
  let skippedMessageCount = 0;
  let errors = 0;

  for (const reservation of rows) {
    const reservationId = safeStr(reservation?.reservationId || reservation?.id);
    const userId = safeStr(reservation?.internalUserId);
    if (!reservationId) continue;

    try {
      const result = await expireCouponReservation(reservationId, {
        reason: "coupon_timeout_20h",
        meta: { source: "broadcast_automation", timeoutHours: 20 },
      });

      const nextReservation = result?.reservation || reservation;
      expiredCount += result?.ok ? 1 : 0;

      if (userId) {
        await resetCheckoutCouponState(userId).catch(() => ({}));
      }

      const alreadySent = Boolean(nextReservation?.messageSentAt || nextReservation?.meta?.couponRemovedMessageSent);
      if (alreadySent) {
        skippedMessageCount += 1;
        continue;
      }

      const recipientInfo = userId ? await getRecipientForUser(userId) : null;
      const recipient = safeStr(recipientInfo?.recipient);
      if (!recipient) {
        skippedMessageCount += 1;
        await recordError("automation_coupon_expiration", userId || reservationId, "Missing outbound recipient for coupon expiration message").catch(() => 0);
        continue;
      }

      const text = await getCouponRemovalMessage(userId, nextReservation);
      if (!safeStr(text)) {
        skippedMessageCount += 1;
        await recordError("automation_coupon_expiration", userId || reservationId, "Coupon expiration message empty").catch(() => 0);
        continue;
      }

      try {
        await sendWhatsAppText({ to: recipient, text });
        await markCouponRemovedMessageSent(reservationId, {
          meta: { source: "broadcast_automation", timeoutHours: 20 },
        }).catch(() => ({}));
        messageSentCount += 1;
      } catch (err) {
        errors += 1;
        await recordError("automation_coupon_expiration", userId || reservationId, err?.message || err).catch(() => 0);
      }
    } catch (err) {
      errors += 1;
      await recordError("automation_coupon_expiration", userId || reservationId, err?.message || err).catch(() => 0);
    }
  }

  return {
    ok: true,
    expiredCount,
    messageSentCount,
    skippedMessageCount,
    errors,
    checked: rows.length,
  };
}

async function maybeSendPostAdIdleReminder(userId, nowTs) {
  const status = await getUserStatus(userId).catch(() => "");
  if (!(status === "TRIAL" || status === "ACTIVE")) return { sent: false };

  const postAdIdle = await getPostAdIdleMeta(userId).catch(() => ({}));
  const idleState = String(postAdIdle?.postAdIdleState || "").trim();
  if (!idleState) return { sent: false };

  const armedAt = String(postAdIdle?.postAdIdleArmedAt || "").trim();
  if (!armedAt) return { sent: false };

  const armedMs = new Date(armedAt).getTime();
  if (!Number.isFinite(armedMs)) return { sent: false };
  if (nowTs - armedMs < IDLE_REMINDER_DELAY_MS) return { sent: false };

  const activityMeta = await getActivityMeta(userId).catch(() => ({}));
  const lastInboundAt = String(activityMeta?.lastInboundAt || "").trim();
  const lastInboundMs = lastInboundAt ? new Date(lastInboundAt).getTime() : NaN;
  if (Number.isFinite(lastInboundMs) && lastInboundMs > armedMs) return { sent: false, skipped: "user-interacted-after-arm" };

  const reminderSentAt = String(postAdIdle?.postAdIdleReminderSentAt || "").trim();
  const reminderSentMs = reminderSentAt ? new Date(reminderSentAt).getTime() : NaN;
  if (Number.isFinite(reminderSentMs) && reminderSentMs >= armedMs) return { sent: false };

  await sendCopyMessage(userId, "FLOW_RETENTION_SIGNOFF");
  await markPostAdIdleReminderSent(userId, new Date(nowTs).toISOString()).catch(() => ({}));
  return { sent: true, type: "post_ad_idle", idleState };
}

async function maybeSendIdleReminder(userId, nowTs) {
  const status = await getUserStatus(userId).catch(() => "");
  if (!isIdleEligibleStatus(status)) return { sent: false };

  const activityMeta = await getActivityMeta(userId).catch(() => ({}));
  const lastInboundAt = String(activityMeta?.lastInboundAt || "").trim();
  if (!lastInboundAt) return { sent: false };

  const lastInboundMs = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(lastInboundMs)) return { sent: false };
  if (nowTs - lastInboundMs < IDLE_REMINDER_DELAY_MS) return { sent: false };

  const idleReminderSentAt = String(activityMeta?.idleReminderSentAt || "").trim();
  const idleReminderSentMs = idleReminderSentAt ? new Date(idleReminderSentAt).getTime() : NaN;
  if (Number.isFinite(idleReminderSentMs) && idleReminderSentMs >= lastInboundMs) return { sent: false };

  await sendCopyMessage(userId, "FLOW_IDLE_NUDGE");
  await setActivityMeta(userId, { ...activityMeta, idleReminderSentAt: new Date(nowTs).toISOString() }).catch(() => ({}));
  return { sent: true, type: "idle" };
}

async function maybeSendDailyAdNudge(userId, nowTs, waIdHint = "") {
  const status = await getUserStatus(userId).catch(() => "");
  if (!isDailyAdEligibleStatus(status)) return { sent: false };

  const currentParts = getTzParts(nowTs);
  if (currentParts.hour !== DAILY_AD_TARGET_HOUR) return { sent: false };

  const growthMeta = await getGrowthMeta(userId).catch(() => ({}));
  if (String(growthMeta?.lastAdCreatedDate || "") === currentParts.date) return { sent: false, skipped: "already-created-today" };
  if (String(growthMeta?.adOfDaySentDate || "") === currentParts.date) return { sent: false, skipped: "already-sent-today" };

  const inboundRef = safeStr(waIdHint) || safeStr((await getRecipientForUser(userId))?.recipient);
  const lastInboundMs = Number(await getLastInboundTs(inboundRef).catch(() => 0) || 0);
  if (!lastInboundMs) return { sent: false };

  const remainingMs = (lastInboundMs + 24 * 60 * 60 * 1000) - nowTs;
  if (!(remainingMs > DAILY_AD_MIN_REMAINING_MS && remainingMs <= DAILY_AD_MAX_REMAINING_MS)) return { sent: false };

  const lastInboundDate = getTzParts(lastInboundMs).date;
  if (lastInboundDate !== previousTzDate(nowTs)) return { sent: false };

  const key = remainingMs <= 90 * 60 * 1000 ? "FLOW_DAILY_AD_NUDGE_SHORT" : "FLOW_DAILY_AD_NUDGE";
  await sendCopyMessage(userId, key);
  await markAdOfDaySent(userId, new Date(nowTs).toISOString()).catch(() => ({}));
  return { sent: true, type: "daily_ad" };
}

export async function runLifecycleAutomationTick({ limit = 5000, tsMs = nowMs() } = {}) {
  const couponAutomation = await processExpiredCouponReservations({
    now: tsMs,
    limit: COUPON_EXPIRATION_CHECK_LIMIT,
  }).catch((err) => ({
    ok: false,
    expiredCount: 0,
    messageSentCount: 0,
    skippedMessageCount: 0,
    errors: 1,
    checked: 0,
    error: err?.message || String(err),
  }));

  const activeWaIds = await listWindow24hActive(tsMs, Number(limit || 5000)).catch(() => []);
  const activeList = Array.isArray(activeWaIds) ? activeWaIds.map((x) => String(x || "").trim()).filter(Boolean) : [];

  const mapped = [];
  const seen = new Set();
  for (const waId of activeList) {
    const userId = safeStr(await getInternalUserIdByWaId(waId).catch(() => null));
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    mapped.push({ userId, waId });
  }

  let postAdIdleSent = 0;
  let idleSent = 0;
  let dailyAdSent = 0;
  let errors = 0;

  for (const entry of mapped) {
    const userId = entry.userId;
    const waId = entry.waId;
    try {
      const postAdIdle = await maybeSendPostAdIdleReminder(userId, tsMs);
      if (postAdIdle?.sent) postAdIdleSent += 1;
    } catch (err) {
      errors += 1;
      await recordError("automation_post_ad_idle", userId, err?.message || err).catch(() => 0);
    }

    try {
      const idle = await maybeSendIdleReminder(userId, tsMs);
      if (idle?.sent) idleSent += 1;
    } catch (err) {
      errors += 1;
      await recordError("automation_idle", userId, err?.message || err).catch(() => 0);
    }

    try {
      const dailyAd = await maybeSendDailyAdNudge(userId, tsMs, waId);
      if (dailyAd?.sent) dailyAdSent += 1;
    } catch (err) {
      errors += 1;
      await recordError("automation_daily_ad", userId, err?.message || err).catch(() => 0);
    }
  }

  return {
    ok: true,
    activeWindow: mapped.length,
    postAdIdleSent,
    idleSent,
    dailyAdSent,
    errors,
    couponExpirationsChecked: Number(couponAutomation?.checked || 0),
    couponExpired: Number(couponAutomation?.expiredCount || 0),
    couponRemovalMessagesSent: Number(couponAutomation?.messageSentCount || 0),
    couponRemovalMessagesSkipped: Number(couponAutomation?.skippedMessageCount || 0),
    couponErrors: Number(couponAutomation?.errors || 0),
  };
}

let automationTimer = null;
let automationRunning = false;

export function startLifecycleAutomationLoop({ intervalMs = 60_000 } = {}) {
  const ms = Math.max(30_000, Number(intervalMs) || 60_000);
  if (automationTimer) return automationTimer;

  const tick = async () => {
    if (automationRunning) return;
    automationRunning = true;
    try {
      await runLifecycleAutomationTick({ limit: 5000, tsMs: nowMs() });
    } catch (err) {
      console.warn(JSON.stringify({
        level: "warn",
        tag: "automation_tick_failed",
        error: String(err?.message || err),
      }));
    } finally {
      automationRunning = false;
    }
  };

  automationTimer = setInterval(() => {
    void tick();
  }, ms);

  if (typeof automationTimer?.unref === "function") automationTimer.unref();
  void tick();
  return automationTimer;
}
