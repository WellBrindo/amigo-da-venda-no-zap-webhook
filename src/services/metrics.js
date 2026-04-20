// src/services/metrics.js
// ✅ V16.4.10 — Métricas de uso (descrições) global e por usuário canônico
// Objetivo:
// - Contadores baratos e estáveis (INCRBY) para:
//   - Global por dia e por mês
//   - Por usuário por dia e por mês
// - Com TTL para não crescer infinito
//
// Chaves:
// - metrics:desc:global:day:{YYYY-MM-DD}   => INT
// - metrics:desc:global:month:{YYYY-MM}    => INT
// - metrics:desc:user:{userId}:day:{YYYY-MM-DD}   => INT
// - metrics:desc:user:{userId}:month:{YYYY-MM}    => INT
//
// Observação:
// - Esse contador é "descrições geradas com sucesso" (após resposta da OpenAI).
// - Não substitui trialUsed/quotaUsed; é complementar para dashboard.

import { redisGet, redisIncrBy, redisExpire, redisDel } from "./redis.js";

const FEEDBACK_EVENTS = Object.freeze([
  "feedback_asked",
  "feedback_answered",
  "feedback_positive",
  "feedback_neutral",
  "feedback_negative",
  "feedback_comment_saved",
  "testimonial_asked",
  "testimonial_created",
  "testimonial_consent_yes",
  "testimonial_consent_no",
  "testimonial_display_first_name",
  "testimonial_display_company",
  "testimonial_display_anonymous",
  "testimonial_review_approved",
  "testimonial_review_rejected",
  "testimonial_review_published",
]);

const COUPON_EVENTS = Object.freeze([
  "coupon_attempted",
  "coupon_validated",
  "coupon_rejected",
  "coupon_reserved",
  "coupon_confirmed",
  "coupon_released",
  "coupon_expired",
  "coupon_failed",
  "coupon_duplicate_blocked",
  "coupon_removed_message_sent",
]);

const COUPON_AMOUNT_FIELDS = Object.freeze([
  "original_cents",
  "discount_cents",
  "final_cents",
]);

const TTL_DAY_SECONDS = 60 * 60 * 24 * 90;    // 90 dias
const TTL_MONTH_SECONDS = 60 * 60 * 24 * 450; // ~15 meses

function safeStr(v) {
  return String(v ?? "").trim();
}

