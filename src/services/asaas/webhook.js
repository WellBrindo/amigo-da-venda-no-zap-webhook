// src/services/asaas/webhook.js

import {
  ensureUserExists,
  setUserStatus,
  getUserPlan,
  resetUserQuotaUsed,
  resetUserTrialUsed,
  getCardValidUntil,
  setCardValidUntil,
  getBillingCityState,
  getBillingAddress,
  setPrevStatus,
  getCouponReservationId,
  getPricingQuote as getStoredPricingQuote,
  resetCheckoutCouponState,
} from "../state.js";

import { getCopyText } from "../copy.js";
import { sendWhatsAppText } from "../meta/whatsapp.js";
import { recordAsaasEvent } from "./ledger.js";
import { getPreferredOutboundRecipient, getPendingIdentityConflictForUser } from "../identity.js";
import {
  trackPaymentConfirmed,
  trackPaymentFailed,
  trackPaymentExpired,
  trackSubscriptionActivated,
  trackPlanActivated,
  trackPaymentError,
  trackWebhookError,
} from "../metrics.js";
import * as audit from "../audit.js";
import {
  confirmCouponReservation,
  releaseCouponReservation,
  failCouponReservation,
  cancelCouponReservation,
} from "../coupons.js";

/**
 * Webhook handler do Asaas
 * externalReference = internalUserId (compatível com legado por alias)
 */

const ASAAS_WEBHOOK_ERROR = Object.freeze({
  PAYLOAD: "ASAAS_WEBHOOK_PAYLOAD_ERROR",
  USER_RESOLUTION: "ASAAS_WEBHOOK_USER_RESOLUTION_ERROR",
  STATE: "ASAAS_WEBHOOK_STATE_ERROR",
  LEDGER: "ASAAS_WEBHOOK_LEDGER_ERROR",
  COUPON: "ASAAS_WEBHOOK_COUPON_ERROR",
  NOTIFICATION: "ASAAS_WEBHOOK_NOTIFICATION_ERROR",
  IDENTITY_REVIEW_REQUIRED: "ASAAS_WEBHOOK_IDENTITY_REVIEW_REQUIRED",
  UNKNOWN_STATUS: "ASAAS_WEBHOOK_UNKNOWN_STATUS",
  RUNTIME: "ASAAS_WEBHOOK_RUNTIME_ERROR",
});

function safeStr(value) {
  return String(value ?? "").trim();
}

