// src/services/flow.js
/**
 * Motor principal de conversa (WhatsApp).
 *
 * Objetivo deste passo (16.4):
 * ✅ Trial e Active gerando anúncio via OpenAI
 * ✅ Template FIXED x FREE com preferência persistida (TEMPLATE/LIVRE)
 * ✅ Fim do trial -> mostra planos direto (1/2/3)
 * ✅ Após plano -> escolhe forma de pagamento (Cartão / PIX)
 * ✅ Antes de Asaas -> pede CPF/CNPJ e valida DV
 * ✅ Integração Asaas:
 *    - Cartão: link recorrente (paymentLinks / chargeType RECURRENT)
 *    - PIX: cobrança mensal avulsa (payments / billingType PIX)
 *
 * Regras:
 * - Nunca logar CPF/CNPJ.
 * - Sem gambiarras: fluxo por status + funções pequenas e claras.
 * - O identificador recebido aqui é tratado como referência canônica interna do usuário.
 */

import { generateAdText } from "./openai/generate.js";
import {
  incDescriptionMetrics,
  trackFirstInboundReceived,
  trackTrialStarted,
  trackFirstAdGenerationStarted,
  trackFirstAdGenerated,
  trackAdGenerated,
  trackAdRefined,
  trackTrialLimitReached,
  trackPlansViewed,
  trackPlanSelected,
  trackBillingCycleSelected,
  trackCouponCodeEntered,
  trackCouponApplied,
  trackCouponRejected,
  trackCouponRemoved,
  trackPricingQuoteGenerated,
  trackCheckoutStarted,
  trackCheckoutConfirmed,
  trackPaymentAbandoned,
  trackFlowError,
  trackPaymentError,
  trackCampaignError,
  trackRedisDegraded,
  trackRedisDown,
  trackRedisCriticalWriteBlocked,
} from "./metrics.js";
import { getCopyText } from "./copy.js";
import * as audit from "./audit.js";
import { redisGet, redisSafeGet, getRedisHealthSnapshot } from "./redis.js";
import { raiseSystemIncident } from "./alerts.js";

import {
  ensureUserExists,
  getUserStatus,
  setUserStatus,
  getUserFullName,
  setUserFullName,
  getTemplateMode,
  setTemplateMode,
  getTemplatePrompted,
  setTemplatePrompted,
  getUserTrialUsed,
  incUserTrialUsed,
  getUserPlan,
  setUserPlan,
  getUserQuotaUsed,
  incUserQuotaUsed,
  setLastPrompt,
  getLastPrompt,
  clearLastPrompt,
  getLastAd,
  setLastAd,
  clearLastAd,
  getRefineCount,
  setRefineCount,
  incRefineCount,
  clearRefineCount,
  getPaymentMethod,
  setPaymentMethod,
  getUserDocMasked,
  setUserDocMasked,
  getBillingCityState,
  setBillingCityState,
  getBillingAddress,
  setBillingAddress,
  getAsaasCustomerId,
  setAsaasCustomerId,
  getAsaasSubscriptionId,
  setAsaasSubscriptionId,
  setMenuPrevStatus,
  getMenuPrevStatus,
  clearMenuPrevStatus,
  setMenuEditContext,
  getMenuEditContext,
  clearMenuEditContext,
  setPrevStatus,
  getPrevStatus,
  clearPrevStatus,
  getBizProfile,
  setBizProfile,
  clearBizProfile,
  getPendingBizProfile,
  setPendingBizProfile,
  clearPendingBizProfile,
  setCardValidUntil,
  getCardValidUntil,
  setCardCanceledAt,
  getCurrentAdSession,
  setCurrentAdSession,
  clearCurrentAdSession,
  getActivityMeta,
  setLastInboundAt,
  setFloodMeta,
  armPostAdIdleReminder,
  clearPostAdIdleReminder,
  markUserAdCreated,
  getCheckoutDraft,
  setCheckoutDraft,
  clearCheckoutDraft,
  getSelectedPlanCode,
  setSelectedPlanCode,
  clearSelectedPlanCode,
  getSelectedBillingCycle,
  setSelectedBillingCycle,
  clearSelectedBillingCycle,
  getSelectedCouponCode,
  setSelectedCouponCode,
  clearSelectedCouponCode,
  getPricingQuote as getStoredPricingQuote,
  setPricingQuote,
  clearPricingQuote,
  getCouponReservationId,
  setCouponReservationId,
  clearCouponReservationId,
  setCouponReservationCreatedAt,
  clearCouponReservationCreatedAt,
  getCheckoutCouponStatus,
  setCheckoutCouponStatus,
  clearCheckoutCouponStatus,
  resetCheckoutCouponState,
  setPlansViewedAt,
  setCheckoutStartedAt,
  setTrialEndedAt,
  setLastCampaignInteractionAt,
  setLastPlanPromptAt,
} from "./state.js";

import { getMenuPlans, getPlan, getPlanByChoice, renderPlansMenu } from "./Plans.js";
import { getPlanBillingOption } from "./plans.js";
import { validateDoc } from "./brDoc.js";
import { buildPricingQuote, summarizePricingQuote } from "./pricing.js";
import { createCouponReservation, releaseCouponReservation } from "./coupons.js";

import {
  findCustomerByExternalReference,
  createCustomer,
  createAsaasCheckoutFromQuote,
  createRecurringCardPaymentLink,
  getSubscription,
  cancelSubscription,
} from "./asaas/client.js";
import {
  markCampaignClickedIntent,
  attributeCampaignConversion,
  getCampaignAttributableContext,
  listCampaigns as listCampaignDefinitions,
} from "./campaigns.js";

// -------------------- Config --------------------
const TRIAL_LIMIT_DEFAULT = 5;
const GLOBAL_SETTINGS_PREFIX = "cfg:global:";
const TRIAL_MAX_DESCRIPTIONS_KEY = `${GLOBAL_SETTINGS_PREFIX}trial.maxDescriptions`;

function normalizeGlobalIntSetting(rawValue, fallback, { min = 1, max = 1000 } = {}) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return fallback;
  }

  const parsed = Number(rawValue);
  let value = Number.isFinite(parsed) ? Math.trunc(parsed) : Number(fallback);

  if (Number.isFinite(min)) value = Math.max(min, value);
  if (Number.isFinite(max)) value = Math.min(max, value);

  return value;
}

async function getTrialMaxDescriptions() {
  try {
    if (typeof redisSafeGet === "function") {
      const result = await redisSafeGet(TRIAL_MAX_DESCRIPTIONS_KEY, {
        fallbackValue: TRIAL_LIMIT_DEFAULT,
        critical: false,
        module: "flow",
        step: "get_trial_max_descriptions",
        suppressThrow: true,
      });

      if (result?.ok) {
        return normalizeGlobalIntSetting(result.value, TRIAL_LIMIT_DEFAULT, { min: 1, max: 1000 });
      }

      const redisStatus = typeof getRedisHealthSnapshot === "function"
        ? getRedisHealthSnapshot()?.status || "DEGRADED"
        : "DEGRADED";

      try {
        if (redisStatus === "DOWN" && typeof trackRedisDown === "function") {
          await trackRedisDown({
            userId: "",
            waId: "",
            source: "flow",
            step: "get_trial_max_descriptions",
            errorCode: "FLOW_REDIS_TRIAL_CONFIG_DEGRADED",
            impact: "trial_config_fallback",
            severity: "MEDIUM",
          });
        } else if (typeof trackRedisDegraded === "function") {
          await trackRedisDegraded({
            userId: "",
            waId: "",
            source: "flow",
            step: "get_trial_max_descriptions",
            errorCode: "FLOW_REDIS_TRIAL_CONFIG_DEGRADED",
            impact: "trial_config_fallback",
            severity: "MEDIUM",
          });
        }
      } catch {}

      try {
        await raiseSystemIncident({
          type: "REDIS",
          severity: "MEDIUM",
          module: "flow",
          step: "get_trial_max_descriptions",
          errorCode: "FLOW_REDIS_TRIAL_CONFIG_DEGRADED",
          message: "Redis degraded while reading global trial configuration. Default fallback applied.",
          impact: "trial_config_fallback",
          dedupeKey: "flow|get_trial_max_descriptions|FLOW_REDIS_TRIAL_CONFIG_DEGRADED|trial_config_fallback",
          meta: {
            redisStatus,
          },
        });
      } catch {}

      return normalizeGlobalIntSetting(result?.value, TRIAL_LIMIT_DEFAULT, { min: 1, max: 1000 });
    }

    const rawValue = await redisGet(TRIAL_MAX_DESCRIPTIONS_KEY);
    return normalizeGlobalIntSetting(rawValue, TRIAL_LIMIT_DEFAULT, { min: 1, max: 1000 });
  } catch {
    return TRIAL_LIMIT_DEFAULT;
  }
}

// -------------------- Statuses (FSM) --------------------
const ST = Object.freeze({
  TRIAL: "TRIAL",
  ACTIVE: "ACTIVE",
  PAYMENT_PENDING: "PAYMENT_PENDING",
  BLOCKED: "BLOCKED",

  WAIT_NAME: "WAIT_NAME",
  WAIT_PRODUCT: "WAIT_PRODUCT",

  WAIT_PLAN: "WAIT_PLAN",
  WAIT_BILLING_CYCLE: "WAIT_BILLING_CYCLE",
  WAIT_COUPON_CODE: "WAIT_COUPON_CODE",
  WAIT_CHECKOUT_CONFIRMATION: "WAIT_CHECKOUT_CONFIRMATION",
  WAIT_UPGRADE_CHOICE: "WAIT_UPGRADE_CHOICE",
  WAIT_PAYMENT_METHOD: "WAIT_PAYMENT_METHOD",
  WAIT_PAYMENT_RECOVERY: "WAIT_PAYMENT_RECOVERY",
  WAIT_DOC: "WAIT_DOC",
  WAIT_BILLING_CITY_STATE: "WAIT_BILLING_CITY_STATE",
  WAIT_BILLING_ADDRESS: "WAIT_BILLING_ADDRESS",

  WAIT_MENU: "WAIT_MENU",
  WAIT_MENU_SUBSCRIPTION: "WAIT_MENU_SUBSCRIPTION",
  WAIT_MENU_EDIT_ROOT: "WAIT_MENU_EDIT_ROOT",
  WAIT_MENU_EDIT_PERSONAL: "WAIT_MENU_EDIT_PERSONAL",
  WAIT_MENU_EDIT_COMPANY: "WAIT_MENU_EDIT_COMPANY",
  WAIT_MENU_EDIT_TEMPLATE: "WAIT_MENU_EDIT_TEMPLATE",
  WAIT_MENU_EDIT_VALUE: "WAIT_MENU_EDIT_VALUE",
  WAIT_MENU_NEW_NAME: "WAIT_MENU_NEW_NAME",
  WAIT_MENU_NEW_DOC: "WAIT_MENU_NEW_DOC",
  WAIT_MENU_PROFILE: "WAIT_MENU_PROFILE",

  // Pós-anúncio
  WAIT_TEMPLATE_MODE: "WAIT_TEMPLATE_MODE",
  WAIT_SAVE_PROFILE: "WAIT_SAVE_PROFILE",
  WAIT_FIRST_RESULT_PROMPT: "WAIT_FIRST_RESULT_PROMPT",
  WAIT_FIRST_RESULT_EXPLAIN: "WAIT_FIRST_RESULT_EXPLAIN",
  WAIT_FEEDBACK_RESPONSE: "WAIT_FEEDBACK_RESPONSE",
  WAIT_CATEGORY_DISAMBIGUATION: "WAIT_CATEGORY_DISAMBIGUATION",
  WAIT_INTENT_DISAMBIGUATION: "WAIT_INTENT_DISAMBIGUATION",
  WAIT_CATEGORY_DETAILS: "WAIT_CATEGORY_DETAILS",

  // Wizard: adicionar/ajustar dados da empresa (manual)
  WAIT_PROFILE_ADD_COMPANY: "WAIT_PROFILE_ADD_COMPANY",
  WAIT_PROFILE_ADD_WHATSAPP: "WAIT_PROFILE_ADD_WHATSAPP",
  WAIT_PROFILE_ADD_ADDRESS: "WAIT_PROFILE_ADD_ADDRESS",
  WAIT_PROFILE_ADD_HOURS: "WAIT_PROFILE_ADD_HOURS",
  WAIT_PROFILE_ADD_SOCIAL: "WAIT_PROFILE_ADD_SOCIAL",
  WAIT_PROFILE_ADD_WEBSITE: "WAIT_PROFILE_ADD_WEBSITE",
  WAIT_PROFILE_ADD_PRODUCTS: "WAIT_PROFILE_ADD_PRODUCTS",
});

// -------------------- Helpers --------------------
function cleanText(t) {
  return String(t ?? "").trim();
}

function upper(t) {
  return cleanText(t).toUpperCase();
}

function isGreeting(t) {
  const s = upper(t);
  return ["OI", "OLA", "OLÁ", "BOM DIA", "BOA TARDE", "BOA NOITE", "INICIO", "INÍCIO", "START"].includes(s);
}

function normalizeChoice(t) {
  const s = upper(t);
  if (s === "1" || s.startsWith("1 ")) return "1";
  if (s === "2" || s.startsWith("2 ")) return "2";
  if (s === "3" || s.startsWith("3 ")) return "3";
  return "";
}

function normalizeBillingCycleChoice(t) {
  const c = normalizeChoice(t);
  if (c === "1") return "monthly";
  if (c === "2") return "annual";
  return "";
}

function wantsNoCouponCommand(t) {
  const s = upper(t);
  return s === "SEM CUPOM" || s === "SEM" || s === "NAO TENHO CUPOM" || s === "NÃO TENHO CUPOM" || s === "SEM DESCONTO";
}

function wantsConfirmCheckoutCommand(t) {
  const s = upper(t);
  return s === "CONFIRMAR" || s === "CONTINUAR" || s === "SEGUIR" || s === "FECHAR" || s === "PAGAR";
}

function wantsChangePlanCommand(t) {
  const s = upper(t);
  return s === "PLANO" || s === "TROCAR PLANO" || s === "ALTERAR PLANO";
}

function wantsChangeBillingCycleCommand(t) {
  const s = upper(t);
  return s === "CICLO" || s === "TROCAR CICLO" || s === "ALTERAR CICLO" || s === "MENSAL/ANUAL";
}

function wantsChangeCouponCommand(t) {
  const s = upper(t);
  return s === "CUPOM" || s === "TROCAR CUPOM" || s === "ALTERAR CUPOM" || s === "REMOVER CUPOM";
}

function billingCycleHumanLabel(value) {
  const cycle = String(value || "").trim().toLowerCase();
  return cycle === "annual" ? "anual" : "mensal";
}

function asaasSubscriptionCycleFromBillingCycle(value) {
  const cycle = String(value || "").trim().toLowerCase();
  return cycle === "annual" ? "YEARLY" : "MONTHLY";
}

function formatMoneyTextFromCents(cents) {
  return `R$ ${String(moneyBRFromCents(cents)).replace('.', ',')}`;
}

function wantsTemplateCommand(t) {
  const s = upper(t);
  return s === "TEMPLATE" || s === "FIXO" || s === "FIXED";
}

function wantsFreeCommand(t) {
  const s = upper(t);
  return s === "LIVRE" || s === "FREE";
}

function wantsMenuCommand(t) {
  const s = upper(t);
  return s === "MENU" || s === "MENÚ";
}

function wantsOkCommand(t) {
  const s = upper(t);
  return s === "OK" || s === "PRONTO" || s === "PROXIMO" || s === "PRÓXIMO";
}

function wantsChangePaymentCommand(t) {
  const s = upper(t);
  return s === "MUDAR PAGAMENTO" || s === "TROCAR PAGAMENTO" || s === "ALTERAR PAGAMENTO" || s === "MUDAR FORMA DE PAGAMENTO";
}

function wantsSkipCommand(t) {
  const s = upper(t);
  return s === "PULAR" || s === "PULA" || s === "SKIP" || s === "0" || s === "-" || s === "NAO" || s === "NÃO";
}

function wantsFinishCommand(t) {
  const s = upper(t);
  return s === "FIM" || s === "FINALIZAR" || s === "PRONTO" || s === "CONCLUIR";
}

function normalizeUrlLike(t) {
  let s = cleanText(t);
  if (!s) return "";

  if (s.startsWith("@")) {
    s = "instagram.com/" + s.slice(1);
  }

  s = s.replace(/\s+/g, "");
  s = s
    .replace(/instagram\.ocm/gi, "instagram.com")
    .replace(/instagram\.cmo/gi, "instagram.com")
    .replace(/istagram\.com/gi, "instagram.com")
    .replace(/instagran\.com/gi, "instagram.com")
    .replace(/facebok\.com/gi, "facebook.com")
    .replace(/faceboook\.com/gi, "facebook.com")
    .replace(/facebook\.ocm/gi, "facebook.com")
    .replace(/facebook\.cmo/gi, "facebook.com")
    .replace(/tiktok\.ocm/gi, "tiktok.com")
    .replace(/tiktok\.cmo/gi, "tiktok.com");

  if (/^www\./i.test(s)) s = `https://${s}`;
  return s;
}

function normalizeWhatsappLike(t) {
  const raw = cleanText(t);
  if (!raw) return "";

  const digits = raw.replace(/\D+/g, "");
  if (digits.length >= 10) {
    let local = digits;
    if ((local.length === 12 || local.length === 13) && local.startsWith("55")) {
      local = local.slice(2);
    }
    if (local.length > 11) local = local.slice(-11);

    if (local.length === 11) {
      return `${local.slice(0, 2)} ${local.slice(2, 7)}-${local.slice(7)}`;
    }
    if (local.length === 10) {
      return `${local.slice(0, 2)} ${local.slice(2, 6)}-${local.slice(6)}`;
    }
  }

  return raw.replace(/\*/g, "-").trim();
}

function normalizeBusinessVoice(adText, bizProfile) {
  const companyName = normalizeProfileScalar(bizProfile?.companyName);
  if (!companyName) return String(adText || "");

  return String(adText || "")
    .replace(/^Sou\s+/im, "Somos ")
    .replace(/^Atendo\s+/im, "Atendemos ")
    .replace(/^Faço\s+/im, "Fazemos ")
    .replace(/^Ofereço\s+/im, "Oferecemos ")
    .replace(/^Trabalho\s+/im, "Trabalhamos ")
    .replace(/meu atendimento/gi, "nosso atendimento")
    .replace(/meus servi[cç]os/gi, "nossos serviços")
    .replace(/minha consultoria/gi, "nossa consultoria")
    .replace(/meu trabalho/gi, "nosso trabalho");
}

function ensureArray(v) {
  return Array.isArray(v) ? v : [];
}

function normalizeMenuChoice(t) {
  const s = cleanText(t);
  // aceita "1", "1)", "1." etc
  const m = s.match(/^(\d{1,2})\s*[)\.\-:]?/);
  if (!m) return "";
  const n = String(m[1] || "").trim();
  // menu tem 1..11
  if (!n) return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  if (num < 1 || num > 11) return "";
  return String(num);
}

