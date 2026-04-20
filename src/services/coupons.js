
// src/services/coupons.js
// Serviço central do módulo de cupons.
// Responsabilidades:
// - CRUD lógico de cupons
// - validação de elegibilidade
// - criação/confirmação/liberação/expiração de reservas
// - bloqueio de reservas duplicadas
// - trilha de relatório operacional
//
// Observações:
// - toda a camada é amarrada a internalUserId
// - o desconto efetivo final será consolidado pelo pricing.js
// - este serviço já registra auditoria e métricas operacionais

import {
  redisGet,
  redisSet,
  redisDel,
  redisSMembers,
  redisSAdd,
  redisSRem,
  redisSCard,
  redisZAdd,
  redisZRem,
  redisZRangeByScore,
  redisCouponIndexKey,
  redisCouponCodeKey,
  redisCouponStatusIndexKey,
  redisCouponReservationKey,
  redisCouponReservationPendingIndexKey,
  redisCouponReservationStatusIndexKey,
  redisCouponReservationUserIndexKey,
  redisCouponReservationCouponIndexKey,
  redisCouponRedemptionUserIndexKey,
  redisCouponRedemptionCouponIndexKey,
  redisCouponReportIndexKey,
  redisCouponReportKey,
  redisNextCouponReservationSequence,
} from "./redis.js";
import { getPlan, getPlanBillingOption } from "./plans.js";
import { getUserPlan, getUserStatus } from "./state.js";
import { logCouponAudit } from "./audit.js";
import {
  recordCouponMetrics,
  trackCouponApplied,
  trackCouponRejected,
} from "./metrics.js";

const COUPON_STATUS = Object.freeze({
  ACTIVE: "active",
  INACTIVE: "inactive",
  DELETED: "deleted",
});

