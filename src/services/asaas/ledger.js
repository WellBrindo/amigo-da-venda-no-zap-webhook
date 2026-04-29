// src/services/asaas/ledger.js
// Histórico (ledger) de eventos do Asaas para reconciliação e observabilidade operacional.
// - Não altera status do usuário (isso continua no webhook handler).
// - Dedup por evento + id (payment/subscription)
// - Capped lists (não cresce infinito)
// - Pode registrar metadados financeiros do checkout/cupom, sem decidir elegibilidade.

import { redisLPush, redisLTrim, redisLRange, redisSIsMember, redisSAdd } from "../redis.js";
import * as audit from "../audit.js";

const KEY_EVENT_IDS = "asaas:event_ids"; // SET
const KEY_EVENTS_GLOBAL = "asaas:events"; // LIST (JSON)

const keyUserEvents = (userId) => `asaas:events:user:${userId}`;

const LEDGER_EVENT_TYPE = Object.freeze({
  CHECKOUT_CREATED: "checkout_created",
  PAYMENT_CONFIRMED: "payment_confirmed",
  PAYMENT_FAILED: "payment_failed",
  PAYMENT_EXPIRED: "payment_expired",
  SUBSCRIPTION_ACTIVATED: "subscription_activated",
  SUBSCRIPTION_CANCELLED: "subscription_cancelled",
  COUPON_EVENT: "coupon_event",
  ADMIN_REFERENCE: "admin_reference",
  INCONSISTENCY: "inconsistency",
  INCOMPLETE: "incomplete",
  GENERIC: "generic",
});

const LEDGER_CATEGORY = Object.freeze({
  CHECKOUT: "checkout",
  PAYMENT: "payment",
  SUBSCRIPTION: "subscription",
  COUPON: "coupon",
  ADMIN: "admin",
  INCONSISTENCY: "inconsistency",
  GENERAL: "general",
});

const LEDGER_SEVERITY = Object.freeze({
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
});

export const ASAAS_LEDGER_ADMIN_EVENT = Object.freeze({
  USER_FINANCIAL_FIELD_CHANGED: "ADMIN_USER_FINANCIAL_FIELD_CHANGED",
});

const ADMIN_FINANCIAL_FIELDS = Object.freeze([
  "plan",
  "paymentMethod",
  "asaasCustomerId",
  "asaasSubscriptionId",
  "cardValidUntil",
  "cardCanceledAt",
]);

const SENSITIVE_META_KEYS = /token|secret|authorization|api[_-]?key|password|cpf|cnpj|document|docdigits|docnumber/i;

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

function normalizeMeta(meta) {
  return meta && typeof meta === "object" && !Array.isArray(meta) ? { ...meta } : {};
}

function sanitizeLedgerMetaValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return "[TRUNCATED]";
  if (typeof value === "string") {
    const text = safeStr(value);
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeLedgerMetaValue(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      if (SENSITIVE_META_KEYS.test(key)) {
        if (key === "doc" && item && typeof item === "object") {
          out.doc = {
            docType: safeStr(item.docType).toUpperCase(),
            docLast4: safeStr(item.docLast4).replace(/\D+/g, "").slice(-4),
          };
        } else if (key === "docType" || key === "docLast4") {
          out[key] = key === "docLast4" ? safeStr(item).replace(/\D+/g, "").slice(-4) : safeStr(item).toUpperCase();
        } else {
          out[key] = "[REDACTED]";
        }
        continue;
      }
      out[key] = sanitizeLedgerMetaValue(item, depth + 1);
    }
    return out;
  }
  return safeStr(value);
}

function sanitizeLedgerMeta(meta) {
  return sanitizeLedgerMetaValue(normalizeMeta(meta));
}

function normalizeChangedFinancialFields(fields = []) {
  const list = Array.isArray(fields) ? fields : String(fields || "").split(",");
  return Array.from(new Set(list.map((field) => safeStr(field)).filter((field) => ADMIN_FINANCIAL_FIELDS.includes(field))));
}