function formatDateBR(iso) {
  const s = String(iso || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  return `${m[3]}/${m[2]}`;
}

async function withMenuHint(waId, text) {
  const base = String(text || "").trim();
  const hint = String(await getCopyText("FLOW_MENU_HINT", { waId })).trim();
  if (!base) return hint;
  if (!hint) return base;
  if (/digitar\s+\*?menu\*?/i.test(base)) return base;
  return `${base}

${hint}`;
}

function daysUntilISO(iso) {
  const s = String(iso || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const target = new Date(y, mo, d, 23, 59, 59);
  const now = new Date();
  const diffMs = target.getTime() - now.getTime();
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

function isISODateInFutureOrToday(iso) {
  const days = daysUntilISO(iso);
  if (days === null) return false;
  return days >= 0;
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function nowIso() {
  return new Date().toISOString();
}

function buildFlowTrackingContext(waId, extra = {}) {
  const context = {
    userId: cleanText(waId),
    waId: cleanText(waId),
    source: "flow",
    ...extra,
  };

  Object.keys(context).forEach((key) => {
    if (context[key] === undefined || context[key] === null || context[key] === "") {
      delete context[key];
    }
  });

  return context;
}

const FLOW_ERROR_KIND = Object.freeze({
  OPENAI_ERROR: "OPENAI_ERROR",
  PRICING_ERROR: "PRICING_ERROR",
  COUPON_ERROR: "COUPON_ERROR",
  CHECKOUT_ERROR: "CHECKOUT_ERROR",
  ASAAS_CLIENT_ERROR: "ASAAS_CLIENT_ERROR",
  STATE_ERROR: "STATE_ERROR",
  WHATSAPP_SEND_ERROR: "WHATSAPP_SEND_ERROR",
  FLOW_STATE_ERROR: "FLOW_STATE_ERROR",
  CAMPAIGN_ATTRIBUTION_ERROR: "CAMPAIGN_ATTRIBUTION_ERROR",
  UNKNOWN_FLOW_ERROR: "UNKNOWN_FLOW_ERROR",
});

function resolveFlowErrorCode(err, fallback = "FLOW_RUNTIME_ERROR") {
  const explicit = cleanText(err?.errorCode || err?.code || err?.name);
  if (explicit) return explicit;
  const msg = cleanText(err?.message).toUpperCase();
  if (!msg) return fallback;
  if (msg.includes("ASAAS")) return "ASAAS_CLIENT_ERROR";
  if (msg.includes("COUPON")) return "COUPON_ERROR";
  if (msg.includes("PRICING") || msg.includes("QUOTE")) return "PRICING_ERROR";
  if (msg.includes("REDIS") || msg.includes("STATE")) return "STATE_ERROR";
  if (msg.includes("OPENAI")) return "OPENAI_ERROR";
  return fallback;
}

function serializeFlowError(err) {
  if (!err) return {};
  return {
    name: cleanText(err?.name),
    message: cleanText(err?.message || err),
    code: cleanText(err?.code || err?.errorCode),
    status: Number.isFinite(Number(err?.status)) ? Number(err.status) : undefined,
    retryable: typeof err?.retryable === "boolean" ? err.retryable : undefined,
  };
}

function createFlowRuntimeContext(waId, extra = {}) {
  return buildFlowTrackingContext(waId, extra);
}

async function flowRuntimeLog(level, event, payload = {}) {
  const entry = {
    ts: nowIso(),
    module: "flow",
    level: cleanText(level || "error").toLowerCase(),
    source: "flow",
    event: cleanText(event || "runtime"),
    ...payload,
  };

  try {
    if (typeof audit?.logOperationalEvent === "function") {
      await audit.logOperationalEvent(entry);
      return;
    }
    if (typeof audit?.logRuntimeError === "function") {
      await audit.logRuntimeError(entry);
      return;
    }
  } catch (_) {
    // fallback abaixo
  }

  const writer = entry.level === "warn" ? console.warn : console.error;
  writer(JSON.stringify(entry));
}

async function emitFlowFailureMetric(kind, waId, extra = {}) {
  const payload = createFlowRuntimeContext(waId, extra);
  try {
    if (kind === FLOW_ERROR_KIND.CAMPAIGN_ATTRIBUTION_ERROR) {
      return await trackCampaignError(payload);
    }
    if ([FLOW_ERROR_KIND.PRICING_ERROR, FLOW_ERROR_KIND.COUPON_ERROR, FLOW_ERROR_KIND.CHECKOUT_ERROR, FLOW_ERROR_KIND.ASAAS_CLIENT_ERROR].includes(kind)) {
      return await trackPaymentError(payload);
    }
    return await trackFlowError(payload);
  } catch (metricErr) {
    await flowRuntimeLog("warn", "flow_metric_emit_failed", {
      userId: cleanText(waId),
      step: cleanText(extra?.step),
      kind: cleanText(kind),
      metricError: serializeFlowError(metricErr),
    });
    return null;
  }
}

async function reportFlowRuntimeError(kind, waId, err, extra = {}) {
  const errorCode = resolveFlowErrorCode(err, cleanText(kind) || "FLOW_RUNTIME_ERROR");
  const step = cleanText(extra?.step);
  const payload = {
    ...extra,
    step,
    errorCode,
    kind: cleanText(kind),
  };
  await flowRuntimeLog(extra?.level || "error", extra?.event || "flow_runtime_error", {
    userId: cleanText(waId),
    waId: cleanText(waId),
    step,
    errorCode,
    kind: cleanText(kind),
    meta: extra?.meta && typeof extra.meta === "object" ? extra.meta : undefined,
    error: serializeFlowError(err),
  });
  await emitFlowFailureMetric(kind, waId, payload);
  return { errorCode, message: cleanText(err?.message || err) };
}

function normalizeIdentityContext(identityContext = {}) {
  return {
    reviewRequired: Boolean(identityContext?.reviewRequired),
    conflictId: cleanText(identityContext?.conflictId),
    allowConversation: identityContext?.allowConversation !== false,
    blockSensitiveOps: Boolean(identityContext?.blockSensitiveOps),
  };
}

async function msgIdentitySensitiveOpBlocked(waId) {
  return "Seu atendimento continua normalmente, mas esta etapa precisa de validação interna antes de prosseguir.";
}

async function reportIdentitySensitiveOpBlocked(waId, identityContext = {}, step = "", meta = {}) {
  const ctx = normalizeIdentityContext(identityContext);
  await flowRuntimeLog("warn", "flow_identity_sensitive_op_blocked", {
    userId: cleanText(waId),
    waId: cleanText(waId),
    step: cleanText(step),
    errorCode: "IDENTITY_REVIEW_REQUIRED",
    kind: "IDENTITY_REVIEW_REQUIRED",
    status: "blocked",
    meta: {
      conflictId: ctx.conflictId,
      reviewRequired: ctx.reviewRequired,
      blockSensitiveOps: ctx.blockSensitiveOps,
      ...(meta && typeof meta === "object" ? meta : {}),
    },
  });

  try {
    if (typeof audit?.logIdentityConflictAudit === "function") {
      await audit.logIdentityConflictAudit({
        action: "IDENTITY_CONFLICT_SENSITIVE_OP_BLOCKED",
        conflictId: ctx.conflictId,
        status: "PENDING_REVIEW",
        summary: "Operação sensível bloqueada no flow por conflito de identidade pendente.",
        meta: {
          step: cleanText(step),
          ...(meta && typeof meta === "object" ? meta : {}),
        },
      });
    }
  } catch (_) {
    // best effort
  }

  return await msgIdentitySensitiveOpBlocked(waId);
}

async function ensureIdentitySensitiveOpAllowed(waId, identityContext = {}, { step = "", meta = {} } = {}) {
  const ctx = normalizeIdentityContext(identityContext);
  if (!ctx.reviewRequired || !ctx.blockSensitiveOps) {
    return { ok: true, identityContext: ctx };
  }

  const blockedText = await reportIdentitySensitiveOpBlocked(waId, ctx, step, meta);
  return {
    ok: false,
    identityContext: ctx,
    replyText: blockedText,
  };
}

async function failClosedForRedisCriticalStep(waId, {
  step = "",
  error = null,
  errorCode = "FLOW_REDIS_CRITICAL_STEP_BLOCKED",
  impact = "",
  severity = "CRITICAL",
  userMessage = "Estamos passando por uma instabilidade momentânea nesta etapa. Por favor, tente novamente em instantes.",
  meta = {},
} = {}) {
  const redisStatus = typeof getRedisHealthSnapshot === "function"
    ? getRedisHealthSnapshot()?.status || "DEGRADED"
    : "DEGRADED";

  try {
    if (typeof trackRedisCriticalWriteBlocked === "function") {
      await trackRedisCriticalWriteBlocked({
        userId: cleanText(waId),
        waId: cleanText(waId),
        source: "flow",
        step: cleanText(step),
        errorCode: cleanText(errorCode),
        impact: cleanText(impact),
        severity: cleanText(severity),
      });
    }
  } catch {}

  try {
    if (redisStatus === "DOWN" && typeof trackRedisDown === "function") {
      await trackRedisDown({
        userId: cleanText(waId),
        waId: cleanText(waId),
        source: "flow",
        step: cleanText(step),
        errorCode: cleanText(errorCode),
        impact: cleanText(impact),
        severity: cleanText(severity),
      });
    } else if (typeof trackRedisDegraded === "function") {
      await trackRedisDegraded({
        userId: cleanText(waId),
        waId: cleanText(waId),
        source: "flow",
        step: cleanText(step),
        errorCode: cleanText(errorCode),
        impact: cleanText(impact),
        severity: cleanText(severity),
      });
    }
  } catch {}

  try {
    await raiseSystemIncident({
      type: "REDIS",
      severity: cleanText(severity) || "CRITICAL",
      module: "flow",
      step: cleanText(step),
      errorCode: cleanText(errorCode),
      message: cleanText(error?.message || error || "Critical flow step blocked due to Redis degradation."),
      impact: cleanText(impact),
      dedupeKey: ["flow", cleanText(step), cleanText(errorCode), cleanText(impact)].filter(Boolean).join("|"),
      meta: {
        redisStatus,
        ...(meta && typeof meta === "object" ? meta : {}),
      },
    });
  } catch {}

  await flowRuntimeLog("warn", "flow_critical_step_blocked", {
    userId: cleanText(waId),
    waId: cleanText(waId),
    step: cleanText(step),
    errorCode: cleanText(errorCode),
    kind: FLOW_ERROR_KIND.STATE_ERROR,
    status: "blocked",
    meta: {
      redisStatus,
      impact: cleanText(impact),
      ...(meta && typeof meta === "object" ? meta : {}),
    },
    error: serializeFlowError(error),
  });

  await emitFlowFailureMetric(FLOW_ERROR_KIND.STATE_ERROR, waId, {
    step: cleanText(step),
    errorCode: cleanText(errorCode),
    impact: cleanText(impact),
    severity: cleanText(severity),
  });

  return reply(userMessage);
}

async function safeReleaseCouponReservationInFlow(reservationId, options = {}) {
  if (!cleanText(reservationId)) return { ok: true, skipped: true };
  try {
    return await releaseCouponReservation(reservationId, options);
  } catch (error) {
    await raiseSystemIncident({
      type: "REDIS",
      severity: "HIGH",
      module: "flow",
      step: "release_coupon_reservation",
      errorCode: cleanText(error?.errorCode || error?.code || "FLOW_COUPON_RELEASE_FAILED"),
      message: cleanText(error?.message || error || "Failed to release coupon reservation from flow."),
      impact: "coupon_release_failed",
      dedupeKey: "flow|release_coupon_reservation|coupon_release_failed",
      meta: {
        reservationId: cleanText(reservationId),
      },
    }).catch(() => null);
    throw error;
  }
}

async function trackFlowMetricSafe(tracker, waId, extra = {}) {
  if (typeof tracker !== "function") return null;
  try {
    return await tracker(buildFlowTrackingContext(waId, extra));
  } catch (err) {
    await flowRuntimeLog("warn", "flow_tracking_non_fatal_error", {
      userId: cleanText(waId),
      tracker: cleanText(tracker?.name),
      step: cleanText(extra?.step),
      error: serializeFlowError(err),
    });
    return null;
  }
}

function isoMsSafe(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

async function resolveFlowCampaignAttributionContext(waId, { purpose = "click" } = {}) {
  try {
    const listResult = await listCampaignDefinitions({ includeInactive: true, limit: 1000 });
    const campaigns = Array.isArray(listResult?.campaigns) ? listResult.campaigns : [];
    if (!campaigns.length) return null;

    const contexts = await Promise.all(
      campaigns.map(async (campaign) => {
        const ctx = await getCampaignAttributableContext(campaign?.id, waId).catch(() => null);
        if (!ctx?.campaign || !ctx?.hasSentAt || !ctx?.withinAttributionWindow) return null;

        const state = ctx?.state || {};
        const lastSentMs = isoMsSafe(state.lastSentAt);
        const lastClickedMs = isoMsSafe(state.lastClickedIntentAt);
        const lastConvertedMs = isoMsSafe(state.lastConversionAttributedAt);

        if (purpose === "click" && lastClickedMs > 0) return null;
        if (purpose === "conversion" && lastConvertedMs > 0) return null;

        return {
          campaign: ctx.campaign,
          state,
          lastSentMs,
          lastClickedMs,
          lastConvertedMs,
        };
      })
    );

    const eligible = contexts.filter(Boolean);
    if (!eligible.length) return null;

    eligible.sort((a, b) => {
      const aPrimary = purpose === "conversion" ? Math.max(a.lastClickedMs, a.lastSentMs) : a.lastSentMs;
      const bPrimary = purpose === "conversion" ? Math.max(b.lastClickedMs, b.lastSentMs) : b.lastSentMs;
      return bPrimary - aPrimary;
    });

    return eligible[0];
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.CAMPAIGN_ATTRIBUTION_ERROR, waId, err, {
      event: "flow_campaign_attribution_context_failed",
      level: "warn",
      step: purpose === "conversion" ? "campaign_conversion_context" : "campaign_click_context",
      meta: { purpose },
    });
    return null;
  }
}

async function resolveAndTrackCampaignClick(waId) {
  try {
    const resolved = await resolveFlowCampaignAttributionContext(waId, { purpose: "click" });
    if (!resolved?.campaign?.id) return null;

    return await markCampaignClickedIntent(resolved.campaign.id, waId, {
      source: "flow",
      reference: "inbound_message",
      details: {
        step: "handleInboundText",
      },
    });
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.CAMPAIGN_ATTRIBUTION_ERROR, waId, err, {
      event: "flow_campaign_click_tracking_failed",
      level: "warn",
      step: "handleInboundText",
      meta: { reference: "inbound_message" },
    });
    return null;
  }
}

async function resolveAndTrackCampaignConversion(waId, conversionType, reference, extraDetails = {}) {
  try {
    const resolved = await resolveFlowCampaignAttributionContext(waId, { purpose: "conversion" });
    if (!resolved?.campaign?.id) return null;

    return await attributeCampaignConversion(resolved.campaign.id, waId, {
      conversionType: cleanText(conversionType),
      source: "flow",
      eventSource: "flow",
      reference: cleanText(reference),
      details: {
        step: "createCurrentPlanPayment",
        ...extraDetails,
      },
    });
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.CAMPAIGN_ATTRIBUTION_ERROR, waId, err, {
      event: "flow_campaign_conversion_tracking_failed",
      level: "warn",
      step: cleanText(extraDetails?.step || "createCurrentPlanPayment"),
      meta: { conversionType: cleanText(conversionType), reference: cleanText(reference) },
    });
    return null;
  }
}

async function markPlansPrompted(waId, { trialEnded = false } = {}) {
  const ts = nowIso();
  await setPlansViewedAt(waId, ts);
  await setLastPlanPromptAt(waId, ts);
  if (trialEnded) {
    await setTrialEndedAt(waId, ts);
    await trackFlowMetricSafe(trackTrialLimitReached, waId, { step: ST.WAIT_PLAN });
  }
  await trackFlowMetricSafe(trackPlansViewed, waId, { step: ST.WAIT_PLAN, date: new Date(ts) });
}

async function markCheckoutInteraction(waId, { started = false } = {}) {
  const ts = nowIso();
  await setLastCampaignInteractionAt(waId, ts);
  if (started) {
    await setCheckoutStartedAt(waId, ts);
  }
}

function diffMsSafe(fromIso, toIso = nowIso()) {
  const from = new Date(String(fromIso || ""));
  const to = new Date(String(toIso || ""));
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return toMs - fromMs;
}

function isTransientFlowStatus(status) {
  return new Set([
    ST.WAIT_NAME,
    ST.WAIT_PLAN,
    ST.WAIT_BILLING_CYCLE,
    ST.WAIT_COUPON_CODE,
    ST.WAIT_CHECKOUT_CONFIRMATION,
    ST.WAIT_UPGRADE_CHOICE,
    ST.WAIT_PAYMENT_METHOD,
    ST.WAIT_PAYMENT_RECOVERY,
    ST.WAIT_DOC,
    ST.WAIT_BILLING_CITY_STATE,
    ST.WAIT_BILLING_ADDRESS,
    ST.WAIT_TEMPLATE_MODE,
    ST.WAIT_SAVE_PROFILE,
    ST.WAIT_FIRST_RESULT_PROMPT,
    ST.WAIT_FIRST_RESULT_EXPLAIN,
    ST.WAIT_FEEDBACK_RESPONSE,
    ST.WAIT_CATEGORY_DISAMBIGUATION,
    ST.WAIT_INTENT_DISAMBIGUATION,
    ST.WAIT_CATEGORY_DETAILS,
    ST.WAIT_PROFILE_ADD_COMPANY,
    ST.WAIT_PROFILE_ADD_WHATSAPP,
    ST.WAIT_PROFILE_ADD_ADDRESS,
    ST.WAIT_PROFILE_ADD_HOURS,
    ST.WAIT_PROFILE_ADD_SOCIAL,
    ST.WAIT_PROFILE_ADD_WEBSITE,
    ST.WAIT_PROFILE_ADD_PRODUCTS,
    ST.WAIT_MENU,
    ST.WAIT_MENU_SUBSCRIPTION,
    ST.WAIT_MENU_EDIT_ROOT,
    ST.WAIT_MENU_EDIT_PERSONAL,
    ST.WAIT_MENU_EDIT_COMPANY,
    ST.WAIT_MENU_EDIT_TEMPLATE,
    ST.WAIT_MENU_EDIT_VALUE,
    ST.WAIT_MENU_NEW_NAME,
    ST.WAIT_MENU_NEW_DOC,
    ST.PAYMENT_PENDING,
  ]).has(status);
}

function shouldWarnFlood(meta, now = nowIso()) {
  const flood = meta?.flood || {};
  const count = Number(flood.count || 0);
  if (count < 4) return false;

  const warnedAgo = diffMsSafe(flood.warnedAt, now);
  if (warnedAgo !== null && warnedAgo < 30_000) return false;
  return true;
}

function moneyBRFromCents(cents) {
  const v = (Number(cents) || 0) / 100;
  return v.toFixed(2);
}

function reply(text) {
  return { shouldReply: true, replyText: String(text || "") };
}

function noReply() {
  return { shouldReply: false, replyText: "" };
}

function replyMulti(texts) {
  const arr = Array.isArray(texts) ? texts : [texts];
  const replies = arr.map((t) => String(t || "").trim()).filter(Boolean);
  return { shouldReply: true, replies, replyText: replies[0] || "" };
}

function prependReplies(result, prefixTexts) {
  if (!result?.shouldReply) return result;

  const prefixes = (Array.isArray(prefixTexts) ? prefixTexts : [prefixTexts])
    .map((t) => String(t || "").trim())
    .filter(Boolean);

  if (!prefixes.length) return result;

  const existing = Array.isArray(result.replies)
    ? result.replies
    : [String(result.replyText || "").trim()].filter(Boolean);

  const replies = [...prefixes, ...existing].filter(Boolean);
  return { ...result, replies, replyText: replies[0] || "" };
}

function normalizeNewlines(s) {
  return String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripOuterStars(s) {
  return String(s || "").replace(/^\*+/, "").replace(/\*+$/, "").trim();
}

function boldWrapSafe(s) {
  const core = stripOuterStars(s);
  if (!core) return "";
  return `*${core.replace(/\*/g, "").trim()}*`;
}

function enforceAdFormatting(adText) {
  const raw = normalizeNewlines(adText);
  const lines0 = raw.split("\n").map((l) => String(l || "").trimRight());

  // remove leading/trailing empty
  while (lines0.length && !String(lines0[0] || "").trim()) lines0.shift();
  while (lines0.length && !String(lines0[lines0.length - 1] || "").trim()) lines0.pop();

  let lines = [...lines0];

  // --------------------------
  // 1) Título (primeira linha)
  // - Evita duplicar asteriscos quando o GPT já colocou *...*
  // - Se houver emoji no começo, deixa o emoji fora do negrito
  // - Sempre insere uma linha em branco após o título
  // --------------------------
  if (lines.length > 0) {
    let titleLine = String(lines[0] || "").trim();

    // Se veio com "duplo wrap" (ex.: *🏢 *Título**), remove o wrap externo
    const starCount = (titleLine.match(/\*/g) || []).length;
    if (titleLine.startsWith("*") && titleLine.endsWith("*") && starCount > 2) {
      titleLine = titleLine.slice(1, -1).trim();
    }

    // Se o título já tem *...* dentro, mantemos — só limpamos asteriscos soltos no começo/fim
    titleLine = titleLine.replace(/^\*+/, "").replace(/\*+$/, "").trim();

    // Se o emoji estiver dentro do título, tenta separar
    let lead = "";
    let core = titleLine;

    const mEmoji = core.match(/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?\s+)(.+)$/u);
    if (mEmoji) {
      lead = mEmoji[1];
      core = String(mEmoji[2] || "").trim();
    }

    // Se o core já estiver em negrito *...*, apenas garante que não há asteriscos "sobrando"
    const mBold = core.match(/^\*([^*]{1,120})\*$/);
    if (mBold) {
      core = mBold[1].trim();
    } else {
      // remove asteriscos internos soltos, para não quebrar
      core = core.replace(/\*/g, "").trim();
    }

    if (core) {
      lines[0] = `${lead}${boldWrapSafe(core)}`;
    } else {
      lines[0] = `${lead}${boldWrapSafe(titleLine)}`;
    }

    // linha em branco após o título
    if (lines.length > 1 && String(lines[1] || "").trim() !== "") {
      lines.splice(1, 0, "");
    }
  }

  // --------------------------
  // 2) Empresa em negrito (se houver) — sem bloquear por causa do título
  // --------------------------
  const companyPattern1 = /\b([AaOo])\s+([A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ][\wÀ-ÿ&\-\. ]{2,80}?)\s+é\b/;
  const companyPattern2 = /\b([A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ][\wÀ-ÿ&\-\. ]{2,80}?)\s+(é|oferece|atua|ajuda|entrega|faz)\b/;

  // aplica em linhas do corpo (ignora título e linhas vazias)
  for (let i = 1; i < lines.length; i++) {
    const line = String(lines[i] || "");
    if (!line.trim()) continue;

    // evita duplo negrito (ex.: já veio com *Nome*)
    if (line.includes("*")) continue;

    // não mexer em bullets (normalmente começam com emoji)
    if (/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(line.trim())) continue;

    // se já tem um *Nome* no começo, considera ok
    if (/^\*\s*[A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ]/.test(line.trim())) continue;

    let replaced = "";
    const m1 = line.match(companyPattern1);
    if (m1 && m1[2]) {
      const nm = String(m1[2]).trim();
      if (nm && !nm.includes("*")) {
        replaced = line.replace(companyPattern1, (all, art, name) => `${art} ${boldWrapSafe(String(name).trim())} é`);
      }
    }

    if (!replaced) {
      const m2 = line.match(companyPattern2);
      if (m2 && m2[1]) {
        const nm = String(m2[1]).trim();
        if (nm && !nm.includes("*")) {
          replaced = line.replace(companyPattern2, (all, name, verb) => `${boldWrapSafe(String(name).trim())} ${verb}`);
        }
      }
    }

    if (replaced && replaced !== line) {
      lines[i] = replaced;
      break; // aplica uma vez
    }
  }

  // --------------------------
  // 3) Normalização de bullets e labels
  // - separa bullets colados na mesma linha
  // - garante "- *Campo:* valor" sem capturar a linha seguinte
  // --------------------------
  let text = lines.join("\n");

  // separa itens de lista quando o GPT colar "- Campo: valor- Outro: valor"
  text = text
    .replace(/([^\n])\s*(-\s*[A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ][^\n:]{1,80}:)/g, "$1\n$2")
    .replace(/([^\n])\s*(•\s*[A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ][^\n:]{1,80}:)/g, "$1\n$2");

  const bulletLabelRe = /^(\s*[-•]\s*)([^\n:*]{1,80}?)(\s*:\s*)(.*)$/;
  text = text
    .split("\n")
    .map((line) => {
      const current = String(line || "").trimRight();
      const match = current.match(bulletLabelRe);
      if (!match) return current;

      const prefix = match[1] || "";
      const label = stripOuterStars(match[2] || "");
      const separator = ":";
      const value = String(match[4] || "").trim();

      if (!label) return current;
      return value
        ? `${prefix}${boldWrapSafe(label)}${separator} ${value}`
        : `${prefix}${boldWrapSafe(label)}${separator}`;
    })
    .join("\n");

  // --------------------------
  // 4) Preço em negrito (somente o valor)
  // --------------------------
  text = text.replace(/R\$\s*\d[\d\.\s]*([,]\d{2})?/g, (m) => {
    const cleaned = m.replace(/\s+/g, " ").trim();
    if (!cleaned) return m;
    if (cleaned.includes("*")) return cleaned;
    return boldWrapSafe(cleaned);
  });

  // --------------------------
  // 5) Linhas informativas no padrão FIXO
  // - 📍 *Localização:* valor
  // - 🕒 *Horário:* valor
  // - 📞 *WhatsApp:* valor
  // --------------------------
  let arr = text.split("\n").map((l) => String(l || "").trimRight());
  const infoEmojiRe = /^(🇧🇷|🕒|📍|🚚|📞|🌐|💬|✅)\s+/;
  const infoLabelMap = {
    "📍": ["Localização", "Local", "Endereço", "Região"],
    "🕒": ["Horário"],
    "📞": ["WhatsApp", "Contato", "Telefone"],
    "💬": ["WhatsApp", "Contato"],
    "🌐": ["Site"],
    "🚚": ["Entrega"],
    "✅": ["Observação"],
    "🇧🇷": ["Brasil"],
  };

  const formatInfoLine = (line) => {
    const current = String(line || "").trimRight();
    const m = current.match(/^\s*(🇧🇷|🕒|📍|🚚|📞|🌐|💬|✅)\s+([^\n]+)$/);
    if (!m) return current;

    const emoji = m[1];
    let rest = String(m[2] || "").trim();
    if (!rest) return current;

    const colonMatch = rest.match(/^\*?([^:*]{1,40})\*?\s*:\s*(.+)$/);
    if (colonMatch) {
      const label = stripOuterStars(colonMatch[1] || "");
      const value = String(colonMatch[2] || "").trim();
      if (!label || !value) return current;
      return `${emoji} ${boldWrapSafe(label)}: ${value}`;
    }

    const knownLabels = infoLabelMap[emoji] || [];
    for (const label of knownLabels) {
      const rx = new RegExp(`^${escapeRegex(label)}\s*[-–—]?\s*(.+)$`, "i");
      const mm = rest.match(rx);
      if (mm && mm[1]) {
        return `${emoji} ${boldWrapSafe(label)}: ${String(mm[1]).trim()}`;
      }
    }

    return `${emoji} ${rest}`;
  };

  arr = arr.map(formatInfoLine);

  // --------------------------
  // 6) Ordenação: CTA de avanço ("Envie...") antes de informações (🇧🇷/🕒/📍...)
  // --------------------------
  const isInfoLine = (l) => infoEmojiRe.test(String(l || "").trim());
  const isAdvanceCTA = (l) => {
    const s = String(l || "").trim().toLowerCase();
    return s.startsWith("envie ") || s.startsWith("mande ") || s.startsWith("me envie ") || s.startsWith("me mande ");
  };

  const infoBefore = [];
  let advanceIdx = -1;

  for (let i = 0; i < arr.length; i++) {
    const line = String(arr[i] || "");
    if (advanceIdx < 0 && isAdvanceCTA(line)) advanceIdx = i;
  }

  if (advanceIdx >= 0) {
    // coleta info lines que aparecem antes do CTA de avanço
    const kept = [];
    for (let i = 0; i < arr.length; i++) {
      const line = String(arr[i] || "");
      if (i < advanceIdx && isInfoLine(line)) {
        infoBefore.push(line);
        continue;
      }
      kept.push(line);
    }
    arr = kept;

    // recalcula advanceIdx após remoção
    advanceIdx = -1;
    for (let i = 0; i < arr.length; i++) {
      if (advanceIdx < 0 && isAdvanceCTA(arr[i])) advanceIdx = i;
    }

    if (infoBefore.length && advanceIdx >= 0) {
      // garante uma linha em branco após o CTA
      const insertAt = advanceIdx + 1;
      if (arr[insertAt] !== "") arr.splice(insertAt, 0, "");

      // insere infos logo abaixo do CTA
      arr.splice(insertAt + 1, 0, ...infoBefore);

      // garante uma linha em branco antes do CTA final (se houver)
      // (CTA final normalmente começa com "Converse", "Chame", "Fale")
      for (let i = arr.length - 1; i >= 0; i--) {
        const s = String(arr[i] || "").trim().toLowerCase();
        if (!s) continue;
        if (s.startsWith("converse") || s.startsWith("chame") || s.startsWith("fale") || s.startsWith("me chame")) {
          if (i - 1 >= 0 && arr[i - 1] !== "") arr.splice(i, 0, "");
          break;
        }
      }
    }
  }

  // --------------------------
  // 7) Sempre pular uma linha entre os dois CTAs finais (se estiverem colados)
  // --------------------------
  const nonEmptyIdx = [];
  for (let i = 0; i < arr.length; i++) {
    if (String(arr[i] || "").trim()) nonEmptyIdx.push(i);
  }
  if (nonEmptyIdx.length >= 2) {
    const a = nonEmptyIdx[nonEmptyIdx.length - 2];
    const b = nonEmptyIdx[nonEmptyIdx.length - 1];
    if (b === a + 1) {
      arr.splice(b, 0, "");
    }
  }

  return arr.join("\n").trim().replace(/\*{2,}/g, "*");
}

function firstNameFromFullName(fullName) {
  const s = cleanText(fullName);
  if (!s) return "";
  const parts = s.split(/\s+/).filter(Boolean);
  return parts.length ? parts[0] : "";
}

const CATEGORY_TERMS = Object.freeze({
  VEHICLE: [
    "CARRO", "CARROS", "VEICULO", "VEICULOS", "VEÍCULO", "VEÍCULOS", "AUTO", "AUTOS", "AUTOMOVEL", "AUTOMOVEIS", "AUTOMÓVEL", "AUTOMÓVEIS",
    "MOTO", "MOTOS", "MOTOCICLETA", "MOTOCICLETAS", "CAMINHONETE", "CAMINHONETES", "CAMIONETE", "CAMIONETES", "PICAPE", "PICAPES",
    "PICKUP", "PICKUPS", "PICK UP", "PICK UPS", "SUV", "SUVS", "SEDAN", "SEDANS", "HATCH", "HATCHS", "HATCHBACK", "UTILITARIO", "UTILITARIOS",
    "VAN", "VANS", "CAMINHAO", "CAMINHÃO", "ONIX", "HB20", "PALIO", "GOL", "UNO", "CORSA", "CELTA", "CRUZE", "CIVIC", "COROLLA", "JETTA",
    "FOX", "SAVEIRO", "STRADA", "TORO", "RENEGADE", "COMPASS", "HR-V", "HRV", "T-CROSS", "TCROSS", "FASTBACK", "PULSE", "NIVUS",
    "ARGO", "MOBI", "TRACKER", "CRETA", "KWID", "S10", "HILUX", "SW4", "RANGER", "AMAROK", "FIAT", "CHEVROLET", "VW", "VOLKSWAGEN", "HYUNDAI", "TOYOTA", "HONDA", "JEEP"
  ],
  PROPERTY: [
    "APARTAMENTO", "APARTAMENTOS", "APTO", "APTOS", "CASA", "CASAS", "SOBRADO", "SOBRADOS", "KITNET", "KITNETS", "STUDIO", "STUDIOS", "FLAT", "FLATS",
    "TERRENO", "TERRENOS", "LOTE", "LOTES", "LOTEAMENTO", "IMOVEL", "IMOVEIS", "IMÓVEL", "IMÓVEIS", "SALA COMERCIAL", "SALAS COMERCIAIS",
    "PONTO COMERCIAL", "PONTOS COMERCIAIS", "GALPAO", "GALPOES", "GALPÃO", "GALPÕES", "CHACARA", "CHACARAS", "CHÁCARA", "CHÁCARAS", "FAZENDA", "FAZENDAS",
    "COBERTURA", "COBERTURAS", "CONDOMINIO", "CONDOMINIOS", "CONDOMÍNIO", "CONDOMÍNIOS", "ALUGO", "ALUGAR", "ALUGUEL", "LOCAÇÃO", "LOCACAO", "LOCAR", "VENDA DE IMOVEIS", "VENDA DE IMÓVEIS"
  ],
  ELECTRONICS: [
    "IPHONE", "IPHONES", "SAMSUNG", "MOTOROLA", "XIAOMI", "CELULAR", "CELULARES", "SMARTPHONE", "SMARTPHONES", "NOTEBOOK", "NOTEBOOKS", "MACBOOK", "MACBOOKS",
    "COMPUTADOR", "COMPUTADORES", "PC", "PCS", "TV", "TVS", "SMART TV", "SMART TVs", "PLAYSTATION", "PS4", "PS5", "XBOX", "NINTENDO", "VIDEOGAME", "VIDEO GAME",
    "IPAD", "IPADS", "TABLET", "TABLETS", "AIRPODS", "SMARTWATCH", "SMARTWATCHES", "APPLE WATCH", "MONITOR", "MONITORES", "IMPRESSORA", "IMPRESSORAS", "FONE BLUETOOTH", "HEADSET"
  ],
  SERVICE: [
    "SERVICO", "SERVICOS", "SERVIÇO", "SERVIÇOS", "FAÇO", "FACO", "FAZEMOS", "PRESTO", "PRESTAMOS", "OFEREÇO", "OFERECO", "OFERECEMOS",
    "REALIZO", "REALIZAMOS", "TRABALHO COM", "ATENDO", "ATENDEMOS", "CONSULTORIA", "ASSESSORIA", "INSTALACAO", "INSTALAÇÃO", "MANUTENCAO", "MANUTENÇÃO",
    "LIMPEZA", "CONSERTO", "REPARO", "PINTURA", "PEDREIRO", "PINTOR", "ELETRICISTA", "ENCANADOR", "MARCENEIRO", "GESSEIRO", "VIDRACEIRO", "JARDINAGEM",
    "FRETE", "MUDANCA", "MUDANÇA", "MONTAGEM", "DESENTUPIMENTO", "DEDETIZACAO", "DEDETIZAÇÃO", "MARIDO DE ALUGUEL"
  ],
  FOOD: [
    "BOLO", "BOLOS", "DOCINHO", "DOCINHOS", "DOCE", "DOCES", "SALGADO", "SALGADOS", "SALGADINHO", "SALGADINHOS", "MARMITA", "MARMITAS", "LANCHE", "LANCHES",
    "PIZZA", "PIZZAS", "AÇAI", "AÇAÍ", "ACAI", "HAMBURGUER", "HAMBÚRGUER", "HAMBURGUERES", "HAMBÚRGUERES", "BRIGADEIRO", "BRIGADEIROS", "CONFEITARIA", "SOBREMESA", "SOBREMESAS",
    "COMIDA", "COMIDA CASEIRA", "PORCAO", "PORÇÃO", "PORCOES", "PORÇÕES", "PRATO", "PRATOS", "TRUFA", "TRUFAS", "DELIVERY", "ALMOCO", "ALMOÇO", "JANTAR", "PÃO DE MEL", "COXINHA"
  ],
  FASHION: [
    "ROUPA", "ROUPAS", "VESTIDO", "VESTIDOS", "CAMISETA", "CAMISETAS", "CAMISA", "CAMISAS", "CALCA", "CALÇA", "CALCAS", "CALÇAS", "TENIS", "TÊNIS",
    "SAPATO", "SAPATOS", "BOLSA", "BOLSAS", "JAQUETA", "JAQUETAS", "LOOK", "LOOKS", "ACESSORIO", "ACESSÓRIO", "ACESSORIOS", "ACESSÓRIOS", "RELOGIO", "RELÓGIO",
    "RELOGIOS", "RELÓGIOS", "BONE", "BONÉ", "BONES", "BONÉS", "SHORT", "SHORTS", "SAIA", "SAIAS", "BLUSA", "BLUSAS", "CROPPED", "CROPPEDS", "MOLETOM", "BIQUINI", "BIQUÍNI"
  ],
  HOME: [
    "GELADEIRA", "GELADEIRAS", "FREEZER", "FREEZERS", "FOGAO", "FOGÃO", "FOGOES", "FOGÕES", "MICROONDAS", "MICRO ONDAS", "MICRO-ONDAS", "MAQUINA", "MÁQUINA",
    "MAQUINA DE LAVAR", "LAVA E SECA", "SOFA", "SOFÁ", "SOFAS", "SOFÁS", "ARMARIO", "ARMÁRIO", "ARMARIOS", "ARMÁRIOS", "MESA", "MESAS", "CADEIRA", "CADEIRAS",
    "GUARDA ROUPA", "GUARDA-ROUPA", "COLCHAO", "COLCHÃO", "COLCHOES", "COLCHÕES", "COOKTOP", "PAINEL", "RACK", "RAQUE", "LAVADORA", "LAVADORAS", "SECADORA", "SECADORAS",
    "CAMA", "CAMAS", "POLTRONA", "POLTRONAS", "ESTANTE", "ESTANTES", "COMODA", "CÔMODA", "ESCRIVANINHA", "APARADOR"
  ],
  BEAUTY: [
    "MANICURE", "PEDICURE", "UNHA", "UNHAS", "ALONGAMENTO", "ALONGAMENTO DE UNHAS", "CILIOS", "CÍLIOS", "SOBRANCELHA", "SOBRANCELHAS",
    "MAQUIAGEM", "MAQUIADORA", "PENTEADO", "ESCOVA", "PROGRESSIVA", "BARBEARIA", "BARBEIRO", "CABELEIREIRA", "CABELEIREIRO", "HAIR STYLIST",
    "DEPILACAO", "DEPILAÇÃO", "LASH DESIGNER", "DESIGNER DE SOBRANCELHAS", "ESTETICA", "ESTÉTICA"
  ],
  HEALTH: [
    "MASSAGEM", "MASSAGISTA", "PERSONAL", "PERSONAL TRAINER", "PILATES", "FISIOTERAPIA", "FISIOTERAPEUTA", "NUTRICIONISTA", "PSICOLOGA", "PSICÓLOGA",
    "PSICOLOGO", "PSICÓLOGO", "TERAPIA", "TERAPEUTA", "ACUPUNTURA", "QUIROPRAXIA", "CONSULTA", "ATENDIMENTO CLINICO", "ATENDIMENTO CLÍNICO", "BEM ESTAR", "BEM-ESTAR"
  ],
  EDUCATION: [
    "AULA", "AULAS", "AULA PARTICULAR", "AULAS PARTICULARES", "CURSO", "CURSOS", "MENTORIA", "TREINAMENTO", "TREINAMENTOS", "REFORCO", "REFORÇO",
    "REFORCO ESCOLAR", "REFORÇO ESCOLAR", "INGLES", "INGLÊS", "ESPANHOL", "MATEMATICA", "MATEMÁTICA", "PORTUGUES", "PORTUGUÊS", "MUSICA", "MÚSICA",
    "VIOLAO", "VIOLÃO", "INFORMATICA", "INFORMÁTICA", "AULA ONLINE", "CURSO ONLINE"
  ],
  PROFESSIONAL: [
    "ADVOGADO", "ADVOGADA", "ADVOCACIA", "CONTADOR", "CONTABIL", "CONTÁBIL", "CONTABILIDADE", "CONSULTOR", "CONSULTORA", "DESPACHANTE",
    "MARKETING", "GESTAO", "GESTÃO", "GESTOR", "GESTORA", "DESIGNER", "PROGRAMADOR", "DESENVOLVEDOR", "ARQUITETO", "ARQUITETA", "ENGENHEIRO", "ENGENHEIRA",
    "SOCIAL MEDIA", "TRAFEGO", "TRÁFEGO", "COPYWRITER", "AUDITORIA", "PLANEJAMENTO", "IMOBILIARIA", "IMOBILIÁRIA", "CORRETOR", "CORRETORA"
  ],
  EVENTS: [
    "EVENTO", "EVENTOS", "FESTA", "FESTAS", "CASAMENTO", "CASAMENTOS", "ANIVERSARIO", "ANIVERSÁRIO", "FORMATURA", "FORMATURAS", "BUFFET", "DECORACAO", "DECORAÇÃO",
    "DECORADOR", "DECORADORA", "FOTOGRAFO", "FOTÓGRAFO", "FOTOGRAFA", "FOTÓGRAFA", "DJ", "CERIMONIAL", "LEMBRANCINHA", "LEMBRANCINHAS", "BRINQUEDOS", "RECREACAO", "RECREAÇÃO"
  ],
  TOURISM: [
    "TEMPORADA", "DIARIA", "DIÁRIA", "HOSPEDAGEM", "POUSADA", "CHALE", "CHALÉ", "AIRBNB", "ALUGUEL POR TEMPORADA", "CASA DE TEMPORADA", "APTO DE TEMPORADA",
    "PASSEIO", "VIAGEM", "EXCURSAO", "EXCURSÃO", "PACOTE", "PACOTES", "RESORT", "HOTEL", "RANCHO", "CABANA"
  ],
  PETS: [
    "PET", "PETS", "CACHORRO", "CACHORROS", "CACHORRINHO", "CACHORRINHOS", "GATO", "GATOS", "FILHOTE", "FILHOTES", "BANHO E TOSA", "RACAO", "RAÇÃO",
    "VETERINARIO", "VETERINÁRIO", "VETERINARIA", "VETERINÁRIA", "ADOCAO", "ADOÇÃO", "DOG", "CAT", "COLEIRA", "CASINHA", "AREIA HIGIENICA", "AREIA HIGIÊNICA"
  ],
  BABY: [
    "BEBE", "BEBÊ", "BEBES", "BEBÊS", "INFANTIL", "CRIANCA", "CRIANÇA", "CRIANCAS", "CRIANÇAS", "BERCO", "BERÇO", "CARRINHO", "CADEIRINHA",
    "BEBE CONFORTO", "BEBÊ CONFORTO", "ENXOVAL", "BRINQUEDO", "BRINQUEDOS", "FRALDA", "FRALDAS", "MATERNIDADE", "ROUPA INFANTIL", "CALCADO INFANTIL", "CALÇADO INFANTIL"
  ],
  TOOLS: [
    "FERRAMENTA", "FERRAMENTAS", "FURADEIRA", "PARAFUSADEIRA", "SERRA", "ESMERILHADEIRA", "BETONEIRA", "ROCADEIRA", "ROÇADEIRA", "MARTELETE", "COMPRESSOR",
    "GERADOR", "ANDAIME", "ESCADA", "MATERIAL DE CONSTRUCAO", "MATERIAL DE CONSTRUÇÃO", "TINTA", "CIMENTO", "TIJOLO", "ARGAMASSA", "PISO", "REVESTIMENTO"
  ],
  COSMETICS: [
    "PERFUME", "PERFUMES", "HIDRATANTE", "HIDRATANTES", "SKINCARE", "MAQUIAGEM", "MAQUIAGENS", "BATOM", "BATONS", "CREME", "CREMES",
    "SERUM", "SÉRUM", "SHAMPOO", "CONDICIONADOR", "COLONIA", "COLÔNIA", "PRODUTO DE BELEZA", "COSMETICO", "COSMÉTICO", "COSMETICOS", "COSMÉTICOS"
  ],
  PROMOTION: [
    "PROMOCAO", "PROMOÇÃO", "PROMOCOES", "PROMOÇÕES", "OFERTA", "OFERTAS", "LIQUIDACAO", "LIQUIDAÇÃO", "QUEIMA DE ESTOQUE", "COMBO", "COMBOS",
    "DESCONTO", "DESCONTOS", "IMPERDIVEL", "IMPERDÍVEL", "OFERTA DO DIA", "PROMO DA SEMANA", "SEMANA DO CLIENTE", "BLACK FRIDAY"
  ],
  JOBS: [
    "VAGA", "VAGAS", "CONTRATACAO", "CONTRATAÇÃO", "CONTRATANDO", "SELECAO", "SELEÇÃO", "OPORTUNIDADE", "OPORTUNIDADES", "TRABALHE CONOSCO",
    "CURRICULO", "CURRÍCULO", "CANDIDATO", "CANDIDATOS", "REQUISITOS", "ENTREVISTA", "FREELANCER", "FREELA", "ESTAGIO", "ESTÁGIO", "EMPREGO"
  ],
});

const CATEGORY_SCHEMAS = Object.freeze({
  VEHICLE: {
    key: "VEHICLE",
    label: "veículo",
    minAskScore: 75,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.VEHICLE);
    },
    fields: [
      { key: "price", label: "Preço", weight: 20, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "year", label: "Ano / modelo", weight: 10, importance: "desired", allowProfileSupport: false, detect: hasVehicleYearSignal },
      { key: "km", label: "Quilometragem", weight: 16, importance: "critical", allowProfileSupport: false, detect: hasKmSignal },
      { key: "transmission", label: "Câmbio", weight: 12, importance: "critical", allowProfileSupport: false, detect: hasTransmissionSignal },
      { key: "fuel", label: "Combustível", weight: 10, importance: "critical", allowProfileSupport: false, detect: hasFuelSignal },
      { key: "version", label: "Versão / motor", weight: 6, importance: "desired", allowProfileSupport: false, detect: hasVehicleVersionSignal },
      { key: "conditionDocs", label: "Estado do veículo / documentação", weight: 16, importance: "critical", allowProfileSupport: false, detect: hasVehicleConditionOrDocsSignal },
      { key: "location", label: "Cidade / retirada / entrega", weight: 5, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "highlights", label: "Opcionais ou destaque principal", weight: 5, importance: "desired", allowProfileSupport: false, detect: hasHighlightsSignal },
    ],
  },
  PROPERTY: {
    key: "PROPERTY",
    label: "imóvel",
    minAskScore: 70,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.PROPERTY);
    },
    fields: [
      { key: "price", label: "Preço / aluguel / condomínio", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "location", label: "Bairro / região / cidade", weight: 20, importance: "critical", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "size", label: "Metragem / quartos / vagas", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasPropertySizeSignal },
      { key: "condition", label: "Estado / diferenciais", weight: 16, importance: "desired", allowProfileSupport: false, detect: hasPropertyConditionSignal },
      { key: "availability", label: "Se está pronto para mudar / visitar", weight: 8, importance: "desired", allowProfileSupport: false, detect: hasAvailabilitySignal },
      { key: "highlights", label: "Destaque principal do imóvel", weight: 8, importance: "desired", allowProfileSupport: false, detect: hasPropertyHighlightSignal },
    ],
  },
  ELECTRONICS: {
    key: "ELECTRONICS",
    label: "produto eletrônico",
    minAskScore: 68,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.ELECTRONICS);
    },
    fields: [
      { key: "price", label: "Preço", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "exactModel", label: "Modelo exato / armazenamento / configuração", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasElectronicsModelSignal },
      { key: "condition", label: "Estado de conservação", weight: 20, importance: "critical", allowProfileSupport: false, detect: hasConditionSignal },
      { key: "usage", label: "Tempo de uso / bateria / funcionamento", weight: 18, importance: "desired", allowProfileSupport: false, detect: hasBatteryOrUsageSignal },
      { key: "accessories", label: "Acessórios / caixa / nota / garantia", weight: 10, importance: "desired", allowProfileSupport: false, detect: hasAccessorySignal },
      { key: "location", label: "Entrega / retirada / cidade", weight: 6, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
    ],
  },
  SERVICE: {
    key: "SERVICE",
    label: "serviço geral",
    minAskScore: 68,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.SERVICE);
    },
    fields: [
      { key: "what", label: "O que você faz exatamente", weight: 30, importance: "critical", allowProfileSupport: false, detect: hasServiceDefinitionSignal },
      { key: "price", label: "Preço ou forma de orçamento", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasPriceOrBudgetSignal },
      { key: "location", label: "Região de atendimento", weight: 18, importance: "critical", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "hours", label: "Horário / disponibilidade", weight: 12, importance: "desired", allowProfileSupport: true, detect: hasHoursSignal },
      { key: "differential", label: "Seu principal diferencial", weight: 18, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
  FOOD: {
    key: "FOOD",
    label: "produto de alimentação",
    minAskScore: 68,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.FOOD);
    },
    fields: [
      { key: "items", label: "Sabores / produtos principais", weight: 24, importance: "critical", allowProfileSupport: true, detect: hasFoodItemsSignal },
      { key: "price", label: "Preço ou faixa de valores", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "location", label: "Entrega / retirada / região", weight: 20, importance: "critical", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "hours", label: "Horário de atendimento", weight: 10, importance: "desired", allowProfileSupport: true, detect: hasHoursSignal },
      { key: "availability", label: "Disponibilidade / encomenda / pronta entrega", weight: 10, importance: "desired", allowProfileSupport: false, detect: hasFoodAvailabilitySignal },
      { key: "differential", label: "Seu destaque principal", weight: 12, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
  FASHION: {
    key: "FASHION",
    label: "roupa ou acessório",
    minAskScore: 65,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.FASHION);
    },
    fields: [
      { key: "price", label: "Preço", weight: 26, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "size", label: "Tamanho / numeração", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasFashionSizeSignal },
      { key: "condition", label: "Estado / cor / marca", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasFashionConditionSignal },
      { key: "location", label: "Entrega / retirada / cidade", weight: 14, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "highlight", label: "Destaque principal da peça", weight: 12, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
  HOME: {
    key: "HOME",
    label: "móvel ou eletrodoméstico",
    minAskScore: 68,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.HOME);
    },
    fields: [
      { key: "price", label: "Preço", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "model", label: "Marca / modelo / tamanho / capacidade", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasHomeModelSignal },
      { key: "condition", label: "Estado de conservação", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasConditionSignal },
      { key: "voltageOrMeasure", label: "Voltagem / medidas", weight: 18, importance: "desired", allowProfileSupport: false, detect: hasVoltageOrMeasureSignal },
      { key: "location", label: "Entrega / retirada / cidade", weight: 14, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
    ],
  },
  BEAUTY: {
    key: "BEAUTY",
    label: "serviço de beleza ou estética",
    minAskScore: 68,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.BEAUTY);
    },
    fields: [
      { key: "service", label: "Procedimento / serviço oferecido", weight: 28, importance: "critical", allowProfileSupport: false, detect: hasBeautyServiceSignal },
      { key: "price", label: "Preço / pacote / promoção", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasPriceOrBudgetSignal },
      { key: "location", label: "Local de atendimento / região", weight: 18, importance: "critical", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "hours", label: "Agenda / horário disponível", weight: 14, importance: "desired", allowProfileSupport: true, detect: hasHoursSignal },
      { key: "differential", label: "Seu principal diferencial", weight: 18, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
  HEALTH: {
    key: "HEALTH",
    label: "serviço de saúde ou bem-estar",
    minAskScore: 68,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.HEALTH);
    },
    fields: [
      { key: "service", label: "Especialidade / atendimento", weight: 28, importance: "critical", allowProfileSupport: false, detect: hasHealthServiceSignal },
      { key: "price", label: "Preço / consulta / sessão", weight: 18, importance: "desired", allowProfileSupport: false, detect: hasPriceOrBudgetSignal },
      { key: "location", label: "Presencial / online / região", weight: 18, importance: "critical", allowProfileSupport: true, detect: hasOnlineOrLocationSignal },
      { key: "hours", label: "Horário / agenda", weight: 14, importance: "desired", allowProfileSupport: true, detect: hasHoursSignal },
      { key: "differential", label: "Seu diferencial / público atendido", weight: 22, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
  EDUCATION: {
    key: "EDUCATION",
    label: "curso ou aula",
    minAskScore: 68,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.EDUCATION);
    },
    fields: [
      { key: "subject", label: "Matéria / tema / curso", weight: 28, importance: "critical", allowProfileSupport: false, detect: hasEducationTopicSignal },
      { key: "modality", label: "Online / presencial / individual / turma", weight: 20, importance: "critical", allowProfileSupport: false, detect: hasOnlineOrModalitySignal },
      { key: "price", label: "Preço / mensalidade / pacote", weight: 18, importance: "desired", allowProfileSupport: false, detect: hasPriceOrBudgetSignal },
      { key: "location", label: "Cidade / região / plataforma", weight: 16, importance: "desired", allowProfileSupport: true, detect: hasOnlineOrLocationSignal },
      { key: "differential", label: "Público-alvo / diferencial", weight: 18, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
  PROFESSIONAL: {
    key: "PROFESSIONAL",
    label: "serviço profissional",
    minAskScore: 68,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.PROFESSIONAL);
    },
    fields: [
      { key: "service", label: "Serviço / especialidade", weight: 28, importance: "critical", allowProfileSupport: false, detect: hasProfessionalServiceSignal },
      { key: "price", label: "Honorários / orçamento / consulta", weight: 16, importance: "desired", allowProfileSupport: false, detect: hasPriceOrBudgetSignal },
      { key: "location", label: "Atendimento online / presencial / região", weight: 18, importance: "critical", allowProfileSupport: true, detect: hasOnlineOrLocationSignal },
      { key: "hours", label: "Horário / disponibilidade", weight: 12, importance: "desired", allowProfileSupport: true, detect: hasHoursSignal },
      { key: "differential", label: "Principal diferencial / nicho atendido", weight: 26, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
  EVENTS: {
    key: "EVENTS",
    label: "serviço para evento ou festa",
    minAskScore: 68,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.EVENTS);
    },
    fields: [
      { key: "eventType", label: "Tipo de evento / serviço", weight: 28, importance: "critical", allowProfileSupport: false, detect: hasEventTypeSignal },
      { key: "date", label: "Data / agenda / disponibilidade", weight: 14, importance: "desired", allowProfileSupport: false, detect: hasBookingOrDateSignal },
      { key: "location", label: "Cidade / região atendida", weight: 18, importance: "critical", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "price", label: "Pacote / orçamento / valor", weight: 18, importance: "desired", allowProfileSupport: false, detect: hasPriceOrBudgetSignal },
      { key: "differential", label: "Destaque do serviço", weight: 22, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
  TOURISM: {
    key: "TOURISM",
    label: "hospedagem ou turismo",
    minAskScore: 68,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.TOURISM);
    },
    fields: [
      { key: "location", label: "Cidade / destino / localização", weight: 22, importance: "critical", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "price", label: "Diária / pacote / valor", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "capacity", label: "Capacidade / quartos / comodidades", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasTourismCapacitySignal },
      { key: "availability", label: "Datas disponíveis / reserva", weight: 16, importance: "desired", allowProfileSupport: false, detect: hasBookingOrDateSignal },
      { key: "highlights", label: "Principal diferencial do local ou passeio", weight: 16, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
  PETS: {
    key: "PETS",
    label: "produto ou serviço pet",
    minAskScore: 66,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.PETS);
    },
    fields: [
      { key: "petType", label: "Animal / produto / serviço", weight: 28, importance: "critical", allowProfileSupport: false, detect: hasPetSignal },
      { key: "price", label: "Preço / taxa / valor", weight: 18, importance: "desired", allowProfileSupport: false, detect: hasPriceOrBudgetSignal },
      { key: "condition", label: "Idade / porte / estado / raça", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasPetProfileSignal },
      { key: "location", label: "Cidade / entrega / retirada", weight: 16, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "availability", label: "Disponibilidade / vacinação / agenda", weight: 14, importance: "desired", allowProfileSupport: false, detect: hasPetAvailabilitySignal },
    ],
  },
  BABY: {
    key: "BABY",
    label: "produto infantil ou bebê",
    minAskScore: 66,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.BABY);
    },
    fields: [
      { key: "item", label: "Produto principal / faixa etária", weight: 28, importance: "critical", allowProfileSupport: false, detect: hasBabyItemSignal },
      { key: "price", label: "Preço", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "condition", label: "Estado / marca / tamanho", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasConditionSignal },
      { key: "safety", label: "Idade indicada / segurança / acessórios", weight: 14, importance: "desired", allowProfileSupport: false, detect: hasSafetySignal },
      { key: "location", label: "Entrega / retirada / cidade", weight: 14, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
    ],
  },
  TOOLS: {
    key: "TOOLS",
    label: "ferramenta ou material de construção",
    minAskScore: 66,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.TOOLS);
    },
    fields: [
      { key: "item", label: "Produto / material / equipamento", weight: 28, importance: "critical", allowProfileSupport: false, detect: hasToolsItemSignal },
      { key: "price", label: "Preço / orçamento", weight: 20, importance: "critical", allowProfileSupport: false, detect: hasPriceOrBudgetSignal },
      { key: "model", label: "Marca / modelo / potência / medida", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasToolsSpecSignal },
      { key: "condition", label: "Estado / quantidade / uso", weight: 16, importance: "desired", allowProfileSupport: false, detect: hasConditionSignal },
      { key: "location", label: "Entrega / retirada / cidade", weight: 14, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
    ],
  },
  COSMETICS: {
    key: "COSMETICS",
    label: "produto de beleza ou cosmético",
    minAskScore: 66,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.COSMETICS);
    },
    fields: [
      { key: "item", label: "Produto / marca / linha", weight: 28, importance: "critical", allowProfileSupport: false, detect: hasCosmeticsItemSignal },
      { key: "price", label: "Preço / kit / promoção", weight: 20, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "use", label: "Fragrância / cor / finalidade", weight: 20, importance: "desired", allowProfileSupport: false, detect: hasCosmeticsUseSignal },
      { key: "validity", label: "Validade / lacrado / original", weight: 16, importance: "desired", allowProfileSupport: false, detect: hasValiditySignal },
      { key: "location", label: "Entrega / retirada / cidade", weight: 16, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
    ],
  },
  PROMOTION: {
    key: "PROMOTION",
    label: "promoção ou campanha de loja",
    minAskScore: 64,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.PROMOTION);
    },
    fields: [
      { key: "offer", label: "Oferta / campanha / produtos em destaque", weight: 30, importance: "critical", allowProfileSupport: false, detect: hasPromotionSignal },
      { key: "price", label: "Preço / desconto / condição", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasPriceOrBudgetSignal },
      { key: "location", label: "Loja / site / cidade", weight: 16, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "availability", label: "Validade / período da promoção", weight: 18, importance: "desired", allowProfileSupport: false, detect: hasBookingOrDateSignal },
      { key: "differential", label: "Destaque principal da oferta", weight: 14, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
  JOBS: {
    key: "JOBS",
    label: "vaga ou oportunidade",
    minAskScore: 66,
    detect(text) {
      return hasCategoryTerms(text, CATEGORY_TERMS.JOBS);
    },
    fields: [
      { key: "role", label: "Cargo / função / oportunidade", weight: 30, importance: "critical", allowProfileSupport: false, detect: hasJobRoleSignal },
      { key: "location", label: "Cidade / presencial / remoto", weight: 18, importance: "critical", allowProfileSupport: true, detect: hasOnlineOrLocationSignal },
      { key: "requirements", label: "Requisitos / experiência", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasJobRequirementSignal },
      { key: "salary", label: "Salário / diária / comissão", weight: 16, importance: "desired", allowProfileSupport: false, detect: hasPriceOrBudgetSignal },
      { key: "contact", label: "Como se candidatar / prazo", weight: 14, importance: "desired", allowProfileSupport: false, detect: hasJobApplicationSignal },
    ],
  },
  GENERIC: {
    key: "GENERIC",
    label: "produto",
    minAskScore: 60,
    detect() {
      return true;
    },
    fields: [
      { key: "price", label: "Preço", weight: 28, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "condition", label: "Estado / tempo de uso", weight: 26, importance: "critical", allowProfileSupport: false, detect: hasConditionSignal },
      { key: "location", label: "Cidade / entrega / retirada", weight: 20, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "differential", label: "Principal destaque do item", weight: 26, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
});

function countWords(text) {
  return cleanText(text).split(/\s+/).filter(Boolean).length;
}

function normalizeCategoryDetectionText(text) {
  return ` ${upper(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()} `;
}

function hasCategoryTerms(text, terms) {
  const normalized = normalizeCategoryDetectionText(text);
  return ensureArray(terms).some((term) => {
    const token = cleanText(term)
      .toUpperCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();

    if (!token) return false;
    return normalized.includes(` ${token} `);
  });
}

function scoreCategoryTermHits(text, terms) {
  const normalized = normalizeCategoryDetectionText(text);
  let score = 0;

  for (const term of ensureArray(terms)) {
    const token = cleanText(term)
      .toUpperCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();

    if (!token) continue;
    if (normalized.includes(` ${token} `)) {
      score += token.length >= 9 ? 8 : token.length >= 6 ? 7 : 5;
    }
  }

  return score;
}

function hasPriceSignal(text) {
  const s = upper(text);
  return /R\$\s*\d/.test(s) || /\b\d+\s*(MIL|REAIS|R\$)\b/.test(s);
}

function hasKmSignal(text) {
  return /\b\d{1,3}(\.\d{3})*\s*KM\b/i.test(text) || /\b\d{1,3}\s*MIL\s*KM\b/i.test(text);
}

function hasVehicleYearSignal(text) {
  return /\b(19|20)\d{2}\b/.test(text);
}

function hasVehicleVersionSignal(text) {
  const s = upper(text);
  return /\b(LTZ|LT|EX|EXL|XLT|TITANIUM|TREND|SE|SEL|GL|GLS|GLX|SPORT|TURBO|1\.0|1\.6|2\.0|V6|V8)\b/.test(s);
}

function hasTransmissionSignal(text) {
  const s = upper(text);
  return /\b(MANUAL|AUTOM[AÁ]TICO|AUTOMATICO|CVT)\b/.test(s);
}

function hasFuelSignal(text) {
  const s = upper(text);
  return /\b(FLEX|GASOLINA|DIESEL|ETANOL|H[ÍI]BRIDO|HIBRIDO|EL[ÉE]TRICO|ELETRICO|GNV)\b/.test(s);
}

function hasConditionSignal(text) {
  const s = upper(text);
  return /\b(CONSERVADO|CONSERVADA|NOVO|NOVA|SEMINOVO|SEMINOVA|REVISADO|REVISADA|PERFEITO ESTADO|ESTADO DE NOVO|USADO|USADA|FUNCIONANDO|FUNCIONA|BOAS? CONDI[CÇ][ÕO]ES|BOM ESTADO|PINTURA|POUCO USO|CARRO DE GARAGEM|GARAGEM|IMPEC[ÁA]VEL|ZERADO|LACRADO|SEM USO)\b/.test(s);
}

function hasVehicleConditionOrDocsSignal(text) {
  const s = upper(text);
  return hasConditionSignal(s) || /\b(DOCUMENTA[CÇ][AÃ]O|DOCS?|DOC OK|DOCUMENTA[CÇ][AÃ]O OK|SEM D[ÉE]BITOS|LICENCIADO|IPVA PAGO)\b/.test(s);
}

function hasHighlightsSignal(text) {
  const s = upper(text);
  return /\b(AR[- ]CONDICIONADO|MULTIM[ÍI]DIA|COURO|AIRBAG|ABS|RODA|TETO|CAMERA DE R[ÉE]|C[ÂA]MERA DE R[ÉE]|COMPLETO|OPCIONAIS?)\b/.test(s);
}

function hasLocationSignal(text) {
  const s = upper(text);
  return /\b(ENTREGO|RETIRAR|RETIRADA|ENTREGA|BAIRRO|CIDADE|REGI[AÃ]O|ATENDO|ATENDIMENTO|ONLINE|DOMIC[ÍI]LIO|DOMICILIO|FRETE|PRESENCIAL|REMOTO)\b/.test(s);
}

function hasOnlineOrLocationSignal(text) {
  const s = upper(text);
  return hasLocationSignal(s) || /\b(ONLINE|PRESENCIAL|REMOTO|H[ÍI]BRIDO|PLATAFORMA|ZOOM|GOOGLE MEET|WHATSAPP)\b/.test(s);
}

function hasOnlineOrModalitySignal(text) {
  const s = upper(text);
  return /\b(ONLINE|PRESENCIAL|REMOTO|INDIVIDUAL|EM GRUPO|TURMA|TURMAS|AULA EXPERIMENTAL|MENTORIA|PLATAFORMA)\b/.test(s);
}

function hasPropertySizeSignal(text) {
  const s = upper(text);
  return /\b(M2|M²|QUARTO|QUARTOS|SU[ÍI]TE|SUITE|VAGA|VAGAS|BANHEIRO|BANHEIROS)\b/.test(s);
}

function hasAvailabilitySignal(text) {
  const s = upper(text);
  return /\b(PRONTO|DISPON[ÍI]VEL|VISITA|VISITAR|MUDAR|IMEDIATO|IMEDIATA)\b/.test(s);
}

function hasPropertyConditionSignal(text) {
  const s = upper(text);
  return hasConditionSignal(s) || /\b(REFORMADO|MOBILIADO|PLANEJADO|VARANDA|SU[ÍI]TE|CONDOM[ÍI]NIO|LAZER)\b/.test(s);
}

function hasPropertyHighlightSignal(text) {
  const s = upper(text);
  return /\b(VISTA|VARANDA|SU[ÍI]TE|CONDOM[ÍI]NIO|LAZER|CHURRASQUEIRA|PISCINA|PORTARIA|PR[ÓO]XIMO|LOCALIZA[CÇ][AÃ]O)\b/.test(s);
}

function hasElectronicsModelSignal(text) {
  const s = upper(text);
  return /\b(64GB|128GB|256GB|512GB|I5|I7|I9|M1|M2|M3|POLEGADAS?|INCH|"|GB|SSD|RAM)\b/.test(s);
}

function hasAccessorySignal(text) {
  const s = upper(text);
  return /\b(CAIXA|CARREGADOR|NOTA FISCAL|GARANTIA|CABO|CAPA|PEL[ÍI]CULA|FONE|ACESS[ÓO]RIOS?)\b/.test(s);
}

function hasBatteryOrUsageSignal(text) {
  const s = upper(text);
  return /\b(BATERIA|SA[ÚU]DE DA BATERIA|USO|ANO DE USO|FUNCIONANDO|SEM MARCAS|SEM DETALHES)\b/.test(s);
}

function hasServiceDefinitionSignal(text) {
  const s = upper(text);
  return countWords(s) >= 3;
}

function hasPriceOrBudgetSignal(text) {
  const s = upper(text);
  return hasPriceSignal(s) || /\b(OR[CÇ]AMENTO|A COMBINAR|CONSULTAR|SOB CONSULTA|PACOTE|MENSALIDADE|COMISS[ÃA]O|DI[ÁA]RIA|TAXA)\b/.test(s);
}

function hasHoursSignal(text) {
  const s = upper(text);
  return /\b(SEG|SEGUNDA|TER|QUA|QUI|SEX|SAB|SÁB|DOM|HOR[ÁA]RIO|HORARIO|AGENDA|DISPONIBILIDADE|\d{1,2}H)\b/.test(s);
}

function hasDifferentialSignal(text) {
  const s = upper(text);
  return /\b(EXPERI[ÊE]NCIA|QUALIDADE|R[ÁA]PIDO|RAPIDO|CAPRICHO|GARANTIA|ATENDIMENTO|PERSONALIZADO|ARTESANAL|CASEIRO|ORIGINAL|ÚNICO DONO|UNICO DONO|EXCLUSIVO|PREMIUM|ALTO PADR[ÃA]O)\b/.test(s);
}

function hasFoodItemsSignal(text) {
  const s = upper(text);
  return /\b(SABOR|SABORES|BRIGADEIRO|BOLO|POTE|PIZZA|HAMB[ÚU]RGUER|COMBO|KIT|ENCOMENDA|MARMITA|LANCHE|POR[CÇ][ÃA]O)\b/.test(s);
}

function hasFoodAvailabilitySignal(text) {
  const s = upper(text);
  return /\b(ENCOMENDA|PRONTA ENTREGA|DISPON[ÍI]VEL HOJE|HOJE|SOB ENCOMENDA|RETIRADA HOJE)\b/.test(s);
}

function hasFashionSizeSignal(text) {
  const s = upper(text);
  return /\b(PP|P|M|G|GG|XG|36|37|38|39|40|41|42|43|44|NUMERA[CÇ][AÃ]O|TAMANHO)\b/.test(s);
}

function hasFashionConditionSignal(text) {
  const s = upper(text);
  return hasConditionSignal(s) || /\b(COR|MARCA|SEM USO|USADO UMA VEZ|ORIGINAL)\b/.test(s);
}

function hasHomeModelSignal(text) {
  const s = upper(text);
  return /\b(LITROS|L|KG|BRASTEMP|ELECTROLUX|CONSUL|SAMSUNG|LG|PHILCO|MIDEA|6 BOCAS|4 BOCAS|PORTAS?)\b/.test(s);
}

function hasVoltageOrMeasureSignal(text) {
  const s = upper(text);
  return /\b(110V|127V|220V|VOLTS?|CM|METROS?|LARGURA|ALTURA|PROFUNDIDADE|MEDIDAS?)\b/.test(s);
}

function hasBeautyServiceSignal(text) {
  const s = upper(text);
  return hasCategoryTerms(s, CATEGORY_TERMS.BEAUTY) || /\b(PACOTE DE UNHAS|DESIGN DE SOBRANCELHAS|MECHAS|ESCOVA PROGRESSIVA)\b/.test(s);
}

function hasHealthServiceSignal(text) {
  const s = upper(text);
  return hasCategoryTerms(s, CATEGORY_TERMS.HEALTH) || /\b(SESS[ÃA]O|CONSULTA|AVALIA[CÇ][AÃ]O|ATENDIMENTO TERAP[ÊE]UTICO)\b/.test(s);
}

function hasEducationTopicSignal(text) {
  const s = upper(text);
  return hasCategoryTerms(s, CATEGORY_TERMS.EDUCATION) || /\b(AULA DE|CURSO DE|REFOR[ÇC]O|MAT[ÉE]RIA|CONTE[ÚU]DO)\b/.test(s);
}

function hasProfessionalServiceSignal(text) {
  const s = upper(text);
  return hasCategoryTerms(s, CATEGORY_TERMS.PROFESSIONAL) || /\b(CONSULTORIA|ASSESSORIA|PLANEJAMENTO|PROJETO|REGULARIZA[CÇ][AÃ]O|DECLARA[CÇ][AÃ]O)\b/.test(s);
}

function hasEventTypeSignal(text) {
  const s = upper(text);
  return hasCategoryTerms(s, CATEGORY_TERMS.EVENTS) || /\b(EVENTO|FESTA|CASAMENTO|ANIVERS[ÁA]RIO|FORMATURA|15 ANOS)\b/.test(s);
}

function hasBookingOrDateSignal(text) {
  const s = upper(text);
  return /\b(HOJE|AMANH[ÃA]|FINAL DE SEMANA|SEMANA|M[EÊ]S|RESERVA|AGENDAMENTO|AGENDA|DATA|DATAS|\d{1,2}\/\d{1,2}(\/\d{2,4})?)\b/.test(s);
}

function hasTourismCapacitySignal(text) {
  const s = upper(text);
  return /\b(H[ÓO]SPEDES?|PESSOAS|QUARTOS?|SU[ÍI]TES?|PISCINA|CHURRASQUEIRA|WI[- ]?FI|CAF[EÉ] DA MANH[ÃA]|DI[ÁA]RIA)\b/.test(s);
}

function hasPetSignal(text) {
  const s = upper(text);
  return hasCategoryTerms(s, CATEGORY_TERMS.PETS);
}

function hasPetProfileSignal(text) {
  const s = upper(text);
  return /\b(PORTE|RA[CÇ]A|VACINADO|VACINADA|VERMIFUGADO|IDADE|MESES?|ANOS?|BANHO E TOSA)\b/.test(s) || hasConditionSignal(s);
}

function hasPetAvailabilitySignal(text) {
  const s = upper(text);
  return /\b(DISPON[ÍI]VEL|PRONTA ENTREGA|AGENDA|VACINADO|VACINADA|RETIRADA|ENTREGA)\b/.test(s);
}

function hasBabyItemSignal(text) {
  const s = upper(text);
  return hasCategoryTerms(s, CATEGORY_TERMS.BABY) || /\b(FAIXA ET[ÁA]RIA|RN|0 A 3|0 A 6|BEB[ÊE])\b/.test(s);
}

function hasSafetySignal(text) {
  const s = upper(text);
  return /\b(SELO|SEGURAN[ÇC]A|CINTO|TRAVA|IDADE INDICADA|CERTIFICADO|INMETRO)\b/.test(s);
}

function hasToolsItemSignal(text) {
  const s = upper(text);
  return hasCategoryTerms(s, CATEGORY_TERMS.TOOLS) || /\b(FERRAMENTA|MATERIAL DE CONSTRU[CÇ][AÃ]O|EQUIPAMENTO)\b/.test(s);
}

function hasToolsSpecSignal(text) {
  const s = upper(text);
  return /\b(MARCA|MODELO|POT[ÊE]NCIA|VOLTAGEM|MEDIDAS?|CAPACIDADE|LITROS|WATTS?)\b/.test(s);
}

function hasCosmeticsItemSignal(text) {
  const s = upper(text);
  return hasCategoryTerms(s, CATEGORY_TERMS.COSMETICS) || /\b(LINHA|KIT|FRAGR[ÂA]NCIA|TONALIDADE)\b/.test(s);
}

function hasCosmeticsUseSignal(text) {
  const s = upper(text);
  return /\b(FRAGR[ÂA]NCIA|CHEIRO|COR|PELE|CABELO|ROSTO|HIDRATA[CÇ][AÃ]O|TRATAMENTO)\b/.test(s);
}

function hasValiditySignal(text) {
  const s = upper(text);
  return /\b(VALIDADE|LACRADO|LACRADA|ORIGINAL|SELO)\b/.test(s);
}

function hasPromotionSignal(text) {
  const s = upper(text);
  return hasCategoryTerms(s, CATEGORY_TERMS.PROMOTION) || /\b(DESCONTO|QUEIMA DE ESTOQUE|OFERTA DO DIA|POR TEMPO LIMITADO|CUPOM|LEVE \d+ PAGUE \d+)\b/.test(s);
}

function hasJobRoleSignal(text) {
  const s = upper(text);
  return hasCategoryTerms(s, CATEGORY_TERMS.JOBS) || /\b(CARGO|FUN[CÇ][AÃ]O|OPORTUNIDADE|VAGA PARA|CONTRATANDO)\b/.test(s);
}

function hasJobRequirementSignal(text) {
  const s = upper(text);
  return /\b(EXPERI[ÊE]NCIA|REQUISITOS?|CURR[ÍI]CULO|CNH|DISPONIBILIDADE|CLT|COMISS[ÃA]O|REMOTO|PRESENCIAL)\b/.test(s);
}

function hasJobApplicationSignal(text) {
  const s = upper(text);
  return /\b(ENVIAR CURR[ÍI]CULO|CHAMAR NO WHATSAPP|CANDIDATAR|PRAZO|ENTREVISTA|SELE[CÇ][AÃ]O)\b/.test(s);
}

const CATEGORY_HINTS = Object.freeze({
  VEHICLE: [...CATEGORY_TERMS.VEHICLE, "0KM", "KM", "AUTOMATICO", "AUTOMÁTICO", "MANUAL", "FLEX", "DIESEL"],
  PROPERTY: [...CATEGORY_TERMS.PROPERTY, "ALTO PADRAO", "ALTO PADRÃO", "METRAGEM", "SUITE", "SUÍTE", "QUARTOS", "VAGAS"],
  ELECTRONICS: [...CATEGORY_TERMS.ELECTRONICS, "GB", "SSD", "RAM", "POLEGADAS", "BATERIA"],
  SERVICE: [...CATEGORY_TERMS.SERVICE, "ORCAMENTO", "ORÇAMENTO", "ATENDIMENTO", "DISPONIBILIDADE", "AGENDAMENTO"],
  FOOD: [...CATEGORY_TERMS.FOOD, "CARDAPIO", "CARDÁPIO", "ENCOMENDA", "PRONTA ENTREGA", "SABORES"],
  FASHION: [...CATEGORY_TERMS.FASHION, "NUMERACAO", "NUMERAÇÃO", "TAMANHO", "MARCA", "COR"],
  HOME: [...CATEGORY_TERMS.HOME, "VOLTAGEM", "CAPACIDADE", "MEDIDAS", "LITROS"],
  BEAUTY: [...CATEGORY_TERMS.BEAUTY, "AGENDA", "HORARIO", "HORÁRIO", "ATENDIMENTO", "ESCOVA", "PROCEDIMENTO"],
  HEALTH: [...CATEGORY_TERMS.HEALTH, "SESSAO", "SESSÃO", "CONSULTA", "ONLINE", "PRESENCIAL", "BEM ESTAR", "BEM-ESTAR"],
  EDUCATION: [...CATEGORY_TERMS.EDUCATION, "ONLINE", "PRESENCIAL", "TURMA", "AULA EXPERIMENTAL", "CERTIFICADO"],
  PROFESSIONAL: [...CATEGORY_TERMS.PROFESSIONAL, "CONSULTORIA", "ASSESSORIA", "ATENDIMENTO ONLINE", "ATENDIMENTO PRESENCIAL"],
  EVENTS: [...CATEGORY_TERMS.EVENTS, "PACOTE", "ORCAMENTO", "ORÇAMENTO", "AGENDA", "DECORAÇÃO", "DECORACAO"],
  TOURISM: [...CATEGORY_TERMS.TOURISM, "RESERVA", "HOSPEDAGEM", "COMODIDADES", "DIARIA", "DIÁRIA", "FINAL DE SEMANA"],
  PETS: [...CATEGORY_TERMS.PETS, "VACINA", "VACINADO", "BANHO", "TOSA", "PORTE", "RACAO", "RAÇÃO"],
  BABY: [...CATEGORY_TERMS.BABY, "IDADE", "FAIXA ETARIA", "FAIXA ETÁRIA", "TAMANHO", "SEGURANCA", "SEGURANÇA"],
  TOOLS: [...CATEGORY_TERMS.TOOLS, "POTENCIA", "POTÊNCIA", "MEDIDAS", "LITROS", "USADO", "SEMINOVO"],
  COSMETICS: [...CATEGORY_TERMS.COSMETICS, "LACRADO", "ORIGINAL", "VALIDADE", "KIT", "FRAGRANCIA", "FRAGRÂNCIA"],
  PROMOTION: [...CATEGORY_TERMS.PROMOTION, "POR TEMPO LIMITADO", "ATE", "ATÉ", "%", "CUPOM"],
  JOBS: [...CATEGORY_TERMS.JOBS, "REMOTO", "PRESENCIAL", "CURRICULO", "CURRÍCULO", "CLT", "COMISSAO", "COMISSÃO"],
});

const CATEGORY_MACRO_GROUPS = Object.freeze({
  PROPERTY: "PROPERTY",
  VEHICLE: "GOODS",
  ELECTRONICS: "GOODS",
  SERVICE: "SERVICE",
  FOOD: "FOOD",
  FASHION: "GOODS",
  HOME: "GOODS",
  BEAUTY: "SERVICE",
  HEALTH: "SERVICE",
  EDUCATION: "SERVICE",
  PROFESSIONAL: "SERVICE",
  EVENTS: "SERVICE",
  TOURISM: "PROPERTY",
  PETS: "GOODS",
  BABY: "GOODS",
  TOOLS: "GOODS",
  COSMETICS: "GOODS",
  PROMOTION: "PROMOTION",
  JOBS: "JOBS",
  GENERIC: "GENERIC",
});

const CATEGORY_AMBIGUITY_PAIRS = Object.freeze({
  "BEAUTY|EDUCATION": {
    question: "Quero entender melhor seu anúncio antes de continuar. Ele está mais para:",
    options: [
      { key: "EDUCATION", label: "curso ou aula" },
      { key: "BEAUTY", label: "serviço de beleza ou estética" },
    ],
  },
  "PROPERTY|TOURISM": {
    question: "Quero entender melhor seu anúncio antes de continuar. Ele está mais para:",
    options: [
      { key: "PROPERTY", label: "imóvel para venda ou locação comum" },
      { key: "TOURISM", label: "hospedagem ou aluguel por temporada" },
    ],
  },
  "FOOD|EVENTS": {
    question: "Quero entender melhor seu anúncio antes de continuar. Ele está mais para:",
    options: [
      { key: "FOOD", label: "venda de alimentos" },
      { key: "EVENTS", label: "serviço para evento ou festa" },
    ],
  },
  "SERVICE|PROFESSIONAL": {
    question: "Quero entender melhor seu anúncio antes de continuar. Ele está mais para:",
    options: [
      { key: "SERVICE", label: "serviço geral" },
      { key: "PROFESSIONAL", label: "serviço profissional especializado" },
    ],
  },
  "COSMETICS|BEAUTY": {
    question: "Quero entender melhor seu anúncio antes de continuar. Ele está mais para:",
    options: [
      { key: "COSMETICS", label: "produto de beleza ou cosmético" },
      { key: "BEAUTY", label: "serviço de beleza ou estética" },
    ],
  },
  "FASHION|BABY": {
    question: "Quero entender melhor seu anúncio antes de continuar. Ele está mais para:",
    options: [
      { key: "FASHION", label: "roupa ou acessório em geral" },
      { key: "BABY", label: "produto infantil ou bebê" },
    ],
  },
  "PROMOTION|FOOD": {
    question: "Quero entender melhor seu anúncio antes de continuar. Ele está mais para:",
    options: [
      { key: "PROMOTION", label: "promoção da loja ou campanha" },
      { key: "FOOD", label: "venda de alimento específico" },
    ],
  },
});

const CATEGORY_ANTI_HINTS = Object.freeze({
  SERVICE: [
    ...CATEGORY_TERMS.BEAUTY,
    ...CATEGORY_TERMS.HEALTH,
    ...CATEGORY_TERMS.EDUCATION,
    ...CATEGORY_TERMS.PROFESSIONAL,
    ...CATEGORY_TERMS.EVENTS,
    ...CATEGORY_TERMS.TOURISM,
  ],
  FASHION: [...CATEGORY_TERMS.BABY],
});

function scoreKeywordHits(text, hints) {
  return scoreCategoryTermHits(text, hints);
}

function getCategoryMacroGroup(categoryKey) {
  return CATEGORY_MACRO_GROUPS[String(categoryKey || "").trim().toUpperCase()] || "GENERIC";
}

function getAmbiguityPairConfig(primaryKey, runnerUpKey) {
  const a = String(primaryKey || "").trim().toUpperCase();
  const b = String(runnerUpKey || "").trim().toUpperCase();
  if (!a || !b || a === b) return null;
  return CATEGORY_AMBIGUITY_PAIRS[`${a}|${b}`] || CATEGORY_AMBIGUITY_PAIRS[`${b}|${a}`] || null;
}

function hasStrongCategoryIndicator(text, schemaKey) {
  const key = String(schemaKey || "").trim().toUpperCase();
  const schema = CATEGORY_SCHEMAS[key];
  if (!schema || key === "GENERIC") return false;

  if (schema.detect(text)) return true;

  const categoryTermsScore = scoreCategoryTermHits(text, CATEGORY_TERMS[key]);
  if (categoryTermsScore >= 12) return true;

  const hintScore = scoreKeywordHits(text, CATEGORY_HINTS[key]);
  return hintScore >= 16;
}

function scoreCategorySchema(text, schema) {
  if (!schema || schema.key === "GENERIC") return 0;

  let score = 0;
  if (schema.detect(text)) score += 40;
  score += scoreKeywordHits(text, CATEGORY_HINTS[schema.key]);

  if (CATEGORY_ANTI_HINTS[schema.key]) {
    score -= Math.min(18, Math.floor(scoreCategoryTermHits(text, CATEGORY_ANTI_HINTS[schema.key]) / 2));
  }

  const completeness = computeCategoryCompleteness({ schema, text, bizProfile: null });
  score += Math.min(36, completeness.presentWeight);

  const words = countWords(text);
  if (schema.key === "SERVICE" && words <= 2) score -= 10;

  return score;
}

function getCategoryCandidates(text) {
  const candidates = Object.values(CATEGORY_SCHEMAS)
    .filter((schema) => schema.key !== "GENERIC")
    .map((schema) => ({
      schema,
      key: schema.key,
      label: schema.label,
      score: scoreCategorySchema(text, schema),
      strong: hasStrongCategoryIndicator(text, schema.key),
      macroGroup: getCategoryMacroGroup(schema.key),
    }))
    .sort((a, b) => b.score - a.score);

  return candidates;
}

const AD_INTENTS = Object.freeze({
  SPECIFIC_ITEM: "SPECIFIC_ITEM",
  SERVICE_OFFER: "SERVICE_OFFER",
  INSTITUTIONAL: "INSTITUTIONAL",
  CATALOG: "CATALOG",
  PROMOTION: "PROMOTION",
  OPPORTUNITY: "OPPORTUNITY",
});

const CATEGORY_ALLOWED_INTENTS = Object.freeze({
  PROPERTY: [AD_INTENTS.SPECIFIC_ITEM, AD_INTENTS.INSTITUTIONAL, AD_INTENTS.CATALOG],
  VEHICLE: [AD_INTENTS.SPECIFIC_ITEM, AD_INTENTS.CATALOG, AD_INTENTS.PROMOTION],
  ELECTRONICS: [AD_INTENTS.SPECIFIC_ITEM, AD_INTENTS.CATALOG, AD_INTENTS.PROMOTION],
  SERVICE: [AD_INTENTS.SERVICE_OFFER, AD_INTENTS.INSTITUTIONAL],
  FOOD: [AD_INTENTS.SPECIFIC_ITEM, AD_INTENTS.CATALOG, AD_INTENTS.PROMOTION],
  FASHION: [AD_INTENTS.SPECIFIC_ITEM, AD_INTENTS.CATALOG, AD_INTENTS.PROMOTION],
  HOME: [AD_INTENTS.SPECIFIC_ITEM, AD_INTENTS.CATALOG, AD_INTENTS.PROMOTION],
  BEAUTY: [AD_INTENTS.SERVICE_OFFER, AD_INTENTS.PROMOTION],
  HEALTH: [AD_INTENTS.SERVICE_OFFER],
  EDUCATION: [AD_INTENTS.SERVICE_OFFER, AD_INTENTS.INSTITUTIONAL],
  PROFESSIONAL: [AD_INTENTS.SERVICE_OFFER, AD_INTENTS.INSTITUTIONAL],
  EVENTS: [AD_INTENTS.SERVICE_OFFER, AD_INTENTS.INSTITUTIONAL],
  TOURISM: [AD_INTENTS.SPECIFIC_ITEM, AD_INTENTS.CATALOG, AD_INTENTS.INSTITUTIONAL],
  PETS: [AD_INTENTS.SPECIFIC_ITEM, AD_INTENTS.SERVICE_OFFER, AD_INTENTS.CATALOG],
  BABY: [AD_INTENTS.SPECIFIC_ITEM, AD_INTENTS.CATALOG, AD_INTENTS.PROMOTION],
  TOOLS: [AD_INTENTS.SPECIFIC_ITEM, AD_INTENTS.CATALOG, AD_INTENTS.PROMOTION],
  COSMETICS: [AD_INTENTS.SPECIFIC_ITEM, AD_INTENTS.CATALOG, AD_INTENTS.PROMOTION],
  PROMOTION: [AD_INTENTS.PROMOTION],
  JOBS: [AD_INTENTS.OPPORTUNITY],
  GENERIC: [AD_INTENTS.SPECIFIC_ITEM, AD_INTENTS.SERVICE_OFFER, AD_INTENTS.CATALOG, AD_INTENTS.PROMOTION, AD_INTENTS.INSTITUTIONAL],
});

function getAllowedIntentsForCategory(schemaKey) {
  return CATEGORY_ALLOWED_INTENTS[String(schemaKey || "").trim().toUpperCase()] || CATEGORY_ALLOWED_INTENTS.GENERIC;
}

function scoreIntentKeywordHits(text, terms) {
  return scoreCategoryTermHits(text, terms);
}

function scorePromotionIntent(text) {
  const s = upper(text);
  let score = scoreIntentKeywordHits(text, CATEGORY_TERMS.PROMOTION);
  if (/\b(PROMO|PROMOCAO|PROMOÇÃO|OFERTA|DESCONTO|LIQUIDACAO|LIQUIDAÇÃO|COMBO)\b/.test(s)) score += 18;
  if (/%/.test(s)) score += 6;
  if (/\b(ATE|ATÉ)\s+\d+%/.test(s)) score += 8;
  return score;
}

function scoreCatalogIntent(text, schemaKey) {
  const s = upper(text);
  let score = 0;
  if (/\b(CATALOGO|CATÁLOGO|LINHA|COLECAO|COLEÇÃO|VARIEDADE|VARIEDADES|OPCOES|OPÇÕES|MODELOS|DIVERSOS|VARIOS|VÁRIOS|SELECAO|SELEÇÃO)\b/.test(s)) score += 18;
  if (/\b(TENHO|TEMOS|TRABALHO COM|TRABALHAMOS COM|OPCOES|OPÇÕES|ITENS|PRODUTOS|SERVICOS|SERVIÇOS)\b/.test(s)) score += 12;
  if (schemaKey === "PROPERTY" && /\b(IMOVEIS|IMÓVEIS|CASAS|APARTAMENTOS|TERRENOS|LOTES)\b/.test(s)) score += 12;
  return score;
}

function scoreInstitutionalIntent(text, schemaKey) {
  const s = upper(text);
  let score = 0;
  if (/\b(EMPRESA|SOMOS|ATENDEMOS|ATENDO|ATUO|ATUAMOS|ESPECIALISTA|ESPECIALIZADO|ESPECIALIZADA|NOSSO|NOSSA|TRABALHO COM|TRABALHAMOS COM|AJUDO|AJUDAMOS|OFERECO|OFEREÇO|OFERECEMOS)\b/.test(s)) score += 18;
  if (schemaKey === "PROPERTY" && /\b(CORRETOR|CORRETORA|IMOBILIARIA|IMOBILIÁRIA|ALTO PADRAO|ALTO PADRÃO|OPORTUNIDADES)\b/.test(s)) score += 18;
  if (schemaKey === "PROFESSIONAL" && /\b(CONSULTORIA|ASSESSORIA|ESCRITORIO|ESCRITÓRIO)\b/.test(s)) score += 12;
  return score;
}

function scoreServiceOfferIntent(text, schemaKey) {
  const s = upper(text);
  let score = 0;
  if (/\b(FAÇO|FACO|PRESTO|OFERECO|OFEREÇO|REALIZO|ATENDO|AGENDA|ATENDIMENTO|SERVICO|SERVIÇO|CONSULTA|SESSAO|SESSÃO|AULA|CURSO)\b/.test(s)) score += 16;
  if (["SERVICE","BEAUTY","HEALTH","EDUCATION","PROFESSIONAL","EVENTS"].includes(schemaKey)) score += 10;
  return score;
}

function scoreSpecificItemIntent(text, schema) {
  const s = upper(text);
  let score = 8;
  if (hasPriceSignal(text)) score += 10;
  if (hasConditionSignal(text)) score += 6;
  if (schema && computeCategoryCompleteness({ schema, text, bizProfile: null }).presentWeight >= 24) score += 10;
  if (/\b(ESTE|ESSA|ESSAS|ESSA|UNICO|ÚNICO|UNICA|ÚNICA|MODELO|ANO|KM|METROS|M2|QUARTOS|VAGAS|LITROS|GB|TAMANHO)\b/.test(s)) score += 8;
  return score;
}

function scoreOpportunityIntent(text) {
  return scoreIntentKeywordHits(text, CATEGORY_TERMS.JOBS) + (upper(text).match(/\b(VAGA|CONTRATANDO|OPORTUNIDADE|CURRICULO|CURRÍCULO)\b/) ? 18 : 0);
}

function getIntentOptionLabel(schemaKey, intentKey) {
  const schemaLabel = CATEGORY_SCHEMAS[String(schemaKey || "").trim().toUpperCase()]?.label || "anúncio";
  const intent = String(intentKey || "").trim().toUpperCase();
  if (schemaKey === "PROPERTY" && intent === AD_INTENTS.SPECIFIC_ITEM) return "anunciar um imóvel específico";
  if (schemaKey === "PROPERTY" && intent === AD_INTENTS.INSTITUTIONAL) return "divulgar meu trabalho/opções de imóveis";
  if (schemaKey === "PROPERTY" && intent === AD_INTENTS.CATALOG) return "mostrar várias opções de imóveis";
  if (intent === AD_INTENTS.SERVICE_OFFER) return `divulgar meu ${schemaLabel}`;
  if (intent === AD_INTENTS.CATALOG) return "mostrar várias opções / catálogo";
  if (intent === AD_INTENTS.PROMOTION) return "divulgar uma promoção / oferta";
  if (intent === AD_INTENTS.INSTITUTIONAL) return "fazer um anúncio institucional";
  if (intent === AD_INTENTS.OPPORTUNITY) return "divulgar uma vaga / oportunidade";
  return "anunciar um item específico";
}

function getIntentInstructionLabel(intentKey) {
  const intent = String(intentKey || "").trim().toUpperCase();
  if (intent === AD_INTENTS.SERVICE_OFFER) return "serviço oferecido";
  if (intent === AD_INTENTS.CATALOG) return "catálogo / várias opções";
  if (intent === AD_INTENTS.PROMOTION) return "promoção / oferta";
  if (intent === AD_INTENTS.INSTITUTIONAL) return "institucional";
  if (intent === AD_INTENTS.OPPORTUNITY) return "vaga / oportunidade";
  return "item específico";
}

function buildIntentDisambiguationPrompt({ schema, primaryIntentKey, runnerUpIntentKey }) {
  const schemaKey = String(schema?.key || "GENERIC").trim().toUpperCase();
  return [
    `Antes de continuar, quero entender melhor *como* você quer anunciar esse ${schema?.label || "item"}:`,
    "",
    `1️⃣ ${getIntentOptionLabel(schemaKey, primaryIntentKey)}`,
    `2️⃣ ${getIntentOptionLabel(schemaKey, runnerUpIntentKey)}`,
    "3️⃣ seguir com uma versão mais genérica",
    "",
    "Responda só com *1*, *2* ou *3*. ✅",
  ].join("\n");
}

function detectAdIntentDecision({ text, schema }) {
  const schemaKey = String(schema?.key || "GENERIC").trim().toUpperCase();
  const allowed = getAllowedIntentsForCategory(schemaKey);
  if (!allowed.length) {
    return { intentKey: AD_INTENTS.SPECIFIC_ITEM, runnerUpIntentKey: "", confidence: "medium", shouldAskDisambiguation: false, prompt: "" };
  }
  if (allowed.length === 1) {
    return { intentKey: allowed[0], runnerUpIntentKey: "", confidence: "high", shouldAskDisambiguation: false, prompt: "" };
  }

  const scores = [];
  for (const intentKey of allowed) {
    let score = 0;
    if (intentKey === AD_INTENTS.PROMOTION) score = scorePromotionIntent(text);
    else if (intentKey === AD_INTENTS.CATALOG) score = scoreCatalogIntent(text, schemaKey);
    else if (intentKey === AD_INTENTS.INSTITUTIONAL) score = scoreInstitutionalIntent(text, schemaKey);
    else if (intentKey === AD_INTENTS.SERVICE_OFFER) score = scoreServiceOfferIntent(text, schemaKey);
    else if (intentKey === AD_INTENTS.OPPORTUNITY) score = scoreOpportunityIntent(text);
    else score = scoreSpecificItemIntent(text, schema);
    scores.push({ intentKey, score });
  }
  scores.sort((a,b)=>b.score-a.score);
  const primary = scores[0] || { intentKey: allowed[0], score: 0 };
  const runnerUp = scores[1] || null;
  const gap = primary.score - Number(runnerUp?.score || 0);

  const shouldAskDisambiguation = !!runnerUp && primary.score >= 10 && runnerUp.score >= 10 && gap <= 8 && (
    [AD_INTENTS.SPECIFIC_ITEM, AD_INTENTS.CATALOG, AD_INTENTS.INSTITUTIONAL, AD_INTENTS.PROMOTION].includes(primary.intentKey) ||
    [AD_INTENTS.SPECIFIC_ITEM, AD_INTENTS.CATALOG, AD_INTENTS.INSTITUTIONAL, AD_INTENTS.PROMOTION].includes(runnerUp.intentKey)
  );

  const confidence = shouldAskDisambiguation ? "medium" : primary.score >= 24 && gap >= 10 ? "high" : gap >= 6 ? "medium" : "low";
  return {
    intentKey: primary.intentKey,
    runnerUpIntentKey: runnerUp?.intentKey || "",
    confidence,
    shouldAskDisambiguation,
    prompt: shouldAskDisambiguation ? buildIntentDisambiguationPrompt({ schema, primaryIntentKey: primary.intentKey, runnerUpIntentKey: runnerUp?.intentKey || "" }) : "",
    scores,
  };
}

function getIntentPromptFieldLabels({ schemaKey, intentKey, fieldsToAsk }) {
  const intent = String(intentKey || "").trim().toUpperCase();
  const key = String(schemaKey || "").trim().toUpperCase();

  if (key === "PROPERTY" && [AD_INTENTS.INSTITUTIONAL, AD_INTENTS.CATALOG].includes(intent)) {
    return [
      "Região / bairros / cidades atendidas",
      "Tipo de imóvel / perfil que você trabalha",
      "Faixa de valor ou padrão dos imóveis",
      "Seu principal diferencial",
      "Forma de contato / visita",
    ];
  }

  if ([AD_INTENTS.CATALOG].includes(intent) && ["VEHICLE","ELECTRONICS","FOOD","FASHION","HOME","BABY","TOOLS","COSMETICS","GENERIC","PETS","TOURISM"].includes(key)) {
    return [
      "Produtos / opções principais",
      "Faixa de preço / condição / promoção",
      "Cidade / entrega / retirada",
      "Destaque principal da sua linha",
    ];
  }

  if (intent === AD_INTENTS.PROMOTION) {
    const promotionFieldLabels = {
      offer: "Oferta / campanha / produtos em destaque",
      price: "Preço / desconto / condição",
      availability: "Validade / período da promoção",
      location: "Cidade / loja / entrega",
      differential: "Destaque principal da oferta",
    };

    const mapped = ensureArray(fieldsToAsk)
      .map((field) => promotionFieldLabels[String(field?.key || "").trim()] || field?.label)
      .filter(Boolean);

    return mapped.length
      ? mapped
      : [
          "Oferta / campanha / produtos em destaque",
          "Preço / desconto / condição",
          "Validade / período da promoção",
          "Cidade / loja / entrega",
        ];
  }

  if (intent === AD_INTENTS.INSTITUTIONAL && ["SERVICE","BEAUTY","HEALTH","EDUCATION","PROFESSIONAL","EVENTS"].includes(key)) {
    return [
      "Serviço / especialidade",
      "Região / formato de atendimento",
      "Seu principal diferencial",
      "Forma de contato / agenda",
    ];
  }

  return ensureArray(fieldsToAsk).map((field) => field.label);
}

function buildIntentContext({ schema, intentKey }) {
  const schemaLabel = schema?.label || "anúncio";
  const intent = String(intentKey || "").trim().toUpperCase();
  const lines = [
    "INTENCAO_DO_ANUNCIO:",
    `- Categoria detectada: ${schemaLabel}.`,
    `- Tipo de anúncio: ${getIntentInstructionLabel(intent)}.`,
  ];

  if (intent === AD_INTENTS.SPECIFIC_ITEM) lines.push("- Trate como item específico. Não invente catálogo, lista numerada, múltiplas opções ou dados que o usuário não informou.");
  if (intent === AD_INTENTS.SERVICE_OFFER) lines.push("- Trate como oferta de serviço. Destaque o que a pessoa faz, região, benefícios e chamada para contato, sem inventar itens ou produtos.");
  if (intent === AD_INTENTS.INSTITUTIONAL) lines.push("- Trate como anúncio institucional. Não invente unidades, modelos, imóveis, itens numerados, preços fictícios ou exemplos falsos.");
  if (intent === AD_INTENTS.CATALOG) lines.push("- Trate como anúncio de variedade/opções. Não crie lista numerada falsa nem exemplos inventados; fale de variedade real de forma genérica e vendedora.");
  if (intent === AD_INTENTS.PROMOTION) lines.push("- Trate como promoção/oferta. Destaque vantagem, condição e urgência com base no que foi informado, sem inventar percentuais, itens ou datas.");
  if (intent === AD_INTENTS.OPPORTUNITY) lines.push("- Trate como vaga/oportunidade. Foque em cargo, requisitos, local e forma de candidatura.");

  return lines.join("\n");
}

function buildCategoryDisambiguationPrompt(decision) {
  const config = getAmbiguityPairConfig(decision?.schema?.key, decision?.runnerUp?.schema?.key);
  const optionA = config?.options?.[0] || { key: decision?.schema?.key, label: decision?.schema?.label || "categoria 1" };
  const optionB = config?.options?.[1] || { key: decision?.runnerUp?.schema?.key, label: decision?.runnerUp?.schema?.label || "categoria 2" };
  const question = config?.question || "Quero entender melhor seu anúncio antes de continuar. Ele está mais para:";

  return [
    question,
    "",
    `1️⃣ ${optionA.label}`,
    `2️⃣ ${optionB.label}`,
    "3️⃣ seguir com uma versão mais genérica",
    "",
    "Responda só com *1*, *2* ou *3*. ✅",
  ].join("\n");
}

function detectCategoryDecision(text) {
  const candidates = getCategoryCandidates(text);
  const primary = candidates[0] || null;
  const runnerUp = candidates[1] || null;

  if (!primary || primary.score < 40) {
    return {
      schema: CATEGORY_SCHEMAS.GENERIC,
      runnerUp: null,
      confidence: "low",
      shouldAskDisambiguation: false,
      prompt: "",
      candidates,
    };
  }

  const gap = primary.score - Number(runnerUp?.score || 0);
  const sameMacroGroup = !!runnerUp && primary.macroGroup === runnerUp.macroGroup;
  const pairConfig = getAmbiguityPairConfig(primary.key, runnerUp?.key);

  const shouldAskDisambiguation = !!runnerUp && (
    (pairConfig && runnerUp.score >= 34 && gap <= 20) ||
    (sameMacroGroup && primary.score < 64 && runnerUp.score >= 32 && gap <= 10) ||
    (!primary.strong && !!runnerUp.strong && gap <= 14)
  );

  const confidence = shouldAskDisambiguation
    ? "medium"
    : primary.score >= 72 && gap >= 18
      ? "high"
      : gap >= 10
        ? "medium"
        : "low";

  return {
    schema: primary.schema,
    runnerUp: runnerUp ? { schema: runnerUp.schema, score: runnerUp.score, strong: runnerUp.strong, macroGroup: runnerUp.macroGroup } : null,
    confidence,
    shouldAskDisambiguation,
    prompt: shouldAskDisambiguation ? buildCategoryDisambiguationPrompt({ schema: primary.schema, runnerUp: runnerUp ? { schema: runnerUp.schema } : null }) : "",
    candidates,
  };
}

function detectCategorySchema(text) {
  return detectCategoryDecision(text).schema;
}
function profileHasUsefulValue(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.map((item) => cleanText(item)).filter(Boolean).length > 0;
  return cleanText(value).length > 0;
}

function hasProfileSupportForField(fieldKey, bizProfile) {
  const profile = bizProfile && typeof bizProfile === "object" ? bizProfile : null;
  if (!profile) return false;

  if (fieldKey === "location") {
    return [profile.location, profile.address, profile.serviceArea].some(profileHasUsefulValue);
  }

  if (fieldKey === "hours") {
    return profileHasUsefulValue(profile.hours);
  }

  if (fieldKey === "items") {
    return profileHasUsefulValue(profile.productList) || profileHasUsefulValue(profile.productsUrl);
  }

  return false;
}

function getFieldPresence(field, text, bizProfile) {
  const detectedInText = !!field?.detect?.(text || "");
  const detectedFromProfile = !!field?.allowProfileSupport && hasProfileSupportForField(field.key, bizProfile);
  return {
    inText: detectedInText,
    fromProfile: detectedFromProfile,
    present: detectedInText || detectedFromProfile,
  };
}

function computeCategoryCompleteness({ schema, text, bizProfile }) {
  const fields = ensureArray(schema?.fields);
  const details = fields.map((field) => {
    const presence = getFieldPresence(field, text, bizProfile);
    const weight = Number(field.weight || 0);
    return {
      key: field.key,
      label: field.label,
      importance: field.importance || "desired",
      weight,
      allowProfileSupport: !!field.allowProfileSupport,
      ...presence,
    };
  });

  const totalWeight = details.reduce((sum, item) => sum + item.weight, 0) || 1;
  const presentWeight = details.reduce((sum, item) => sum + (item.present ? item.weight : 0), 0);
  const score = Math.round((presentWeight / totalWeight) * 100);

  const missingCritical = details.filter((item) => item.importance === "critical" && !item.present);
  const missingDesired = details.filter((item) => item.importance !== "critical" && !item.present);

  return {
    schema,
    score,
    totalWeight,
    presentWeight,
    details,
    missingCritical,
    missingDesired,
    missingAll: details.filter((item) => !item.present),
  };
}

function pickFieldsToAsk({ completeness, maxFields = 5 }) {
  const sortByWeightDesc = (a, b) => {
    const wa = Number(a?.weight || 0);
    const wb = Number(b?.weight || 0);
    return wb - wa;
  };

  const critical = [...ensureArray(completeness?.missingCritical)].sort(sortByWeightDesc);
  const desired = [...ensureArray(completeness?.missingDesired)].sort(sortByWeightDesc);
  const ordered = [...critical, ...desired];
  return ordered.slice(0, maxFields);
}

function shouldAskCategoryQuestions({ schema, text, completeness, attemptCount = 0 }) {
  if (!schema || !completeness) return false;
  if (attemptCount >= 1) return false;

  const words = countWords(text);
  const askable = pickFieldsToAsk({ completeness });
  if (!askable.length) return false;

  if (completeness.missingCritical.length > 0) return true;

  const threshold = Number(schema.minAskScore || 65);
  if (completeness.score < threshold) return true;

  if (schema.key === "SERVICE") {
    const missingDesiredWeighted = ensureArray(completeness.missingDesired)
      .filter((item) => Number(item.weight || 0) >= 12);
    if (missingDesiredWeighted.length >= 2) return true;
    if (missingDesiredWeighted.length >= 1 && words <= 12) return true;
  }

  if (schema.key === "GENERIC") {
    return words <= 5 && completeness.missingAll.length >= 2;
  }

  return words <= 3 && completeness.missingAll.length >= 1;
}

function buildCategoryQuestionPrompt({ schema, intentKey = AD_INTENTS.SPECIFIC_ITEM, fieldsToAsk, bizProfile }) {
  const hints = [];

  if (hasProfileSupportForField("location", bizProfile)) {
    hints.push("região eu já posso aproveitar dos seus dados salvos");
  }
  if (hasProfileSupportForField("hours", bizProfile)) {
    hints.push("horário eu já posso aproveitar dos seus dados salvos");
  }

  const promptFields = getIntentPromptFieldLabels({ schemaKey: schema?.key, intentKey, fieldsToAsk });
  const introByIntent = {
    [AD_INTENTS.SPECIFIC_ITEM]: `Perfeito! Para o anúncio de ${schema.label} ficar mais forte, me manda em *uma única mensagem* só o que você quiser informar destes pontos:`,
    [AD_INTENTS.SERVICE_OFFER]: `Perfeito! Para esse anúncio de ${schema.label} ficar mais forte, me manda em *uma única mensagem* só o que você quiser informar destes pontos:`,
    [AD_INTENTS.INSTITUTIONAL]: `Perfeito! Como esse anúncio está mais para uma versão *institucional*, me manda em *uma única mensagem* só o que você quiser informar destes pontos:`,
    [AD_INTENTS.CATALOG]: `Perfeito! Como esse anúncio está mais para *várias opções / catálogo*, me manda em *uma única mensagem* só o que você quiser informar destes pontos:`,
    [AD_INTENTS.PROMOTION]: `Perfeito! Como esse anúncio está mais para uma *promoção / oferta*, me manda em *uma única mensagem* só o que você quiser informar destes pontos:`,
    [AD_INTENTS.OPPORTUNITY]: `Perfeito! Para essa *vaga / oportunidade* ficar mais forte, me manda em *uma única mensagem* só o que você quiser informar destes pontos:`,
  };

  const lines = [
    introByIntent[String(intentKey || AD_INTENTS.SPECIFIC_ITEM).trim().toUpperCase()] || `Perfeito! Para o anúncio de ${schema.label} ficar mais forte, me manda em *uma única mensagem* só o que você quiser informar destes pontos:`,
    "",
    ...promptFields.map((label) => `* ${label}`),
    "",
    "Pode mandar apenas o que você tiver.",
  ];

  if (hints.length) {
    lines.push(`✅ ${hints.join(" e ")}.`);
  }

  lines.push("");
  lines.push("Se preferir, digite *PULAR* e eu gero com o que já tenho. ✅");
  return lines.join("\n");
}

function buildCategoryIntakePlan({ text, bizProfile, attemptCount = 0, forcedSchemaKey = "", forcedIntentKey = "", skipDisambiguation = false, skipIntentDisambiguation = false }) {
  const forcedKey = String(forcedSchemaKey || "").trim().toUpperCase();
  const detection = forcedKey && CATEGORY_SCHEMAS[forcedKey]
    ? { schema: CATEGORY_SCHEMAS[forcedKey], runnerUp: null, confidence: "forced", shouldAskDisambiguation: false, prompt: "", candidates: [] }
    : detectCategoryDecision(text);

  const schema = detection.schema || CATEGORY_SCHEMAS.GENERIC;
  const completeness = computeCategoryCompleteness({ schema, text, bizProfile });
  const fieldsToAsk = pickFieldsToAsk({ completeness });

  if (!skipDisambiguation && detection.shouldAskDisambiguation && attemptCount < 1) {
    return {
      shouldAsk: false,
      shouldAskDisambiguation: true,
      shouldAskIntentDisambiguation: false,
      schema,
      completeness,
      fieldsToAsk: [],
      prompt: detection.prompt || "",
      detection,
      intentDecision: { intentKey: AD_INTENTS.SPECIFIC_ITEM, runnerUpIntentKey: "", confidence: "medium", shouldAskDisambiguation: false, prompt: "" },
    };
  }

  const forcedIntent = String(forcedIntentKey || "").trim().toUpperCase();
  const intentDecision = forcedIntent && Object.values(AD_INTENTS).includes(forcedIntent)
    ? { intentKey: forcedIntent, runnerUpIntentKey: "", confidence: "forced", shouldAskDisambiguation: false, prompt: "" }
    : detectAdIntentDecision({ text, schema });

  if (!skipIntentDisambiguation && intentDecision.shouldAskDisambiguation && attemptCount < 1) {
    return {
      shouldAsk: false,
      shouldAskDisambiguation: false,
      shouldAskIntentDisambiguation: true,
      schema,
      completeness,
      fieldsToAsk: [],
      prompt: intentDecision.prompt || "",
      detection,
      intentDecision,
    };
  }

  if (!shouldAskCategoryQuestions({ schema, text, completeness, attemptCount })) {
    return {
      shouldAsk: false,
      shouldAskDisambiguation: false,
      shouldAskIntentDisambiguation: false,
      schema,
      completeness,
      fieldsToAsk: [],
      prompt: "",
      detection,
      intentDecision,
    };
  }

  return {
    shouldAsk: true,
    shouldAskDisambiguation: false,
    shouldAskIntentDisambiguation: false,
    schema,
    completeness,
    fieldsToAsk,
    prompt: buildCategoryQuestionPrompt({ schema, intentKey: intentDecision.intentKey, fieldsToAsk, bizProfile }),
    detection,
    intentDecision,
  };
}

async function setAdSessionPayload(waId, payload) {
  await setCurrentAdSession(waId, payload);
}

async function getAdSessionPayload(waId) {
  return await getCurrentAdSession(waId);
}

async function clearAdSessionPayload(waId) {
  await clearCurrentAdSession(waId);
}

function buildLeadIntakeCombinedText(baseText, complementText) {
  return [
    baseText,
    "",
    "INFORMAÇÕES COMPLEMENTARES DO USUÁRIO:",
    complementText,
  ].join("\n");
}

function buildGenerationPrompt({ userText, lastAd, isRefinement, bizContext, intentContext = "" }) {
  const sections = [];

  sections.push([
    "REGRA_DE_PRIORIDADE:",
    "1. O que o usuário escreveu na descrição atual.",
    "2. As informações complementares respondidas nesta conversa.",
    "3. Os dados salvos da empresa, apenas para preencher o que faltar.",
    "Se houver conflito, siga exatamente essa ordem e nunca invente placeholders.",
  ].join("\n"));

  sections.push([
    "REGRAS_FIXAS_DE_MARCA_E_CONTATO:",
    "- Se houver nome da empresa salvo, ele deve aparecer em TODO anúncio final e em negrito.",
    "- Se houver site salvo, ele deve aparecer em TODO anúncio final.",
    "- Se houver redes sociais salvas, elas devem aparecer em TODO anúncio final.",
    "- Só deixe de mostrar nome da empresa, site ou redes sociais se o usuário pedir explicitamente para retirar, remover, ocultar ou não mostrar esses dados no refinamento.",
  ].join("\n"));

  if (bizContext) sections.push(bizContext);
  if (intentContext) sections.push(intentContext);

  if (isRefinement) {
    sections.push(`ANUNCIO_ATUAL:
${lastAd}`);
    sections.push(`AJUSTES_SOLICITADOS:
${userText}`);
  } else {
    sections.push(`DESCRIÇÃO_DO_USUÁRIO:
${userText}`);
  }

  return sections.join("\n\n");
}

async function clearCheckoutQuoteState(waId, { releaseReservation = false, reason = "", meta = {} } = {}) {
  const reservationId = await getCouponReservationId(waId);

  if (releaseReservation && reservationId) {
    try {
      await safeReleaseCouponReservationInFlow(reservationId, {
        reason: reason || "checkout_selection_changed",
        meta: { ...meta, source: "flow" },
      });
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.COUPON_ERROR, waId, err, {
        event: "flow_checkout_quote_release_failed",
        level: "warn",
        step: "clearCheckoutQuoteState",
        meta: { reservationId: cleanText(reservationId), reason: cleanText(reason) || "checkout_selection_changed" },
      });
    }
  }

  try {
    await Promise.all([
      clearCheckoutDraft(waId),
      clearSelectedCouponCode(waId),
      clearPricingQuote(waId),
      clearCouponReservationId(waId),
      clearCouponReservationCreatedAt(waId),
      clearCheckoutCouponStatus(waId),
    ]);
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
      event: "flow_checkout_quote_state_clear_failed",
      step: "clearCheckoutQuoteState",
      meta: { releaseReservation: !!releaseReservation },
    });
    throw err;
  }
}

async function getSelectedCheckoutPlan(waId) {
  const selectedPlanCode = (await getSelectedPlanCode(waId)) || (await getUserPlan(waId));
  if (!selectedPlanCode) return null;
  return await getPlan(selectedPlanCode);
}

async function getCurrentCheckoutSelection(waId) {
  const planCode = (await getSelectedPlanCode(waId)) || (await getUserPlan(waId)) || "";
  const billingCycle = (await getSelectedBillingCycle(waId)) || "monthly";
  const couponCode = await getSelectedCouponCode(waId);
  const plan = planCode ? await getPlan(planCode) : null;
  return { planCode, billingCycle, couponCode, plan };
}

function translatePricingFailure(code, fallback = "") {
  const map = {
    plan_code_required: "Escolha um plano para continuar.",
    plan_not_found: "Não encontrei esse plano. Vamos escolher novamente.",
    billing_cycle_not_available: "Esse ciclo não está disponível para o plano escolhido.",
    coupon_code_required: "Digite um cupom válido ou responda *SEM CUPOM*.",
    coupon_not_found: "Não encontrei esse cupom.",
    coupon_inactive: "Esse cupom está inativo no momento.",
    coupon_not_started: "Esse cupom ainda não começou a valer.",
    coupon_expired: "Esse cupom expirou.",
    coupon_plan_not_allowed: "Esse cupom não vale para o plano escolhido.",
    coupon_cycle_not_allowed: "Esse cupom não vale para esse ciclo de cobrança.",
    coupon_total_limit_reached: "Esse cupom atingiu o limite total de usos.",
    coupon_user_limit_reached: "Você já atingiu o limite de uso desse cupom.",
    coupon_requires_no_active_plan: "Esse cupom vale apenas para quem não tem plano ativo.",
    coupon_first_purchase_only: "Esse cupom vale apenas para a primeira contratação.",
    coupon_duplicate_pending_reservation: "Já existe uma reserva pendente desse cupom para você.",
  };
  return map[String(code || "").trim()] || String(fallback || "").trim() || "Não foi possível validar o cupom agora.";
}

async function persistCheckoutQuoteState(waId, { planCode = "", billingCycle = "monthly", couponCode = "", quote = null, reservation = null } = {}) {
  const normalizedPlanCode = String(planCode || "").trim().toUpperCase();
  const normalizedBillingCycle = String(billingCycle || "monthly").trim().toLowerCase() === "annual" ? "annual" : "monthly";
  const normalizedCouponCode = String(couponCode || "").trim().toUpperCase();
  const reservationId = reservation?.reservationId || "";
  const reservationCreatedAt = reservation?.reservedAt || new Date().toISOString();
  const checkoutCouponStatus = normalizedCouponCode ? (reservationId ? "RESERVED" : "VALIDATED") : "NONE";
  const summary = summarizePricingQuote(quote || {});

  try {
    await setSelectedPlanCode(waId, normalizedPlanCode);
    await setSelectedBillingCycle(waId, normalizedBillingCycle);
    if (normalizedCouponCode) await setSelectedCouponCode(waId, normalizedCouponCode);
    else await clearSelectedCouponCode(waId);

    await setPricingQuote(waId, {
      ...(quote || {}),
      couponReservationId: reservationId,
      couponReservationCreatedAt: reservationId ? reservationCreatedAt : "",
      checkoutCouponStatus,
    });

    if (reservationId) {
      await setCouponReservationId(waId, reservationId);
      await setCouponReservationCreatedAt(waId, reservationCreatedAt);
    } else {
      await clearCouponReservationId(waId);
      await clearCouponReservationCreatedAt(waId);
    }

    await setCheckoutCouponStatus(waId, checkoutCouponStatus);
    await setCheckoutDraft(waId, {
      planCode: normalizedPlanCode,
      billingCycle: normalizedBillingCycle,
      couponCode: normalizedCouponCode,
      couponReservationId: reservationId,
      couponReservationCreatedAt: reservationId ? reservationCreatedAt : "",
      checkoutCouponStatus,
      calculation: quote?.calculation || null,
      chargeMode: quote?.chargeMode || "",
      summary: summary?.summary || "",
      planName: quote?.plan?.name || quote?.explanation?.planName || "",
    });
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
      event: "flow_checkout_quote_persist_failed",
      step: "persistCheckoutQuoteState",
      meta: { planCode: normalizedPlanCode, billingCycle: normalizedBillingCycle, couponCode: normalizedCouponCode, reservationId: cleanText(reservationId) },
    });
    throw err;
  }
}

async function prepareCheckoutQuote(waId, { planCode = "", billingCycle = "monthly", couponCode = "", identityContext = {} } = {}) {
  const sensitiveOp = await ensureIdentitySensitiveOpAllowed(waId, identityContext, {
    step: "prepareCheckoutQuote",
    meta: { planCode, billingCycle, couponCode },
  });
  if (!sensitiveOp?.ok) {
    return { ok: false, code: "identity_review_pending", reason: sensitiveOp.replyText };
  }
  try {
    await clearCheckoutQuoteState(waId, {
      releaseReservation: true,
      reason: couponCode ? "checkout_coupon_replaced" : "checkout_quote_rebuilt",
      meta: { planCode, billingCycle, couponCode },
    });
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
      event: "flow_checkout_quote_clear_failed",
      step: "prepareCheckoutQuote",
      meta: { planCode, billingCycle, couponCode },
    });
    return { ok: false, code: "checkout_quote_clear_failed", reason: "Não foi possível preparar sua contratação agora." };
  }

  let quote;
  try {
    quote = await buildPricingQuote({
      internalUserId: waId,
      planCode,
      billingCycle,
      couponCode,
    });
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.PRICING_ERROR, waId, err, {
      event: "flow_pricing_quote_build_failed",
      step: "prepareCheckoutQuote",
      meta: { planCode, billingCycle, couponCode },
    });
    return { ok: false, code: "pricing_runtime_error", reason: "Não foi possível calcular a contratação agora." };
  }

  if (!quote?.ok || !quote?.valid) {
    return { ok: false, quote };
  }

  let reservation = null;
  if (couponCode) {
    let quoteSummary = "";
    try {
      quoteSummary = summarizePricingQuote(quote).summary;
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.PRICING_ERROR, waId, err, {
        event: "flow_pricing_quote_summary_failed",
        step: "prepareCheckoutQuote",
        meta: { planCode, billingCycle, couponCode },
      });
      return { ok: false, code: "pricing_summary_error", reason: "Não foi possível preparar o resumo da contratação." };
    }

    let reservationResult;
    try {
      reservationResult = await createCouponReservation({
        internalUserId: waId,
        couponCode,
        planCode,
        billingCycle,
        basePriceCents: Number(quote?.calculation?.basePriceCents || 0),
        selectionSnapshot: {
          planCode,
          billingCycle,
          couponCode,
          quoteSummary,
          chargeMode: quote?.chargeMode || "",
        },
        meta: { source: "flow" },
      });
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.COUPON_ERROR, waId, err, {
        event: "flow_coupon_reservation_create_failed",
        step: "prepareCheckoutQuote",
        meta: { planCode, billingCycle, couponCode },
      });
      return { ok: false, code: "coupon_reservation_runtime_error", reason: "Não foi possível reservar o cupom agora." };
    }

    if (!reservationResult?.ok || !reservationResult?.reservation) {
      return { ok: false, quote: reservationResult || quote };
    }

    reservation = reservationResult.reservation;
  }

  try {
    await persistCheckoutQuoteState(waId, {
      planCode,
      billingCycle,
      couponCode,
      quote,
      reservation,
    });
  } catch (err) {
    if (reservation?.reservationId) {
      try {
        await releaseCouponReservation(reservation.reservationId, {
          reason: "checkout_quote_persist_failed",
          meta: { source: "flow", planCode, billingCycle, couponCode },
        });
      } catch (releaseErr) {
        await reportFlowRuntimeError(FLOW_ERROR_KIND.COUPON_ERROR, waId, releaseErr, {
          event: "flow_coupon_reservation_rollback_failed",
          level: "warn",
          step: "prepareCheckoutQuote",
          meta: { reservationId: cleanText(reservation.reservationId), planCode, billingCycle, couponCode },
        });
      }
    }
    return { ok: false, code: "checkout_quote_state_persist_failed", reason: "Não foi possível salvar a contratação agora." };
  }

  await trackFlowMetricSafe(trackPricingQuoteGenerated, waId, {
    planCode,
    billingCycle,
    couponCode,
    step: ST.WAIT_COUPON_CODE,
  });

  return { ok: true, quote, reservation };
}