const RESERVATION_STATUS = Object.freeze({
  RESERVED: "reserved",
  CONFIRMED: "confirmed",
  RELEASED: "released",
  EXPIRED: "expired",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const DISCOUNT_TYPE = Object.freeze({
  PERCENT: "percent",
  FIXED: "fixed",
});

const APPLIES_TO = Object.freeze({
  FIRST_CHARGE_ONLY: "first_charge_only",
  ENTIRE_SUBSCRIPTION: "entire_subscription",
});

const DEFAULT_RESERVATION_TTL_HOURS = 20;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 2000;
const COUPON_CONVERSION_TRACKING_MODE = Object.freeze({
  AUTO: "auto",
  NONE: "none",
  ENGINE_VALIDATION: "engine_validation",
  FLOW_EXCLUSIVE: "flow_exclusive",
});

// Política semântica final deste módulo:
// - Eventos operacionais do motor de cupom:
//   coupon_attempted, coupon_validated, coupon_reserved, coupon_confirmed,
//   coupon_released, coupon_expired, coupon_failed,
//   coupon_duplicate_blocked, coupon_removed_message_sent.
// - Eventos oficiais do funil:
//   coupon_applied, coupon_rejected, coupon_removed.
// - Responsabilidade canônica:
//   * coupon_applied: flow.js (UX) ou coupons.js (engine_validation), sem duplicidade material.
//   * coupon_rejected: pode ser emitido pelo motor de validação com segurança.
//   * coupon_removed: somente remoção explícita no fluxo de UX; nunca timeout/automação.
//   * coupon_removed_message_sent: permanece apenas operacional.


function safeStr(value) {
  return String(value ?? "").trim();
}

function toUpper(value) {
  return safeStr(value).toUpperCase();
}

function toLower(value) {
  return safeStr(value).toLowerCase();
}

function nowMs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(values = [], { upper = false, lower = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    let text = safeStr(value);
    if (!text) continue;
    if (upper) text = text.toUpperCase();
    if (lower) text = text.toLowerCase();
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toPositiveIntOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

function toNonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}

function toBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const text = toLower(value);
  if (!text) return fallback;
  if (["1", "true", "yes", "y", "sim", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "nao", "não", "off"].includes(text)) return false;
  return fallback;
}

function parseJson(raw, fallback = null) {
  try {
    return JSON.parse(String(raw ?? ""));
  } catch {
    return fallback;
  }
}

function normalizeCouponCode(value) {
  return toUpper(value);
}

function normalizePlanCode(value) {
  return toUpper(value);
}

function normalizeBillingCycle(value) {
  const text = toLower(value);
  return text === "annual" ? "annual" : text === "monthly" ? "monthly" : "";
}

function normalizeCouponStatus(value) {
  const text = toLower(value);
  if (text === COUPON_STATUS.ACTIVE) return COUPON_STATUS.ACTIVE;
  if (text === COUPON_STATUS.DELETED) return COUPON_STATUS.DELETED;
  return COUPON_STATUS.INACTIVE;
}

function normalizeReservationStatus(value) {
  const text = toLower(value);
  if (text === RESERVATION_STATUS.CONFIRMED) return RESERVATION_STATUS.CONFIRMED;
  if (text === RESERVATION_STATUS.RELEASED) return RESERVATION_STATUS.RELEASED;
  if (text === RESERVATION_STATUS.EXPIRED) return RESERVATION_STATUS.EXPIRED;
  if (text === RESERVATION_STATUS.FAILED) return RESERVATION_STATUS.FAILED;
  if (text === RESERVATION_STATUS.CANCELLED) return RESERVATION_STATUS.CANCELLED;
  return RESERVATION_STATUS.RESERVED;
}

function normalizeDiscountType(value) {
  const text = toLower(value);
  return text === DISCOUNT_TYPE.FIXED ? DISCOUNT_TYPE.FIXED : DISCOUNT_TYPE.PERCENT;
}

function normalizeAppliesTo(value) {
  const text = toLower(value);
  return text === APPLIES_TO.ENTIRE_SUBSCRIPTION
    ? APPLIES_TO.ENTIRE_SUBSCRIPTION
    : APPLIES_TO.FIRST_CHARGE_ONLY;
}

function normalizeIso(value) {
  const text = safeStr(value);
  if (!text) return "";
  const dt = new Date(text);
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : "";
}

function isoToMs(value) {
  const iso = normalizeIso(value);
  if (!iso) return 0;
  return new Date(iso).getTime();
}

function couponKey(code) {
  return redisCouponCodeKey(code);
}

function makeReservationId(sequence) {
  const seq = toPositiveIntOrNull(sequence);
  if (!seq) throw new Error(`makeReservationId: invalid sequence=${sequence}`);
  return `cpr_${String(seq).padStart(8, "0")}`;
}

function makeReportId(reservationId, eventName) {
  return `couponReport_${Date.now()}_${safeStr(reservationId)}_${safeStr(eventName).toLowerCase()}`;
}

function normalizeTags(values) {
  return uniqueStrings(values, { upper: false, lower: true });
}

function normalizeEligiblePlans(values) {
  return uniqueStrings(values, { upper: true });
}

function normalizeEligibleCycles(values) {
  return uniqueStrings(values.map((v) => normalizeBillingCycle(v)).filter(Boolean), { lower: true });
}

function normalizeMeta(value) {
  return isPlainObject(value) ? { ...value } : {};
}

function computeDiscountAmountCents({
  discountType = DISCOUNT_TYPE.PERCENT,
  discountPercent = 0,
  discountAmountCents = 0,
  discountCapCents = null,
  basePriceCents = 0,
} = {}) {
  const base = toNonNegativeInt(basePriceCents, 0);
  if (!base) return 0;

  if (discountType === DISCOUNT_TYPE.FIXED) {
    return Math.min(base, toNonNegativeInt(discountAmountCents, 0));
  }

  const percent = Number(discountPercent);
  if (!Number.isFinite(percent) || percent <= 0) return 0;

  let calculated = Math.round(base * (percent / 100));
  const cap = toPositiveIntOrNull(discountCapCents);
  if (cap) calculated = Math.min(calculated, cap);
  return Math.min(base, Math.max(0, calculated));
}

function sanitizeSelectionSnapshot(selection = {}) {
  const source = isPlainObject(selection) ? selection : {};
  const next = {};

  next.planCode = normalizePlanCode(source.planCode || source.selectedPlanCode);
  next.billingCycle = normalizeBillingCycle(source.billingCycle || source.selectedBillingCycle);
  next.couponCode = normalizeCouponCode(source.couponCode || source.selectedCouponCode);
  next.internalUserId = safeStr(source.internalUserId);
  next.basePriceCents = toNonNegativeInt(source.basePriceCents, 0);
  next.discountAmountCents = toNonNegativeInt(source.discountAmountCents, 0);
  next.finalPriceCents = toNonNegativeInt(source.finalPriceCents, 0);
  next.appliesTo = normalizeAppliesTo(source.appliesTo);
  next.meta = normalizeMeta(source.meta);

  Object.keys(next).forEach((key) => {
    const value = next[key];
    if (typeof value === "string" && !value) delete next[key];
    if (isPlainObject(value) && !Object.keys(value).length) delete next[key];
    if (typeof value === "number" && !Number.isFinite(value)) delete next[key];
  });

  return next;
}

function buildCoupon(input = {}, existing = null) {
  const prev = isPlainObject(existing) ? existing : {};
  const now = nowIso();

  const couponCode = normalizeCouponCode(input.couponCode || prev.couponCode);
  if (!couponCode) throw new Error("buildCoupon: couponCode is required");

  const discountType = normalizeDiscountType(input.discountType || prev.discountType);
  const next = {
    couponCode,
    name: safeStr(input.name ?? prev.name),
    description: safeStr(input.description ?? prev.description),
    status: normalizeCouponStatus(input.status ?? prev.status ?? (toBool(input.active ?? prev.active, true) ? "active" : "inactive")),
    active: normalizeCouponStatus(input.status ?? prev.status ?? (toBool(input.active ?? prev.active, true) ? "active" : "inactive")) === COUPON_STATUS.ACTIVE,
    deleted: normalizeCouponStatus(input.status ?? prev.status) === COUPON_STATUS.DELETED || toBool(input.deleted ?? prev.deleted, false),
    discountType,
    discountPercent:
      discountType === DISCOUNT_TYPE.PERCENT
        ? Math.max(0, Number(input.discountPercent ?? input.discountValue ?? prev.discountPercent ?? prev.discountValue ?? 0) || 0)
        : 0,
    discountAmountCents:
      discountType === DISCOUNT_TYPE.FIXED
        ? toNonNegativeInt(input.discountAmountCents ?? input.discountValueCents ?? input.discountValue ?? prev.discountAmountCents ?? prev.discountValueCents ?? prev.discountValue ?? 0, 0)
        : 0,
    discountCapCents: toPositiveIntOrNull(input.discountCapCents ?? input.discountCap ?? prev.discountCapCents ?? prev.discountCap ?? null),
    eligiblePlanCodes: normalizeEligiblePlans(input.eligiblePlanCodes ?? input.planCodes ?? prev.eligiblePlanCodes ?? prev.planCodes ?? []),
    eligibleBillingCycles: normalizeEligibleCycles(input.eligibleBillingCycles ?? input.billingCycles ?? prev.eligibleBillingCycles ?? prev.billingCycles ?? []),
    validFrom: normalizeIso(input.validFrom ?? prev.validFrom),
    validUntil: normalizeIso(input.validUntil ?? prev.validUntil),
    maxRedemptionsTotal: toPositiveIntOrNull(input.maxRedemptionsTotal ?? prev.maxRedemptionsTotal),
    maxRedemptionsPerUser: toPositiveIntOrNull(input.maxRedemptionsPerUser ?? prev.maxRedemptionsPerUser),
    firstPurchaseOnly: toBool(input.firstPurchaseOnly ?? prev.firstPurchaseOnly, false),
    onlyWithoutActivePlan: toBool(input.onlyWithoutActivePlan ?? prev.onlyWithoutActivePlan, false),
    appliesTo: normalizeAppliesTo(input.appliesTo ?? prev.appliesTo),
    stackable: false,
    priority: toNonNegativeInt(input.priority ?? prev.priority, 0),
    tags: normalizeTags(input.tags ?? prev.tags ?? []),
    createdAt: normalizeIso(prev.createdAt) || now,
    updatedAt: now,
    deletedAt: "",
    createdBy: safeStr(input.createdBy ?? prev.createdBy),
    updatedBy: safeStr(input.updatedBy ?? input.createdBy ?? prev.updatedBy),
    meta: normalizeMeta(input.meta ?? prev.meta),
  };

  if (next.validFrom && next.validUntil) {
    const fromMs = isoToMs(next.validFrom);
    const untilMs = isoToMs(next.validUntil);
    if (fromMs && untilMs && untilMs < fromMs) {
      throw new Error("buildCoupon: validUntil must be >= validFrom");
    }
  }

  if (next.deleted) {
    next.status = COUPON_STATUS.DELETED;
    next.active = false;
    next.deletedAt = normalizeIso(input.deletedAt ?? prev.deletedAt) || now;
  } else {
    next.deletedAt = "";
  }

  return next;
}

function buildReservation(input = {}, existing = null) {
  const prev = isPlainObject(existing) ? existing : {};
  const now = nowIso();

  const reservationId = safeStr(input.reservationId || prev.reservationId);
  if (!reservationId) throw new Error("buildReservation: reservationId is required");

  const couponCode = normalizeCouponCode(input.couponCode || prev.couponCode);
  if (!couponCode) throw new Error("buildReservation: couponCode is required");

  const internalUserId = safeStr(input.internalUserId || prev.internalUserId);
  if (!internalUserId) throw new Error("buildReservation: internalUserId is required");

  const planCode = normalizePlanCode(input.planCode || prev.planCode);
  const billingCycle = normalizeBillingCycle(input.billingCycle || prev.billingCycle);

  const status = normalizeReservationStatus(input.status || prev.status || RESERVATION_STATUS.RESERVED);
  const reservedAt = normalizeIso(input.reservedAt || prev.reservedAt) || now;
  const expiresAt = normalizeIso(input.expiresAt || prev.expiresAt);
  const selectionSnapshot = sanitizeSelectionSnapshot(input.selectionSnapshot || prev.selectionSnapshot || {});
  const next = {
    reservationId,
    couponCode,
    internalUserId,
    planCode,
    billingCycle,
    status,
    appliesTo: normalizeAppliesTo(input.appliesTo || prev.appliesTo || selectionSnapshot.appliesTo),
    basePriceCents: toNonNegativeInt(input.basePriceCents ?? prev.basePriceCents ?? selectionSnapshot.basePriceCents, 0),
    discountAmountCents: toNonNegativeInt(input.discountAmountCents ?? prev.discountAmountCents ?? selectionSnapshot.discountAmountCents, 0),
    finalPriceCents: toNonNegativeInt(input.finalPriceCents ?? prev.finalPriceCents ?? selectionSnapshot.finalPriceCents, 0),
    reservedAt,
    expiresAt,
    confirmedAt: normalizeIso(input.confirmedAt || prev.confirmedAt),
    releasedAt: normalizeIso(input.releasedAt || prev.releasedAt),
    expiredAt: normalizeIso(input.expiredAt || prev.expiredAt),
    failedAt: normalizeIso(input.failedAt || prev.failedAt),
    cancelledAt: normalizeIso(input.cancelledAt || prev.cancelledAt),
    paymentId: safeStr(input.paymentId || prev.paymentId),
    subscriptionId: safeStr(input.subscriptionId || prev.subscriptionId),
    releaseReason: safeStr(input.releaseReason || prev.releaseReason),
    failureReason: safeStr(input.failureReason || prev.failureReason),
    cancellationReason: safeStr(input.cancellationReason || prev.cancellationReason),
    messageSentAt: normalizeIso(input.messageSentAt || prev.messageSentAt),
    createdAt: normalizeIso(prev.createdAt) || reservedAt,
    updatedAt: now,
    selectionSnapshot,
    meta: normalizeMeta(input.meta ?? prev.meta),
  };

  return next;
}

function buildReportRow(input = {}) {
  const row = {
    reportId: safeStr(input.reportId) || makeReportId(input.reservationId, input.eventName),
    ts: normalizeIso(input.ts) || nowIso(),
    eventName: toLower(input.eventName),
    couponCode: normalizeCouponCode(input.couponCode),
    reservationId: safeStr(input.reservationId),
    internalUserId: safeStr(input.internalUserId),
    planCode: normalizePlanCode(input.planCode),
    billingCycle: normalizeBillingCycle(input.billingCycle),
    status: normalizeReservationStatus(input.status),
    appliesTo: normalizeAppliesTo(input.appliesTo),
    basePriceCents: toNonNegativeInt(input.basePriceCents, 0),
    discountAmountCents: toNonNegativeInt(input.discountAmountCents, 0),
    finalPriceCents: toNonNegativeInt(input.finalPriceCents, 0),
    paymentId: safeStr(input.paymentId),
    subscriptionId: safeStr(input.subscriptionId),
    reason: safeStr(input.reason),
    meta: normalizeMeta(input.meta),
  };
  return row;
}

async function readCoupon(couponCode) {
  const code = normalizeCouponCode(couponCode);
  if (!code) return null;
  const raw = await redisGet(couponKey(code));
  if (!raw) return null;
  const parsed = parseJson(raw, null);
  if (!isPlainObject(parsed)) return null;
  try {
    return buildCoupon(parsed, parsed);
  } catch {
    return null;
  }
}

async function writeCouponRecord(coupon) {
  await redisSet(couponKey(coupon.couponCode), JSON.stringify(coupon));
  return coupon;
}

async function syncCouponIndexes(previousCoupon, nextCoupon) {
  const prev = isPlainObject(previousCoupon) ? previousCoupon : null;
  const next = isPlainObject(nextCoupon) ? nextCoupon : null;

  if (prev?.couponCode && (!next || prev.couponCode !== next.couponCode)) {
    await redisSRem(redisCouponIndexKey(), prev.couponCode);
  }

  if (prev?.status && prev?.couponCode && (!next || prev.status !== next.status || prev.couponCode !== next.couponCode)) {
    await redisSRem(redisCouponStatusIndexKey(prev.status), prev.couponCode);
  }

  if (!next) return;

  await redisSAdd(redisCouponIndexKey(), next.couponCode);
  await redisSAdd(redisCouponStatusIndexKey(next.status), next.couponCode);
}

async function readReservation(reservationId) {
  const id = safeStr(reservationId);
  if (!id) return null;
  const raw = await redisGet(redisCouponReservationKey(id));
  if (!raw) return null;
  const parsed = parseJson(raw, null);
  if (!isPlainObject(parsed)) return null;
  try {
    return buildReservation(parsed, parsed);
  } catch {
    return null;
  }
}

async function writeReservationRecord(reservation) {
  await redisSet(redisCouponReservationKey(reservation.reservationId), JSON.stringify(reservation));
  return reservation;
}

async function syncReservationIndexes(previousReservation, nextReservation) {
  const prev = isPlainObject(previousReservation) ? previousReservation : null;
  const next = isPlainObject(nextReservation) ? nextReservation : null;

  if (prev?.reservationId && (!next || prev.status !== next.status)) {
    await redisSRem(redisCouponReservationStatusIndexKey(prev.status), prev.reservationId);
  }

  if (prev?.reservationId && (!next || prev.internalUserId !== next.internalUserId)) {
    await redisSRem(redisCouponReservationUserIndexKey(prev.internalUserId), prev.reservationId);
  }

  if (prev?.reservationId && (!next || prev.couponCode !== next.couponCode)) {
    await redisSRem(redisCouponReservationCouponIndexKey(prev.couponCode), prev.reservationId);
  }

  if (prev?.reservationId && prev?.status === RESERVATION_STATUS.RESERVED && (!next || next.status !== RESERVATION_STATUS.RESERVED)) {
    await redisZRem(redisCouponReservationPendingIndexKey(), prev.reservationId);
  }

  if (!next) return;

  await redisSAdd(redisCouponReservationUserIndexKey(next.internalUserId), next.reservationId);
  await redisSAdd(redisCouponReservationCouponIndexKey(next.couponCode), next.reservationId);
  await redisSAdd(redisCouponReservationStatusIndexKey(next.status), next.reservationId);

  if (next.status === RESERVATION_STATUS.RESERVED) {
    const expiresAtMs = isoToMs(next.expiresAt);
    if (expiresAtMs > 0) {
      await redisZAdd(redisCouponReservationPendingIndexKey(), expiresAtMs, next.reservationId);
    }
  } else {
    await redisZRem(redisCouponReservationPendingIndexKey(), next.reservationId);
  }

  if (
    prev?.reservationId &&
    prev?.status === RESERVATION_STATUS.CONFIRMED &&
    (
      next.status !== RESERVATION_STATUS.CONFIRMED ||
      prev.internalUserId !== next.internalUserId ||
      prev.couponCode !== next.couponCode
    )
  ) {
    await Promise.all([
      redisSRem(redisCouponRedemptionUserIndexKey(prev.internalUserId), prev.reservationId),
      redisSRem(redisCouponRedemptionCouponIndexKey(prev.couponCode), prev.reservationId),
    ]);
  }

  if (next.status === RESERVATION_STATUS.CONFIRMED) {
    await Promise.all([
      redisSAdd(redisCouponRedemptionUserIndexKey(next.internalUserId), next.reservationId),
      redisSAdd(redisCouponRedemptionCouponIndexKey(next.couponCode), next.reservationId),
    ]);
  }
}

async function writeReportRow(row) {
  await redisSet(redisCouponReportKey(row.reportId), JSON.stringify(row));
  await redisSAdd(redisCouponReportIndexKey(), row.reportId);
  return row;
}

async function readReportRow(reportId) {
  const id = safeStr(reportId);
  if (!id) return null;
  const raw = await redisGet(redisCouponReportKey(id));
  if (!raw) return null;
  const parsed = parseJson(raw, null);
  if (!isPlainObject(parsed)) return null;
  return buildReportRow(parsed);
}

async function appendReportRow(payload = {}) {
  const row = buildReportRow(payload);
  await writeReportRow(row);
  return row;
}

async function getCouponRedemptionReservations(couponCode) {
  const code = normalizeCouponCode(couponCode);
  if (!code) return [];
  const ids = await redisSMembers(redisCouponRedemptionCouponIndexKey(code));
  return hydrateReservations(ids);
}

async function getUserRedemptionReservations(internalUserId) {
  const userId = safeStr(internalUserId);
  if (!userId) return [];
  const ids = await redisSMembers(redisCouponRedemptionUserIndexKey(userId));
  return hydrateReservations(ids);
}

async function hydrateReservations(ids = []) {
  const uniqueIds = uniqueStrings(ids);
  if (!uniqueIds.length) return [];
  const rows = await Promise.all(uniqueIds.map((id) => readReservation(id)));
  return rows.filter(Boolean).sort(sortReservationsDesc);
}

function sortCoupons(a, b) {
  const pa = toNonNegativeInt(a?.priority, 0);
  const pb = toNonNegativeInt(b?.priority, 0);
  if (pb !== pa) return pb - pa;
  return safeStr(a?.couponCode).localeCompare(safeStr(b?.couponCode));
}

function sortReservationsDesc(a, b) {
  return isoToMs(b?.updatedAt || b?.createdAt || b?.reservedAt) - isoToMs(a?.updatedAt || a?.createdAt || a?.reservedAt);
}

function sortReportRowsDesc(a, b) {
  return isoToMs(b?.ts) - isoToMs(a?.ts);
}

function resolveReservationHours(payload = {}) {
  const hours = Number(payload.reservationTtlHours ?? payload.reservationHours ?? DEFAULT_RESERVATION_TTL_HOURS);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_RESERVATION_TTL_HOURS;
  return Math.max(1, Math.trunc(hours));
}

function buildEligibilityFailure(code, message, extra = {}) {
  return {
    ok: false,
    eligible: false,
    code: safeStr(code),
    reason: safeStr(message),
    ...extra,
  };
}

async function getCouponRedemptionCount(couponCode) {
  const code = normalizeCouponCode(couponCode);
  if (!code) return 0;
  const count = await redisSCard(redisCouponRedemptionCouponIndexKey(code));
  return toNonNegativeInt(count, 0);
}

async function getUserCouponRedemptionCount(internalUserId, couponCode) {
  const userId = safeStr(internalUserId);
  const code = normalizeCouponCode(couponCode);
  if (!userId || !code) return 0;
  const rows = await getUserRedemptionReservations(userId);
  return rows.filter((row) => row.couponCode === code && row.status === RESERVATION_STATUS.CONFIRMED).length;
}

async function userHasAnyConfirmedRedemption(internalUserId) {
  const rows = await getUserRedemptionReservations(internalUserId);
  return rows.some((row) => row.status === RESERVATION_STATUS.CONFIRMED);
}

async function findDuplicateOpenReservation(internalUserId, couponCode) {
  const userId = safeStr(internalUserId);
  const code = normalizeCouponCode(couponCode);
  if (!userId || !code) return null;

  const ids = await redisSMembers(redisCouponReservationUserIndexKey(userId));
  const reservations = await hydrateReservations(ids);
  const now = nowMs();

  for (const reservation of reservations) {
    if (reservation.couponCode !== code) continue;
    if (reservation.status !== RESERVATION_STATUS.RESERVED) continue;
    const expiresAtMs = isoToMs(reservation.expiresAt);
    if (expiresAtMs && expiresAtMs < now) continue;
    return reservation;
  }

  return null;
}

function buildCouponTrackingContext({
  internalUserId = "",
  couponCode = "",
  planCode = "",
  billingCycle = "",
  source = "coupons",
  step = "",
} = {}) {
  return {
    userId: safeStr(internalUserId),
    waId: safeStr(internalUserId),
    couponCode: normalizeCouponCode(couponCode),
    planCode: normalizePlanCode(planCode),
    billingCycle: normalizeBillingCycle(billingCycle),
    source: safeStr(source) || "coupons",
    step: safeStr(step),
  };
}

function normalizeCouponConversionTrackingMode(value) {
  const text = toLower(value);
  if (text === COUPON_CONVERSION_TRACKING_MODE.NONE) return COUPON_CONVERSION_TRACKING_MODE.NONE;
  if (text === COUPON_CONVERSION_TRACKING_MODE.ENGINE_VALIDATION) return COUPON_CONVERSION_TRACKING_MODE.ENGINE_VALIDATION;
  if (text === COUPON_CONVERSION_TRACKING_MODE.FLOW_EXCLUSIVE) return COUPON_CONVERSION_TRACKING_MODE.FLOW_EXCLUSIVE;
  return COUPON_CONVERSION_TRACKING_MODE.AUTO;
}

function resolveCouponConversionTrackingMode({ trackingMode = "auto", trackConversion = false, source = "coupons" } = {}) {
  const normalizedMode = normalizeCouponConversionTrackingMode(trackingMode);
  if (normalizedMode !== COUPON_CONVERSION_TRACKING_MODE.AUTO) {
    return normalizedMode;
  }

  if (trackConversion) {
    return COUPON_CONVERSION_TRACKING_MODE.ENGINE_VALIDATION;
  }

  const normalizedSource = toLower(source);

  // Fonte canônica do tracking de UX interativo:
  // - flow.js emite coupon_applied / coupon_rejected / coupon_removed
  //   nos pontos de interação explícita do usuário.
  if (normalizedSource === "flow") {
    return COUPON_CONVERSION_TRACKING_MODE.FLOW_EXCLUSIVE;
  }

  // Pricing faz validação estrutural de checkout, mas não deve duplicar
  // o funil oficial quando o fluxo principal já capturou a interação do usuário.
  if (normalizedSource.startsWith("pricing")) {
    return COUPON_CONVERSION_TRACKING_MODE.NONE;
  }

  // Demais validações diretas do motor de cupom podem emitir funil oficial.
  return COUPON_CONVERSION_TRACKING_MODE.ENGINE_VALIDATION;
}

function shouldEmitCouponConversion(mode, kind) {
  const normalizedMode = normalizeCouponConversionTrackingMode(mode);
  if (normalizedMode === COUPON_CONVERSION_TRACKING_MODE.NONE) return false;
  if (normalizedMode === COUPON_CONVERSION_TRACKING_MODE.FLOW_EXCLUSIVE) return false;
  if (normalizedMode === COUPON_CONVERSION_TRACKING_MODE.ENGINE_VALIDATION) {
    return kind === "applied" || kind === "rejected";
  }
  return false;
}

async function emitCouponConversionMetricSafe(kind, payload = {}) {
  try {
    if (kind === "applied") {
      return await trackCouponApplied(buildCouponTrackingContext(payload));
    }
    if (kind === "rejected") {
      return await trackCouponRejected(buildCouponTrackingContext(payload));
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function emitCouponAudit(action, reservationOrCoupon, extra = {}) {
  const payload = isPlainObject(reservationOrCoupon) ? reservationOrCoupon : {};
  const couponCode = normalizeCouponCode(extra.couponCode || payload.couponCode);
  if (!couponCode) return null;

  return logCouponAudit({
    module: "COUPON",
    action: safeStr(action).toUpperCase(),
    couponCode,
    internalUserId: safeStr(extra.internalUserId || payload.internalUserId),
    reservationId: safeStr(extra.reservationId || payload.reservationId),
    planCode: normalizePlanCode(extra.planCode || payload.planCode),
    billingCycle: normalizeBillingCycle(extra.billingCycle || payload.billingCycle),
    paymentId: safeStr(extra.paymentId || payload.paymentId),
    subscriptionId: safeStr(extra.subscriptionId || payload.subscriptionId),
    summary: safeStr(extra.summary),
    meta: normalizeMeta(extra.meta),
    before: normalizeMeta(extra.before),
    after: normalizeMeta(extra.after),
  });
}

async function emitCouponMetric({
  eventName = "",
  couponCode = "",
  internalUserId = "",
  planCode = "",
  billingCycle = "",
  basePriceCents = 0,
  discountAmountCents = 0,
  finalPriceCents = 0,
} = {}) {
  if (!safeStr(eventName)) return null;
  return recordCouponMetrics({
    eventName,
    userId: safeStr(internalUserId),
    couponCode: normalizeCouponCode(couponCode),
    planCode: normalizePlanCode(planCode),
    billingCycle: normalizeBillingCycle(billingCycle),
    originalCents: toNonNegativeInt(basePriceCents, 0),
    discountCents: toNonNegativeInt(discountAmountCents, 0),
    finalCents: toNonNegativeInt(finalPriceCents, 0),
  });
}

async function emitCouponReport(eventName, reservationOrCoupon, extra = {}) {
  const payload = isPlainObject(reservationOrCoupon) ? reservationOrCoupon : {};
  const couponCode = normalizeCouponCode(extra.couponCode || payload.couponCode);
  if (!couponCode) return null;

  return appendReportRow({
    eventName,
    couponCode,
    reservationId: safeStr(extra.reservationId || payload.reservationId),
    internalUserId: safeStr(extra.internalUserId || payload.internalUserId),
    planCode: normalizePlanCode(extra.planCode || payload.planCode),
    billingCycle: normalizeBillingCycle(extra.billingCycle || payload.billingCycle),
    status: normalizeReservationStatus(extra.status || payload.status),
    appliesTo: normalizeAppliesTo(extra.appliesTo || payload.appliesTo),
    basePriceCents: toNonNegativeInt(extra.basePriceCents ?? payload.basePriceCents, 0),
    discountAmountCents: toNonNegativeInt(extra.discountAmountCents ?? payload.discountAmountCents, 0),
    finalPriceCents: toNonNegativeInt(extra.finalPriceCents ?? payload.finalPriceCents, 0),
    paymentId: safeStr(extra.paymentId || payload.paymentId),
    subscriptionId: safeStr(extra.subscriptionId || payload.subscriptionId),
    reason: safeStr(extra.reason),
    meta: normalizeMeta(extra.meta),
  });
}

function normalizeListLimit(limit, fallback = DEFAULT_LIST_LIMIT) {
  return Math.max(1, Math.min(MAX_LIST_LIMIT, toInt(limit, fallback)));
}

async function getPlanAndBillingOption(planCode, billingCycle) {
  const normalizedPlanCode = normalizePlanCode(planCode);
  const normalizedBillingCycle = normalizeBillingCycle(billingCycle);
  if (!normalizedPlanCode) return { plan: null, billingOption: null };

  const plan = await getPlan(normalizedPlanCode);
  if (!plan) return { plan: null, billingOption: null };

  const billingOption = getPlanBillingOption(plan, normalizedBillingCycle || "monthly");
  return { plan, billingOption };
}

function coerceBasePriceCents(inputBasePriceCents, billingOption) {
  const explicit = toNonNegativeInt(inputBasePriceCents, 0);
  if (explicit > 0) return explicit;
  return toNonNegativeInt(billingOption?.priceCents, 0);
}

async function buildEligibilityContext({
  internalUserId = "",
  couponCode = "",
  planCode = "",
  billingCycle = "",
  basePriceCents = 0,
} = {}) {
  const userId = safeStr(internalUserId);
  const code = normalizeCouponCode(couponCode);
  const normalizedPlanCode = normalizePlanCode(planCode);
  const normalizedBillingCycle = normalizeBillingCycle(billingCycle);

  const [coupon, duplicateReservation, userStatus, userPlan, redemptionCountTotal, redemptionCountByUser, hasPriorPurchase] =
    await Promise.all([
      readCoupon(code),
      findDuplicateOpenReservation(userId, code),
      userId ? getUserStatus(userId) : "",
      userId ? getUserPlan(userId) : "",
      code ? getCouponRedemptionCount(code) : 0,
      userId && code ? getUserCouponRedemptionCount(userId, code) : 0,
      userId ? userHasAnyConfirmedRedemption(userId) : false,
    ]);

  const { plan, billingOption } = await getPlanAndBillingOption(normalizedPlanCode, normalizedBillingCycle);

  const effectiveBasePriceCents = coerceBasePriceCents(basePriceCents, billingOption);

  return {
    internalUserId: userId,
    couponCode: code,
    planCode: normalizedPlanCode,
    billingCycle: normalizedBillingCycle,
    coupon,
    duplicateReservation,
    userStatus: toUpper(userStatus),
    userPlan: normalizePlanCode(userPlan),
    redemptionCountTotal: toNonNegativeInt(redemptionCountTotal, 0),
    redemptionCountByUser: toNonNegativeInt(redemptionCountByUser, 0),
    hasPriorPurchase: Boolean(hasPriorPurchase),
    plan,
    billingOption,
    basePriceCents: effectiveBasePriceCents,
  };
}

export async function getCoupon(couponCode) {
  return readCoupon(couponCode);
}

export async function listCoupons({ includeInactive = true, includeDeleted = false } = {}) {
  const ids = await redisSMembers(redisCouponIndexKey());
  const rows = await Promise.all(uniqueStrings(ids, { upper: true }).map((code) => readCoupon(code)));
  return rows
    .filter(Boolean)
    .filter((row) => (includeDeleted ? true : !row.deleted))
    .filter((row) => (includeInactive ? true : row.status === COUPON_STATUS.ACTIVE))
    .sort(sortCoupons);
}

export async function upsertCoupon(input = {}) {
  const couponCode = normalizeCouponCode(input.couponCode);
  if (!couponCode) throw new Error("upsertCoupon: couponCode is required");

  const previous = await readCoupon(couponCode);
  const next = buildCoupon(input, previous);

  await writeCouponRecord(next);
  await syncCouponIndexes(previous, next);

  await emitCouponAudit(previous ? "COUPON_UPDATED" : "COUPON_CREATED", next, {
    couponCode: next.couponCode,
    summary: previous ? "Cupom atualizado" : "Cupom criado",
    before: previous || {},
    after: next,
  });

  await emitCouponReport(previous ? "coupon_updated" : "coupon_created", next, {
    couponCode: next.couponCode,
    status: next.status,
    meta: { active: next.active },
  });

  return next;
}

export async function setCouponActive(couponCode, active, extra = {}) {
  const current = await readCoupon(couponCode);
  if (!current) throw new Error("setCouponActive: coupon not found");
  return upsertCoupon({
    ...current,
    ...extra,
    couponCode: current.couponCode,
    status: toBool(active, true) ? COUPON_STATUS.ACTIVE : COUPON_STATUS.INACTIVE,
    active: toBool(active, true),
  });
}

export async function deleteCoupon(couponCode, extra = {}) {
  const current = await readCoupon(couponCode);
  if (!current) return null;

  const next = buildCoupon({
    ...current,
    ...extra,
    couponCode: current.couponCode,
    deleted: true,
    status: COUPON_STATUS.DELETED,
    active: false,
  }, current);

  await writeCouponRecord(next);
  await syncCouponIndexes(current, next);

  await emitCouponAudit("COUPON_DELETED", next, {
    summary: "Cupom removido logicamente",
    before: current,
    after: next,
  });

  await emitCouponReport("coupon_deleted", next, {
    status: next.status,
  });

  return next;
}

export async function validateCouponEligibility({
  internalUserId = "",
  couponCode = "",
  planCode = "",
  billingCycle = "",
  basePriceCents = 0,
  trackConversion = false,
  trackingMode = "auto",
  source = "coupons",
} = {}) {
  const context = await buildEligibilityContext({
    internalUserId,
    couponCode,
    planCode,
    billingCycle,
    basePriceCents,
  });

  const {
    coupon,
    duplicateReservation,
    userStatus,
    userPlan,
    redemptionCountTotal,
    redemptionCountByUser,
    hasPriorPurchase,
    plan,
    billingOption,
  } = context;

  const conversionTrackingMode = resolveCouponConversionTrackingMode({
    trackingMode,
    trackConversion,
    source,
  });

  await emitCouponMetric({
    eventName: "coupon_attempted",
    couponCode: context.couponCode,
    internalUserId: context.internalUserId,
    planCode: context.planCode,
    billingCycle: context.billingCycle,
    basePriceCents: context.basePriceCents,
  });

  if (!context.couponCode) {
    const result = buildEligibilityFailure("coupon_code_required", "couponCode required");
    return { ...result, context };
  }

  if (!coupon || coupon.deleted || coupon.status === COUPON_STATUS.DELETED) {
    const result = buildEligibilityFailure("coupon_not_found", "Coupon not found", { context });
    if (shouldEmitCouponConversion(conversionTrackingMode, "rejected")) {
      await emitCouponConversionMetricSafe("rejected", {
        internalUserId: context.internalUserId,
        couponCode: context.couponCode,
        planCode: context.planCode,
        billingCycle: context.billingCycle,
        source,
        step: result.code,
      });
    }
    await emitCouponAudit("COUPON_REJECTED", context, {
      couponCode: context.couponCode,
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      summary: "Cupom inexistente ou removido",
      meta: { code: result.code },
    });
    await emitCouponMetric({
      eventName: "coupon_rejected",
      couponCode: context.couponCode,
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      basePriceCents: context.basePriceCents,
    });
    return { ...result, context };
  }

  if (coupon.status !== COUPON_STATUS.ACTIVE || !coupon.active) {
    const result = buildEligibilityFailure("coupon_inactive", "Coupon inactive", { context });
    if (shouldEmitCouponConversion(conversionTrackingMode, "rejected")) {
      await emitCouponConversionMetricSafe("rejected", {
        internalUserId: context.internalUserId,
        couponCode: coupon.couponCode,
        planCode: context.planCode,
        billingCycle: context.billingCycle,
        source,
        step: result.code,
      });
    }
    await emitCouponAudit("COUPON_REJECTED", coupon, {
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      summary: "Cupom inativo",
      meta: { code: result.code },
    });
    await emitCouponMetric({
      eventName: "coupon_rejected",
      couponCode: coupon.couponCode,
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      basePriceCents: context.basePriceCents,
    });
    return { ...result, context };
  }

  if (!plan || !billingOption || billingOption.enabled === false) {
    const result = buildEligibilityFailure("plan_or_cycle_invalid", "Plan or billing cycle invalid", { context });
    if (shouldEmitCouponConversion(conversionTrackingMode, "rejected")) {
      await emitCouponConversionMetricSafe("rejected", {
        internalUserId: context.internalUserId,
        couponCode: coupon.couponCode,
        planCode: context.planCode,
        billingCycle: context.billingCycle,
        source,
        step: result.code,
      });
    }
    await emitCouponAudit("COUPON_REJECTED", coupon, {
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      summary: "Plano ou ciclo inválido para o checkout",
      meta: { code: result.code },
    });
    await emitCouponMetric({
      eventName: "coupon_rejected",
      couponCode: coupon.couponCode,
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      basePriceCents: context.basePriceCents,
    });
    return { ...result, context };
  }

  const currentMs = nowMs();
  const validFromMs = isoToMs(coupon.validFrom);
  const validUntilMs = isoToMs(coupon.validUntil);

  if (validFromMs && currentMs < validFromMs) {
    const result = buildEligibilityFailure("coupon_not_started", "Coupon validity has not started", { context });
    if (shouldEmitCouponConversion(conversionTrackingMode, "rejected")) {
      await emitCouponConversionMetricSafe("rejected", {
        internalUserId: context.internalUserId,
        couponCode: coupon.couponCode,
        planCode: context.planCode,
        billingCycle: context.billingCycle,
        source,
        step: result.code,
      });
    }
    await emitCouponMetric({
      eventName: "coupon_rejected",
      couponCode: coupon.couponCode,
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      basePriceCents: context.basePriceCents,
    });
    return { ...result, context };
  }

  if (validUntilMs && currentMs > validUntilMs) {
    const result = buildEligibilityFailure("coupon_expired", "Coupon expired", { context });
    if (shouldEmitCouponConversion(conversionTrackingMode, "rejected")) {
      await emitCouponConversionMetricSafe("rejected", {
        internalUserId: context.internalUserId,
        couponCode: coupon.couponCode,
        planCode: context.planCode,
        billingCycle: context.billingCycle,
        source,
        step: result.code,
      });
    }
    await emitCouponMetric({
      eventName: "coupon_rejected",
      couponCode: coupon.couponCode,
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      basePriceCents: context.basePriceCents,
    });
    return { ...result, context };
  }

  if (coupon.eligiblePlanCodes.length && !coupon.eligiblePlanCodes.includes(context.planCode)) {
    const result = buildEligibilityFailure("coupon_plan_not_allowed", "Coupon not allowed for selected plan", { context });
    if (shouldEmitCouponConversion(conversionTrackingMode, "rejected")) {
      await emitCouponConversionMetricSafe("rejected", {
        internalUserId: context.internalUserId,
        couponCode: coupon.couponCode,
        planCode: context.planCode,
        billingCycle: context.billingCycle,
        source,
        step: result.code,
      });
    }
    await emitCouponMetric({
      eventName: "coupon_rejected",
      couponCode: coupon.couponCode,
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      basePriceCents: context.basePriceCents,
    });
    return { ...result, context };
  }

  if (coupon.eligibleBillingCycles.length && !coupon.eligibleBillingCycles.includes(context.billingCycle)) {
    const result = buildEligibilityFailure("coupon_cycle_not_allowed", "Coupon not allowed for selected billing cycle", { context });
    if (shouldEmitCouponConversion(conversionTrackingMode, "rejected")) {
      await emitCouponConversionMetricSafe("rejected", {
        internalUserId: context.internalUserId,
        couponCode: coupon.couponCode,
        planCode: context.planCode,
        billingCycle: context.billingCycle,
        source,
        step: result.code,
      });
    }
    await emitCouponMetric({
      eventName: "coupon_rejected",
      couponCode: coupon.couponCode,
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      basePriceCents: context.basePriceCents,
    });
    return { ...result, context };
  }

  if (coupon.maxRedemptionsTotal && redemptionCountTotal >= coupon.maxRedemptionsTotal) {
    const result = buildEligibilityFailure("coupon_total_limit_reached", "Coupon total limit reached", { context });
    if (shouldEmitCouponConversion(conversionTrackingMode, "rejected")) {
      await emitCouponConversionMetricSafe("rejected", {
        internalUserId: context.internalUserId,
        couponCode: coupon.couponCode,
        planCode: context.planCode,
        billingCycle: context.billingCycle,
        source,
        step: result.code,
      });
    }
    await emitCouponMetric({
      eventName: "coupon_rejected",
      couponCode: coupon.couponCode,
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      basePriceCents: context.basePriceCents,
    });
    return { ...result, context };
  }

  if (coupon.maxRedemptionsPerUser && redemptionCountByUser >= coupon.maxRedemptionsPerUser) {
    const result = buildEligibilityFailure("coupon_user_limit_reached", "Coupon user limit reached", { context });
    if (shouldEmitCouponConversion(conversionTrackingMode, "rejected")) {
      await emitCouponConversionMetricSafe("rejected", {
        internalUserId: context.internalUserId,
        couponCode: coupon.couponCode,
        planCode: context.planCode,
        billingCycle: context.billingCycle,
        source,
        step: result.code,
      });
    }
    await emitCouponMetric({
      eventName: "coupon_rejected",
      couponCode: coupon.couponCode,
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      basePriceCents: context.basePriceCents,
    });
    return { ...result, context };
  }

  const activePlanDetected = userStatus === "ACTIVE" && Boolean(userPlan);
  if (coupon.onlyWithoutActivePlan && activePlanDetected) {
    const result = buildEligibilityFailure("coupon_requires_no_active_plan", "Coupon requires user without active plan", { context });
    if (shouldEmitCouponConversion(conversionTrackingMode, "rejected")) {
      await emitCouponConversionMetricSafe("rejected", {
        internalUserId: context.internalUserId,
        couponCode: coupon.couponCode,
        planCode: context.planCode,
        billingCycle: context.billingCycle,
        source,
        step: result.code,
      });
    }
    await emitCouponMetric({
      eventName: "coupon_rejected",
      couponCode: coupon.couponCode,
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      basePriceCents: context.basePriceCents,
    });
    return { ...result, context };
  }

  if (coupon.firstPurchaseOnly && (hasPriorPurchase || activePlanDetected)) {
    const result = buildEligibilityFailure("coupon_first_purchase_only", "Coupon valid only for first purchase", { context });
    if (shouldEmitCouponConversion(conversionTrackingMode, "rejected")) {
      await emitCouponConversionMetricSafe("rejected", {
        internalUserId: context.internalUserId,
        couponCode: coupon.couponCode,
        planCode: context.planCode,
        billingCycle: context.billingCycle,
        source,
        step: result.code,
      });
    }
    await emitCouponMetric({
      eventName: "coupon_rejected",
      couponCode: coupon.couponCode,
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      basePriceCents: context.basePriceCents,
    });
    return { ...result, context };
  }

  if (duplicateReservation) {
    const result = buildEligibilityFailure("coupon_duplicate_pending_reservation", "Duplicate open reservation found", {
      context,
      duplicateReservation,
    });
    if (shouldEmitCouponConversion(conversionTrackingMode, "rejected")) {
      await emitCouponConversionMetricSafe("rejected", {
        internalUserId: context.internalUserId,
        couponCode: coupon.couponCode,
        planCode: context.planCode,
        billingCycle: context.billingCycle,
        source,
        step: result.code,
      });
    }
    
    await emitCouponAudit("COUPON_DUPLICATE_BLOCKED", coupon, {
      internalUserId: context.internalUserId,
      reservationId: duplicateReservation.reservationId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      summary: "Reserva duplicada bloqueada",
      meta: { code: result.code },
    });
    await emitCouponMetric({
      eventName: "coupon_duplicate_blocked",
      couponCode: coupon.couponCode,
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      basePriceCents: context.basePriceCents,
    });
    return { ...result, context };
  }

  const base = context.basePriceCents;
  const discountAmountCents = computeDiscountAmountCents({
    discountType: coupon.discountType,
    discountPercent: coupon.discountPercent,
    discountAmountCents: coupon.discountAmountCents,
    discountCapCents: coupon.discountCapCents,
    basePriceCents: base,
  });
  const finalPriceCents = Math.max(0, base - discountAmountCents);

  const result = {
    ok: true,
    eligible: true,
    code: "coupon_valid",
    reason: "",
    coupon,
    context,
    calculation: {
      basePriceCents: base,
      discountAmountCents,
      finalPriceCents,
      appliesTo: coupon.appliesTo,
      discountType: coupon.discountType,
      discountPercent: coupon.discountPercent,
      discountAmountCentsConfigured: coupon.discountAmountCents,
      discountCapCents: coupon.discountCapCents,
    },
  };

  await emitCouponAudit("COUPON_VALIDATED", coupon, {
    internalUserId: context.internalUserId,
    planCode: context.planCode,
    billingCycle: context.billingCycle,
    summary: "Cupom validado com sucesso",
    meta: {
      basePriceCents: base,
      discountAmountCents,
      finalPriceCents,
      appliesTo: coupon.appliesTo,
    },
  });

  await emitCouponMetric({
    eventName: "coupon_validated",
    couponCode: coupon.couponCode,
    internalUserId: context.internalUserId,
    planCode: context.planCode,
    billingCycle: context.billingCycle,
    basePriceCents: base,
    discountAmountCents,
    finalPriceCents,
  });

  if (shouldEmitCouponConversion(conversionTrackingMode, "rejected")) {
    await emitCouponConversionMetricSafe("applied", {
      internalUserId: context.internalUserId,
      couponCode: coupon.couponCode,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      source,
      step: result.code,
    });
  }

  return result;
}

export async function createCouponReservation({
  internalUserId = "",
  couponCode = "",
  planCode = "",
  billingCycle = "",
  basePriceCents = 0,
  selectionSnapshot = {},
  reservationTtlHours = DEFAULT_RESERVATION_TTL_HOURS,
  meta = {},
} = {}) {
  const eligibility = await validateCouponEligibility({
    internalUserId,
    couponCode,
    planCode,
    billingCycle,
    basePriceCents,
  });

  if (!eligibility.ok) return eligibility;

  const sequence = await redisNextCouponReservationSequence();
  const reservationId = makeReservationId(sequence);
  const ttlHours = resolveReservationHours({ reservationTtlHours });
  const reservedAtMs = nowMs();
  const expiresAtMs = reservedAtMs + ttlHours * 60 * 60 * 1000;

  const reservation = buildReservation({
    reservationId,
    couponCode: eligibility.coupon.couponCode,
    internalUserId: safeStr(internalUserId),
    planCode: normalizePlanCode(planCode),
    billingCycle: normalizeBillingCycle(billingCycle),
    status: RESERVATION_STATUS.RESERVED,
    appliesTo: eligibility.coupon.appliesTo,
    basePriceCents: eligibility.calculation.basePriceCents,
    discountAmountCents: eligibility.calculation.discountAmountCents,
    finalPriceCents: eligibility.calculation.finalPriceCents,
    reservedAt: new Date(reservedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    selectionSnapshot: {
      ...sanitizeSelectionSnapshot(selectionSnapshot),
      internalUserId: safeStr(internalUserId),
      planCode: normalizePlanCode(planCode),
      billingCycle: normalizeBillingCycle(billingCycle),
      couponCode: normalizeCouponCode(couponCode),
      basePriceCents: eligibility.calculation.basePriceCents,
      discountAmountCents: eligibility.calculation.discountAmountCents,
      finalPriceCents: eligibility.calculation.finalPriceCents,
      appliesTo: eligibility.coupon.appliesTo,
    },
    meta: normalizeMeta(meta),
  });

  await writeReservationRecord(reservation);
  await syncReservationIndexes(null, reservation);

  await emitCouponAudit("COUPON_RESERVED", reservation, {
    summary: "Reserva de cupom criada",
    meta: { ttlHours },
  });
  await emitCouponMetric({
    eventName: "coupon_reserved",
    couponCode: reservation.couponCode,
    internalUserId: reservation.internalUserId,
    planCode: reservation.planCode,
    billingCycle: reservation.billingCycle,
    basePriceCents: reservation.basePriceCents,
    discountAmountCents: reservation.discountAmountCents,
    finalPriceCents: reservation.finalPriceCents,
  });
  await emitCouponReport("coupon_reserved", reservation, {
    status: reservation.status,
    meta: { ttlHours },
  });

  return {
    ok: true,
    reservation,
    coupon: eligibility.coupon,
    calculation: eligibility.calculation,
  };
}

export async function getCouponReservation(reservationId) {
  return readReservation(reservationId);
}

export async function listCouponReservations({
  internalUserId = "",
  couponCode = "",
  status = "",
  statuses = [],
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const normalizedStatusList = uniqueStrings(
    [
      ...(Array.isArray(statuses) ? statuses : []),
      status,
    ]
      .map((item) => normalizeReservationStatus(item))
      .filter(Boolean),
    { lower: true }
  );

  let ids = [];
  if (safeStr(internalUserId)) {
    ids = await redisSMembers(redisCouponReservationUserIndexKey(internalUserId));
  } else if (normalizeCouponCode(couponCode)) {
    ids = await redisSMembers(redisCouponReservationCouponIndexKey(couponCode));
  } else if (normalizedStatusList.length === 1) {
    ids = await redisSMembers(redisCouponReservationStatusIndexKey(normalizedStatusList[0]));
  } else {
    const sourceStatuses = normalizedStatusList.length
      ? normalizedStatusList
      : Object.values(RESERVATION_STATUS);
    const parts = await Promise.all(
      sourceStatuses.map((item) => redisSMembers(redisCouponReservationStatusIndexKey(item)))
    );
    ids = parts.flat();
  }

  let rows = await hydrateReservations(ids);

  if (safeStr(internalUserId)) rows = rows.filter((row) => row.internalUserId === safeStr(internalUserId));
  if (normalizeCouponCode(couponCode)) rows = rows.filter((row) => row.couponCode === normalizeCouponCode(couponCode));
  if (normalizedStatusList.length) rows = rows.filter((row) => normalizedStatusList.includes(row.status));

  return rows.slice(0, normalizeListLimit(limit));
}

export async function listExpiredPendingCouponReservations({
  now = new Date(),
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const nowValue = now instanceof Date ? now.getTime() : Number(now);
  const normalizedNow = Number.isFinite(nowValue) ? nowValue : Date.now();
  const ids = await redisZRangeByScore(
    redisCouponReservationPendingIndexKey(),
    0,
    normalizedNow,
    normalizeListLimit(limit)
  );
  const rows = await hydrateReservations(ids);
  return rows.filter((row) => row.status === RESERVATION_STATUS.RESERVED && isoToMs(row.expiresAt) <= normalizedNow);
}

async function transitionReservation(reservationId, nextStatus, patch = {}, eventName = "", metricEvent = "") {
  const previous = await readReservation(reservationId);
  if (!previous) {
    return { ok: false, error: "reservation_not_found" };
  }

  const allowedStatus = normalizeReservationStatus(nextStatus);

  if (previous.status === allowedStatus) {
    return { ok: true, alreadyApplied: true, previous, reservation: previous };
  }

  const next = buildReservation(
    {
      ...previous,
      ...patch,
      reservationId: previous.reservationId,
      status: allowedStatus,
    },
    previous
  );

  await writeReservationRecord(next);
  await syncReservationIndexes(previous, next);

  await emitCouponAudit(eventName, next, {
    summary: `Reserva alterada para ${allowedStatus}`,
    before: previous,
    after: next,
  });

  if (metricEvent) {
    await emitCouponMetric({
      eventName: metricEvent,
      couponCode: next.couponCode,
      internalUserId: next.internalUserId,
      planCode: next.planCode,
      billingCycle: next.billingCycle,
      basePriceCents: next.basePriceCents,
      discountAmountCents: next.discountAmountCents,
      finalPriceCents: next.finalPriceCents,
    });
  }

  await emitCouponReport(metricEvent || eventName.toLowerCase(), next, {
    status: next.status,
    paymentId: next.paymentId,
    subscriptionId: next.subscriptionId,
    reason: patch.releaseReason || patch.failureReason || patch.cancellationReason || "",
    meta: normalizeMeta(patch.meta),
  });

  return { ok: true, previous, reservation: next };
}

export async function confirmCouponReservation(
  reservationId,
  { paymentId = "", subscriptionId = "", meta = {} } = {}
) {
  return transitionReservation(
    reservationId,
    RESERVATION_STATUS.CONFIRMED,
    {
      confirmedAt: nowIso(),
      paymentId,
      subscriptionId,
      meta: { ...normalizeMeta(meta), transition: "confirmed" },
    },
    "COUPON_CONFIRMED",
    "coupon_confirmed"
  );
}

export async function releaseCouponReservation(
  reservationId,
  { reason = "", paymentId = "", subscriptionId = "", meta = {} } = {}
) {
  return transitionReservation(
    reservationId,
    RESERVATION_STATUS.RELEASED,
    {
      releasedAt: nowIso(),
      releaseReason: safeStr(reason) || "released",
      paymentId,
      subscriptionId,
      meta: { ...normalizeMeta(meta), transition: "released" },
    },
    "COUPON_RELEASED",
    "coupon_released"
  );
}

export async function expireCouponReservation(reservationId, { reason = "", meta = {} } = {}) {
  return transitionReservation(
    reservationId,
    RESERVATION_STATUS.EXPIRED,
    {
      expiredAt: nowIso(),
      releaseReason: safeStr(reason) || "expired",
      meta: { ...normalizeMeta(meta), transition: "expired" },
    },
    "COUPON_EXPIRED",
    "coupon_expired"
  );
}

export async function failCouponReservation(
  reservationId,
  { reason = "", paymentId = "", subscriptionId = "", meta = {} } = {}
) {
  return transitionReservation(
    reservationId,
    RESERVATION_STATUS.FAILED,
    {
      failedAt: nowIso(),
      failureReason: safeStr(reason) || "failed",
      paymentId,
      subscriptionId,
      meta: { ...normalizeMeta(meta), transition: "failed" },
    },
    "COUPON_FAILED",
    "coupon_failed"
  );
}

export async function cancelCouponReservation(
  reservationId,
  { reason = "", paymentId = "", subscriptionId = "", meta = {} } = {}
) {
  return transitionReservation(
    reservationId,
    RESERVATION_STATUS.CANCELLED,
    {
      cancelledAt: nowIso(),
      cancellationReason: safeStr(reason) || "cancelled",
      paymentId,
      subscriptionId,
      meta: { ...normalizeMeta(meta), transition: "cancelled" },
    },
    "COUPON_CANCELLED",
    ""
  );
}

// Importante:
// - coupon_removed_message_sent é um evento operacional de timeout/automação.
// - coupon_removed (funil oficial) pertence ao fluxo de UX explícita e NÃO deve ser emitido aqui.
export async function markCouponRemovedMessageSent(reservationId, { sentAt = "", meta = {}, trackConversion = false, trackingMode = "auto", source = "coupons" } = {}) {
  const previous = await readReservation(reservationId);
  if (!previous) return { ok: false, error: "reservation_not_found" };

  if (safeStr(previous.messageSentAt)) {
    return { ok: true, alreadyMarked: true, previous, reservation: previous };
  }

  const next = buildReservation(
    {
      ...previous,
      messageSentAt: normalizeIso(sentAt) || nowIso(),
      meta: { ...previous.meta, ...normalizeMeta(meta), couponRemovedMessageSent: true },
    },
    previous
  );

  await writeReservationRecord(next);
  await emitCouponAudit("COUPON_REMOVED_MESSAGE_SENT", next, {
    summary: "Mensagem de remoção de cupom enviada",
    before: previous,
    after: next,
  });
  await emitCouponMetric({
    eventName: "coupon_removed_message_sent",
    couponCode: next.couponCode,
    internalUserId: next.internalUserId,
    planCode: next.planCode,
    billingCycle: next.billingCycle,
    basePriceCents: next.basePriceCents,
    discountAmountCents: next.discountAmountCents,
    finalPriceCents: next.finalPriceCents,
  });
  await emitCouponReport("coupon_removed_message_sent", next, {
    status: next.status,
    meta: normalizeMeta(meta),
  });

  return { ok: true, previous, reservation: next };
}

export async function listCouponReportRows({
  couponCode = "",
  internalUserId = "",
  eventName = "",
  status = "",
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const ids = await redisSMembers(redisCouponReportIndexKey());
  const uniqueIds = uniqueStrings(ids);
  const rows = await Promise.all(uniqueIds.map((id) => readReportRow(id)));
  let filtered = rows.filter(Boolean);

  const code = normalizeCouponCode(couponCode);
  const userId = safeStr(internalUserId);
  const event = toLower(eventName);
  const normalizedStatus = status ? normalizeReservationStatus(status) : "";

  if (code) filtered = filtered.filter((row) => row.couponCode === code);
  if (userId) filtered = filtered.filter((row) => row.internalUserId === userId);
  if (event) filtered = filtered.filter((row) => row.eventName === event);
  if (normalizedStatus) filtered = filtered.filter((row) => row.status === normalizedStatus);

  return filtered.sort(sortReportRowsDesc).slice(0, normalizeListLimit(limit));
}

export async function getCouponUsageSummary(couponCode = "") {
  const code = normalizeCouponCode(couponCode);
  if (!code) return { ok: false, error: "couponCode required" };

  const coupon = await readCoupon(code);
  if (!coupon) return { ok: false, error: "coupon_not_found" };

  const reservations = await listCouponReservations({ couponCode: code, limit: MAX_LIST_LIMIT });
  const redemptions = reservations.filter((row) => row.status === RESERVATION_STATUS.CONFIRMED);
  const pending = reservations.filter((row) => row.status === RESERVATION_STATUS.RESERVED);
  const released = reservations.filter((row) => row.status === RESERVATION_STATUS.RELEASED);
  const expired = reservations.filter((row) => row.status === RESERVATION_STATUS.EXPIRED);
  const failed = reservations.filter((row) => row.status === RESERVATION_STATUS.FAILED);
  const cancelled = reservations.filter((row) => row.status === RESERVATION_STATUS.CANCELLED);

  const totalBase = redemptions.reduce((sum, row) => sum + toNonNegativeInt(row.basePriceCents, 0), 0);
  const totalDiscount = redemptions.reduce((sum, row) => sum + toNonNegativeInt(row.discountAmountCents, 0), 0);
  const totalFinal = redemptions.reduce((sum, row) => sum + toNonNegativeInt(row.finalPriceCents, 0), 0);

  return {
    ok: true,
    coupon,
    counts: {
      reservations: reservations.length,
      pending: pending.length,
      confirmed: redemptions.length,
      released: released.length,
      expired: expired.length,
      failed: failed.length,
      cancelled: cancelled.length,
    },
    amounts: {
      basePriceCents: totalBase,
      discountAmountCents: totalDiscount,
      finalPriceCents: totalFinal,
    },
  };
}

export async function getCouponReservationUsageByUser(internalUserId, couponCode = "") {
  const userId = safeStr(internalUserId);
  const code = normalizeCouponCode(couponCode);
  if (!userId) return { ok: false, error: "internalUserId required" };

  const reservations = await listCouponReservations({
    internalUserId: userId,
    couponCode: code,
    limit: MAX_LIST_LIMIT,
  });

  return {
    ok: true,
    internalUserId: userId,
    couponCode: code || null,
    reservations,
    counts: {
      total: reservations.length,
      confirmed: reservations.filter((row) => row.status === RESERVATION_STATUS.CONFIRMED).length,
      pending: reservations.filter((row) => row.status === RESERVATION_STATUS.RESERVED).length,
    },
  };
}

export const COUPON_STATUS_VALUES = COUPON_STATUS;
export const COUPON_RESERVATION_STATUS_VALUES = RESERVATION_STATUS;
export const COUPON_DISCOUNT_TYPE_VALUES = DISCOUNT_TYPE;
export const COUPON_APPLIES_TO_VALUES = APPLIES_TO;
export const COUPON_DEFAULT_RESERVATION_TTL_HOURS = DEFAULT_RESERVATION_TTL_HOURS;
export const COUPON_CONVERSION_TRACKING_MODE_VALUES = COUPON_CONVERSION_TRACKING_MODE;
