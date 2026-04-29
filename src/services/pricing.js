// src/services/pricing.js
// Motor central de precificação do checkout.
// Responsabilidades:
// - montar quote oficial por plano + ciclo + cupom opcional
// - centralizar preço original, desconto, preço final e explicação do cálculo
// - impedir recálculo espalhado em flow / asaas / admin

import { getPlan, getPlanBillingOption, formatBRLFromCents } from "./plans.js";
import { getCoupon, validateCouponEligibility } from "./coupons.js";
import { trackPricingQuoteGenerated, trackPricingError, trackPaymentError } from "./metrics.js";
import * as audit from "./audit.js";

const BILLING_CYCLES = Object.freeze(["monthly", "annual"]);
const APPLIES_TO = Object.freeze({
  FIRST_CHARGE_ONLY: "first_charge_only",
  ENTIRE_SUBSCRIPTION: "entire_subscription",
});

const PRICING_ERROR_CODE = Object.freeze({
  INPUT: "PRICING_INPUT_ERROR",
  PLAN: "PRICING_PLAN_ERROR",
  BILLING_CYCLE: "PRICING_BILLING_CYCLE_ERROR",
  COUPON: "PRICING_COUPON_ERROR",
  RUNTIME: "PRICING_RUNTIME_ERROR",
});

function safeStr(value) {
  return String(value ?? "").trim();
}

function toUpper(value) {
  return safeStr(value).toUpperCase();
}

