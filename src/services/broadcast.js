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
  getRedisHealthSnapshot,
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
import * as metrics from "./metrics.js";
import * as audit from "./audit.js";
import { getCopyText } from "./copy.js";
import { pushSystemAlert, raiseSystemIncident } from "./alerts.js";
import { getInternalUserIdByWaId, getPreferredOutboundRecipient, getPendingIdentityConflictForUser } from "./identity.js";
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


const BROADCAST_ERROR = Object.freeze({
  RECIPIENT: "BROADCAST_RECIPIENT_ERROR",
  SEND: "BROADCAST_SEND_ERROR",
  PERSISTENCE: "BROADCAST_PERSISTENCE_ERROR",
  CAMPAIGN_LOOKUP: "BROADCAST_CAMPAIGN_LOOKUP_ERROR",
  COUPON_EXPIRATION: "BROADCAST_COUPON_EXPIRATION_ERROR",
  IDENTITY_REVIEW_REQUIRED: "BROADCAST_IDENTITY_REVIEW_REQUIRED",
  RUNTIME: "BROADCAST_RUNTIME_ERROR",
});

function extractErrorMessage(err) {
  return safeStr(err?.message || err?.reason || err?.error || err) || "Unknown broadcast error";
}

function buildBroadcastErrorContext({
  errorCode = BROADCAST_ERROR.RUNTIME,
  campaignId = "",
  campaignCode = "",
  userId = "",
  recipient = "",
  step = "",
  source = "broadcast",
  extra = {},
} = {}) {
  return {
    source: safeStr(source) || "broadcast",
    campaignId: safeStr(campaignId),
    campaignCode: safeStr(campaignCode),
    userId: safeStr(userId),
    waId: safeStr(recipient),
    recipient: safeStr(recipient),
    step: safeStr(step),
    errorCode: safeStr(errorCode) || BROADCAST_ERROR.RUNTIME,
    ...(extra && typeof extra === "object" ? extra : {}),
  };
}

async function emitBroadcastMetricSafe(metricFn, payload = {}) {
  if (typeof metricFn !== "function") return null;
  try {
    return await metricFn(payload);
  } catch {
    return null;
  }
}

async function logBroadcastOperational(entry = {}) {
  const payload = {
    module: "broadcast",
    event: safeStr(entry.event) || "broadcast_runtime",
    level: safeStr(entry.level) || "warn",
    status: safeStr(entry.status),
    message: safeStr(entry.message),
    errorCode: safeStr(entry.errorCode),
    userId: safeStr(entry.userId),
    waId: safeStr(entry.waId || entry.recipient),
    campaignId: safeStr(entry.campaignId),
    campaignCode: safeStr(entry.campaignCode),
    step: safeStr(entry.step),
    meta: entry.meta && typeof entry.meta === "object" ? entry.meta : {},
  };

  try {
    if (typeof audit.logOperationalEvent === "function") {
      await audit.logOperationalEvent(payload);
      return;
    }
    if (typeof audit.logRuntimeError === "function") {
      await audit.logRuntimeError(payload);
      return;
    }
  } catch {}

  try {
    console.warn(JSON.stringify({ level: payload.level, tag: payload.event, ...payload }));
  } catch {}
}

async function reportIdentityReviewSuppression({
  userId = "",
  recipient = "",
  campaignId = "",
  campaignCode = "",
  step = "",
  conflictId = "",
  status = "PENDING_REVIEW",
  source = "",
} = {}) {
  const payload = buildBroadcastErrorContext({
    errorCode: BROADCAST_ERROR.IDENTITY_REVIEW_REQUIRED,
    campaignId,
    campaignCode,
    userId,
    recipient,
    step,
    extra: {
      conflictId: safeStr(conflictId),
      conflictStatus: safeStr(status || "PENDING_REVIEW"),
      suppressionSource: safeStr(source),
    },
  });

  await logBroadcastOperational({
    event: "broadcast_identity_review_suppressed",
    level: "info",
    status: "suppressed",
    message: "Campanha automática suprimida por conflito de identidade pendente.",
    ...payload,
    meta: payload,
  });

  try {
    if (typeof audit.logIdentityConflictAudit === "function") {
      await audit.logIdentityConflictAudit({
        action: "IDENTITY_CONFLICT_SENSITIVE_OP_BLOCKED",
        conflictId: safeStr(conflictId),
        waUserId: safeStr(userId),
        status: safeStr(status || "PENDING_REVIEW"),
        summary: "Campanha automática suprimida por conflito de identidade pendente.",
        meta: {
          campaignId: safeStr(campaignId),
          campaignCode: safeStr(campaignCode),
          step: safeStr(step),
          recipient: safeStr(recipient),
          source: safeStr(source || "broadcast"),
          classification: "suppressed_controlled",
        },
      });
    }
  } catch {}

  return {
    ...payload,
    classification: "suppressed_controlled",
  };
}

async function getPendingIdentityConflictForBroadcastUser(userId) {
  const id = safeStr(userId);
  if (!id) return null;
  try {
    return await getPendingIdentityConflictForUser(id);
  } catch {
    return null;
  }
}

async function reportBroadcastFailure({
  error,
  errorCode = BROADCAST_ERROR.RUNTIME,
  campaignId = "",
  campaignCode = "",
  userId = "",
  recipient = "",
  step = "",
  metricsKind = "campaign",
  extra = {},
} = {}) {
  const context = buildBroadcastErrorContext({
    errorCode, campaignId, campaignCode, userId, recipient, step, extra,
  });
  const message = extractErrorMessage(error);

  await logBroadcastOperational({
    event: safeStr(step) || "broadcast_failure",
    level: "warn",
    status: "error",
    message,
    ...context,
    meta: extra,
  });

  if (metricsKind === "whatsapp") {
    await emitBroadcastMetricSafe(metrics.trackWhatsappSendError, context);
  } else {
    await emitBroadcastMetricSafe(metrics.trackCampaignError, context);
  }

  return { ...context, message };
}