async function ensureCheckoutQuoteForPayment(waId) {
  let selection;
  try {
    selection = await getCurrentCheckoutSelection(waId);
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
      event: "flow_checkout_selection_read_failed",
      step: "ensureCheckoutQuoteForPayment",
    });
    return { ok: false, code: "checkout_selection_read_failed" };
  }

  if (!selection.planCode) {
    return { ok: false, code: "plan_missing" };
  }

  let storedQuote = null;
  try {
    storedQuote = await getStoredPricingQuote(waId);
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
      event: "flow_stored_quote_read_failed",
      step: "ensureCheckoutQuoteForPayment",
      meta: { planCode: selection.planCode, billingCycle: selection.billingCycle, couponCode: selection.couponCode },
    });
  }

  if (storedQuote?.planCode === String(selection.planCode || "").toUpperCase()
      && storedQuote?.billingCycle === String(selection.billingCycle || "monthly").toLowerCase()
      && String(storedQuote?.couponCode || "").toUpperCase() === String(selection.couponCode || "").toUpperCase()) {
    return { ok: true, quote: storedQuote, plan: selection.plan };
  }

  let quote;
  try {
    quote = await buildPricingQuote({
      internalUserId: waId,
      planCode: selection.planCode,
      billingCycle: selection.billingCycle,
      couponCode: selection.couponCode,
    });
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.PRICING_ERROR, waId, err, {
      event: "flow_checkout_quote_rebuild_failed",
      step: "ensureCheckoutQuoteForPayment",
      meta: { planCode: selection.planCode, billingCycle: selection.billingCycle, couponCode: selection.couponCode },
    });
    return { ok: false, code: "pricing_runtime_error", plan: selection.plan };
  }

  if (!quote?.ok || !quote?.valid) {
    return { ok: false, quote, plan: selection.plan };
  }

  let reservationId = "";
  if (selection.couponCode) {
    try {
      reservationId = await getCouponReservationId(waId);
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
        event: "flow_coupon_reservation_read_failed",
        step: "ensureCheckoutQuoteForPayment",
        meta: { planCode: selection.planCode, billingCycle: selection.billingCycle, couponCode: selection.couponCode },
      });
      return { ok: false, code: "coupon_reservation_state_error", plan: selection.plan };
    }
  }

  try {
    await persistCheckoutQuoteState(waId, {
      planCode: selection.planCode,
      billingCycle: selection.billingCycle,
      couponCode: selection.couponCode,
      quote,
      reservation: selection.couponCode ? { reservationId, reservedAt: new Date().toISOString() } : null,
    });
  } catch (err) {
    return { ok: false, code: "checkout_quote_state_persist_failed", plan: selection.plan };
  }

  return { ok: true, quote, plan: selection.plan };
}