function toLower(value) {
  return safeStr(value).toLowerCase();
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizePlanCode(value) {
  return toUpper(value);
}

function normalizeBillingCycle(value, { fallback = "monthly" } = {}) {
  const normalized = toLower(value);
  if (!normalized) return fallback;
  if (!BILLING_CYCLES.includes(normalized)) {
    throw new Error(`Invalid billingCycle. Use ${BILLING_CYCLES.join(" or ")}.`);
  }
  return normalized;
}

function normalizeCouponCode(value) {
  return toUpper(value);
}

function normalizeAppliesTo(value) {
  const text = toLower(value);
  return text === APPLIES_TO.ENTIRE_SUBSCRIPTION
    ? APPLIES_TO.ENTIRE_SUBSCRIPTION
    : APPLIES_TO.FIRST_CHARGE_ONLY;
}

function normalizeCurrencyCents(value) {
  const cents = toInt(value, 0);
  return Math.max(0, cents);
}

function cloneCalculation(calc = {}) {
  return {
    basePriceCents: normalizeCurrencyCents(calc.basePriceCents),
    discountAmountCents: normalizeCurrencyCents(calc.discountAmountCents),
    finalPriceCents: normalizeCurrencyCents(calc.finalPriceCents),
    appliesTo: normalizeAppliesTo(calc.appliesTo),
    discountType: safeStr(calc.discountType),
    discountPercent: Number(calc.discountPercent) || 0,
    discountAmountCentsConfigured: normalizeCurrencyCents(calc.discountAmountCentsConfigured),
    discountCapCents: calc.discountCapCents == null ? null : normalizeCurrencyCents(calc.discountCapCents),
  };
}

const PRICING_TRACKING_MODE = Object.freeze({
  NONE: "none",
  PREVIEW: "preview",
  CHECKOUT: "checkout",
  INTERNAL: "internal",
});

export const PRICING_TRACKING_MODE_VALUES = PRICING_TRACKING_MODE;

function normalizePricingTrackingMode(value) {
  const mode = safeStr(value).toLowerCase();
  if (mode === PRICING_TRACKING_MODE.PREVIEW) return PRICING_TRACKING_MODE.PREVIEW;
  if (mode === PRICING_TRACKING_MODE.CHECKOUT) return PRICING_TRACKING_MODE.CHECKOUT;
  if (mode === PRICING_TRACKING_MODE.INTERNAL) return PRICING_TRACKING_MODE.INTERNAL;
  return PRICING_TRACKING_MODE.NONE;
}

function resolvePricingTrackingMode({ trackingMode = "", trackMetrics = false, source = "pricing" } = {}) {
  const explicit = normalizePricingTrackingMode(trackingMode);
  if (explicit !== PRICING_TRACKING_MODE.NONE) return explicit;

  const normalizedSource = safeStr(source).toLowerCase();
  if (normalizedSource === "pricing_preview") return PRICING_TRACKING_MODE.PREVIEW;
  if (normalizedSource === "pricing_matrix") return PRICING_TRACKING_MODE.INTERNAL;
  if (["pricing_checkout", "checkout", "flow", "flow_checkout", "asaas_client", "asaas_checkout"].includes(normalizedSource)) {
    return PRICING_TRACKING_MODE.CHECKOUT;
  }
  if (trackMetrics) return PRICING_TRACKING_MODE.CHECKOUT;
  return PRICING_TRACKING_MODE.NONE;
}

function shouldEmitOfficialPricingTracking(mode) {
  return normalizePricingTrackingMode(mode) === PRICING_TRACKING_MODE.CHECKOUT;
}

function buildPricingTrackingContext({
  internalUserId = "",
  planCode = "",
  billingCycle = "monthly",
  couponCode = "",
  source = "pricing",
  step = "",
  errorCode = "",
} = {}) {
  return {
    userId: safeStr(internalUserId),
    waId: safeStr(internalUserId),
    planCode: normalizePlanCode(planCode),
    billingCycle: normalizeBillingCycle(billingCycle, { fallback: "monthly" }),
    couponCode: normalizeCouponCode(couponCode),
    source: safeStr(source) || "pricing",
    step: safeStr(step),
    errorCode: safeStr(errorCode),
  };
}

async function emitPricingMetricSafe(metricFn, payload = {}) {
  if (typeof metricFn !== "function") return { ok: false, skipped: true, error: "metric_fn_missing" };
  try {
    return await metricFn(payload);
  } catch {
    return { ok: false, skipped: true, error: "metric_emit_failed" };
  }
}

async function maybeTrackPricingError({
  trackingMode = PRICING_TRACKING_MODE.NONE,
  internalUserId = "",
  planCode = "",
  billingCycle = "monthly",
  couponCode = "",
  step = "",
  source = "pricing",
  errorCode = "",
} = {}) {
  if (!shouldEmitOfficialPricingTracking(trackingMode)) return { ok: true, skipped: true };
  return emitPricingMetricSafe(trackPricingError, buildPricingTrackingContext({
    internalUserId,
    planCode,
    billingCycle,
    couponCode,
    source,
    step,
    errorCode,
  }));
}

async function maybeTrackPaymentError({
  trackingMode = PRICING_TRACKING_MODE.NONE,
  internalUserId = "",
  planCode = "",
  billingCycle = "monthly",
  couponCode = "",
  step = "",
  source = "pricing",
  errorCode = "",
} = {}) {
  if (!shouldEmitOfficialPricingTracking(trackingMode)) return { ok: true, skipped: true };
  return emitPricingMetricSafe(trackPaymentError, buildPricingTrackingContext({
    internalUserId,
    planCode,
    billingCycle,
    couponCode,
    source,
    step,
    errorCode,
  }));
}

async function maybeTrackPricingQuoteGenerated({
  trackingMode = PRICING_TRACKING_MODE.NONE,
  internalUserId = "",
  planCode = "",
  billingCycle = "monthly",
  couponCode = "",
  step = "",
  source = "pricing",
} = {}) {
  if (!shouldEmitOfficialPricingTracking(trackingMode)) return { ok: true, skipped: true };
  return emitPricingMetricSafe(trackPricingQuoteGenerated, buildPricingTrackingContext({
    internalUserId,
    planCode,
    billingCycle,
    couponCode,
    source,
    step,
  }));
}

async function logPricingOperationalEvent({
  level = "warn",
  event = "pricing_runtime_event",
  internalUserId = "",
  planCode = "",
  billingCycle = "",
  couponCode = "",
  source = "pricing",
  step = "",
  errorCode = "",
  message = "",
  meta = {},
} = {}) {
  const payload = {
    module: "pricing",
    source: safeStr(source) || "pricing",
    event: safeStr(event) || "pricing_runtime_event",
    level: safeStr(level) || "warn",
    userId: safeStr(internalUserId),
    step: safeStr(step),
    errorCode: safeStr(errorCode),
    message: safeStr(message),
    meta: {
      planCode: normalizePlanCode(planCode),
      billingCycle: safeStr(billingCycle),
      couponCode: normalizeCouponCode(couponCode),
      ...(meta && typeof meta === "object" ? meta : {}),
    },
  };

  try {
    if (typeof audit?.logOperationalEvent === "function") {
      await audit.logOperationalEvent(payload);
      return;
    }
    if (typeof audit?.logRuntimeError === "function") {
      await audit.logRuntimeError(payload);
      return;
    }
  } catch {
    // fallback para console abaixo
  }

  try {
    console[payload.level === "error" ? "error" : "warn"](
      JSON.stringify({
        level: payload.level,
        tag: payload.event,
        source: payload.source,
        userId: payload.userId || null,
        step: payload.step || null,
        errorCode: payload.errorCode || null,
        message: payload.message || null,
        meta: payload.meta,
      })
    );
  } catch {
    // best effort
  }
}

function buildFailure(code, message, extra = {}) {
  return {
    ok: false,
    valid: false,
    code: safeStr(code) || "pricing_error",
    reason: safeStr(message) || "Pricing error",
    ...extra,
  };
}

function buildSuccess(payload = {}) {
  return {
    ok: true,
    valid: true,
    ...payload,
  };
}

function buildChargeMode({ billingCycle = "monthly", appliesTo = APPLIES_TO.FIRST_CHARGE_ONLY } = {}) {
  const cycle = normalizeBillingCycle(billingCycle);
  const mode = normalizeAppliesTo(appliesTo);

  if (mode === APPLIES_TO.ENTIRE_SUBSCRIPTION) {
    return cycle === "annual" ? "recurring_annual" : "recurring_monthly";
  }

  return cycle === "annual" ? "annual_checkout" : "monthly_checkout";
}

function buildPricingExplanation({
  plan,
  billingOption,
  coupon = null,
  couponCode = "",
  billingCycle = "monthly",
  calculation = {},
} = {}) {
  const basePriceCents = normalizeCurrencyCents(calculation.basePriceCents);
  const discountAmountCents = normalizeCurrencyCents(calculation.discountAmountCents);
  const finalPriceCents = normalizeCurrencyCents(calculation.finalPriceCents);
  const appliesTo = normalizeAppliesTo(calculation.appliesTo);
  const cycle = normalizeBillingCycle(billingCycle);

  const originalLabel = formatBRLFromCents(basePriceCents);
  const discountLabel = formatBRLFromCents(discountAmountCents);
  const finalLabel = formatBRLFromCents(finalPriceCents);
  const cycleLabel = cycle === "annual" ? "anual" : "mensal";

  const quoteLabel = `${originalLabel}/${cycle === "annual" ? "ano" : "mês"}`;
  const finalCycleLabel = `${finalLabel}/${cycle === "annual" ? "ano" : "mês"}`;
  const appliesToLabel =
    appliesTo === APPLIES_TO.ENTIRE_SUBSCRIPTION
      ? "em toda a assinatura"
      : "apenas na primeira cobrança";

  return {
    planName: safeStr(plan?.name),
    planCode: normalizePlanCode(plan?.code),
    billingCycle: cycle,
    billingCycleLabel: cycleLabel,
    quoteLabel,
    originalLabel,
    discountLabel,
    finalLabel,
    finalCycleLabel,
    appliesTo,
    appliesToLabel,
    couponCode: normalizeCouponCode(couponCode || coupon?.couponCode),
    couponName: safeStr(coupon?.name),
    description: [
      safeStr(plan?.name) ? `Plano ${safeStr(plan?.name)}` : "",
      `cobrança ${cycleLabel}`,
      `valor original ${originalLabel}`,
      discountAmountCents > 0 ? `desconto ${discountLabel}` : "",
      `valor final ${finalLabel}`,
      normalizeCouponCode(couponCode || coupon?.couponCode) ? `cupom ${normalizeCouponCode(couponCode || coupon?.couponCode)}` : "",
      appliesToLabel,
    ]
      .filter(Boolean)
      .join(" | "),
  };
}

function buildStructuredPricingError({
  errorCode = PRICING_ERROR_CODE.RUNTIME,
  code = "pricing_error",
  reason = "Pricing error",
  internalUserId = "",
  planCode = "",
  billingCycle = "monthly",
  couponCode = "",
  source = "pricing",
  step = "",
  cause = null,
  extra = {},
} = {}) {
  const err = new Error(safeStr(reason) || "Pricing error");
  err.ok = false;
  err.errorCode = safeStr(errorCode) || PRICING_ERROR_CODE.RUNTIME;
  err.code = safeStr(code) || "pricing_error";
  err.reason = safeStr(reason) || "Pricing error";
  err.retryable = false;
  err.source = safeStr(source) || "pricing";
  err.step = safeStr(step);
  err.internalUserId = safeStr(internalUserId);
  err.planCode = normalizePlanCode(planCode);
  err.billingCycle = safeStr(billingCycle);
  err.couponCode = normalizeCouponCode(couponCode);
  err.cause = cause || null;
  err.extra = extra && typeof extra === "object" ? extra : {};
  return err;
}

async function runPricingStage(stageName, fn, context = {}) {
  try {
    return await fn();
  } catch (error) {
    const structured = buildStructuredPricingError({
      errorCode: safeStr(context.errorCode) || PRICING_ERROR_CODE.RUNTIME,
      code: safeStr(context.code) || "pricing_runtime_error",
      reason: safeStr(error?.reason || error?.message) || "Pricing runtime error",
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      couponCode: context.couponCode,
      source: context.source,
      step: safeStr(context.step || stageName),
      cause: error,
      extra: {
        stageName: safeStr(stageName),
        ...(context.extra && typeof context.extra === "object" ? context.extra : {}),
      },
    });

    await logPricingOperationalEvent({
      level: "warn",
      event: "pricing_stage_failed",
      internalUserId: context.internalUserId,
      planCode: context.planCode,
      billingCycle: context.billingCycle,
      couponCode: context.couponCode,
      source: context.source,
      step: safeStr(context.step || stageName),
      errorCode: structured.errorCode,
      message: structured.reason,
      meta: { stageName: safeStr(stageName), code: structured.code },
    });

    throw structured;
  }
}

function failureFromStructuredError(error, extra = {}) {
  return buildFailure(
    safeStr(error?.code) || "pricing_runtime_error",
    safeStr(error?.reason || error?.message) || "Pricing runtime error",
    {
      errorCode: safeStr(error?.errorCode) || PRICING_ERROR_CODE.RUNTIME,
      retryable: Boolean(error?.retryable),
      ...extra,
    }
  );
}

export async function getBasePlanPricing({ planCode = "", billingCycle = "monthly", trackMetrics = false, trackingMode = "", source = "pricing" } = {}) {
  const normalizedPlanCode = normalizePlanCode(planCode);
  const normalizedBillingCycle = normalizeBillingCycle(billingCycle, { fallback: "monthly" });

  if (!normalizedPlanCode) {
    return buildFailure("plan_code_required", "planCode required", {
      errorCode: PRICING_ERROR_CODE.INPUT,
    });
  }

  void trackMetrics;
  void trackingMode;
  void source;

  const plan = await runPricingStage("load_plan", async () => {
    return getPlan(normalizedPlanCode);
  }, {
    errorCode: PRICING_ERROR_CODE.PLAN,
    code: "plan_not_found",
    internalUserId: "",
    planCode: normalizedPlanCode,
    billingCycle: normalizedBillingCycle,
    source,
    step: "load_plan",
  });

  if (!plan || !safeStr(plan.code)) {
    return buildFailure("plan_not_found", "Plan not found", {
      errorCode: PRICING_ERROR_CODE.PLAN,
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
    });
  }

  const billingOption = await runPricingStage("load_billing_option", async () => {
    return getPlanBillingOption(plan, normalizedBillingCycle);
  }, {
    errorCode: PRICING_ERROR_CODE.BILLING_CYCLE,
    code: "billing_cycle_not_available",
    internalUserId: "",
    planCode: normalizedPlanCode,
    billingCycle: normalizedBillingCycle,
    source,
    step: "load_billing_option",
  });

  if (!billingOption || billingOption.enabled === false) {
    return buildFailure("billing_cycle_not_available", "Billing cycle not available", {
      errorCode: PRICING_ERROR_CODE.BILLING_CYCLE,
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      plan,
    });
  }

  const basePriceCents = normalizeCurrencyCents(billingOption.priceCents);
  const calculation = cloneCalculation({
    basePriceCents,
    discountAmountCents: 0,
    finalPriceCents: basePriceCents,
    appliesTo: APPLIES_TO.FIRST_CHARGE_ONLY,
    discountType: "",
    discountPercent: 0,
    discountAmountCentsConfigured: 0,
    discountCapCents: null,
  });

  return buildSuccess({
    quoteType: "base",
    internalUserId: "",
    planCode: normalizedPlanCode,
    billingCycle: normalizedBillingCycle,
    plan,
    billingOption,
    couponCode: "",
    coupon: null,
    eligibility: null,
    calculation,
    chargeMode: buildChargeMode({
      billingCycle: normalizedBillingCycle,
      appliesTo: calculation.appliesTo,
    }),
    explanation: buildPricingExplanation({
      plan,
      billingOption,
      coupon: null,
      couponCode: "",
      billingCycle: normalizedBillingCycle,
      calculation,
    }),
  });
}

export async function buildPricingQuote({
  internalUserId = "",
  planCode = "",
  billingCycle = "monthly",
  couponCode = "",
  trackMetrics = false,
  trackingMode = "",
  source = "pricing",
} = {}) {
  const normalizedInternalUserId = safeStr(internalUserId);
  const normalizedPlanCode = normalizePlanCode(planCode);
  const normalizedBillingCycle = normalizeBillingCycle(billingCycle, { fallback: "monthly" });
  const normalizedCouponCode = normalizeCouponCode(couponCode);
  const resolvedTrackingMode = resolvePricingTrackingMode({ trackingMode, trackMetrics, source });

  const emitFailureObservability = async ({ step, errorCode }) => {
    await maybeTrackPricingError({
      trackingMode: resolvedTrackingMode,
      internalUserId: normalizedInternalUserId,
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      couponCode: normalizedCouponCode,
      source,
      step,
      errorCode,
    });
    await maybeTrackPaymentError({
      trackingMode: resolvedTrackingMode,
      internalUserId: normalizedInternalUserId,
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      couponCode: normalizedCouponCode,
      source,
      step,
      errorCode,
    });
    await logPricingOperationalEvent({
      level: "warn",
      event: "pricing_quote_failed",
      internalUserId: normalizedInternalUserId,
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      couponCode: normalizedCouponCode,
      source,
      step,
      errorCode,
      message: step,
    });
  };

  let baseQuote;
  try {
    baseQuote = await getBasePlanPricing({
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      trackMetrics: false,
      trackingMode: PRICING_TRACKING_MODE.NONE,
      source,
    });
  } catch (error) {
    const failure = failureFromStructuredError(error, {
      quoteType: "checkout",
      internalUserId: normalizedInternalUserId,
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      couponCode: normalizedCouponCode,
    });
    await emitFailureObservability({
      step: "build_base_quote_failed",
      errorCode: safeStr(error?.errorCode) || PRICING_ERROR_CODE.RUNTIME,
    });
    return failure;
  }

  if (!baseQuote.ok) {
    const errorCode =
      safeStr(baseQuote?.errorCode) ||
      (safeStr(baseQuote?.code) === "plan_not_found" ? PRICING_ERROR_CODE.PLAN
        : safeStr(baseQuote?.code) === "billing_cycle_not_available" ? PRICING_ERROR_CODE.BILLING_CYCLE
        : PRICING_ERROR_CODE.INPUT);

    await emitFailureObservability({
      step: ["billing_cycle_not_available", "plan_not_found"].includes(safeStr(baseQuote?.code))
        ? "invalid_plan_or_cycle"
        : safeStr(baseQuote?.code) || "build_base_quote_failed",
      errorCode,
    });

    return {
      ...baseQuote,
      internalUserId: normalizedInternalUserId,
      couponCode: normalizedCouponCode,
      errorCode,
    };
  }

  const {
    plan,
    billingOption,
    calculation: baseCalculation,
  } = baseQuote;

  if (!normalizedCouponCode) {
    const result = buildSuccess({
      quoteType: "checkout",
      internalUserId: normalizedInternalUserId,
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      plan,
      billingOption,
      couponCode: "",
      coupon: null,
      eligibility: {
        ok: true,
        eligible: false,
        code: "no_coupon",
        reason: "",
      },
      calculation: baseCalculation,
      chargeMode: buildChargeMode({
        billingCycle: normalizedBillingCycle,
        appliesTo: baseCalculation.appliesTo,
      }),
      explanation: buildPricingExplanation({
        plan,
        billingOption,
        coupon: null,
        couponCode: "",
        billingCycle: normalizedBillingCycle,
        calculation: baseCalculation,
      }),
    });

    await maybeTrackPricingQuoteGenerated({
      trackingMode: resolvedTrackingMode,
      internalUserId: normalizedInternalUserId,
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      couponCode: "",
      source,
      step: "checkout_quote_generated_without_coupon",
    });

    return result;
  }

  let coupon = null;
  try {
    coupon = await runPricingStage("get_coupon", async () => {
      return getCoupon(normalizedCouponCode);
    }, {
      errorCode: PRICING_ERROR_CODE.COUPON,
      code: "coupon_lookup_failed",
      internalUserId: normalizedInternalUserId,
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      couponCode: normalizedCouponCode,
      source,
      step: "get_coupon",
    });
  } catch (error) {
    const failure = failureFromStructuredError(error, {
      quoteType: "checkout",
      internalUserId: normalizedInternalUserId,
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      couponCode: normalizedCouponCode,
      plan,
      billingOption,
      coupon: null,
      calculation: baseCalculation,
      chargeMode: buildChargeMode({
        billingCycle: normalizedBillingCycle,
        appliesTo: baseCalculation.appliesTo,
      }),
      explanation: buildPricingExplanation({
        plan,
        billingOption,
        coupon: null,
        couponCode: normalizedCouponCode,
        billingCycle: normalizedBillingCycle,
        calculation: baseCalculation,
      }),
    });
    await emitFailureObservability({ step: "invalid_coupon", errorCode: safeStr(error?.errorCode) || PRICING_ERROR_CODE.COUPON });
    return failure;
  }

  let eligibility;
  try {
    eligibility = await runPricingStage("validate_coupon_eligibility", async () => {
      return validateCouponEligibility({
        internalUserId: normalizedInternalUserId,
        couponCode: normalizedCouponCode,
        planCode: normalizedPlanCode,
        billingCycle: normalizedBillingCycle,
        basePriceCents: baseCalculation.basePriceCents,
        trackingMode: "none",
        trackConversion: false,
        source,
      });
    }, {
      errorCode: PRICING_ERROR_CODE.COUPON,
      code: "coupon_validation_failed",
      internalUserId: normalizedInternalUserId,
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      couponCode: normalizedCouponCode,
      source,
      step: "validate_coupon_eligibility",
    });
  } catch (error) {
    const failure = failureFromStructuredError(error, {
      quoteType: "checkout",
      internalUserId: normalizedInternalUserId,
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      couponCode: normalizedCouponCode,
      plan,
      billingOption,
      coupon,
      calculation: baseCalculation,
      chargeMode: buildChargeMode({
        billingCycle: normalizedBillingCycle,
        appliesTo: baseCalculation.appliesTo,
      }),
      explanation: buildPricingExplanation({
        plan,
        billingOption,
        coupon,
        couponCode: normalizedCouponCode,
        billingCycle: normalizedBillingCycle,
        calculation: baseCalculation,
      }),
    });
    await emitFailureObservability({ step: "invalid_coupon", errorCode: safeStr(error?.errorCode) || PRICING_ERROR_CODE.COUPON });
    return failure;
  }

  if (!eligibility?.ok || !eligibility?.eligible) {
    const step = ["plan_or_cycle_invalid", "coupon_plan_not_allowed", "coupon_cycle_not_allowed"].includes(safeStr(eligibility?.code))
      ? "invalid_plan_or_cycle"
      : "invalid_coupon";
    const errorCode = step === "invalid_plan_or_cycle" ? PRICING_ERROR_CODE.BILLING_CYCLE : PRICING_ERROR_CODE.COUPON;

    const failure = buildFailure(
      safeStr(eligibility?.code) || "coupon_invalid",
      safeStr(eligibility?.reason) || "Coupon invalid",
      {
        quoteType: "checkout",
        internalUserId: normalizedInternalUserId,
        planCode: normalizedPlanCode,
        billingCycle: normalizedBillingCycle,
        plan,
        billingOption,
        couponCode: normalizedCouponCode,
        coupon,
        eligibility,
        calculation: baseCalculation,
        chargeMode: buildChargeMode({
          billingCycle: normalizedBillingCycle,
          appliesTo: baseCalculation.appliesTo,
        }),
        explanation: buildPricingExplanation({
          plan,
          billingOption,
          coupon,
          couponCode: normalizedCouponCode,
          billingCycle: normalizedBillingCycle,
          calculation: baseCalculation,
        }),
        errorCode,
      }
    );

    await emitFailureObservability({ step, errorCode });
    return failure;
  }

  const calculation = cloneCalculation(eligibility?.calculation || baseCalculation);

  const result = buildSuccess({
    quoteType: "checkout",
    internalUserId: normalizedInternalUserId,
    planCode: normalizedPlanCode,
    billingCycle: normalizedBillingCycle,
    plan,
    billingOption,
    couponCode: normalizedCouponCode,
    coupon,
    eligibility,
    calculation,
    chargeMode: buildChargeMode({
      billingCycle: normalizedBillingCycle,
      appliesTo: calculation.appliesTo,
    }),
    explanation: buildPricingExplanation({
      plan,
      billingOption,
      coupon,
      couponCode: normalizedCouponCode,
      billingCycle: normalizedBillingCycle,
      calculation,
    }),
  });

  await maybeTrackPricingQuoteGenerated({
    trackingMode: resolvedTrackingMode,
    internalUserId: normalizedInternalUserId,
    planCode: normalizedPlanCode,
    billingCycle: normalizedBillingCycle,
    couponCode: normalizedCouponCode,
    source,
    step: "checkout_quote_generated_with_coupon",
  });

  return result;
}

export async function previewPricingForCoupon({
  couponCode = "",
  planCode = "",
  billingCycle = "monthly",
  internalUserId = "",
} = {}) {
  return buildPricingQuote({
    internalUserId,
    planCode,
    billingCycle,
    couponCode,
    trackMetrics: false,
    trackingMode: PRICING_TRACKING_MODE.PREVIEW,
    source: "pricing_preview",
  });
}

export async function buildPricingMatrix({
  internalUserId = "",
  couponCode = "",
  planCodes = [],
  billingCycles = BILLING_CYCLES,
} = {}) {
  const cycles = Array.isArray(billingCycles) && billingCycles.length
    ? billingCycles.map((cycle) => normalizeBillingCycle(cycle))
    : [...BILLING_CYCLES];

  const normalizedPlanCodes = Array.isArray(planCodes)
    ? planCodes.map((code) => normalizePlanCode(code)).filter(Boolean)
    : [];

  const rows = [];

  for (const planCode of normalizedPlanCodes) {
    for (const billingCycle of cycles) {
      const quote = await buildPricingQuote({
        internalUserId,
        couponCode,
        planCode,
        billingCycle,
        trackMetrics: false,
        trackingMode: PRICING_TRACKING_MODE.INTERNAL,
        source: "pricing_matrix",
      });

      rows.push({
        planCode,
        billingCycle,
        ok: Boolean(quote?.ok),
        valid: Boolean(quote?.valid),
        code: safeStr(quote?.code),
        reason: safeStr(quote?.reason),
        calculation: quote?.calculation || null,
        chargeMode: safeStr(quote?.chargeMode),
        explanation: quote?.explanation || null,
      });
    }
  }

  return {
    ok: true,
    internalUserId: safeStr(internalUserId),
    couponCode: normalizeCouponCode(couponCode),
    rows,
  };
}

export function summarizePricingQuote(quote = {}) {
  if (!quote || typeof quote !== "object") {
    return {
      ok: false,
      code: "quote_invalid",
      summary: "",
    };
  }

  const calculation = cloneCalculation(quote.calculation || {});
  const explanation = quote.explanation || buildPricingExplanation({
    plan: quote.plan,
    billingOption: quote.billingOption,
    coupon: quote.coupon,
    couponCode: quote.couponCode,
    billingCycle: quote.billingCycle,
    calculation,
  });

  return {
    ok: Boolean(quote.ok),
    valid: Boolean(quote.valid),
    code: safeStr(quote.code),
    summary: safeStr(explanation.description),
    planName: safeStr(explanation.planName),
    billingCycleLabel: safeStr(explanation.billingCycleLabel),
    originalLabel: safeStr(explanation.originalLabel),
    discountLabel: safeStr(explanation.discountLabel),
    finalLabel: safeStr(explanation.finalLabel),
    appliesToLabel: safeStr(explanation.appliesToLabel),
    couponCode: safeStr(explanation.couponCode),
    chargeMode: safeStr(quote.chargeMode),
    calculation,
  };
}

// -------------------------
// Admin helpers: leitura segura de precificação efetiva do usuário
// -------------------------
function normalizeAdminPricingSnapshot(userSnapshot = {}) {
  const snap = userSnapshot && typeof userSnapshot === "object" ? userSnapshot : {};
  const quote = snap.pricingQuote && typeof snap.pricingQuote === "object" ? snap.pricingQuote : null;
  const checkoutDraft = snap.checkoutDraft && typeof snap.checkoutDraft === "object" ? snap.checkoutDraft : null;

  const planCode = normalizePlanCode(
    snap.selectedPlanCode ||
      quote?.planCode ||
      checkoutDraft?.selectedPlanCode ||
      checkoutDraft?.planCode ||
      snap.plan ||
      ""
  );

  let billingCycle = "monthly";
  try {
    billingCycle = normalizeBillingCycle(
      snap.selectedBillingCycle ||
        quote?.billingCycle ||
        checkoutDraft?.selectedBillingCycle ||
        checkoutDraft?.billingCycle ||
        "monthly",
      { fallback: "monthly" }
    );
  } catch (_) {
    billingCycle = "monthly";
  }

  const couponCode = normalizeCouponCode(
    snap.selectedCouponCode ||
      quote?.couponCode ||
      checkoutDraft?.selectedCouponCode ||
      checkoutDraft?.couponCode ||
      ""
  );

  return {
    userId: safeStr(snap.userId || snap.internalUserId || snap.waId),
    internalUserId: safeStr(snap.internalUserId || snap.userId || snap.waId),
    planCode,
    billingCycle,
    couponCode,
    pricingQuote: quote,
    checkoutDraft,
  };
}

function buildAdminPricingMoneyView(cents) {
  const valueCents = normalizeCurrencyCents(cents);
  return {
    cents: valueCents,
    label: formatBRLFromCents(valueCents),
  };
}

function buildAdminPricingWarning(code, message, severity = "warn") {
  return {
    code: safeStr(code) || "admin_pricing_warning",
    message: safeStr(message) || "Aviso de precificação administrativa.",
    severity: safeStr(severity) || "warn",
  };
}

export async function getAdminUserEffectivePricingView(userSnapshot = {}, options = {}) {
  const normalized = normalizeAdminPricingSnapshot(userSnapshot);
  const warnings = [];
  const source = safeStr(options.source || "admin_pricing_view");

  warnings.push(buildAdminPricingWarning(
    "individual_price_not_supported_without_financial_sync",
    "Preço individual não suportado sem integração financeira correspondente.",
    "warn"
  ));

  if (!normalized.planCode) {
    return {
      ok: true,
      valid: false,
      planCode: "",
      billingCycle: normalized.billingCycle,
      couponCode: normalized.couponCode,
      basePrice: buildAdminPricingMoneyView(0),
      discount: buildAdminPricingMoneyView(0),
      finalPrice: buildAdminPricingMoneyView(0),
      source,
      pricingSource: "none",
      warnings: [
        ...warnings,
        buildAdminPricingWarning("missing_plan", "Usuário sem plano definido para leitura de preço efetivo.", "info"),
      ],
      quote: null,
    };
  }

  const quote = await buildPricingQuote({
    internalUserId: normalized.internalUserId,
    planCode: normalized.planCode,
    billingCycle: normalized.billingCycle,
    couponCode: normalized.couponCode,
    trackMetrics: false,
    trackingMode: PRICING_TRACKING_MODE.INTERNAL,
    source,
  });

  if (!quote?.ok) {
    return {
      ok: true,
      valid: false,
      planCode: normalized.planCode,
      billingCycle: normalized.billingCycle,
      couponCode: normalized.couponCode,
      basePrice: buildAdminPricingMoneyView(0),
      discount: buildAdminPricingMoneyView(0),
      finalPrice: buildAdminPricingMoneyView(0),
      source,
      pricingSource: "pricing_engine_error",
      warnings: [
        ...warnings,
        buildAdminPricingWarning(
          safeStr(quote?.code) || "pricing_quote_invalid",
          safeStr(quote?.reason) || "Não foi possível calcular a visão de preço efetivo pelo motor central.",
          "danger"
        ),
      ],
      quote,
    };
  }

  const calculation = cloneCalculation(quote.calculation || {});
  const summarized = summarizePricingQuote(quote);
  const storedQuote = normalized.pricingQuote;

  if (storedQuote) {
    warnings.push(buildAdminPricingWarning(
      "stored_pricing_quote_is_historical",
      "Há pricingQuote salvo no usuário; ele é tratado como histórico/rascunho e não como mensalidade individual editável.",
      "info"
    ));
  }

  return {
    ok: true,
    valid: true,
    planCode: normalized.planCode,
    billingCycle: normalized.billingCycle,
    couponCode: normalized.couponCode,
    basePrice: buildAdminPricingMoneyView(calculation.basePriceCents),
    discount: buildAdminPricingMoneyView(calculation.discountAmountCents),
    finalPrice: buildAdminPricingMoneyView(calculation.finalPriceCents),
    source,
    pricingSource: normalized.couponCode ? "pricing_engine_plan_coupon" : "pricing_engine_plan",
    warnings,
    summary: summarized,
    quote,
  };
}