function inferEventClassification({ event = "", payment = null, subscription = null, couponLedger = null, meta = {} } = {}) {
  const ev = safeStr(event).toLowerCase();
  const paymentStatus = safeStr(payment?.status).toLowerCase();
  const subscriptionStatus = safeStr(subscription?.status).toLowerCase();
  const hasCoupon = !!(couponLedger && typeof couponLedger === "object" && (safeStr(couponLedger.couponCode) || safeStr(couponLedger.reservationId)));

  if (ev === safeStr(ASAAS_LEDGER_ADMIN_EVENT.USER_FINANCIAL_FIELD_CHANGED).toLowerCase()) {
    return {
      eventType: LEDGER_EVENT_TYPE.ADMIN_REFERENCE,
      category: LEDGER_CATEGORY.ADMIN,
      status: "admin_reference",
      severity: LEDGER_SEVERITY.INFO,
      isFailure: false,
      isInconsistency: false,
    };
  }

  if (ev.includes("inconsisten") || ev.includes("invalid") || ev.includes("missing") || ev.includes("diverg")) {
    return {
      eventType: LEDGER_EVENT_TYPE.INCONSISTENCY,
      category: LEDGER_CATEGORY.INCONSISTENCY,
      status: "inconsistent",
      severity: LEDGER_SEVERITY.ERROR,
      isFailure: true,
      isInconsistency: true,
    };
  }

  if (ev.includes("expired") || paymentStatus === "overdue") {
    return {
      eventType: LEDGER_EVENT_TYPE.PAYMENT_EXPIRED,
      category: LEDGER_CATEGORY.PAYMENT,
      status: "expired",
      severity: LEDGER_SEVERITY.WARN,
      isFailure: true,
      isInconsistency: false,
    };
  }

  if (ev.includes("fail") || paymentStatus === "failed") {
    return {
      eventType: LEDGER_EVENT_TYPE.PAYMENT_FAILED,
      category: LEDGER_CATEGORY.PAYMENT,
      status: "failed",
      severity: LEDGER_SEVERITY.ERROR,
      isFailure: true,
      isInconsistency: false,
    };
  }

  if (ev.includes("confirm") || paymentStatus === "received" || paymentStatus === "confirmed") {
    return {
      eventType: LEDGER_EVENT_TYPE.PAYMENT_CONFIRMED,
      category: LEDGER_CATEGORY.PAYMENT,
      status: "confirmed",
      severity: LEDGER_SEVERITY.INFO,
      isFailure: false,
      isInconsistency: false,
    };
  }

  if (ev.includes("cancel") || subscriptionStatus === "cancelled") {
    return {
      eventType: LEDGER_EVENT_TYPE.SUBSCRIPTION_CANCELLED,
      category: LEDGER_CATEGORY.SUBSCRIPTION,
      status: "cancelled",
      severity: LEDGER_SEVERITY.WARN,
      isFailure: false,
      isInconsistency: false,
    };
  }

  if (ev.includes("subscription") || subscriptionStatus === "active") {
    return {
      eventType: LEDGER_EVENT_TYPE.SUBSCRIPTION_ACTIVATED,
      category: LEDGER_CATEGORY.SUBSCRIPTION,
      status: subscriptionStatus || "active",
      severity: LEDGER_SEVERITY.INFO,
      isFailure: false,
      isInconsistency: false,
    };
  }

  if (ev.includes("pix")) {
    return {
      eventType: LEDGER_EVENT_TYPE.CHECKOUT_CREATED,
      category: LEDGER_CATEGORY.CHECKOUT,
      status: "pix_created",
      severity: LEDGER_SEVERITY.INFO,
      isFailure: false,
      isInconsistency: false,
    };
  }

  if (ev.includes("checkout") || ev.includes("link") || ev.includes("charge") || ev.includes("payment_link")) {
    return {
      eventType: LEDGER_EVENT_TYPE.CHECKOUT_CREATED,
      category: LEDGER_CATEGORY.CHECKOUT,
      status: "created",
      severity: LEDGER_SEVERITY.INFO,
      isFailure: false,
      isInconsistency: false,
    };
  }

  if (hasCoupon) {
    return {
      eventType: LEDGER_EVENT_TYPE.COUPON_EVENT,
      category: LEDGER_CATEGORY.COUPON,
      status: safeStr(meta.status || couponLedger?.reservationStatus || "coupon_event"),
      severity: LEDGER_SEVERITY.INFO,
      isFailure: false,
      isInconsistency: false,
    };
  }

  const hasCoreRefs = safeStr(payment?.id) || safeStr(subscription?.id);
  if (!hasCoreRefs) {
    return {
      eventType: LEDGER_EVENT_TYPE.INCOMPLETE,
      category: LEDGER_CATEGORY.GENERAL,
      status: "incomplete",
      severity: LEDGER_SEVERITY.WARN,
      isFailure: true,
      isInconsistency: false,
    };
  }

  return {
    eventType: LEDGER_EVENT_TYPE.GENERIC,
    category: LEDGER_CATEGORY.GENERAL,
    status: safeStr(meta.status || "recorded"),
    severity: LEDGER_SEVERITY.INFO,
    isFailure: false,
    isInconsistency: false,
  };
}