async function reportBroadcastDegraded({
  error,
  errorCode = BROADCAST_ERROR.PERSISTENCE,
  campaignId = "",
  campaignCode = "",
  userId = "",
  recipient = "",
  step = "",
  impact = "",
  severity = "HIGH",
  extra = {},
} = {}) {
  const context = buildBroadcastErrorContext({
    errorCode, campaignId, campaignCode, userId, recipient, step, extra,
  });
  const message = extractErrorMessage(error);
  const redisStatus = typeof getRedisHealthSnapshot === "function"
    ? safeStr(getRedisHealthSnapshot()?.status) || "DEGRADED"
    : "DEGRADED";

  await logBroadcastOperational({
    event: safeStr(step) || "broadcast_degraded",
    level: "warn",
    status: "degraded",
    message,
    ...context,
    meta: {
      impact: safeStr(impact),
      severity: safeStr(severity),
      redisStatus,
      ...(extra && typeof extra === "object" ? extra : {}),
    },
  });

  try {
    if (redisStatus === "DOWN" && typeof metrics.trackRedisDown === "function") {
      await metrics.trackRedisDown({
        userId: safeStr(userId),
        waId: safeStr(recipient),
        source: "broadcast",
        step: safeStr(step),
        errorCode: safeStr(errorCode),
        impact: safeStr(impact),
        severity: safeStr(severity),
      });
    } else if (typeof metrics.trackRedisDegraded === "function") {
      await metrics.trackRedisDegraded({
        userId: safeStr(userId),
        waId: safeStr(recipient),
        source: "broadcast",
        step: safeStr(step),
        errorCode: safeStr(errorCode),
        impact: safeStr(impact),
        severity: safeStr(severity),
      });
    }
  } catch {}

  try {
    await raiseSystemIncident({
      type: "REDIS",
      severity: safeStr(severity) || "HIGH",
      module: "broadcast",
      step: safeStr(step),
      errorCode: safeStr(errorCode),
      message,
      impact: safeStr(impact),
      dedupeKey: ["broadcast", safeStr(step), safeStr(errorCode), safeStr(impact), safeStr(campaignId)].filter(Boolean).join("|"),
      meta: {
        campaignId: safeStr(campaignId),
        campaignCode: safeStr(campaignCode),
        userId: safeStr(userId),
        recipient: safeStr(recipient),
        redisStatus,
        ...(extra && typeof extra === "object" ? extra : {}),
      },
    });
  } catch {}

  return { ...context, message, classification: "degraded" };
}

async function redisBestEffort(action, fallback, failureContext = {}) {
  try {
    return await action();
  } catch (error) {
    await reportBroadcastDegraded({
      error,
      errorCode: BROADCAST_ERROR.PERSISTENCE,
      step: failureContext.step || "redis_operation",
      campaignId: failureContext.campaignId,
      campaignCode: failureContext.campaignCode,
      userId: failureContext.userId,
      recipient: failureContext.recipient,
      impact: safeStr(failureContext.impact || "redis_persistence_fallback"),
      severity: safeStr(failureContext.severity || "HIGH"),
      extra: failureContext.extra,
    });
    return fallback;
  }
}

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
  if (!id) {
    return { ok: false, userId: id, recipient: "", channel: "", errorCode: BROADCAST_ERROR.RECIPIENT, error: "Missing userId" };
  }

  try {
    const outbound = await getPreferredOutboundRecipient(id);
    const recipient = safeStr(outbound?.recipient);
    if (!recipient) {
      return {
        ok: false,
        userId: id,
        recipient: "",
        channel: safeStr(outbound?.channel || ""),
        errorCode: BROADCAST_ERROR.RECIPIENT,
        error: "Missing outbound recipient",
      };
    }
    return { ok: true, userId: id, recipient, channel: safeStr(outbound?.channel || "WHATSAPP") };
  } catch (error) {
    return {
      ok: false,
      userId: id,
      recipient: "",
      channel: "",
      errorCode: BROADCAST_ERROR.RECIPIENT,
      error,
    };
  }
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
  return await redisBestEffort(async () => {
    await redisExpire(campaignKeyMeta(id), ttl);
    await redisExpire(campaignKeyErrors(id), ttl);
    await redisExpire(campaignKeySent(id), ttl);
    await redisExpire(campaignKeyPending(id), ttl);
    return true;
  }, false, { campaignId: safeStr(id), step: "ensure_campaign_ttl" });
}

async function addCampaignToList(id) {
  return await redisBestEffort(async () => {
    await redisLPush(CAMPAIGNS_LIST_KEY, id);
    await redisLTrim(CAMPAIGNS_LIST_KEY, 0, CAMPAIGNS_MAX_LIST - 1);
    await redisExpire(CAMPAIGNS_LIST_KEY, CAMPAIGNS_TTL_SECONDS);
    return true;
  }, false, { campaignId: safeStr(id), step: "add_campaign_to_list" });
}

async function recordError(id, userRef, errorMsg) {
  const entry = {
    ts: new Date().toISOString(),
    userRef: safeStr(userRef),
    error: safeStr(errorMsg).slice(0, 500),
  };

  try {
    await redisLPush(campaignKeyErrors(id), JSON.stringify(entry));
    await redisLTrim(campaignKeyErrors(id), 0, 199);
    await ensureCampaignTTL(id);
    return true;
  } catch (error) {
    await reportBroadcastDegraded({
      error,
      errorCode: BROADCAST_ERROR.PERSISTENCE,
      campaignId: safeStr(id),
      userId: safeStr(userRef),
      step: "record_campaign_error",
      impact: "campaign_error_log_persistence_failed",
      severity: "MEDIUM",
      extra: { originalError: entry.error },
    });
    return false;
  }
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
      await reportBroadcastFailure({
        error: _,
        errorCode: BROADCAST_ERROR.RUNTIME,
        userId: safeStr(userId),
        step: "compute_targets_by_plan",
      });
    }
  }
  return filtered;
}

async function readRuntimeMeta(campaignId) {
  const raw = await redisBestEffort(
    () => redisGet(campaignKeyMeta(campaignId)),
    "",
    { campaignId: safeStr(campaignId), step: "read_runtime_meta" }
  );
  try {
    return normalizeRuntimeMeta(raw ? JSON.parse(raw) : {});
  } catch (error) {
    await reportBroadcastFailure({
      error,
      errorCode: BROADCAST_ERROR.PERSISTENCE,
      campaignId: safeStr(campaignId),
      step: "parse_runtime_meta",
    });
    return normalizeRuntimeMeta({});
  }
}

