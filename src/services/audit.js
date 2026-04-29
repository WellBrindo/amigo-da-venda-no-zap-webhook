// src/services/audit.js
import {
  redisLPush,
  redisLRange,
  redisLLen,
  redisLTrim,
  redisExpire,
  redisCouponAuditListKey,
  redisCouponUserAuditListKey,
} from "./redis.js";

const ADMIN_AUDIT_KEY = "audit:admin";
const ADMIN_AUDIT_MAX_ITEMS = 2000;
const ADMIN_AUDIT_TTL_SECONDS = 180 * 24 * 60 * 60;


const ADMIN_AUTH_AUDIT_ACTIONS = Object.freeze([
  "ADMIN_AUTH_MISSING_HEADER",
  "ADMIN_AUTH_INVALID_CREDENTIALS",
  "ADMIN_AUTH_BLOCKED",
  "ADMIN_AUTH_SUCCESS",
  "ADMIN_AUTH_RUNTIME_ERROR",
]);

function normalizeAdminAuthAction(value) {
  const action = safeStr(value).toUpperCase();
  return ADMIN_AUTH_AUDIT_ACTIONS.includes(action) ? action : "ADMIN_AUTH_RUNTIME_ERROR";
}


const IDENTITY_CONFLICT_AUDIT_ACTIONS = Object.freeze([
  "IDENTITY_CONFLICT_DETECTED",
  "IDENTITY_CONFLICT_REOPENED",
  "IDENTITY_CONFLICT_REVIEWED",
  "IDENTITY_CONFLICT_RESOLVED",
  "IDENTITY_CONFLICT_DISMISSED",
  "IDENTITY_CONFLICT_ARCHIVED",
  "IDENTITY_CONFLICT_SENSITIVE_OP_BLOCKED",
  "IDENTITY_CONFLICT_MERGED",
  "IDENTITY_CONFLICT_ALIASES_REASSIGNED",
  "IDENTITY_CONFLICT_USERS_SEPARATED",
  "IDENTITY_CONFLICT_USER_BLOCKED",
]);

function normalizeIdentityConflictAction(value) {
  const action = safeStr(value).toUpperCase();
  return IDENTITY_CONFLICT_AUDIT_ACTIONS.includes(action)
    ? action
    : "IDENTITY_CONFLICT_DETECTED";
}

const COUPON_AUDIT_MAX_ITEMS = 2000;
const COUPON_AUDIT_TTL_SECONDS = 180 * 24 * 60 * 60;


const CAMPAIGN_AUDIT_GLOBAL_KEY = "audit:campaign:global";
const CAMPAIGN_AUDIT_BY_CAMPAIGN_PREFIX = "audit:campaign:campaign";
const CAMPAIGN_AUDIT_MAX_ITEMS = 2000;
const CAMPAIGN_AUDIT_TTL_SECONDS = 180 * 24 * 60 * 60;

const RUNTIME_AUDIT_KEY = "audit:runtime";
const RUNTIME_AUDIT_BY_MODULE_PREFIX = "audit:runtime:module";
const RUNTIME_AUDIT_MAX_ITEMS = 3000;
const RUNTIME_AUDIT_TTL_SECONDS = 30 * 24 * 60 * 60;
const RUNTIME_LOG_LEVELS = Object.freeze(["debug", "info", "warn", "error", "fatal"]);

const REDIS_RUNTIME_EVENTS = Object.freeze([
  "REDIS_DEGRADED",
  "REDIS_DOWN",
  "REDIS_RECOVERED",
  "REDIS_CRITICAL_WRITE_BLOCKED",
  "REDIS_FALLBACK_READ_USED",
  "REDIS_ALERT_DISPATCHED",
  "REDIS_ALERT_RESOLVED",
]);

function normalizeRedisRuntimeEvent(value) {
  const action = safeStr(value).toUpperCase();
  return REDIS_RUNTIME_EVENTS.includes(action) ? action : "";
}