function normalizeUserMetricRef(userRef) {
  return safeStr(userRef);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Retorna datas no fuso do servidor.
 * (No Render, normalmente UTC; para métricas é OK e estável)
 */
export function getDayKeyParts(date = new Date()) {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  return { day: `${y}-${m}-${d}`, month: `${y}-${m}` };
}

function kGlobalDay(day) {
  return `metrics:desc:global:day:${day}`;
}
function kGlobalMonth(month) {
  return `metrics:desc:global:month:${month}`;
}
function kUserDay(userRef, day) {
  return `metrics:desc:user:${userRef}:day:${day}`;
}
function kUserMonth(userRef, month) {
  return `metrics:desc:user:${userRef}:month:${month}`;
}


function normalizeMetricEventName(eventName) {
  return String(eventName ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
}

function kEventGlobalDay(eventName, day) {
  return `metrics:event:${eventName}:global:day:${day}`;
}
function kEventGlobalMonth(eventName, month) {
  return `metrics:event:${eventName}:global:month:${month}`;
}
function kEventUserDay(userRef, eventName, day) {
  return `metrics:event:${eventName}:user:${userRef}:day:${day}`;
}
function kEventUserMonth(userRef, eventName, month) {
  return `metrics:event:${eventName}:user:${userRef}:month:${month}`;
}

function normalizeMetricSlug(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeCouponMetricCode(value) {
  return normalizeMetricSlug(value).toUpperCase();
}

function normalizePlanMetricCode(value) {
  return normalizeMetricSlug(value).toUpperCase();
}

function normalizeBillingCycleMetric(value) {
  const cycle = normalizeMetricSlug(value);
  if (cycle === "monthly" || cycle === "annual") return cycle;
  return cycle || "unknown";
}

function normalizeAmountMetricValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

function kCouponEventGlobalDay(eventName, day) {
  return `metrics:coupon:event:${eventName}:global:day:${day}`;
}
function kCouponEventGlobalMonth(eventName, month) {
  return `metrics:coupon:event:${eventName}:global:month:${month}`;
}
function kCouponEventUserDay(userRef, eventName, day) {
  return `metrics:coupon:event:${eventName}:user:${userRef}:day:${day}`;
}
function kCouponEventUserMonth(userRef, eventName, month) {
  return `metrics:coupon:event:${eventName}:user:${userRef}:month:${month}`;
}
function kCouponEventCouponDay(couponCode, eventName, day) {
  return `metrics:coupon:event:${eventName}:coupon:${couponCode}:day:${day}`;
}
function kCouponEventCouponMonth(couponCode, eventName, month) {
  return `metrics:coupon:event:${eventName}:coupon:${couponCode}:month:${month}`;
}
function kCouponEventPlanDay(planCode, eventName, day) {
  return `metrics:coupon:event:${eventName}:plan:${planCode}:day:${day}`;
}
function kCouponEventPlanMonth(planCode, eventName, month) {
  return `metrics:coupon:event:${eventName}:plan:${planCode}:month:${month}`;
}
function kCouponEventCycleDay(cycle, eventName, day) {
  return `metrics:coupon:event:${eventName}:cycle:${cycle}:day:${day}`;
}
function kCouponEventCycleMonth(cycle, eventName, month) {
  return `metrics:coupon:event:${eventName}:cycle:${cycle}:month:${month}`;
}

function kCouponAmountGlobalDay(field, day) {
  return `metrics:coupon:amount:${field}:global:day:${day}`;
}
function kCouponAmountGlobalMonth(field, month) {
  return `metrics:coupon:amount:${field}:global:month:${month}`;
}
function kCouponAmountUserDay(userRef, field, day) {
  return `metrics:coupon:amount:${field}:user:${userRef}:day:${day}`;
}
function kCouponAmountUserMonth(userRef, field, month) {
  return `metrics:coupon:amount:${field}:user:${userRef}:month:${month}`;
}
function kCouponAmountCouponDay(couponCode, field, day) {
  return `metrics:coupon:amount:${field}:coupon:${couponCode}:day:${day}`;
}
function kCouponAmountCouponMonth(couponCode, field, month) {
  return `metrics:coupon:amount:${field}:coupon:${couponCode}:month:${month}`;
}
function kCouponAmountPlanDay(planCode, field, day) {
  return `metrics:coupon:amount:${field}:plan:${planCode}:day:${day}`;
}
function kCouponAmountPlanMonth(planCode, field, month) {
  return `metrics:coupon:amount:${field}:plan:${planCode}:month:${month}`;
}
function kCouponAmountCycleDay(cycle, field, day) {
  return `metrics:coupon:amount:${field}:cycle:${cycle}:day:${day}`;
}
function kCouponAmountCycleMonth(cycle, field, month) {
  return `metrics:coupon:amount:${field}:cycle:${cycle}:month:${month}`;
}

export async function incMetricEvent(eventName, { userId = "", waId = "", by = 1, date = new Date() } = {}) {
  const normalizedEvent = normalizeMetricEventName(eventName);
  const inc = Number(by) || 1;
  if (!normalizedEvent) return { ok: false, error: "eventName required" };

  const { day, month } = getDayKeyParts(date);
  const keys = {
    gd: kEventGlobalDay(normalizedEvent, day),
    gm: kEventGlobalMonth(normalizedEvent, month),
  };

  const jobs = [
    redisIncrBy(keys.gd, inc),
    redisIncrBy(keys.gm, inc),
  ];

  const id = normalizeUserMetricRef(userId || waId);
  if (id) {
    keys.ud = kEventUserDay(id, normalizedEvent, day);
    keys.um = kEventUserMonth(id, normalizedEvent, month);
    jobs.push(redisIncrBy(keys.ud, inc));
    jobs.push(redisIncrBy(keys.um, inc));
  }

  const valuesRaw = await Promise.all(jobs);
  const values = {
    gd: valuesRaw[0],
    gm: valuesRaw[1],
  };
  if (id) {
    values.ud = valuesRaw[2];
    values.um = valuesRaw[3];
  }

  const ttlJobs = [
    redisExpire(keys.gd, TTL_DAY_SECONDS),
    redisExpire(keys.gm, TTL_MONTH_SECONDS),
  ];
  if (id) {
    ttlJobs.push(redisExpire(keys.ud, TTL_DAY_SECONDS));
    ttlJobs.push(redisExpire(keys.um, TTL_MONTH_SECONDS));
  }
  await Promise.allSettled(ttlJobs);

  return { ok: true, eventName: normalizedEvent, userId: id || null, waId: id || null, keys, values };
}

export async function getGlobalMetricEvent(eventName, date = new Date()) {
  const normalizedEvent = normalizeMetricEventName(eventName);
  if (!normalizedEvent) return { ok: false, error: "eventName required" };
  const { day, month } = getDayKeyParts(date);
  const [d, m] = await Promise.all([
    redisGet(kEventGlobalDay(normalizedEvent, day)),
    redisGet(kEventGlobalMonth(normalizedEvent, month)),
  ]);
  return {
    ok: true,
    eventName: normalizedEvent,
    day,
    month,
    dayCount: Number(d || 0),
    monthCount: Number(m || 0),
  };
}

export async function getUserMetricEvent(eventName, userRef, date = new Date()) {
  const normalizedEvent = normalizeMetricEventName(eventName);
  const id = normalizeUserMetricRef(userRef);
  if (!normalizedEvent) return { ok: false, error: "eventName required" };
  if (!id) return { ok: false, error: "userId required" };
  const { day, month } = getDayKeyParts(date);
  const [d, m] = await Promise.all([
    redisGet(kEventUserDay(id, normalizedEvent, day)),
    redisGet(kEventUserMonth(id, normalizedEvent, month)),
  ]);
  return {
    ok: true,
    eventName: normalizedEvent,
    userId: id,
    userId: id,
    waId: id,
    day,
    month,
    dayCount: Number(d || 0),
    monthCount: Number(m || 0),
  };
}

export async function getMetricEventLastNDays(eventName, n = 30, endDate = new Date()) {
  const normalizedEvent = normalizeMetricEventName(eventName);
  if (!normalizedEvent) return { ok: false, error: "eventName required" };

  const days = clampInt(n, 1, 365, 30);
  const end = new Date(endDate.getTime());
  const start = addDays(end, -(days - 1));

  const labels = [];
  const keys = [];
  for (let i = 0; i < days; i++) {
    const d = fmtYmd(addDays(start, i));
    labels.push(d);
    keys.push(kEventGlobalDay(normalizedEvent, d));
  }

  const values = [];
  for (const k of keys) {
    const v = await redisGet(k);
    values.push(Number(v || 0));
  }

  return {
    ok: true,
    eventName: normalizedEvent,
    start: labels[0],
    end: labels[labels.length - 1],
    points: labels.map((label, index) => ({ day: label, count: values[index] })),
  };
}

export async function getFeedbackMetricsOverview(date = new Date()) {
  const events = await Promise.all(FEEDBACK_EVENTS.map((eventName) => getGlobalMetricEvent(eventName, date)));
  const eventCounts = Object.fromEntries(events.filter((entry) => entry && entry.ok).map((entry) => [entry.eventName, { dayCount: entry.dayCount, monthCount: entry.monthCount }]));
  return {
    ok: true,
    day: events[0]?.day || getDayKeyParts(date).day,
    month: events[0]?.month || getDayKeyParts(date).month,
    events: eventCounts,
  };
}

/**
 * Incrementa contadores de "descrições geradas"
 * - Global (day/month)
 * - Por usuário (day/month)
 */
export async function incDescriptionMetrics(userRef, by = 1, date = new Date()) {
  const id = normalizeUserMetricRef(userRef);
  const inc = Number(by) || 1;
  if (!id) return { ok: true, skipped: true };

  const { day, month } = getDayKeyParts(date);

  const keys = {
    gd: kGlobalDay(day),
    gm: kGlobalMonth(month),
    ud: kUserDay(id, day),
    um: kUserMonth(id, month),
  };

  // incrementa
  const [gd, gm, ud, um] = await Promise.all([
    redisIncrBy(keys.gd, inc),
    redisIncrBy(keys.gm, inc),
    redisIncrBy(keys.ud, inc),
    redisIncrBy(keys.um, inc),
  ]);

  // TTL best-effort (não quebra se falhar)
  await Promise.allSettled([
    redisExpire(keys.gd, TTL_DAY_SECONDS),
    redisExpire(keys.gm, TTL_MONTH_SECONDS),
    redisExpire(keys.ud, TTL_DAY_SECONDS),
    redisExpire(keys.um, TTL_MONTH_SECONDS),
  ]);

  return { ok: true, keys, values: { gd, gm, ud, um } };
}

/**
 * Lê contadores globais
 */
export async function getGlobalDescriptionMetrics(date = new Date()) {
  const { day, month } = getDayKeyParts(date);
  const [d, m] = await Promise.all([
    redisGet(kGlobalDay(day)),
    redisGet(kGlobalMonth(month)),
  ]);
  return {
    ok: true,
    day,
    month,
    dayCount: Number(d || 0),
    monthCount: Number(m || 0),
  };
}

/**
 * Lê contadores por usuário
 */
export async function getUserDescriptionMetrics(userRef, date = new Date()) {
  const id = normalizeUserMetricRef(userRef);
  const { day, month } = getDayKeyParts(date);
  if (!id) return { ok: false, error: "userId required" };

  const [d, m] = await Promise.all([
    redisGet(kUserDay(id, day)),
    redisGet(kUserMonth(id, month)),
  ]);

  return {
    ok: true,
    waId: id,
    day,
    month,
    dayCount: Number(d || 0),
    monthCount: Number(m || 0),
  };
}

// -----------------------------
// 📈 Histórico (global e por usuário)
// -----------------------------

function isValidYmd(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}
function isValidYm(s) {
  return /^\d{4}-\d{2}$/.test(String(s || ""));
}

function toDateFromYmd(ymd) {
  // Interpreta como data local do servidor (estável).
  const [y, m, d] = String(ymd).split("-").map((x) => Number(x));
  return new Date(y, (m || 1) - 1, d || 1);
}

function fmtYmd(dt) {
  const y = dt.getFullYear();
  const m = pad2(dt.getMonth() + 1);
  const d = pad2(dt.getDate());
  return `${y}-${m}-${d}`;
}

function fmtYm(dt) {
  const y = dt.getFullYear();
  const m = pad2(dt.getMonth() + 1);
  return `${y}-${m}`;
}

function addDays(dt, n) {
  const x = new Date(dt.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

function addMonths(dt, n) {
  const x = new Date(dt.getTime());
  x.setMonth(x.getMonth() + n);
  return x;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * Retorna série diária global dos últimos N dias (inclui hoje).
 * Ex.: N=30 => 30 pontos.
 */
export async function getGlobalLastNDays(n = 30, endDate = new Date()) {
  const days = clampInt(n, 1, 365, 30);
  const end = new Date(endDate.getTime());
  const start = addDays(end, -(days - 1));

  const keys = [];
  const labels = [];
  for (let i = 0; i < days; i++) {
    const d = fmtYmd(addDays(start, i));
    labels.push(d);
    keys.push(kGlobalDay(d));
  }

  const values = [];
  for (const k of keys) {
    const v = await redisGet(k);
    values.push(Number(v || 0));
  }

  return { ok: true, start: labels[0], end: labels[labels.length - 1], points: labels.map((l, i) => ({ day: l, count: values[i] })) };
}

/**
 * Retorna série mensal global dos últimos N meses (inclui mês atual).
 * Ex.: N=12 => 12 pontos.
 */
export async function getGlobalLastNMonths(n = 12, endDate = new Date()) {
  const months = clampInt(n, 1, 36, 12);
  const end = new Date(endDate.getTime());
  // começar no primeiro dia do mês para consistência
  end.setDate(1);
  const start = addMonths(end, -(months - 1));

  const labels = [];
  const keys = [];
  for (let i = 0; i < months; i++) {
    const m = fmtYm(addMonths(start, i));
    labels.push(m);
    keys.push(kGlobalMonth(m));
  }

  const values = [];
  for (const k of keys) {
    const v = await redisGet(k);
    values.push(Number(v || 0));
  }

  return { ok: true, start: labels[0], end: labels[labels.length - 1], points: labels.map((l, i) => ({ month: l, count: values[i] })) };
}

/**
 * Série diária GLOBAL por intervalo personalizado (inclusive).
 * start/end no formato YYYY-MM-DD.
 * Limites: máx 366 dias para proteger produção.
 */
export async function getGlobalDaysRange({ start, end } = {}) {
  const s = safeStr(start);
  const e = safeStr(end);
  if (!isValidYmd(s) || !isValidYmd(e)) return { ok: false, error: "start/end must be YYYY-MM-DD" };

  const ds = toDateFromYmd(s);
  const de = toDateFromYmd(e);
  if (de < ds) return { ok: false, error: "end must be >= start" };

  const diffDays = Math.floor((de.getTime() - ds.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const days = clampInt(diffDays, 1, 366, 30);

  const labels = [];
  const keys = [];
  for (let i = 0; i < days; i++) {
    const d = fmtYmd(addDays(ds, i));
    labels.push(d);
    keys.push(kGlobalDay(d));
  }

  const values = [];
  for (const k of keys) {
    const v = await redisGet(k);
    values.push(Number(v || 0));
  }

  return { ok: true, start: labels[0], end: labels[labels.length - 1], points: labels.map((l, i) => ({ day: l, count: values[i] })) };
}

/**
 * Série diária por usuário (últimos N dias).
 */
export async function getUserLastNDays(userRef, n = 30, endDate = new Date()) {
  const id = normalizeUserMetricRef(userRef);
  if (!id) return { ok: false, error: "userId required" };

  const days = clampInt(n, 1, 365, 30);
  const end = new Date(endDate.getTime());
  const start = addDays(end, -(days - 1));

  const labels = [];
  const keys = [];
  for (let i = 0; i < days; i++) {
    const d = fmtYmd(addDays(start, i));
    labels.push(d);
    keys.push(kUserDay(id, d));
  }

  const values = [];
  for (const k of keys) {
    const v = await redisGet(k);
    values.push(Number(v || 0));
  }

  return { ok: true, userId: id, waId: id, start: labels[0], end: labels[labels.length - 1], points: labels.map((l, i) => ({ day: l, count: values[i] })) };
}

/**
 * Série mensal por usuário (últimos N meses).
 */
export async function getUserLastNMonths(userRef, n = 12, endDate = new Date()) {
  const id = normalizeUserMetricRef(userRef);
  if (!id) return { ok: false, error: "userId required" };

  const months = clampInt(n, 1, 36, 12);
  const end = new Date(endDate.getTime());
  end.setDate(1);
  const start = addMonths(end, -(months - 1));

  const labels = [];
  const keys = [];
  for (let i = 0; i < months; i++) {
    const m = fmtYm(addMonths(start, i));
    labels.push(m);
    keys.push(kUserMonth(id, m));
  }

  const values = [];
  for (const k of keys) {
    const v = await redisGet(k);
    values.push(Number(v || 0));
  }

  return { ok: true, userId: id, waId: id, start: labels[0], end: labels[labels.length - 1], points: labels.map((l, i) => ({ month: l, count: values[i] })) };
}

/**
 * Série diária por usuário por intervalo personalizado (inclusive).
 */
export async function getUserDaysRange({ userId = "", waId = "", start, end } = {}) {
  const id = normalizeUserMetricRef(userId || waId);
  if (!id) return { ok: false, error: "userId required" };

  const s = safeStr(start);
  const e = safeStr(end);
  if (!isValidYmd(s) || !isValidYmd(e)) return { ok: false, error: "start/end must be YYYY-MM-DD" };

  const ds = toDateFromYmd(s);
  const de = toDateFromYmd(e);
  if (de < ds) return { ok: false, error: "end must be >= start" };

  const diffDays = Math.floor((de.getTime() - ds.getTime()) / (24 * 60 * 60 * 1000)) + 1;
  const days = clampInt(diffDays, 1, 366, 30);

  const labels = [];
  const keys = [];
  for (let i = 0; i < days; i++) {
    const d = fmtYmd(addDays(ds, i));
    labels.push(d);
    keys.push(kUserDay(id, d));
  }

  const values = [];
  for (const k of keys) {
    const v = await redisGet(k);
    values.push(Number(v || 0));
  }

  return { ok: true, userId: id, waId: id, start: labels[0], end: labels[labels.length - 1], points: labels.map((l, i) => ({ day: l, count: values[i] })) };
}

export async function recordCouponMetricEvent(
  eventName,
  { userId = "", waId = "", couponCode = "", planCode = "", billingCycle = "", by = 1, date = new Date() } = {}
) {
  const normalizedEvent = normalizeMetricEventName(eventName);
  const inc = Number(by) || 1;
  if (!normalizedEvent) return { ok: false, error: "eventName required" };

  const id = normalizeUserMetricRef(userId || waId);
  const normalizedCouponCode = normalizeCouponMetricCode(couponCode);
  const normalizedPlanCode = normalizePlanMetricCode(planCode);
  const normalizedBillingCycle = normalizeBillingCycleMetric(billingCycle);
  const { day, month } = getDayKeyParts(date);

  const keys = {
    gd: kCouponEventGlobalDay(normalizedEvent, day),
    gm: kCouponEventGlobalMonth(normalizedEvent, month),
  };
  const jobs = [
    redisIncrBy(keys.gd, inc),
    redisIncrBy(keys.gm, inc),
  ];

  if (id) {
    keys.ud = kCouponEventUserDay(id, normalizedEvent, day);
    keys.um = kCouponEventUserMonth(id, normalizedEvent, month);
    jobs.push(redisIncrBy(keys.ud, inc));
    jobs.push(redisIncrBy(keys.um, inc));
  }
  if (normalizedCouponCode) {
    keys.cd = kCouponEventCouponDay(normalizedCouponCode, normalizedEvent, day);
    keys.cm = kCouponEventCouponMonth(normalizedCouponCode, normalizedEvent, month);
    jobs.push(redisIncrBy(keys.cd, inc));
    jobs.push(redisIncrBy(keys.cm, inc));
  }
  if (normalizedPlanCode) {
    keys.pd = kCouponEventPlanDay(normalizedPlanCode, normalizedEvent, day);
    keys.pm = kCouponEventPlanMonth(normalizedPlanCode, normalizedEvent, month);
    jobs.push(redisIncrBy(keys.pd, inc));
    jobs.push(redisIncrBy(keys.pm, inc));
  }
  if (normalizedBillingCycle && normalizedBillingCycle !== "unknown") {
    keys.bd = kCouponEventCycleDay(normalizedBillingCycle, normalizedEvent, day);
    keys.bm = kCouponEventCycleMonth(normalizedBillingCycle, normalizedEvent, month);
    jobs.push(redisIncrBy(keys.bd, inc));
    jobs.push(redisIncrBy(keys.bm, inc));
  }

  const valuesRaw = await Promise.all(jobs);
  const ttlJobs = Object.values(keys).map((key) => redisExpire(key, key.includes(":day:") ? TTL_DAY_SECONDS : TTL_MONTH_SECONDS));
  await Promise.allSettled(ttlJobs);

  return {
    ok: true,
    eventName: normalizedEvent,
    userId: id || null,
    couponCode: normalizedCouponCode || null,
    planCode: normalizedPlanCode || null,
    billingCycle: normalizedBillingCycle || null,
    keys,
    valueCount: valuesRaw.length,
  };
}

export async function addCouponMetricAmounts(
  { userId = "", waId = "", couponCode = "", planCode = "", billingCycle = "", originalCents = 0, discountCents = 0, finalCents = 0, date = new Date() } = {}
) {
  const id = normalizeUserMetricRef(userId || waId);
  const normalizedCouponCode = normalizeCouponMetricCode(couponCode);
  const normalizedPlanCode = normalizePlanMetricCode(planCode);
  const normalizedBillingCycle = normalizeBillingCycleMetric(billingCycle);
  const { day, month } = getDayKeyParts(date);

  const amounts = {
    original_cents: normalizeAmountMetricValue(originalCents),
    discount_cents: normalizeAmountMetricValue(discountCents),
    final_cents: normalizeAmountMetricValue(finalCents),
  };

  const scheduled = [];
  const keys = {};
  for (const [field, amount] of Object.entries(amounts)) {
    if (!amount) continue;

    const baseKeys = {
      gd: kCouponAmountGlobalDay(field, day),
      gm: kCouponAmountGlobalMonth(field, month),
    };
    keys[field] = { ...baseKeys };
    scheduled.push(redisIncrBy(baseKeys.gd, amount), redisIncrBy(baseKeys.gm, amount));

    if (id) {
      keys[field].ud = kCouponAmountUserDay(id, field, day);
      keys[field].um = kCouponAmountUserMonth(id, field, month);
      scheduled.push(redisIncrBy(keys[field].ud, amount), redisIncrBy(keys[field].um, amount));
    }
    if (normalizedCouponCode) {
      keys[field].cd = kCouponAmountCouponDay(normalizedCouponCode, field, day);
      keys[field].cm = kCouponAmountCouponMonth(normalizedCouponCode, field, month);
      scheduled.push(redisIncrBy(keys[field].cd, amount), redisIncrBy(keys[field].cm, amount));
    }
    if (normalizedPlanCode) {
      keys[field].pd = kCouponAmountPlanDay(normalizedPlanCode, field, day);
      keys[field].pm = kCouponAmountPlanMonth(normalizedPlanCode, field, month);
      scheduled.push(redisIncrBy(keys[field].pd, amount), redisIncrBy(keys[field].pm, amount));
    }
    if (normalizedBillingCycle && normalizedBillingCycle !== "unknown") {
      keys[field].bd = kCouponAmountCycleDay(normalizedBillingCycle, field, day);
      keys[field].bm = kCouponAmountCycleMonth(normalizedBillingCycle, field, month);
      scheduled.push(redisIncrBy(keys[field].bd, amount), redisIncrBy(keys[field].bm, amount));
    }
  }

  if (!scheduled.length) return { ok: true, skipped: true, keys, amounts };

  await Promise.all(scheduled);
  const ttlJobs = [];
  for (const group of Object.values(keys)) {
    for (const key of Object.values(group)) {
      ttlJobs.push(redisExpire(key, key.includes(":day:") ? TTL_DAY_SECONDS : TTL_MONTH_SECONDS));
    }
  }
  await Promise.allSettled(ttlJobs);

  return {
    ok: true,
    userId: id || null,
    couponCode: normalizedCouponCode || null,
    planCode: normalizedPlanCode || null,
    billingCycle: normalizedBillingCycle || null,
    amounts,
    keys,
  };
}

export async function recordCouponMetrics(payload = {}) {
  const {
    eventName = "",
    userId = "",
    waId = "",
    couponCode = "",
    planCode = "",
    billingCycle = "",
    by = 1,
    originalCents = 0,
    discountCents = 0,
    finalCents = 0,
    date = new Date(),
  } = payload || {};

  const eventResult = eventName
    ? await recordCouponMetricEvent(eventName, { userId, waId, couponCode, planCode, billingCycle, by, date })
    : { ok: true, skipped: true };

  const amountResult = await addCouponMetricAmounts({
    userId,
    waId,
    couponCode,
    planCode,
    billingCycle,
    originalCents,
    discountCents,
    finalCents,
    date,
  });

  return { ok: Boolean(eventResult?.ok && amountResult?.ok), eventResult, amountResult };
}

async function readCouponAmountScope(keys) {
  const [dayRaw, monthRaw] = await Promise.all([redisGet(keys.day), redisGet(keys.month)]);
  return { dayCount: Number(dayRaw || 0), monthCount: Number(monthRaw || 0) };
}

export async function getCouponMetricsOverview(date = new Date()) {
  const eventEntries = await Promise.all(COUPON_EVENTS.map((eventName) => getCouponMetricEvent(eventName, date)));
  const amountEntries = await Promise.all(COUPON_AMOUNT_FIELDS.map((field) => getCouponAmountTotals(field, date)));

  return {
    ok: true,
    day: eventEntries[0]?.day || getDayKeyParts(date).day,
    month: eventEntries[0]?.month || getDayKeyParts(date).month,
    events: Object.fromEntries(eventEntries.filter((entry) => entry && entry.ok).map((entry) => [entry.eventName, { dayCount: entry.dayCount, monthCount: entry.monthCount }])),
    amounts: Object.fromEntries(amountEntries.filter((entry) => entry && entry.ok).map((entry) => [entry.field, { dayCount: entry.dayCount, monthCount: entry.monthCount }])),
  };
}

export async function getCouponMetricEvent(eventName, date = new Date()) {
  const normalizedEvent = normalizeMetricEventName(eventName);
  if (!normalizedEvent) return { ok: false, error: "eventName required" };
  const { day, month } = getDayKeyParts(date);
  const [d, m] = await Promise.all([
    redisGet(kCouponEventGlobalDay(normalizedEvent, day)),
    redisGet(kCouponEventGlobalMonth(normalizedEvent, month)),
  ]);
  return { ok: true, eventName: normalizedEvent, day, month, dayCount: Number(d || 0), monthCount: Number(m || 0) };
}

export async function getCouponMetricEventByCoupon(eventName, couponCode, date = new Date()) {
  const normalizedEvent = normalizeMetricEventName(eventName);
  const normalizedCouponCode = normalizeCouponMetricCode(couponCode);
  if (!normalizedEvent) return { ok: false, error: "eventName required" };
  if (!normalizedCouponCode) return { ok: false, error: "couponCode required" };
  const { day, month } = getDayKeyParts(date);
  const [d, m] = await Promise.all([
    redisGet(kCouponEventCouponDay(normalizedCouponCode, normalizedEvent, day)),
    redisGet(kCouponEventCouponMonth(normalizedCouponCode, normalizedEvent, month)),
  ]);
  return { ok: true, eventName: normalizedEvent, couponCode: normalizedCouponCode, day, month, dayCount: Number(d || 0), monthCount: Number(m || 0) };
}

export async function getCouponMetricEventByPlan(eventName, planCode, date = new Date()) {
  const normalizedEvent = normalizeMetricEventName(eventName);
  const normalizedPlanCode = normalizePlanMetricCode(planCode);
  if (!normalizedEvent) return { ok: false, error: "eventName required" };
  if (!normalizedPlanCode) return { ok: false, error: "planCode required" };
  const { day, month } = getDayKeyParts(date);
  const [d, m] = await Promise.all([
    redisGet(kCouponEventPlanDay(normalizedPlanCode, normalizedEvent, day)),
    redisGet(kCouponEventPlanMonth(normalizedPlanCode, normalizedEvent, month)),
  ]);
  return { ok: true, eventName: normalizedEvent, planCode: normalizedPlanCode, day, month, dayCount: Number(d || 0), monthCount: Number(m || 0) };
}

export async function getCouponMetricEventByBillingCycle(eventName, billingCycle, date = new Date()) {
  const normalizedEvent = normalizeMetricEventName(eventName);
  const normalizedBillingCycle = normalizeBillingCycleMetric(billingCycle);
  if (!normalizedEvent) return { ok: false, error: "eventName required" };
  if (!normalizedBillingCycle || normalizedBillingCycle === "unknown") return { ok: false, error: "billingCycle required" };
  const { day, month } = getDayKeyParts(date);
  const [d, m] = await Promise.all([
    redisGet(kCouponEventCycleDay(normalizedBillingCycle, normalizedEvent, day)),
    redisGet(kCouponEventCycleMonth(normalizedBillingCycle, normalizedEvent, month)),
  ]);
  return { ok: true, eventName: normalizedEvent, billingCycle: normalizedBillingCycle, day, month, dayCount: Number(d || 0), monthCount: Number(m || 0) };
}

export async function getCouponAmountTotals(field, date = new Date()) {
  const normalizedField = normalizeMetricSlug(field);
  if (!COUPON_AMOUNT_FIELDS.includes(normalizedField)) return { ok: false, error: "field invalid" };
  const { day, month } = getDayKeyParts(date);
  const counts = await readCouponAmountScope({
    day: kCouponAmountGlobalDay(normalizedField, day),
    month: kCouponAmountGlobalMonth(normalizedField, month),
  });
  return { ok: true, field: normalizedField, day, month, ...counts };
}

export async function getCouponAmountTotalsByCoupon(field, couponCode, date = new Date()) {
  const normalizedField = normalizeMetricSlug(field);
  const normalizedCouponCode = normalizeCouponMetricCode(couponCode);
  if (!COUPON_AMOUNT_FIELDS.includes(normalizedField)) return { ok: false, error: "field invalid" };
  if (!normalizedCouponCode) return { ok: false, error: "couponCode required" };
  const { day, month } = getDayKeyParts(date);
  const counts = await readCouponAmountScope({
    day: kCouponAmountCouponDay(normalizedCouponCode, normalizedField, day),
    month: kCouponAmountCouponMonth(normalizedCouponCode, normalizedField, month),
  });
  return { ok: true, field: normalizedField, couponCode: normalizedCouponCode, day, month, ...counts };
}

export async function getCouponAmountTotalsByPlan(field, planCode, date = new Date()) {
  const normalizedField = normalizeMetricSlug(field);
  const normalizedPlanCode = normalizePlanMetricCode(planCode);
  if (!COUPON_AMOUNT_FIELDS.includes(normalizedField)) return { ok: false, error: "field invalid" };
  if (!normalizedPlanCode) return { ok: false, error: "planCode required" };
  const { day, month } = getDayKeyParts(date);
  const counts = await readCouponAmountScope({
    day: kCouponAmountPlanDay(normalizedPlanCode, normalizedField, day),
    month: kCouponAmountPlanMonth(normalizedPlanCode, normalizedField, month),
  });
  return { ok: true, field: normalizedField, planCode: normalizedPlanCode, day, month, ...counts };
}

export async function getCouponAmountTotalsByBillingCycle(field, billingCycle, date = new Date()) {
  const normalizedField = normalizeMetricSlug(field);
  const normalizedBillingCycle = normalizeBillingCycleMetric(billingCycle);
  if (!COUPON_AMOUNT_FIELDS.includes(normalizedField)) return { ok: false, error: "field invalid" };
  if (!normalizedBillingCycle || normalizedBillingCycle === "unknown") return { ok: false, error: "billingCycle required" };
  const { day, month } = getDayKeyParts(date);
  const counts = await readCouponAmountScope({
    day: kCouponAmountCycleDay(normalizedBillingCycle, normalizedField, day),
    month: kCouponAmountCycleMonth(normalizedBillingCycle, normalizedField, month),
  });
  return { ok: true, field: normalizedField, billingCycle: normalizedBillingCycle, day, month, ...counts };
}

export async function resetUserCouponMetrics(userRef, { days = 120, months = 18, endDate = new Date() } = {}) {
  const id = normalizeUserMetricRef(userRef);
  if (!id) return { ok: false, error: "userId required" };

  const dN = clampInt(days, 1, 400, 120);
  const mN = clampInt(months, 1, 48, 18);
  const end = new Date(endDate.getTime());
  const startDay = addDays(end, -(dN - 1));
  const endMonth = new Date(end.getTime());
  endMonth.setDate(1);
  const startMonth = addMonths(endMonth, -(mN - 1));

  const keys = [];
  for (const eventName of COUPON_EVENTS) {
    const normalizedEvent = normalizeMetricEventName(eventName);
    for (let i = 0; i < dN; i++) {
      const d = fmtYmd(addDays(startDay, i));
      keys.push(kCouponEventUserDay(id, normalizedEvent, d));
    }
    for (let i = 0; i < mN; i++) {
      const m = fmtYm(addMonths(startMonth, i));
      keys.push(kCouponEventUserMonth(id, normalizedEvent, m));
    }
  }

  for (const field of COUPON_AMOUNT_FIELDS) {
    for (let i = 0; i < dN; i++) {
      const d = fmtYmd(addDays(startDay, i));
      keys.push(kCouponAmountUserDay(id, field, d));
    }
    for (let i = 0; i < mN; i++) {
      const m = fmtYm(addMonths(startMonth, i));
      keys.push(kCouponAmountUserMonth(id, field, m));
    }
  }

  let deleted = 0;
  for (const key of keys) {
    try {
      await redisDel(key);
      deleted++;
    } catch (_) {}
  }

  return {
    ok: true,
    userId: id,
    waId: id,
    deleted,
    ranges: {
      days: { start: fmtYmd(startDay), end: fmtYmd(end), count: dN },
      months: { start: fmtYm(startMonth), end: fmtYm(endMonth), count: mN },
    },
  };
}

// -----------------------------
// 🧹 Reset de métricas por usuário (sem SCAN/KEYS)
// -----------------------------
// 🧹 Reset de métricas por usuário (sem SCAN/KEYS)
// - Remove chaves day/month do usuário em um intervalo fixo
// - Útil para “resetar como se nunca tivesse escrito” em número de teste
// -----------------------------

export async function resetUserDescriptionMetrics(userRef, { days = 120, months = 18, endDate = new Date() } = {}) {
  const id = normalizeUserMetricRef(userRef);
  if (!id) return { ok: false, error: 'userId required' };

  const dN = clampInt(days, 1, 400, 120);
  const mN = clampInt(months, 1, 48, 18);

  const end = new Date(endDate.getTime());
  const dayEnd = fmtYmd(end);

  // Dias
  const startDay = addDays(end, -(dN - 1));
  const dayKeys = [];
  for (let i = 0; i < dN; i++) {
    const d = fmtYmd(addDays(startDay, i));
    dayKeys.push(kUserDay(id, d));
  }

  // Meses
  const endMonth = new Date(end.getTime());
  endMonth.setDate(1);
  const startMonth = addMonths(endMonth, -(mN - 1));
  const monthKeys = [];
  for (let i = 0; i < mN; i++) {
    const m = fmtYm(addMonths(startMonth, i));
    monthKeys.push(kUserMonth(id, m));
  }

  const eventDayKeys = [];
  const eventMonthKeys = [];
  for (const eventName of FEEDBACK_EVENTS) {
    const normalizedEvent = normalizeMetricEventName(eventName);
    for (let i = 0; i < dN; i++) {
      const d = fmtYmd(addDays(startDay, i));
      eventDayKeys.push(kEventUserDay(id, normalizedEvent, d));
    }
    for (let i = 0; i < mN; i++) {
      const m = fmtYm(addMonths(startMonth, i));
      eventMonthKeys.push(kEventUserMonth(id, normalizedEvent, m));
    }
  }

  let delCount = 0;
  const all = [...dayKeys, ...monthKeys, ...eventDayKeys, ...eventMonthKeys];
  for (const k of all) {
    try {
      await redisDel(k);
      delCount++;
    } catch (_) {
      // best-effort
    }
  }

  return { ok: true, userId: id, waId: id, deleted: delCount, ranges: { days: { start: fmtYmd(startDay), end: dayEnd, count: dN }, months: { start: fmtYm(startMonth), end: fmtYm(endMonth), count: mN } } };
}

const CONVERSION_EVENTS = Object.freeze([
  "first_inbound_received",
  "trial_started",
  "first_ad_generation_started",
  "first_ad_generated",
  "ad_generated",
  "ad_refined",
  "trial_limit_reached",
  "plans_viewed",
  "plan_selected",
  "billing_cycle_selected",
  "coupon_code_entered",
  "coupon_applied",
  "coupon_rejected",
  "coupon_removed",
  "pricing_quote_generated",
  "checkout_started",
  "checkout_confirmed",
  "payment_link_created",
  "pix_checkout_created",
  "subscription_checkout_created",
  "payment_confirmed",
  "payment_failed",
  "payment_expired",
  "subscription_activated",
  "plan_activated",
  "checkout_abandoned",
  "payment_abandoned",
  "campaign_received",
  "campaign_clicked_intent",
  "campaign_conversion_attributed",
  "flow_error",
  "payment_error",
  "campaign_error",
  "pricing_error",
  "whatsapp_send_error",
  "webhook_error",
  "state_error",
  "coupon_error",
]);

export const CONVERSION_EVENT_CATALOG = Object.freeze({
  FIRST_INBOUND_RECEIVED: "first_inbound_received",
  TRIAL_STARTED: "trial_started",
  FIRST_AD_GENERATION_STARTED: "first_ad_generation_started",
  FIRST_AD_GENERATED: "first_ad_generated",
  AD_GENERATED: "ad_generated",
  AD_REFINED: "ad_refined",
  TRIAL_LIMIT_REACHED: "trial_limit_reached",
  PLANS_VIEWED: "plans_viewed",
  PLAN_SELECTED: "plan_selected",
  BILLING_CYCLE_SELECTED: "billing_cycle_selected",
  COUPON_CODE_ENTERED: "coupon_code_entered",
  COUPON_APPLIED: "coupon_applied",
  COUPON_REJECTED: "coupon_rejected",
  COUPON_REMOVED: "coupon_removed",
  PRICING_QUOTE_GENERATED: "pricing_quote_generated",
  CHECKOUT_STARTED: "checkout_started",
  CHECKOUT_CONFIRMED: "checkout_confirmed",
  PAYMENT_LINK_CREATED: "payment_link_created",
  PIX_CHECKOUT_CREATED: "pix_checkout_created",
  SUBSCRIPTION_CHECKOUT_CREATED: "subscription_checkout_created",
  PAYMENT_CONFIRMED: "payment_confirmed",
  PAYMENT_FAILED: "payment_failed",
  PAYMENT_EXPIRED: "payment_expired",
  SUBSCRIPTION_ACTIVATED: "subscription_activated",
  PLAN_ACTIVATED: "plan_activated",
  CHECKOUT_ABANDONED: "checkout_abandoned",
  PAYMENT_ABANDONED: "payment_abandoned",
  CAMPAIGN_RECEIVED: "campaign_received",
  CAMPAIGN_CLICKED_INTENT: "campaign_clicked_intent",
  CAMPAIGN_CONVERSION_ATTRIBUTED: "campaign_conversion_attributed",
  FLOW_ERROR: "flow_error",
  PAYMENT_ERROR: "payment_error",
  CAMPAIGN_ERROR: "campaign_error",
  PRICING_ERROR: "pricing_error",
  WHATSAPP_SEND_ERROR: "whatsapp_send_error",
  WEBHOOK_ERROR: "webhook_error",
  STATE_ERROR: "state_error",
  COUPON_ERROR: "coupon_error",
});

const CONVERSION_EVENT_SET = new Set(CONVERSION_EVENTS);

const CAMPAIGN_EVENTS = Object.freeze([
  "campaign_evaluated",
  "campaign_eligible",
  "campaign_blocked",
  "campaign_sent",
  "campaign_error",
  "campaign_conflict_lost",
  "campaign_window24h_blocked",
  "campaign_cooldown_blocked",
]);

function normalizeCampaignMetricId(value) {
  return normalizeMetricSlug(value);
}

function normalizeCampaignCategoryMetric(value) {
  return normalizeMetricSlug(value);
}

function kCampaignEventGlobalDay(eventName, day) {
  return `metrics:campaign:event:${eventName}:global:day:${day}`;
}
function kCampaignEventGlobalMonth(eventName, month) {
  return `metrics:campaign:event:${eventName}:global:month:${month}`;
}
function kCampaignEventCampaignDay(campaignId, eventName, day) {
  return `metrics:campaign:event:${eventName}:campaign:${campaignId}:day:${day}`;
}
function kCampaignEventCampaignMonth(campaignId, eventName, month) {
  return `metrics:campaign:event:${eventName}:campaign:${campaignId}:month:${month}`;
}
function kCampaignEventCategoryDay(category, eventName, day) {
  return `metrics:campaign:event:${eventName}:category:${category}:day:${day}`;
}
function kCampaignEventCategoryMonth(category, eventName, month) {
  return `metrics:campaign:event:${eventName}:category:${category}:month:${month}`;
}
function kCampaignEventUserDay(userRef, eventName, day) {
  return `metrics:campaign:event:${eventName}:user:${userRef}:day:${day}`;
}
function kCampaignEventUserMonth(userRef, eventName, month) {
  return `metrics:campaign:event:${eventName}:user:${userRef}:month:${month}`;
}

export async function recordCampaignMetricEvent(
  eventName,
  { userId = "", waId = "", campaignId = "", category = "", by = 1, date = new Date() } = {}
) {
  const normalizedEvent = normalizeMetricEventName(eventName);
  const inc = Number(by) || 1;
  if (!normalizedEvent) return { ok: false, error: "eventName required" };

  const id = normalizeUserMetricRef(userId || waId);
  const normalizedCampaignId = normalizeCampaignMetricId(campaignId);
  const normalizedCategory = normalizeCampaignCategoryMetric(category);
  const { day, month } = getDayKeyParts(date);

  const keys = {
    gd: kCampaignEventGlobalDay(normalizedEvent, day),
    gm: kCampaignEventGlobalMonth(normalizedEvent, month),
  };
  const jobs = [
    redisIncrBy(keys.gd, inc),
    redisIncrBy(keys.gm, inc),
  ];

  if (id) {
    keys.ud = kCampaignEventUserDay(id, normalizedEvent, day);
    keys.um = kCampaignEventUserMonth(id, normalizedEvent, month);
    jobs.push(redisIncrBy(keys.ud, inc));
    jobs.push(redisIncrBy(keys.um, inc));
  }
  if (normalizedCampaignId) {
    keys.cd = kCampaignEventCampaignDay(normalizedCampaignId, normalizedEvent, day);
    keys.cm = kCampaignEventCampaignMonth(normalizedCampaignId, normalizedEvent, month);
    jobs.push(redisIncrBy(keys.cd, inc));
    jobs.push(redisIncrBy(keys.cm, inc));
  }
  if (normalizedCategory) {
    keys.kd = kCampaignEventCategoryDay(normalizedCategory, normalizedEvent, day);
    keys.km = kCampaignEventCategoryMonth(normalizedCategory, normalizedEvent, month);
    jobs.push(redisIncrBy(keys.kd, inc));
    jobs.push(redisIncrBy(keys.km, inc));
  }

  await Promise.all(jobs);
  const ttlJobs = Object.values(keys).map((key) =>
    redisExpire(key, key.includes(":day:") ? TTL_DAY_SECONDS : TTL_MONTH_SECONDS)
  );
  await Promise.allSettled(ttlJobs);

  return {
    ok: true,
    eventName: normalizedEvent,
    userId: id || null,
    campaignId: normalizedCampaignId || null,
    category: normalizedCategory || null,
    keys,
  };
}

export async function getCampaignMetricEvent(eventName, date = new Date()) {
  const normalizedEvent = normalizeMetricEventName(eventName);
  if (!normalizedEvent) return { ok: false, error: "eventName required" };
  const { day, month } = getDayKeyParts(date);
  const [d, m] = await Promise.all([
    redisGet(kCampaignEventGlobalDay(normalizedEvent, day)),
    redisGet(kCampaignEventGlobalMonth(normalizedEvent, month)),
  ]);
  return {
    ok: true,
    eventName: normalizedEvent,
    day,
    month,
    dayCount: Number(d || 0),
    monthCount: Number(m || 0),
  };
}

export async function getCampaignMetricEventByCampaign(campaignId, eventName, date = new Date()) {
  const normalizedCampaignId = normalizeCampaignMetricId(campaignId);
  const normalizedEvent = normalizeMetricEventName(eventName);
  if (!normalizedCampaignId) return { ok: false, error: "campaignId required" };
  if (!normalizedEvent) return { ok: false, error: "eventName required" };
  const { day, month } = getDayKeyParts(date);
  const [d, m] = await Promise.all([
    redisGet(kCampaignEventCampaignDay(normalizedCampaignId, normalizedEvent, day)),
    redisGet(kCampaignEventCampaignMonth(normalizedCampaignId, normalizedEvent, month)),
  ]);
  return {
    ok: true,
    campaignId: normalizedCampaignId,
    eventName: normalizedEvent,
    day,
    month,
    dayCount: Number(d || 0),
    monthCount: Number(m || 0),
  };
}

export async function getCampaignMetricEventByCategory(category, eventName, date = new Date()) {
  const normalizedCategory = normalizeCampaignCategoryMetric(category);
  const normalizedEvent = normalizeMetricEventName(eventName);
  if (!normalizedCategory) return { ok: false, error: "category required" };
  if (!normalizedEvent) return { ok: false, error: "eventName required" };
  const { day, month } = getDayKeyParts(date);
  const [d, m] = await Promise.all([
    redisGet(kCampaignEventCategoryDay(normalizedCategory, normalizedEvent, day)),
    redisGet(kCampaignEventCategoryMonth(normalizedCategory, normalizedEvent, month)),
  ]);
  return {
    ok: true,
    category: normalizedCategory,
    eventName: normalizedEvent,
    day,
    month,
    dayCount: Number(d || 0),
    monthCount: Number(m || 0),
  };
}

export async function getCampaignMetricsOverview(date = new Date()) {
  const entries = await Promise.all(CAMPAIGN_EVENTS.map((eventName) => getCampaignMetricEvent(eventName, date)));
  return {
    ok: true,
    day: entries[0]?.day || getDayKeyParts(date).day,
    month: entries[0]?.month || getDayKeyParts(date).month,
    events: Object.fromEntries(
      entries
        .filter((entry) => entry && entry.ok)
        .map((entry) => [entry.eventName, { dayCount: entry.dayCount, monthCount: entry.monthCount }])
    ),
  };
}


function normalizeTrackingContext(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const normalizedDate = source.date instanceof Date ? source.date : (source.date ? new Date(source.date) : new Date());
  const date = Number.isFinite(normalizedDate.getTime()) ? normalizedDate : new Date();

  return {
    userId: normalizeUserMetricRef(source.userId || source.internalUserId || source.userRef),
    waId: normalizeUserMetricRef(source.waId),
    planCode: normalizePlanMetricCode(source.planCode),
    billingCycle: normalizeBillingCycleMetric(source.billingCycle),
    couponCode: normalizeCouponMetricCode(source.couponCode),
    campaignId: normalizeCampaignMetricId(source.campaignId),
    campaignCode: normalizeMetricSlug(source.campaignCode),
    paymentId: safeStr(source.paymentId),
    subscriptionId: safeStr(source.subscriptionId),
    quoteId: safeStr(source.quoteId),
    errorCode: normalizeMetricSlug(source.errorCode),
    source: normalizeMetricSlug(source.source),
    step: normalizeMetricSlug(source.step),
    by: Number(source.by) || 1,
    date,
  };
}

export async function trackConversionEvent(eventName, payload = {}) {
  const normalizedEvent = normalizeMetricEventName(eventName);
  if (!normalizedEvent) return { ok: false, error: "eventName required" };
  if (!CONVERSION_EVENT_SET.has(normalizedEvent)) {
    return { ok: false, error: "eventName not in conversion catalog", eventName: normalizedEvent };
  }

  const context = normalizeTrackingContext(payload);
  const metricResult = await incMetricEvent(normalizedEvent, {
    userId: context.userId,
    waId: context.waId,
    by: context.by,
    date: context.date,
  });

  return {
    ...metricResult,
    catalog: "conversion",
    eventName: normalizedEvent,
    context: {
      userId: context.userId || null,
      waId: context.waId || null,
      planCode: context.planCode || null,
      billingCycle: context.billingCycle || null,
      couponCode: context.couponCode || null,
      campaignId: context.campaignId || null,
      campaignCode: context.campaignCode || null,
      paymentId: context.paymentId || null,
      subscriptionId: context.subscriptionId || null,
      quoteId: context.quoteId || null,
      errorCode: context.errorCode || null,
      source: context.source || null,
      step: context.step || null,
      by: context.by,
      date: context.date,
    },
  };
}

function makeTrackConversionHelper(eventName) {
  return async function trackConversionHelper(payload = {}) {
    return trackConversionEvent(eventName, payload);
  };
}

export const trackFirstInboundReceived = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.FIRST_INBOUND_RECEIVED);
export const trackTrialStarted = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.TRIAL_STARTED);
export const trackFirstAdGenerationStarted = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.FIRST_AD_GENERATION_STARTED);
export const trackFirstAdGenerated = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.FIRST_AD_GENERATED);
export const trackAdGenerated = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.AD_GENERATED);
export const trackAdRefined = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.AD_REFINED);
export const trackTrialLimitReached = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.TRIAL_LIMIT_REACHED);
export const trackPlansViewed = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.PLANS_VIEWED);
export const trackPlanSelected = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.PLAN_SELECTED);
export const trackBillingCycleSelected = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.BILLING_CYCLE_SELECTED);
export const trackCouponCodeEntered = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.COUPON_CODE_ENTERED);
export const trackCouponApplied = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.COUPON_APPLIED);
export const trackCouponRejected = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.COUPON_REJECTED);
export const trackCouponRemoved = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.COUPON_REMOVED);
export const trackPricingQuoteGenerated = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.PRICING_QUOTE_GENERATED);
export const trackCheckoutStarted = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.CHECKOUT_STARTED);
export const trackCheckoutConfirmed = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.CHECKOUT_CONFIRMED);
export const trackPaymentLinkCreated = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.PAYMENT_LINK_CREATED);
export const trackPixCheckoutCreated = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.PIX_CHECKOUT_CREATED);
export const trackSubscriptionCheckoutCreated = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.SUBSCRIPTION_CHECKOUT_CREATED);
export const trackPaymentConfirmed = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.PAYMENT_CONFIRMED);
export const trackPaymentFailed = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.PAYMENT_FAILED);
export const trackPaymentExpired = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.PAYMENT_EXPIRED);
export const trackSubscriptionActivated = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.SUBSCRIPTION_ACTIVATED);
export const trackPlanActivated = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.PLAN_ACTIVATED);
export const trackCheckoutAbandoned = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.CHECKOUT_ABANDONED);
export const trackPaymentAbandoned = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.PAYMENT_ABANDONED);
export const trackCampaignReceived = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.CAMPAIGN_RECEIVED);
export const trackCampaignClickedIntent = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.CAMPAIGN_CLICKED_INTENT);
export const trackCampaignConversionAttributed = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.CAMPAIGN_CONVERSION_ATTRIBUTED);
export const trackFlowError = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.FLOW_ERROR);
export const trackPaymentError = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.PAYMENT_ERROR);
export const trackCampaignError = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.CAMPAIGN_ERROR);
export const trackPricingError = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.PRICING_ERROR);
export const trackWhatsappSendError = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.WHATSAPP_SEND_ERROR);
export const trackWebhookError = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.WEBHOOK_ERROR);
export const trackStateError = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.STATE_ERROR);
export const trackCouponError = makeTrackConversionHelper(CONVERSION_EVENT_CATALOG.COUPON_ERROR);