// -------------------- Copy / Mensagens --------------------
async function msgAskName(waId){
  return withMenuHint(waId, await getCopyText("FLOW_ASK_NAME", { waId }));
}

async function msgAskProduct(waId){
  const fullName = await getUserFullName(waId);
  const firstName = firstNameFromFullName(fullName);
  const trialMaxDescriptions = await getTrialMaxDescriptions();
  const firstNameSuffix = firstName ? `, ${firstName}` : "";
  return withMenuHint(waId, await getCopyText("FLOW_ASK_PRODUCT", {
    waId,
    vars: { firstName, firstNameSuffix, trialMaxDescriptions },
  }));
}

async function msgTrialOverAndPlans(waId) {
  await markPlansPrompted(waId, { trialEnded: true });
  return await renderPlansMenu();
}

async function msgPlansOnly(waId) {
  await markPlansPrompted(waId, { trialEnded: false });
  // Versão sem o "trial concluído"
  const menu = await getMenuPlans();
  if (!menu || menu.length === 0) {
    return (
      "Para continuar, escolha um plano:\n\n" +
      "1) De Vez em Quando — R$ 24.90\n   • 20 descrições/mês\n\n" +
      "2) Sempre por Perto — R$ 34.90\n   • 60 descrições/mês\n\n" +
      "3) Melhor Amigo — R$ 49.90\n   • 200 descrições/mês\n\n" +
      "Responda com *1*, *2* ou *3*."
    );
  }

  const lines = [];
  lines.push("Para continuar, escolha um plano:");
  lines.push("");

  menu.forEach((p, idx) => {
    const n = idx + 1;
    const emoji = n === 1 ? "1️⃣" : n === 2 ? "2️⃣" : n === 3 ? "3️⃣" : `${n})`;
    const price = String(moneyBRFromCents(p.priceCents)).replace('.', ',');
    const quotaText = p.description || `${p.monthlyQuota} descrições/mês`;
    lines.push(`${emoji} *${p.name}* — R$ ${price} (${quotaText})`);
  });
  lines.push("");

  lines.push("Responda com *1*, *2* ou *3*.");
  return lines.join("\n");
}