function normalizeCents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function normalizeAppliesTo(value) {
  const text = safeStr(value).toLowerCase();
  return text === "entire_subscription" ? "entire_subscription" : "first_charge_only";
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeWebhookPayload(body) {
  const payload = body && typeof body === "object" ? body : {};
  return {
    event: safeStr(payload?.event),
    payment: payload?.payment && typeof payload.payment === "object" ? payload.payment : null,
    subscription: payload?.subscription && typeof payload.subscription === "object" ? payload.subscription : null,
  };
}

function buildWebhookTrackingContext({
  userId = "",
  payment = null,
  subscription = null,
  storedQuote = null,
  step = "",
} = {}) {
  const quote = pickQuoteForLedger(storedQuote || {}, userId);
  return {
    userId: safeStr(userId),
    waId: safeStr(userId),
    paymentId: safeStr(payment?.id),
    subscriptionId: safeStr(subscription?.id),
    planCode: safeStr(quote?.planCode),
    billingCycle: safeStr(quote?.billingCycle),
    couponCode: safeStr(quote?.couponCode),
    source: "asaas_webhook",
    step: safeStr(step),
  };
}

function buildWebhookOperationalContext({
  userId = "",
  event = "",
  payment = null,
  subscription = null,
  step = "",
  errorCode = "",
  message = "",
  meta = {},
} = {}) {
  return {
    ts: nowIso(),
    source: "asaas_webhook",
    event: safeStr(event),
    userId: safeStr(userId),
    paymentId: safeStr(payment?.id),
    subscriptionId: safeStr(subscription?.id),
    step: safeStr(step),
    errorCode: safeStr(errorCode),
    message: safeStr(message),
    meta: meta && typeof meta === "object" ? meta : {},
  };
}

async function logWebhookOperational(level = "info", context = {}) {
  const payload = {
    level: safeStr(level) || "info",
    module: "asaas_webhook",
    source: "asaas_webhook",
    ...context,
  };

  try {
    if (typeof audit?.logOperationalEvent === "function") {
      await audit.logOperationalEvent({
        module: "asaas_webhook",
        event: safeStr(payload.event || "asaas_webhook_runtime"),
        level: safeStr(payload.level || "info").toLowerCase(),
        userId: safeStr(payload.userId),
        paymentId: safeStr(payload.paymentId),
        subscriptionId: safeStr(payload.subscriptionId),
        step: safeStr(payload.step),
        message: safeStr(payload.message),
        errorCode: safeStr(payload.errorCode),
        status: safeStr(payload.status),
        meta: payload.meta && typeof payload.meta === "object" ? payload.meta : {},
      });
      return;
    }
    if (
      typeof audit?.logRuntimeError === "function" &&
      ["warn", "error", "fatal"].includes(safeStr(payload.level || "info").toLowerCase())
    ) {
      await audit.logRuntimeError({
        module: "asaas_webhook",
        event: safeStr(payload.event || "asaas_webhook_runtime"),
        level: safeStr(payload.level || "warn").toLowerCase(),
        userId: safeStr(payload.userId),
        paymentId: safeStr(payload.paymentId),
        subscriptionId: safeStr(payload.subscriptionId),
        step: safeStr(payload.step),
        message: safeStr(payload.message),
        errorCode: safeStr(payload.errorCode),
        status: safeStr(payload.status),
        meta: payload.meta && typeof payload.meta === "object" ? payload.meta : {},
      });
      return;
    }
  } catch {}

  const method = payload.level === "error" ? console.error : payload.level === "warn" ? console.warn : console.log;
  method(JSON.stringify(payload));
}

function classifyWebhookRuntimeError(error, fallback = ASAAS_WEBHOOK_ERROR.RUNTIME) {
  const message = safeStr(error?.message || error);
  if (!message) return fallback;

  if (/externalreference|no_external_reference|missing.*event|payload/i.test(message)) {
    return ASAAS_WEBHOOK_ERROR.PAYLOAD;
  }
  if (/user|internaluserid|ensureuserexists|identity/i.test(message)) {
    return ASAAS_WEBHOOK_ERROR.USER_RESOLUTION;
  }
  if (/ledger|recordasaasevent/i.test(message)) {
    return ASAAS_WEBHOOK_ERROR.LEDGER;
  }
  if (/coupon|reservation/i.test(message)) {
    return ASAAS_WEBHOOK_ERROR.COUPON;
  }
  if (/recipient|whatsapp|copytext|notification/i.test(message)) {
    return ASAAS_WEBHOOK_ERROR.NOTIFICATION;
  }
  if (/status|state|billing|active|wait_/i.test(message)) {
    return ASAAS_WEBHOOK_ERROR.STATE;
  }
  return fallback;
}

async function emitWebhookMetricSafe(metricFn, payload = {}) {
  if (typeof metricFn !== "function") return null;
  try {
    return await metricFn(payload);
  } catch (err) {
    await logWebhookOperational("warn", {
      event: "asaas_webhook_metric_emit_failed",
      step: "emit_webhook_metric",
      userId: safeStr(payload?.userId || payload?.waId),
      paymentId: safeStr(payload?.paymentId),
      subscriptionId: safeStr(payload?.subscriptionId),
      errorCode: safeStr(err?.errorCode || err?.code || ASAAS_WEBHOOK_ERROR.RUNTIME),
      message: err?.message || String(err),
      meta: {
        metric: safeStr(metricFn?.name),
      },
    });
    return null;
  }
}

async function emitWebhookFailureMetrics({ userId = "", payment = null, subscription = null, event = "", step = "", errorCode = "" } = {}) {
  const payload = buildWebhookTrackingContext({
    userId,
    payment,
    subscription,
    step,
  });
  payload.errorCode = safeStr(errorCode);
  await emitWebhookMetricSafe(trackWebhookError, payload);
  await emitWebhookMetricSafe(trackPaymentError, payload);
}

function pickQuoteForLedger(quote = {}, userId = "") {
  if (!quote || typeof quote !== "object") return null;

  const calculation = quote?.calculation && typeof quote.calculation === "object"
    ? quote.calculation
    : {};

  const basePriceCents = normalizeCents(calculation.basePriceCents);
  const discountAmountCents = normalizeCents(calculation.discountAmountCents);
  const finalPriceCents = normalizeCents(calculation.finalPriceCents);

  return {
    internalUserId: safeStr(quote.internalUserId || userId),
    planCode: safeStr(quote.planCode),
    planName: safeStr(quote?.plan?.name || quote?.explanation?.planName),
    billingCycle: safeStr(quote.billingCycle || quote?.explanation?.billingCycle),
    chargeMode: safeStr(quote.chargeMode),
    couponCode: safeStr(quote.couponCode || quote?.explanation?.couponCode),
    appliesTo: normalizeAppliesTo(calculation.appliesTo || quote?.explanation?.appliesTo),
    basePriceCents,
    discountAmountCents,
    finalPriceCents,
  };
}

function buildCouponLedgerPayload(finalizeResult = {}, fallbackQuote = null) {
  const reservation =
    finalizeResult?.reservation ||
    finalizeResult?.current ||
    finalizeResult?.next ||
    finalizeResult?.previous ||
    null;

  if (!reservation && !fallbackQuote) return null;

  const quote = pickQuoteForLedger(fallbackQuote || {}, reservation?.internalUserId || "");
  const basePriceCents = normalizeCents(reservation?.basePriceCents ?? quote?.basePriceCents);
  const discountAmountCents = normalizeCents(
    reservation?.discountAmountCents ?? quote?.discountAmountCents
  );
  const finalPriceCents = normalizeCents(reservation?.finalPriceCents ?? quote?.finalPriceCents);

  return {
    reservationId: safeStr(
      reservation?.reservationId ||
      reservation?.id ||
      finalizeResult?.reservationId
    ),
    reservationStatus: safeStr(
      reservation?.status ||
      finalizeResult?.status
    ),
    couponCode: safeStr(reservation?.couponCode || quote?.couponCode),
    planCode: safeStr(reservation?.planCode || quote?.planCode),
    billingCycle: safeStr(reservation?.billingCycle || quote?.billingCycle),
    appliesTo: normalizeAppliesTo(reservation?.appliesTo || quote?.appliesTo),
    basePriceCents,
    discountAmountCents,
    finalPriceCents,
  };
}

async function getQuoteSnapshotForLedger(userId) {
  try {
    return await getStoredPricingQuote(userId);
  } catch {
    return null;
  }
}

async function sendCopyText(userId, key, vars = {}, errorTag = "ASAAS_WEBHOOK_SEND_ERROR") {
  const text = await getCopyText(key, { waId: userId, userId, ...vars });
  const recipient = await getPreferredOutboundRecipient(userId);

  if (!recipient?.recipient) {
    const err = new Error("Missing outbound recipient");
    err.code = ASAAS_WEBHOOK_ERROR.NOTIFICATION;
    throw err;
  }

  try {
    await sendWhatsAppText({ recipient, text });
    return { ok: true };
  } catch (err) {
    err.code = safeStr(err?.code || err?.errorCode || ASAAS_WEBHOOK_ERROR.NOTIFICATION);
    err.tag = errorTag;
    throw err;
  }
}

async function sendCopyTextSafe(userId, key, vars = {}, errorTag = "ASAAS_WEBHOOK_SEND_ERROR", context = {}) {
  try {
    return await sendCopyText(userId, key, vars, errorTag);
  } catch (err) {
    const errorCode = safeStr(err?.code || classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.NOTIFICATION));
    await logWebhookOperational("warn", buildWebhookOperationalContext({
      userId,
      event: context?.event,
      payment: context?.payment,
      subscription: context?.subscription,
      step: safeStr(context?.step || errorTag),
      errorCode,
      message: err?.message || String(err),
      meta: { key, tag: errorTag },
    }));
    await emitWebhookFailureMetrics({
      userId,
      payment: context?.payment,
      subscription: context?.subscription,
      event: context?.event,
      step: safeStr(context?.step || errorTag),
      errorCode,
    });
    return { ok: false, error: err?.message || String(err), errorCode };
  }
}