// Alias com capitalização mais natural, preservando compatibilidade retroativa
export const trackWhatsAppSendError = trackWhatsappSendError;

export async function getConversionMetricsOverview(date = new Date()) {
  const entries = await Promise.all(CONVERSION_EVENTS.map((eventName) => getGlobalMetricEvent(eventName, date)));
  return {
    ok: true,
    day: entries[0]?.day || getDayKeyParts(date).day,
    month: entries[0]?.month || getDayKeyParts(date).month,
    events: Object.fromEntries(
      entries
        .filter((entry) => entry && entry.ok)
        .map((entry) => [entry.eventName, { dayCount: entry.dayCount, monthCount: entry.monthCount }])
    ),
  };
}


const ERROR_EVENTS = Object.freeze([
  CONVERSION_EVENT_CATALOG.FLOW_ERROR,
  CONVERSION_EVENT_CATALOG.PAYMENT_ERROR,
  CONVERSION_EVENT_CATALOG.CAMPAIGN_ERROR,
  CONVERSION_EVENT_CATALOG.WHATSAPP_SEND_ERROR,
  CONVERSION_EVENT_CATALOG.WEBHOOK_ERROR,
  CONVERSION_EVENT_CATALOG.STATE_ERROR,
  CONVERSION_EVENT_CATALOG.PRICING_ERROR,
  CONVERSION_EVENT_CATALOG.COUPON_ERROR,
]);