async function msgAskPaymentMethod(waId, plan, quote = null){
  const effectivePlan = plan || await getSelectedCheckoutPlan(waId);
  const effectiveQuote = quote || await getStoredPricingQuote(waId);
  const billingCycle = effectiveQuote?.billingCycle || (await getSelectedBillingCycle(waId)) || "monthly";
  const finalPriceCents = Number(effectiveQuote?.calculation?.finalPriceCents || 0);
  const planPrice = finalPriceCents > 0
    ? moneyBRFromCents(finalPriceCents)
    : effectivePlan?.priceCents
      ? moneyBRFromCents(effectivePlan.priceCents)
      : "";

  const base = await getCopyText("FLOW_ASK_PAYMENT_METHOD_WITH_PLAN", {
    waId,
    vars: {
      planName: effectivePlan?.name || effectiveQuote?.explanation?.planName || "",
      planPrice,
    },
  });

  const lines = [base];
  if (effectiveQuote?.explanation?.description) {
    lines.push(
      "",
      `Resumo: ${effectiveQuote.explanation.description}.`,
      `Ciclo selecionado: *${billingCycleHumanLabel(billingCycle)}*.`,
    );
  }

  return withMenuHint(waId, lines.filter(Boolean).join("\n"));
}

async function msgAskBillingCycle(waId, plan) {
  const monthly = getPlanBillingOption(plan, "monthly");
  const annual = getPlanBillingOption(plan, "annual");
  const lines = [
    `Perfeito! Você escolheu o plano *${plan?.name || ""}*.`,
    "",
    "Agora escolha o ciclo de cobrança:",
    "",
    monthly ? `1️⃣ *Mensal* — ${formatMoneyTextFromCents(monthly.priceCents || 0)}` : "1️⃣ *Mensal*",
    annual ? `2️⃣ *Anual* — ${formatMoneyTextFromCents(annual.priceCents || 0)}` : "2️⃣ *Anual*",
    "",
    "Responda com *1* para mensal ou *2* para anual.",
  ];
  return withMenuHint(waId, lines.join("\n"));
}

async function msgAskCouponCode(waId, plan, billingCycle) {
  const label = billingCycleHumanLabel(billingCycle);
  const option = getPlanBillingOption(plan, billingCycle);
  const priceText = option ? formatMoneyTextFromCents(option.priceCents || 0) : "";
  const lines = [
    `Ótimo! Seguiremos com o plano *${plan?.name || ""}* no ciclo *${label}*.`,
    priceText ? `Valor base desta contratação: *${priceText}*.` : "",
    "",
    "Se você tiver um cupom de desconto, envie agora.",
    "Se preferir continuar sem cupom, responda *SEM CUPOM*.",
  ].filter(Boolean);
  return withMenuHint(waId, lines.join("\n"));
}

async function msgCouponInvalid(waId, pricingResult) {
  const message = translatePricingFailure(pricingResult?.code, pricingResult?.reason);
  return withMenuHint(waId, `${message}\n\nEnvie outro cupom ou responda *SEM CUPOM* para continuar.`);
}

async function msgCheckoutSummary(waId, quote) {
  const summary = summarizePricingQuote(quote || {});
  const lines = [
    "*Resumo da sua contratação*",
    "",
    summary.planName ? `Plano: *${summary.planName}*` : "",
    summary.billingCycleLabel ? `Ciclo: *${summary.billingCycleLabel}*` : "",
    summary.originalLabel ? `Valor original: *${summary.originalLabel}*` : "",
    summary.discountLabel && summary.discountLabel !== "R$ 0,00" ? `Desconto: *${summary.discountLabel}*` : "",
    summary.finalLabel ? `Valor final: *${summary.finalLabel}*` : "",
    summary.appliesToLabel ? `Aplicação do desconto: *${summary.appliesToLabel}*` : "",
    summary.couponCode ? `Cupom: *${summary.couponCode}*` : "Cupom: *sem cupom*",
    "",
    "Responda *CONFIRMAR* para seguir.",
    "Se quiser alterar algo, responda *PLANO*, *CICLO* ou *CUPOM*.",
  ].filter(Boolean);
  return withMenuHint(waId, lines.join("\n"));
}

async function msgAskDoc(waId){

  return withMenuHint(waId, await getCopyText("FLOW_ASK_DOC", { waId }));
}

async function msgInvalidDoc(waId){
  return await getCopyText("FLOW_INVALID_DOC", { waId });
}

async function msgAskBillingCityState(waId){
  return withMenuHint(waId, await getCopyText("FLOW_ASK_BILLING_CITY_STATE", { waId }));
}

