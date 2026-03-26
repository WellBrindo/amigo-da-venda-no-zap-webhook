// src/services/asaas/client.js
/**
 * Cliente simples do Asaas (sem SDK, sem gambiarra).
 *
 * Regras:
 * - Nunca logar CPF/CNPJ.
 * - Nunca expor API Key.
 * - Não recalcular preço fora do quote oficial.
 * - Materializar no Asaas apenas o resultado já calculado pelo pricing.js.
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

function safeStr(value) {
  return String(value ?? "").trim();
}

function safeUpper(value) {
  return safeStr(value).toUpperCase();
}

function safeLower(value) {
  return safeStr(value).toLowerCase();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeMoneyValue(value) {
  const n = toNumber(value, 0);
  return Math.max(0, Number(n.toFixed(2)));
}

function centsToValue(cents) {
  return normalizeMoneyValue(toNumber(cents, 0) / 100);
}

function normalizeSubscriptionCycle(cycle = "MONTHLY") {
  const normalized = safeUpper(cycle);
  if (normalized === "YEARLY" || normalized === "ANNUAL") return "YEARLY";
  return "MONTHLY";
}

function normalizeBillingCycle(cycle = "monthly") {
  const normalized = safeLower(cycle);
  return normalized === "annual" || normalized === "yearly" ? "annual" : "monthly";
}

function normalizeAppliesTo(value = "first_charge_only") {
  const normalized = safeLower(value);
  return normalized === "entire_subscription" ? "entire_subscription" : "first_charge_only";
}

function normalizeChargeMode(value = "") {
  const normalized = safeLower(value);
  if (
    normalized === "recurring_monthly" ||
    normalized === "recurring_annual" ||
    normalized === "monthly_checkout" ||
    normalized === "annual_checkout"
  ) {
    return normalized;
  }
  return "";
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(baseDate, days) {
  const base = safeStr(baseDate) || todayISO();
  const d = new Date(`${base}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function buildDescriptionParts({ planName = "", billingCycle = "monthly", quote = null } = {}) {
  const parts = [];
  const plan = safeStr(planName);
  const cycle = normalizeBillingCycle(billingCycle);
  const couponCode = safeStr(quote?.couponCode || quote?.explanation?.couponCode);

  if (plan) parts.push(`Plano ${plan}`);
  parts.push(cycle === "annual" ? "cobrança anual" : "cobrança mensal");
  if (couponCode) parts.push(`cupom ${couponCode}`);

  return parts;
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

function normalizeQuotePayload(quote = {}) {
  const planCode = safeStr(quote?.planCode);
  const planName = safeStr(quote?.plan?.name || quote?.explanation?.planName);
  const billingCycle = normalizeBillingCycle(
    quote?.billingCycle || quote?.explanation?.billingCycle || "monthly"
  );
  const chargeMode = normalizeChargeMode(quote?.chargeMode);
  const calculation = quote?.calculation || {};
  const basePriceCents = Math.max(0, Math.trunc(toNumber(calculation.basePriceCents, 0)));
  const discountAmountCents = Math.max(0, Math.trunc(toNumber(calculation.discountAmountCents, 0)));
  const finalPriceCents = Math.max(0, Math.trunc(toNumber(calculation.finalPriceCents, 0)));
  const appliesTo = normalizeAppliesTo(calculation.appliesTo || quote?.explanation?.appliesTo);
  const couponCode = safeStr(quote?.couponCode || quote?.explanation?.couponCode);

  return {
    ok: !!quote?.ok,
    valid: !!quote?.valid,
    code: safeStr(quote?.code),
    reason: safeStr(quote?.reason),
    internalUserId: safeStr(quote?.internalUserId),
    planCode,
    planName,
    billingCycle,
    chargeMode,
    couponCode,
    appliesTo,
    basePriceCents,
    discountAmountCents,
    finalPriceCents,
    basePriceValue: centsToValue(basePriceCents),
    discountAmountValue: centsToValue(discountAmountCents),
    finalPriceValue: centsToValue(finalPriceCents),
  };
}

function assertValidQuote(quote = {}) {
  const normalized = normalizeQuotePayload(quote);

  if (!normalized.ok || !normalized.valid) {
    throw new Error(normalized.reason || normalized.code || "Invalid pricing quote");
  }

  if (!normalized.planCode) {
    throw new Error("Quote missing planCode");
  }

  if (normalized.finalPriceCents <= 0) {
    throw new Error("Quote finalPriceCents must be greater than zero");
  }

  return normalized;
}

export function buildAsaasChargeContextFromQuote({
  quote = {},
  paymentMethod = "",
  dueDate = "",
  paymentDate = "",
} = {}) {
  const q = assertValidQuote(quote);
  const method = safeLower(paymentMethod);
  const resolvedDueDate = safeStr(dueDate) || safeStr(paymentDate) || addDaysISO(todayISO(), 1);
  const resolvedPaymentDate = safeStr(paymentDate) || resolvedDueDate;

  const description = buildDescriptionParts({
    planName: q.planName,
    billingCycle: q.billingCycle,
    quote,
  }).join(" | ");

  const subscriptionCycle = normalizeSubscriptionCycle(
    q.billingCycle === "annual" ? "YEARLY" : "MONTHLY"
  );

  const recurringSupported = q.appliesTo === "entire_subscription";
  const firstChargeOnlyRecurringUnsupported = q.appliesTo === "first_charge_only";

  const context = {
    ok: true,
    valid: true,
    paymentMethod: method || "",
    planCode: q.planCode,
    planName: q.planName,
    billingCycle: q.billingCycle,
    subscriptionCycle,
    chargeMode:
      q.chargeMode ||
      (q.billingCycle === "annual"
        ? recurringSupported
          ? "recurring_annual"
          : "annual_checkout"
        : recurringSupported
          ? "recurring_monthly"
          : "monthly_checkout"),
    appliesTo: q.appliesTo,
    couponCode: q.couponCode,
    basePriceCents: q.basePriceCents,
    discountAmountCents: q.discountAmountCents,
    finalPriceCents: q.finalPriceCents,
    basePriceValue: q.basePriceValue,
    discountAmountValue: q.discountAmountValue,
    finalPriceValue: q.finalPriceValue,
    description,
    dueDate: resolvedDueDate,
    paymentDate: resolvedPaymentDate,
    recurringSupported,
    firstChargeOnlyRecurringUnsupported,
    restrictions: [],
  };

  if ((method === "credit_card" || method === "card") && firstChargeOnlyRecurringUnsupported) {
    context.ok = false;
    context.valid = false;
    context.code = "recurring_first_charge_discount_not_supported";
    context.reason =
      "Na operação atual do Asaas, o fluxo recorrente por link de cartão não diferencia a primeira cobrança da recorrência subsequente sem lógica adicional fora deste cliente.";
    context.restrictions.push(context.reason);
  }

  return context;
}

// -------------------- Customer --------------------
export async function findCustomerByExternalReference(externalReference) {
  const ref = safeStr(externalReference);
  if (!ref) return null;

  const q = new URLSearchParams({ externalReference: ref, limit: "10", offset: "0" }).toString();
  const data = await asaasFetch(`/customers?${q}`);

  const first = data?.data?.[0];
  if (!first?.id) return null;
  return first;
}

export async function createCustomer({ name, cpfCnpj, externalReference }) {
  const nm = safeStr(name) || "Cliente Amigo das Vendas";
  const doc = safeStr(cpfCnpj);
  const ref = safeStr(externalReference);

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
    customer: safeStr(customerId),
    billingType: "PIX",
    value: normalizeMoneyValue(value),
    dueDate: safeStr(dueDate),
    description: safeStr(description),
    externalReference: externalReference ? safeStr(externalReference) : undefined,
  };

  return asaasFetch("/payments", { method: "POST", body: payload });
}

export async function createPixPaymentFromQuote({
  customerId,
  quote,
  description = "",
  externalReference,
  dueDate,
}) {
  const context = buildAsaasChargeContextFromQuote({
    quote,
    paymentMethod: "pix",
    dueDate,
  });

  return createPixPayment({
    customerId,
    value: context.finalPriceValue,
    description: safeStr(description) || context.description,
    externalReference,
    dueDate: context.dueDate,
  });
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
    name: safeStr(name || "Assinatura Amigo das Vendas"),
    description: safeStr(description),
    chargeType: "RECURRENT",
    billingType: "CREDIT_CARD",
    subscriptionCycle: normalizeSubscriptionCycle(subscriptionCycle),
    value: normalizeMoneyValue(value),
    externalReference: externalReference ? safeStr(externalReference) : undefined,
  };

  return asaasFetch("/paymentLinks", { method: "POST", body: payload });
}

export async function createRecurringCardPaymentLinkFromQuote({
  quote,
  name = "",
  description = "",
  externalReference,
}) {
  const context = buildAsaasChargeContextFromQuote({
    quote,
    paymentMethod: "credit_card",
  });

  if (!context.ok || !context.valid) {
    const err = new Error(context.reason || "Quote not supported for recurring card payment link");
    err.code = context.code || "quote_not_supported_for_recurring_link";
    err.context = context;
    throw err;
  }

  return createRecurringCardPaymentLink({
    name: safeStr(name) || safeStr(context.planName) || "Assinatura Amigo das Vendas",
    description: safeStr(description) || context.description,
    value: context.finalPriceValue,
    externalReference,
    subscriptionCycle: context.subscriptionCycle,
  });
}

export async function createAsaasCheckoutFromQuote({
  customerId = "",
  quote = {},
  paymentMethod = "",
  externalReference = "",
  dueDate = "",
  description = "",
  name = "",
} = {}) {
  const method = safeLower(paymentMethod);

  if (method === "pix") {
    return createPixPaymentFromQuote({
      customerId,
      quote,
      description,
      externalReference,
      dueDate,
    });
  }

  if (method === "credit_card" || method === "card") {
    return createRecurringCardPaymentLinkFromQuote({
      quote,
      name,
      description,
      externalReference,
    });
  }

  throw new Error("Unsupported paymentMethod. Use pix or credit_card.");
}

// -------------------- Subscriptions --------------------
// Observação: Asaas pode oferecer endpoints diferentes para cancelar.
// Estratégia segura:
// 1) Tentar POST /subscriptions/{id}/cancel
// 2) Se falhar (404/405), tentar DELETE /subscriptions/{id}

export async function getSubscription({ subscriptionId }) {
  const id = safeStr(subscriptionId);
  if (!id) throw new Error("subscriptionId required");
  return asaasFetch(`/subscriptions/${id}`, { method: "GET" });
}

export async function cancelSubscription({ subscriptionId }) {
  const id = safeStr(subscriptionId);
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
  const id = safeStr(paymentId);
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

  if (externalReference) params.set("externalReference", safeStr(externalReference));
  if (customerId) params.set("customer", safeStr(customerId));
  if (subscriptionId) params.set("subscription", safeStr(subscriptionId));
  if (status) params.set("status", safeStr(status));
  if (billingType) params.set("billingType", safeStr(billingType));

  // Asaas aceita dateCreated (YYYY-MM-DD) e possivelmente filtros por intervalo via createdDate[ge]/[le] em alguns endpoints.
  // Mantemos abordagem compatível: se apenas um lado foi fornecido, enviamos dateCreated (from).
  if (dateCreatedFrom && !dateCreatedTo) params.set("dateCreated", safeStr(dateCreatedFrom));
  if (dateCreatedFrom && dateCreatedTo) {
    params.set("dateCreated[ge]", safeStr(dateCreatedFrom));
    params.set("dateCreated[le]", safeStr(dateCreatedTo));
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
  if (externalReference) params.set("externalReference", safeStr(externalReference));
  if (customerId) params.set("customer", safeStr(customerId));
  if (status) params.set("status", safeStr(status));
  params.set("limit", String(Number(limit) || 50));
  params.set("offset", String(Number(offset) || 0));
  return asaasFetch(`/subscriptions?${params.toString()}`, { method: "GET" });
}

export async function listSubscriptionsByExternalReference(externalReference, { limit = 50, offset = 0 } = {}) {
  return listSubscriptions({ externalReference, limit, offset });
}
