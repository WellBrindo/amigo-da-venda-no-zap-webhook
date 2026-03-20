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
} from "../state.js";

import { getCopyText } from "../copy.js";
import { sendWhatsAppText } from "../meta/whatsapp.js";
import { recordAsaasEvent } from "./ledger.js";
import { getPreferredOutboundRecipient } from "../identity.js";
/**
 * Webhook handler do Asaas
 * externalReference = internalUserId (compatível com legado por alias)
 */

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

export async function handleAsaasWebhookEvent(body) {
  try {
    const event = body?.event;
    const payment = body?.payment;
    const subscription = body?.subscription;

    const userId =
      payment?.externalReference ||
      subscription?.externalReference ||
      null;

    if (!userId) {
      console.log("[ASAAS_WEBHOOK] Evento sem externalReference ignorado.");
      return { ok: false, reason: "no_external_reference" };
    }

    await ensureUserExists(userId);

    // Ledger (Admin: histórico / reconciliação)
    await recordAsaasEvent({ event, waId: userId, payment, subscription, source: "webhook" });

    // ==============================
    // PAGAMENTO CONFIRMADO
    // ==============================
    if (
      event === "PAYMENT_RECEIVED" ||
      event === "PAYMENT_CONFIRMED"
    ) {
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