async function msgAskBillingAddress(waId){
  return withMenuHint(waId, await getCopyText("FLOW_ASK_BILLING_ADDRESS", { waId }));
}

async function msgAfterAdAskTemplateChoice(waId, currentMode){
  return await getCopyText("FLOW_ASK_TEMPLATE_CHOICE", { waId });
}

async function msgTemplateSet(waId, mode){
  return await getCopyText(mode === "FREE" ? "FLOW_TEMPLATE_SET_FREE" : "FLOW_TEMPLATE_SET_FIXED", { waId });
}

async function msgAskProfileRegistration(waId) {
  return await getCopyText("FLOW_ASK_PROFILE_REGISTRATION", { waId });
}

async function msgFirstResultPrompt(waId) {
  return await getCopyText("FLOW_FIRST_RESULT_PROMPT", { waId });
}

async function msgFirstResultExplain(waId) {
  return await getCopyText("FLOW_FIRST_RESULT_EXPLAIN", { waId });
}

async function msgFirstResultShowFree(waId) {
  return await getCopyText("FLOW_FIRST_RESULT_SHOW_FREE", { waId });
}

function buildRefinementReminder(maxRefinements) {
  const qty = Number.isFinite(Number(maxRefinements)) && Number(maxRefinements) >= 0
    ? Math.trunc(Number(maxRefinements))
    : 2;

  return `* Para refinar: responda com o que você quer mudar (ex.: "deixa mais curto", "mais emocional", "com mais emoji", etc...).

(Lembrete: até ${qty} refinamento(s) por descrição. No próximo, conta como uma nova descrição.)`;
}

async function msgRefinementPrompt(waId, maxRefinements) {
  const lines = [];
  lines.push(await getCopyText("FLOW_AFTER_SAVE_PROFILE_QUESTION", { waId }));
  lines.push(buildRefinementReminder(maxRefinements));
  lines.push(await getCopyText("FLOW_AFTER_SAVE_PROFILE_OK_HINT", { waId }));
  return lines.join("\n");
}

function normalizeProfileScalar(value) {
  return String(value ?? "").replace(/\\/g, "/").trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalizeUrlForCompare(value) {
  let s = normalizeProfileScalar(value).toLowerCase();
  if (!s) return "";

  const markdownHref = s.match(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/i)?.[1];
  if (markdownHref) s = markdownHref;

  s = s.replace(/^https?:\/\//i, "");
  s = s.replace(/^www\./i, "");
  s = s.replace(/\/+$/g, "");
  return s;
}

function lineContainsEquivalentUrl(line, value) {
  const target = canonicalizeUrlForCompare(value);
  if (!target) return false;

  const source = normalizeProfileScalar(line);
  if (!source) return false;

  const direct = canonicalizeUrlForCompare(source);
  if (direct && direct.includes(target)) return true;

  const markdownUrls = [...source.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/gi)].map((match) => canonicalizeUrlForCompare(match[1]));
  if (markdownUrls.some((item) => item && item.includes(target))) return true;

  const plainUrls = [...source.matchAll(/https?:\/\/[^\s)]+/gi)].map((match) => canonicalizeUrlForCompare(match[0]));
  if (plainUrls.some((item) => item && item.includes(target))) return true;

  return canonicalizeUrlForCompare(source.replace(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/gi, "$1")).includes(target);
}

function normalizeMarkdownLinksDisplay(adText) {
  return String(adText || "").replace(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/gi, "$1");
}

function normalizeSocialLinksDisplay(adText) {
  return String(adText || "").replace(
    /(📸\s*(?:Siga-nos|Nos acompanhe|Acompanhe-nos|Redes sociais?):\s*)(.+)/gi,
    (full, prefix, content) => `${prefix}${content.replace(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/gi, "$1")}`,
  );
}

function textRequestsRemovingCompanyInfo(text) {
  const s = upper(text);
  return /(RETIRA|RETIRAR|REMOVE|REMOVER|SEM|TIRA|OCULTA|OCULTAR|N[ÃA]O COLOCA|NAO COLOCA|N[ÃA]O MOSTRA|NAO MOSTRA)/.test(s)
    && /(EMPRESA|NOME DA EMPRESA|MARCA|SITE|REDES?|REDE SOCIAL|INSTAGRAM|FACEBOOK|TIKTOK)/.test(s);
}

function textRequestsRemovingField(text, fieldType) {
  const s = upper(text);
  const removeIntent = /(RETIRA|RETIRAR|REMOVE|REMOVER|SEM|TIRA|OCULTA|OCULTAR|N[ÃA]O COLOCA|NAO COLOCA|N[ÃA]O MOSTRA|NAO MOSTRA)/.test(s);
  if (!removeIntent) return false;

  if (fieldType === "website") {
    return /(SITE|LINK|WEBSITE|WWW)/.test(s);
  }

  if (fieldType === "socials") {
    return /(REDES?|REDE SOCIAL|INSTAGRAM|FACEBOOK|TIKTOK|SOCIAL)/.test(s);
  }

  if (fieldType === "companyName") {
    return /(EMPRESA|NOME DA EMPRESA|MARCA)/.test(s);
  }

  return false;
}

function hasLineWithText(lines, value) {
  const target = normalizeProfileScalar(value).toLowerCase();
  if (!target) return false;
  return lines.some((line) => normalizeProfileScalar(line).toLowerCase().includes(target));
}

function normalizeCompanyCtas(adText, bizProfile) {
  const companyName = normalizeProfileScalar(bizProfile?.companyName);
  if (!companyName) return String(adText || "");

  return String(adText || "")
    .replace(/Fale comigo/gi, "Fale conosco")
    .replace(/Entre em contato comigo/gi, "Entre em contato conosco")
    .replace(/Me chame/gi, "Nos chame")
    .replace(/Agende comigo/gi, "Agende conosco");
}

function normalizeGenericCtas(adText) {
  return String(adText || "")
    .replace(/Fale comigo para mais informa[cç][õo]es!?/gi, "Entre em contato para mais informações.")
    .replace(/Fale comigo para saber mais!?/gi, "Entre em contato para mais informações.")
    .replace(/Fale comigo/gi, "Entre em contato")
    .replace(/Entre em contato comigo/gi, "Entre em contato")
    .replace(/Me chame/gi, "Entre em contato")
    .replace(/Agende comigo/gi, "Agende seu atendimento");
}

function removeGeneratedPlaceholders(adText) {
  const placeholderPatterns = [
    /^\s*\*?\s*\[(Seu|Sua|Seus|Suas)\s+[^\]]+\]\s*\*?\s*$/gim,
    /^\s*\*?\s*\[Contato\]\s*\*?\s*$/gim,
    /\*?\s*\[(Seu|Sua|Seus|Suas)\s+[^\]]+\]\s*\*?/gi,
    /\*?\s*\[Contato\]\s*\*?/gi,
  ];

  let text = String(adText || "");
  for (const rx of placeholderPatterns) {
    text = text.replace(rx, "");
  }

  const lines = text
    .split("\n")
    .map((line) => String(line || "").trim())
    .filter((line) => !/^\*?\s*\[(Seu|Sua|Seus|Suas)\s+[^\]]+\]\s*\*?$/i.test(line))
    .filter((line) => !/^\*?\s*\[Contato\]\s*\*?$/i.test(line))
    .filter((line) => !/^\*+\s*$/i.test(line));

  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  const compact = [];
  for (const line of lines) {
    if (!line.trim() && compact.length && !compact[compact.length - 1].trim()) continue;
    compact.push(line);
  }

  return compact.join("\n").trim();
}

function sanitizeGeneratedAd(adText, bizProfile) {
  const hasCompany = !!normalizeProfileScalar(bizProfile?.companyName);
  let text = String(adText || "");
  text = normalizeMarkdownLinksDisplay(text);
  text = removeGeneratedPlaceholders(text);
  if (hasCompany) text = normalizeBusinessVoice(text, bizProfile);
  text = hasCompany ? normalizeCompanyCtas(text, bizProfile) : normalizeGenericCtas(text);
  text = removeGeneratedPlaceholders(text);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function ensureCompanyNameBold(adText, companyName) {
  const name = normalizeProfileScalar(companyName);
  if (!name) return adText;

  const escaped = escapeRegex(name);
  const alreadyBold = new RegExp(`\\*${escaped}\\*`, "i");
  if (alreadyBold.test(adText)) return adText;

  const plain = new RegExp(escaped, "i");
  if (plain.test(adText)) {
    return adText.replace(plain, `*${name}*`);
  }

  const lines = String(adText || "").split("\n");
  const insertLine = `🏢 *${name}*`;

  if (!lines.length) return insertLine;

  if (lines.length === 1) {
    return [lines[0], "", insertLine].join("\n");
  }

  lines.splice(2, 0, insertLine, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function applyPersistentBusinessInfo(adText, bizProfile, userText, isRefinement) {
  if (!bizProfile || typeof bizProfile !== "object") return adText;

  const refinementText = isRefinement ? String(userText || "") : "";
  let text = normalizeBusinessVoice(adText, bizProfile);
  text = normalizeCompanyCtas(text, bizProfile);
  text = normalizeSocialLinksDisplay(text);

  const companyName = normalizeProfileScalar(bizProfile.companyName);
  const website = normalizeUrlLike(normalizeProfileScalar(bizProfile.website));
  const whatsapp = normalizeWhatsappLike(normalizeProfileScalar(bizProfile.whatsapp));
  const socials = ensureArray(bizProfile.socials)
    .map((item) => normalizeUrlLike(normalizeProfileScalar(item)))
    .filter(Boolean);

  if (companyName && !textRequestsRemovingField(refinementText, "companyName") && !textRequestsRemovingCompanyInfo(refinementText)) {
    text = ensureCompanyNameBold(text, companyName);
  }

  const lines = String(text || "").split("\n").map((line) => String(line || "").trimRight());
  const infoLinesToAdd = [];

  if (website && !textRequestsRemovingField(refinementText, "website") && !hasLineWithText(lines, website) && !lines.some((line) => lineContainsEquivalentUrl(line, website))) {
    infoLinesToAdd.push(`🌐 *Site:* ${website}`);
  }

  if (whatsapp && !hasLineWithText(lines, whatsapp)) {
    infoLinesToAdd.push(`📞 *WhatsApp:* ${whatsapp}`);
  }

  if (socials.length && !textRequestsRemovingField(refinementText, "socials")) {
    const missingSocials = socials.filter((item) => !hasLineWithText(lines, item) && !lines.some((line) => lineContainsEquivalentUrl(line, item)));
    if (missingSocials.length) {
      infoLinesToAdd.push(`📱 ${missingSocials.join(" | ")}`);
    }
  }

  if (!infoLinesToAdd.length) return text;

  let insertAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = String(lines[i] || "").trim().toLowerCase();
    if (!s) continue;
    if (s.startsWith("converse") || s.startsWith("chame") || s.startsWith("fale") || s.startsWith("me chame") || s.startsWith("📲") || s.startsWith("💬")) {
      insertAt = i;
      break;
    }
  }

  const payload = [];
  if (insertAt > 0 && String(lines[insertAt - 1] || "").trim() !== "") payload.push("");
  payload.push(...infoLinesToAdd);
  if (insertAt < lines.length && String(lines[insertAt] || "").trim() !== "") payload.push("");

  lines.splice(insertAt, 0, ...payload);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildBizProfileContext(profile) {
  if (!profile || typeof profile !== "object") return "";

  const parts = [];
  const companyName = normalizeProfileScalar(profile.companyName);
  const serviceArea = normalizeProfileScalar(profile.serviceArea);
  const location = normalizeProfileScalar(profile.location);
  const hours = normalizeProfileScalar(profile.hours);
  const whatsapp = normalizeWhatsappLike(normalizeProfileScalar(profile.whatsapp));
  const website = normalizeUrlLike(normalizeProfileScalar(profile.website));
  const productList = normalizeProfileScalar(profile.productList || profile.productsUrl);
  const socials = ensureArray(profile.socials)
    .map((item) => normalizeUrlLike(normalizeProfileScalar(item)))
    .filter(Boolean);

  if (companyName) parts.push(`Empresa: ${companyName}`);
  if (serviceArea) parts.push(`Atendimento: ${serviceArea}`);
  if (location) parts.push(`Local: ${location}`);
  if (hours) parts.push(`Horário: ${hours}`);
  if (whatsapp) parts.push(`WhatsApp: ${whatsapp}`);
  if (website) parts.push(`Site: ${website}`);
  if (productList) parts.push(`Catálogo/Lista: ${productList}`);
  if (socials.length) parts.push(`Redes: ${socials.join(" | ")}`);

  if (!parts.length) return "";

  return [
    "CONTEXTO_DA_EMPRESA (dados salvos do usuário; trate como fonte de verdade quando ele pedir para incluir ou ajustar dados da empresa, sem inventar placeholders ou substituir por exemplos):",
    parts.join("\n"),
  ].join("\n");
}

function hasMeaningfulBizProfile(profile) {
  if (!profile || typeof profile !== "object") return false;

  const companyName = normalizeProfileScalar(profile.companyName);
  const serviceArea = normalizeProfileScalar(profile.serviceArea);
  const location = normalizeProfileScalar(profile.location);
  const hours = normalizeProfileScalar(profile.hours);
  const whatsapp = normalizeWhatsappLike(normalizeProfileScalar(profile.whatsapp));
  const website = normalizeUrlLike(normalizeProfileScalar(profile.website));
  const productList = normalizeProfileScalar(profile.productList || profile.productsUrl);
  const socials = ensureArray(profile.socials)
    .map((item) => normalizeUrlLike(normalizeProfileScalar(item)))
    .filter(Boolean);

  return Boolean(
    companyName ||
    serviceArea ||
    location ||
    hours ||
    whatsapp ||
    website ||
    productList ||
    socials.length
  );
}

async function msgAfterSaveProfile(waId, saved, maxRefinements) {
  const lines = [];
  lines.push(
    saved
      ? await getCopyText("FLOW_SAVE_PROFILE_SAVED_CONFIRM", { waId })
      : await getCopyText("FLOW_SAVE_PROFILE_NOT_SAVED_CONFIRM", { waId })
  );
  lines.push("");
  lines.push(await getCopyText("FLOW_AFTER_SAVE_PROFILE_QUESTION", { waId }));
  lines.push(buildRefinementReminder(maxRefinements));
  lines.push(await getCopyText("FLOW_AFTER_SAVE_PROFILE_OK_HINT", { waId }));
  return lines.join("\n");
}

async function msgMenuMain(waId) {
  return await getCopyText("FLOW_MENU_MAIN", { waId });
}

function maskDocPreview(doc) {
  if (!doc?.docType) return "Não informado";
  return `${doc.docType} (oculto por segurança)`;
}

function formatSubscriptionDueDate({ paymentMethod, validUntil }) {
  if (paymentMethod === "PIX") return "A definir após a cobrança mensal";
  const renewalBr = formatDateBR(validUntil);
  if (!renewalBr) return "—";
  const days = daysUntilISO(validUntil);
  const suffix = typeof days === "number" ? ` (faltam ${days} dia(s))` : "";
  return `${renewalBr}${suffix}`;
}

async function msgMenuSubscription(waId) {
  const status = await getUserStatus(waId);
  const planCode = await getUserPlan(waId);
  const paymentMethod = await getPaymentMethod(waId);
  const validUntil = await getCardValidUntil(waId);

  let planName = "Trial";
  let total = await getTrialMaxDescriptions();
  let used = await getUserTrialUsed(waId);

  if (planCode) {
    const plan = (await getMenuPlans()).find((item) => item.code === planCode) || (await getPlan(planCode)) || null;
    if (plan) {
      planName = plan.name || planCode;
      total = Number(plan.monthlyQuota || 0) || 0;
      used = await getUserQuotaUsed(waId);
    } else {
      planName = planCode;
      total = 0;
      used = await getUserQuotaUsed(waId);
    }
  }

  return await getCopyText("FLOW_MENU_SUBSCRIPTION", {
    waId,
    vars: {
      planName,
      status: status || "—",
      paymentMethodLabel: paymentMethod === "CARD" ? "Cartão" : paymentMethod === "PIX" ? "PIX" : "—",
      dueDate: formatSubscriptionDueDate({ paymentMethod, validUntil }),
      used,
      total: total || "—",
    },
  });
}

async function msgMenuEditRoot(waId) {
  return await getCopyText("FLOW_MENU_EDIT_ROOT", { waId });
}

async function buildPersonalMenuOptions(waId) {
  const [fullName, doc, billingCityState, billingAddress] = await Promise.all([
    getUserFullName(waId),
    getUserDocMasked(waId),
    getBillingCityState(waId),
    getBillingAddress(waId),
  ]);

  return [
    { number: "1", field: "fullName", label: fullName || "Nome não informado" },
    { number: "2", field: "docMasked", label: maskDocPreview(doc) },
    { number: "3", field: "billingCityState", label: billingCityState || "Cidade/UF não informada" },
    { number: "4", field: "billingAddress", label: billingAddress || "Endereço não informado" },
  ];
}

async function msgMenuEditPersonal(waId) {
  const options = await buildPersonalMenuOptions(waId);
  const optionsText = options.map((item) => `${item.number}) ${item.label}`).join("\n");
  return await getCopyText("FLOW_MENU_EDIT_PERSONAL", { waId, vars: { options: optionsText } });
}

async function buildCompanyMenuOptions(waId) {
  const biz = (await getBizProfile(waId)) || {};
  const socials = ensureArray(biz?.socials).filter(Boolean).join(", ");
  return [
    { number: "1", field: "companyName", label: biz?.companyName || "Nome da empresa não informado" },
    { number: "2", field: "whatsapp", label: biz?.whatsapp || "WhatsApp não informado" },
    { number: "3", field: "address", label: biz?.address || biz?.location || "Endereço/local não informado" },
    { number: "4", field: "hours", label: biz?.hours || "Horário não informado" },
    { number: "5", field: "socials", label: socials || "Redes sociais não informadas" },
    { number: "6", field: "website", label: biz?.website || "Site não informado" },
    { number: "7", field: "productList", label: biz?.productList || biz?.productsUrl || "Catálogo/lista não informado" },
  ];
}

async function msgMenuEditCompany(waId) {
  const options = await buildCompanyMenuOptions(waId);
  const optionsText = options.map((item) => `${item.number}) ${item.label}`).join("\n");
  return await getCopyText("FLOW_MENU_EDIT_COMPANY", { waId, vars: { options: optionsText } });
}

async function msgMenuEditTemplate(waId) {
  const mode = await getTemplateMode(waId);
  return await getCopyText("FLOW_MENU_EDIT_TEMPLATE", { waId, vars: { mode: mode === "FREE" ? "LIVRE" : "FIXO" } });
}

async function msgMenuAskEditField(waId, context) {
  const field = String(context?.field || "");
  if (field === "fullName") {
    return withMenuHint(waId, await getCopyText("FLOW_MENU_EDIT_FIELD_FULLNAME", { waId }));
  }
  if (field === "docMasked") {
    return withMenuHint(waId, await getCopyText("FLOW_MENU_EDIT_FIELD_DOC", { waId }));
  }
  if (field === "billingCityState") {
    return withMenuHint(waId, await getCopyText("FLOW_MENU_EDIT_FIELD_BILLING_CITY_STATE", { waId }));
  }
  if (field === "billingAddress") {
    return withMenuHint(waId, await getCopyText("FLOW_MENU_EDIT_FIELD_BILLING_ADDRESS", { waId }));
  }

  const fieldLabels = {
    companyName: "nome da empresa",
    whatsapp: "WhatsApp",
    address: "endereço ou local de atendimento",
    hours: "horário",
    socials: "redes sociais",
    website: "site",
    productList: "catálogo ou lista de produtos",
  };
  const label = fieldLabels[field] || "dado";
  return withMenuHint(waId, await getCopyText("FLOW_MENU_EDIT_FIELD_GENERIC", { waId, vars: { label } }));
}

async function msgMenuProfileView(waId) {
  return await msgMenuEditCompany(waId);
}

async function msgMenuAskNewName(waId) {
  return await getCopyText("FLOW_MENU_ASK_NEW_NAME", { waId });
}

async function msgMenuAskNewDoc(waId) {
  return await getCopyText("FLOW_MENU_ASK_NEW_DOC", { waId });
}

async function msgMenuUrlHelp(waId) {
  return await getCopyText("FLOW_MENU_URL_HELP", { waId });
}

async function msgMenuUrlFeedback(waId) {
  return await getCopyText("FLOW_MENU_URL_FEEDBACK", { waId });
}

async function msgMenuUrlInstagram(waId) {
  return await getCopyText("FLOW_MENU_URL_INSTAGRAM", { waId });
}

async function msgMenuCancelNotFound(waId) {
  return await getCopyText("FLOW_MENU_CANCEL_NOT_FOUND", { waId });
}

async function msgMenuCancelOk(waId, { renewalBr = "", daysLeft = "" } = {}) {
  return await getCopyText("FLOW_MENU_CANCEL_OK", {
    waId,
    vars: { renewalBr, daysLeft },
  });
}

async function msgMenuMySubscription(waId) {
  return await msgMenuSubscription(waId);
}
async function createCurrentPlanPayment(waId, identityContext = {}) {
  const sensitiveOp = await ensureIdentitySensitiveOpAllowed(waId, identityContext, {
    step: "createCurrentPlanPayment",
  });
  if (!sensitiveOp?.ok) {
    return sensitiveOp.replyText;
  }
  let selection;
  try {
    selection = await getCurrentCheckoutSelection(waId);
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
      event: "flow_checkout_selection_failed",
      step: "createCurrentPlanPayment",
    });
    return "Não consegui preparar sua contratação agora. Tente novamente em instantes.";
  }

  let planCode = selection.planCode;
  if (!planCode) {
    try {
      planCode = await getUserPlan(waId);
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
        event: "flow_user_plan_read_failed",
        step: "createCurrentPlanPayment",
      });
      return "Não consegui recuperar seu plano agora. Tente novamente em instantes.";
    }
  }

  let plan = selection.plan || null;
  if (!plan && planCode) {
    try {
      plan = await getPlan(planCode);
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
        event: "flow_plan_lookup_failed",
        step: "createCurrentPlanPayment",
        meta: { planCode },
      });
      return "Não consegui validar seu plano agora. Tente novamente em instantes.";
    }
  }

  if (!plan) {
    try {
      await setUserStatus(waId, ST.WAIT_PLAN);
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
        event: "flow_status_reset_to_plan_failed",
        step: "createCurrentPlanPayment",
      });
    }
    return await msgPlansOnly(waId);
  }

  let pm = "";
  try {
    pm = await getPaymentMethod(waId);
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
      event: "flow_payment_method_read_failed",
      step: "createCurrentPlanPayment",
      meta: { planCode: plan.code },
    });
    return "Não consegui recuperar a forma de pagamento agora. Tente novamente em instantes.";
  }

  if (!pm) {
    try {
      await setUserStatus(waId, ST.WAIT_PAYMENT_METHOD);
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
        event: "flow_status_wait_payment_method_failed",
        step: "createCurrentPlanPayment",
      });
      return "Não consegui preparar o pagamento agora. Tente novamente em instantes.";
    }
    return await msgAskPaymentMethod(waId, plan);
  }

  let customerId = "";
  try {
    customerId = await getAsaasCustomerId(waId);
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
      event: "flow_asaas_customer_read_failed",
      step: "createCurrentPlanPayment",
      meta: { planCode: plan.code },
    });
    return "Não consegui validar seu cadastro agora. Tente novamente em instantes.";
  }

  if (!customerId) {
    try {
      await setUserStatus(waId, ST.WAIT_DOC);
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
        event: "flow_status_wait_doc_failed",
        step: "createCurrentPlanPayment",
      });
      return "Não consegui preparar o pagamento agora. Tente novamente em instantes.";
    }
    return await msgAskDoc(waId);
  }

  const quoteResult = await ensureCheckoutQuoteForPayment(waId);
  if (!quoteResult?.ok || !quoteResult?.quote) {
    const pricingFailure = quoteResult?.quote || quoteResult || {};
    let couponCode = "";
    try {
      couponCode = await getSelectedCouponCode(waId);
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
        event: "flow_selected_coupon_read_failed",
        step: "createCurrentPlanPayment",
      });
    }

    if (couponCode) {
      try {
        await setUserStatus(waId, ST.WAIT_COUPON_CODE);
      } catch (err) {
        await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
          event: "flow_status_wait_coupon_failed",
          step: "createCurrentPlanPayment",
        });
        return "Não consegui validar seu cupom agora. Tente novamente em instantes.";
      }
      return await msgCouponInvalid(waId, pricingFailure);
    }

    try {
      await setUserStatus(waId, ST.WAIT_PLAN);
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
        event: "flow_status_wait_plan_failed_after_quote_error",
        step: "createCurrentPlanPayment",
      });
      return "Não consegui preparar sua contratação agora. Tente novamente em instantes.";
    }
    return await msgPlansOnly(waId);
  }

  const quote = quoteResult.quote;
  const billingCycle = quote?.billingCycle || selection.billingCycle || "monthly";
  const planCodeLabel = quote?.planCode || plan.code;
  const billingLabel = billingCycleHumanLabel(billingCycle);
  const quoteSummary = quote?.explanation?.description ? `Resumo: ${quote.explanation.description}.` : "";
  const externalReference = waId;
  const dueDate = todayISO();

  if (pm === "PIX") {
    let pay;
    try {
      pay = await createAsaasCheckoutFromQuote({
        customerId,
        quote,
        paymentMethod: "pix",
        externalReference,
        dueDate,
        description: `Amigo das Vendas - Plano ${planCodeLabel} (${billingLabel} via PIX)`,
        name: `Plano ${plan.name} (${billingLabel})`,
      });
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.ASAAS_CLIENT_ERROR, waId, err, {
        event: "flow_pix_checkout_create_failed",
        step: "createCurrentPlanPayment",
        meta: { paymentMethod: "PIX", planCode: planCodeLabel, billingCycle },
      });
      return "Não consegui gerar sua cobrança PIX agora. Tente novamente em instantes.";
    }

    await resolveAndTrackCampaignConversion(waId, "checkout_completed", "checkout_flow_pix", {
      paymentMethod: "PIX",
      planCode: planCodeLabel,
      billingCycle,
    });

    try {
      await markCheckoutInteraction(waId);
      await setUserStatus(waId, ST.PAYMENT_PENDING);
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
        event: "flow_pix_checkout_state_update_failed",
        step: "createCurrentPlanPayment",
        meta: { paymentMethod: "PIX", planCode: planCodeLabel, billingCycle, paymentId: cleanText(pay?.id) },
      });
      return "Gerei sua cobrança, mas não consegui finalizar o estado da contratação agora. Tente novamente em instantes.";
    }

    const url = pay?.invoiceUrl || pay?.bankSlipUrl || pay?.paymentLink || "";
    const lines = [
      await getCopyText("FLOW_PLAN_VALUE_REINFORCEMENT", { waId }),
      "",
      "✅ Pronto! Gerei sua cobrança via *PIX*.",
      quoteSummary,
      "",
      url ? `Pague por aqui: ${url}` : "Pague pelo link dentro do Asaas.",
      "",
      "Assim que o pagamento for confirmado, seu plano ativa automaticamente. 🚀",
      "",
      "Se quiser mudar a forma de pagamento agora, responda *MUDAR PAGAMENTO*.",
    ].filter(Boolean);
    return lines.join("\n");
  }

  try {
    const link = await createAsaasCheckoutFromQuote({
      quote,
      paymentMethod: "credit_card",
      externalReference,
      description: `Amigo das Vendas - Plano ${planCodeLabel} (${billingLabel} no cartão)`,
      name: `Assinatura ${plan.name} (${billingLabel})`,
    });

    await resolveAndTrackCampaignConversion(waId, "checkout_completed", "checkout_flow_credit_card", {
      paymentMethod: "CREDIT_CARD",
      planCode: planCodeLabel,
      billingCycle,
    });

    try {
      await markCheckoutInteraction(waId);
      await setUserStatus(waId, ST.PAYMENT_PENDING);
    } catch (stateErr) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, stateErr, {
        event: "flow_card_checkout_state_update_failed",
        step: "createCurrentPlanPayment",
        meta: { paymentMethod: "CREDIT_CARD", planCode: planCodeLabel, billingCycle, paymentId: cleanText(link?.id) },
      });
      return "Gerei seu link de pagamento, mas não consegui finalizar o estado da contratação agora. Tente novamente em instantes.";
    }

    const url = link?.url || link?.paymentLink || link?.link || "";
    const lines = [
      await getCopyText("FLOW_PLAN_VALUE_REINFORCEMENT", { waId }),
      "",
      "✅ Pronto! Agora é só concluir no *Cartão* (assinatura).",
      quoteSummary,
      "",
      url ? `Finalize por aqui: ${url}` : "Finalize pelo link no Asaas.",
      "",
      "Assim que confirmar, seu plano ativa automaticamente. 🚀",
      "",
      "Se quiser mudar a forma de pagamento agora, responda *MUDAR PAGAMENTO*.",
    ].filter(Boolean);
    return lines.join("\n");
  } catch (err) {
    if (err?.code === "recurring_first_charge_discount_not_supported") {
      try {
        await setUserStatus(waId, ST.WAIT_PAYMENT_METHOD);
      } catch (stateErr) {
        await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, stateErr, {
          event: "flow_status_wait_payment_method_after_card_coupon_restriction_failed",
          step: "createCurrentPlanPayment",
        });
        return "Esse desconto não pode ser finalizado no cartão recorrente agora. Tente novamente em instantes.";
      }
      const lines = [
        "⚠️ Esse cupom gera um desconto válido apenas para a primeira cobrança.",
        "No fluxo atual, esse tipo de desconto não pode ser finalizado no *Cartão* recorrente.",
        "",
        "Para continuar com esse desconto, responda *1* e finalize via *PIX*.",
        "Se preferir manter o cartão, responda *MUDAR PAGAMENTO* e escolha outra forma.",
      ].filter(Boolean);
      return lines.join("\n");
    }

    await reportFlowRuntimeError(FLOW_ERROR_KIND.ASAAS_CLIENT_ERROR, waId, err, {
      event: "flow_card_checkout_create_failed",
      step: "createCurrentPlanPayment",
      meta: { paymentMethod: "CREDIT_CARD", planCode: planCodeLabel, billingCycle },
    });
    return "Não consegui gerar seu link de pagamento agora. Tente novamente em instantes.";
  }
}