async function finalizeCheckoutCouponOnWebhook(
  userId,
  {
    mode = "",
    reason = "",
    paymentId = "",
    subscriptionId = "",
    event = "",
    payment = null,
    subscription = null,
  } = {}
) {
  try {
    const reservationId = await getCouponReservationId(userId);
    if (!reservationId) {
      return { ok: true, skipped: true, reason: "no_coupon_reservation", shouldResetCheckoutState: true };
    }

    const payload = {
      reason: safeStr(reason),
      paymentId: safeStr(paymentId),
      subscriptionId: safeStr(subscriptionId),
      meta: {
        source: "asaas_webhook",
        event: safeStr(event),
        paymentStatus: safeStr(payment?.status),
        paymentBillingType: safeStr(payment?.billingType),
        subscriptionStatus: safeStr(subscription?.status),
      },
    };

    let result = null;

    if (mode === "confirm") {
      result = await confirmCouponReservation(reservationId, {
        paymentId: payload.paymentId,
        subscriptionId: payload.subscriptionId,
        meta: payload.meta,
      });
    } else if (mode === "release") {
      result = await releaseCouponReservation(reservationId, payload);
    } else if (mode === "fail") {
      result = await failCouponReservation(reservationId, payload);
    } else if (mode === "cancel") {
      result = await cancelCouponReservation(reservationId, payload);
    } else {
      return { ok: false, reason: "invalid_mode", mode, shouldResetCheckoutState: false };
    }

    return { ...(result || { ok: true, reservationId }), shouldResetCheckoutState: true };
  } catch (err) {
    await logWebhookOperational("warn", buildWebhookOperationalContext({
      userId,
      event,
      payment,
      subscription,
      step: "finalize_checkout_coupon",
      errorCode: classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.COUPON),
      message: err?.message || String(err),
      meta: { mode: safeStr(mode) },
    }));
    return {
      ok: false,
      error: err?.message || String(err),
      errorCode: classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.COUPON),
      shouldResetCheckoutState: false,
    };
  }
}

async function recordWebhookLedger({
  event = "",
  userId = "",
  payment = null,
  subscription = null,
  couponFinalize = null,
  storedQuote = null,
} = {}) {
  const quoteSource = storedQuote || (await getQuoteSnapshotForLedger(userId));
  const quoteForLedger = pickQuoteForLedger(quoteSource, userId);
  const couponLedger = buildCouponLedgerPayload(couponFinalize, quoteForLedger);

  await recordAsaasEvent({
    event,
    userId,
    payment,
    subscription,
    source: "webhook",
    quote: quoteForLedger,
    couponLedger,
  });
}

async function resetCheckoutCouponStateSafe(userId, { event = "", payment = null, subscription = null, step = "" } = {}) {
  try {
    await resetCheckoutCouponState(userId);
    return { ok: true };
  } catch (err) {
    const errorCode = classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.STATE);
    await logWebhookOperational("warn", buildWebhookOperationalContext({
      userId,
      event,
      payment,
      subscription,
      step: safeStr(step || "reset_checkout_coupon_state"),
      errorCode,
      message: err?.message || String(err),
    }));
    await emitWebhookFailureMetrics({ userId, payment, subscription, event, step: safeStr(step || "reset_checkout_coupon_state"), errorCode });
    return { ok: false, error: err?.message || String(err), errorCode };
  }
}