function normalizeCampaignCode(value) {
  const text = safeStr(value).toUpperCase();
  return text || "";
}

function campaignAuditListKey(campaignId) {
  const id = safeStr(campaignId);
  if (!id) throw new Error("campaignAuditListKey: campaignId is required");
  return `${CAMPAIGN_AUDIT_BY_CAMPAIGN_PREFIX}:${id}`;
}


function runtimeAuditListKey(moduleName) {
  const moduleId = normalizeMetricSlug(moduleName) || "runtime";
  return `${RUNTIME_AUDIT_BY_MODULE_PREFIX}:${moduleId}`;
}

function safeStr(value) {
  return String(value ?? "").trim();
}

function toInt(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function makeEventId() {
  return `audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const AUDIT_MAX_STRING_LENGTH = 1200;
const AUDIT_MAX_ARRAY_ITEMS = 80;
const AUDIT_MAX_OBJECT_KEYS = 120;
const AUDIT_MAX_DEPTH = 6;
const SENSITIVE_KEY_RE = /(?:authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|passwd|senha|pin|bearer|credential|private[_-]?key)/i;
const DOCUMENT_KEY_RE = /(?:cpf|cnpj|document|documento|docDigits|docNumber|taxId)/i;

function limitAuditString(value, max = AUDIT_MAX_STRING_LENGTH) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated:${text.length - max}]`;
}

function sanitizeDocumentValue(value) {
  const digits = String(value ?? "").replace(/\D+/g, "");
  if (!digits) return "";
  return `***${digits.slice(-4)}`;
}

function sanitizeAuditValue(value, { depth = 0, key = "" } = {}) {
  const normalizedKey = safeStr(key);

  if (SENSITIVE_KEY_RE.test(normalizedKey)) return "[redacted]";

  if (DOCUMENT_KEY_RE.test(normalizedKey) && !/docType|docLast4/i.test(normalizedKey)) {
    return sanitizeDocumentValue(value);
  }

  if (value === null || value === undefined) return value;

  if (typeof value === "string") return limitAuditString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "";

  if (Array.isArray(value)) {
    if (depth >= AUDIT_MAX_DEPTH) return `[array:${value.length}]`;
    return value.slice(0, AUDIT_MAX_ARRAY_ITEMS).map((item, index) => sanitizeAuditValue(item, { depth: depth + 1, key: `${normalizedKey}.${index}` }));
  }

  if (typeof value === "object") {
    if (depth >= AUDIT_MAX_DEPTH) return "[object]";
    const out = {};
    const entries = Object.entries(value).slice(0, AUDIT_MAX_OBJECT_KEYS);
    for (const [childKey, childValue] of entries) {
      if (SENSITIVE_KEY_RE.test(childKey)) {
        out[childKey] = "[redacted]";
        continue;
      }

      if (childKey === "doc" && childValue && typeof childValue === "object" && !Array.isArray(childValue)) {
        out.doc = {
          docType: safeStr(childValue.docType).toUpperCase(),
          docLast4: safeStr(childValue.docLast4).replace(/\D+/g, "").slice(-4),
        };
        continue;
      }

      if (DOCUMENT_KEY_RE.test(childKey) && !/docType|docLast4/i.test(childKey)) {
        out[childKey] = sanitizeDocumentValue(childValue);
        continue;
      }

      out[childKey] = sanitizeAuditValue(childValue, { depth: depth + 1, key: childKey });
    }
    if (Object.keys(value).length > AUDIT_MAX_OBJECT_KEYS) {
      out.__truncatedKeys = Object.keys(value).length - AUDIT_MAX_OBJECT_KEYS;
    }
    return out;
  }

  return safeStr(value);
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sanitized = sanitizeAuditValue(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized) ? sanitized : {};
}

function normalizeStringArray(value) {
  const arr = Array.isArray(value) ? value : [];
  return Array.from(new Set(arr.map((item) => safeStr(item)).filter(Boolean))).slice(0, 200);
}

function normalizeCouponCode(value) {
  const text = safeStr(value).toUpperCase();
  return text || "";
}

function normalizeBillingCycle(value) {
  const text = safeStr(value).toLowerCase();
  return text || "";
}


function normalizeMetricSlug(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeRuntimeLevel(value) {
  const level = normalizeMetricSlug(value);
  return RUNTIME_LOG_LEVELS.includes(level) ? level : "info";
}

function normalizeRuntimeEvent(input = {}) {
  const moduleName = safeStr(input.module || input.source || "runtime");
  const normalizedRedisEvent = normalizeRedisRuntimeEvent(input.event || input.action);
  return {
    id: safeStr(input.id) || makeEventId(),
    ts: safeStr(input.ts) || new Date().toISOString(),
    module: moduleName,
    event: safeStr(normalizedRedisEvent || input.event || input.action || "runtime_event"),
    level: normalizeRuntimeLevel(input.level || (input.errorCode ? "error" : "info")),
    userId: safeStr(input.userId || input.internalUserId),
    internalUserId: safeStr(input.internalUserId || input.userId),
    waId: safeStr(input.waId),
    campaignId: safeStr(input.campaignId),
    campaignCode: normalizeCampaignCode(input.campaignCode),
    paymentId: safeStr(input.paymentId),
    subscriptionId: safeStr(input.subscriptionId),
    step: safeStr(input.step),
    status: safeStr(input.status),
    message: safeStr(input.message || input.summary),
    errorCode: safeStr(input.errorCode).toUpperCase(),
    meta: normalizeObject(input.meta),
  };
}

function normalizeEvent(input = {}) {
  return {
    id: safeStr(input.id) || makeEventId(),
    ts: safeStr(input.ts) || new Date().toISOString(),
    module: safeStr(input.module).toUpperCase(),
    action: safeStr(input.action).toUpperCase(),
    waId: safeStr(input.waId),
    internalUserId: safeStr(input.internalUserId),
    couponCode: normalizeCouponCode(input.couponCode),
    reservationId: safeStr(input.reservationId),
    planCode: safeStr(input.planCode).toUpperCase(),
    billingCycle: normalizeBillingCycle(input.billingCycle),
    paymentId: safeStr(input.paymentId),
    subscriptionId: safeStr(input.subscriptionId),
    targetId: safeStr(input.targetId),
    targetLabel: safeStr(input.targetLabel),
    summary: safeStr(input.summary),
    actor: normalizeObject(input.actor),
    meta: normalizeObject(input.meta),
    before: normalizeObject(input.before),
    after: normalizeObject(input.after),
    changedFields: normalizeStringArray(input.changedFields || input.meta?.changedFields),
    rejectedFields: normalizeStringArray(input.rejectedFields || input.meta?.rejectedFields),
  };
}

async function pushAuditEvent(key, event, { maxItems, ttlSeconds } = {}) {
  await redisLPush(key, JSON.stringify(event));
  await Promise.allSettled([
    redisLTrim(key, 0, Math.max(1, toInt(maxItems, 1000)) - 1),
    redisExpire(key, Math.max(1, toInt(ttlSeconds, 86400))),
  ]);
  return event;
}

function parseAuditItems(raw) {
  const items = Array.isArray(raw) ? raw : [];
  return items.map((entry) => {
    try {
      return normalizeEvent(JSON.parse(String(entry)));
    } catch (_) {
      return normalizeEvent({
        action: "RAW_EVENT",
        module: "AUDIT",
        summary: safeStr(entry),
      });
    }
  });
}


export async function logAdminAuthAudit(input = {}) {
  const actor = normalizeObject(input.actor);
  const meta = normalizeObject(input.meta);

  const event = normalizeEvent({
    module: safeStr(input.module) || "ADMIN_AUTH",
    action: normalizeAdminAuthAction(input.action || input.event),
    waId: safeStr(input.waId),
    internalUserId: safeStr(input.internalUserId),
    targetId: safeStr(input.targetId || input.username || actor.user || input.ip),
    targetLabel: safeStr(input.targetLabel) || "admin_auth",
    summary: safeStr(input.summary || input.message || input.event),
    actor: {
      type: safeStr(actor.type || "admin"),
      user: safeStr(actor.user || input.username),
      ip: safeStr(actor.ip || input.ip),
      userAgent: safeStr(actor.userAgent),
    },
    meta: {
      username: safeStr(input.username || meta.username || actor.user),
      ip: safeStr(input.ip || meta.ip || actor.ip),
      code: safeStr(input.code || meta.code),
      authMode: safeStr(input.authMode || meta.authMode),
      event: safeStr(input.event || input.action),
      ...meta,
    },
    before: normalizeObject(input.before),
    after: normalizeObject(input.after),
  });

  return pushAuditEvent(ADMIN_AUDIT_KEY, event, {
    maxItems: ADMIN_AUDIT_MAX_ITEMS,
    ttlSeconds: ADMIN_AUDIT_TTL_SECONDS,
  });
}



export async function logIdentityConflictAudit(input = {}) {
  const actor = normalizeObject(input.actor);
  const meta = normalizeObject(input.meta);

  const event = normalizeEvent({
    module: safeStr(input.module) || "IDENTITY_CONFLICT",
    action: normalizeIdentityConflictAction(input.action || input.event),
    waId: safeStr(input.waId),
    internalUserId: safeStr(input.internalUserId || input.waUserId),
    targetId: safeStr(input.targetId || input.conflictId || input.waUserId || input.bsuidUserId),
    targetLabel: safeStr(input.targetLabel) || "identity_conflict",
    summary: safeStr(input.summary || input.message || input.event),
    actor: {
      type: safeStr(actor.type || "system"),
      user: safeStr(actor.user || input.reviewedBy),
      ip: safeStr(actor.ip),
      userAgent: safeStr(actor.userAgent),
    },
    meta: {
      conflictId: safeStr(input.conflictId || meta.conflictId),
      waUserId: safeStr(input.waUserId || meta.waUserId),
      bsuidUserId: safeStr(input.bsuidUserId || meta.bsuidUserId),
      status: safeStr(input.status || meta.status),
      reviewDecision: safeStr(input.reviewDecision || meta.reviewDecision),
      reviewedBy: safeStr(input.reviewedBy || meta.reviewedBy || actor.user),
      waId: safeStr(input.waId || meta.waId),
      bsuid: safeStr(input.bsuid || meta.bsuid),
      event: safeStr(input.event || input.action),
      ...meta,
    },
    before: normalizeObject(input.before),
    after: normalizeObject(input.after),
  });

  return pushAuditEvent(ADMIN_AUDIT_KEY, event, {
    maxItems: ADMIN_AUDIT_MAX_ITEMS,
    ttlSeconds: ADMIN_AUDIT_TTL_SECONDS,
  });
}

export async function logAdminAudit(input = {}) {
  const event = normalizeEvent(input);
  return pushAuditEvent(ADMIN_AUDIT_KEY, event, {
    maxItems: ADMIN_AUDIT_MAX_ITEMS,
    ttlSeconds: ADMIN_AUDIT_TTL_SECONDS,
  });
}

export async function logUserAdminEditAudit(input = {}) {
  const before = normalizeObject(input.before);
  const after = normalizeObject(input.after);
  const changedFields = normalizeStringArray(input.changedFields);
  const rejectedFields = normalizeStringArray(input.rejectedFields);

  const event = normalizeEvent({
    module: "crm_user_edit",
    action: safeStr(input.action) || "update_user_admin_fields",
    waId: safeStr(input.waId || before.waId || after.waId),
    internalUserId: safeStr(input.internalUserId || input.userId || before.userId || after.userId),
    targetId: safeStr(input.targetId || input.internalUserId || input.userId || before.userId || after.userId || input.waId),
    targetLabel: safeStr(input.targetLabel || after.fullName || before.fullName || after.waId || before.waId || input.waId),
    summary: safeStr(input.summary) || `Edição administrativa de usuário: ${changedFields.length} campo(s) alterado(s)`,
    actor: normalizeObject(input.actor),
    before,
    after,
    changedFields,
    rejectedFields,
    meta: {
      ...normalizeObject(input.meta),
      changedFields,
      rejectedFields,
      changedCount: changedFields.length,
      rejectedCount: rejectedFields.length,
    },
  });

  return pushAuditEvent(ADMIN_AUDIT_KEY, event, {
    maxItems: ADMIN_AUDIT_MAX_ITEMS,
    ttlSeconds: ADMIN_AUDIT_TTL_SECONDS,
  });
}

export async function listAdminAudit({ limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(1500, toInt(limit, 100)));
  const raw = await redisLRange(ADMIN_AUDIT_KEY, 0, lim - 1);
  return parseAuditItems(raw);
}

export async function getAdminAuditCount() {
  const count = await redisLLen(ADMIN_AUDIT_KEY);
  return toInt(count, 0);
}

export async function logCouponAudit(input = {}) {
  const event = normalizeEvent({
    module: safeStr(input.module) || "COUPON",
    ...input,
  });

  const couponCode = normalizeCouponCode(event.couponCode);
  const internalUserId = safeStr(event.internalUserId);
  if (!couponCode) throw new Error("logCouponAudit: couponCode is required");

  const jobs = [
    pushAuditEvent(redisCouponAuditListKey(couponCode), event, {
      maxItems: COUPON_AUDIT_MAX_ITEMS,
      ttlSeconds: COUPON_AUDIT_TTL_SECONDS,
    }),
  ];

  if (internalUserId) {
    jobs.push(
      pushAuditEvent(redisCouponUserAuditListKey(internalUserId), event, {
        maxItems: COUPON_AUDIT_MAX_ITEMS,
        ttlSeconds: COUPON_AUDIT_TTL_SECONDS,
      })
    );
  }

  await Promise.allSettled(jobs);
  return event;
}

export async function listCouponAuditByCoupon(couponCode, { limit = 100 } = {}) {
  const code = normalizeCouponCode(couponCode);
  if (!code) return [];
  const lim = Math.max(1, Math.min(1500, toInt(limit, 100)));
  const raw = await redisLRange(redisCouponAuditListKey(code), 0, lim - 1);
  return parseAuditItems(raw);
}

export async function listCouponAuditByUser(internalUserId, { limit = 100 } = {}) {
  const userId = safeStr(internalUserId);
  if (!userId) return [];
  const lim = Math.max(1, Math.min(1500, toInt(limit, 100)));
  const raw = await redisLRange(redisCouponUserAuditListKey(userId), 0, lim - 1);
  return parseAuditItems(raw);
}

export async function getCouponAuditCountByCoupon(couponCode) {
  const code = normalizeCouponCode(couponCode);
  if (!code) return 0;
  const count = await redisLLen(redisCouponAuditListKey(code));
  return toInt(count, 0);
}

export async function getCouponAuditCountByUser(internalUserId) {
  const userId = safeStr(internalUserId);
  if (!userId) return 0;
  const count = await redisLLen(redisCouponUserAuditListKey(userId));
  return toInt(count, 0);
}


export async function logCampaignAudit(input = {}) {
  const event = normalizeEvent({
    module: safeStr(input.module) || "CAMPAIGN",
    ...input,
    campaignCode: normalizeCampaignCode(input.campaignCode),
  });

  const campaignId = safeStr(input.campaignId || event.targetId);
  if (!campaignId) throw new Error("logCampaignAudit: campaignId is required");

  const enrichedEvent = normalizeEvent({
    ...event,
    targetId: campaignId,
    targetLabel: safeStr(input.targetLabel) || "campaign",
    meta: {
      ...normalizeObject(event.meta),
      campaignId,
      campaignCode: normalizeCampaignCode(input.campaignCode),
      notes: safeStr(input.notes),
    },
  });

  const jobs = [
    pushAuditEvent(CAMPAIGN_AUDIT_GLOBAL_KEY, enrichedEvent, {
      maxItems: CAMPAIGN_AUDIT_MAX_ITEMS,
      ttlSeconds: CAMPAIGN_AUDIT_TTL_SECONDS,
    }),
    pushAuditEvent(campaignAuditListKey(campaignId), enrichedEvent, {
      maxItems: CAMPAIGN_AUDIT_MAX_ITEMS,
      ttlSeconds: CAMPAIGN_AUDIT_TTL_SECONDS,
    }),
  ];

  await Promise.allSettled(jobs);
  return enrichedEvent;
}

export async function listCampaignAudit({ limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(1500, toInt(limit, 100)));
  const raw = await redisLRange(CAMPAIGN_AUDIT_GLOBAL_KEY, 0, lim - 1);
  return parseAuditItems(raw);
}

export async function listCampaignAuditByCampaign(campaignId, { limit = 100 } = {}) {
  const id = safeStr(campaignId);
  if (!id) return [];
  const lim = Math.max(1, Math.min(1500, toInt(limit, 100)));
  const raw = await redisLRange(campaignAuditListKey(id), 0, lim - 1);
  return parseAuditItems(raw);
}

export async function getCampaignAuditCount() {
  const count = await redisLLen(CAMPAIGN_AUDIT_GLOBAL_KEY);
  return toInt(count, 0);
}

export async function getCampaignAuditCountByCampaign(campaignId) {
  const id = safeStr(campaignId);
  if (!id) return 0;
  const count = await redisLLen(campaignAuditListKey(id));
  return toInt(count, 0);
}


export async function logOperationalEvent(input = {}) {
  const event = normalizeRuntimeEvent(input);
  const moduleKey = runtimeAuditListKey(event.module);

  await Promise.allSettled([
    pushAuditEvent(RUNTIME_AUDIT_KEY, event, {
      maxItems: RUNTIME_AUDIT_MAX_ITEMS,
      ttlSeconds: RUNTIME_AUDIT_TTL_SECONDS,
    }),
    pushAuditEvent(moduleKey, event, {
      maxItems: RUNTIME_AUDIT_MAX_ITEMS,
      ttlSeconds: RUNTIME_AUDIT_TTL_SECONDS,
    }),
  ]);

  return event;
}

export async function logRuntimeError(input = {}) {
  return logOperationalEvent({
    level: safeStr(input.level) || "error",
    status: safeStr(input.status) || "error",
    ...input,
  });
}

export async function listOperationalAudit({ limit = 100, module = "" } = {}) {
  const lim = Math.max(1, Math.min(1500, toInt(limit, 100)));
  const key = safeStr(module) ? runtimeAuditListKey(module) : RUNTIME_AUDIT_KEY;
  const raw = await redisLRange(key, 0, lim - 1);
  const items = Array.isArray(raw) ? raw : [];
  return items.map((entry) => {
    try {
      return normalizeRuntimeEvent(JSON.parse(String(entry)));
    } catch (_) {
      return normalizeRuntimeEvent({
        module: safeStr(module) || "runtime",
        event: "runtime_raw_event",
        level: "warn",
        message: safeStr(entry),
      });
    }
  });
}

export async function getOperationalAuditCount({ module = "" } = {}) {
  const key = safeStr(module) ? runtimeAuditListKey(module) : RUNTIME_AUDIT_KEY;
  const count = await redisLLen(key);
  return toInt(count, 0);
}
