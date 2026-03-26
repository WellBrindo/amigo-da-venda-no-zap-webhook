// src/services/asaas/ledger.js
// Histórico (ledger) de eventos do Asaas para reconciliação no Admin.
// - Não altera status do usuário (isso continua no webhook handler).
// - Dedup por evento + id (payment/subscription)
// - Capped lists (não cresce infinito)
// - Pode registrar metadados financeiros do checkout/cupom, sem decidir elegibilidade.

import { redisLPush, redisLTrim, redisLRange, redisSIsMember, redisSAdd } from "../redis.js";

const KEY_EVENT_IDS = "asaas:event_ids"; // SET
const KEY_EVENTS_GLOBAL = "asaas:events"; // LIST (JSON)

const keyUserEvents = (userId) => `asaas:events:user:${userId}`;

function safeStr(v) {
  return String(v || "").trim();
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeLedgerUserRef({ userId, waId }) {
  return safeStr(userId || waId);
}

function normalizeCents(value) {
  return Math.max(0, Math.trunc(toNumber(value, 0)));
}

function normalizeMoneyValue(value) {
  return Math.max(0, Number(toNumber(value, 0).toFixed(2)));
}

function centsToValue(cents) {
  return normalizeMoneyValue(toNumber(cents, 0) / 100);
}

function normalizeAppliesTo(value) {
  const text = safeStr(value).toLowerCase();
  return text === "entire_subscription" ? "entire_subscription" : "first_charge_only";
}

function pickPayment(p) {
  if (!p || typeof p !== "object") return null;
  return {
    id: safeStr(p.id),
    status: safeStr(p.status),
    billingType: safeStr(p.billingType),
    value: typeof p.value === "number" ? p.value : Number(p.value || 0),
    netValue: typeof p.netValue === "number" ? p.netValue : Number(p.netValue || 0),
    dueDate: safeStr(p.dueDate),
    paymentDate: safeStr(p.paymentDate || p.receivedDate || p.confirmedDate),
    invoiceUrl: safeStr(p.invoiceUrl),
    externalReference: safeStr(p.externalReference),
    description: safeStr(p.description),
  };
}

function pickSubscription(s) {
  if (!s || typeof s !== "object") return null;
  return {
    id: safeStr(s.id),
    status: safeStr(s.status),
    cycle: safeStr(s.cycle),
    value: typeof s.value === "number" ? s.value : Number(s.value || 0),
    nextDueDate: safeStr(s.nextDueDate || s.nextPaymentDate),
    externalReference: safeStr(s.externalReference),
  };
}

function pickQuote(quote) {
  if (!quote || typeof quote !== "object") return null;

  const calculation = quote.calculation && typeof quote.calculation === "object"
    ? quote.calculation
    : {};

  const basePriceCents = normalizeCents(calculation.basePriceCents);
  const discountAmountCents = normalizeCents(calculation.discountAmountCents);
  const finalPriceCents = normalizeCents(calculation.finalPriceCents);

  return {
    internalUserId: safeStr(quote.internalUserId),
    planCode: safeStr(quote.planCode),
    planName: safeStr(quote.plan?.name || quote.explanation?.planName),
    billingCycle: safeStr(quote.billingCycle || quote.explanation?.billingCycle),
    chargeMode: safeStr(quote.chargeMode),
    couponCode: safeStr(quote.couponCode || quote.explanation?.couponCode),
    appliesTo: normalizeAppliesTo(calculation.appliesTo || quote.explanation?.appliesTo),
    basePriceCents,
    discountAmountCents,
    finalPriceCents,
    basePriceValue: centsToValue(basePriceCents),
    discountAmountValue: centsToValue(discountAmountCents),
    finalPriceValue: centsToValue(finalPriceCents),
  };
}

function pickCouponLedger(couponLedger = {}, quote = null) {
  if (!couponLedger || typeof couponLedger !== "object") couponLedger = {};
  const quoteData = pickQuote(quote);

  const basePriceCents = normalizeCents(
    couponLedger.basePriceCents ?? quoteData?.basePriceCents
  );
  const discountAmountCents = normalizeCents(
    couponLedger.discountAmountCents ?? quoteData?.discountAmountCents
  );
  const finalPriceCents = normalizeCents(
    couponLedger.finalPriceCents ?? quoteData?.finalPriceCents
  );

  return {
    reservationId: safeStr(couponLedger.reservationId),
    reservationStatus: safeStr(couponLedger.reservationStatus),
    couponCode: safeStr(couponLedger.couponCode || quoteData?.couponCode),
    planCode: safeStr(couponLedger.planCode || quoteData?.planCode),
    billingCycle: safeStr(couponLedger.billingCycle || quoteData?.billingCycle),
    appliesTo: normalizeAppliesTo(couponLedger.appliesTo || quoteData?.appliesTo),
    basePriceCents,
    discountAmountCents,
    finalPriceCents,
    basePriceValue: centsToValue(basePriceCents),
    discountAmountValue: centsToValue(discountAmountCents),
    finalPriceValue: centsToValue(finalPriceCents),
  };
}

function makeDedupKey({ event, payment, subscription }) {
  const ev = safeStr(event);
  const pid = safeStr(payment?.id);
  const sid = safeStr(subscription?.id);
  if (pid) return `${ev}:payment:${pid}`;
  if (sid) return `${ev}:subscription:${sid}`;
  // fallback (raríssimo)
  return `${ev}:generic:${Date.now()}`;
}

function parseRows(rows) {
  const items = [];
  for (const r of rows || []) {
    try {
      items.push(JSON.parse(r));
    } catch {
      // ignora
    }
  }
  return items;
}

export async function recordAsaasEvent({
  event,
  userId,
  waId,
  payment,
  subscription,
  source = "webhook",
  quote = null,
  couponLedger = null,
}) {
  const userRef = normalizeLedgerUserRef({ userId, waId });
  if (!userRef) return { ok: false, reason: "no_userId" };

  const entry = {
    ts: new Date().toISOString(),
    source: safeStr(source) || "webhook",
    event: safeStr(event),
    userId: userRef,
    waId: safeStr(waId),
    payment: pickPayment(payment),
    subscription: pickSubscription(subscription),
    quote: pickQuote(quote),
    couponLedger: pickCouponLedger(couponLedger, quote),
  };

  const dedupKey = makeDedupKey({ event, payment, subscription });
  const already = await redisSIsMember(KEY_EVENT_IDS, dedupKey);
  if (already) return { ok: true, dedup: true };

  await redisSAdd(KEY_EVENT_IDS, dedupKey);

  const json = JSON.stringify(entry);
  await redisLPush(KEY_EVENTS_GLOBAL, json);
  await redisLTrim(KEY_EVENTS_GLOBAL, 0, 1999);

  const userKey = keyUserEvents(userRef);
  await redisLPush(userKey, json);
  await redisLTrim(userKey, 0, 499);

  return { ok: true };
}

export async function recordAsaasCouponLedger({
  event,
  userId,
  waId,
  payment = null,
  subscription = null,
  source = "coupon",
  quote = null,
  couponCode = "",
  reservationId = "",
  reservationStatus = "",
  planCode = "",
  billingCycle = "",
  appliesTo = "",
  basePriceCents = 0,
  discountAmountCents = 0,
  finalPriceCents = 0,
}) {
  return recordAsaasEvent({
    event,
    userId,
    waId,
    payment,
    subscription,
    source,
    quote,
    couponLedger: {
      couponCode,
      reservationId,
      reservationStatus,
      planCode,
      billingCycle,
      appliesTo,
      basePriceCents,
      discountAmountCents,
      finalPriceCents,
    },
  });
}

export async function listAsaasEvents({ userId = "", waId = "", offset = 0, limit = 50 } = {}) {
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const start = off;
  const stop = off + lim - 1;

  const userRef = normalizeLedgerUserRef({ userId, waId });
  const key = userRef ? keyUserEvents(userRef) : KEY_EVENTS_GLOBAL;
  const rows = await redisLRange(key, start, stop);

  return { ok: true, items: parseRows(rows) };
}

export async function listAsaasCouponEvents({ userId = "", waId = "", offset = 0, limit = 50 } = {}) {
  const result = await listAsaasEvents({ userId, waId, offset, limit });
  if (!result?.ok) return result;

  return {
    ok: true,
    items: (result.items || []).filter((item) => item?.couponLedger && typeof item.couponLedger === "object"),
  };
}