async function writeRuntimeMeta(campaignId, meta = {}) {
  const normalized = normalizeRuntimeMeta(meta);
  await redisBestEffort(
    () => setWithTTL(campaignKeyMeta(campaignId), JSON.stringify(normalized)),
    null,
    { campaignId: safeStr(campaignId), step: "write_runtime_meta" }
  );
  return normalized;
}

function buildCampaignDispatchDetails({
  dispatchSource = "",
  recipient = "",
  channel = "",
  runtimeMeta = {},
  campaign = null,
  extra = {},
} = {}) {
  const normalizedExtra = extra && typeof extra === "object" ? { ...extra } : {};
  return {
    dispatchSource: safeStr(dispatchSource),
    recipient: safeStr(recipient),
    channel: safeStr(channel || "WHATSAPP"),
    campaignCode: safeStr(campaign?.code),
    triggerType: safeStr(campaign?.triggerType),
    category: safeStr(campaign?.category),
    messageMode: safeStr(campaign?.messageMode),
    runtimeCreatedAt: safeStr(runtimeMeta?.createdAt),
    runtimeTotalTargets: Math.max(0, Number(runtimeMeta?.totalTargets || 0) || 0),
    runtimeSendNow: Math.max(0, Number(runtimeMeta?.sendNow || 0) || 0),
    runtimePending: Math.max(0, Number(runtimeMeta?.pending || 0) || 0),
    attributionPolicy: "clicked_intent_and_conversion_must_be_recorded_from_real_user_interaction_points",
    ...normalizedExtra,
  };
}

/**
 * Importante:
 * - este módulo é o orquestrador de disparo operacional
 * - ele confirma envio real e delega campaign_received ao campaigns.js via markCampaignSent(...)
 * - campaign_clicked_intent / campaign_conversion_attributed NÃO devem ser inferidos aqui apenas porque houve inbound
 * - esses eventos precisam nascer em pontos de interação real do usuário (ex.: flow inbound, ação explícita, conversão reconhecida)
 */

async function getCampaignStats(campaignId) {
  const [sentCount, pendingCount, errs] = await Promise.all([
    redisBestEffort(() => redisSCard(campaignKeySent(campaignId)), 0, { campaignId: safeStr(campaignId), step: "stats_sent_count" }),
    redisBestEffort(() => redisSCard(campaignKeyPending(campaignId)), 0, { campaignId: safeStr(campaignId), step: "stats_pending_count" }),
    redisBestEffort(() => redisLRange(campaignKeyErrors(campaignId), 0, 199), [], { campaignId: safeStr(campaignId), step: "stats_error_range" }),
  ]);

  return {
    sent: Number(sentCount || 0),
    pending: Number(pendingCount || 0),
    errors: Array.isArray(errs) ? errs.length : 0,
  };
}

