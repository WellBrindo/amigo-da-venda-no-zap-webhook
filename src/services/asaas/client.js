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

import * as metrics from "../metrics.js";
import * as audit from "../audit.js";
import { getPendingIdentityConflictForUser } from "../identity.js";

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
  if (!key) {
    throw buildAsaasClientError({
      errorCode: ASAAS_CLIENT_ERROR_CODE.ENV,
      message: "ASAAS_API_KEY missing",
      retryable: false,
      httpStatus: 500,
      step: "asaasHeaders",
      source: "asaas_client",
    });
  }
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

const ASAAS_CLIENT_TRACKING_MODE = Object.freeze({
  NONE: "none",
  PROVIDER_ONLY: "provider_only",
  PROVIDER_AND_JOURNEY: "provider_and_journey",
});

export const ASAAS_CLIENT_ERROR_CODE = Object.freeze({
  ENV: "ASAAS_ENV_ERROR",
  AUTH: "ASAAS_AUTH_ERROR",
  HTTP: "ASAAS_HTTP_ERROR",
  VALIDATION: "ASAAS_VALIDATION_ERROR",
  CUSTOMER: "ASAAS_CUSTOMER_ERROR",
  PIX_CREATE: "ASAAS_PIX_CREATE_ERROR",
  PAYMENT_LINK: "ASAAS_PAYMENT_LINK_ERROR",
  SUBSCRIPTION: "ASAAS_SUBSCRIPTION_ERROR",
  RESPONSE_PARSE: "ASAAS_RESPONSE_PARSE_ERROR",
  IDENTITY_REVIEW_REQUIRED: "ASAAS_IDENTITY_REVIEW_REQUIRED",
  UNKNOWN: "ASAAS_UNKNOWN_ERROR",
});

function normalizeAsaasClientTrackingMode(value, { fallback = ASAAS_CLIENT_TRACKING_MODE.PROVIDER_ONLY } = {}) {
  const normalized = safeLower(value);
  if (normalized === ASAAS_CLIENT_TRACKING_MODE.NONE) return ASAAS_CLIENT_TRACKING_MODE.NONE;
  if (normalized === ASAAS_CLIENT_TRACKING_MODE.PROVIDER_AND_JOURNEY) return ASAAS_CLIENT_TRACKING_MODE.PROVIDER_AND_JOURNEY;
  if (normalized === ASAAS_CLIENT_TRACKING_MODE.PROVIDER_ONLY) return ASAAS_CLIENT_TRACKING_MODE.PROVIDER_ONLY;
  return fallback;
}

function resolveAsaasClientTrackingMode({
  trackingMode = "",
  trackConversion = true,
  trackCheckoutLifecycle = false,
} = {}) {
  const explicitMode = normalizeAsaasClientTrackingMode(trackingMode, { fallback: "" });
  if (explicitMode) return explicitMode;
  if (!trackConversion && !trackCheckoutLifecycle) return ASAAS_CLIENT_TRACKING_MODE.NONE;
  if (trackConversion && trackCheckoutLifecycle) return ASAAS_CLIENT_TRACKING_MODE.PROVIDER_AND_JOURNEY;
  if (trackConversion) return ASAAS_CLIENT_TRACKING_MODE.PROVIDER_ONLY;
  if (trackCheckoutLifecycle) return ASAAS_CLIENT_TRACKING_MODE.PROVIDER_AND_JOURNEY;
  return ASAAS_CLIENT_TRACKING_MODE.NONE;
}

function shouldEmitProviderTracking(trackingMode) {
  return normalizeAsaasClientTrackingMode(trackingMode) !== ASAAS_CLIENT_TRACKING_MODE.NONE;
}

