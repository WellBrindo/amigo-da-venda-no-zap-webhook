import {
  redisGet,
  redisSet,
  redisDel,
  redisSAdd,
  redisSRem,
  redisSMembers,
  redisLPush,
  redisLRange,
  redisLTrim,
  redisExpire,
  redisCampaignDefinitionKey,
  redisCampaignIndexAllKey,
  redisCampaignIndexActiveKey,
  redisCampaignIndexCategoryKey,
  redisCampaignIndexCodeKey,
  redisCampaignUserStateKey,
  redisCampaignLogGlobalKey,
  redisCampaignLogUserKey,
  redisCampaignLogCampaignKey,
  redisCampaignCooldownKey,
  redisCampaignConflictGlobalKey,
  redisNextCampaignSequence,
  redisNextCampaignExecutionSequence,
} from "./redis.js";
import {
  trackCampaignReceived,
  trackCampaignClickedIntent,
  trackCampaignConversionAttributed,
  trackCampaignError,
} from "./metrics.js";
import * as audit from "./audit.js";

const CAMPAIGN_TTL_LOG_SECONDS = 180 * 24 * 60 * 60;
const CAMPAIGN_LOG_MAX_ITEMS = 5000;
const CAMPAIGN_USER_LOG_MAX_ITEMS = 500;
const CAMPAIGN_CONFLICT_LOG_MAX_ITEMS = 2000;
const CAMPAIGN_DEFAULT_TIMEZONE = "America/Sao_Paulo";
const CAMPAIGN_ATTRIBUTION_WINDOW_HOURS = 72;

export const CAMPAIGN_ATTRIBUTION_POLICY = Object.freeze({
  MINIMUM_RELIABLE: "minimum_reliable",
});


const CAMPAIGN_ERROR_CODE = Object.freeze({
  PERSISTENCE_ERROR: "CAMPAIGN_PERSISTENCE_ERROR",
  STATE_ERROR: "CAMPAIGN_STATE_ERROR",
  ELIGIBILITY_ERROR: "CAMPAIGN_ELIGIBILITY_ERROR",
  CONFLICT_ERROR: "CAMPAIGN_CONFLICT_ERROR",
  ATTRIBUTION_ERROR: "CAMPAIGN_ATTRIBUTION_ERROR",
  TRACKING_ERROR: "CAMPAIGN_TRACKING_ERROR",
  RUNTIME_ERROR: "CAMPAIGN_RUNTIME_ERROR",
});

export const CAMPAIGN_CATEGORY = Object.freeze({
  CREATION_REENGAGEMENT: "creation_reengagement",
  TRIAL_CONVERSION: "trial_conversion",
  CHECKOUT_RECOVERY: "checkout_recovery",
  PAYMENT_RECOVERY: "payment_recovery",
  HABIT_ACTIVATION: "habit_activation",
  UPSELL: "upsell",
  REACTIVATION: "reactivation",
  GENERIC_NURTURE: "generic_nurture",
  OPERATIONAL: "operational",
});

export const CAMPAIGN_CHANNEL = Object.freeze({
  WHATSAPP_WINDOW24H: "whatsapp_window24h",
  WHATSAPP_TEMPLATE: "whatsapp_template",
});

export const CAMPAIGN_TRIGGER_TYPE = Object.freeze({
  EVENT: "event",
  STATE_IDLE: "state_idle",
  TIME_SINCE_LAST_INBOUND: "time_since_last_inbound",
  TIME_SINCE_LAST_OUTBOUND: "time_since_last_outbound",
  TIME_SINCE_STATE_ENTERED: "time_since_state_entered",
  TIME_SINCE_TRIAL_END: "time_since_trial_end",
  TIME_SINCE_CHECKOUT_STARTED: "time_since_checkout_started",
  TIME_SINCE_PAYMENT_PENDING: "time_since_payment_pending",
  MANUAL: "manual",
});

export const CAMPAIGN_MESSAGE_MODE = Object.freeze({
  COPY_KEY: "copy_key",
  INLINE_TEXT: "inline_text",
});

export const CAMPAIGN_EXECUTION_ACTION = Object.freeze({
  SKIPPED: "skipped",
  BLOCKED: "blocked",
  PENDING: "pending",
  SENT: "sent",
  ERROR: "error",
  CONFLICT_LOST: "conflict_lost",
});

export const CAMPAIGN_BLOCK_REASON = Object.freeze({
  INACTIVE_CAMPAIGN: "inactive_campaign",
  OUT_OF_SCHEDULE: "out_of_schedule",
  STATUS_NOT_ALLOWED: "status_not_allowed",
  STATUS_EXCLUDED: "status_excluded",
  PLAN_NOT_ALLOWED: "plan_not_allowed",
  PLAN_EXCLUDED: "plan_excluded",
  ACTIVE_PLAN_REQUIRED: "active_plan_required",
  NO_ACTIVE_PLAN_REQUIRED: "no_active_plan_required",
  TRIAL_NOT_ENDED: "trial_not_ended",
  PLANS_NOT_VIEWED: "plans_not_viewed",
  PAYMENT_PENDING_REQUIRED: "payment_pending_required",
  CHECKOUT_NOT_STARTED: "checkout_not_started",
  WINDOW24H_REQUIRED: "window24h_required",
  BLOCKED_USER: "blocked_user",
  CHECKOUT_BLOCKED: "checkout_blocked",
  PAYMENT_PENDING_BLOCKED: "payment_pending_blocked",
  BUSINESS_HOURS_ONLY: "business_hours_only",
  BELOW_MIN_THRESHOLD: "below_min_threshold",
  ABOVE_MAX_THRESHOLD: "above_max_threshold",
  COOLDOWN_ACTIVE: "cooldown_active",
  SEND_LIMIT_REACHED: "send_limit_reached",
  DUPLICATE_SEND_ONCE: "duplicate_send_once",
  CONFLICT_LOST: "conflict_lost",
  CHANNEL_NOT_ALLOWED: "channel_not_allowed",
});

export const CAMPAIGN_CONFLICT_GROUP = Object.freeze({
  CREATION_REENGAGEMENT: "creation_reengagement",
  TRIAL_CONVERSION: "trial_conversion",
  CHECKOUT_RECOVERY: "checkout_recovery",
  PAYMENT_RECOVERY: "payment_recovery",
  HABIT_ACTIVATION: "habit_activation",
  UPSELL: "upsell",
  REACTIVATION: "reactivation",
  GENERIC: "generic",
  OPERATIONAL: "operational",
});

const CATEGORY_VALUES = new Set(Object.values(CAMPAIGN_CATEGORY));
const CHANNEL_VALUES = new Set(Object.values(CAMPAIGN_CHANNEL));
const TRIGGER_TYPE_VALUES = new Set(Object.values(CAMPAIGN_TRIGGER_TYPE));
const MESSAGE_MODE_VALUES = new Set(Object.values(CAMPAIGN_MESSAGE_MODE));
const CONFLICT_GROUP_VALUES = new Set(Object.values(CAMPAIGN_CONFLICT_GROUP));

function safeStr(value) {
  return String(value ?? "").trim();
}

function serializeActorLabel(actor) {
  if (typeof actor === "string") return safeStr(actor);
  if (actor && typeof actor === "object") {
    const user = safeStr(actor.user);
    const type = safeStr(actor.type);
    if (type && user) return `${type}:${user}`;
    if (user) return user;
    if (type) return type;
  }
  return safeStr(actor);
}

function toUpper(value) {
  return safeStr(value).toUpperCase();
}

function toLower(value) {
  return safeStr(value).toLowerCase();
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toPositiveInt(value, fallback = 0) {
  return Math.max(0, toInt(value, fallback));
}

function toBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const text = toLower(value);
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return !!fallback;
}

function toNullable(value) {
  const text = safeStr(value);
  return text || null;
}

function ensureArray(value, { normalize = (v) => safeStr(v), dedupe = true } = {}) {
  const base = Array.isArray(value) ? value : value == null ? [] : [value];
  const arr = base.map((item) => normalize(item)).filter(Boolean);
  return dedupe ? Array.from(new Set(arr)) : arr;
}

function tryJsonParse(value, fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}


function createCampaignError(errorCode, message, meta = {}) {
  const err = new Error(safeStr(message) || errorCode || CAMPAIGN_ERROR_CODE.RUNTIME_ERROR);
  err.name = "CampaignRuntimeError";
  err.errorCode = safeStr(errorCode) || CAMPAIGN_ERROR_CODE.RUNTIME_ERROR;
  err.retryable = !!meta.retryable;
  err.meta = meta && typeof meta === "object" ? { ...meta } : {};
  return err;
}

