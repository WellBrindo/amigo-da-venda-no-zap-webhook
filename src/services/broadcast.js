// src/services/broadcast.js
// Orquestrador do motor de campanhas.
// Responsabilidades:
// - manter bootstrap do lifecycle
// - criar/disparar campanhas manuais com compatibilidade
// - processar pendências quando usuário volta para a janela 24h
// - executar rotinas operacionais isoladas (ex.: expiração de cupom)
// - delegar definição/elegibilidade/conflito para src/services/campaigns.js

import {
  redisSet,
  redisGet,
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
  getGrowthMeta,
  getUserTrialUsed,
  getUserAdsCreatedTotal,
  resetCheckoutCouponState,
} from "./state.js";
import { listWindow24hActive, nowMs } from "./window24h.js";
import { sendWhatsAppText } from "./meta/whatsapp.js";
import { getCopyText } from "./copy.js";
import { pushSystemAlert } from "./alerts.js";
import { getInternalUserIdByWaId, getPreferredOutboundRecipient } from "./identity.js";
import {
  listExpiredPendingCouponReservations,
  expireCouponReservation,
  markCouponRemovedMessageSent,
} from "./coupons.js";
import {
  createCampaign,
  getCampaign as getCampaignCore,
  listCampaigns as listCampaignsCore,
  evaluateCampaignEligibility,
  resolveCampaignConflict,
  logCampaignConflict,
  markCampaignSent,
  markCampaignError,
  CAMPAIGN_CATEGORY,
  CAMPAIGN_TRIGGER_TYPE,
  CAMPAIGN_MESSAGE_MODE,
  CAMPAIGN_CHANNEL,
  CAMPAIGN_CONFLICT_GROUP,
} from "./campaigns.js";

const CAMPAIGNS_LIST_KEY = "campaigns:list"; // campanhas manuais para compatibilidade do Admin legado
const PENDING_CAMPAIGNS_SET = "campaigns:pending:set"; // SET de campaignId com pendências
const CAMPAIGNS_TTL_SECONDS = 60 * 60 * 24 * 45; // 45 dias
const CAMPAIGNS_MAX_LIST = 300;

const AUTOMATION_TZ = "America/Sao_Paulo";
const COUPON_EXPIRATION_CHECK_LIMIT = 200;
const COUPON_REMOVAL_MESSAGE_KEY = "FLOW_COUPON_REMOVED_TIMEOUT";
const COUPON_REMOVAL_FALLBACK = [
  "Seu cupom de desconto foi removido porque o pagamento não foi confirmado dentro do prazo.",
  "Se quiser, você pode escolher novamente seu plano e aplicar um novo cupom válido na contratação.",
].join("\n\n");

function safeStr(v) {
  return String(v ?? "").trim();
}

function normalizePlanTargets(planTargets) {
  if (!planTargets) return [];
  const arr = Array.isArray(planTargets) ? planTargets : [planTargets];
  return arr
    .map((p) => safeStr(p).toUpperCase())
    .filter(Boolean)
    .filter((p) => /^[A-Z0-9_]{3,60}$/.test(p));
}

function normalizeRuntimeMeta(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  return {
    subject: safeStr(src.subject),
    text: safeStr(src.text),
    mode: safeStr(src.mode || "TEXT").toUpperCase(),
    planTargets: normalizePlanTargets(src.planTargets),
    createdAt: safeStr(src.createdAt) || new Date().toISOString(),
    totalTargets: Math.max(0, Number(src.totalTargets || 0) || 0),
    sendNow: Math.max(0, Number(src.sendNow || 0) || 0),
    pending: Math.max(0, Number(src.pending || 0) || 0),
  };
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
  return `campaign:${id}:pending`; // SET internalUserId
}
function campaignKeyErrors(id) {
  return `campaign:${id}:errors`; // LIST
}

async function setWithTTL(key, value, ttlSeconds = CAMPAIGNS_TTL_SECONDS) {
  await redisSet(key, value);
  await redisExpire(key, ttlSeconds);
}

