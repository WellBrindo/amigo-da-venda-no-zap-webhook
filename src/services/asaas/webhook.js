import { redisGet, redisSet, redisExpire } from "../redis.js";
import crypto from "crypto";
// src/services/asaas/webhook.js

import {
  ensureUserExists,
  setUserStatus,
  getUserPlan,
  resetUserQuotaUsed,
  resetUserTrialUsed,
  getCardValidUntil,
  setCardValidUntil,
} from "../state.js";

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

    // ==============================
    // IDEMPOTÊNCIA (evita reprocessar retries do Asaas)
    // ==============================
    const entityIdRaw =
      payment?.id ||
      subscription?.id ||
      body?.id ||
      null;

    const bodyHash = (() => {
      try {
        const s = JSON.stringify(body || {});
        return crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
      } catch {
        return "nohash";
      }
    })();

    const entityId = String(entityIdRaw || bodyHash).trim();
    const idemKey = `asaas:evt:${String(event || "UNKNOWN")}:${entityId}`;

    try {
      const seen = await redisGet(idemKey);
      if (seen) {
        console.log("[ASAAS_WEBHOOK] Evento duplicado ignorado:", { waId, event, entityId });
        return { ok: true, ignored: true, duplicate: true };
      }
      await redisSet(idemKey, "1");
      await redisExpire(idemKey, 60 * 60 * 24 * 3); // 3 dias
    } catch (err) {
      // se Redis falhar, não bloquear o fluxo do webhook
      console.warn("[ASAAS_WEBHOOK_WARN] Falha ao aplicar idempotência:", String(err?.message || err));
    }


    await ensureUserExists(waId);

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