function serializeCampaignError(error, fallbackCode = CAMPAIGN_ERROR_CODE.RUNTIME_ERROR) {
  const code = safeStr(error?.errorCode || error?.code || fallbackCode) || CAMPAIGN_ERROR_CODE.RUNTIME_ERROR;
  const message = safeStr(error?.message || error) || code;
  return {
    errorCode: code,
    message,
    retryable: Boolean(error?.retryable),
    meta: error?.meta && typeof error.meta === "object" ? { ...error.meta } : {},
  };
}

function buildCampaignOperationalLog({ level = "warn", event = "", campaignId = "", campaignCode = "", userId = "", step = "", error = null, meta = {} } = {}) {
  const serialized = error ? serializeCampaignError(error) : null;
  return {
    level: safeStr(level) || "warn",
    source: "campaigns",
    event: safeStr(event),
    campaignId: safeStr(campaignId),
    campaignCode: normalizeCampaignCode(campaignCode || ""),
    userId: safeStr(userId),
    step: safeStr(step),
    errorCode: serialized?.errorCode || "",
    message: serialized?.message || "",
    retryable: serialized?.retryable || false,
    meta: meta && typeof meta === "object" ? { ...meta, ...(serialized?.meta || {}) } : (serialized?.meta || {}),
    ts: nowIso(),
  };
}

function emitCampaignOperationalLog(payload = {}) {
  const entry = buildCampaignOperationalLog(payload);

  void (async () => {
    try {
      if (typeof audit?.logOperationalEvent === "function") {
        await audit.logOperationalEvent({
          module: "campaigns",
          event: entry.event || "campaign_runtime",
          level: entry.level || "warn",
          userId: entry.userId || "",
          campaignId: entry.campaignId || "",
          campaignCode: entry.campaignCode || "",
          step: entry.step || "",
          errorCode: entry.errorCode || "",
          message: entry.message || "",
          status: entry.retryable ? "retryable" : "",
          meta: entry.meta && typeof entry.meta === "object" ? entry.meta : {},
        });
        return;
      }
      if (typeof audit?.logRuntimeError === "function") {
        await audit.logRuntimeError({
          module: "campaigns",
          event: entry.event || "campaign_runtime",
          level: entry.level || "warn",
          userId: entry.userId || "",
          campaignId: entry.campaignId || "",
          campaignCode: entry.campaignCode || "",
          step: entry.step || "",
          errorCode: entry.errorCode || "",
          message: entry.message || "",
          meta: entry.meta && typeof entry.meta === "object" ? entry.meta : {},
        });
        return;
      }
    } catch {
      // fallback below
    }

    try {
      const line = JSON.stringify(entry);
      if (entry.level === "error" || entry.level === "fatal") {
        console.error(line);
        return;
      }
      if (entry.level === "warn") {
        console.warn(line);
        return;
      }
      console.log(line);
    } catch {
      // no-op
    }
  })();
}

async function safeAppendCampaignLog(payload, meta = {}) {
  try {
    await appendCampaignLog(payload);
    return { ok: true };
  } catch (error) {
    await reportCampaignFailure({
      level: "warn",
      event: "campaign_log_write_failed",
      campaignId: payload?.campaignId,
      campaignCode: payload?.campaignCode,
      userId: payload?.userId,
      step: safeStr(meta.step || payload?.reason || payload?.action),
      error: createCampaignError(CAMPAIGN_ERROR_CODE.PERSISTENCE_ERROR, error?.message || error, { operation: "appendCampaignLog" }),
      meta,
    });
    return { ok: false, error: serializeCampaignError(error, CAMPAIGN_ERROR_CODE.PERSISTENCE_ERROR) };
  }
}

async function safeEmitCampaignMetric(metricFn, payload = {}, meta = {}) {
  try {
    return await emitCampaignMetricSafe(metricFn, payload);
  } catch (error) {
    await reportCampaignFailure({
      level: "warn",
      event: "campaign_metric_emit_failed",
      campaignId: payload?.campaignId,
      campaignCode: payload?.campaignCode,
      userId: payload?.userId,
      step: safeStr(meta.step || payload?.step),
      error: createCampaignError(CAMPAIGN_ERROR_CODE.TRACKING_ERROR, error?.message || error, { operation: "emitCampaignMetric" }),
      meta,
    });
    return { ok: false, skipped: true, reason: "metric_emit_failed" };
  }
}

async function emitCampaignErrorMetric(payload = {}, meta = {}) {
  const trackerPayload = {
    userId: safeStr(payload?.userId),
    waId: safeStr(payload?.userId),
    campaignId: safeStr(payload?.campaignId),
    campaignCode: normalizeCampaignCode(payload?.campaignCode || ""),
    source: safeStr(payload?.source) || "campaigns",
    step: safeStr(payload?.step || meta?.step),
    errorCode: safeStr(payload?.errorCode || meta?.errorCode || CAMPAIGN_ERROR_CODE.RUNTIME_ERROR),
    by: safeStr(payload?.reference || meta?.reference),
  };
  return safeEmitCampaignMetric(trackCampaignError, trackerPayload, { step: trackerPayload.step || meta?.step || "campaign_error" });
}

async function reportCampaignFailure({
  event = "campaign_runtime_failure",
  level = "warn",
  campaignId = "",
  campaignCode = "",
  userId = "",
  step = "",
  error = null,
  source = "campaigns",
  meta = {},
  emitMetric = true,
} = {}) {
  const serialized = serializeCampaignError(error, CAMPAIGN_ERROR_CODE.RUNTIME_ERROR);
  emitCampaignOperationalLog({
    level,
    event,
    campaignId,
    campaignCode,
    userId,
    step,
    error,
    meta: {
      source: safeStr(source) || "campaigns",
      ...(meta && typeof meta === "object" ? meta : {}),
    },
  });

  if (emitMetric) {
    await emitCampaignErrorMetric({
      campaignId,
      campaignCode,
      userId,
      source,
      step,
      errorCode: serialized.errorCode,
    }, meta);
  }

  return serialized;
}

function normalizeCampaignCode(value) {
  return toUpper(value).replace(/\s+/g, "_");
}

function normalizeCategory(value) {
  const text = toLower(value);
  return CATEGORY_VALUES.has(text) ? text : CAMPAIGN_CATEGORY.GENERIC_NURTURE;
}

function normalizeChannel(value) {
  const text = toLower(value);
  return CHANNEL_VALUES.has(text) ? text : CAMPAIGN_CHANNEL.WHATSAPP_WINDOW24H;
}

function normalizeTriggerType(value) {
  const text = toLower(value);
  return TRIGGER_TYPE_VALUES.has(text) ? text : CAMPAIGN_TRIGGER_TYPE.MANUAL;
}

function normalizeMessageMode(value, { copyKey, inlineText } = {}) {
  const text = toLower(value);
  if (MESSAGE_MODE_VALUES.has(text)) return text;
  return safeStr(copyKey) ? CAMPAIGN_MESSAGE_MODE.COPY_KEY : safeStr(inlineText) ? CAMPAIGN_MESSAGE_MODE.INLINE_TEXT : CAMPAIGN_MESSAGE_MODE.COPY_KEY;
}

function normalizeConflictGroup(value, category) {
  const text = toLower(value);
  if (CONFLICT_GROUP_VALUES.has(text)) return text;
  return CONFLICT_GROUP_VALUES.has(category) ? category : CAMPAIGN_CONFLICT_GROUP.GENERIC;
}

function normalizePlanCodes(value) {
  return ensureArray(value, { normalize: (item) => normalizeCampaignCode(item) });
}

function normalizeStatuses(value) {
  return ensureArray(value, { normalize: (item) => toUpper(item) });
}

