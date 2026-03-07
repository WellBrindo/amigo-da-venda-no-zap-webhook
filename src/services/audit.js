// src/services/audit.js
import { redisLPush, redisLRange, redisLLen, redisLTrim, redisExpire } from "./redis.js";

const ADMIN_AUDIT_KEY = "audit:admin";
const ADMIN_AUDIT_MAX_ITEMS = 2000;
const ADMIN_AUDIT_TTL_SECONDS = 180 * 24 * 60 * 60;

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

function normalizeEvent(input = {}) {
  return {
    id: safeStr(input.id) || makeEventId(),
    ts: safeStr(input.ts) || new Date().toISOString(),
    module: safeStr(input.module).toUpperCase(),
    action: safeStr(input.action).toUpperCase(),
    waId: safeStr(input.waId),
    targetId: safeStr(input.targetId),
    targetLabel: safeStr(input.targetLabel),
    summary: safeStr(input.summary),
    actor: normalizeObject(input.actor),
    meta: normalizeObject(input.meta),
    before: normalizeObject(input.before),
    after: normalizeObject(input.after),
  };
}

export async function logAdminAudit(input = {}) {
  const event = normalizeEvent(input);
  await redisLPush(ADMIN_AUDIT_KEY, JSON.stringify(event));
  await Promise.allSettled([
    redisLTrim(ADMIN_AUDIT_KEY, 0, ADMIN_AUDIT_MAX_ITEMS - 1),
    redisExpire(ADMIN_AUDIT_KEY, ADMIN_AUDIT_TTL_SECONDS),
  ]);
  return event;
}

export async function listAdminAudit({ limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(1500, toInt(limit, 100)));
  const raw = await redisLRange(ADMIN_AUDIT_KEY, 0, lim - 1);
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

export async function getAdminAuditCount() {
  const count = await redisLLen(ADMIN_AUDIT_KEY);
  return toInt(count, 0);
}