async function emitLedgerOperationalLog(entry) {
  const payload = {
    module: "asaas_ledger",
    source: "asaas_ledger",
    event: safeStr(entry?.event || "asaas_ledger_event"),
    level: safeStr(entry?.severity || LEDGER_SEVERITY.INFO),
    userId: safeStr(entry?.userId),
    waId: safeStr(entry?.waId),
    paymentId: safeStr(entry?.paymentId),
    subscriptionId: safeStr(entry?.subscriptionId),
    step: safeStr(entry?.eventType || entry?.category),
    status: safeStr(entry?.status),
    message: safeStr(entry?.summary || entry?.message || entry?.event),
    errorCode: safeStr(entry?.errorCode),
    meta: normalizeMeta(entry?.meta),
  };

  try {
    if ((payload.level === "warn" || payload.level === "error") && typeof audit?.logRuntimeError === "function") {
      await audit.logRuntimeError(payload);
      return;
    }
    if (typeof audit?.logOperationalEvent === "function") {
      await audit.logOperationalEvent(payload);
      return;
    }
  } catch {
    // fallback abaixo
  }

  try {
    const line = JSON.stringify(payload);
    if (payload.level === "error") console.error(line);
    else if (payload.level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    // noop
  }
}

function buildLedgerEntry({
  event,
  userId,
  waId,
  payment,
  subscription,
  source = "webhook",
  quote = null,
  couponLedger = null,
  summary = "",
  meta = {},
  errorCode = "",
} = {}) {
  const paymentData = pickPayment(payment);
  const subscriptionData = pickSubscription(subscription);
  const quoteData = pickQuote(quote);
  const couponData = pickCouponLedger(couponLedger, quote);
  const classification = inferEventClassification({
    event,
    payment: paymentData,
    subscription: subscriptionData,
    couponLedger: couponData,
    meta,
  });

  const paymentId = safeStr(paymentData?.id);
  const subscriptionId = safeStr(subscriptionData?.id);
  const couponCode = safeStr(couponData?.couponCode || quoteData?.couponCode);
  const reservationId = safeStr(couponData?.reservationId);
  const planCode = safeStr(couponData?.planCode || quoteData?.planCode);
  const billingCycle = safeStr(couponData?.billingCycle || quoteData?.billingCycle);

  return {
    ts: new Date().toISOString(),
    source: safeStr(source) || "webhook",
    event: safeStr(event),
    eventType: classification.eventType,
    category: classification.category,
    status: classification.status,
    severity: classification.severity,
    isFailure: Boolean(classification.isFailure),
    isInconsistency: Boolean(classification.isInconsistency),
    summary: safeStr(summary) || safeStr(event),
    message: safeStr(summary) || safeStr(event),
    errorCode: safeStr(errorCode),
    userId: normalizeLedgerUserRef({ userId, waId }),
    waId: safeStr(waId),
    paymentId,
    subscriptionId,
    planCode,
    billingCycle,
    couponCode,
    reservationId,
    payment: paymentData,
    subscription: subscriptionData,
    quote: quoteData,
    couponLedger: couponData,
    meta: sanitizeLedgerMeta(meta),
  };
}

async function appendLedgerEntry(entry, { skipAudit = false } = {}) {
  const dedupKey = makeDedupKey({ event: entry.event, payment: entry.payment, subscription: entry.subscription });
  const already = await redisSIsMember(KEY_EVENT_IDS, dedupKey);
  if (already) return { ok: true, dedup: true, item: entry };

  await redisSAdd(KEY_EVENT_IDS, dedupKey);

  const json = JSON.stringify(entry);
  await redisLPush(KEY_EVENTS_GLOBAL, json);
  await redisLTrim(KEY_EVENTS_GLOBAL, 0, 1999);

  const userKey = keyUserEvents(entry.userId);
  await redisLPush(userKey, json);
  await redisLTrim(userKey, 0, 499);

  if (!skipAudit && (entry.isFailure || entry.isInconsistency || entry.category !== LEDGER_CATEGORY.GENERAL)) {
    await emitLedgerOperationalLog(entry);
  }

  return { ok: true, item: entry };
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
  summary = "",
  meta = {},
  errorCode = "",
} = {}) {
  const userRef = normalizeLedgerUserRef({ userId, waId });
  if (!userRef) return { ok: false, reason: "no_userId" };

  const entry = buildLedgerEntry({
    event,
    userId,
    waId,
    payment,
    subscription,
    source,
    quote,
    couponLedger,
    summary,
    meta,
    errorCode,
  });

  return appendLedgerEntry(entry);
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
  summary = "",
  meta = {},
  errorCode = "",
}) {
  return recordAsaasEvent({
    event,
    userId,
    waId,
    payment,
    subscription,
    source,
    quote,
    summary,
    meta,
    errorCode,
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

export async function recordAsaasCheckoutCreated(args = {}) {
  return recordAsaasEvent({
    ...args,
    summary: safeStr(args.summary) || "Checkout materializado no Asaas",
    event: safeStr(args.event) || "checkout_created",
  });
}

export async function recordAsaasPaymentConfirmed(args = {}) {
  return recordAsaasEvent({
    ...args,
    summary: safeStr(args.summary) || "Pagamento confirmado no Asaas",
    event: safeStr(args.event) || "payment_confirmed",
  });
}

export async function recordAsaasPaymentFailed(args = {}) {
  return recordAsaasEvent({
    ...args,
    summary: safeStr(args.summary) || "Pagamento falhou no Asaas",
    event: safeStr(args.event) || "payment_failed",
  });
}

export async function recordAsaasPaymentExpired(args = {}) {
  return recordAsaasEvent({
    ...args,
    summary: safeStr(args.summary) || "Pagamento expirado no Asaas",
    event: safeStr(args.event) || "payment_expired",
  });
}

export async function recordAsaasSubscriptionActivated(args = {}) {
  return recordAsaasEvent({
    ...args,
    summary: safeStr(args.summary) || "Assinatura ativada no Asaas",
    event: safeStr(args.event) || "subscription_activated",
  });
}

export async function recordAsaasInconsistency({
  event = "financial_inconsistency",
  userId = "",
  waId = "",
  payment = null,
  subscription = null,
  source = "asaas_ledger",
  quote = null,
  couponLedger = null,
  summary = "Inconsistência financeira registrada",
  message = "",
  errorCode = "ASAAS_LEDGER_INCONSISTENCY",
  meta = {},
} = {}) {
  const userRef = normalizeLedgerUserRef({ userId, waId });
  if (!userRef) return { ok: false, reason: "no_userId" };

  const entry = buildLedgerEntry({
    event,
    userId,
    waId,
    payment,
    subscription,
    source,
    quote,
    couponLedger,
    summary: safeStr(summary) || safeStr(message) || "Inconsistência financeira registrada",
    meta: {
      ...normalizeMeta(meta),
      inconsistency: true,
      runtime: true,
      rawMessage: safeStr(message),
    },
    errorCode,
  });

  entry.eventType = LEDGER_EVENT_TYPE.INCONSISTENCY;
  entry.category = LEDGER_CATEGORY.INCONSISTENCY;
  entry.status = "inconsistent";
  entry.severity = LEDGER_SEVERITY.ERROR;
  entry.isFailure = true;
  entry.isInconsistency = true;

  return appendLedgerEntry(entry);
}

 export async function recordAdminUserFinancialFieldChanged({
  userId = "",
  waId = "",
  changedFields = [],
  before = {},
  after = {},
  actor = {},
  summary = "",
  meta = {},
} = {}) {
  const userRef = normalizeLedgerUserRef({ userId, waId });
  if (!userRef) return { ok: false, reason: "no_userId" };

  const normalizedChangedFields = normalizeChangedFinancialFields(changedFields);
  if (!normalizedChangedFields.length) {
    return { ok: true, skipped: true, reason: "no_financial_fields_changed" };
  }

  const entry = buildLedgerEntry({
    event: ASAAS_LEDGER_ADMIN_EVENT.USER_FINANCIAL_FIELD_CHANGED,
    userId,
    waId,
    payment: null,
    subscription: null,
    source: "admin",
    quote: null,
    couponLedger: null,
    summary: safeStr(summary) || "Alteração administrativa de campo financeiro do usuário registrada apenas para rastreabilidade.",
    meta: {
      ...normalizeMeta(meta),
      administrativeReferenceOnly: true,
      doesNotRepresentPayment: true,
      doesNotRepresentCharge: true,
      doesNotConfirmCoupon: true,
      doesNotModifySubscription: true,
      changedFields: normalizedChangedFields,
      before: sanitizeLedgerMeta(before),
      after: sanitizeLedgerMeta(after),
      actor: sanitizeLedgerMeta(actor),
    },
  });

  entry.eventType = LEDGER_EVENT_TYPE.ADMIN_REFERENCE;
  entry.category = LEDGER_CATEGORY.ADMIN;
  entry.status = "admin_reference";
  entry.severity = LEDGER_SEVERITY.INFO;
  entry.isFailure = false;
  entry.isInconsistency = false;
  entry.payment = null;
  entry.subscription = null;
  entry.paymentId = "";
  entry.subscriptionId = "";
  entry.couponLedger = null;
  entry.couponCode = "";
  entry.reservationId = "";

  return appendLedgerEntry(entry);
}

export async function listAsaasEvents({
  userId = "",
  waId = "",
  offset = 0,
  limit = 50,
  eventType = "",
  onlyFailures = false,
  onlyInconsistencies = false,
  couponCode = "",
  paymentId = "",
  subscriptionId = "",
} = {}) {
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const start = off;
  const stop = off + lim - 1;

  const userRef = normalizeLedgerUserRef({ userId, waId });
  const key = userRef ? keyUserEvents(userRef) : KEY_EVENTS_GLOBAL;
  const rows = await redisLRange(key, start, stop);

  let items = parseRows(rows);
  const eventTypeFilter = safeStr(eventType).toLowerCase();
  const couponCodeFilter = safeStr(couponCode);
  const paymentIdFilter = safeStr(paymentId);
  const subscriptionIdFilter = safeStr(subscriptionId);

  if (eventTypeFilter) items = items.filter((item) => safeStr(item?.eventType).toLowerCase() === eventTypeFilter);
  if (onlyFailures) items = items.filter((item) => !!item?.isFailure);
  if (onlyInconsistencies) items = items.filter((item) => !!item?.isInconsistency);
  if (couponCodeFilter) items = items.filter((item) => safeStr(item?.couponCode || item?.couponLedger?.couponCode) === couponCodeFilter);
  if (paymentIdFilter) items = items.filter((item) => safeStr(item?.paymentId || item?.payment?.id) === paymentIdFilter);
  if (subscriptionIdFilter) items = items.filter((item) => safeStr(item?.subscriptionId || item?.subscription?.id) === subscriptionIdFilter);

  return { ok: true, items };
}

export async function listAsaasCouponEvents({ userId = "", waId = "", offset = 0, limit = 50 } = {}) {
  const result = await listAsaasEvents({ userId, waId, offset, limit });
  if (!result?.ok) return result;

  return {
    ok: true,
    items: (result.items || []).filter((item) => item?.couponLedger && typeof item.couponLedger === "object"),
  };
}
