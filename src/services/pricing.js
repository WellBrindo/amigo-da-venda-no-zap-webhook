// src/services/pricing.js
// Motor central de precificação do checkout.
// Responsabilidades:
// - montar quote oficial por plano + ciclo + cupom opcional
// - centralizar preço original, desconto, preço final e explicação do cálculo
// - impedir recálculo espalhado em flow / asaas / admin

import { getPlan, getPlanBillingOption, formatBRLFromCents } from "./plans.js";
import { getCoupon, validateCouponEligibility } from "./coupons.js";

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

export async function getBasePlanPricing({ planCode = "", billingCycle = "monthly" } = {}) {
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
} = {}) {
  const normalizedInternalUserId = safeStr(internalUserId);
  const normalizedPlanCode = normalizePlanCode(planCode);
  const normalizedBillingCycle = normalizeBillingCycle(billingCycle);
  const normalizedCouponCode = normalizeCouponCode(couponCode);

  const baseQuote = await getBasePlanPricing({
    planCode: normalizedPlanCode,
    billingCycle: normalizedBillingCycle,
  });

  if (!baseQuote.ok) {
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
    return buildSuccess({
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
    return buildFailure(
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
  }

  const calculation = cloneCalculation(eligibility?.calculation || baseCalculation);

  return buildSuccess({
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