export const ERROR_EVENT_CATALOG = Object.freeze({
  FLOW_ERROR: CONVERSION_EVENT_CATALOG.FLOW_ERROR,
  PAYMENT_ERROR: CONVERSION_EVENT_CATALOG.PAYMENT_ERROR,
  CAMPAIGN_ERROR: CONVERSION_EVENT_CATALOG.CAMPAIGN_ERROR,
  WHATSAPP_SEND_ERROR: CONVERSION_EVENT_CATALOG.WHATSAPP_SEND_ERROR,
  WEBHOOK_ERROR: CONVERSION_EVENT_CATALOG.WEBHOOK_ERROR,
  STATE_ERROR: CONVERSION_EVENT_CATALOG.STATE_ERROR,
  PRICING_ERROR: CONVERSION_EVENT_CATALOG.PRICING_ERROR,
  COUPON_ERROR: CONVERSION_EVENT_CATALOG.COUPON_ERROR,
});

export async function getErrorMetricsOverview(date = new Date()) {
  const entries = await Promise.all(ERROR_EVENTS.map((eventName) => getGlobalMetricEvent(eventName, date)));
  return {
    ok: true,
    day: entries[0]?.day || getDayKeyParts(date).day,
    month: entries[0]?.month || getDayKeyParts(date).month,
    events: Object.fromEntries(
      entries
        .filter((entry) => entry && entry.ok)
        .map((entry) => [entry.eventName, { dayCount: entry.dayCount, monthCount: entry.monthCount }])
    ),
  };
}

export async function getErrorMetricEvent(eventName, date = new Date()) {
  const normalizedEvent = normalizeMetricEventName(eventName);
  if (!ERROR_EVENTS.includes(normalizedEvent)) {
    return { ok: false, error: 'eventName not in error catalog', eventName: normalizedEvent };
  }
  return getGlobalMetricEvent(normalizedEvent, date);
}
