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
import { getPreferredOutboundRecipient } from "../identity.js";
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
    console.error(`[${errorTag}] Missing outbound recipient`, { userId, key });
    return;
  }

  await sendWhatsAppText({ recipient, text }).catch((err) => {
    console.error(`[${errorTag}]`, err?.message || err);
  });
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
      return { ok: true, skipped: true, reason: "no_coupon_reservation" };
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
      return { ok: false, reason: "invalid_mode", mode };
    }

    await resetCheckoutCouponState(userId);
    return result || { ok: true, reservationId };
  } catch (err) {
    console.error("[ASAAS_WEBHOOK_COUPON_FINALIZE_ERROR]", {
      userId,
      mode,
      event,
      message: err?.message || String(err),
    });
    return { ok: false, error: err?.message || String(err) };
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

export async function handleAsaasWebhookEvent(body) {
  try {
    const event = body?.event;
    const payment = body?.payment;
    const subscription = body?.subscription;

    const paymentId = safeStr(payment?.id);
    const subscriptionId = safeStr(subscription?.id);

    const userId =
      payment?.externalReference ||
      subscription?.externalReference ||
      null;

    if (!userId) {
      console.log("[ASAAS_WEBHOOK] Evento sem externalReference ignorado.");
      return { ok: false, reason: "no_external_reference" };
    }

    await ensureUserExists(userId);

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

      await recordWebhookLedger({
        event,
        userId,
        payment,
        subscription,
        couponFinalize,
        storedQuote,
      });

      const plan = await getUserPlan(userId);

      if (!plan) {
        console.log(
          "[ASAAS_WEBHOOK_WARNING] Payment confirmed but plan missing",
          { userId, event }
        );
      }

      await resetUserQuotaUsed(userId);
      await resetUserTrialUsed(userId);

      const [billingCityState, billingAddress] = await Promise.all([
        getBillingCityState(userId),
        getBillingAddress(userId),
      ]);

      if (!billingCityState) {
        await setPrevStatus(userId, "ACTIVE");
        await setUserStatus(userId, "WAIT_BILLING_CITY_STATE");
        await sendCopyText(
          userId,
          "FLOW_ASK_BILLING_CITY_STATE",
          {},
          "ASAAS_WEBHOOK_SEND_CITY_ERROR"
        );

        console.log("[ASAAS_WEBHOOK] Usuário ativado e aguardando cidade/UF:", { userId, event, plan: plan || "NONE" });
        return { ok: true, statusSetTo: "WAIT_BILLING_CITY_STATE" };
      }

      if (!billingAddress) {
        await setPrevStatus(userId, "ACTIVE");
        await setUserStatus(userId, "WAIT_BILLING_ADDRESS");
        await sendCopyText(
          userId,
          "FLOW_ASK_BILLING_ADDRESS",
          {},
          "ASAAS_WEBHOOK_SEND_ADDRESS_ERROR"
        );

        console.log("[ASAAS_WEBHOOK] Usuário ativado e aguardando endereço:", { userId, event, plan: plan || "NONE" });
        return { ok: true, statusSetTo: "WAIT_BILLING_ADDRESS" };
      }

      await setUserStatus(userId, "ACTIVE");
      await sendCopyText(
        userId,
        "FLOW_PLAN_ACTIVATED_WELCOME",
        {},
        "ASAAS_WEBHOOK_SEND_ACTIVE_WELCOME_ERROR"
      );

      console.log("[ASAAS_WEBHOOK] Usuário ativado:", {
        userId,
        event,
        plan: plan || "NONE",
      });

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

      await recordWebhookLedger({
        event,
        userId,
        payment,
        subscription,
        couponFinalize,
        storedQuote,
      });

      await setUserStatus(userId, "WAIT_PAYMENT_RECOVERY");
      await sendCopyText(
        userId,
        "FLOW_PAYMENT_RECOVERY",
        {},
        "ASAAS_WEBHOOK_SEND_PAYMENT_RECOVERY_ERROR"
      );

      console.log("[ASAAS_WEBHOOK] Falha no cartão / recuperação iniciada:", {
        userId,
        event,
      });

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

      await recordWebhookLedger({
        event,
        userId,
        payment,
        subscription,
        couponFinalize,
        storedQuote,
      });

      await setUserStatus(userId, "PAYMENT_PENDING");

      console.log("[ASAAS_WEBHOOK] Pagamento vencido:", {
        userId,
        event,
      });

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

      await recordWebhookLedger({
        event,
        userId,
        payment,
        subscription,
        couponFinalize,
        storedQuote,
      });

      await setUserStatus(userId, "BLOCKED");

      console.log("[ASAAS_WEBHOOK] Pagamento deletado:", {
        userId,
        event,
      });

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

      await recordWebhookLedger({
        event,
        userId,
        payment,
        subscription,
        couponFinalize,
        storedQuote,
      });

      // Regra do produto:
      // - Se o usuário cancelou a recorrência, ele mantém acesso até o fim do ciclo atual.
      // - Portanto, NÃO bloqueamos imediatamente se ainda existir validade futura.
      const nextDue = String(subscription?.nextDueDate || subscription?.nextPaymentDate || "").trim();
      if (nextDue) {
        // best-effort para ter data de renovação disponível no menu
        await setCardValidUntil(userId, nextDue);
      }

      const validUntil = await getCardValidUntil(userId);
      if (validUntil) {
        const daysLeft = (() => {
          const m = String(validUntil).match(/^(\d{4})-(\d{2})-(\d{2})$/);
          if (!m) return null;
          const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
          const target = new Date(y, mo, d, 23, 59, 59);
          const now = new Date();
          const diffMs = target.getTime() - now.getTime();
          return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
        })();

        // ainda válido => não altera status
        if (typeof daysLeft === "number" && daysLeft >= 0) {
          console.log("[ASAAS_WEBHOOK] Assinatura inativada, mas ainda válida até:", {
            userId,
            event,
            validUntil,
            daysLeft,
          });
          return { ok: true, ignored: true, stillValidUntil: validUntil };
        }
      }

      // Sem validade (ou expirado) => força reescolha de plano
      await setUserStatus(userId, "WAIT_PLAN");

      console.log("[ASAAS_WEBHOOK] Assinatura inativada (sem validade):", {
        userId,
        event,
      });

      return { ok: true, statusSetTo: "WAIT_PLAN" };
    }

    // Ledger de eventos ignorados também é útil para reconciliação.
    await recordWebhookLedger({
      event,
      userId,
      payment,
      subscription,
      couponFinalize: null,
      storedQuote: await getQuoteSnapshotForLedger(userId),
    });

    console.log("[ASAAS_WEBHOOK] Evento ignorado:", {
      userId,
      event,
    });

    return { ok: true, ignored: true };
  } catch (err) {
    console.error("[ASAAS_WEBHOOK_ERROR]", err);
    return { ok: false, error: err.message };
  }
}