async function ensureCampaignTTL(id) {
  const ttl = CAMPAIGNS_TTL_SECONDS;
  try {
    await redisExpire(campaignKeyMeta(id), ttl);
    await redisExpire(campaignKeyErrors(id), ttl);
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

async function recordError(id, userRef, errorMsg) {
  const entry = {
    ts: new Date().toISOString(),
    userRef: safeStr(userRef),
    error: safeStr(errorMsg).slice(0, 500),
  };
  await redisLPush(campaignKeyErrors(id), JSON.stringify(entry));
  await redisLTrim(campaignKeyErrors(id), 0, 199);
  await ensureCampaignTTL(id);
}

async function computeTargetsByPlan({ planTargets = [] }) {
  const targets = await listUsers();
  const plansFilter = normalizePlanTargets(planTargets);

  if (plansFilter.length === 0) {
    return targets;
  }

  const filtered = [];
  for (const userId of targets) {
    try {
      const p = await getUserPlan(userId);
      if (plansFilter.includes(String(p || "").toUpperCase())) {
        filtered.push(userId);
      }
    } catch (_) {
      // campanha manual não pode quebrar por um usuário isolado
    }
  }
  return filtered;
}

async function readRuntimeMeta(campaignId) {
  const raw = await redisGet(campaignKeyMeta(campaignId)).catch(() => "");
  try {
    return normalizeRuntimeMeta(raw ? JSON.parse(raw) : {});
  } catch {
    return normalizeRuntimeMeta({});
  }
}

async function writeRuntimeMeta(campaignId, meta = {}) {
  const normalized = normalizeRuntimeMeta(meta);
  await setWithTTL(campaignKeyMeta(campaignId), JSON.stringify(normalized));
  return normalized;
}

async function getCampaignStats(campaignId) {
  const [sentCount, pendingCount, errs] = await Promise.all([
    redisSCard(campaignKeySent(campaignId)).catch(() => 0),
    redisSCard(campaignKeyPending(campaignId)).catch(() => 0),
    redisLRange(campaignKeyErrors(campaignId), 0, 199).catch(() => []),
  ]);

  return {
    sent: Number(sentCount || 0),
    pending: Number(pendingCount || 0),
    errors: Array.isArray(errs) ? errs.length : 0,
  };
}

function isCheckoutLikeStatus(status) {
  const s = safeStr(status).toUpperCase();
  return [
    "WAIT_PLAN",
    "WAIT_BILLING_CYCLE",
    "WAIT_COUPON_CODE",
    "WAIT_CHECKOUT_CONFIRMATION",
    "WAIT_PAYMENT_METHOD",
    "WAIT_DOC",
    "WAIT_BILLING_CITY_STATE",
    "WAIT_BILLING_ADDRESS",
    "PAYMENT_PENDING",
  ].includes(s);
}

function deriveUserContext({ status = "", planCode = "", activityMeta = {}, growthMeta = {}, trialUsed = 0, adsCreated = 0, window24hOpen = false } = {}) {
  const s = safeStr(status).toUpperCase();
  const p = safeStr(planCode).toUpperCase();
  const lastInboundAt = safeStr(activityMeta?.lastInboundAt);
  const lastOutboundAt =
    safeStr(activityMeta?.idleReminderSentAt) ||
    safeStr(activityMeta?.postAdIdleReminderSentAt) ||
    "";
  const lastPlanPromptAt = safeStr(activityMeta?.lastPlanPromptAt);
  const trialEnded = s !== "TRIAL";
  const plansViewed = isCheckoutLikeStatus(s) || !!lastPlanPromptAt || s === "ACTIVE";
  const checkoutStarted = isCheckoutLikeStatus(s);
  const isPaymentPending = s === "PAYMENT_PENDING";
  const isBlockedUser = s === "BLOCKED";
  const isInCheckout = isCheckoutLikeStatus(s) && !isPaymentPending;

  return {
    status: s,
    planCode: p,
    window24hOpen: !!window24hOpen,
    isBlockedUser,
    isInCheckout,
    isPaymentPending,
    trialEnded,
    plansViewed,
    checkoutStarted,
    trialUsed: Math.max(0, Number(trialUsed || 0) || 0),
    adsCreated: Math.max(0, Number(adsCreated || 0) || 0),
    lastInboundAt,
    lastOutboundAt,
    lastAdCreatedAt: safeStr(growthMeta?.lastAdCreatedAt),
  };
}

async function renderCampaignMessage(campaign, userId) {
  const messageMode = safeStr(campaign?.messageMode).toLowerCase();
  const inlineText = safeStr(campaign?.inlineText);

  if (messageMode === CAMPAIGN_MESSAGE_MODE.INLINE_TEXT) {
    return inlineText;
  }

  const copyKey = safeStr(campaign?.copyKey);
  if (!copyKey) return "";
  const text = await getCopyText(copyKey, { waId: safeStr(userId), userId: safeStr(userId), vars: {} }).catch(() => "");
  return safeStr(text);
}

function shouldConsiderLifecycleCampaign(campaign) {
  if (!campaign || !campaign.isActive || campaign.isArchived) return false;
  const triggerType = safeStr(campaign.triggerType).toLowerCase();
  const category = safeStr(campaign.category).toLowerCase();
  if (triggerType === CAMPAIGN_TRIGGER_TYPE.MANUAL) return false;
  if (category === CAMPAIGN_CATEGORY.OPERATIONAL) return false;
  return true;
}

export async function createCampaignAndDispatch({
  subject,
  text,
  planTargets,
  mode = "TEXT",
} = {}) {
  const subj = safeStr(subject);
  const body = safeStr(text);
  if (!subj && !body) throw new Error("Missing subject or text");

  const campaignResult = await createCampaign(
    {
      code: `MANUAL_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      name: subj || "Campanha manual",
      description: subj || body.slice(0, 120),
      isActive: true,
      category: CAMPAIGN_CATEGORY.GENERIC_NURTURE,
      channel: CAMPAIGN_CHANNEL.WHATSAPP_WINDOW24H,
      messageMode: CAMPAIGN_MESSAGE_MODE.INLINE_TEXT,
      inlineText: body,
      priority: 100,
      conflictGroup: CAMPAIGN_CONFLICT_GROUP.GENERIC,
      triggerType: CAMPAIGN_TRIGGER_TYPE.MANUAL,
      triggerEvent: "manual_dispatch",
      requiredStatuses: [],
      excludedStatuses: [],
      requiredPlanCodes: normalizePlanTargets(planTargets),
      excludedPlanCodes: [],
      requiresWindow24hOpen: false,
      notes: subj,
    },
    { actor: "broadcast.createCampaignAndDispatch" }
  );

  const campaign = campaignResult?.campaign;
  if (!campaign?.id) throw new Error("failed to create campaign");

  const targetUserIds = await computeTargetsByPlan({ planTargets });
  const windowWaIds = await listWindow24hActive(nowMs(), 20000);
  const windowSet = new Set((windowWaIds || []).map((x) => String(x)));

  const sendNow = [];
  const pending = [];

  for (const userId of targetUserIds) {
    const recipientInfo = await getRecipientForUser(userId);
    if (!recipientInfo?.recipient) {
      await recordError(campaign.id, userId, "Missing outbound recipient for campaign target");
      await markCampaignError(campaign.id, userId, "Missing outbound recipient for campaign target").catch(() => ({}));
      continue;
    }
    if (windowSet.has(String(recipientInfo.recipient))) sendNow.push(recipientInfo);
    else pending.push(String(userId));
  }

  const runtimeMeta = await writeRuntimeMeta(campaign.id, {
    subject: subj,
    text: body,
    mode,
    planTargets: normalizePlanTargets(planTargets),
    createdAt: new Date().toISOString(),
    totalTargets: targetUserIds.length,
    sendNow: sendNow.length,
    pending: pending.length,
  });

  await addCampaignToList(campaign.id);

  const msg = buildMessage({ subject: subj, text: body });

  for (const entry of sendNow) {
    const userId = safeStr(entry?.userId);
    const recipient = safeStr(entry?.recipient);
    try {
      await sendWhatsAppText({ to: recipient, text: msg });
      await redisSAdd(campaignKeySent(campaign.id), userId);
      await markCampaignSent(campaign.id, userId, { details: { source: "manual_dispatch", recipient } }).catch(() => ({}));
    } catch (err) {
      await recordError(campaign.id, userId || recipient, err?.message || err);
      await markCampaignError(campaign.id, userId, err).catch(() => ({}));
    }
  }

  if (pending.length > 0) {
    await redisSAdd(campaignKeyPending(campaign.id), pending);
    await redisSAdd(PENDING_CAMPAIGNS_SET, campaign.id);
  }

  await ensureCampaignTTL(campaign.id);

  await pushSystemAlert("CAMPAIGN_CREATED", {
    id: campaign.id,
    totalTargets: targetUserIds.length,
    sendNow: sendNow.length,
    pending: pending.length,
    planTargets: runtimeMeta.planTargets,
    mode,
  }).catch(() => ({}));

  return await getCampaign(campaign.id);
}

export async function getCampaign(id) {
  const result = await getCampaignCore(String(id || "").trim());
  const campaign = result?.campaign || null;
  if (!campaign) return { ok: true, campaign: null };

  const runtimeMeta = await readRuntimeMeta(campaign.id);
  const stats = await getCampaignStats(campaign.id);

  return {
    ok: true,
    campaign: {
      id: campaign.id,
      meta: runtimeMeta,
      definition: campaign,
      stats,
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

export async function reprocessCampaignForActiveWindow(campaignId, { limit = 5000 } = {}) {
  const id = safeStr(campaignId);
  if (!id) throw new Error("campaignId required");

  const campaign = (await getCampaignCore(id))?.campaign;
  if (!campaign) throw new Error("campaign not found");

  const runtimeMeta = await readRuntimeMeta(id);
  const windowWaIds = await listWindow24hActive(nowMs(), Number(limit || 5000));
  const windowList = Array.isArray(windowWaIds) ? windowWaIds.map((x) => String(x)) : [];
  const windowSet = new Set(windowList);
  const pendingUserIds = await redisSMembers(campaignKeyPending(id)).catch(() => []);
  const pendList = Array.isArray(pendingUserIds) ? pendingUserIds.map((x) => String(x)) : [];

  let attempted = 0;
  let sent = 0;
  let errors = 0;

  const msg = buildMessage({ subject: runtimeMeta.subject, text: runtimeMeta.text });
  if (!msg) throw new Error("campaign message empty");

  for (const userId of pendList) {
    if (!userId) continue;
    const recipientInfo = await getRecipientForUser(userId);
    const recipient = safeStr(recipientInfo?.recipient);
    if (!recipient) {
      errors += 1;
      await recordError(id, userId, "Missing outbound recipient for pending campaign user");
      await markCampaignError(id, userId, "Missing outbound recipient for pending campaign user").catch(() => ({}));
      continue;
    }
    if (!windowSet.has(recipient)) continue;

    attempted += 1;
    try {
      await sendWhatsAppText({ to: recipient, text: msg });
      await redisSAdd(campaignKeySent(id), userId);
      await redisSRem(campaignKeyPending(id), userId);
      await markCampaignSent(id, userId, { details: { source: "reprocess_active_window", recipient } }).catch(() => ({}));
      sent += 1;
    } catch (err) {
      errors += 1;
      await recordError(id, userId, err?.message || err);
      await markCampaignError(id, userId, err).catch(() => ({}));
    }
  }

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

    const isPending = await redisSIsMember(campaignKeyPending(cpId), id).catch(() => 0);
    if (!Number(isPending)) continue;

    const runtimeMeta = await readRuntimeMeta(cpId);
    const msg = buildMessage({ subject: runtimeMeta.subject, text: runtimeMeta.text });

    if (!msg) {
      await redisSRem(campaignKeyPending(cpId), id).catch(() => 0);
      await recordError(cpId, id, "Campaign meta missing subject/text (auto-send skipped)");
      await markCampaignError(cpId, id, "Campaign meta missing subject/text (auto-send skipped)").catch(() => ({}));
      processed += 1;
      continue;
    }

    const recipientInfo = await getRecipientForUser(id);
    const recipient = safeStr(recipientInfo?.recipient);
    if (!recipient) {
      await recordError(cpId, id, "Missing outbound recipient for pending campaign user");
      await markCampaignError(cpId, id, "Missing outbound recipient for pending campaign user").catch(() => ({}));
      continue;
    }

    try {
      await sendWhatsAppText({ to: recipient, text: msg });
      await redisSAdd(campaignKeySent(cpId), id);
      await redisSRem(campaignKeyPending(cpId), id);
      await markCampaignSent(cpId, id, { details: { source: "pending_after_inbound", recipient } }).catch(() => ({}));
      processed += 1;
    } catch (err) {
      await recordError(cpId, id, err?.message || err);
      await markCampaignError(cpId, id, err).catch(() => ({}));
    }

    const pendingLeft = await redisSCard(campaignKeyPending(cpId)).catch(() => 0);
    if (Number(pendingLeft || 0) === 0) {
      await redisSRem(PENDING_CAMPAIGNS_SET, cpId).catch(() => 0);
    }

    await ensureCampaignTTL(cpId);
  }

  return { ok: true, waId: inboundWaId, userId: id, processed };
}

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

async function evaluateLifecycleCandidatesForUser(userId, nowTs) {
  const status = await getUserStatus(userId).catch(() => "");
  const planCode = await getUserPlan(userId).catch(() => "");
  const activityMeta = await getActivityMeta(userId).catch(() => ({}));
  const growthMeta = await getGrowthMeta(userId).catch(() => ({}));
  const trialUsed = await getUserTrialUsed(userId).catch(() => 0);
  const adsCreated = await getUserAdsCreatedTotal(userId).catch(() => 0);

  const context = deriveUserContext({
    status,
    planCode,
    activityMeta,
    growthMeta,
    trialUsed,
    adsCreated,
    window24hOpen: true,
  });

  const all = await listCampaignsCore({ includeInactive: false, limit: 1000 }).catch(() => ({ campaigns: [] }));
  const campaigns = (Array.isArray(all?.campaigns) ? all.campaigns : []).filter(shouldConsiderLifecycleCampaign);

  const evaluations = [];
  for (const campaign of campaigns) {
    try {
      const result = await evaluateCampaignEligibility(campaign, { userId }, { ...context, userId, nowMs: nowTs });
      evaluations.push(result);
    } catch (_) {
      // erro isolado de uma campanha não pode quebrar o tick inteiro
    }
  }

  return { status, context, evaluations };
}

async function dispatchLifecycleWinner(userId, evaluation) {
  const campaign = evaluation?.campaign;
  if (!campaign?.id) return { sent: false };

  const recipientInfo = await getRecipientForUser(userId);
  const recipient = safeStr(recipientInfo?.recipient);
  if (!recipient) {
    await recordError(campaign.id, userId, "Missing outbound recipient for lifecycle campaign");
    await markCampaignError(campaign.id, userId, "Missing outbound recipient for lifecycle campaign").catch(() => ({}));
    return { sent: false };
  }

  const text = await renderCampaignMessage(campaign, userId);
  if (!safeStr(text)) {
    await recordError(campaign.id, userId, "Lifecycle campaign message empty");
    await markCampaignError(campaign.id, userId, "Lifecycle campaign message empty").catch(() => ({}));
    return { sent: false };
  }

  try {
    await sendWhatsAppText({ to: recipient, text });
    await markCampaignSent(campaign.id, userId, {
      details: {
        source: "lifecycle_automation",
        recipient,
        triggerType: campaign.triggerType,
        category: campaign.category,
      },
    }).catch(() => ({}));
    return { sent: true, campaignId: campaign.id };
  } catch (err) {
    await recordError(campaign.id, userId, err?.message || err);
    await markCampaignError(campaign.id, userId, err).catch(() => ({}));
    return { sent: false };
  }
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

  let campaignSent = 0;
  let conflictsLogged = 0;
  let errors = 0;

  for (const entry of mapped) {
    const userId = entry.userId;
    try {
      const result = await evaluateLifecycleCandidatesForUser(userId, tsMs);
      const eligible = result.evaluations.filter((item) => item?.eligible);
      if (!eligible.length) continue;

      const resolved = resolveCampaignConflict(eligible);
      if (eligible.length > 1) {
        await logCampaignConflict({
          userId,
          evaluations: eligible,
          winner: resolved?.winner || null,
        }).catch(() => ({}));
        conflictsLogged += 1;
      }

      const winner = resolved?.winner || null;
      if (!winner) continue;

      const sent = await dispatchLifecycleWinner(userId, winner);
      if (sent?.sent) campaignSent += 1;
    } catch (err) {
      errors += 1;
      await recordError("automation_lifecycle", userId, err?.message || err).catch(() => 0);
    }
  }

  return {
    ok: true,
    activeWindow: mapped.length,
    campaignSent,
    conflictsLogged,
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