// -------------------- Core --------------------
async function trackInboundActivity({ waId, status }) {
  const currentMeta = (await getActivityMeta(waId)) || {};
  const hadLastInbound = Boolean(String(currentMeta?.lastInboundAt || "").trim());
  const now = nowIso();
  const flood = currentMeta?.flood || {};
  const lastMessageAt = flood?.lastMessageAt || currentMeta?.lastInboundAt || "";
  const deltaMs = diffMsSafe(lastMessageAt, now);

  let nextFlood;
  if (deltaMs !== null && deltaMs >= 0 && deltaMs <= 8_000) {
    nextFlood = {
      windowStartAt: flood?.windowStartAt || lastMessageAt || now,
      count: Number(flood?.count || 0) + 1,
      lastMessageAt: now,
      warnedAt: flood?.warnedAt || "",
    };
  } else {
    nextFlood = {
      windowStartAt: now,
      count: 1,
      lastMessageAt: now,
      warnedAt: flood?.warnedAt || "",
    };
  }

  const shouldWarn = shouldWarnFlood({ flood: nextFlood }, now);
  if (shouldWarn) nextFlood.warnedAt = now;

  await Promise.all([
    setLastInboundAt(waId, now),
    setFloodMeta(waId, nextFlood),
  ]);

  const wasIdleLongEnough = (() => {
    if (!isTransientFlowStatus(status)) return false;
    const diff = diffMsSafe(currentMeta?.lastInboundAt, now);
    return diff !== null && diff >= 5 * 60 * 1000;
  })();

  return {
    shouldWarnFlood: shouldWarn,
    shouldPrefixIdleNudge: wasIdleLongEnough,
    isFirstInbound: !hadLastInbound,
  };
}

export async function handleInboundText({ waId, userId, text, identityContext = {} }) {
  const id = cleanText(userId || waId);
  const inbound = cleanText(text);

  if (!id || !inbound) return noReply();

  await ensureUserExists(id);
  await clearPostAdIdleReminder(id);

  const currentStatus = await getUserStatus(id);
  const activity = await trackInboundActivity({ waId: id, status: currentStatus });
  await resolveAndTrackCampaignClick(id);
  if (activity?.isFirstInbound) {
    await trackFlowMetricSafe(trackFirstInboundReceived, id, { step: currentStatus || ST.WAIT_NAME });
  }
  const outcome = await handleInboundTextCore({ userId: id, text: inbound, identityContext });

  const prefixes = [];
  if (activity.shouldWarnFlood) {
    prefixes.push(await getCopyText("FLOW_FLOOD_NOTICE", { waId: id }));
  }

  return prependReplies(outcome, prefixes);
}

async function handleInboundTextCore({ waId, userId, text, identityContext = {} }) {
  const id = cleanText(userId || waId);
  const inbound = cleanText(text);

  if (!id || !inbound) return noReply();

  await ensureUserExists(id);

  // ✅ Regra de consistência: usuário só pode estar ACTIVE com plano pago associado.
  // Se por qualquer motivo estiver ACTIVE sem plano, rebaixamos para TRIAL automaticamente.
  const _st0 = await getUserStatus(id);
  const _pl0 = await getUserPlan(id);
  if (_st0 === ST.ACTIVE && !_pl0) {
    await setUserStatus(id, ST.TRIAL);
  }

  // Comandos globais de preferência de template
  if (wantsTemplateCommand(inbound)) {
    await setTemplateMode(id, "FIXED");
    return reply(await msgTemplateSet(id, "FIXED"));
  }
  if (wantsFreeCommand(inbound)) {
    await setTemplateMode(id, "FREE");
    return reply(await msgTemplateSet(id, "FREE"));
  }

  // Comando global: MENU
  if (wantsMenuCommand(inbound)) {
    const cur = await getUserStatus(id);
    await setMenuPrevStatus(id, cur);
    await setUserStatus(id, ST.WAIT_MENU);
    return reply(await msgMenuMain(id));
  }

  const status = await getUserStatus(id);

  // ✅ Segurança: ACTIVE sem plano nunca pode continuar
  if (status === ST.ACTIVE) {
    const planCode = await getUserPlan(id);
    if (!planCode) {
      return reply(await getCopyText("FLOW_ACTIVE_NO_PLAN_ERROR", { waId: id }));
    }
  }

  // ✅ Primeiro contato (ou usuário sem nome): sempre pedir nome antes de seguir no fluxo.
  // Mantém comandos globais (TEMPLATE/LIVRE/MENU) funcionando acima.
  const __name = await getUserFullName(id);
  if (!__name && ![ST.WAIT_NAME, ST.WAIT_MENU_NEW_NAME, ST.WAIT_MENU_NEW_DOC, ST.WAIT_MENU_EDIT_VALUE].includes(status)) {
    await setUserStatus(id, ST.WAIT_NAME);
    return reply(await msgAskName(id));
  }

  if (status === ST.BLOCKED) {
    return reply(await getCopyText("FLOW_BLOCKED", { waId: id }));
  }

  // 0) MENU (estado dedicado)
  if (status === ST.WAIT_MENU) {
    const choice = normalizeMenuChoice(inbound);

    if (!choice) {
      const prev = await getMenuPrevStatus(id);
      await clearMenuPrevStatus(id);
      await clearMenuEditContext(id);
      if (prev && prev !== ST.WAIT_MENU) {
        await setUserStatus(id, prev);
      } else {
        await setUserStatus(id, ST.WAIT_PRODUCT);
      }
      return await handleInboundTextCore({ userId: id, text: inbound });
    }

    if (choice === "1") {
      await setUserStatus(id, ST.WAIT_MENU_SUBSCRIPTION);
      return reply(await msgMenuSubscription(id));
    }

    if (choice === "2") {
      await setUserStatus(id, ST.WAIT_MENU_EDIT_ROOT);
      return reply(await msgMenuEditRoot(id));
    }

    if (choice === "3") {
      return reply(await msgPlansOnly(id));
    }

    if (choice === "4") {
      return reply(await msgMenuUrlHelp(id));
    }

    return reply(await msgMenuMain(id));
  }

  if (status === ST.WAIT_MENU_SUBSCRIPTION) {
    const choice = normalizeMenuChoice(inbound);
    if (choice === "1") {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply(await msgPlansOnly(id));
    }

    if (choice === "2") {
      const subId = await getAsaasSubscriptionId(id);
      if (!subId) return reply(await msgMenuCancelNotFound(id));

      let nextDue = "";
      try {
        const sub = await getSubscription({ subscriptionId: subId });
        nextDue = String(sub?.nextDueDate || sub?.nextPaymentDate || "").trim();
        if (nextDue) await setCardValidUntil(id, nextDue);
      } catch (_) {}

      await cancelSubscription({ subscriptionId: subId });
      await setCardCanceledAt(id, new Date().toISOString());

      const renewalBr = formatDateBR(nextDue) || formatDateBR(await getCardValidUntil(id)) || "—";
      const days = daysUntilISO(nextDue || (await getCardValidUntil(id)));
      const daysLeft = typeof days === "number" ? String(days) : "—";
      return reply(await msgMenuCancelOk(id, { renewalBr, daysLeft }));
    }

    if (choice === "3") return reply(await msgMenuUrlHelp(id));
    if (choice === "4") {
      await setUserStatus(id, ST.WAIT_MENU);
      return reply(await msgMenuMain(id));
    }

    return reply(await msgMenuSubscription(id));
  }

  if (status === ST.WAIT_MENU_EDIT_ROOT) {
    const choice = normalizeMenuChoice(inbound);
    if (choice === "1") {
      await setUserStatus(id, ST.WAIT_MENU_EDIT_PERSONAL);
      return reply(await msgMenuEditPersonal(id));
    }
    if (choice === "2") {
      await setUserStatus(id, ST.WAIT_MENU_EDIT_COMPANY);
      return reply(await msgMenuEditCompany(id));
    }
    if (choice === "3") {
      await setUserStatus(id, ST.WAIT_MENU_EDIT_TEMPLATE);
      return reply(await msgMenuEditTemplate(id));
    }
    if (choice === "4") return reply(await msgMenuUrlHelp(id));
    if (choice === "5") {
      await setUserStatus(id, ST.WAIT_MENU);
      return reply(await msgMenuMain(id));
    }
    return reply(await msgMenuEditRoot(id));
  }

  if (status === ST.WAIT_MENU_EDIT_PERSONAL) {
    const choice = normalizeMenuChoice(inbound);
    if (choice === "5") {
      await setUserStatus(id, ST.WAIT_MENU_EDIT_ROOT);
      await clearMenuEditContext(id);
      return reply(await msgMenuEditRoot(id));
    }

    const options = await buildPersonalMenuOptions(id);
    const selected = options.find((item) => item.number === choice);
    if (!selected) return reply(await msgMenuEditPersonal(id));

    const nextStatus = selected.field === "fullName" ? ST.WAIT_MENU_NEW_NAME : selected.field === "docMasked" ? ST.WAIT_MENU_NEW_DOC : ST.WAIT_MENU_EDIT_VALUE;
    await setMenuEditContext(id, { group: "personal", field: selected.field, returnStatus: ST.WAIT_MENU_EDIT_PERSONAL });
    await setUserStatus(id, nextStatus);

    if (selected.field === "fullName") return reply(await msgMenuAskNewName(id));
    if (selected.field === "docMasked") return reply(await msgMenuAskNewDoc(id));
    return reply(await msgMenuAskEditField(id, { field: selected.field }));
  }

  if (status === ST.WAIT_MENU_EDIT_COMPANY) {
    const choice = normalizeMenuChoice(inbound);
    if (choice === "8") {
      await setUserStatus(id, ST.WAIT_MENU_EDIT_ROOT);
      await clearMenuEditContext(id);
      return reply(await msgMenuEditRoot(id));
    }

    const options = await buildCompanyMenuOptions(id);
    const selected = options.find((item) => item.number === choice);
    if (!selected) return reply(await msgMenuEditCompany(id));

    await setMenuEditContext(id, { group: "company", field: selected.field, returnStatus: ST.WAIT_MENU_EDIT_COMPANY });
    await setUserStatus(id, ST.WAIT_MENU_EDIT_VALUE);
    return reply(await msgMenuAskEditField(id, { field: selected.field }));
  }

  if (status === ST.WAIT_MENU_EDIT_TEMPLATE) {
    const choice = normalizeChoice(inbound);
    if (choice === "1") {
      await setTemplateMode(id, "FIXED");
      await setUserStatus(id, ST.WAIT_MENU_EDIT_ROOT);
      return reply(`${await msgTemplateSet(id, "FIXED")}\n\n${await msgMenuEditRoot(id)}`);
    }
    if (choice === "2") {
      await setTemplateMode(id, "FREE");
      await setUserStatus(id, ST.WAIT_MENU_EDIT_ROOT);
      return reply(`${await msgTemplateSet(id, "FREE")}\n\n${await msgMenuEditRoot(id)}`);
    }
    if (normalizeMenuChoice(inbound) === "3") {
      await setUserStatus(id, ST.WAIT_MENU_EDIT_ROOT);
      return reply(await msgMenuEditRoot(id));
    }
    return reply(await msgMenuEditTemplate(id));
  }

  if (status === ST.WAIT_MENU_NEW_NAME) {
    const name = cleanText(inbound);
    if (name.length < 3) return reply(await getCopyText("FLOW_NAME_TOO_SHORT", { waId: id }));
    await setUserFullName(id, name);

    const ctx = await getMenuEditContext(id);
    const returnStatus = ctx?.returnStatus || ST.WAIT_MENU;
    await clearMenuEditContext(id);
    await setUserStatus(id, returnStatus);

    const nextMessage = returnStatus === ST.WAIT_MENU_EDIT_PERSONAL ? await msgMenuEditPersonal(id) : await msgMenuMain(id);
    return reply(`${await getCopyText("FLOW_MENU_NAME_UPDATED", { waId: id })}\n\n${nextMessage}`);
  }

  if (status === ST.WAIT_MENU_NEW_DOC) {
    const v = validateDoc(inbound);
    if (!v.ok) return reply(await msgInvalidDoc(id));

    await setUserDocMasked(id, v.type, v.last4);

    const ctx = await getMenuEditContext(id);
    const returnStatus = ctx?.returnStatus || ST.WAIT_MENU;
    await clearMenuEditContext(id);
    await setUserStatus(id, returnStatus);

    const nextMessage = returnStatus === ST.WAIT_MENU_EDIT_PERSONAL ? await msgMenuEditPersonal(id) : await msgMenuMain(id);
    return reply(`${await getCopyText("FLOW_MENU_DOC_UPDATED", { waId: id })}\n\n${nextMessage}`);
  }

  if (status === ST.WAIT_MENU_EDIT_VALUE) {
    const ctx = await getMenuEditContext(id);
    if (!ctx?.field) {
      await setUserStatus(id, ST.WAIT_MENU_EDIT_ROOT);
      return reply(await msgMenuEditRoot(id));
    }

    const value = cleanText(inbound);
    if (!value) return reply(await msgMenuAskEditField(id, ctx));

    if (ctx.group === "personal") {
      if (ctx.field === "billingCityState") await setBillingCityState(id, value);
      if (ctx.field === "billingAddress") await setBillingAddress(id, value.toUpperCase() === "APENAS ONLINE" ? "APENAS ONLINE" : value);
      await setUserStatus(id, ST.WAIT_MENU_EDIT_PERSONAL);
      await clearMenuEditContext(id);
      return reply(`✅ Dado atualizado com sucesso!\n\n${await msgMenuEditPersonal(id)}`);
    }

    const biz = (await getBizProfile(id)) || {};
    if (ctx.group === "company") {
      if (ctx.field === "socials") {
        biz.socials = value.split(/[\n,;]+/).map((item) => cleanText(item)).filter(Boolean);
      } else if (ctx.field === "address") {
        biz.address = value;
      } else if (ctx.field === "productList") {
        biz.productList = value;
      } else {
        biz[ctx.field] = value;
      }
      await setBizProfile(id, biz);
      await setUserStatus(id, ST.WAIT_MENU_EDIT_COMPANY);
      await clearMenuEditContext(id);
      return reply(`✅ Dado atualizado com sucesso!\n\n${await msgMenuEditCompany(id)}`);
    }

    await clearMenuEditContext(id);
    await setUserStatus(id, ST.WAIT_MENU_EDIT_ROOT);
    return reply(await msgMenuEditRoot(id));
  }

  // 0.25) MENU — Dados da empresa (compatibilidade legado)
  if (status === ST.WAIT_MENU_PROFILE) {
    await setUserStatus(id, ST.WAIT_MENU_EDIT_COMPANY);
    return reply(await msgMenuEditCompany(id));
  }

// 0.3) Pós-anúncio — escolha final do modelo padrão (1/2)
  if (status === ST.WAIT_TEMPLATE_MODE) {
    const c = normalizeChoice(inbound);

    if (c !== "1" && c !== "2") {
      return reply(await msgAfterAdAskTemplateChoice(id, "FREE"));
    }

    const mode = c === "2" ? "FREE" : "FIXED";
    await setTemplateMode(id, mode);
    await setTemplatePrompted(id, true);

    const currentBiz = await getBizProfile(id);
    await setPendingBizProfile(id, (currentBiz && typeof currentBiz === "object") ? currentBiz : {});
    await setUserStatus(id, ST.WAIT_SAVE_PROFILE);
    return replyMulti([await msgTemplateSet(id, mode), await msgAskProfileRegistration(id)]);
  }

  // 0.4) Pós-anúncio — cadastro dos dados da empresa (1/2)
  if (status === ST.WAIT_SAVE_PROFILE) {
    const c = normalizeChoice(inbound);

    if (c === "1") {
      const current = await getBizProfile(id);
      const pending =
        (await getPendingBizProfile(id)) ||
        (current && typeof current === "object" ? current : {});

      await setPendingBizProfile(id, pending);
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_COMPANY);

      const msg = [
        await getCopyText("FLOW_PROFILE_WIZARD_INTRO", { waId: id }),
        "",
        await getCopyText("FLOW_PROFILE_WIZARD_STEP1_COMPANY", { waId: id }),
      ].join("\n");
      return reply(msg);
    }

    if (c === "2") {
      await clearPendingBizProfile(id);

      const prev = await getPrevStatus(id);
      await clearPrevStatus(id);
      if (prev && prev !== ST.WAIT_SAVE_PROFILE) await setUserStatus(id, prev);
      else await setUserStatus(id, ST.WAIT_PRODUCT);

      const isTrialNow = prev !== ST.ACTIVE;
      const maxRef = await resolveMaxRefinementsForUser(id, isTrialNow);
      return replyMulti(await buildPostProfilePrompt({ waId: id, saved: false, maxRefinements: maxRef }));
    }

    return reply(await msgAskProfileRegistration(id));
  }

  // 0.41) Pós-primeiro resultado — descoberta do modelo LIVRE
  if (status === ST.WAIT_FIRST_RESULT_PROMPT) {
    const c = normalizeChoice(inbound);

    if (c === "1" || c === "2") {
      const result = await handleFirstResultFlowChoice({ waId: id, choice: c });
      if (result) return result;
    }

    if (c === "3") {
      await setUserStatus(id, ST.WAIT_FIRST_RESULT_EXPLAIN);
      return reply(await msgFirstResultExplain(id));
    }

    return reply(await msgFirstResultPrompt(id));
  }

  if (status === ST.WAIT_FIRST_RESULT_EXPLAIN) {
    const c = normalizeChoice(inbound);

    if (c === "1" || c === "2") {
      const result = await handleFirstResultFlowChoice({ waId: id, choice: c });
      if (result) return result;
    }

    return reply(await msgFirstResultExplain(id));
  }

  // 0.42) Compatibilidade de estado legado de feedback
  if (status === ST.WAIT_FEEDBACK_RESPONSE) {
    const prev = await getPrevStatus(id);
    await clearPrevStatus(id);
    await setUserStatus(id, prev || ST.ACTIVE);
    await armPostAdIdleReminder(id, "REFINE_OR_OK");
    return reply(await msgRefinementPrompt(id, await resolveMaxRefinementsForUser(id, (prev || ST.ACTIVE) === ST.TRIAL)));
  }

  // 0.44) Desambiguação curta de categoria quando o motor detectar conflito
  if (status === ST.WAIT_CATEGORY_DISAMBIGUATION) {
    const intake = await getAdSessionPayload(id);

    if (!intake?.baseText) {
      await clearAdSessionPayload(id);
      await setUserStatus(id, ST.WAIT_PRODUCT);
      return reply(await msgAskProduct(id));
    }

    const choice = normalizeChoice(inbound);
    if (!["1", "2", "3"].includes(choice)) {
      return reply(String(intake.prompt || "").trim() || "Responda só com 1, 2 ou 3.");
    }

    const baseStatus = intake.prevStatus === ST.ACTIVE ? ST.ACTIVE : ST.TRIAL;
    const isTrialFlow = baseStatus !== ST.ACTIVE;
    const bizProfile = await getBizProfile(id);

    const selectedSchemaKey = choice === "1"
      ? String(intake.primaryCategoryKey || "").trim().toUpperCase()
      : choice === "2"
        ? String(intake.runnerUpCategoryKey || "").trim().toUpperCase()
        : "GENERIC";

    const intakePlan = buildCategoryIntakePlan({
      text: intake.baseText,
      bizProfile,
      attemptCount: 1,
      forcedSchemaKey: selectedSchemaKey,
      skipDisambiguation: true,
    });

    await clearAdSessionPayload(id);
    await setUserStatus(id, baseStatus);

    if (intakePlan.shouldAsk) {
      await setAdSessionPayload(id, {
        kind: "CATEGORY_DETAILS",
        baseText: intake.baseText,
        prevStatus: baseStatus,
        categoryKey: intakePlan.schema.key,
        categoryLabel: intakePlan.schema.label,
        intentKey: intakePlan.intentDecision?.intentKey || AD_INTENTS.SPECIFIC_ITEM,
        intentLabel: getIntentInstructionLabel(intakePlan.intentDecision?.intentKey || AD_INTENTS.SPECIFIC_ITEM),
        askedFieldKeys: intakePlan.fieldsToAsk.map((field) => field.key),
        scoreBeforeAsk: intakePlan.completeness.score,
        attemptCount: 1,
      });
      await setUserStatus(id, ST.WAIT_CATEGORY_DETAILS);
      return reply(intakePlan.prompt);
    }

    return await handleGenerateAdInTrialOrActive({
      waId: id,
      inboundText: intake.baseText,
      isTrial: isTrialFlow,
      currentStatus: baseStatus,
      skipCategoryIntake: true,
    });
  }

  // 0.445) Desambiguação curta da intenção do anúncio
  if (status === ST.WAIT_INTENT_DISAMBIGUATION) {
    const intake = await getAdSessionPayload(id);

    if (!intake?.baseText) {
      await clearAdSessionPayload(id);
      await setUserStatus(id, ST.WAIT_PRODUCT);
      return reply(await msgAskProduct(id));
    }

    const choice = normalizeChoice(inbound);
    if (!["1", "2", "3"].includes(choice)) {
      return reply(String(intake.prompt || "").trim() || "Responda só com 1, 2 ou 3.");
    }

    const baseStatus = intake.prevStatus === ST.ACTIVE ? ST.ACTIVE : ST.TRIAL;
    const isTrialFlow = baseStatus !== ST.ACTIVE;
    const bizProfile = await getBizProfile(id);

    const selectedIntentKey = choice === "1"
      ? String(intake.primaryIntentKey || "").trim().toUpperCase()
      : choice === "2"
        ? String(intake.runnerUpIntentKey || "").trim().toUpperCase()
        : AD_INTENTS.SPECIFIC_ITEM;

    const intakePlan = buildCategoryIntakePlan({
      text: intake.baseText,
      bizProfile,
      attemptCount: 1,
      forcedSchemaKey: intake.categoryKey || "",
      forcedIntentKey: selectedIntentKey,
      skipDisambiguation: true,
      skipIntentDisambiguation: true,
    });

    await clearAdSessionPayload(id);
    await setUserStatus(id, baseStatus);

    if (intakePlan.shouldAsk) {
      await setAdSessionPayload(id, {
        kind: "CATEGORY_DETAILS",
        baseText: intake.baseText,
        prevStatus: baseStatus,
        categoryKey: intakePlan.schema.key,
        categoryLabel: intakePlan.schema.label,
        intentKey: intakePlan.intentDecision?.intentKey || selectedIntentKey,
        intentLabel: getIntentInstructionLabel(intakePlan.intentDecision?.intentKey || selectedIntentKey),
        askedFieldKeys: intakePlan.fieldsToAsk.map((field) => field.key),
        scoreBeforeAsk: intakePlan.completeness.score,
        attemptCount: 1,
      });
      await setUserStatus(id, ST.WAIT_CATEGORY_DETAILS);
      return reply(intakePlan.prompt);
    }

    return await handleGenerateAdInTrialOrActive({
      waId: id,
      inboundText: intake.baseText,
      isTrial: isTrialFlow,
      currentStatus: baseStatus,
      skipCategoryIntake: true,
      forcedSchemaKey: intake.categoryKey || "",
      forcedIntentKey: intakePlan.intentDecision?.intentKey || selectedIntentKey,
    });
  }

  // 0.45) Complemento de informações antes de gerar anúncio
  if (status === ST.WAIT_CATEGORY_DETAILS) {
    const intake = await getAdSessionPayload(id);

    if (!intake?.baseText) {
      await clearAdSessionPayload(id);
      await setUserStatus(id, ST.WAIT_PRODUCT);
      return reply(await msgAskProduct(id));
    }

    const baseStatus = intake.prevStatus === ST.ACTIVE ? ST.ACTIVE : ST.TRIAL;
    const isTrialFlow = baseStatus !== ST.ACTIVE;

    await clearAdSessionPayload(id);
    await setUserStatus(id, baseStatus);

    if (wantsSkipCommand(inbound) || wantsOkCommand(inbound)) {
      return await handleGenerateAdInTrialOrActive({
        waId: id,
        inboundText: intake.baseText,
        isTrial: isTrialFlow,
        currentStatus: baseStatus,
        skipCategoryIntake: true,
        forcedSchemaKey: intake.categoryKey || "",
        forcedIntentKey: intake.intentKey || "",
      });
    }

    const combinedText = buildLeadIntakeCombinedText(intake.baseText, inbound);
    return await handleGenerateAdInTrialOrActive({
      waId: id,
      inboundText: combinedText,
      isTrial: isTrialFlow,
      currentStatus: baseStatus,
      skipCategoryIntake: true,
      forcedSchemaKey: intake.categoryKey || "",
      forcedIntentKey: intake.intentKey || "",
    });
  }

  // 0.5) Wizard — adicionar/ajustar dados da empresa (manual)
  if (
    status === ST.WAIT_PROFILE_ADD_COMPANY ||
    status === ST.WAIT_PROFILE_ADD_WHATSAPP ||
    status === ST.WAIT_PROFILE_ADD_ADDRESS ||
    status === ST.WAIT_PROFILE_ADD_HOURS ||
    status === ST.WAIT_PROFILE_ADD_SOCIAL ||
    status === ST.WAIT_PROFILE_ADD_WEBSITE ||
    status === ST.WAIT_PROFILE_ADD_PRODUCTS
  ) {
    const pending = (await getPendingBizProfile(id)) || {};
    const profile = pending && typeof pending === "object" ? pending : {};

    // Etapa 1: nome da empresa
    if (status === ST.WAIT_PROFILE_ADD_COMPANY) {
      if (!wantsSkipCommand(inbound)) {
        const name = cleanText(inbound);
        if (name.length >= 2) profile.companyName = name;
      }
      await setPendingBizProfile(id, profile);
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_WHATSAPP);
      return reply(await getCopyText("FLOW_PROFILE_WIZARD_STEP2_WHATSAPP", { waId: id }));
    }

    // Etapa 2: whatsapp
    if (status === ST.WAIT_PROFILE_ADD_WHATSAPP) {
      if (!wantsSkipCommand(inbound)) {
        const wa = cleanText(inbound);
        if (wa.length >= 8) profile.whatsapp = normalizeWhatsappLike(wa);
      }
      await setPendingBizProfile(id, profile);
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_ADDRESS);
      return reply(await getCopyText("FLOW_PROFILE_WIZARD_STEP3_ADDRESS", { waId: id }));
    }

    // Etapa 3: endereço/local
    if (status === ST.WAIT_PROFILE_ADD_ADDRESS) {
      if (!wantsSkipCommand(inbound)) {
        const s = cleanText(inbound);
        if (upper(s) === "APENAS ATENDIMENTO ONLINE") {
          profile.location = "Apenas atendimento online";
        } else if (s.length >= 2) {
          profile.location = s;
        }
      }
      await setPendingBizProfile(id, profile);
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_HOURS);
      return reply(await getCopyText("FLOW_PROFILE_WIZARD_STEP4_HOURS", { waId: id }));
    }

    // Etapa 4: horário
    if (status === ST.WAIT_PROFILE_ADD_HOURS) {
      if (!wantsSkipCommand(inbound)) {
        const s = cleanText(inbound);
        if (s.length >= 2) profile.hours = s;
      }
      await setPendingBizProfile(id, profile);
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_SOCIAL);
      return reply(await getCopyText("FLOW_PROFILE_WIZARD_STEP5_SOCIAL", { waId: id }));
    }

    // Etapa 5: redes sociais (loop)
    if (status === ST.WAIT_PROFILE_ADD_SOCIAL) {
      if (wantsSkipCommand(inbound) || wantsFinishCommand(inbound)) {
        await setPendingBizProfile(id, profile);
        await setUserStatus(id, ST.WAIT_PROFILE_ADD_WEBSITE);
        return reply(await getCopyText("FLOW_PROFILE_WIZARD_STEP6_WEBSITE", { waId: id }));
      }

      const url = normalizeUrlLike(inbound);
      if (url) {
        const arr = ensureArray(profile.socials);
        arr.push(url);
        // dedupe simples
        profile.socials = Array.from(new Set(arr.map((x) => String(x).trim()).filter(Boolean)));
        await setPendingBizProfile(id, profile);
        return reply(await getCopyText("FLOW_PROFILE_WIZARD_SOCIAL_ADDED", { waId: id }));
      }

      return reply(await getCopyText("FLOW_PROFILE_WIZARD_SOCIAL_INVALID", { waId: id }));
    }

    // Etapa 6: website
    if (status === ST.WAIT_PROFILE_ADD_WEBSITE) {
      if (!wantsSkipCommand(inbound)) {
        const url = normalizeUrlLike(inbound);
        if (url) profile.website = url;
      }
      await setPendingBizProfile(id, profile);
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_PRODUCTS);
      return reply(await getCopyText("FLOW_PROFILE_WIZARD_STEP7_PRODUCTS", { waId: id }));
    }

    // Etapa 7: lista de produtos
    if (status === ST.WAIT_PROFILE_ADD_PRODUCTS) {
      if (!wantsSkipCommand(inbound)) {
        const url = normalizeUrlLike(inbound);
        if (url) profile.productList = url;
      }

      // salva direto (o usuário escolheu "Adicionar dados")
      await setBizProfile(id, profile);
      await clearPendingBizProfile(id);

      const prev = await getPrevStatus(id);
      await clearPrevStatus(id);
      if (prev && prev !== ST.WAIT_SAVE_PROFILE) await setUserStatus(id, prev);
      else await setUserStatus(id, ST.WAIT_PRODUCT);

      const isTrialNow = prev !== ST.ACTIVE;
      const maxRef = await resolveMaxRefinementsForUser(id, isTrialNow);
      return replyMulti(await buildPostProfilePrompt({ waId: id, saved: true, maxRefinements: maxRef }));
    }
  }