function limitPreview(value, max = 240) {
  const text = safeStr(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  const lim = Math.max(40, Math.min(Number(max || 240), 1000));
  return text.length > lim ? `${text.slice(0, lim)}…` : text;
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function normalizeDiagnosticCampaignRecord({
  campaignId = "",
  campaign = null,
  runtimeMeta = {},
  stats = {},
  pendingMembership = false,
  sentMembership = false,
  errorItems = [],
} = {}) {
  const definition = campaign && typeof campaign === "object" ? campaign : {};
  const meta = runtimeMeta && typeof runtimeMeta === "object" ? runtimeMeta : {};
  const id = safeStr(campaignId || definition.id);
  return {
    campaignId: id,
    campaignCode: safeStr(definition.code),
    name: safeStr(definition.name),
    category: safeStr(definition.category),
    triggerType: safeStr(definition.triggerType),
    messageMode: safeStr(definition.messageMode),
    copyKey: safeStr(definition.copyKey),
    inlineTextPreview: limitPreview(definition.inlineText, 240),
    subject: safeStr(meta.subject),
    textPreview: limitPreview(meta.text || definition.inlineText, 240),
    runtimeCreatedAt: safeStr(meta.createdAt),
    stats: stats && typeof stats === "object" ? stats : {},
    pendingMembership: Boolean(pendingMembership),
    sentMembership: Boolean(sentMembership),
    errorItems: Array.isArray(errorItems) ? errorItems : [],
  };
}

function normalizeLifecycleDiagnosticEvaluation(item = {}) {
  const evaluation = item && typeof item === "object" ? item : {};
  const campaign = evaluation.campaign && typeof evaluation.campaign === "object" ? evaluation.campaign : {};
  return {
    campaignId: safeStr(campaign.id || evaluation.campaignId),
    campaignCode: safeStr(campaign.code || evaluation.campaignCode),
    name: safeStr(campaign.name),
    category: safeStr(campaign.category),
    triggerType: safeStr(campaign.triggerType),
    eligible: Boolean(evaluation.eligible),
    action: safeStr(evaluation.action),
    reason: safeStr(evaluation.reason),
    primaryReason: safeStr(evaluation.primaryReason),
    blockReason: safeStr(evaluation.blockReason),
    cooldownUntil: safeStr(evaluation.cooldownUntil),
    evaluatedAt: safeStr(evaluation.evaluatedAt),
  };
}

async function resolveUserIdForCampaignDiagnostics(userRef) {
  const inputRef = safeStr(userRef);
  if (!inputRef) return { inputRef, userId: "" };
  if (/^usr_\d+$/i.test(inputRef)) return { inputRef, userId: inputRef };
  const mapped = await redisBestEffort(
    () => getInternalUserIdByWaId(inputRef),
    "",
    { userId: inputRef, recipient: inputRef, step: "diagnostics_resolve_user" }
  );
  return { inputRef, userId: safeStr(mapped || inputRef) };
}

async function readCampaignDiagnosticsRecord(campaignId, userId) {
  const id = safeStr(campaignId);
  const user = safeStr(userId);
  if (!id || !user) return null;

  const [coreResult, runtimeMeta, stats, pendingMembership, sentMembership, rawErrors] = await Promise.all([
    getCampaignCore(id).catch(() => null),
    readRuntimeMeta(id).catch(() => normalizeRuntimeMeta({})),
    getCampaignStats(id).catch(() => ({ sent: 0, pending: 0, errors: 0 })),
    redisBestEffort(
      () => redisSIsMember(campaignKeyPending(id), user),
      0,
      { campaignId: id, userId: user, step: "diagnostics_pending_membership" }
    ),
    redisBestEffort(
      () => redisSIsMember(campaignKeySent(id), user),
      0,
      { campaignId: id, userId: user, step: "diagnostics_sent_membership" }
    ),
    redisBestEffort(
      () => redisLRange(campaignKeyErrors(id), 0, 199),
      [],
      { campaignId: id, userId: user, step: "diagnostics_error_items" }
    ),
  ]);

  const errorItems = (Array.isArray(rawErrors) ? rawErrors : [])
    .map((item) => safeJsonParse(item, null))
    .filter((item) => {
      const ref = safeStr(item?.userRef || item?.userId || item?.waId);
      return !ref || ref === user;
    })
    .slice(0, 20)
    .map((item) => ({
      ts: safeStr(item?.ts),
      userRef: safeStr(item?.userRef || item?.userId || item?.waId),
      error: limitPreview(item?.error || item?.message, 240),
    }));

  return normalizeDiagnosticCampaignRecord({
    campaignId: id,
    campaign: coreResult?.campaign || null,
    runtimeMeta,
    stats,
    pendingMembership: Number(pendingMembership || 0) > 0,
    sentMembership: Number(sentMembership || 0) > 0,
    errorItems,
  });
}

async function listAllDiagnosticCampaignIds() {
  const legacyIds = await redisBestEffort(
    () => redisLRange(CAMPAIGNS_LIST_KEY, 0, CAMPAIGNS_MAX_LIST - 1),
    [],
    { step: "diagnostics_list_legacy_campaigns" }
  );
  const managed = await listCampaignsCore({ includeInactive: true, limit: 1000 }).catch(() => ({ campaigns: [] }));
  const managedIds = (Array.isArray(managed?.campaigns) ? managed.campaigns : [])
    .map((campaign) => safeStr(campaign?.id))
    .filter(Boolean);

  return Array.from(new Set([
    ...(Array.isArray(legacyIds) ? legacyIds : []).map((id) => safeStr(id)).filter(Boolean),
    ...managedIds,
  ]));
}

export async function getUserCampaignDiagnostics(userRef, options = {}) {
  const { inputRef, userId } = await resolveUserIdForCampaignDiagnostics(userRef);
  const generatedAt = new Date().toISOString();

  const base = {
    ok: true,
    inputRef,
    userId,
    generatedAt,
    summary: {
      pendingCount: 0,
      sentCount: 0,
      errorCount: 0,
      lifecycleEvaluatedCount: 0,
      lifecycleEligibleCount: 0,
      hasLifecycleWinner: false,
    },
    pending: [],
    sent: [],
    errors: [],
    lifecycle: {
      status: "",
      context: {},
      evaluations: [],
      eligible: [],
      winner: null,
    },
  };

  if (!userId) return base;

  const pendingCampaignIds = await redisBestEffort(
    () => redisSMembers(PENDING_CAMPAIGNS_SET),
    [],
    { userId, step: "diagnostics_pending_campaigns_set" }
  );

  const pendingIds = Array.from(new Set((Array.isArray(pendingCampaignIds) ? pendingCampaignIds : [])
    .map((id) => safeStr(id))
    .filter(Boolean)));

  for (const campaignId of pendingIds) {
    const isPending = await redisBestEffort(
      () => redisSIsMember(campaignKeyPending(campaignId), userId),
      0,
      { campaignId, userId, step: "diagnostics_pending_user_membership" }
    );
    if (!Number(isPending || 0)) continue;

    const row = await readCampaignDiagnosticsRecord(campaignId, userId);
    if (row) base.pending.push(row);
  }

  const allCampaignIds = await listAllDiagnosticCampaignIds();
  for (const campaignId of allCampaignIds) {
    const row = await readCampaignDiagnosticsRecord(campaignId, userId);
    if (!row) continue;

    if (row.sentMembership) base.sent.push(row);
    if (row.errorItems.length) base.errors.push(row);
  }

  const nowTs = Number(options?.nowMs || nowMs());
  const lifecycle = await evaluateLifecycleCandidatesForUser(userId, nowTs).catch((error) => ({
    status: "",
    context: {},
    evaluations: [],
    error: extractErrorMessage(error),
  }));

  const evaluations = Array.isArray(lifecycle?.evaluations) ? lifecycle.evaluations : [];
  const eligibleRaw = evaluations.filter((item) => item?.eligible);
  const resolved = eligibleRaw.length ? resolveCampaignConflict(eligibleRaw) : { winner: null };

  base.lifecycle = {
    status: safeStr(lifecycle?.status),
    context: lifecycle?.context && typeof lifecycle.context === "object" ? lifecycle.context : {},
    evaluations: evaluations.map(normalizeLifecycleDiagnosticEvaluation),
    eligible: eligibleRaw.map(normalizeLifecycleDiagnosticEvaluation),
    winner: resolved?.winner ? normalizeLifecycleDiagnosticEvaluation(resolved.winner) : null,
  };

  base.summary = {
    pendingCount: base.pending.length,
    sentCount: base.sent.length,
    errorCount: base.errors.reduce((acc, item) => acc + (Array.isArray(item.errorItems) ? item.errorItems.length : 0), 0),
    lifecycleEvaluatedCount: base.lifecycle.evaluations.length,
    lifecycleEligibleCount: base.lifecycle.eligible.length,
    hasLifecycleWinner: Boolean(base.lifecycle.winner?.campaignId),
  };

  return base;
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

  let campaignResult;
  try {
    campaignResult = await createCampaign(
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
  } catch (error) {
    await reportBroadcastFailure({ error, errorCode: BROADCAST_ERROR.CAMPAIGN_LOOKUP, step: "create_campaign" });
    throw error;
  }

  const campaign = campaignResult?.campaign;
  if (!campaign?.id) throw new Error("failed to create campaign");

  let targetUserIds = [];
  try {
    targetUserIds = await computeTargetsByPlan({ planTargets });
  } catch (error) {
    await reportBroadcastFailure({
      error,
      errorCode: BROADCAST_ERROR.RUNTIME,
      campaignId: campaign.id,
      campaignCode: campaign.code,
      step: "compute_targets",
    });
    targetUserIds = [];
  }

  const windowWaIds = await redisBestEffort(
    () => listWindow24hActive(nowMs(), 20000),
    [],
    { campaignId: campaign.id, campaignCode: campaign.code, step: "list_window24h_active" }
  );
  const windowSet = new Set((windowWaIds || []).map((x) => String(x)));

  const sendNow = [];
  const pending = [];

  for (const userId of targetUserIds) {
    try {
      const recipientInfo = await getRecipientForUser(userId);
      if (!recipientInfo?.ok || !recipientInfo?.recipient) {
        await reportBroadcastFailure({
          error: recipientInfo?.error || "Missing outbound recipient for campaign target",
          errorCode: recipientInfo?.errorCode || BROADCAST_ERROR.RECIPIENT,
          campaignId: campaign.id,
          campaignCode: campaign.code,
          userId,
          step: "resolve_campaign_recipient",
        });
        await recordError(campaign.id, userId, "Missing outbound recipient for campaign target");
        await markCampaignError(campaign.id, userId, "Missing outbound recipient for campaign target").catch(() => ({}));
        continue;
      }
      if (windowSet.has(String(recipientInfo.recipient))) sendNow.push(recipientInfo);
      else pending.push(String(userId));
    } catch (error) {
      await reportBroadcastFailure({
        error, errorCode: BROADCAST_ERROR.RECIPIENT, campaignId: campaign.id, campaignCode: campaign.code, userId, step: "queue_target_resolution",
      });
      await recordError(campaign.id, userId, extractErrorMessage(error));
      await markCampaignError(campaign.id, userId, error).catch(() => ({}));
    }
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
      const markSentStored = await redisBestEffort(
        () => redisSAdd(campaignKeySent(campaign.id), userId),
        0,
        {
          campaignId: campaign.id,
          campaignCode: campaign.code,
          userId,
          recipient,
          step: "mark_campaign_sent",
          impact: "post_send_sent_set_persistence",
          severity: "CRITICAL",
        }
      );
      if (!Number(markSentStored || 0)) {
        await reportBroadcastDegraded({
          error: "Campaign delivered but sent persistence could not be confirmed",
          errorCode: BROADCAST_ERROR.PERSISTENCE,
          campaignId: campaign.id,
          campaignCode: campaign.code,
          userId,
          recipient,
          step: "mark_campaign_sent",
          impact: "post_send_sent_set_persistence",
          severity: "CRITICAL",
          extra: { classification: "critical_post_send_persistence" },
        });
        continue;
      }

      try {
        await markCampaignSent(campaign.id, userId, {
          source: "broadcast",
          details: buildCampaignDispatchDetails({
            dispatchSource: "manual_dispatch",
            recipient,
            channel: entry?.channel,
            runtimeMeta,
            campaign,
          }),
        });
      } catch (error) {
        await reportBroadcastDegraded({
          error,
          errorCode: BROADCAST_ERROR.PERSISTENCE,
          campaignId: campaign.id,
          campaignCode: campaign.code,
          userId,
          recipient,
          step: "mark_campaign_sent_core",
          impact: "post_send_campaign_sent_core_failed",
          severity: "CRITICAL",
        });
        continue;
      }
    } catch (error) {
      await reportBroadcastFailure({
        error,
        errorCode: BROADCAST_ERROR.SEND,
        campaignId: campaign.id,
        campaignCode: campaign.code,
        userId: userId || recipient,
        recipient,
        step: "manual_dispatch_send",
        metricsKind: "whatsapp",
      });
      await recordError(campaign.id, userId || recipient, extractErrorMessage(error));
      await markCampaignError(campaign.id, userId, error).catch(() => ({}));
    }
  }

  if (pending.length > 0) {
    await redisBestEffort(() => redisSAdd(campaignKeyPending(campaign.id), pending), 0, { campaignId: campaign.id, campaignCode: campaign.code, step: "queue_campaign_pending" });
    await redisBestEffort(() => redisSAdd(PENDING_CAMPAIGNS_SET, campaign.id), 0, { campaignId: campaign.id, campaignCode: campaign.code, step: "queue_pending_set" });
  }

  await ensureCampaignTTL(campaign.id);

  try {
    await pushSystemAlert("CAMPAIGN_CREATED", {
      id: campaign.id,
      totalTargets: targetUserIds.length,
      sendNow: sendNow.length,
      pending: pending.length,
      planTargets: runtimeMeta.planTargets,
      mode,
    });
  } catch (error) {
    await reportBroadcastFailure({ error, errorCode: BROADCAST_ERROR.RUNTIME, campaignId: campaign.id, campaignCode: campaign.code, step: "push_system_alert" });
  }

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

  let campaign = null;
  try {
    campaign = (await getCampaignCore(id))?.campaign;
  } catch (error) {
    await reportBroadcastFailure({ error, errorCode: BROADCAST_ERROR.CAMPAIGN_LOOKUP, campaignId: id, step: "reprocess_lookup_campaign" });
    throw error;
  }
  if (!campaign) throw new Error("campaign not found");

  const runtimeMeta = await readRuntimeMeta(id);
  const windowWaIds = await redisBestEffort(() => listWindow24hActive(nowMs(), Number(limit || 5000)), [], { campaignId: id, campaignCode: campaign.code, step: "reprocess_list_window24h_active" });
  const windowList = Array.isArray(windowWaIds) ? windowWaIds.map((x) => String(x)) : [];
  const windowSet = new Set(windowList);
  const pendingUserIds = await redisBestEffort(() => redisSMembers(campaignKeyPending(id)), [], { campaignId: id, campaignCode: campaign.code, step: "reprocess_pending_users" });
  const pendList = Array.isArray(pendingUserIds) ? pendingUserIds.map((x) => String(x)) : [];

  let attempted = 0;
  let sent = 0;
  let errors = 0;

  const msg = buildMessage({ subject: runtimeMeta.subject, text: runtimeMeta.text });
  if (!msg) throw new Error("campaign message empty");

  for (const userId of pendList) {
    if (!userId) continue;
    try {
      const recipientInfo = await getRecipientForUser(userId);
      const recipient = safeStr(recipientInfo?.recipient);
      if (!recipientInfo?.ok || !recipient) {
        errors += 1;
        await reportBroadcastFailure({ error: recipientInfo?.error || "Missing outbound recipient for pending campaign user", errorCode: recipientInfo?.errorCode || BROADCAST_ERROR.RECIPIENT, campaignId: id, campaignCode: campaign.code, userId, step: "reprocess_resolve_recipient" });
        await recordError(id, userId, "Missing outbound recipient for pending campaign user");
        await markCampaignError(id, userId, "Missing outbound recipient for pending campaign user").catch(() => ({}));
        continue;
      }
      const pendingIdentityConflict = await getPendingIdentityConflictForBroadcastUser(userId);
      if (pendingIdentityConflict) {
        await reportIdentityReviewSuppression({
          userId,
          recipient,
          campaignId: id,
          campaignCode: campaign.code,
          step: "reprocess_identity_review_gate",
          conflictId: pendingIdentityConflict.conflictId,
          status: pendingIdentityConflict.status,
          source: "reprocess_active_window",
        });
        continue;
      }
      if (!windowSet.has(recipient)) continue;

      attempted += 1;
      await sendWhatsAppText({ to: recipient, text: msg });
      const reprocessSentStored = await redisBestEffort(() => redisSAdd(campaignKeySent(id), userId), 0, {
        campaignId: id,
        campaignCode: campaign.code,
        userId,
        recipient,
        step: "reprocess_mark_sent",
        impact: "post_send_sent_set_persistence",
        severity: "CRITICAL",
      });
      if (!Number(reprocessSentStored || 0)) {
        await reportBroadcastDegraded({
          error: "Reprocess delivery succeeded but sent persistence could not be confirmed",
          errorCode: BROADCAST_ERROR.PERSISTENCE,
          campaignId: id,
          campaignCode: campaign.code,
          userId,
          recipient,
          step: "reprocess_mark_sent",
          impact: "post_send_sent_set_persistence",
          severity: "CRITICAL",
        });
        continue;
      }

      await redisBestEffort(() => redisSRem(campaignKeyPending(id), userId), 0, {
        campaignId: id,
        campaignCode: campaign.code,
        userId,
        recipient,
        step: "reprocess_remove_pending",
        impact: "pending_set_cleanup_failed",
        severity: "HIGH",
      });
      try {
        await markCampaignSent(id, userId, {
          source: "broadcast",
          details: buildCampaignDispatchDetails({
            dispatchSource: "reprocess_active_window",
            recipient,
            channel: recipientInfo?.channel,
            runtimeMeta,
            campaign,
          }),
        });
      } catch (error) {
        await reportBroadcastDegraded({
          error,
          errorCode: BROADCAST_ERROR.PERSISTENCE,
          campaignId: id,
          campaignCode: campaign.code,
          userId,
          recipient,
          step: "reprocess_mark_campaign_sent_core",
          impact: "post_send_campaign_sent_core_failed",
          severity: "CRITICAL",
        });
        continue;
      }
      sent += 1;
    } catch (error) {
      errors += 1;
      await reportBroadcastFailure({ error, errorCode: BROADCAST_ERROR.SEND, campaignId: id, campaignCode: campaign.code, userId, step: "reprocess_send", metricsKind: "whatsapp" });
      await recordError(id, userId, extractErrorMessage(error));
      await markCampaignError(id, userId, error).catch(() => ({}));
    }
  }

  const pendingLeft = await redisBestEffort(() => redisSCard(campaignKeyPending(id)), 0, { campaignId: id, campaignCode: campaign.code, step: "reprocess_pending_left" });
  if (Number(pendingLeft || 0) === 0) {
    await redisBestEffort(() => redisSRem(PENDING_CAMPAIGNS_SET, id), 0, { campaignId: id, campaignCode: campaign.code, step: "reprocess_remove_from_pending_set" });
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

// Este ponto reage à reabertura da janela 24h e ao envio pendente.
// A reentrada do usuário, por si só, NÃO é interpretada aqui como clicked_intent.
// O registro de intenção/clique deve ocorrer no ponto que interpreta a ação real do usuário.
export async function processPendingForWaId(waId) {
  const inboundWaId = safeStr(waId);
  if (!inboundWaId) return { ok: true, processed: 0 };

  const userId = await redisBestEffort(() => getInternalUserIdByWaId(inboundWaId), null, { userId: inboundWaId, recipient: inboundWaId, step: "process_pending_resolve_user" });
  const id = safeStr(userId);
  if (!id) return { ok: true, waId: inboundWaId, processed: 0 };

  const pendingCampaigns = await redisBestEffort(() => redisSMembers(PENDING_CAMPAIGNS_SET), [], { userId: id, recipient: inboundWaId, step: "process_pending_list_set" });
  const list = Array.isArray(pendingCampaigns) ? pendingCampaigns : [];

  let processed = 0;

  for (const cpIdRaw of list) {
    const cpId = safeStr(cpIdRaw);
    if (!cpId) continue;

    try {
      const isPending = await redisBestEffort(() => redisSIsMember(campaignKeyPending(cpId), id), 0, { campaignId: cpId, userId: id, recipient: inboundWaId, step: "process_pending_membership" });
      if (!Number(isPending)) continue;

      const runtimeMeta = await readRuntimeMeta(cpId);
      const campaign = (await getCampaignCore(cpId).catch(() => null))?.campaign || null;
      const msg = buildMessage({ subject: runtimeMeta.subject, text: runtimeMeta.text });

      if (!msg) {
        await redisBestEffort(() => redisSRem(campaignKeyPending(cpId), id), 0, { campaignId: cpId, campaignCode: campaign?.code, userId: id, recipient: inboundWaId, step: "process_pending_remove_invalid_message" });
        await recordError(cpId, id, "Campaign meta missing subject/text (auto-send skipped)");
        await markCampaignError(cpId, id, "Campaign meta missing subject/text (auto-send skipped)").catch(() => ({}));
        processed += 1;
        continue;
      }

      const recipientInfo = await getRecipientForUser(id);
      const recipient = safeStr(recipientInfo?.recipient);
      if (!recipientInfo?.ok || !recipient) {
        await reportBroadcastFailure({ error: recipientInfo?.error || "Missing outbound recipient for pending campaign user", errorCode: recipientInfo?.errorCode || BROADCAST_ERROR.RECIPIENT, campaignId: cpId, campaignCode: campaign?.code, userId: id, recipient: inboundWaId, step: "process_pending_resolve_recipient" });
        await recordError(cpId, id, "Missing outbound recipient for pending campaign user");
        await markCampaignError(cpId, id, "Missing outbound recipient for pending campaign user").catch(() => ({}));
        continue;
      }

      const pendingIdentityConflict = await getPendingIdentityConflictForBroadcastUser(id);
      if (pendingIdentityConflict) {
        await reportIdentityReviewSuppression({
          userId: id,
          recipient,
          campaignId: cpId,
          campaignCode: campaign?.code,
          step: "process_pending_identity_review_gate",
          conflictId: pendingIdentityConflict.conflictId,
          status: pendingIdentityConflict.status,
          source: "pending_after_inbound",
        });
        continue;
      }

      await sendWhatsAppText({ to: recipient, text: msg });
      const pendingSentStored = await redisBestEffort(() => redisSAdd(campaignKeySent(cpId), id), 0, {
        campaignId: cpId,
        campaignCode: campaign?.code,
        userId: id,
        recipient,
        step: "process_pending_mark_sent",
        impact: "post_send_sent_set_persistence",
        severity: "CRITICAL",
      });
      if (!Number(pendingSentStored || 0)) {
        await reportBroadcastDegraded({
          error: "Pending campaign delivered but sent persistence could not be confirmed",
          errorCode: BROADCAST_ERROR.PERSISTENCE,
          campaignId: cpId,
          campaignCode: campaign?.code,
          userId: id,
          recipient,
          step: "process_pending_mark_sent",
          impact: "post_send_sent_set_persistence",
          severity: "CRITICAL",
          extra: { inboundWaId },
        });
        continue;
      }

      await redisBestEffort(() => redisSRem(campaignKeyPending(cpId), id), 0, {
        campaignId: cpId,
        campaignCode: campaign?.code,
        userId: id,
        recipient,
        step: "process_pending_remove_pending",
        impact: "pending_set_cleanup_failed",
        severity: "HIGH",
      });
      try {
        await markCampaignSent(cpId, id, {
          source: "broadcast",
          details: buildCampaignDispatchDetails({
            dispatchSource: "pending_after_inbound",
            recipient,
            channel: recipientInfo?.channel,
            runtimeMeta,
            campaign: campaign || { id: cpId },
            extra: { inboundWaId },
          }),
        });
      } catch (error) {
        await reportBroadcastDegraded({
          error,
          errorCode: BROADCAST_ERROR.PERSISTENCE,
          campaignId: cpId,
          campaignCode: campaign?.code,
          userId: id,
          recipient,
          step: "process_pending_mark_campaign_sent_core",
          impact: "post_send_campaign_sent_core_failed",
          severity: "CRITICAL",
          extra: { inboundWaId },
        });
        continue;
      }
      processed += 1;

      const pendingLeft = await redisBestEffort(() => redisSCard(campaignKeyPending(cpId)), 0, { campaignId: cpId, campaignCode: campaign?.code, userId: id, recipient, step: "process_pending_pending_left" });
      if (Number(pendingLeft || 0) === 0) {
        await redisBestEffort(() => redisSRem(PENDING_CAMPAIGNS_SET, cpId), 0, { campaignId: cpId, campaignCode: campaign?.code, userId: id, recipient, step: "process_pending_remove_from_set" });
      }

      await ensureCampaignTTL(cpId);
    } catch (error) {
      await reportBroadcastFailure({ error, errorCode: BROADCAST_ERROR.SEND, campaignId: cpId, userId: id, recipient: inboundWaId, step: "process_pending_send", metricsKind: "whatsapp" });
      await recordError(cpId, id, extractErrorMessage(error));
      await markCampaignError(cpId, id, error).catch(() => ({}));
    }
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
  const expired = await redisBestEffort(
    () => listExpiredPendingCouponReservations({ now, limit }),
    [],
    { step: "list_expired_coupon_reservations" }
  );
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
        await redisBestEffort(() => resetCheckoutCouponState(userId), null, { userId, step: "reset_checkout_coupon_state_after_timeout" });
      }

      const alreadySent = Boolean(nextReservation?.messageSentAt || nextReservation?.meta?.couponRemovedMessageSent);
      if (alreadySent) {
        skippedMessageCount += 1;
        continue;
      }

      const recipientInfo = userId ? await getRecipientForUser(userId) : null;
      const recipient = safeStr(recipientInfo?.recipient);
      if (!recipientInfo?.ok || !recipient) {
        skippedMessageCount += 1;
        await reportBroadcastFailure({ error: recipientInfo?.error || "Missing outbound recipient for coupon expiration message", errorCode: recipientInfo?.errorCode || BROADCAST_ERROR.RECIPIENT, campaignId: "automation_coupon_expiration", userId: userId || reservationId, step: "coupon_expiration_resolve_recipient" });
        await recordError("automation_coupon_expiration", userId || reservationId, "Missing outbound recipient for coupon expiration message");
        continue;
      }

      const text = await getCouponRemovalMessage(userId, nextReservation);
      if (!safeStr(text)) {
        skippedMessageCount += 1;
        await reportBroadcastFailure({ error: "Coupon expiration message empty", errorCode: BROADCAST_ERROR.COUPON_EXPIRATION, campaignId: "automation_coupon_expiration", userId: userId || reservationId, recipient, step: "coupon_expiration_empty_message" });
        await recordError("automation_coupon_expiration", userId || reservationId, "Coupon expiration message empty");
        continue;
      }

      try {
        await sendWhatsAppText({ to: recipient, text });
        await markCouponRemovedMessageSent(reservationId, {
          meta: { source: "broadcast_automation", timeoutHours: 20 },
        }).catch(() => ({}));
        messageSentCount += 1;
      } catch (error) {
        errors += 1;
        await reportBroadcastFailure({ error, errorCode: BROADCAST_ERROR.SEND, campaignId: "automation_coupon_expiration", userId: userId || reservationId, recipient, step: "coupon_expiration_send", metricsKind: "whatsapp" });
        await recordError("automation_coupon_expiration", userId || reservationId, extractErrorMessage(error));
      }
    } catch (error) {
      errors += 1;
      await reportBroadcastFailure({ error, errorCode: BROADCAST_ERROR.COUPON_EXPIRATION, campaignId: "automation_coupon_expiration", userId: userId || reservationId, step: "coupon_expiration_runtime" });
      await recordError("automation_coupon_expiration", userId || reservationId, extractErrorMessage(error));
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
      await reportBroadcastFailure({
        error: _,
        errorCode: BROADCAST_ERROR.RUNTIME,
        campaignId: safeStr(campaign?.id),
        campaignCode: safeStr(campaign?.code),
        userId: safeStr(userId),
        step: "evaluate_lifecycle_campaign",
      });
    }
  }

  return { status, context, evaluations };
}

async function dispatchLifecycleWinner(userId, evaluation) {
  const campaign = evaluation?.campaign;
  if (!campaign?.id) return { sent: false };

  try {
    const recipientInfo = await getRecipientForUser(userId);
    const recipient = safeStr(recipientInfo?.recipient);
    if (!recipientInfo?.ok || !recipient) {
      await reportBroadcastFailure({ error: recipientInfo?.error || "Missing outbound recipient for lifecycle campaign", errorCode: recipientInfo?.errorCode || BROADCAST_ERROR.RECIPIENT, campaignId: campaign.id, campaignCode: campaign.code, userId, step: "lifecycle_resolve_recipient" });
      await recordError(campaign.id, userId, "Missing outbound recipient for lifecycle campaign");
      await markCampaignError(campaign.id, userId, "Missing outbound recipient for lifecycle campaign").catch(() => ({}));
      return { sent: false };
    }

    const pendingIdentityConflict = await getPendingIdentityConflictForBroadcastUser(userId);
    if (pendingIdentityConflict) {
      await reportIdentityReviewSuppression({
        userId,
        recipient,
        campaignId: campaign.id,
        campaignCode: campaign.code,
        step: "lifecycle_identity_review_gate",
        conflictId: pendingIdentityConflict.conflictId,
        status: pendingIdentityConflict.status,
        source: "lifecycle_automation",
      });
      return { sent: false, suppressed: true };
    }

    const text = await renderCampaignMessage(campaign, userId);
    if (!safeStr(text)) {
      await reportBroadcastFailure({ error: "Lifecycle campaign message empty", errorCode: BROADCAST_ERROR.CAMPAIGN_LOOKUP, campaignId: campaign.id, campaignCode: campaign.code, userId, recipient, step: "lifecycle_render_message" });
      await recordError(campaign.id, userId, "Lifecycle campaign message empty");
      await markCampaignError(campaign.id, userId, "Lifecycle campaign message empty").catch(() => ({}));
      return { sent: false };
    }

    await sendWhatsAppText({ to: recipient, text });
    const lifecycleSentStored = await redisBestEffort(() => redisSAdd(campaignKeySent(campaign.id), userId), 0, {
      campaignId: campaign.id,
      campaignCode: campaign.code,
      userId,
      recipient,
      step: "dispatch_lifecycle_mark_sent",
      impact: "post_send_sent_set_persistence",
      severity: "CRITICAL",
    });
    if (!Number(lifecycleSentStored || 0)) {
      await reportBroadcastDegraded({
        error: "Lifecycle campaign delivered but sent persistence could not be confirmed",
        errorCode: BROADCAST_ERROR.PERSISTENCE,
        campaignId: campaign.id,
        campaignCode: campaign.code,
        userId,
        recipient,
        step: "dispatch_lifecycle_mark_sent",
        impact: "post_send_sent_set_persistence",
        severity: "CRITICAL",
      });
      return { sent: false, degraded: true };
    }

    try {
      await markCampaignSent(campaign.id, userId, {
        source: "broadcast",
        details: buildCampaignDispatchDetails({
          dispatchSource: "lifecycle_automation",
          recipient,
          channel: recipientInfo?.channel,
          campaign,
          extra: {
            evaluationReason: safeStr(evaluation?.primaryReason),
            evaluationAt: safeStr(evaluation?.evaluatedAt),
          },
        }),
      });
    } catch (error) {
      await reportBroadcastDegraded({
        error,
        errorCode: BROADCAST_ERROR.PERSISTENCE,
        campaignId: campaign.id,
        campaignCode: campaign.code,
        userId,
        recipient,
        step: "dispatch_lifecycle_mark_campaign_sent_core",
        impact: "post_send_campaign_sent_core_failed",
        severity: "CRITICAL",
      });
      return { sent: false, degraded: true };
    }
    return { sent: true, campaignId: campaign.id };
  } catch (error) {
    await reportBroadcastFailure({ error, errorCode: BROADCAST_ERROR.SEND, campaignId: campaign.id, campaignCode: campaign.code, userId, step: "dispatch_lifecycle_winner", metricsKind: "whatsapp" });
    await recordError(campaign.id, userId, extractErrorMessage(error));
    await markCampaignError(campaign.id, userId, error).catch(() => ({}));
    return { sent: false };
  }
}

export async function runLifecycleAutomationTick({ limit = 5000, tsMs = nowMs() } = {}) {
  const couponAutomation = await processExpiredCouponReservations({
    now: tsMs,
    limit: COUPON_EXPIRATION_CHECK_LIMIT,
  }).catch(async (error) => {
    await reportBroadcastFailure({ error, errorCode: BROADCAST_ERROR.COUPON_EXPIRATION, campaignId: "automation_coupon_expiration", step: "run_coupon_automation" });
    return {
      ok: false,
      expiredCount: 0,
      messageSentCount: 0,
      skippedMessageCount: 0,
      errors: 1,
      checked: 0,
      error: extractErrorMessage(error),
    };
  });

  const activeWaIds = await redisBestEffort(() => listWindow24hActive(tsMs, Number(limit || 5000)), [], { step: "lifecycle_list_window24h_active" });
  const activeList = Array.isArray(activeWaIds) ? activeWaIds.map((x) => String(x || "").trim()).filter(Boolean) : [];

  const mapped = [];
  const seen = new Set();
  for (const waId of activeList) {
    const userId = safeStr(await getInternalUserIdByWaId(waId).catch(async (error) => {
      await reportBroadcastFailure({ error, errorCode: BROADCAST_ERROR.RECIPIENT, userId: waId, recipient: waId, step: "lifecycle_resolve_internal_user" });
      return null;
    }));
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
    } catch (error) {
      errors += 1;
      await reportBroadcastFailure({ error, errorCode: BROADCAST_ERROR.RUNTIME, campaignId: "automation_lifecycle", userId, step: "run_lifecycle_tick_user" });
      await recordError("automation_lifecycle", userId, extractErrorMessage(error));
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
      await reportBroadcastFailure({ error: err, errorCode: BROADCAST_ERROR.RUNTIME, campaignId: "automation_loop", step: "automation_tick_failed" });
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
