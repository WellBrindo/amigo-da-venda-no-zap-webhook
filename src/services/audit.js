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

const COUPON_AUDIT_MAX_ITEMS = 2000;
const COUPON_AUDIT_TTL_SECONDS = 180 * 24 * 60 * 60;

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

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function normalizeCouponCode(value) {
  const text = safeStr(value).toUpperCase();
  return text || "";
}

function normalizeBillingCycle(value) {
  const text = safeStr(value).toLowerCase();
  return text || "";
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

export async function logAdminAudit(input = {}) {
  const event = normalizeEvent(input);
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