async function recordWebhookLedgerSafe(args = {}) {
  try {
    await recordWebhookLedger(args);
    return { ok: true };
  } catch (err) {
    const errorCode = classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.LEDGER);
    await logWebhookOperational("error", buildWebhookOperationalContext({
      userId: args?.userId,
      event: args?.event,
      payment: args?.payment,
      subscription: args?.subscription,
      step: "record_webhook_ledger",
      errorCode,
      message: err?.message || String(err),
    }));
    await emitWebhookFailureMetrics({
      userId: args?.userId,
      payment: args?.payment,
      subscription: args?.subscription,
      event: args?.event,
      step: "record_webhook_ledger",
      errorCode,
    });
    return { ok: false, error: err?.message || String(err), errorCode };
  }
}

async function resolveUserForWebhook(userId) {
  const normalizedUserId = safeStr(userId);
  if (!normalizedUserId) {
    const err = new Error("Webhook event missing externalReference/internal user id");
    err.code = ASAAS_WEBHOOK_ERROR.USER_RESOLUTION;
    throw err;
  }
  await ensureUserExists(normalizedUserId);
  return normalizedUserId;
}

async function getPendingIdentityConflictSafe(userId) {
  const normalizedUserId = safeStr(userId);
  if (!normalizedUserId) return null;
  try {
    return await getPendingIdentityConflictForUser(normalizedUserId);
  } catch (err) {
    await logWebhookOperational("warn", buildWebhookOperationalContext({
      userId: normalizedUserId,
      event: "identity_review_lookup_failed",
      step: "identity_review_lookup",
      errorCode: ASAAS_WEBHOOK_ERROR.IDENTITY_REVIEW_REQUIRED,
      message: err?.message || String(err),
    }));
    return null;
  }
}

async function handleIdentityReviewPending({
  userId = "",
  event = "",
  payment = null,
  subscription = null,
  conflict = null,
  step = "",
  message = "",
  meta = {},
} = {}) {
  const conflictId = safeStr(conflict?.conflictId);
  const conflictStatus = safeStr(conflict?.status || "PENDING_REVIEW");

  await logWebhookOperational("info", buildWebhookOperationalContext({
    userId,
    event,
    payment,
    subscription,
    step: safeStr(step || "identity_review_pending"),
    errorCode: ASAAS_WEBHOOK_ERROR.IDENTITY_REVIEW_REQUIRED,
    message: safeStr(message || "Evento financeiro registrado, mas automações irreversíveis foram suprimidas por conflito de identidade pendente."),
    status: "suppressed",
    meta: {
      conflictId,
      conflictStatus,
      classification: "suppressed_controlled",
      ...((meta && typeof meta === "object") ? meta : {}),
    },
  }));

  try {
    if (typeof audit?.logIdentityConflictAudit === "function") {
      await audit.logIdentityConflictAudit({
        action: "IDENTITY_CONFLICT_SENSITIVE_OP_BLOCKED",
        conflictId,
        waUserId: safeStr(conflict?.waUserId || userId),
        bsuidUserId: safeStr(conflict?.bsuidUserId),
        status: conflictStatus,
        waId: safeStr(conflict?.waId),
        bsuid: safeStr(conflict?.bsuid),
        summary: safeStr(message || "Evento financeiro processado com automações irreversíveis suprimidas por conflito de identidade pendente."),
        meta: {
          source: "asaas_webhook",
          webhookEvent: safeStr(event),
          paymentId: safeStr(payment?.id),
          subscriptionId: safeStr(subscription?.id),
          step: safeStr(step || "identity_review_pending"),
          ...((meta && typeof meta === "object") ? meta : {}),
        },
      });
    }
  } catch {}

  return {
    ok: true,
    reviewRequired: true,
    suppressed: true,
    classification: "suppressed_controlled",
    conflictId,
    conflictStatus,
  };
}