function normalizeDateTime(value) {
  const text = safeStr(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizeTimezone(value) {
  const text = safeStr(value);
  return text || CAMPAIGN_DEFAULT_TIMEZONE;
}

function formatCampaignId(sequence) {
  const seq = String(sequence ?? "").trim();
  if (!seq) throw new Error("Missing campaign sequence");
  return `camp_${seq}`;
}

function formatExecutionId(sequence) {
  const seq = String(sequence ?? "").trim();
  if (!seq) throw new Error("Missing campaign execution sequence");
  return `camp_exec_${seq}`;
}

async function nextCampaignId() {
  const next = await redisNextCampaignSequence();
  return formatCampaignId(next);
}

async function nextExecutionId() {
  const next = await redisNextCampaignExecutionSequence();
  return formatExecutionId(next);
}

function normalizeCampaignDefinition(input = {}, { existing = null, actor = null } = {}) {
  const current = existing && typeof existing === "object" ? existing : null;
  const now = nowIso();

  const code = normalizeCampaignCode(input.code || current?.code || "");
  if (!code) throw new Error("campaign code is required");

  const category = normalizeCategory(input.category || current?.category);
  const channel = normalizeChannel(input.channel || current?.channel);
  const copyKey = safeStr(input.copyKey ?? current?.copyKey);
  const inlineText = safeStr(input.inlineText ?? current?.inlineText);
  const messageMode = normalizeMessageMode(input.messageMode ?? current?.messageMode, { copyKey, inlineText });

  const actorLabel = serializeActorLabel(actor);
  const inputCreatedBy = serializeActorLabel(input.createdBy);
  const inputUpdatedBy = serializeActorLabel(input.updatedBy);

  const campaign = {
    id: safeStr(input.id || current?.id || ""),
    code,
    name: safeStr(input.name || current?.name || code),
    description: safeStr(input.description || current?.description),
    isActive: toBool(input.isActive ?? current?.isActive ?? true, true),
    isArchived: toBool(input.isArchived ?? current?.isArchived ?? false, false),
    category,
    channel,
    messageMode,
    copyKey: messageMode === CAMPAIGN_MESSAGE_MODE.COPY_KEY ? copyKey : "",
    inlineText: messageMode === CAMPAIGN_MESSAGE_MODE.INLINE_TEXT ? inlineText : "",
    priority: toPositiveInt(input.priority ?? current?.priority ?? 100, 100),
    conflictGroup: normalizeConflictGroup(input.conflictGroup ?? current?.conflictGroup, category),
    sendOncePerUser: toBool(input.sendOncePerUser ?? current?.sendOncePerUser ?? false, false),
    maxSendsPerUser: toPositiveInt(input.maxSendsPerUser ?? current?.maxSendsPerUser ?? 0, 0),
    cooldownHours: toPositiveInt(input.cooldownHours ?? current?.cooldownHours ?? 0, 0),
    delayMinutes: toPositiveInt(input.delayMinutes ?? current?.delayMinutes ?? 0, 0),
    triggerType: normalizeTriggerType(input.triggerType ?? current?.triggerType),
    triggerEvent: safeStr(input.triggerEvent ?? current?.triggerEvent),
    requiredStatuses: normalizeStatuses(input.requiredStatuses ?? current?.requiredStatuses),
    excludedStatuses: normalizeStatuses(input.excludedStatuses ?? current?.excludedStatuses),
    requiredPlanCodes: normalizePlanCodes(input.requiredPlanCodes ?? current?.requiredPlanCodes),
    excludedPlanCodes: normalizePlanCodes(input.excludedPlanCodes ?? current?.excludedPlanCodes),
    requiresActivePlan: toBool(input.requiresActivePlan ?? current?.requiresActivePlan ?? false, false),
    requiresNoActivePlan: toBool(input.requiresNoActivePlan ?? current?.requiresNoActivePlan ?? false, false),
    requiresTrialEnded: toBool(input.requiresTrialEnded ?? current?.requiresTrialEnded ?? false, false),
    requiresPlansViewed: toBool(input.requiresPlansViewed ?? current?.requiresPlansViewed ?? false, false),
    requiresPaymentPending: toBool(input.requiresPaymentPending ?? current?.requiresPaymentPending ?? false, false),
    requiresCheckoutStarted: toBool(input.requiresCheckoutStarted ?? current?.requiresCheckoutStarted ?? false, false),
    requiresWindow24hOpen: toBool(input.requiresWindow24hOpen ?? current?.requiresWindow24hOpen ?? false, false),
    minTrialUsed: toPositiveInt(input.minTrialUsed ?? current?.minTrialUsed ?? 0, 0),
    maxTrialUsed: toPositiveInt(input.maxTrialUsed ?? current?.maxTrialUsed ?? 0, 0),
    minAdsCreated: toPositiveInt(input.minAdsCreated ?? current?.minAdsCreated ?? 0, 0),
    maxAdsCreated: toPositiveInt(input.maxAdsCreated ?? current?.maxAdsCreated ?? 0, 0),
    minHoursSinceLastInbound: toPositiveInt(input.minHoursSinceLastInbound ?? current?.minHoursSinceLastInbound ?? 0, 0),
    maxHoursSinceLastInbound: toPositiveInt(input.maxHoursSinceLastInbound ?? current?.maxHoursSinceLastInbound ?? 0, 0),
    minHoursSinceLastOutbound: toPositiveInt(input.minHoursSinceLastOutbound ?? current?.minHoursSinceLastOutbound ?? 0, 0),
    maxHoursSinceLastOutbound: toPositiveInt(input.maxHoursSinceLastOutbound ?? current?.maxHoursSinceLastOutbound ?? 0, 0),
    blockIfInCheckout: toBool(input.blockIfInCheckout ?? current?.blockIfInCheckout ?? false, false),
    blockIfPaymentPending: toBool(input.blockIfPaymentPending ?? current?.blockIfPaymentPending ?? false, false),
    blockIfBlocked: toBool(input.blockIfBlocked ?? current?.blockIfBlocked ?? true, true),
    businessHoursOnly: toBool(input.businessHoursOnly ?? current?.businessHoursOnly ?? false, false),
    timezone: normalizeTimezone(input.timezone ?? current?.timezone),
    startAt: normalizeDateTime(input.startAt ?? current?.startAt),
    endAt: normalizeDateTime(input.endAt ?? current?.endAt),
    notes: safeStr(input.notes ?? current?.notes),
    createdAt: current?.createdAt || now,
    updatedAt: now,
    createdBy: safeStr(current?.createdBy || inputCreatedBy || actorLabel),
    updatedBy: safeStr(actorLabel || inputUpdatedBy || current?.updatedBy),
    version: toPositiveInt((current?.version || 0) + 1, 1),
  };

  if (campaign.messageMode === CAMPAIGN_MESSAGE_MODE.COPY_KEY && !campaign.copyKey) {
    throw new Error("copyKey is required when messageMode=copy_key");
  }
  if (campaign.messageMode === CAMPAIGN_MESSAGE_MODE.INLINE_TEXT && !campaign.inlineText) {
    throw new Error("inlineText is required when messageMode=inline_text");
  }
  if (campaign.requiresActivePlan && campaign.requiresNoActivePlan) {
    throw new Error("campaign cannot require active plan and no active plan at the same time");
  }
  if (campaign.startAt && campaign.endAt && Date.parse(campaign.startAt) > Date.parse(campaign.endAt)) {
    throw new Error("campaign startAt cannot be after endAt");
  }

  return campaign;
}

function normalizeCampaignUserState(input = {}) {
  return {
    campaignId: safeStr(input.campaignId),
    userId: safeStr(input.userId),
    sendCount: toPositiveInt(input.sendCount ?? 0, 0),
    lastSentAt: normalizeDateTime(input.lastSentAt),
    lastSentSource: safeStr(input.lastSentSource),
    lastEvaluatedAt: normalizeDateTime(input.lastEvaluatedAt),
    lastEligibilityResult: safeStr(input.lastEligibilityResult),
    lastBlockReason: safeStr(input.lastBlockReason),
    cooldownUntil: normalizeDateTime(input.cooldownUntil),
    lastMessageId: safeStr(input.lastMessageId),
    lastClickedIntentAt: normalizeDateTime(input.lastClickedIntentAt),
    lastClickedIntentSource: safeStr(input.lastClickedIntentSource),
    lastConversionAttributedAt: normalizeDateTime(input.lastConversionAttributedAt),
    lastAttributedConversionType: safeStr(input.lastAttributedConversionType),
    lastAttributedEventSource: safeStr(input.lastAttributedEventSource),
    lastAttributedReference: safeStr(input.lastAttributedReference),
  };
}

async function writeJson(key, payload) {
  try {
    await redisSet(key, JSON.stringify(payload));
    return payload;
  } catch (error) {
    throw createCampaignError(CAMPAIGN_ERROR_CODE.PERSISTENCE_ERROR, error?.message || error, {
      operation: "writeJson",
      key: safeStr(key),
    });
  }
}

async function readJson(key, fallback = null) {
  let raw = "";
  try {
    raw = await redisGet(key);
  } catch (error) {
    await reportCampaignFailure({
      event: "campaign_read_failed",
      step: "read_json",
      error: createCampaignError(CAMPAIGN_ERROR_CODE.PERSISTENCE_ERROR, error?.message || error, {
        operation: "redisGet",
        key: safeStr(key),
      }),
      meta: { key: safeStr(key) },
    });
    return fallback;
  }

  if (!raw) return fallback;
  const parsed = tryJsonParse(raw, fallback);
  if (parsed === fallback && raw) {
    await reportCampaignFailure({
      event: "campaign_parse_failed",
      step: "read_json",
      error: createCampaignError(CAMPAIGN_ERROR_CODE.STATE_ERROR, "Invalid campaign JSON payload", {
        operation: "json_parse",
        key: safeStr(key),
      }),
      meta: { key: safeStr(key) },
    });
  }
  return parsed;
}

function campaignSortComparator(a, b) {
  const pa = toPositiveInt(a?.priority ?? 0, 0);
  const pb = toPositiveInt(b?.priority ?? 0, 0);
  if (pa !== pb) return pb - pa;
  const ua = safeStr(a?.updatedAt);
  const ub = safeStr(b?.updatedAt);
  if (ua !== ub) return ub.localeCompare(ua);
  return safeStr(a?.id).localeCompare(safeStr(b?.id));
}

async function appendCampaignLog(payload) {
  try {
    const logLine = JSON.stringify(payload);
    await redisLPush(redisCampaignLogGlobalKey(), logLine);
    await redisLTrim(redisCampaignLogGlobalKey(), 0, CAMPAIGN_LOG_MAX_ITEMS - 1);
    await redisExpire(redisCampaignLogGlobalKey(), CAMPAIGN_TTL_LOG_SECONDS);

    if (payload.userId) {
      const userKey = redisCampaignLogUserKey(payload.userId);
      await redisLPush(userKey, logLine);
      await redisLTrim(userKey, 0, CAMPAIGN_USER_LOG_MAX_ITEMS - 1);
      await redisExpire(userKey, CAMPAIGN_TTL_LOG_SECONDS);
    }

    if (payload.campaignId) {
      const campaignKey = redisCampaignLogCampaignKey(payload.campaignId);
      await redisLPush(campaignKey, logLine);
      await redisLTrim(campaignKey, 0, CAMPAIGN_USER_LOG_MAX_ITEMS - 1);
      await redisExpire(campaignKey, CAMPAIGN_TTL_LOG_SECONDS);
    }

    return payload;
  } catch (error) {
    throw createCampaignError(CAMPAIGN_ERROR_CODE.PERSISTENCE_ERROR, error?.message || error, {
      operation: "appendCampaignLog",
      campaignId: safeStr(payload?.campaignId),
      userId: safeStr(payload?.userId),
    });
  }
}

async function appendConflictLog(payload) {
  try {
    const line = JSON.stringify(payload);
    await redisLPush(redisCampaignConflictGlobalKey(), line);
    await redisLTrim(redisCampaignConflictGlobalKey(), 0, CAMPAIGN_CONFLICT_LOG_MAX_ITEMS - 1);
    await redisExpire(redisCampaignConflictGlobalKey(), CAMPAIGN_TTL_LOG_SECONDS);
    return payload;
  } catch (error) {
    throw createCampaignError(CAMPAIGN_ERROR_CODE.PERSISTENCE_ERROR, error?.message || error, {
      operation: "appendConflictLog",
      campaignId: safeStr(payload?.winnerCampaignId),
      userId: safeStr(payload?.userId),
    });
  }
}

function buildCampaignTrackingContext({
  campaign = null,
  campaignId = "",
  campaignCode = "",
  userId = "",
  source = "campaigns",
  step = "",
  conversionType = "",
  reference = "",
} = {}) {
  return {
    userId: safeStr(userId),
    waId: safeStr(userId),
    campaignId: safeStr(campaignId || campaign?.id),
    campaignCode: normalizeCampaignCode(campaignCode || campaign?.code || ""),
    source: safeStr(source) || "campaigns",
    step: safeStr(step),
    type: safeStr(conversionType),
    by: safeStr(reference),
  };
}

async function emitCampaignMetricSafe(metricFn, payload = {}) {
  if (typeof metricFn !== "function") return { ok: false, skipped: true, reason: "metric_fn_missing" };
  try {
    return await metricFn(payload);
  } catch {
    return { ok: false, skipped: true, reason: "metric_emit_failed" };
  }
}

function getAttributionWindowHours(campaign = null) {
  const configured = toPositiveInt(campaign?.attributionWindowHours ?? 0, 0);
  return configured > 0 ? configured : CAMPAIGN_ATTRIBUTION_WINDOW_HOURS;
}

function isWithinAttributionWindow(lastSentAt, campaign = null, nowMsValue = Date.now()) {
  const sentAt = normalizeDateTime(lastSentAt);
  if (!sentAt) return false;
  const sentMs = Date.parse(sentAt);
  if (!Number.isFinite(sentMs)) return false;
  const windowHours = getAttributionWindowHours(campaign);
  return nowMsValue - sentMs <= windowHours * 60 * 60 * 1000;
}

function buildSkipResult(reason, { campaignId = "", userId = "", campaign = null, extra = {} } = {}) {
  return {
    ok: false,
    skipped: true,
    reason: safeStr(reason),
    campaignId: safeStr(campaignId || campaign?.id),
    campaignCode: normalizeCampaignCode(campaign?.code || ""),
    userId: safeStr(userId),
    ...extra,
  };
}

async function getCampaignAttributionContext(campaignId, userId) {
  const now = nowIso();
  const nowMsValue = Date.parse(now);
  try {
    const campaign = (await getCampaign(campaignId))?.campaign || null;
    const stateResult = await getCampaignUserState(campaignId, userId);
    const current = stateResult?.state || normalizeCampaignUserState({ campaignId, userId });

    return {
      campaign,
      current,
      now,
      nowMs: nowMsValue,
      hasSentAt: Boolean(safeStr(current?.lastSentAt)),
      withinAttributionWindow: isWithinAttributionWindow(current?.lastSentAt, campaign, nowMsValue),
      stateError: stateResult?.error || null,
    };
  } catch (error) {
    throw createCampaignError(CAMPAIGN_ERROR_CODE.ATTRIBUTION_ERROR, error?.message || error, {
      operation: "getCampaignAttributionContext",
      campaignId: safeStr(campaignId),
      userId: safeStr(userId),
    });
  }
}

export async function getCampaignAttributableContext(campaignId, userId) {
  const context = await getCampaignAttributionContext(campaignId, userId);
  return {
    ok: true,
    policy: CAMPAIGN_ATTRIBUTION_POLICY.MINIMUM_RELIABLE,
    attributionWindowHours: getAttributionWindowHours(context.campaign),
    campaign: context.campaign,
    state: context.current,
    hasSentAt: context.hasSentAt,
    withinAttributionWindow: context.withinAttributionWindow,
    eligibleForClickedIntent: context.hasSentAt && context.withinAttributionWindow,
    eligibleForConversionAttribution: context.hasSentAt && context.withinAttributionWindow,
  };
}

async function upsertCampaignIndexes(campaign, previous = null) {
  const id = safeStr(campaign?.id);
  if (!id) throw new Error("campaign id is required for index update");

  await redisSAdd(redisCampaignIndexAllKey(), id);
  await redisSet(redisCampaignIndexCodeKey(campaign.code), id);
  await redisSAdd(redisCampaignIndexCategoryKey(campaign.category), id);

  if (campaign.isActive && !campaign.isArchived) {
    await redisSAdd(redisCampaignIndexActiveKey(), id);
  } else {
    await redisSRem(redisCampaignIndexActiveKey(), id);
  }

  if (previous && previous.category && previous.category !== campaign.category) {
    await redisSRem(redisCampaignIndexCategoryKey(previous.category), id);
  }
  if (previous && previous.code && previous.code !== campaign.code) {
    await redisSet(redisCampaignIndexCodeKey(previous.code), "");
  }
}

export async function getCampaign(idOrCode) {
  const raw = safeStr(idOrCode);
  if (!raw) return { campaign: null, error: null };

  try {
    const direct = raw.startsWith("camp_") ? raw : null;
    const byCode = direct ? null : await redisGet(redisCampaignIndexCodeKey(normalizeCampaignCode(raw)));
    const campaignId = safeStr(direct || byCode);
    if (!campaignId) return { campaign: null, error: null };

    const data = await readJson(redisCampaignDefinitionKey(campaignId), null);
    return { campaign: data ? normalizeCampaignDefinition(data, { existing: data }) : null, error: null };
  } catch (error) {
    const serialized = serializeCampaignError(createCampaignError(CAMPAIGN_ERROR_CODE.PERSISTENCE_ERROR, error?.message || error, {
      operation: "getCampaign",
      idOrCode: raw,
    }));
    emitCampaignOperationalLog({ event: "campaign_lookup_failed", campaignCode: raw, step: "get_campaign", error: serialized });
    return { campaign: null, error: serialized };
  }
}

export async function listCampaigns({ includeInactive = true, category = null, limit = 100 } = {}) {
  const key = category
    ? redisCampaignIndexCategoryKey(normalizeCategory(category))
    : includeInactive
      ? redisCampaignIndexAllKey()
      : redisCampaignIndexActiveKey();

  const ids = await redisSMembers(key);
  const uniqueIds = Array.isArray(ids) ? Array.from(new Set(ids.map((item) => safeStr(item)).filter(Boolean))) : [];
  const items = [];

  for (const id of uniqueIds) {
    const data = await readJson(redisCampaignDefinitionKey(id), null);
    if (!data) continue;
    const campaign = normalizeCampaignDefinition(data, { existing: data });
    if (!includeInactive && (!campaign.isActive || campaign.isArchived)) continue;
    items.push(campaign);
  }

  items.sort(campaignSortComparator);
  return {
    campaigns: items.slice(0, Math.max(1, Math.min(1000, Number(limit) || 100))),
    total: items.length,
  };
}

export async function createCampaign(input = {}, { actor = null } = {}) {
  const campaign = normalizeCampaignDefinition(input, { actor });
  const existingByCode = await getCampaign(campaign.code);
  if (existingByCode?.campaign) {
    throw new Error(`campaign code already exists: ${campaign.code}`);
  }

  campaign.id = await nextCampaignId();
  campaign.version = 1;
  await writeJson(redisCampaignDefinitionKey(campaign.id), campaign);
  await upsertCampaignIndexes(campaign, null);

  await appendCampaignLog({
    executionId: await nextExecutionId(),
    campaignId: campaign.id,
    userId: "",
    action: CAMPAIGN_EXECUTION_ACTION.SKIPPED,
    reason: "campaign_created",
    details: { code: campaign.code, actor: serializeActorLabel(actor) },
    evaluatedAt: nowIso(),
  });

  return { campaign };
}

export async function updateCampaign(id, patch = {}, { actor = null } = {}) {
  const current = (await getCampaign(id))?.campaign;
  if (!current) throw new Error("campaign not found");

  const previous = { ...current };
  const campaign = normalizeCampaignDefinition({ ...current, ...patch, id: current.id }, { existing: current, actor });
  campaign.createdAt = current.createdAt;
  campaign.createdBy = current.createdBy;

  await writeJson(redisCampaignDefinitionKey(campaign.id), campaign);
  await upsertCampaignIndexes(campaign, previous);

  await appendCampaignLog({
    executionId: await nextExecutionId(),
    campaignId: campaign.id,
    userId: "",
    action: CAMPAIGN_EXECUTION_ACTION.SKIPPED,
    reason: "campaign_updated",
    details: { actor: serializeActorLabel(actor), previousVersion: previous.version, nextVersion: campaign.version },
    evaluatedAt: nowIso(),
  });

  return { campaign, previous };
}

export async function setCampaignActive(id, isActive, { actor = null } = {}) {
  return updateCampaign(id, { isActive: !!isActive }, { actor });
}

export async function archiveCampaign(id, { actor = null } = {}) {
  return updateCampaign(id, { isArchived: true, isActive: false }, { actor });
}

export async function duplicateCampaign(id, { actor = null, codeSuffix = "COPY" } = {}) {
  const current = (await getCampaign(id))?.campaign;
  if (!current) throw new Error("campaign not found");

  const cloneCode = normalizeCampaignCode(`${current.code}_${safeStr(codeSuffix) || "COPY"}`);
  return createCampaign(
    {
      ...current,
      id: "",
      code: cloneCode,
      name: `${current.name} (Cópia)`,
      isActive: false,
      isArchived: false,
      createdAt: "",
      updatedAt: "",
      createdBy: "",
      updatedBy: "",
      version: 0,
    },
    { actor }
  );
}

export async function deleteCampaign(id, { actor = null } = {}) {
  const current = (await getCampaign(id))?.campaign;
  if (!current) throw new Error("campaign not found");
  if (current.isActive) throw new Error("deactivate campaign before deleting");

  const campaignId = safeStr(current.id);
  const category = normalizeCategory(current.category);
  const code = normalizeCampaignCode(current.code);

  await redisDel(redisCampaignDefinitionKey(campaignId));
  await redisSRem(redisCampaignIndexAllKey(), campaignId);
  await redisSRem(redisCampaignIndexActiveKey(), campaignId);
  await redisSRem(redisCampaignIndexCategoryKey(category), campaignId);
  await redisDel(redisCampaignIndexCodeKey(code));

  await appendCampaignLog({
    executionId: await nextExecutionId(),
    campaignId,
    userId: "",
    action: CAMPAIGN_EXECUTION_ACTION.SKIPPED,
    reason: "campaign_deleted",
    details: {
      actor: serializeActorLabel(actor),
      code: current.code,
      name: current.name,
    },
    evaluatedAt: nowIso(),
  });

  return {
    ok: true,
    deleted: true,
    campaignId,
    code: current.code,
    name: current.name,
  };
}

export async function getCampaignUserState(campaignId, userId) {
  const cid = safeStr(campaignId);
  const uid = safeStr(userId);
  if (!cid || !uid) return { state: normalizeCampaignUserState({ campaignId: cid, userId: uid }), error: null };
  try {
    const raw = await readJson(redisCampaignUserStateKey(cid, uid), null);
    return { state: normalizeCampaignUserState({ campaignId: cid, userId: uid, ...(raw || {}) }), error: null };
  } catch (error) {
    const serialized = serializeCampaignError(createCampaignError(CAMPAIGN_ERROR_CODE.STATE_ERROR, error?.message || error, {
      operation: "getCampaignUserState",
      campaignId: cid,
      userId: uid,
    }));
    emitCampaignOperationalLog({ event: "campaign_user_state_read_failed", campaignId: cid, userId: uid, step: "get_campaign_user_state", error: serialized });
    return { state: normalizeCampaignUserState({ campaignId: cid, userId: uid }), error: serialized };
  }
}

export async function setCampaignUserState(campaignId, userId, patch = {}) {
  const currentResult = await getCampaignUserState(campaignId, userId);
  const current = currentResult?.state;
  const next = normalizeCampaignUserState({ ...current, ...patch, campaignId, userId });
  try {
    await writeJson(redisCampaignUserStateKey(next.campaignId, next.userId), next);
    return { ok: true, state: next, error: null };
  } catch (error) {
    const campaignError = createCampaignError(CAMPAIGN_ERROR_CODE.STATE_ERROR, error?.message || error, {
      operation: "setCampaignUserState",
      campaignId: next.campaignId,
      userId: next.userId,
    });
    await reportCampaignFailure({ event: "campaign_user_state_write_failed", campaignId: next.campaignId, userId: next.userId, step: "set_campaign_user_state", error: campaignError });
    return { ok: false, state: current || normalizeCampaignUserState({ campaignId, userId }), error: serializeCampaignError(campaignError) };
  }
}

function deriveCooldownUntil(nowMsValue, campaign) {
  const hours = toPositiveInt(campaign?.cooldownHours ?? 0, 0);
  if (hours <= 0) return null;
  return new Date(nowMsValue + hours * 60 * 60 * 1000).toISOString();
}

function getTimeDiffHours(nowMsValue, isoValue) {
  const raw = normalizeDateTime(isoValue);
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  return (nowMsValue - ts) / (60 * 60 * 1000);
}

function isWithinBusinessHours(_campaign, _context) {
  return true;
}

function compareThreshold({ value, min = 0, max = 0 }) {
  if (min > 0 && (value == null || value < min)) return CAMPAIGN_BLOCK_REASON.BELOW_MIN_THRESHOLD;
  if (max > 0 && (value == null || value > max)) return CAMPAIGN_BLOCK_REASON.ABOVE_MAX_THRESHOLD;
  return "";
}

export async function evaluateCampaignEligibility(campaignInput, userInput = {}, context = {}) {
  let campaign;
  try {
    campaign = normalizeCampaignDefinition(campaignInput, { existing: campaignInput });
  } catch (error) {
    const campaignError = createCampaignError(CAMPAIGN_ERROR_CODE.ELIGIBILITY_ERROR, error?.message || error, {
      operation: "normalizeCampaignDefinition",
      campaignId: safeStr(campaignInput?.id),
      userId: safeStr(userInput?.userId || context?.userId),
    });
    await reportCampaignFailure({ event: "campaign_eligibility_normalization_failed", campaignId: safeStr(campaignInput?.id), userId: safeStr(userInput?.userId || context?.userId), step: "evaluate_campaign_eligibility", error: campaignError });
    return {
      campaignId: safeStr(campaignInput?.id),
      userId: safeStr(userInput?.userId || context?.userId),
      eligible: false,
      reasons: [CAMPAIGN_ERROR_CODE.ELIGIBILITY_ERROR],
      primaryReason: CAMPAIGN_ERROR_CODE.ELIGIBILITY_ERROR,
      cooldownUntil: null,
      channelAllowed: false,
      conflictGroup: safeStr(campaignInput?.conflictGroup),
      priority: toPositiveInt(campaignInput?.priority ?? 0, 0),
      evaluatedAt: nowIso(),
      campaign: campaignInput || null,
      context: { evaluationFailed: true },
      error: serializeCampaignError(campaignError),
    };
  }

  const nowMsValue = Number(context?.nowMs) || Date.now();
  const userId = safeStr(userInput?.userId || context?.userId);
  const status = toUpper(context?.status || userInput?.status);
  const planCode = normalizeCampaignCode(context?.planCode || userInput?.planCode || "");
  const hasActivePlan = !!planCode;
  const window24hOpen = !!(context?.window24hOpen ?? userInput?.window24hOpen);
  const isBlockedUser = !!(context?.isBlockedUser ?? userInput?.isBlockedUser ?? status === "BLOCKED");
  const isInCheckout = !!(context?.isInCheckout ?? userInput?.isInCheckout);
  const isPaymentPending = !!(context?.isPaymentPending ?? userInput?.isPaymentPending ?? status === "PAYMENT_PENDING");
  const trialEnded = !!(context?.trialEnded ?? userInput?.trialEnded);
  const plansViewed = !!(context?.plansViewed ?? userInput?.plansViewed);
  const checkoutStarted = !!(context?.checkoutStarted ?? userInput?.checkoutStarted);
  const adsCreated = toPositiveInt(context?.adsCreated ?? userInput?.adsCreated ?? 0, 0);
  const trialUsed = toPositiveInt(context?.trialUsed ?? userInput?.trialUsed ?? 0, 0);
  const lastInboundHours = getTimeDiffHours(nowMsValue, context?.lastInboundAt || userInput?.lastInboundAt);
  const lastOutboundHours = getTimeDiffHours(nowMsValue, context?.lastOutboundAt || userInput?.lastOutboundAt);
  const currentStateResult = await getCampaignUserState(campaign.id, userId);
  const currentState = currentStateResult?.state;
  const cooldownUntil = normalizeDateTime(currentState?.cooldownUntil);
  const cooldownActive = cooldownUntil ? Date.parse(cooldownUntil) > nowMsValue : false;

  if (currentStateResult?.error) {
    const blockedEvaluation = {
      campaignId: campaign.id,
      userId,
      eligible: false,
      reasons: [CAMPAIGN_ERROR_CODE.STATE_ERROR],
      primaryReason: CAMPAIGN_ERROR_CODE.STATE_ERROR,
      cooldownUntil: null,
      channelAllowed: !campaign.requiresWindow24hOpen || window24hOpen,
      conflictGroup: campaign.conflictGroup,
      priority: campaign.priority,
      evaluatedAt: new Date(nowMsValue).toISOString(),
      campaign,
      context: {
        status,
        planCode,
        hasActivePlan,
        trialEnded,
        plansViewed,
        checkoutStarted,
        isPaymentPending,
        isInCheckout,
        adsCreated,
        trialUsed,
        lastInboundHours,
        lastOutboundHours,
        window24hOpen,
        stateReadFailed: true,
      },
      error: currentStateResult.error,
    };

    await safeAppendCampaignLog({
      executionId: await nextExecutionId(),
      campaignId: campaign.id,
      userId,
      action: CAMPAIGN_EXECUTION_ACTION.BLOCKED,
      reason: blockedEvaluation.primaryReason,
      details: { reasons: blockedEvaluation.reasons },
      evaluatedAt: blockedEvaluation.evaluatedAt,
    }, { step: "evaluate_campaign_eligibility" });

    await emitCampaignErrorMetric({
      campaignId: campaign.id,
      campaignCode: campaign.code,
      userId,
      source: "campaigns",
      step: "evaluate_campaign_eligibility",
      errorCode: CAMPAIGN_ERROR_CODE.STATE_ERROR,
    }, { stateReadFailed: true });

    return blockedEvaluation;
  }

  const reasons = [];

  if (!campaign.isActive || campaign.isArchived) reasons.push(CAMPAIGN_BLOCK_REASON.INACTIVE_CAMPAIGN);
  if (campaign.startAt && Date.parse(campaign.startAt) > nowMsValue) reasons.push(CAMPAIGN_BLOCK_REASON.OUT_OF_SCHEDULE);
  if (campaign.endAt && Date.parse(campaign.endAt) < nowMsValue) reasons.push(CAMPAIGN_BLOCK_REASON.OUT_OF_SCHEDULE);
  if (campaign.requiredStatuses.length && !campaign.requiredStatuses.includes(status)) reasons.push(CAMPAIGN_BLOCK_REASON.STATUS_NOT_ALLOWED);
  if (campaign.excludedStatuses.length && campaign.excludedStatuses.includes(status)) reasons.push(CAMPAIGN_BLOCK_REASON.STATUS_EXCLUDED);
  if (campaign.requiredPlanCodes.length && !campaign.requiredPlanCodes.includes(planCode)) reasons.push(CAMPAIGN_BLOCK_REASON.PLAN_NOT_ALLOWED);
  if (campaign.excludedPlanCodes.length && campaign.excludedPlanCodes.includes(planCode)) reasons.push(CAMPAIGN_BLOCK_REASON.PLAN_EXCLUDED);
  if (campaign.requiresActivePlan && !hasActivePlan) reasons.push(CAMPAIGN_BLOCK_REASON.ACTIVE_PLAN_REQUIRED);
  if (campaign.requiresNoActivePlan && hasActivePlan) reasons.push(CAMPAIGN_BLOCK_REASON.NO_ACTIVE_PLAN_REQUIRED);
  if (campaign.requiresTrialEnded && !trialEnded) reasons.push(CAMPAIGN_BLOCK_REASON.TRIAL_NOT_ENDED);
  if (campaign.requiresPlansViewed && !plansViewed) reasons.push(CAMPAIGN_BLOCK_REASON.PLANS_NOT_VIEWED);
  if (campaign.requiresPaymentPending && !isPaymentPending) reasons.push(CAMPAIGN_BLOCK_REASON.PAYMENT_PENDING_REQUIRED);
  if (campaign.requiresCheckoutStarted && !checkoutStarted) reasons.push(CAMPAIGN_BLOCK_REASON.CHECKOUT_NOT_STARTED);
  if (campaign.requiresWindow24hOpen && !window24hOpen) reasons.push(CAMPAIGN_BLOCK_REASON.WINDOW24H_REQUIRED);
  if (campaign.blockIfBlocked && isBlockedUser) reasons.push(CAMPAIGN_BLOCK_REASON.BLOCKED_USER);
  if (campaign.blockIfInCheckout && isInCheckout) reasons.push(CAMPAIGN_BLOCK_REASON.CHECKOUT_BLOCKED);
  if (campaign.blockIfPaymentPending && isPaymentPending) reasons.push(CAMPAIGN_BLOCK_REASON.PAYMENT_PENDING_BLOCKED);
  if (campaign.businessHoursOnly && !isWithinBusinessHours(campaign, context)) reasons.push(CAMPAIGN_BLOCK_REASON.BUSINESS_HOURS_ONLY);
  if (cooldownActive) reasons.push(CAMPAIGN_BLOCK_REASON.COOLDOWN_ACTIVE);
  if (campaign.sendOncePerUser && currentState?.sendCount > 0) reasons.push(CAMPAIGN_BLOCK_REASON.DUPLICATE_SEND_ONCE);
  if (campaign.maxSendsPerUser > 0 && currentState?.sendCount >= campaign.maxSendsPerUser) reasons.push(CAMPAIGN_BLOCK_REASON.SEND_LIMIT_REACHED);

  const thresholds = [
    compareThreshold({ value: trialUsed, min: campaign.minTrialUsed, max: campaign.maxTrialUsed }),
    compareThreshold({ value: adsCreated, min: campaign.minAdsCreated, max: campaign.maxAdsCreated }),
    compareThreshold({ value: lastInboundHours, min: campaign.minHoursSinceLastInbound, max: campaign.maxHoursSinceLastInbound }),
    compareThreshold({ value: lastOutboundHours, min: campaign.minHoursSinceLastOutbound, max: campaign.maxHoursSinceLastOutbound }),
  ].filter(Boolean);

  reasons.push(...thresholds);

  const eligible = reasons.length === 0;
  const evaluation = {
    campaignId: campaign.id,
    userId,
    eligible,
    reasons,
    primaryReason: reasons[0] || "",
    cooldownUntil,
    channelAllowed: !campaign.requiresWindow24hOpen || window24hOpen,
    conflictGroup: campaign.conflictGroup,
    priority: campaign.priority,
    evaluatedAt: new Date(nowMsValue).toISOString(),
    campaign,
    context: {
      status,
      planCode,
      hasActivePlan,
      trialEnded,
      plansViewed,
      checkoutStarted,
      isPaymentPending,
      isInCheckout,
      adsCreated,
      trialUsed,
      lastInboundHours,
      lastOutboundHours,
      window24hOpen,
    },
    error: null,
  };

  const stateWriteResult = await setCampaignUserState(campaign.id, userId, {
    lastEvaluatedAt: evaluation.evaluatedAt,
    lastEligibilityResult: eligible ? "eligible" : "blocked",
    lastBlockReason: evaluation.primaryReason,
  });

  if (!stateWriteResult?.ok) {
    evaluation.eligible = false;
    evaluation.reasons = [CAMPAIGN_ERROR_CODE.STATE_ERROR];
    evaluation.primaryReason = CAMPAIGN_ERROR_CODE.STATE_ERROR;
    evaluation.error = stateWriteResult?.error || serializeCampaignError(createCampaignError(CAMPAIGN_ERROR_CODE.STATE_ERROR, "Failed to persist campaign evaluation state"));
  }

  await safeAppendCampaignLog({
    executionId: await nextExecutionId(),
    campaignId: campaign.id,
    userId,
    action: evaluation.eligible ? CAMPAIGN_EXECUTION_ACTION.SKIPPED : CAMPAIGN_EXECUTION_ACTION.BLOCKED,
    reason: evaluation.primaryReason || (evaluation.eligible ? "eligible" : "blocked"),
    details: { reasons: evaluation.reasons },
    evaluatedAt: evaluation.evaluatedAt,
  }, { step: "evaluate_campaign_eligibility" });

  return evaluation;
}

export function resolveCampaignConflict(evaluations = []) {
  try {
    const eligible = (Array.isArray(evaluations) ? evaluations : []).filter((item) => item?.eligible && item?.campaign);
    const ordered = eligible.slice().sort((a, b) => campaignSortComparator(a?.campaign, b?.campaign));
    const winner = ordered[0] || null;
    const losers = winner
      ? ordered.slice(1).map((item) => ({
          campaignId: item.campaignId,
          userId: item.userId,
          reason: CAMPAIGN_BLOCK_REASON.CONFLICT_LOST,
          priority: item.priority,
        }))
      : [];

    return { winner, losers, ok: true };
  } catch (error) {
    emitCampaignOperationalLog({
      event: "campaign_conflict_resolution_failed",
      step: "resolve_campaign_conflict",
      error: createCampaignError(CAMPAIGN_ERROR_CODE.CONFLICT_ERROR, error?.message || error, { operation: "resolveCampaignConflict" }),
    });
    return { winner: null, losers: [], ok: false, error: serializeCampaignError(error, CAMPAIGN_ERROR_CODE.CONFLICT_ERROR) };
  }
}

export async function logCampaignConflict({ userId, evaluations = [], winner = null } = {}) {
  const payload = {
    executionId: await nextExecutionId(),
    userId: safeStr(userId),
    evaluatedAt: nowIso(),
    winnerCampaignId: safeStr(winner?.campaignId),
    candidateCampaignIds: (Array.isArray(evaluations) ? evaluations : []).map((item) => safeStr(item?.campaignId)).filter(Boolean),
    blockedCampaignIds: (Array.isArray(evaluations) ? evaluations : [])
      .map((item) => (winner && item?.campaignId !== winner.campaignId ? safeStr(item?.campaignId) : ""))
      .filter(Boolean),
  };
  try {
    await appendConflictLog(payload);
    return { ok: true, payload };
  } catch (error) {
    const campaignError = createCampaignError(CAMPAIGN_ERROR_CODE.CONFLICT_ERROR, error?.message || error, {
      operation: "logCampaignConflict",
      userId: safeStr(userId),
    });
    emitCampaignOperationalLog({ event: "campaign_conflict_log_failed", userId, step: "log_campaign_conflict", error: campaignError });
    return { ok: false, payload, error: serializeCampaignError(campaignError) };
  }
}

export async function markCampaignSent(campaignId, userId, { messageId = "", details = null, source = "campaigns" } = {}) {
  try {
    const current = (await getCampaignUserState(campaignId, userId))?.state;
    const campaignResult = await getCampaign(campaignId);
    const campaign = campaignResult?.campaign || {};
    const now = nowIso();
    const cooldownUntil = deriveCooldownUntil(Date.now(), campaign);

    const next = await setCampaignUserState(campaignId, userId, {
      sendCount: toPositiveInt(current?.sendCount ?? 0, 0) + 1,
      lastSentAt: now,
      lastSentSource: safeStr(source) || "campaigns",
      cooldownUntil,
      lastMessageId: safeStr(messageId),
      lastEligibilityResult: "sent",
      lastBlockReason: "",
    });

    if (!next?.ok) {
      return {
        ok: false,
        campaignId: safeStr(campaignId),
        userId: safeStr(userId),
        error: next?.error || serializeCampaignError(createCampaignError(CAMPAIGN_ERROR_CODE.STATE_ERROR, "Failed to persist campaign sent state")),
      };
    }

    const logResult = await safeAppendCampaignLog({
      executionId: await nextExecutionId(),
      campaignId: safeStr(campaignId),
      userId: safeStr(userId),
      action: CAMPAIGN_EXECUTION_ACTION.SENT,
      reason: "sent",
      details: details || {},
      evaluatedAt: now,
      cooldownUntil,
    }, { step: "mark_campaign_sent" });

    await safeEmitCampaignMetric(trackCampaignReceived, buildCampaignTrackingContext({
      campaign,
      campaignId,
      userId,
      source,
      step: "campaign_sent",
    }), { step: "mark_campaign_sent" });

    return { ok: true, state: next?.state || next, logged: !!logResult?.ok, campaign };
  } catch (error) {
    const campaignError = createCampaignError(CAMPAIGN_ERROR_CODE.TRACKING_ERROR, error?.message || error, {
      operation: "markCampaignSent",
      campaignId: safeStr(campaignId),
      userId: safeStr(userId),
    });
    await reportCampaignFailure({ event: "campaign_mark_sent_failed", campaignId, userId, step: "mark_campaign_sent", error: campaignError });
    return { ok: false, campaignId: safeStr(campaignId), userId: safeStr(userId), error: serializeCampaignError(campaignError) };
  }
}

export async function markCampaignError(campaignId, userId, error) {
  try {
    const message = safeStr(error?.message || error);
    const payload = {
      executionId: await nextExecutionId(),
      campaignId: safeStr(campaignId),
      userId: safeStr(userId),
      action: CAMPAIGN_EXECUTION_ACTION.ERROR,
      reason: "error",
      details: { message, errorCode: safeStr(error?.errorCode || error?.code) },
      evaluatedAt: nowIso(),
    };
    const logResult = await safeAppendCampaignLog(payload, { step: "mark_campaign_error" });
    await emitCampaignErrorMetric({
      campaignId,
      userId,
      source: "campaigns",
      step: "mark_campaign_error",
      errorCode: safeStr(error?.errorCode || error?.code || CAMPAIGN_ERROR_CODE.TRACKING_ERROR),
    }, { message });
    return { ok: true, payload, logged: !!logResult?.ok };
  } catch (caught) {
    const campaignError = createCampaignError(CAMPAIGN_ERROR_CODE.TRACKING_ERROR, caught?.message || caught, {
      operation: "markCampaignError",
      campaignId: safeStr(campaignId),
      userId: safeStr(userId),
    });
    await reportCampaignFailure({ event: "campaign_mark_error_failed", campaignId, userId, step: "mark_campaign_error", error: campaignError });
    return { ok: false, campaignId: safeStr(campaignId), userId: safeStr(userId), error: serializeCampaignError(campaignError) };
  }
}

export async function markCampaignClickedIntent(campaignId, userId, { details = null, source = "campaigns", reference = "" } = {}) {
  try {
    const context = await getCampaignAttributionContext(campaignId, userId);
    const { campaign, now, hasSentAt, withinAttributionWindow } = context;

    if (!hasSentAt) {
      return buildSkipResult("campaign_not_sent_for_user", {
        campaignId,
        userId,
        campaign,
      });
    }

    if (!withinAttributionWindow) {
      return buildSkipResult("campaign_outside_attribution_window", {
        campaignId,
        userId,
        campaign,
        extra: { attributionWindowHours: getAttributionWindowHours(campaign) },
      });
    }

    const next = await setCampaignUserState(campaignId, userId, {
      lastClickedIntentAt: now,
      lastClickedIntentSource: safeStr(source) || "campaigns",
    });

    if (!next?.ok) {
      return { ok: false, campaignId: safeStr(campaignId), userId: safeStr(userId), error: next?.error || serializeCampaignError(createCampaignError(CAMPAIGN_ERROR_CODE.ATTRIBUTION_ERROR, "Failed to persist clicked intent state")) };
    }

    await safeAppendCampaignLog({
      executionId: await nextExecutionId(),
      campaignId: safeStr(campaignId),
      userId: safeStr(userId),
      action: CAMPAIGN_EXECUTION_ACTION.SKIPPED,
      reason: "campaign_clicked_intent",
      details: {
        reference: safeStr(reference),
        ...(details && typeof details === "object" ? details : {}),
      },
      evaluatedAt: now,
    }, { step: "mark_campaign_clicked_intent" });

    await safeEmitCampaignMetric(trackCampaignClickedIntent, buildCampaignTrackingContext({
      campaign,
      campaignId,
      userId,
      source,
      step: "clicked_intent_registered",
      reference,
    }), { step: "mark_campaign_clicked_intent" });

    return {
      ok: true,
      state: next?.state || next,
      campaign,
      policy: CAMPAIGN_ATTRIBUTION_POLICY.MINIMUM_RELIABLE,
      attributionWindowHours: getAttributionWindowHours(campaign),
    };
  } catch (error) {
    const campaignError = createCampaignError(CAMPAIGN_ERROR_CODE.ATTRIBUTION_ERROR, error?.message || error, {
      operation: "markCampaignClickedIntent",
      campaignId: safeStr(campaignId),
      userId: safeStr(userId),
    });
    await reportCampaignFailure({ event: "campaign_clicked_intent_failed", campaignId, userId, step: "mark_campaign_clicked_intent", error: campaignError });
    return { ok: false, campaignId: safeStr(campaignId), userId: safeStr(userId), error: serializeCampaignError(campaignError) };
  }
}

export async function attributeCampaignConversion(campaignId, userId, {
  conversionType = "",
  details = null,
  source = "campaigns",
  eventSource = "",
  reference = "",
} = {}) {
  try {
    const context = await getCampaignAttributionContext(campaignId, userId);
    const { campaign, now, hasSentAt, withinAttributionWindow } = context;
    const normalizedConversionType = safeStr(conversionType);

    if (!hasSentAt) {
      return buildSkipResult("campaign_not_sent_for_user", {
        campaignId,
        userId,
        campaign,
      });
    }

    if (!withinAttributionWindow) {
      return buildSkipResult("campaign_outside_attribution_window", {
        campaignId,
        userId,
        campaign,
        extra: { attributionWindowHours: getAttributionWindowHours(campaign) },
      });
    }

    if (!normalizedConversionType) {
      return buildSkipResult("conversion_type_required", {
        campaignId,
        userId,
        campaign,
      });
    }

    const next = await setCampaignUserState(campaignId, userId, {
      lastConversionAttributedAt: now,
      lastAttributedConversionType: normalizedConversionType,
      lastAttributedEventSource: safeStr(eventSource || source),
      lastAttributedReference: safeStr(reference),
    });

    if (!next?.ok) {
      return { ok: false, campaignId: safeStr(campaignId), userId: safeStr(userId), error: next?.error || serializeCampaignError(createCampaignError(CAMPAIGN_ERROR_CODE.ATTRIBUTION_ERROR, "Failed to persist conversion attribution state")) };
    }

    await safeAppendCampaignLog({
      executionId: await nextExecutionId(),
      campaignId: safeStr(campaignId),
      userId: safeStr(userId),
      action: CAMPAIGN_EXECUTION_ACTION.SKIPPED,
      reason: "campaign_conversion_attributed",
      details: {
        conversionType: normalizedConversionType,
        eventSource: safeStr(eventSource || source),
        reference: safeStr(reference),
        ...(details && typeof details === "object" ? details : {}),
      },
      evaluatedAt: now,
    }, { step: "attribute_campaign_conversion" });

    await safeEmitCampaignMetric(trackCampaignConversionAttributed, buildCampaignTrackingContext({
      campaign,
      campaignId,
      userId,
      source,
      step: "conversion_attributed",
      conversionType: normalizedConversionType,
      reference: safeStr(reference) || safeStr(eventSource || source),
    }), { step: "attribute_campaign_conversion" });

    return {
      ok: true,
      state: next?.state || next,
      campaign,
      policy: CAMPAIGN_ATTRIBUTION_POLICY.MINIMUM_RELIABLE,
      attributionWindowHours: getAttributionWindowHours(campaign),
    };
  } catch (error) {
    const campaignError = createCampaignError(CAMPAIGN_ERROR_CODE.ATTRIBUTION_ERROR, error?.message || error, {
      operation: "attributeCampaignConversion",
      campaignId: safeStr(campaignId),
      userId: safeStr(userId),
    });
    await reportCampaignFailure({ event: "campaign_conversion_attribution_failed", campaignId, userId, step: "attribute_campaign_conversion", error: campaignError });
    return { ok: false, campaignId: safeStr(campaignId), userId: safeStr(userId), error: serializeCampaignError(campaignError) };
  }
}

export async function listCampaignLogs({ campaignId = "", userId = "", limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
  const key = campaignId
    ? redisCampaignLogCampaignKey(safeStr(campaignId))
    : userId
      ? redisCampaignLogUserKey(safeStr(userId))
      : redisCampaignLogGlobalKey();
  const rows = await redisLRange(key, 0, safeLimit - 1);
  return {
    items: (Array.isArray(rows) ? rows : []).map((row) => tryJsonParse(row, null)).filter(Boolean),
  };
}

export async function simulateCampaignsForUser(userInput = {}, context = {}, { includeInactive = false } = {}) {
  const userId = safeStr(userInput?.userId || context?.userId);
  const data = await listCampaigns({ includeInactive, limit: 1000 });
  const campaigns = Array.isArray(data?.campaigns) ? data.campaigns : [];
  const evaluations = [];

  for (const campaign of campaigns) {
    const result = await evaluateCampaignEligibility(campaign, { userId, ...userInput }, { userId, ...context });
    evaluations.push(result);
  }

  const { winner, losers } = resolveCampaignConflict(evaluations);
  return {
    userId,
    evaluations,
    winner,
    losers,
  };
}

export async function processPendingCampaignsForUser(waId) {
  const { processPendingForWaId } = await import("./broadcast.js");
  return processPendingForWaId(waId);
}

export async function createCampaignAndDispatch({
  subject,
  text,
  planCodes = [],
  messageType = "TEXT",
  template = null,
} = {}) {
  const { createCampaignAndDispatch: legacyDispatch } = await import("./broadcast.js");
  void messageType;
  void template;
  return legacyDispatch({
    subject,
    text,
    planTargets: Array.isArray(planCodes) ? planCodes : [],
    mode: "TEXT",
  });
}

export async function listCampaignIds({ limit = 50 } = {}) {
  const data = await listCampaigns({ includeInactive: true, limit });
  const arr = Array.isArray(data?.campaigns) ? data.campaigns : [];
  return arr.map((c) => String(c?.id || "")).filter(Boolean);
}

export async function getCampaignDetails(id) {
  const data = await getCampaign(String(id || "").trim());
  return data?.campaign || null;
}
