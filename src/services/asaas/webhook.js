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

import { sendWhatsAppText } from "../meta/whatsapp.js";
import { recordAsaasEvent } from "./ledger.js";
/**
 * Webhook handler do Asaas
 * externalReference = waId
 */

export async function handleAsaasWebhookEvent(body) {
  try {
    const event = body?.event;
    const payment = body?.payment;
    const subscription = body?.subscription;

    const waId =
      payment?.externalReference ||
      subscription?.externalReference ||
      null;

    if (!waId) {
      console.log("[ASAAS_WEBHOOK] Evento sem externalReference ignorado.");
      return { ok: false, reason: "no_external_reference" };
    }

    await ensureUserExists(waId);

    // Ledger (Admin: histórico / reconciliação)
    await recordAsaasEvent({ event, waId, payment, subscription, source: "webhook" });

    // ==============================
    // PAGAMENTO CONFIRMADO
    // ==============================
    if (
      event === "PAYMENT_RECEIVED" ||
      event === "PAYMENT_CONFIRMED"
    ) {
      const plan = await getUserPlan(waId);

      if (!plan) {
        console.log(
          "[ASAAS_WEBHOOK_WARNING] Payment confirmed but plan missing",
          { waId, event }
        );
      }

      await resetUserQuotaUsed(waId);
      await resetUserTrialUsed(waId);

      const [billingCityState, billingAddress] = await Promise.all([
        getBillingCityState(waId),
        getBillingAddress(waId),
      ]);

      if (!billingCityState) {
        await setPrevStatus(waId, "ACTIVE");
        await setUserStatus(waId, "WAIT_BILLING_CITY_STATE");
        await sendWhatsAppText({
          to: waId,
          text: [
            "✅ Pagamento confirmado! Seu plano já está ativo.",
            "",
            "Agora preciso de uma informação para completar o seu cadastro.",
            "",
            "📍 Qual é sua *Cidade/UF*? (ex: Atibaia/SP)",
            "",
            "A qualquer momento, você pode digitar *MENU* para acessar as opções de configuração.",
          ].join("\n"),
        }).catch((err) => console.error("[ASAAS_WEBHOOK_SEND_CITY_ERROR]", err?.message || err));

        console.log("[ASAAS_WEBHOOK] Usuário ativado e aguardando cidade/UF:", { waId, event, plan: plan || "NONE" });
        return { ok: true, statusSetTo: "WAIT_BILLING_CITY_STATE" };
      }

      if (!billingAddress) {
        await setPrevStatus(waId, "ACTIVE");
        await setUserStatus(waId, "WAIT_BILLING_ADDRESS");
        await sendWhatsAppText({
          to: waId,
          text: [
            "✅ Pagamento confirmado! Seu plano já está ativo.",
            "",
            "Agora me diga seu *endereço* (rua, número, bairro).",
            "",
            "Se for apenas atendimento online, responda: *APENAS ONLINE*",
            "",
            "A qualquer momento, você pode digitar *MENU* para acessar as opções de configuração.",
          ].join("\n"),
        }).catch((err) => console.error("[ASAAS_WEBHOOK_SEND_ADDRESS_ERROR]", err?.message || err));

        console.log("[ASAAS_WEBHOOK] Usuário ativado e aguardando endereço:", { waId, event, plan: plan || "NONE" });
        return { ok: true, statusSetTo: "WAIT_BILLING_ADDRESS" };
      }

      await setUserStatus(waId, "ACTIVE");

      console.log("[ASAAS_WEBHOOK] Usuário ativado:", {
        waId,
        event,
        plan: plan || "NONE",
      });

      return { ok: true, statusSetTo: "ACTIVE" };
    }

    // ==============================
    // PAGAMENTO VENCIDO
    // ==============================
    if (event === "PAYMENT_OVERDUE") {
      await setUserStatus(waId, "PAYMENT_PENDING");

      console.log("[ASAAS_WEBHOOK] Pagamento vencido:", {
        waId,
        event,
      });

      return { ok: true, statusSetTo: "PAYMENT_PENDING" };
    }

    // ==============================
    // PAGAMENTO DELETADO
    // ==============================
    if (event === "PAYMENT_DELETED") {
      await setUserStatus(waId, "BLOCKED");

      console.log("[ASAAS_WEBHOOK] Pagamento deletado:", {
        waId,
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
        await setCardValidUntil(waId, nextDue);
      }

      const validUntil = await getCardValidUntil(waId);
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
            waId,
            event,
            validUntil,
            daysLeft,
          });
          return { ok: true, ignored: true, stillValidUntil: validUntil };
        }
      }

      // Sem validade (ou expirado) => força reescolha de plano
      await setUserStatus(waId, "WAIT_PLAN");

      console.log("[ASAAS_WEBHOOK] Assinatura inativada (sem validade):", {
        waId,
        event,
      });

      return { ok: true, statusSetTo: "WAIT_PLAN" };
    }

    console.log("[ASAAS_WEBHOOK] Evento ignorado:", {
      waId,
      event,
    });

    return { ok: true, ignored: true };
  } catch (err) {
    console.error("[ASAAS_WEBHOOK_ERROR]", err);
    return { ok: false, error: err.message };
  }
}