function daysLeftUntilIso(iso) {
  const value = safeStr(iso);
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const target = new Date(y, mo, d, 23, 59, 59);
  const now = new Date();
  const diffMs = target.getTime() - now.getTime();
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

export async function handleAsaasWebhookEvent(body) {
  try {
    const { event, payment, subscription } = normalizeWebhookPayload(body);
    const paymentId = safeStr(payment?.id);
    const subscriptionId = safeStr(subscription?.id);

    if (!event) {
      const errorCode = ASAAS_WEBHOOK_ERROR.PAYLOAD;
      await logWebhookOperational("warn", buildWebhookOperationalContext({
        event,
        payment,
        subscription,
        step: "parse_payload",
        errorCode,
        message: "Webhook do Asaas recebido sem event.",
      }));
      await emitWebhookFailureMetrics({ event, payment, subscription, step: "parse_payload", errorCode });
      return { ok: false, reason: "missing_event" };
    }

    const inferredUserId =
      safeStr(payment?.externalReference) ||
      safeStr(subscription?.externalReference) ||
      "";

    if (!inferredUserId) {
      const errorCode = ASAAS_WEBHOOK_ERROR.USER_RESOLUTION;
      await logWebhookOperational("warn", buildWebhookOperationalContext({
        event,
        payment,
        subscription,
        step: "resolve_user",
        errorCode,
        message: "Evento sem externalReference/internal user id.",
      }));
      await emitWebhookFailureMetrics({ event, payment, subscription, step: "resolve_user", errorCode });
      return { ok: false, reason: "no_external_reference" };
    }

    const userId = await resolveUserForWebhook(inferredUserId);

    // ==============================
    // PAGAMENTO CONFIRMADO
    // ==============================
    if (
      event === "PAYMENT_RECEIVED" ||
      event === "PAYMENT_CONFIRMED"
    ) {
      const storedQuote = await getQuoteSnapshotForLedger(userId);
      const couponFinalize = await finalizeCheckoutCouponOnWebhook(userId, {
        mode: "confirm",
        paymentId,
        subscriptionId,
        event,
        payment,
        subscription,
      });

      if (!couponFinalize?.ok && !couponFinalize?.skipped) {
        await emitWebhookFailureMetrics({
          userId,
          payment,
          subscription,
          event,
          step: "finalize_coupon_confirm",
          errorCode: safeStr(couponFinalize?.errorCode || ASAAS_WEBHOOK_ERROR.COUPON),
        });
      }

      const ledgerResult = await recordWebhookLedgerSafe({
        event,
        userId,
        payment,
        subscription,
        couponFinalize,
        storedQuote,
      });

      if (couponFinalize?.shouldResetCheckoutState && ledgerResult?.ok) {
        await resetCheckoutCouponStateSafe(userId, {
          event,
          payment,
          subscription,
          step: "payment_confirmed_reset_checkout_state",
        });
      }

      const trackingContext = buildWebhookTrackingContext({
        userId,
        payment,
        subscription,
        storedQuote,
        step: safeStr(event).toLowerCase(),
      });

      const plan = await getUserPlan(userId).catch(() => "");

      if (!plan) {
        await logWebhookOperational("warn", buildWebhookOperationalContext({
          userId,
          event,
          payment,
          subscription,
          step: "payment_confirmed_plan_lookup",
          errorCode: ASAAS_WEBHOOK_ERROR.STATE,
          message: "Payment confirmed but user plan is missing.",
        }));
      }

      try {
        await resetUserQuotaUsed(userId);
        await resetUserTrialUsed(userId);
      } catch (err) {
        const errorCode = classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.STATE);
        await logWebhookOperational("warn", buildWebhookOperationalContext({
          userId,
          event,
          payment,
          subscription,
          step: "payment_confirmed_reset_usage",
          errorCode,
          message: err?.message || String(err),
        }));
        await emitWebhookFailureMetrics({ userId, payment, subscription, event, step: "payment_confirmed_reset_usage", errorCode });
      }

      await emitWebhookMetricSafe(trackPaymentConfirmed, trackingContext);
      if (trackingContext.subscriptionId) {
        await emitWebhookMetricSafe(trackSubscriptionActivated, trackingContext);
      }
      await emitWebhookMetricSafe(trackPlanActivated, trackingContext);

      const pendingIdentityConflict = await getPendingIdentityConflictSafe(userId);
      if (pendingIdentityConflict) {
        return await handleIdentityReviewPending({
          userId,
          event,
          payment,
          subscription,
          conflict: pendingIdentityConflict,
          step: "payment_confirmed_identity_review_gate",
          message: "Pagamento confirmado registrado em ledger, mas ativação automática e notificações foram suprimidas por conflito de identidade pendente.",
          meta: {
            paymentConfirmed: true,
            ledgerRecorded: Boolean(ledgerResult?.ok),
            couponFinalized: Boolean(couponFinalize?.ok || couponFinalize?.skipped),
          },
        });
      }

      let billingCityState = "";
      let billingAddress = "";
      try {
        [billingCityState, billingAddress] = await Promise.all([
          getBillingCityState(userId),
          getBillingAddress(userId),
        ]);
      } catch (err) {
        const errorCode = classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.STATE);
        await logWebhookOperational("warn", buildWebhookOperationalContext({
          userId,
          event,
          payment,
          subscription,
          step: "payment_confirmed_billing_lookup",
          errorCode,
          message: err?.message || String(err),
        }));
        await emitWebhookFailureMetrics({ userId, payment, subscription, event, step: "payment_confirmed_billing_lookup", errorCode });
      }

      if (!billingCityState) {
        try {
          await setPrevStatus(userId, "ACTIVE");
          await setUserStatus(userId, "WAIT_BILLING_CITY_STATE");
        } catch (err) {
          const errorCode = classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.STATE);
          await logWebhookOperational("error", buildWebhookOperationalContext({
            userId,
            event,
            payment,
            subscription,
            step: "payment_confirmed_set_wait_city",
            errorCode,
            message: err?.message || String(err),
          }));
          await emitWebhookFailureMetrics({ userId, payment, subscription, event, step: "payment_confirmed_set_wait_city", errorCode });
          return { ok: false, error: err?.message || String(err), errorCode };
        }

        await sendCopyTextSafe(
          userId,
          "FLOW_ASK_BILLING_CITY_STATE",
          {},
          "ASAAS_WEBHOOK_SEND_CITY_ERROR",
          { event, payment, subscription, step: "payment_confirmed_send_city" }
        );

        await logWebhookOperational("info", buildWebhookOperationalContext({
          userId,
          event,
          payment,
          subscription,
          step: "payment_confirmed_wait_city",
          message: `Usuário ativado e aguardando cidade/UF. Plano: ${safeStr(plan || "NONE")}`,
        }));
        return { ok: true, statusSetTo: "WAIT_BILLING_CITY_STATE" };
      }

      if (!billingAddress) {
        try {
          await setPrevStatus(userId, "ACTIVE");
          await setUserStatus(userId, "WAIT_BILLING_ADDRESS");
        } catch (err) {
          const errorCode = classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.STATE);
          await logWebhookOperational("error", buildWebhookOperationalContext({
            userId,
            event,
            payment,
            subscription,
            step: "payment_confirmed_set_wait_address",
            errorCode,
            message: err?.message || String(err),
          }));
          await emitWebhookFailureMetrics({ userId, payment, subscription, event, step: "payment_confirmed_set_wait_address", errorCode });
          return { ok: false, error: err?.message || String(err), errorCode };
        }

        await sendCopyTextSafe(
          userId,
          "FLOW_ASK_BILLING_ADDRESS",
          {},
          "ASAAS_WEBHOOK_SEND_ADDRESS_ERROR",
          { event, payment, subscription, step: "payment_confirmed_send_address" }
        );

        await logWebhookOperational("info", buildWebhookOperationalContext({
          userId,
          event,
          payment,
          subscription,
          step: "payment_confirmed_wait_address",
          message: `Usuário ativado e aguardando endereço. Plano: ${safeStr(plan || "NONE")}`,
        }));
        return { ok: true, statusSetTo: "WAIT_BILLING_ADDRESS" };
      }

      try {
        await setUserStatus(userId, "ACTIVE");
      } catch (err) {
        const errorCode = classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.STATE);
        await logWebhookOperational("error", buildWebhookOperationalContext({
          userId,
          event,
          payment,
          subscription,
          step: "payment_confirmed_set_active",
          errorCode,
          message: err?.message || String(err),
        }));
        await emitWebhookFailureMetrics({ userId, payment, subscription, event, step: "payment_confirmed_set_active", errorCode });
        return { ok: false, error: err?.message || String(err), errorCode };
      }

      await sendCopyTextSafe(
        userId,
        "FLOW_PLAN_ACTIVATED_WELCOME",
        {},
        "ASAAS_WEBHOOK_SEND_ACTIVE_WELCOME_ERROR",
        { event, payment, subscription, step: "payment_confirmed_send_welcome" }
      );

      await logWebhookOperational("info", buildWebhookOperationalContext({
        userId,
        event,
        payment,
        subscription,
        step: "payment_confirmed_active",
        message: `Usuário ativado com sucesso. Plano: ${safeStr(plan || "NONE")}`,
      }));

      return { ok: true, statusSetTo: "ACTIVE" };
    }

    // ==============================
    // FALHA NO CARTÃO / RECUPERAÇÃO DE PAGAMENTO
    // ==============================
    if (
      event === "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED" ||
      event === "PAYMENT_REPROVED_BY_RISK_ANALYSIS"
    ) {
      const storedQuote = await getQuoteSnapshotForLedger(userId);
      const couponFinalize = await finalizeCheckoutCouponOnWebhook(userId, {
        mode: "fail",
        reason: "payment_card_failed",
        paymentId,
        subscriptionId,
        event,
        payment,
        subscription,
      });

      const ledgerResult = await recordWebhookLedgerSafe({
        event,
        userId,
        payment,
        subscription,
        couponFinalize,
        storedQuote,
      });

      if (couponFinalize?.shouldResetCheckoutState && ledgerResult?.ok) {
        await resetCheckoutCouponStateSafe(userId, {
          event,
          payment,
          subscription,
          step: "payment_failed_reset_checkout_state",
        });
      }

      await emitWebhookMetricSafe(
        trackPaymentFailed,
        buildWebhookTrackingContext({
          userId,
          payment,
          subscription,
          storedQuote,
          step: safeStr(event).toLowerCase(),
        })
      );

      const pendingIdentityConflict = await getPendingIdentityConflictSafe(userId);
      if (pendingIdentityConflict) {
        return await handleIdentityReviewPending({
          userId,
          event,
          payment,
          subscription,
          conflict: pendingIdentityConflict,
          step: "payment_failed_identity_review_gate",
          message: "Falha de pagamento registrada em ledger, mas recuperação automática e notificações foram suprimidas por conflito de identidade pendente.",
          meta: {
            ledgerRecorded: Boolean(ledgerResult?.ok),
            couponFinalized: Boolean(couponFinalize?.ok || couponFinalize?.skipped),
          },
        });
      }

      try {
        await setUserStatus(userId, "WAIT_PAYMENT_RECOVERY");
      } catch (err) {
        const errorCode = classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.STATE);
        await logWebhookOperational("error", buildWebhookOperationalContext({
          userId,
          event,
          payment,
          subscription,
          step: "payment_failed_set_recovery",
          errorCode,
          message: err?.message || String(err),
        }));
        await emitWebhookFailureMetrics({ userId, payment, subscription, event, step: "payment_failed_set_recovery", errorCode });
        return { ok: false, error: err?.message || String(err), errorCode };
      }

      await sendCopyTextSafe(
        userId,
        "FLOW_PAYMENT_RECOVERY",
        {},
        "ASAAS_WEBHOOK_SEND_PAYMENT_RECOVERY_ERROR",
        { event, payment, subscription, step: "payment_failed_send_recovery" }
      );

      await logWebhookOperational("info", buildWebhookOperationalContext({
        userId,
        event,
        payment,
        subscription,
        step: "payment_failed_wait_recovery",
        message: "Falha no cartão / recuperação iniciada.",
      }));

      return { ok: true, statusSetTo: "WAIT_PAYMENT_RECOVERY" };
    }

    // ==============================
    // PAGAMENTO VENCIDO
    // ==============================
    if (event === "PAYMENT_OVERDUE") {
      const storedQuote = await getQuoteSnapshotForLedger(userId);
      const couponFinalize = await finalizeCheckoutCouponOnWebhook(userId, {
        mode: "release",
        reason: "payment_overdue",
        paymentId,
        subscriptionId,
        event,
        payment,
        subscription,
      });

      const ledgerResult = await recordWebhookLedgerSafe({
        event,
        userId,
        payment,
        subscription,
        couponFinalize,
        storedQuote,
      });

      if (couponFinalize?.shouldResetCheckoutState && ledgerResult?.ok) {
        await resetCheckoutCouponStateSafe(userId, {
          event,
          payment,
          subscription,
          step: "payment_overdue_reset_checkout_state",
        });
      }

      await emitWebhookMetricSafe(
        trackPaymentExpired,
        buildWebhookTrackingContext({
          userId,
          payment,
          subscription,
          storedQuote,
          step: safeStr(event).toLowerCase(),
        })
      );

      const pendingIdentityConflict = await getPendingIdentityConflictSafe(userId);
      if (pendingIdentityConflict) {
        return await handleIdentityReviewPending({
          userId,
          event,
          payment,
          subscription,
          conflict: pendingIdentityConflict,
          step: "payment_overdue_identity_review_gate",
          message: "Pagamento vencido registrado em ledger, mas transição automática de status foi suprimida por conflito de identidade pendente.",
          meta: {
            ledgerRecorded: Boolean(ledgerResult?.ok),
            couponFinalized: Boolean(couponFinalize?.ok || couponFinalize?.skipped),
          },
        });
      }

      try {
        await setUserStatus(userId, "PAYMENT_PENDING");
      } catch (err) {
        const errorCode = classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.STATE);
        await logWebhookOperational("error", buildWebhookOperationalContext({
          userId,
          event,
          payment,
          subscription,
          step: "payment_overdue_set_pending",
          errorCode,
          message: err?.message || String(err),
        }));
        await emitWebhookFailureMetrics({ userId, payment, subscription, event, step: "payment_overdue_set_pending", errorCode });
        return { ok: false, error: err?.message || String(err), errorCode };
      }

      await logWebhookOperational("info", buildWebhookOperationalContext({
        userId,
        event,
        payment,
        subscription,
        step: "payment_overdue_pending",
        message: "Pagamento vencido. Usuário mantido em PAYMENT_PENDING.",
      }));

      return { ok: true, statusSetTo: "PAYMENT_PENDING" };
    }

    // ==============================
    // PAGAMENTO DELETADO
    // ==============================
    if (event === "PAYMENT_DELETED") {
      const storedQuote = await getQuoteSnapshotForLedger(userId);
      const couponFinalize = await finalizeCheckoutCouponOnWebhook(userId, {
        mode: "cancel",
        reason: "payment_deleted",
        paymentId,
        subscriptionId,
        event,
        payment,
        subscription,
      });

      const ledgerResult = await recordWebhookLedgerSafe({
        event,
        userId,
        payment,
        subscription,
        couponFinalize,
        storedQuote,
      });

      if (couponFinalize?.shouldResetCheckoutState && ledgerResult?.ok) {
        await resetCheckoutCouponStateSafe(userId, {
          event,
          payment,
          subscription,
          step: "payment_deleted_reset_checkout_state",
        });
      }

      const pendingIdentityConflict = await getPendingIdentityConflictSafe(userId);
      if (pendingIdentityConflict) {
        return await handleIdentityReviewPending({
          userId,
          event,
          payment,
          subscription,
          conflict: pendingIdentityConflict,
          step: "payment_deleted_identity_review_gate",
          message: "Exclusão de pagamento registrada em ledger, mas bloqueio automático foi suprimido por conflito de identidade pendente.",
          meta: {
            ledgerRecorded: Boolean(ledgerResult?.ok),
            couponFinalized: Boolean(couponFinalize?.ok || couponFinalize?.skipped),
          },
        });
      }

      try {
        await setUserStatus(userId, "BLOCKED");
      } catch (err) {
        const errorCode = classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.STATE);
        await logWebhookOperational("error", buildWebhookOperationalContext({
          userId,
          event,
          payment,
          subscription,
          step: "payment_deleted_set_blocked",
          errorCode,
          message: err?.message || String(err),
        }));
        await emitWebhookFailureMetrics({ userId, payment, subscription, event, step: "payment_deleted_set_blocked", errorCode });
        return { ok: false, error: err?.message || String(err), errorCode };
      }

      await logWebhookOperational("info", buildWebhookOperationalContext({
        userId,
        event,
        payment,
        subscription,
        step: "payment_deleted_blocked",
        message: "Pagamento deletado. Usuário bloqueado.",
      }));

      return { ok: true, statusSetTo: "BLOCKED" };
    }

    // ==============================
    // ASSINATURA CANCELADA / INATIVA
    // ==============================
    if (
      event === "SUBSCRIPTION_DELETED" ||
      event === "SUBSCRIPTION_EXPIRED" ||
      event === "SUBSCRIPTION_INACTIVATED"
    ) {
      const storedQuote = await getQuoteSnapshotForLedger(userId);
      const couponFinalize = await finalizeCheckoutCouponOnWebhook(userId, {
        mode: "cancel",
        reason: "subscription_inactivated",
        paymentId,
        subscriptionId,
        event,
        payment,
        subscription,
      });

      const ledgerResult = await recordWebhookLedgerSafe({
        event,
        userId,
        payment,
        subscription,
        couponFinalize,
        storedQuote,
      });

      if (couponFinalize?.shouldResetCheckoutState && ledgerResult?.ok) {
        await resetCheckoutCouponStateSafe(userId, {
          event,
          payment,
          subscription,
          step: "subscription_inactivated_reset_checkout_state",
        });
      }

      const pendingIdentityConflict = await getPendingIdentityConflictSafe(userId);
      if (pendingIdentityConflict) {
        return await handleIdentityReviewPending({
          userId,
          event,
          payment,
          subscription,
          conflict: pendingIdentityConflict,
          step: "subscription_inactivated_identity_review_gate",
          message: "Inativação de assinatura registrada em ledger, mas transições automáticas dependentes de identidade foram suprimidas por conflito pendente.",
          meta: {
            ledgerRecorded: Boolean(ledgerResult?.ok),
            couponFinalized: Boolean(couponFinalize?.ok || couponFinalize?.skipped),
          },
        });
      }

      const nextDue = safeStr(subscription?.nextDueDate || subscription?.nextPaymentDate);
      if (nextDue) {
        try {
          await setCardValidUntil(userId, nextDue);
        } catch (err) {
          const errorCode = classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.STATE);
          await logWebhookOperational("warn", buildWebhookOperationalContext({
            userId,
            event,
            payment,
            subscription,
            step: "subscription_inactivated_set_valid_until",
            errorCode,
            message: err?.message || String(err),
          }));
          await emitWebhookFailureMetrics({ userId, payment, subscription, event, step: "subscription_inactivated_set_valid_until", errorCode });
        }
      }

      let validUntil = "";
      try {
        validUntil = await getCardValidUntil(userId);
      } catch (err) {
        const errorCode = classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.STATE);
        await logWebhookOperational("warn", buildWebhookOperationalContext({
          userId,
          event,
          payment,
          subscription,
          step: "subscription_inactivated_get_valid_until",
          errorCode,
          message: err?.message || String(err),
        }));
        await emitWebhookFailureMetrics({ userId, payment, subscription, event, step: "subscription_inactivated_get_valid_until", errorCode });
      }

      if (validUntil) {
        const daysLeft = daysLeftUntilIso(validUntil);
        if (typeof daysLeft === "number" && daysLeft >= 0) {
          await logWebhookOperational("info", buildWebhookOperationalContext({
            userId,
            event,
            payment,
            subscription,
            step: "subscription_inactivated_still_valid",
            message: `Assinatura inativada, mas ainda válida até ${validUntil}.`,
            meta: { validUntil, daysLeft },
          }));
          return { ok: true, ignored: true, stillValidUntil: validUntil };
        }
      }

      try {
        await setUserStatus(userId, "WAIT_PLAN");
      } catch (err) {
        const errorCode = classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.STATE);
        await logWebhookOperational("error", buildWebhookOperationalContext({
          userId,
          event,
          payment,
          subscription,
          step: "subscription_inactivated_set_wait_plan",
          errorCode,
          message: err?.message || String(err),
        }));
        await emitWebhookFailureMetrics({ userId, payment, subscription, event, step: "subscription_inactivated_set_wait_plan", errorCode });
        return { ok: false, error: err?.message || String(err), errorCode };
      }

      await logWebhookOperational("info", buildWebhookOperationalContext({
        userId,
        event,
        payment,
        subscription,
        step: "subscription_inactivated_wait_plan",
        message: "Assinatura inativada sem validade futura. Usuário enviado para WAIT_PLAN.",
      }));

      return { ok: true, statusSetTo: "WAIT_PLAN" };
    }

    // Ledger de eventos ignorados também é útil para reconciliação.
    await recordWebhookLedgerSafe({
      event,
      userId,
      payment,
      subscription,
      couponFinalize: null,
      storedQuote: await getQuoteSnapshotForLedger(userId),
    });

    await logWebhookOperational("info", buildWebhookOperationalContext({
      userId,
      event,
      payment,
      subscription,
      step: "ignored_event",
      message: "Evento ignorado após reconciliação em ledger.",
    }));

    return { ok: true, ignored: true };
  } catch (err) {
    const errorCode = safeStr(err?.code || classifyWebhookRuntimeError(err, ASAAS_WEBHOOK_ERROR.RUNTIME));
    const payload = normalizeWebhookPayload(body);
    const fallbackUserId =
      safeStr(payload?.payment?.externalReference) ||
      safeStr(payload?.subscription?.externalReference) ||
      "";

    await logWebhookOperational("error", buildWebhookOperationalContext({
      userId: fallbackUserId,
      event: payload?.event,
      payment: payload?.payment,
      subscription: payload?.subscription,
      step: "handle_asaas_webhook_event",
      errorCode,
      message: err?.message || String(err),
    }));

    await emitWebhookFailureMetrics({
      userId: fallbackUserId,
      payment: payload?.payment,
      subscription: payload?.subscription,
      event: payload?.event,
      step: "handle_asaas_webhook_event",
      errorCode,
    });

    return { ok: false, error: err?.message || String(err), errorCode };
  }
}
