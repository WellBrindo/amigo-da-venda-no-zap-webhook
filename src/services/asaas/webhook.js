import { setUserStatus, setUserPlan, ensureUserExists } from "../state.js";

/**
 * Regras (MVP SaaS):
 * - PAYMENT_RECEIVED / PAYMENT_CONFIRMED => ACTIVE
 * - PAYMENT_OVERDUE => PAYMENT_PENDING (ou BLOCKED depois, se você quiser grace period)
 * - PAYMENT_DELETED => BLOCKED
 * - SUBSCRIPTION_INACTIVATED / SUBSCRIPTION_DELETED => BLOCKED
 *
 * Identificação do usuário:
 * - Vamos depender de "externalReference" == waId (ex: 5511....)
 *   (No passo seguinte, quando criarmos cobranças/assinaturas, vamos gravar o waId lá.)
 */
function pickWaIdFromEvent(payload) {
  // Asaas geralmente envia: { event: "PAYMENT_RECEIVED", payment: {...} }
  // ou: { event: "SUBSCRIPTION_INACTIVATED", subscription: {...} }
  const payment = payload?.payment;
  const subscription = payload?.subscription;

  const ref =
    (payment && (payment.externalReference || payment.external_reference)) ||
    (subscription && (subscription.externalReference || subscription.external_reference)) ||
    payload?.externalReference ||
    payload?.external_reference ||
    "";

  const waId = String(ref || "").trim();
  return waId;
}

function pickPlanCodeFromEvent(payload) {
  // Para já “amarrar” o plano escolhido:
  // no próximo passo vamos gravar o planCode em descrição/metadata; por enquanto tenta achar algo:
  const payment = payload?.payment;
  const desc = String(payment?.description || "");
  // Se você quiser, depois colocamos um formato padrão: "PLANO:DE_VEZ_EM_QUANDO"
  const m = desc.match(/PLANO:([A-Z0-9_]+)/i);
  return m ? String(m[1] || "").toUpperCase() : "";
}

export async function handleAsaasWebhookEvent(payload) {
  const event = String(payload?.event || "").trim();
  if (!event) return { ignored: true, reason: "missing_event" };

  const waId = pickWaIdFromEvent(payload);
  if (!waId) {
    // Sem externalReference não dá para mapear usuário ainda
    return { ignored: true, reason: "missing_externalReference" };
  }

  await ensureUserExists(waId);

  // Opcional: tenta capturar plano do evento (vamos melhorar no passo seguinte)
  const planCode = pickPlanCodeFromEvent(payload);
  if (planCode) {
    await setUserPlan(waId, planCode);
  }

  // Mapear eventos
  if (event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED") {
    await setUserStatus(waId, "ACTIVE");
    return { waId, event, statusSetTo: "ACTIVE" };
  }

  if (event === "PAYMENT_OVERDUE") {
    // MVP: mantém como pendente (você pode decidir bloquear depois de X dias)
    await setUserStatus(waId, "PAYMENT_PENDING");
    return { waId, event, statusSetTo: "PAYMENT_PENDING" };
  }

  if (event === "PAYMENT_DELETED") {
    await setUserStatus(waId, "BLOCKED");
    return { waId, event, statusSetTo: "BLOCKED" };
  }

  if (event === "SUBSCRIPTION_INACTIVATED" || event === "SUBSCRIPTION_DELETED") {
    await setUserStatus(waId, "BLOCKED");
    return { waId, event, statusSetTo: "BLOCKED" };
  }

  if (event === "SUBSCRIPTION_CREATED" || event === "SUBSCRIPTION_UPDATED") {
    // Não muda status por si só; status muda por pagamento.
    return { waId, event, noted: true };
  }

  return { waId, event, ignored: true, reason: "unhandled_event" };
}