// ✅ Se o usuário manda "oi" e ainda não tem nome, inicia onboarding
  if (isGreeting(inbound)) {
    const name = await getUserFullName(id);
    if (!name) {
      await setUserStatus(id, ST.WAIT_NAME);
      return reply(await msgAskName(id));
    }
  }

  // 1) Onboarding: nome
  if (status === ST.WAIT_NAME) {
    const name = cleanText(inbound);
    if (name.length < 3) return reply(await getCopyText("FLOW_NAME_TOO_SHORT", { waId: id }));
    await setUserFullName(id, name);
    await setUserStatus(id, ST.WAIT_PRODUCT);
    await trackFlowMetricSafe(trackTrialStarted, id, { step: ST.WAIT_PRODUCT });
    return reply(await msgAskProduct(id));
  }

  // 2) Onboarding: produto/serviço
  if (status === ST.WAIT_PRODUCT) {
    if (isGreeting(inbound)) return reply(await msgAskProduct(id));
    return await handleGenerateAdInTrialOrActive({ waId: id, inboundText: inbound, isTrial: true, currentStatus: status });
  }

  // 3) Trial
  if (status === ST.TRIAL) {
    if (isGreeting(inbound)) return reply(await msgAskProduct(id));
    return await handleGenerateAdInTrialOrActive({ waId: id, inboundText: inbound, isTrial: true, currentStatus: status });
  }

  // 4) Escolha de plano
  if (status === ST.WAIT_PLAN) {
    const choice = normalizeChoice(inbound);
    const plan = await getPlanByChoice(choice);
    if (!plan) return reply(await msgPlansOnly(id));

    await clearCheckoutQuoteState(id, {
      releaseReservation: true,
      reason: "plan_changed",
      meta: { nextPlanCode: plan.code },
    });
    await clearSelectedBillingCycle(id);
    await setSelectedPlanCode(id, plan.code);
    await setUserPlan(id, plan.code);
    await markCheckoutInteraction(id, { started: true });
    await trackFlowMetricSafe(trackPlanSelected, id, { planCode: plan.code, step: ST.WAIT_PLAN });
    await setUserStatus(id, ST.WAIT_BILLING_CYCLE);

    return reply(await msgAskBillingCycle(id, plan));
  }

  // 4.1) Compatibilidade de estado legado de upgrade
  if (status === ST.WAIT_UPGRADE_CHOICE) {
    await setUserStatus(id, ST.WAIT_PLAN);
    return reply(await msgPlansOnly(id));
  }

  // 4.2) Escolha do ciclo de cobrança
  if (status === ST.WAIT_BILLING_CYCLE) {
    const billingCycle = normalizeBillingCycleChoice(inbound);
    const plan = await getSelectedCheckoutPlan(id);

    if (!plan) {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply(await msgPlansOnly(id));
    }

    if (!billingCycle) return reply(await msgAskBillingCycle(id, plan));

    await clearCheckoutQuoteState(id, {
      releaseReservation: true,
      reason: "billing_cycle_changed",
      meta: { planCode: plan.code, billingCycle },
    });
    await setSelectedBillingCycle(id, billingCycle);
    await markCheckoutInteraction(id);
    await trackFlowMetricSafe(trackBillingCycleSelected, id, {
      planCode: plan.code,
      billingCycle,
      step: ST.WAIT_BILLING_CYCLE,
    });
    await setUserStatus(id, ST.WAIT_COUPON_CODE);
    return reply(await msgAskCouponCode(id, plan, billingCycle));
  }

  // 4.3) Cupom
  if (status === ST.WAIT_COUPON_CODE) {
    const selection = await getCurrentCheckoutSelection(id);
    if (!selection.planCode || !selection.plan) {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply(await msgPlansOnly(id));
    }

    const billingCycle = selection.billingCycle || "monthly";

    if (wantsNoCouponCommand(inbound)) {
      if (selection.couponCode) {
        await trackFlowMetricSafe(trackCouponRemoved, id, {
          planCode: selection.planCode,
          billingCycle,
          couponCode: selection.couponCode,
          step: ST.WAIT_COUPON_CODE,
        });
      }
      const prepared = await prepareCheckoutQuote(id, {
        planCode: selection.planCode,
        billingCycle,
        couponCode: "",
        identityContext,
      });
      if (!prepared?.ok) {
        if (prepared?.code === "identity_review_pending") {
          return reply(prepared.reason || await msgIdentitySensitiveOpBlocked(id));
        }
        return reply(await msgCouponInvalid(id, prepared?.quote));
      }
      await trackFlowMetricSafe(trackCheckoutStarted, id, {
        planCode: selection.planCode,
        billingCycle,
        step: ST.WAIT_CHECKOUT_CONFIRMATION,
      });
      await setUserStatus(id, ST.WAIT_CHECKOUT_CONFIRMATION);
      return reply(await msgCheckoutSummary(id, prepared.quote));
    }

    const couponCode = cleanText(inbound).toUpperCase();
    if (!couponCode) return reply(await msgAskCouponCode(id, selection.plan, billingCycle));

    await trackFlowMetricSafe(trackCouponCodeEntered, id, {
      planCode: selection.planCode,
      billingCycle,
      couponCode,
      step: ST.WAIT_COUPON_CODE,
    });

    const prepared = await prepareCheckoutQuote(id, {
      planCode: selection.planCode,
      billingCycle,
      couponCode,
      identityContext,
    });

    if (!prepared?.ok) {
      if (prepared?.code === "identity_review_pending") {
        return reply(prepared.reason || await msgIdentitySensitiveOpBlocked(id));
      }
      await trackFlowMetricSafe(trackCouponRejected, id, {
        planCode: selection.planCode,
        billingCycle,
        couponCode,
        step: ST.WAIT_COUPON_CODE,
      });
      return reply(await msgCouponInvalid(id, prepared?.quote));
    }

    await trackFlowMetricSafe(trackCouponApplied, id, {
      planCode: selection.planCode,
      billingCycle,
      couponCode,
      step: ST.WAIT_COUPON_CODE,
    });
    await trackFlowMetricSafe(trackCheckoutStarted, id, {
      planCode: selection.planCode,
      billingCycle,
      couponCode,
      step: ST.WAIT_CHECKOUT_CONFIRMATION,
    });

    await setUserStatus(id, ST.WAIT_CHECKOUT_CONFIRMATION);
    return reply(await msgCheckoutSummary(id, prepared.quote));
  }

  // 4.4) Confirmação do checkout
  if (status === ST.WAIT_CHECKOUT_CONFIRMATION) {
    const selection = await getCurrentCheckoutSelection(id);
    const quote = await getStoredPricingQuote(id);
    const plan = selection.plan || await getSelectedCheckoutPlan(id);

    if (!selection.planCode || !plan || !quote) {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply(await msgPlansOnly(id));
    }

    if (wantsConfirmCheckoutCommand(inbound)) {
      await markCheckoutInteraction(id);
      await trackFlowMetricSafe(trackCheckoutConfirmed, id, {
        planCode: selection.planCode,
        billingCycle: selection.billingCycle || quote?.billingCycle || "monthly",
        couponCode: selection.couponCode || quote?.couponCode || "",
        step: ST.WAIT_CHECKOUT_CONFIRMATION,
      });
      await setUserStatus(id, ST.WAIT_PAYMENT_METHOD);
      return reply(await msgAskPaymentMethod(id, plan, quote));
    }

    if (wantsChangePlanCommand(inbound)) {
      await clearCheckoutQuoteState(id, { releaseReservation: true, reason: "checkout_change_plan" });
      await clearSelectedPlanCode(id);
      await clearSelectedBillingCycle(id);
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply(await msgPlansOnly(id));
    }

    if (wantsChangeBillingCycleCommand(inbound)) {
      await clearCheckoutQuoteState(id, { releaseReservation: true, reason: "checkout_change_cycle" });
      await clearSelectedBillingCycle(id);
      await setUserStatus(id, ST.WAIT_BILLING_CYCLE);
      return reply(await msgAskBillingCycle(id, plan));
    }

    if (wantsChangeCouponCommand(inbound)) {
      await clearCheckoutQuoteState(id, { releaseReservation: true, reason: "checkout_change_coupon" });
      await setUserStatus(id, ST.WAIT_COUPON_CODE);
      return reply(await msgAskCouponCode(id, plan, selection.billingCycle || "monthly"));
    }

    return reply(await msgCheckoutSummary(id, quote));
  }

  // 5) Forma de pagamento
  if (status === ST.WAIT_PAYMENT_METHOD) {
    const c = normalizeChoice(inbound);
    if (c !== "1" && c !== "2") return reply(await getCopyText("FLOW_INVALID_PAYMENT_METHOD", { waId: id }));

    const quote = await getStoredPricingQuote(id);
    if (!quote?.planCode || !quote?.billingCycle) {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply(await msgPlansOnly(id));
    }

    const pm = c === "1" ? "CARD" : "PIX";
    await setPaymentMethod(id, pm);
    await markCheckoutInteraction(id);

    const customerId = await getAsaasCustomerId(id);
    if (customerId) {
      return reply(await createCurrentPlanPayment(id, identityContext));
    }

    await setUserStatus(id, ST.WAIT_DOC);
    return reply(await msgAskDoc(id));
  }

  // 6) Documento (CPF/CNPJ) + prepara cobrança
  if (status === ST.WAIT_DOC) {
    const v = validateDoc(inbound);
    if (!v.ok) return reply(await msgInvalidDoc(id));

    await setUserDocMasked(id, v.type, v.last4);

    const planCode = (await getSelectedPlanCode(id)) || (await getUserPlan(id));
    const plan = planCode ? await getPlan(planCode) : null;
    if (!plan) {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply(await msgPlansOnly(id));
    }

    const pm = await getPaymentMethod(id);
    if (!pm) {
      await setUserStatus(id, ST.WAIT_PAYMENT_METHOD);
      return reply(await msgAskPaymentMethod(id, plan));
    }

    await ensureAsaasCustomer({ waId: id, fullName: await getUserFullName(id), cpfCnpj: v.digits });
    return reply(await createCurrentPlanPayment(id, identityContext));
  }

  // 6.1) Cidade/UF (após pagamento confirmado)
  if (status === ST.WAIT_BILLING_CITY_STATE) {
    const v = String(inbound || "").trim();
    if (!v) return reply(await msgAskBillingCityState(id));

    await setBillingCityState(id, v);
    await setUserStatus(id, ST.WAIT_BILLING_ADDRESS);
    return reply(await msgAskBillingAddress(id));
  }

  // 6.2) Endereço (após pagamento confirmado)
  if (status === ST.WAIT_BILLING_ADDRESS) {
    const v = String(inbound || "").trim();
    if (!v) return reply(await msgAskBillingAddress(id));

    const addr = v.toUpperCase() === "APENAS ONLINE" ? "APENAS ONLINE" : v;
    await setBillingAddress(id, addr);

    const prev = await getPrevStatus(id);
    await clearPrevStatus(id);
    await setUserStatus(id, prev || ST.ACTIVE);

    return reply(await withMenuHint(id, await getCopyText("FLOW_BILLING_UPDATED_SUCCESS", { waId: id })));
  }

  // 6.5) Recuperação de pagamento
  if (status === ST.WAIT_PAYMENT_RECOVERY) {
    const c = normalizeChoice(inbound);
    if (c === "1" || c === "2") {
      await setPaymentMethod(id, c === "1" ? "CARD" : "PIX");
      return reply(await createCurrentPlanPayment(id, identityContext));
    }

    if (c === "3") {
      await markCheckoutInteraction(id);
      await setUserStatus(id, ST.PAYMENT_PENDING);
      return replyMulti([
        await getCopyText("FLOW_MENU_URL_FEEDBACK", { waId: id }),
        await getCopyText("FLOW_PAYMENT_PENDING", { waId: id, vars: { planTxt: "" } }),
      ]);
    }

    return reply(await getCopyText("FLOW_PAYMENT_RECOVERY", { waId: id }));
  }

  // 7) Pagamento pendente
  if (status === ST.PAYMENT_PENDING) {
    if (wantsChangePaymentCommand(inbound)) {
      const quote = await getStoredPricingQuote(id);
      await trackFlowMetricSafe(trackPaymentAbandoned, id, {
        planCode: quote?.planCode || (await getUserPlan(id)) || "",
        billingCycle: quote?.billingCycle || "monthly",
        couponCode: quote?.couponCode || "",
        step: ST.PAYMENT_PENDING,
      });
      const planCode = await getUserPlan(id);
      const plan = (await getMenuPlans()).find((p) => p.code === planCode) || null;
      if (!plan) {
        await setUserStatus(id, ST.WAIT_PLAN);
        return reply(await msgPlansOnly(id));
      }
      await setUserStatus(id, ST.WAIT_PAYMENT_METHOD);
      return reply(await msgAskPaymentMethod(id, plan));
    }

    const quote = await getStoredPricingQuote(id);
    const planCode = (await getSelectedPlanCode(id)) || (await getUserPlan(id));
    const plan = planCode ? await getPlan(planCode) : null;
    const planTxt = quote?.explanation?.description
      ? `${quote.explanation.description}.`
      : plan
        ? `Plano: *${plan.name}*.`
        : "";
    return reply(await getCopyText("FLOW_PAYMENT_PENDING", { waId: id, vars: { planTxt } }));
  }

  // 8) ACTIVE
  if (status === ST.ACTIVE) {
    if (isGreeting(inbound)) return reply(await msgAskProduct(id));
    return await handleGenerateAdInTrialOrActive({ waId: id, inboundText: inbound, isTrial: false, currentStatus: status });
  }

  // fallback seguro
  return reply(await getCopyText("FLOW_FALLBACK_UNKNOWN", { waId: id }));
}

async function getRefinementPolicyForUser(waId, isTrial) {
  const DEFAULT_MAX_REFINEMENTS = 2;

  if (isTrial) {
    return {
      isTrial: true,
      planCode: "",
      maxRefinements: DEFAULT_MAX_REFINEMENTS,
      source: "TRIAL_DEFAULT",
    };
  }

  const planCode = await getUserPlan(waId);
  if (!planCode) {
    return {
      isTrial: false,
      planCode: "",
      maxRefinements: DEFAULT_MAX_REFINEMENTS,
      source: "NO_PLAN_DEFAULT",
    };
  }

  let plan = await getPlan(planCode);
  if (!plan) {
    plan = (await getMenuPlans()).find((p) => p.code === planCode) || null;
  }

  const fromPlan = Number(plan?.maxRefinements);
  const maxRefinements =
    Number.isFinite(fromPlan) && fromPlan >= 0
      ? Math.trunc(fromPlan)
      : DEFAULT_MAX_REFINEMENTS;

  return {
    isTrial: false,
    planCode,
    maxRefinements,
    source: plan ? "PLAN" : "PLAN_NOT_FOUND_DEFAULT",
  };
}

async function resolveMaxRefinementsForUser(waId, isTrial) {
  const policy = await getRefinementPolicyForUser(waId, isTrial);
  return policy.maxRefinements;
}

async function buildPostProfilePrompt({ waId, saved, maxRefinements }) {
  return [await msgAfterSaveProfile(waId, saved, maxRefinements)];
}

async function handlePostAdDecisionCommand({ waId, inboundText }) {
  const lastAd = await getLastAd(waId);
  if (!lastAd) return null;
  if (!wantsOkCommand(inboundText)) return null;

  await clearLastAd(waId);
  await clearRefineCount(waId);
  await clearLastPrompt(waId);

  return reply(await getCopyText("FLOW_OK_NEXT_DESCRIPTION", { waId }));
}

async function renderTemplatePreviewForMode({ waId, sourceText, targetMode }) {
  const baseText = cleanText(sourceText);
  if (!baseText) return "";

  const bizProfile = await getBizProfile(waId);
  const resolvedSchema = detectCategoryDecision(baseText).schema || CATEGORY_SCHEMAS.GENERIC;
  const resolvedIntentKey = detectAdIntentDecision({ text: baseText, schema: resolvedSchema }).intentKey;
  const bizContext = buildBizProfileContext(bizProfile);
  const intentContext = buildIntentContext({ schema: resolvedSchema, intentKey: resolvedIntentKey });
  const promptToSend = buildGenerationPrompt({
    userText: baseText,
    lastAd: "",
    isRefinement: false,
    bizContext,
    intentContext,
  });

  const response = await generateAdText({ userText: promptToSend, mode: targetMode });
  let formattedAd = enforceAdFormatting(response.text || "");
  formattedAd = sanitizeGeneratedAd(formattedAd, bizProfile);
  formattedAd = applyPersistentBusinessInfo(formattedAd, bizProfile, baseText, false);
  formattedAd = sanitizeGeneratedAd(formattedAd, bizProfile);
  formattedAd = enforceAdFormatting(formattedAd);
  return formattedAd;
}

async function handleFirstResultFlowChoice({ waId, choice }) {
  const id = waId;

  if (choice === "2") {
    await setTemplateMode(id, "FIXED");
    await setTemplatePrompted(id, true);

    const currentBiz = await getBizProfile(id);
    await setPendingBizProfile(id, (currentBiz && typeof currentBiz === "object") ? currentBiz : {});
    await setUserStatus(id, ST.WAIT_SAVE_PROFILE);
    return replyMulti([await msgTemplateSet(id, "FIXED"), await msgAskProfileRegistration(id)]);
  }

  if (choice !== "1") return null;

  const sourceText = await getLastPrompt(id);
  if (!sourceText) {
    await setUserStatus(id, ST.WAIT_FIRST_RESULT_PROMPT);
    return reply(await msgFirstResultPrompt(id));
  }

  let freePreview = "";
  try {
    freePreview = await renderTemplatePreviewForMode({
      waId: id,
      sourceText,
      targetMode: "FREE",
    });
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.OPENAI_ERROR, id, err, {
      event: "flow_template_preview_generation_failed",
      step: "handleFirstResultFlowChoice",
      meta: { targetMode: "FREE" },
    });
    return reply(await getCopyText("FLOW_OPENAI_ERROR", { waId: id }));
  }

  await setUserStatus(id, ST.WAIT_TEMPLATE_MODE);
  return replyMulti([
    await msgFirstResultShowFree(id),
    freePreview,
    await msgAfterAdAskTemplateChoice(id, "FREE"),
  ]);
}

// -------------------- Generate Ad --------------------
async function handleGenerateAdInTrialOrActive({ waId, inboundText, isTrial, currentStatus, skipCategoryIntake = false, forcedSchemaKey = "", forcedIntentKey = "" }) {
  const id = waId;
  const userText = inboundText;

  const postAdDecision = await handlePostAdDecisionCommand({ waId: id, inboundText: userText });
  if (postAdDecision) return postAdDecision;

  const lastAd = await getLastAd(id);
  const isRefinement = !!lastAd;
  const bizProfile = await getBizProfile(id);

  if (!isRefinement && !skipCategoryIntake) {
    const intakePlan = buildCategoryIntakePlan({ text: userText, bizProfile, attemptCount: 0, forcedSchemaKey, forcedIntentKey });

    if (intakePlan.shouldAskDisambiguation) {
      await setAdSessionPayload(id, {
        kind: "CATEGORY_DISAMBIGUATION",
        baseText: userText,
        prevStatus: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
        primaryCategoryKey: intakePlan.schema.key,
        runnerUpCategoryKey: intakePlan.detection?.runnerUp?.schema?.key || "",
        prompt: intakePlan.prompt || "",
        confidence: intakePlan.detection?.confidence || "medium",
      });
      await setUserStatus(id, ST.WAIT_CATEGORY_DISAMBIGUATION);
      return reply(intakePlan.prompt);
    }

    if (intakePlan.shouldAskIntentDisambiguation) {
      await setAdSessionPayload(id, {
        kind: "INTENT_DISAMBIGUATION",
        baseText: userText,
        prevStatus: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
        categoryKey: intakePlan.schema.key,
        categoryLabel: intakePlan.schema.label,
        primaryIntentKey: intakePlan.intentDecision?.intentKey || AD_INTENTS.SPECIFIC_ITEM,
        runnerUpIntentKey: intakePlan.intentDecision?.runnerUpIntentKey || "",
        prompt: intakePlan.prompt || "",
        confidence: intakePlan.intentDecision?.confidence || "medium",
      });
      await setUserStatus(id, ST.WAIT_INTENT_DISAMBIGUATION);
      return reply(intakePlan.prompt);
    }

    if (intakePlan.shouldAsk) {
      await setAdSessionPayload(id, {
        kind: "CATEGORY_DETAILS",
        baseText: userText,
        prevStatus: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
        categoryKey: intakePlan.schema.key,
        categoryLabel: intakePlan.schema.label,
        intentKey: intakePlan.intentDecision?.intentKey || AD_INTENTS.SPECIFIC_ITEM,
        intentLabel: getIntentInstructionLabel(intakePlan.intentDecision?.intentKey || AD_INTENTS.SPECIFIC_ITEM),
        askedFieldKeys: intakePlan.fieldsToAsk.map((field) => field.key),
        scoreBeforeAsk: intakePlan.completeness.score,
        attemptCount: 1,
      });
      await setUserStatus(id, ST.WAIT_CATEGORY_DETAILS);
      return reply(intakePlan.prompt);
    }
  }

  // Regra de consumo (refinamentos):
  // - 1 descrição inicial sempre consome 1 crédito
  // - Refinamentos "grátis" por descrição = maxRefinements do plano
  // - Ao ultrapassar o limite, consome +1 crédito e reinicia o ciclo (refineCount volta para 1)
  //   Ex.: maxRefinements=2 => consome no refinamento 3,5,7...

  const maxRefinements = await resolveMaxRefinementsForUser(id, isTrial);

  const currentRefines = isRefinement ? await getRefineCount(id) : 0; // refinamentos na "rodada" atual
  const attemptedNext = isRefinement ? (currentRefines + 1) : 0;

  const willConsumeExtraCredit = isRefinement && attemptedNext > maxRefinements;
  const nextRefines = isRefinement ? (willConsumeExtraCredit ? 1 : attemptedNext) : 0;

  const creditsNeeded = isRefinement ? (willConsumeExtraCredit ? 1 : 0) : 1;

  // TRIAL: checa limite (considera refinamentos que não consomem crédito)
  if (isTrial) {
    const used = await getUserTrialUsed(id);
    const trialLimit = await getTrialMaxDescriptions();
    if (creditsNeeded > 0 && used >= trialLimit) {
      await trackFlowMetricSafe(trackTrialLimitReached, id, {
        step: currentStatus || ST.TRIAL,
      });
      await setUserStatus(id, ST.WAIT_PLAN);
      return replyMulti([
        await getCopyText("FLOW_PLAN_VALUE_REINFORCEMENT", { waId: id }),
        await msgTrialOverAndPlans(id),
      ]);
    }
  } else {
    // ACTIVE: checa validade do cartão (quando recorrência foi cancelada)
    const validUntil = await getCardValidUntil(id);
    if (validUntil && !isISODateInFutureOrToday(validUntil)) {
      const pm = await getPaymentMethod(id);
      if (pm === "CARD") {
        await setUserStatus(id, ST.WAIT_PLAN);
        return reply((await getCopyText("FLOW_QUOTA_BLOCKED", { waId: id })) + "\n\n" + (await msgPlansOnly(id)));
      }
    }

    // ACTIVE: checa quota do plano
    const planCode = await getUserPlan(id);
    const plan = (await getMenuPlans()).find((p) => p.code === planCode);
    if (!plan) {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply(await msgPlansOnly(id));
    }

    const used = await getUserQuotaUsed(id);
    if (used >= Number(plan.monthlyQuota || 0)) {
      await setUserStatus(id, ST.WAIT_PLAN);
      return replyMulti([
        await getCopyText("FLOW_QUOTA_REACHED_PREFIX", { waId: id }),
        await msgPlansOnly(id),
      ]);
    }
  }

  const mode = await getTemplateMode(id);

  const resolvedSchema = forcedSchemaKey && CATEGORY_SCHEMAS[String(forcedSchemaKey || "").trim().toUpperCase()]
    ? CATEGORY_SCHEMAS[String(forcedSchemaKey || "").trim().toUpperCase()]
    : detectCategoryDecision(userText).schema || CATEGORY_SCHEMAS.GENERIC;
  const resolvedIntentKey = forcedIntentKey && Object.values(AD_INTENTS).includes(String(forcedIntentKey || "").trim().toUpperCase())
    ? String(forcedIntentKey || "").trim().toUpperCase()
    : detectAdIntentDecision({ text: userText, schema: resolvedSchema }).intentKey;

  // OpenAI
  const alreadyUsedCredits = isTrial
    ? Number(await getUserTrialUsed(id) || 0)
    : Number(await getUserQuotaUsed(id) || 0);
  const isFirstPaidGenerationAttempt = !isRefinement && creditsNeeded > 0 && alreadyUsedCredits === 0;
  if (isFirstPaidGenerationAttempt) {
    await trackFlowMetricSafe(trackFirstAdGenerationStarted, id, {
      step: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
    });
  }

  let ad = "";
  try {
    const bizContext = buildBizProfileContext(bizProfile);
    const intentContext = buildIntentContext({ schema: resolvedSchema, intentKey: resolvedIntentKey });
    const promptToSend = buildGenerationPrompt({
      userText,
      lastAd,
      isRefinement,
      bizContext,
      intentContext,
    });

    const hasBizProfile = hasMeaningfulBizProfile(bizProfile);
    const systemKey = mode === "FIXED" && !hasBizProfile
      ? "OPENAI_SYSTEM_FIXED_NO_PROFILE"
      : null;

    const r = await generateAdText({ userText: promptToSend, mode, systemKey });
    ad = r.text;
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.OPENAI_ERROR, id, err, {
      event: "flow_ad_generation_failed",
      step: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
      meta: { isTrial: !!isTrial, isRefinement: !!isRefinement, mode: cleanText(mode) },
    });
    return reply(await getCopyText("FLOW_OPENAI_ERROR", { waId: id }));
  }

  try {
    await setLastPrompt(id, userText);
    await setLastAd(id, ad);
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, id, err, {
      event: "flow_generated_ad_state_persist_failed",
      step: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
      meta: { isTrial: !!isTrial, isRefinement: !!isRefinement },
    });
    return reply("Consegui gerar seu anúncio, mas não consegui salvar essa etapa agora. Tente novamente em instantes.");
  }

  // controla contagem de refinamentos e consumo de créditos
  try {
    if (isRefinement) {
      await setRefineCount(id, nextRefines);
    } else {
      await clearRefineCount(id);
    }
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, id, err, {
      event: "flow_refine_state_update_failed",
      step: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
      meta: { isTrial: !!isTrial, isRefinement: !!isRefinement, nextRefines },
    });
    return reply("Consegui gerar seu anúncio, mas não consegui concluir a atualização agora. Tente novamente em instantes.");
  }

  // conta uso apenas quando há consumo de crédito
  if (creditsNeeded > 0) {
    if (isTrial) await incUserTrialUsed(id, creditsNeeded);
    else await incUserQuotaUsed(id, creditsNeeded);

    // métricas globais + por usuário (best-effort; não pode quebrar produção)
    try {
      await incDescriptionMetrics(id, creditsNeeded);
    } catch (err) {
      flowRuntimeLog("warn", "flow_description_metrics_increment_failed", {
        userId: cleanText(id),
        step: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
        meta: { isTrial: !!isTrial, creditsNeeded },
        error: serializeFlowError(err),
      });
    }
  }

  try {
    await markUserAdCreated(id);
    await setLastCampaignInteractionAt(id, nowIso());
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, id, err, {
      event: "flow_post_generation_state_mark_failed",
      step: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
      meta: { isTrial: !!isTrial, isRefinement: !!isRefinement },
    });
    return reply("Consegui gerar seu anúncio, mas não consegui concluir a etapa agora. Tente novamente em instantes.");
  }

  if (isFirstPaidGenerationAttempt) {
    await trackFlowMetricSafe(trackFirstAdGenerated, id, {
      step: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
    });
  }
  await trackFlowMetricSafe(trackAdGenerated, id, {
    step: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
  });
  if (isRefinement) {
    await trackFlowMetricSafe(trackAdRefined, id, {
      step: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
    });
  }

  let formattedAd = enforceAdFormatting(ad);
  formattedAd = sanitizeGeneratedAd(formattedAd, bizProfile);
  formattedAd = applyPersistentBusinessInfo(formattedAd, bizProfile, userText, isRefinement);
  formattedAd = sanitizeGeneratedAd(formattedAd, bizProfile);
  formattedAd = enforceAdFormatting(formattedAd);

  // Pós-anúncio:
  // - A escolha FIXO/LIVRE aparece apenas na 1ª descrição (templatePrompted = false)
  // - Depois disso, seguimos direto para a mensagem curta de refinamento
  const alreadyPrompted = await getTemplatePrompted(id);

  if (!alreadyPrompted) {
    try {
      await setLastCampaignInteractionAt(id, nowIso());
      await setPrevStatus(id, currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE));
      await setUserStatus(id, ST.WAIT_FIRST_RESULT_PROMPT);
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, id, err, {
        event: "flow_first_result_state_transition_failed",
        step: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
        meta: { isTrial: !!isTrial },
      });
      return reply("Consegui gerar seu anúncio, mas não consegui avançar para a próxima etapa agora. Tente novamente em instantes.");
    }
    return replyMulti([formattedAd, await msgFirstResultPrompt(id)]);
  }

  const refineMsg = await msgRefinementPrompt(id, maxRefinements);
  try {
    await setLastCampaignInteractionAt(id, nowIso());
    await armPostAdIdleReminder(id, "REFINE_OR_OK");
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, id, err, {
      event: "flow_refinement_followup_state_failed",
      step: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
      meta: { isTrial: !!isTrial },
    });
  }

  return replyMulti([formattedAd, refineMsg]);
}

// -------------------- Asaas helpers --------------------
async function ensureAsaasCustomer({ waId, fullName, cpfCnpj }) {
  let existing = "";
  try {
    existing = await getAsaasCustomerId(waId);
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
      event: "flow_asaas_customer_existing_read_failed",
      step: "ensureAsaasCustomer",
    });
    throw err;
  }
  if (existing) return existing;

  let found = null;
  try {
    found = await findCustomerByExternalReference(waId);
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.ASAAS_CLIENT_ERROR, waId, err, {
      event: "flow_asaas_customer_lookup_failed",
      step: "ensureAsaasCustomer",
      level: "warn",
    });
  }
  if (found?.id) {
    try {
      await setAsaasCustomerId(waId, found.id);
    } catch (err) {
      await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
        event: "flow_asaas_customer_found_persist_failed",
        step: "ensureAsaasCustomer",
      });
      throw err;
    }
    return found.id;
  }

  let customer;
  try {
    customer = await createCustomer({
      name: fullName || waId,
      cpfCnpj,
      externalReference: waId,
    });
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.ASAAS_CLIENT_ERROR, waId, err, {
      event: "flow_asaas_customer_create_failed",
      step: "ensureAsaasCustomer",
    });
    throw err;
  }

  if (!customer?.id) {
    const err = new Error("Asaas: customer not created");
    err.code = "asaas_customer_not_created";
    await reportFlowRuntimeError(FLOW_ERROR_KIND.ASAAS_CLIENT_ERROR, waId, err, {
      event: "flow_asaas_customer_create_missing_id",
      step: "ensureAsaasCustomer",
    });
    throw err;
  }

  try {
    await setAsaasCustomerId(waId, customer.id);
  } catch (err) {
    await reportFlowRuntimeError(FLOW_ERROR_KIND.STATE_ERROR, waId, err, {
      event: "flow_asaas_customer_created_persist_failed",
      step: "ensureAsaasCustomer",
      meta: { customerId: cleanText(customer?.id) },
    });
    throw err;
  }
  return customer.id;
}
