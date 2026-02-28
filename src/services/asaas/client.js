// src/services/asaas/client.js
/**
 * Cliente simples do Asaas (sem SDK, sem gambiarra).
 *
 * Regras:
 * - Nunca logar CPF/CNPJ.
 * - Nunca expor API Key.
 */

function env(name, def = "") {
  return String(process.env[name] || def).trim();
}

function asaasBaseUrl() {
  const e = env("ASAAS_ENV", "production").toLowerCase();
  // produção: api.asaas.com | sandbox: api-sandbox.asaas.com
  return e === "sandbox" ? "https://api-sandbox.asaas.com/v3" : "https://api.asaas.com/v3";
}

function asaasHeaders() {
  const key = env("ASAAS_API_KEY");
  if (!key) throw new Error("ASAAS_API_KEY missing");
  return {
    "Content-Type": "application/json",
    access_token: key,
  };
}

async function asaasFetch(path, { method = "GET", body = undefined } = {}) {
  const url = `${asaasBaseUrl()}${path}`;
  const init = {
    method,
    headers: asaasHeaders(),
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg =
      (json && json.errors && json.errors[0] && json.errors[0].description) ||
      (json && json.message) ||
      text ||
      `Asaas HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = json;
    throw err;
  }

  return json;
}

// -------------------- Customer --------------------
export async function findCustomerByExternalReference(externalReference) {
  const ref = String(externalReference || "").trim();
  if (!ref) return null;

  const q = new URLSearchParams({ externalReference: ref, limit: "10", offset: "0" }).toString();
  const data = await asaasFetch(`/customers?${q}`);

  const first = data?.data?.[0];
  if (!first?.id) return null;
  return first;
}

export async function createCustomer({ name, cpfCnpj, externalReference }) {
  const nm = String(name || "").trim() || "Cliente Amigo das Vendas";
  const doc = String(cpfCnpj || "").trim();
  const ref = String(externalReference || "").trim();

  // ⚠️ não logar doc
  const payload = {
    name: nm,
    cpfCnpj: doc,
    externalReference: ref || undefined,
  };

  return asaasFetch("/customers", { method: "POST", body: payload });
}

// -------------------- Payment (PIX / boleto / etc) --------------------
export async function createPixPayment({ customerId, value, description, externalReference, dueDate }) {
  const payload = {
    customer: String(customerId),
    billingType: "PIX",
    value: Number(value),
    dueDate: String(dueDate),
    description: String(description || ""),
    externalReference: externalReference ? String(externalReference) : undefined,
  };

  return asaasFetch("/payments", { method: "POST", body: payload });
}

// -------------------- Payment Link (Recurring credit card) --------------------
export async function createRecurringCardPaymentLink({
  name,
  description,
  value,
  externalReference,
  subscriptionCycle = "MONTHLY",
}) {
  // Docs: /v3/paymentLinks
  // chargeType: RECURRENT => cria assinatura automática após checkout
  const payload = {
    name: String(name || "Assinatura Amigo das Vendas"),
    description: String(description || ""),
    chargeType: "RECURRENT",
    billingType: "CREDIT_CARD",
    subscriptionCycle: String(subscriptionCycle || "MONTHLY"),
    value: Number(value),
    externalReference: externalReference ? String(externalReference) : undefined,
  };

  return asaasFetch("/paymentLinks", { method: "POST", body: payload });
}

// -------------------- Subscriptions --------------------
// Observação: Asaas pode oferecer endpoints diferentes para cancelar.
// Estratégia segura:
// 1) Tentar POST /subscriptions/{id}/cancel
// 2) Se falhar (404/405), tentar DELETE /subscriptions/{id}

export async function getSubscription({ subscriptionId }) {
  const id = String(subscriptionId || "").trim();
  if (!id) throw new Error("subscriptionId required");
  return asaasFetch(`/subscriptions/${id}`, { method: "GET" });
}

export async function cancelSubscription({ subscriptionId }) {
  const id = String(subscriptionId || "").trim();
  if (!id) throw new Error("subscriptionId required");

  // 1) POST cancel (quando disponível)
  try {
    return await asaasFetch(`/subscriptions/${id}/cancel`, { method: "POST" });
  } catch (err) {
    const st = Number(err?.status || 0);
    // 404/405/400: tenta alternativa
    if (st && st !== 404 && st !== 405 && st !== 400) throw err;
  }

  // 2) DELETE subscription
  return asaasFetch(`/subscriptions/${id}`, { method: "DELETE" });
}

// -------------------- Payments (Consulta / Reconciliação) --------------------
export async function getPayment({ paymentId }) {
  const id = String(paymentId || "").trim();
  if (!id) throw new Error("paymentId required");
  return asaasFetch(`/payments/${id}`, { method: "GET" });
}

export async function listPayments({
  externalReference,
  customerId,
  subscriptionId,
  status,
  billingType,
  dateCreatedFrom,
  dateCreatedTo,
  limit = 50,
  offset = 0,
} = {}) {
  const params = new URLSearchParams();

  if (externalReference) params.set("externalReference", String(externalReference));
  if (customerId) params.set("customer", String(customerId));
  if (subscriptionId) params.set("subscription", String(subscriptionId));
  if (status) params.set("status", String(status));
  if (billingType) params.set("billingType", String(billingType));

  // Asaas aceita dateCreated (YYYY-MM-DD) e possivelmente filtros por intervalo via createdDate[ge]/[le] em alguns endpoints.
  // Mantemos abordagem compatível: se apenas um lado foi fornecido, enviamos dateCreated (from).
  if (dateCreatedFrom && !dateCreatedTo) params.set("dateCreated", String(dateCreatedFrom));
  if (dateCreatedFrom && dateCreatedTo) {
    params.set("dateCreated[ge]", String(dateCreatedFrom));
    params.set("dateCreated[le]", String(dateCreatedTo));
  }

  params.set("limit", String(Number(limit) || 50));
  params.set("offset", String(Number(offset) || 0));

  return asaasFetch(`/payments?${params.toString()}`, { method: "GET" });
}

export async function listPaymentsByExternalReference(externalReference, { limit = 50, offset = 0 } = {}) {
  return listPayments({ externalReference, limit, offset });
}

// -------------------- Subscriptions (Listagem) --------------------
export async function listSubscriptions({
  externalReference,
  customerId,
  status,
  limit = 50,
  offset = 0,
} = {}) {
  const params = new URLSearchParams();
  if (externalReference) params.set("externalReference", String(externalReference));
  if (customerId) params.set("customer", String(customerId));
  if (status) params.set("status", String(status));
  params.set("limit", String(Number(limit) || 50));
  params.set("offset", String(Number(offset) || 0));
  return asaasFetch(`/subscriptions?${params.toString()}`, { method: "GET" });
}

export async function listSubscriptionsByExternalReference(externalReference, { limit = 50, offset = 0 } = {}) {
  return listSubscriptions({ externalReference, limit, offset });
}