function shouldEmitJourneyTracking(trackingMode) {
  return normalizeAsaasClientTrackingMode(trackingMode) === ASAAS_CLIENT_TRACKING_MODE.PROVIDER_AND_JOURNEY;
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

function buildAsaasClientTrackingContext({
  quote = {},
  paymentId = "",
  subscriptionId = "",
  source = "asaas_client",
  step = "",
  errorCode = "",
} = {}) {
  const normalized = normalizeQuotePayload(quote);
  return {
    userId: normalized.internalUserId || safeStr(quote?.internalUserId),
    waId: normalized.internalUserId || safeStr(quote?.internalUserId),
    planCode: normalized.planCode,
    billingCycle: normalized.billingCycle,
    couponCode: normalized.couponCode,
    paymentId: safeStr(paymentId),
    subscriptionId: safeStr(subscriptionId),
    source: safeStr(source) || "asaas_client",
    step: safeStr(step),
    errorCode: safeStr(errorCode),
  };
}

async function emitAsaasClientMetricSafe(metricFn, payload = {}) {
  if (typeof metricFn !== "function") return null;
  try {
    return await metricFn(payload);
  } catch {
    return null;
  }
}

function inferRetryableFromHttpStatus(httpStatus) {
  const status = Number(httpStatus || 0);
  if (!status) return false;
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  if (status >= 500) return true;
  return false;
}

function inferAsaasErrorCode({ httpStatus = 0, message = "", payload = null, fallback = ASAAS_CLIENT_ERROR_CODE.HTTP } = {}) {
  const status = Number(httpStatus || 0);
  const text = `${safeStr(message)} ${safeStr(payload?.errors?.[0]?.code)} ${safeStr(payload?.errors?.[0]?.description)}`.toLowerCase();

  if (fallback && fallback !== ASAAS_CLIENT_ERROR_CODE.HTTP) return fallback;
  if (status === 401 || status === 403) return ASAAS_CLIENT_ERROR_CODE.AUTH;
  if (status === 400 || status === 404 || status === 422) return ASAAS_CLIENT_ERROR_CODE.VALIDATION;
  if (text.includes("api key")) return ASAAS_CLIENT_ERROR_CODE.AUTH;
  return ASAAS_CLIENT_ERROR_CODE.HTTP;
}

function buildAsaasClientError({
  errorCode = ASAAS_CLIENT_ERROR_CODE.UNKNOWN,
  message = "Asaas client error",
  retryable = false,
  httpStatus = 0,
  provider = "asaas",
  payload = null,
  cause = null,
  source = "asaas_client",
  step = "",
  context = null,
} = {}) {
  const err = new Error(safeStr(message) || "Asaas client error");
  err.ok = false;
  err.errorCode = safeStr(errorCode) || ASAAS_CLIENT_ERROR_CODE.UNKNOWN;
  err.retryable = Boolean(retryable);
  err.httpStatus = Number(httpStatus || 0) || undefined;
  err.provider = provider;
  err.payload = payload ?? null;
  err.context = context ?? null;
  err.source = safeStr(source) || "asaas_client";
  err.step = safeStr(step);
  if (cause) err.cause = cause;
  return err;
}

async function logAsaasClientFailure({
  error = null,
  quote = {},
  source = "asaas_client",
  step = "",
  paymentId = "",
  subscriptionId = "",
  extra = {},
} = {}) {
  const payload = buildAsaasClientTrackingContext({
    quote,
    paymentId,
    subscriptionId,
    source,
    step,
    errorCode: safeStr(error?.errorCode || error?.code),
  });

  const paymentErrorTracker = metrics?.trackPaymentError;
  if (typeof paymentErrorTracker === "function") {
    await emitAsaasClientMetricSafe(paymentErrorTracker, payload);
  }

  const logger =
    audit?.logOperationalEvent ||
    audit?.logRuntimeError ||
    null;

  const logEntry = {
    module: "ASAAS_CLIENT",
    event: "ERROR",
    level: "error",
    source,
    step,
    userId: payload.userId || "",
    paymentId: payload.paymentId || "",
    subscriptionId: payload.subscriptionId || "",
    planCode: payload.planCode || "",
    billingCycle: payload.billingCycle || "",
    couponCode: payload.couponCode || "",
    errorCode: safeStr(error?.errorCode || error?.code),
    message: safeStr(error?.message),
    meta: {
      retryable: Boolean(error?.retryable),
      httpStatus: Number(error?.httpStatus || error?.status || 0) || undefined,
      ...extra,
    },
  };

  if (typeof logger === "function") {
    try {
      await logger(logEntry);
      return;
    } catch {
      // fallback abaixo
    }
  }

  console.warn(JSON.stringify({
    level: "error",
    tag: "asaas_client_error",
    ...logEntry,
  }));
}

function assertRequiredString(value, label, { errorCode = ASAAS_CLIENT_ERROR_CODE.VALIDATION, source = "asaas_client", step = "" } = {}) {
  const text = safeStr(value);
  if (!text) {
    throw buildAsaasClientError({
      errorCode,
      message: `${label} required`,
      retryable: false,
      httpStatus: 400,
      source,
      step,
    });
  }
  return text;
}

async function assertNoPendingIdentityConflictForQuote(quote = {}, { source = "asaas_client", step = "identityReviewGate" } = {}) {
  const internalUserId = safeStr(quote?.internalUserId);
  if (!internalUserId) return null;

  let conflict = null;
  try {
    conflict = await getPendingIdentityConflictForUser(internalUserId);
  } catch (cause) {
    throw buildAsaasClientError({
      errorCode: ASAAS_CLIENT_ERROR_CODE.IDENTITY_REVIEW_REQUIRED,
      message: "Unable to confirm identity review state before financial materialization.",
      retryable: false,
      httpStatus: 409,
      source,
      step,
      cause,
      context: {
        internalUserId,
        identityReviewLookupFailed: true,
      },
    });
  }

  if (!conflict) return null;

  throw buildAsaasClientError({
    errorCode: ASAAS_CLIENT_ERROR_CODE.IDENTITY_REVIEW_REQUIRED,
    message: "Checkout requires internal validation before financial materialization.",
    retryable: false,
    httpStatus: 409,
    source,
    step,
    context: {
      internalUserId,
      conflictId: safeStr(conflict?.conflictId),
      conflictStatus: safeStr(conflict?.status || "PENDING_REVIEW"),
      blockSensitiveOps: Boolean(conflict?.blockSensitiveOps),
      classification: "identity_review_block",
    },
  });
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

function assertValidQuote(quote = {}, { source = "asaas_client", step = "assertValidQuote" } = {}) {
  const normalized = normalizeQuotePayload(quote);

  if (!normalized.ok || !normalized.valid) {
    throw buildAsaasClientError({
      errorCode: ASAAS_CLIENT_ERROR_CODE.VALIDATION,
      message: normalized.reason || normalized.code || "Invalid pricing quote",
      retryable: false,
      httpStatus: 400,
      source,
      step,
      context: { quote: normalized },
    });
  }

  if (!normalized.planCode) {
    throw buildAsaasClientError({
      errorCode: ASAAS_CLIENT_ERROR_CODE.VALIDATION,
      message: "Quote missing planCode",
      retryable: false,
      httpStatus: 400,
      source,
      step,
      context: { quote: normalized },
    });
  }

  if (normalized.finalPriceCents <= 0) {
    throw buildAsaasClientError({
      errorCode: ASAAS_CLIENT_ERROR_CODE.VALIDATION,
      message: "Quote finalPriceCents must be greater than zero",
      retryable: false,
      httpStatus: 400,
      source,
      step,
      context: { quote: normalized },
    });
  }

  return normalized;
}

async function asaasFetch(path, { method = "GET", body = undefined, step = "asaasFetch", errorCode = ASAAS_CLIENT_ERROR_CODE.HTTP, context = null } = {}) {
  let url = "";
  try {
    url = `${asaasBaseUrl()}${path}`;
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
    } catch (parseErr) {
      if (res.ok) {
        throw buildAsaasClientError({
          errorCode: ASAAS_CLIENT_ERROR_CODE.RESPONSE_PARSE,
          message: "Invalid JSON response from Asaas",
          retryable: false,
          httpStatus: res.status,
          payload: text ? { raw: String(text).slice(0, 1000) } : null,
          cause: parseErr,
          step,
          context,
        });
      }
      json = null;
    }

    if (!res.ok) {
      const msg =
        (json && json.errors && json.errors[0] && (json.errors[0].description || json.errors[0].code)) ||
        (json && json.message) ||
        text ||
        `Asaas HTTP ${res.status}`;

      throw buildAsaasClientError({
        errorCode: inferAsaasErrorCode({
          httpStatus: res.status,
          message: msg,
          payload: json,
          fallback: errorCode,
        }),
        message: msg,
        retryable: inferRetryableFromHttpStatus(res.status),
        httpStatus: res.status,
        payload: json,
        step,
        context,
      });
    }

    return json;
  } catch (err) {
    if (err?.errorCode) throw err;

    const message = safeStr(err?.message) || "Asaas request failed";
    throw buildAsaasClientError({
      errorCode: message.toLowerCase().includes("api_key") || message.toLowerCase().includes("access_token")
        ? ASAAS_CLIENT_ERROR_CODE.AUTH
        : errorCode || ASAAS_CLIENT_ERROR_CODE.UNKNOWN,
      message,
      retryable: false,
      httpStatus: Number(err?.status || 0) || undefined,
      payload: err?.payload || null,
      cause: err,
      step,
      context: context || (url ? { path, url } : null),
    });
  }
}

export function buildAsaasChargeContextFromQuote({
  quote = {},
  paymentMethod = "",
  dueDate = "",
  paymentDate = "",
} = {}) {
  const q = assertValidQuote(quote, { source: "asaas_client", step: "buildAsaasChargeContextFromQuote" });
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

  try {
    const q = new URLSearchParams({ externalReference: ref, limit: "10", offset: "0" }).toString();
    const data = await asaasFetch(`/customers?${q}`, {
      method: "GET",
      step: "findCustomerByExternalReference",
      errorCode: ASAAS_CLIENT_ERROR_CODE.CUSTOMER,
      context: { externalReference: ref },
    });

    const first = data?.data?.[0];
    if (!first?.id) return null;
    return first;
  } catch (err) {
    await logAsaasClientFailure({
      error: err,
      source: "asaas_client",
      step: "findCustomerByExternalReference",
      extra: { externalReference: ref },
    });
    throw err;
  }
}

export async function createCustomer({ name, cpfCnpj, externalReference }) {
  const nm = safeStr(name) || "Cliente Amigo das Vendas";
  const doc = assertRequiredString(cpfCnpj, "cpfCnpj", {
    errorCode: ASAAS_CLIENT_ERROR_CODE.VALIDATION,
    source: "asaas_client",
    step: "createCustomer",
  });
  const ref = safeStr(externalReference);

  // ⚠️ não logar doc
  const payload = {
    name: nm,
    cpfCnpj: doc,
    externalReference: ref || undefined,
  };

  try {
    return await asaasFetch("/customers", {
      method: "POST",
      body: payload,
      step: "createCustomer",
      errorCode: ASAAS_CLIENT_ERROR_CODE.CUSTOMER,
      context: { externalReference: ref, hasDocument: Boolean(doc) },
    });
  } catch (err) {
    await logAsaasClientFailure({
      error: err,
      source: "asaas_client",
      step: "createCustomer",
      extra: { externalReference: ref, hasDocument: Boolean(doc) },
    });
    throw err;
  }
}

// -------------------- Payment (PIX / boleto / etc) --------------------
export async function createPixPayment({ customerId, value, description, externalReference, dueDate }) {
  const finalCustomerId = assertRequiredString(customerId, "customerId", {
    errorCode: ASAAS_CLIENT_ERROR_CODE.VALIDATION,
    source: "asaas_client",
    step: "createPixPayment",
  });
  const finalDueDate = assertRequiredString(dueDate, "dueDate", {
    errorCode: ASAAS_CLIENT_ERROR_CODE.VALIDATION,
    source: "asaas_client",
    step: "createPixPayment",
  });

  const normalizedValue = normalizeMoneyValue(value);
  if (normalizedValue <= 0) {
    throw buildAsaasClientError({
      errorCode: ASAAS_CLIENT_ERROR_CODE.VALIDATION,
      message: "value must be greater than zero",
      retryable: false,
      httpStatus: 400,
      source: "asaas_client",
      step: "createPixPayment",
    });
  }

  const payload = {
    customer: finalCustomerId,
    billingType: "PIX",
    value: normalizedValue,
    dueDate: finalDueDate,
    description: safeStr(description),
    externalReference: externalReference ? safeStr(externalReference) : undefined,
  };

  try {
    return await asaasFetch("/payments", {
      method: "POST",
      body: payload,
      step: "createPixPayment",
      errorCode: ASAAS_CLIENT_ERROR_CODE.PIX_CREATE,
      context: {
        customerId: finalCustomerId,
        dueDate: finalDueDate,
        externalReference: safeStr(externalReference),
      },
    });
  } catch (err) {
    await logAsaasClientFailure({
      error: err,
      source: "asaas_client",
      step: "createPixPayment",
      extra: {
        customerId: finalCustomerId,
        dueDate: finalDueDate,
        externalReference: safeStr(externalReference),
      },
    });
    throw err;
  }
}

export async function createPixPaymentFromQuote({
  customerId,
  quote,
  description = "",
  externalReference,
  dueDate,
  trackingMode = "",
  trackConversion = true,
  trackCheckoutLifecycle = false,
  source = "asaas_client",
}) {
  await assertNoPendingIdentityConflictForQuote(quote, {
    source,
    step: "createPixPaymentFromQuote:identity_review_gate",
  });

  const context = buildAsaasChargeContextFromQuote({
    quote,
    paymentMethod: "pix",
    dueDate,
  });

  const resolvedTrackingMode = resolveAsaasClientTrackingMode({
    trackingMode,
    trackConversion,
    trackCheckoutLifecycle,
  });

  const trackingContext = buildAsaasClientTrackingContext({
    quote,
    source,
    step: "provider_pix_checkout_requested",
  });

  if (shouldEmitJourneyTracking(resolvedTrackingMode)) {
    await emitAsaasClientMetricSafe(metrics.trackCheckoutStarted, trackingContext);
  }

  try {
    const payment = await createPixPayment({
      customerId,
      value: context.finalPriceValue,
      description: safeStr(description) || context.description,
      externalReference,
      dueDate: context.dueDate,
    });

    const paymentTrackingContext = buildAsaasClientTrackingContext({
      quote,
      paymentId: safeStr(payment?.id),
      source,
      step: "pix_checkout_created",
    });

    if (shouldEmitProviderTracking(resolvedTrackingMode)) {
      await emitAsaasClientMetricSafe(metrics.trackPixCheckoutCreated, paymentTrackingContext);
    }
    if (shouldEmitJourneyTracking(resolvedTrackingMode)) {
      await emitAsaasClientMetricSafe(
        metrics.trackCheckoutConfirmed,
        buildAsaasClientTrackingContext({
          quote,
          paymentId: safeStr(payment?.id),
          source,
          step: "provider_pix_checkout_materialized",
        })
      );
    }

    return payment;
  } catch (err) {
    await logAsaasClientFailure({
      error: err,
      quote,
      source,
      step: "createPixPaymentFromQuote",
      extra: {
        externalReference: safeStr(externalReference),
        dueDate: safeStr(context?.dueDate),
      },
    });
    throw err;
  }
}

// -------------------- Payment Link (Recurring credit card) --------------------
export async function createRecurringCardPaymentLink({
  name,
  description,
  value,
  externalReference,
  subscriptionCycle = "MONTHLY",
}) {
  const normalizedValue = normalizeMoneyValue(value);
  if (normalizedValue <= 0) {
    throw buildAsaasClientError({
      errorCode: ASAAS_CLIENT_ERROR_CODE.VALIDATION,
      message: "value must be greater than zero",
      retryable: false,
      httpStatus: 400,
      source: "asaas_client",
      step: "createRecurringCardPaymentLink",
    });
  }

  // Docs: /v3/paymentLinks
  // chargeType: RECURRENT => cria assinatura automática após checkout
  const payload = {
    name: safeStr(name || "Assinatura Amigo das Vendas"),
    description: safeStr(description),
    chargeType: "RECURRENT",
    billingType: "CREDIT_CARD",
    subscriptionCycle: normalizeSubscriptionCycle(subscriptionCycle),
    value: normalizedValue,
    externalReference: externalReference ? safeStr(externalReference) : undefined,
  };

  try {
    return await asaasFetch("/paymentLinks", {
      method: "POST",
      body: payload,
      step: "createRecurringCardPaymentLink",
      errorCode: ASAAS_CLIENT_ERROR_CODE.PAYMENT_LINK,
      context: {
        externalReference: safeStr(externalReference),
        subscriptionCycle: normalizeSubscriptionCycle(subscriptionCycle),
      },
    });
  } catch (err) {
    await logAsaasClientFailure({
      error: err,
      source: "asaas_client",
      step: "createRecurringCardPaymentLink",
      extra: {
        externalReference: safeStr(externalReference),
        subscriptionCycle: normalizeSubscriptionCycle(subscriptionCycle),
      },
    });
    throw err;
  }
}

export async function createRecurringCardPaymentLinkFromQuote({
  quote,
  name = "",
  description = "",
  externalReference,
  trackingMode = "",
  trackConversion = true,
  trackCheckoutLifecycle = false,
  source = "asaas_client",
}) {
  await assertNoPendingIdentityConflictForQuote(quote, {
    source,
    step: "createRecurringCardPaymentLinkFromQuote:identity_review_gate",
  });

  const context = buildAsaasChargeContextFromQuote({
    quote,
    paymentMethod: "credit_card",
  });

  if (!context.ok || !context.valid) {
    const err = buildAsaasClientError({
      errorCode: ASAAS_CLIENT_ERROR_CODE.VALIDATION,
      message: context.reason || "Quote not supported for recurring card payment link",
      retryable: false,
      httpStatus: 400,
      source,
      step: "createRecurringCardPaymentLinkFromQuote",
      context,
    });
    err.code = context.code || "quote_not_supported_for_recurring_link";
    throw err;
  }

  const resolvedTrackingMode = resolveAsaasClientTrackingMode({
    trackingMode,
    trackConversion,
    trackCheckoutLifecycle,
  });

  const trackingContext = buildAsaasClientTrackingContext({
    quote,
    source,
    step: "provider_subscription_checkout_requested",
  });

  if (shouldEmitJourneyTracking(resolvedTrackingMode)) {
    await emitAsaasClientMetricSafe(metrics.trackCheckoutStarted, trackingContext);
  }

  try {
    const paymentLink = await createRecurringCardPaymentLink({
      name: safeStr(name) || safeStr(context.planName) || "Assinatura Amigo das Vendas",
      description: safeStr(description) || context.description,
      value: context.finalPriceValue,
      externalReference,
      subscriptionCycle: context.subscriptionCycle,
    });

    const paymentLinkTrackingContext = buildAsaasClientTrackingContext({
      quote,
      paymentId: safeStr(paymentLink?.id),
      source,
      step: "payment_link_created",
    });

    if (shouldEmitProviderTracking(resolvedTrackingMode)) {
      await emitAsaasClientMetricSafe(metrics.trackPaymentLinkCreated, paymentLinkTrackingContext);
      await emitAsaasClientMetricSafe(
        metrics.trackSubscriptionCheckoutCreated,
        buildAsaasClientTrackingContext({
          quote,
          paymentId: safeStr(paymentLink?.id),
          source,
          step: "subscription_checkout_created",
        })
      );
    }
    if (shouldEmitJourneyTracking(resolvedTrackingMode)) {
      await emitAsaasClientMetricSafe(
        metrics.trackCheckoutConfirmed,
        buildAsaasClientTrackingContext({
          quote,
          paymentId: safeStr(paymentLink?.id),
          source,
          step: "provider_subscription_checkout_materialized",
        })
      );
    }

    return paymentLink;
  } catch (err) {
    await logAsaasClientFailure({
      error: err,
      quote,
      source,
      step: "createRecurringCardPaymentLinkFromQuote",
      extra: { externalReference: safeStr(externalReference) },
    });
    throw err;
  }
}

export async function createAsaasCheckoutFromQuote({
  customerId = "",
  quote = {},
  paymentMethod = "",
  externalReference = "",
  dueDate = "",
  description = "",
  name = "",
  trackingMode = "",
  trackConversion = true,
  trackCheckoutLifecycle = false,
  source = "asaas_client",
} = {}) {
  const method = safeLower(paymentMethod);

  try {
    await assertNoPendingIdentityConflictForQuote(quote, {
      source,
      step: "createAsaasCheckoutFromQuote:identity_review_gate",
    });
    if (method === "pix") {
      return await createPixPaymentFromQuote({
        customerId,
        quote,
        description,
        externalReference,
        dueDate,
        trackingMode,
        trackConversion,
        trackCheckoutLifecycle,
        source,
      });
    }

    if (method === "credit_card" || method === "card") {
      return await createRecurringCardPaymentLinkFromQuote({
        quote,
        name,
        description,
        externalReference,
        trackingMode,
        trackConversion,
        trackCheckoutLifecycle,
        source,
      });
    }

    throw buildAsaasClientError({
      errorCode: ASAAS_CLIENT_ERROR_CODE.VALIDATION,
      message: "Unsupported paymentMethod. Use pix or credit_card.",
      retryable: false,
      httpStatus: 400,
      source,
      step: "createAsaasCheckoutFromQuote",
      context: { paymentMethod: method },
    });
  } catch (err) {
    await logAsaasClientFailure({
      error: err,
      quote,
      source,
      step: "createAsaasCheckoutFromQuote",
      extra: { paymentMethod: method },
    });
    throw err;
  }
}

// -------------------- Subscriptions --------------------
// Observação: Asaas pode oferecer endpoints diferentes para cancelar.
// Estratégia segura:
// 1) Tentar POST /subscriptions/{id}/cancel
// 2) Se falhar (404/405), tentar DELETE /subscriptions/{id}

export async function getSubscription({ subscriptionId }) {
  const id = assertRequiredString(subscriptionId, "subscriptionId", {
    errorCode: ASAAS_CLIENT_ERROR_CODE.VALIDATION,
    source: "asaas_client",
    step: "getSubscription",
  });

  try {
    return await asaasFetch(`/subscriptions/${id}`, {
      method: "GET",
      step: "getSubscription",
      errorCode: ASAAS_CLIENT_ERROR_CODE.SUBSCRIPTION,
      context: { subscriptionId: id },
    });
  } catch (err) {
    await logAsaasClientFailure({
      error: err,
      source: "asaas_client",
      step: "getSubscription",
      subscriptionId: id,
    });
    throw err;
  }
}

export async function cancelSubscription({ subscriptionId }) {
  const id = assertRequiredString(subscriptionId, "subscriptionId", {
    errorCode: ASAAS_CLIENT_ERROR_CODE.VALIDATION,
    source: "asaas_client",
    step: "cancelSubscription",
  });

  // 1) POST cancel (quando disponível)
  try {
    return await asaasFetch(`/subscriptions/${id}/cancel`, {
      method: "POST",
      step: "cancelSubscription:post_cancel",
      errorCode: ASAAS_CLIENT_ERROR_CODE.SUBSCRIPTION,
      context: { subscriptionId: id },
    });
  } catch (err) {
    const st = Number(err?.httpStatus || err?.status || 0);
    if (st && st !== 404 && st !== 405 && st !== 400) {
      await logAsaasClientFailure({
        error: err,
        source: "asaas_client",
        step: "cancelSubscription:post_cancel",
        subscriptionId: id,
      });
      throw err;
    }
  }

  // 2) DELETE subscription
  try {
    return await asaasFetch(`/subscriptions/${id}`, {
      method: "DELETE",
      step: "cancelSubscription:delete",
      errorCode: ASAAS_CLIENT_ERROR_CODE.SUBSCRIPTION,
      context: { subscriptionId: id },
    });
  } catch (err) {
    await logAsaasClientFailure({
      error: err,
      source: "asaas_client",
      step: "cancelSubscription:delete",
      subscriptionId: id,
    });
    throw err;
  }
}

// -------------------- Payments (Consulta / Reconciliação) --------------------
export async function getPayment({ paymentId }) {
  const id = assertRequiredString(paymentId, "paymentId", {
    errorCode: ASAAS_CLIENT_ERROR_CODE.VALIDATION,
    source: "asaas_client",
    step: "getPayment",
  });

  try {
    return await asaasFetch(`/payments/${id}`, {
      method: "GET",
      step: "getPayment",
      errorCode: ASAAS_CLIENT_ERROR_CODE.HTTP,
      context: { paymentId: id },
    });
  } catch (err) {
    await logAsaasClientFailure({
      error: err,
      source: "asaas_client",
      step: "getPayment",
      paymentId: id,
    });
    throw err;
  }
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

  if (dateCreatedFrom && !dateCreatedTo) params.set("dateCreated", safeStr(dateCreatedFrom));
  if (dateCreatedFrom && dateCreatedTo) {
    params.set("dateCreated[ge]", safeStr(dateCreatedFrom));
    params.set("dateCreated[le]", safeStr(dateCreatedTo));
  }

  params.set("limit", String(Number(limit) || 50));
  params.set("offset", String(Number(offset) || 0));

  try {
    return await asaasFetch(`/payments?${params.toString()}`, {
      method: "GET",
      step: "listPayments",
      errorCode: ASAAS_CLIENT_ERROR_CODE.HTTP,
      context: {
        externalReference: safeStr(externalReference),
        customerId: safeStr(customerId),
        subscriptionId: safeStr(subscriptionId),
      },
    });
  } catch (err) {
    await logAsaasClientFailure({
      error: err,
      source: "asaas_client",
      step: "listPayments",
      extra: {
        externalReference: safeStr(externalReference),
        customerId: safeStr(customerId),
        subscriptionId: safeStr(subscriptionId),
      },
    });
    throw err;
  }
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

  try {
    return await asaasFetch(`/subscriptions?${params.toString()}`, {
      method: "GET",
      step: "listSubscriptions",
      errorCode: ASAAS_CLIENT_ERROR_CODE.SUBSCRIPTION,
      context: {
        externalReference: safeStr(externalReference),
        customerId: safeStr(customerId),
        status: safeStr(status),
      },
    });
  } catch (err) {
    await logAsaasClientFailure({
      error: err,
      source: "asaas_client",
      step: "listSubscriptions",
      extra: {
        externalReference: safeStr(externalReference),
        customerId: safeStr(customerId),
        status: safeStr(status),
      },
    });
    throw err;
  }
}

export async function listSubscriptionsByExternalReference(externalReference, { limit = 50, offset = 0 } = {}) {
  return listSubscriptions({ externalReference, limit, offset });
}

export const ASAAS_CLIENT_TRACKING_MODE_VALUES = ASAAS_CLIENT_TRACKING_MODE;
