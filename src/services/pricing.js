// src/services/pricing.js
// Motor central de precificação do checkout.
// Responsabilidades:
// - montar quote oficial por plano + ciclo + cupom opcional
// - centralizar preço original, desconto, preço final e explicação do cálculo
// - impedir recálculo espalhado em flow / asaas / admin

import { getPlan, getPlanBillingOption, formatBRLFromCents } from "./plans.js";
import { getCoupon, validateCouponEligibility } from "./coupons.js";
import { trackPricingQuoteGenerated, trackPricingError } from "./metrics.js";

const BILLING_CYCLES = Object.freeze(["monthly", "annual"]);
const APPLIES_TO = Object.freeze({
  FIRST_CHARGE_ONLY: "first_charge_only",
  ENTIRE_SUBSCRIPTION: "entire_subscription",
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
} = {}) {
  return {
    userId: safeStr(internalUserId),
    waId: safeStr(internalUserId),
    planCode: normalizePlanCode(planCode),
    billingCycle: normalizeBillingCycle(billingCycle, { fallback: "monthly" }),
    couponCode: normalizeCouponCode(couponCode),
    source: safeStr(source) || "pricing",
    step: safeStr(step),
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
} = {}) {
  if (!shouldEmitOfficialPricingTracking(trackingMode)) return { ok: true, skipped: true };
  return emitPricingMetricSafe(trackPricingError, buildPricingTrackingContext({
    internalUserId,
    planCode,
    billingCycle,
    couponCode,
    source,
    step,
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

export async function getBasePlanPricing({ planCode = "", billingCycle = "monthly", trackMetrics = false, trackingMode = "", source = "pricing" } = {}) {
  const normalizedPlanCode = normalizePlanCode(planCode);
  const normalizedBillingCycle = normalizeBillingCycle(billingCycle);

  if (!normalizedPlanCode) {
    return buildFailure("plan_code_required", "planCode required");
  }

  const plan = await getPlan(normalizedPlanCode);
  if (!plan || !safeStr(plan.code)) {
    return buildFailure("plan_not_found", "Plan not found", {
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
    });
  }

  const billingOption = getPlanBillingOption(plan, normalizedBillingCycle);
  if (!billingOption || billingOption.enabled === false) {
    return buildFailure("billing_cycle_not_available", "Billing cycle not available", {
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

  const result = buildSuccess({
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

  void trackMetrics;
  void trackingMode;
  void source;

  return result;
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
  const normalizedBillingCycle = normalizeBillingCycle(billingCycle);
  const normalizedCouponCode = normalizeCouponCode(couponCode);
  const resolvedTrackingMode = resolvePricingTrackingMode({ trackingMode, trackMetrics, source });

  const baseQuote = await getBasePlanPricing({
    planCode: normalizedPlanCode,
    billingCycle: normalizedBillingCycle,
    trackMetrics: false,
    trackingMode: PRICING_TRACKING_MODE.NONE,
    source,
  });

  if (!baseQuote.ok) {
    await maybeTrackPricingError({
      trackingMode: resolvedTrackingMode,
      internalUserId: normalizedInternalUserId,
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      couponCode: normalizedCouponCode,
      source,
      step: safeStr(baseQuote?.code) === "billing_cycle_not_available"
        ? "invalid_plan_or_cycle"
        : safeStr(baseQuote?.code) === "plan_not_found"
          ? "invalid_plan_or_cycle"
          : safeStr(baseQuote?.code) || "build_base_quote_failed",
    });
    return {
      ...baseQuote,
      internalUserId: normalizedInternalUserId,
      couponCode: normalizedCouponCode,
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

  const coupon = await getCoupon(normalizedCouponCode);
  const eligibility = await validateCouponEligibility({
    internalUserId: normalizedInternalUserId,
    couponCode: normalizedCouponCode,
    planCode: normalizedPlanCode,
    billingCycle: normalizedBillingCycle,
    basePriceCents: baseCalculation.basePriceCents,
  });

  if (!eligibility?.ok || !eligibility?.eligible) {
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
      }
    );

    await maybeTrackPricingError({
      trackingMode: resolvedTrackingMode,
      internalUserId: normalizedInternalUserId,
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      couponCode: normalizedCouponCode,
      source,
      step: ["plan_or_cycle_invalid", "coupon_plan_not_allowed", "coupon_cycle_not_allowed"].includes(safeStr(eligibility?.code))
        ? "invalid_plan_or_cycle"
        : "invalid_coupon",
    });

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
