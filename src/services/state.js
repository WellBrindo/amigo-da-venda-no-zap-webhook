// src/services/state.js
// ✅ V16.4.3 — Correções de Produção (sem remover funções):
// - Mantém migração segura do users:index (WRONGTYPE)
// - Elimina redisSet(key, "") (evita Upstash: ERR wrong number of arguments for 'set' command)
// - Normaliza valores sujos do tipo "\"\"" (plan/paymentMethod) na leitura e escrita
// - ✅ Hardening: setLastPrompt() nunca faz SET com valor vazio (vazio => DEL)

import {
  redisGet,
  redisSet,
  redisIncrBy,
  redisDel,
  redisSAdd,
  redisSMembers,
  redisSRem,
  redisType,
  redisUserKey,
  redisSafeGet,
  redisSafeSet,
  redisSafeIncrBy,
  redisSafeDel,
  redisSafeSAdd,
  redisSafeSMembers,
  redisSafeSRem,
  redisSafeType,
  getRedisHealthSnapshot,
} from "./redis.js";
import {
  trackStateError,
  trackRedisDegraded,
  trackRedisDown,
  trackRedisFallbackRead,
  trackRedisCriticalWriteBlocked,
  trackRedisNoncriticalWriteSkipped,
} from "./metrics.js";
import * as audit from "./audit.js";
import { raiseSystemIncident } from "./alerts.js";


const STATE_ERROR_CODE = Object.freeze({
  READ: "STATE_READ_ERROR",
  WRITE: "STATE_WRITE_ERROR",
  PARSE: "STATE_PARSE_ERROR",
  DELETE: "STATE_DELETE_ERROR",
  INDEX: "STATE_INDEX_ERROR",
  RUNTIME: "STATE_RUNTIME_ERROR",
});

const STATE_OPERATION_POLICY = Object.freeze({
  READ: "read",
  WRITE_CRITICAL: "write_critical",
  WRITE_NONCRITICAL: "write_noncritical",
  DELETE_CRITICAL: "delete_critical",
  DELETE_NONCRITICAL: "delete_noncritical",
  INDEX: "index",
});

async function logStateOperationalError({
  userId = "",
  key = "",
  step = "",
  errorCode = STATE_ERROR_CODE.RUNTIME,
  error = null,
  meta = null,
  level = "warn",
  event = "state_runtime_error",
} = {}) {
  const payload = {
    module: "state",
    level: safeStr(level) || "warn",
    source: "state",
    event: safeStr(event) || "state_runtime_error",
    userId: safeStr(userId),
    step: safeStr(step),
    errorCode: safeStr(errorCode) || STATE_ERROR_CODE.RUNTIME,
    message: safeStr(error?.message || error || ""),
    meta: {
      key: safeStr(key),
      ...(meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {}),
    },
  };

  try {
    if (typeof trackStateError === "function") {
      await trackStateError({
        userId: payload.userId,
        waId: payload.userId,
        source: "state",
        step: payload.step || payload.meta.key || "state_runtime",
        errorCode: payload.errorCode,
      });
    }
  } catch (_) {}

  try {
    if (audit && typeof audit.logOperationalEvent === "function") {
      await audit.logOperationalEvent(payload);
      return;
    }
    if (audit && typeof audit.logRuntimeError === "function") {
      await audit.logRuntimeError(payload);
      return;
    }
  } catch (_) {}

  console.warn(JSON.stringify({
    level: payload.level,
    source: "state",
    event: payload.event,
    userId: payload.userId,
    step: payload.step,
    errorCode: payload.errorCode,
    message: payload.message,
    meta: payload.meta,
  }));
}

async function safeStateRedisGet(keyName, { userId = "", step = "", fallback = "" } = {}) {
  try {
    const result = await redisSafeGet(keyName, {
      fallbackValue: fallback,
      critical: false,
      module: "state",
      step,
      suppressThrow: true,
    });
    if (result?.ok) {
      return result.value == null ? fallback : result.value;
    }

    await logStateOperationalError({
      userId,
      key: keyName,
      step,
      errorCode: STATE_ERROR_CODE.READ,
      error: result?.message || "state_read_degraded",
      event: "state_read_failed",
      meta: {
        degraded: true,
        fallbackUsed: true,
        redisStatus: safeStr(result?.status),
      },
    });
    await emitRedisDegradationSignals({
      userId,
      step,
      key: keyName,
      errorCode: STATE_ERROR_CODE.READ,
      impact: "state_read_fallback",
      message: safeStr(result?.message),
      fallbackUsed: true,
      severity: "MEDIUM",
    });
    return result?.value == null ? fallback : result.value;
  } catch (error) {
    await logStateOperationalError({
      userId,
      key: keyName,
      step,
      errorCode: STATE_ERROR_CODE.READ,
      error,
      event: "state_read_failed",
      meta: { degraded: true, fallbackUsed: true },
    });
    await emitRedisDegradationSignals({
      userId,
      step,
      key: keyName,
      errorCode: STATE_ERROR_CODE.READ,
      impact: "state_read_fallback",
      message: safeStr(error?.message || error),
      fallbackUsed: true,
      severity: "MEDIUM",
    });
    return fallback;
  }
}

async function safeStateRedisSet(keyName, value, { userId = "", step = "", critical = false } = {}) {
  try {
    const result = await redisSafeSet(keyName, value, {
      fallbackValue: false,
      critical,
      module: "state",
      step,
      suppressThrow: !critical,
    });
    if (result?.ok) {
      return true;
    }

    await logStateOperationalError({
      userId,
      key: keyName,
      step,
      errorCode: STATE_ERROR_CODE.WRITE,
      error: result?.message || "state_write_degraded",
      event: critical ? "state_write_critical_blocked" : "state_write_failed",
      meta: {
        degraded: true,
        criticalBlocked: Boolean(critical),
        fallbackUsed: !critical,
        redisStatus: safeStr(result?.status),
      },
    });
    await emitRedisDegradationSignals({
      userId,
      step,
      key: keyName,
      errorCode: STATE_ERROR_CODE.WRITE,
      impact: critical ? "critical_state_write_blocked" : "noncritical_state_write_skipped",
      message: safeStr(result?.message),
      critical,
      fallbackUsed: !critical,
    });
    if (critical) {
      throw new Error(safeStr(result?.message) || "Critical state write blocked");
    }
    return false;
  } catch (error) {
    await logStateOperationalError({
      userId,
      key: keyName,
      step,
      errorCode: STATE_ERROR_CODE.WRITE,
      error,
      event: critical ? "state_write_critical_blocked" : "state_write_failed",
      meta: {
        degraded: true,
        criticalBlocked: Boolean(critical),
        fallbackUsed: !critical,
      },
    });
    await emitRedisDegradationSignals({
      userId,
      step,
      key: keyName,
      errorCode: STATE_ERROR_CODE.WRITE,
      impact: critical ? "critical_state_write_blocked" : "noncritical_state_write_failed",
      message: safeStr(error?.message || error),
      critical,
      fallbackUsed: !critical,
    });
    if (critical) throw error;
    return false;
  }
}

async function safeStateRedisDel(keyName, { userId = "", step = "", critical = false } = {}) {
  try {
    const result = await redisSafeDel(keyName, {
      fallbackValue: false,
      critical,
      module: "state",
      step,
      suppressThrow: !critical,
    });
    if (result?.ok) {
      return true;
    }

    await logStateOperationalError({
      userId,
      key: keyName,
      step,
      errorCode: STATE_ERROR_CODE.DELETE,
      error: result?.message || "state_delete_degraded",
      event: critical ? "state_delete_critical_blocked" : "state_delete_failed",
      meta: {
        degraded: true,
        criticalBlocked: Boolean(critical),
        fallbackUsed: !critical,
        redisStatus: safeStr(result?.status),
      },
    });
    await emitRedisDegradationSignals({
      userId,
      step,
      key: keyName,
      errorCode: STATE_ERROR_CODE.DELETE,
      impact: critical ? "critical_state_delete_blocked" : "noncritical_state_delete_skipped",
      message: safeStr(result?.message),
      critical,
      fallbackUsed: !critical,
    });
    if (critical) {
      throw new Error(safeStr(result?.message) || "Critical state delete blocked");
    }
    return false;
  } catch (error) {
    await logStateOperationalError({
      userId,
      key: keyName,
      step,
      errorCode: STATE_ERROR_CODE.DELETE,
      error,
      event: critical ? "state_delete_critical_blocked" : "state_delete_failed",
      meta: {
        degraded: true,
        criticalBlocked: Boolean(critical),
        fallbackUsed: !critical,
      },
    });
    await emitRedisDegradationSignals({
      userId,
      step,
      key: keyName,
      errorCode: STATE_ERROR_CODE.DELETE,
      impact: critical ? "critical_state_delete_blocked" : "noncritical_state_delete_failed",
      message: safeStr(error?.message || error),
      critical,
      fallbackUsed: !critical,
    });
    if (critical) throw error;
    return false;
  }
}

async function safeStateIndexUser(userRef, step = "index_user", { critical = false } = {}) {
  try {
    return await indexUser(userRef, { critical });
  } catch (error) {
    await logStateOperationalError({
      userId: userRef,
      key: USERS_INDEX_KEY,
      step,
      errorCode: STATE_ERROR_CODE.INDEX,
      error,
      event: critical ? "state_index_critical_blocked" : "state_index_failed",
      meta: {
        degraded: true,
        criticalBlocked: Boolean(critical),
      },
    });
    await emitRedisDegradationSignals({
      userId: userRef,
      step,
      key: USERS_INDEX_KEY,
      errorCode: STATE_ERROR_CODE.INDEX,
      impact: critical ? "critical_index_write_blocked" : "index_write_failed",
      message: safeStr(error?.message || error),
      critical,
    });
    if (critical) throw error;
    return false;
  }
}


async function emitRedisDegradationSignals({
  userId = "",
  step = "",
  key = "",
  errorCode = "",
  impact = "",
  message = "",
  critical = false,
  fallbackUsed = false,
  severity = "HIGH",
} = {}) {
  const snapshot = typeof getRedisHealthSnapshot === "function"
    ? getRedisHealthSnapshot()
    : { status: "DEGRADED" };
  const status = safeStr(snapshot?.status) || "DEGRADED";

  try {
    if (status === "DOWN" && typeof trackRedisDown === "function") {
      await trackRedisDown({
        userId: safeStr(userId),
        waId: safeStr(userId),
        source: "state",
        step: safeStr(step),
        errorCode: safeStr(errorCode),
        impact: safeStr(impact || key),
        severity: safeStr(severity),
      });
    } else if (status === "DEGRADED" && typeof trackRedisDegraded === "function") {
      await trackRedisDegraded({
        userId: safeStr(userId),
        waId: safeStr(userId),
        source: "state",
        step: safeStr(step),
        errorCode: safeStr(errorCode),
        impact: safeStr(impact || key),
        severity: safeStr(severity),
      });
    }
    if (fallbackUsed && typeof trackRedisFallbackRead === "function") {
      await trackRedisFallbackRead({
        userId: safeStr(userId),
        waId: safeStr(userId),
        source: "state",
        step: safeStr(step),
        errorCode: safeStr(errorCode),
        impact: safeStr(impact || key),
        severity: safeStr(severity),
      });
    }
    if (critical && typeof trackRedisCriticalWriteBlocked === "function") {
      await trackRedisCriticalWriteBlocked({
        userId: safeStr(userId),
        waId: safeStr(userId),
        source: "state",
        step: safeStr(step),
        errorCode: safeStr(errorCode),
        impact: safeStr(impact || key),
        severity: safeStr(severity),
      });
    } else if (!critical && typeof trackRedisNoncriticalWriteSkipped === "function" && safeStr(impact)) {
      await trackRedisNoncriticalWriteSkipped({
        userId: safeStr(userId),
        waId: safeStr(userId),
        source: "state",
        step: safeStr(step),
        errorCode: safeStr(errorCode),
        impact: safeStr(impact || key),
        severity: safeStr(severity),
      });
    }
  } catch (_) {}

  try {
    await raiseSystemIncident({
      type: "REDIS",
      severity: critical ? "CRITICAL" : severity,
      module: "state",
      step: safeStr(step),
      errorCode: safeStr(errorCode) || STATE_ERROR_CODE.RUNTIME,
      message: safeStr(message) || "State Redis degradation detected.",
      impact: safeStr(impact || (critical ? "critical_state_write_blocked" : "state_fallback_used")),
      dedupeKey: ["state", safeStr(step), safeStr(key), safeStr(errorCode), critical ? "critical" : "degraded"].filter(Boolean).join("|"),
      meta: {
        key: safeStr(key),
        status,
        critical,
        fallbackUsed,
      },
    });
  } catch (_) {}
}

async function safeStateRedisIncrBy(keyName, delta = 1, { userId = "", step = "", fallback = 0, critical = false } = {}) {
  try {
    const result = await redisSafeIncrBy(keyName, delta, {
      fallbackValue: fallback,
      critical,
      module: "state",
      step,
      suppressThrow: !critical,
    });
    if (result?.ok) {
      return toInt(result.value, fallback);
    }

    await logStateOperationalError({
      userId,
      key: keyName,
      step,
      errorCode: STATE_ERROR_CODE.WRITE,
      error: result?.message || "state_incr_degraded",
      event: critical ? "state_incr_critical_blocked" : "state_incr_degraded",
      meta: {
        degraded: true,
        criticalBlocked: Boolean(critical),
        fallbackUsed: true,
        redisStatus: safeStr(result?.status),
      },
    });
    await emitRedisDegradationSignals({
      userId,
      step,
      key: keyName,
      errorCode: STATE_ERROR_CODE.WRITE,
      impact: critical ? "critical_counter_write_blocked" : "counter_write_skipped",
      message: safeStr(result?.message),
      critical,
      fallbackUsed: !critical,
    });
    if (critical) {
      throw new Error(safeStr(result?.message) || "Critical state counter write blocked");
    }
    return toInt(result?.value, fallback);
  } catch (error) {
    await logStateOperationalError({
      userId,
      key: keyName,
      step,
      errorCode: STATE_ERROR_CODE.WRITE,
      error,
      event: critical ? "state_incr_critical_blocked" : "state_incr_failed",
      meta: {
        degraded: true,
        criticalBlocked: Boolean(critical),
        fallbackUsed: !critical,
      },
    });
    await emitRedisDegradationSignals({
      userId,
      step,
      key: keyName,
      errorCode: STATE_ERROR_CODE.WRITE,
      impact: critical ? "critical_counter_write_blocked" : "counter_write_failed",
      message: safeStr(error?.message || error),
      critical,
      fallbackUsed: !critical,
    });
    if (critical) throw error;
    return toInt(fallback, 0);
  }
}

async function safeStateRedisSAdd(keyName, members, { userId = "", step = "", critical = false } = {}) {
  const list = Array.isArray(members) ? members : [members];
  try {
    if (typeof redisSafeSAdd === "function") {
      const result = await redisSafeSAdd(keyName, list, {
        fallbackValue: 0,
        critical,
        module: "state",
        step,
        suppressThrow: !critical,
      });
      if (result?.ok) return Number(result.value || 0);
      await emitRedisDegradationSignals({
        userId,
        step,
        key: keyName,
        errorCode: STATE_ERROR_CODE.INDEX,
        impact: critical ? "critical_index_write_blocked" : "index_write_skipped",
        message: safeStr(result?.message),
        critical,
      });
      if (critical) throw new Error(safeStr(result?.message) || "state_sadd_failed");
      return 0;
    }
    return await redisSAdd(keyName, list);
  } catch (error) {
    await logStateOperationalError({
      userId,
      key: keyName,
      step,
      errorCode: STATE_ERROR_CODE.INDEX,
      error,
      event: critical ? "state_sadd_critical_blocked" : "state_sadd_failed",
    });
    if (critical) throw error;
    return 0;
  }
}

async function safeStateRedisSMembers(keyName, { userId = "", step = "", fallback = [] } = {}) {
  try {
    if (typeof redisSafeSMembers === "function") {
      const result = await redisSafeSMembers(keyName, {
        fallbackValue: fallback,
        critical: false,
        module: "state",
        step,
        suppressThrow: true,
      });
      if (result?.ok) return Array.isArray(result.value) ? result.value : fallback;
      await emitRedisDegradationSignals({
        userId,
        step,
        key: keyName,
        errorCode: STATE_ERROR_CODE.READ,
        impact: "index_read_fallback",
        message: safeStr(result?.message),
        critical: false,
        fallbackUsed: true,
        severity: "MEDIUM",
      });
      return Array.isArray(result?.value) ? result.value : fallback;
    }
    const value = await redisSMembers(keyName);
    return Array.isArray(value) ? value : fallback;
  } catch (error) {
    await logStateOperationalError({
      userId,
      key: keyName,
      step,
      errorCode: STATE_ERROR_CODE.READ,
      error,
      event: "state_smembers_failed",
    });
    return fallback;
  }
}

async function safeStateRedisSRem(keyName, members, { userId = "", step = "", critical = false } = {}) {
  const list = Array.isArray(members) ? members : [members];
  try {
    if (typeof redisSafeSRem === "function") {
      const result = await redisSafeSRem(keyName, list, {
        fallbackValue: 0,
        critical,
        module: "state",
        step,
        suppressThrow: !critical,
      });
      if (result?.ok) return Number(result.value || 0);
      await emitRedisDegradationSignals({
        userId,
        step,
        key: keyName,
        errorCode: STATE_ERROR_CODE.DELETE,
        impact: critical ? "critical_index_delete_blocked" : "index_delete_skipped",
        message: safeStr(result?.message),
        critical,
      });
      if (critical) throw new Error(safeStr(result?.message) || "state_srem_failed");
      return 0;
    }
    return await redisSRem(keyName, list);
  } catch (error) {
    await logStateOperationalError({
      userId,
      key: keyName,
      step,
      errorCode: STATE_ERROR_CODE.DELETE,
      error,
      event: critical ? "state_srem_critical_blocked" : "state_srem_failed",
    });
    if (critical) throw error;
    return 0;
  }
}

async function safeStateRedisType(keyName, { userId = "", step = "", fallback = "" } = {}) {
  try {
    if (typeof redisSafeType === "function") {
      const result = await redisSafeType(keyName, {
        fallbackValue: fallback,
        critical: false,
        module: "state",
        step,
        suppressThrow: true,
      });
      if (result?.ok) return safeStr(result.value);
      await emitRedisDegradationSignals({
        userId,
        step,
        key: keyName,
        errorCode: STATE_ERROR_CODE.READ,
        impact: "type_check_fallback",
        message: safeStr(result?.message),
        fallbackUsed: true,
        severity: "MEDIUM",
      });
      return safeStr(result?.value || fallback);
    }
    return safeStr(await redisType(keyName));
  } catch (error) {
    await logStateOperationalError({
      userId,
      key: keyName,
      step,
      errorCode: STATE_ERROR_CODE.READ,
      error,
      event: "state_type_failed",
    });
    return safeStr(fallback);
  }
}


function safeStateJsonParse(raw, fallback = null, { userId = "", key = "", step = "" } = {}) {
  const s = safeStr(raw);
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch (error) {
    void logStateOperationalError({
      userId,
      key,
      step,
      errorCode: STATE_ERROR_CODE.PARSE,
      error,
      event: "state_parse_failed",
    });
    return fallback;
  }
}

/**
 * ✅ Estado do usuário (Redis)
 *
 * Regras importantes:
 * - NUNCA armazenar CPF/CNPJ completo (LGPD + segurança).
 * - Só guardamos: docType ("CPF"|"CNPJ") e docLast4 (últimos 4 dígitos).
 * - Snapshot do admin NUNCA deve expor documento completo.
 *
 * Chaves:
 * - user:{internalUserId}:status  => TRIAL | ACTIVE | PAYMENT_PENDING | BLOCKED
 * - user:{internalUserId}:plan    => plano (ex: DE_VEZ_EM_QUANDO)
 * - user:{internalUserId}:quotaUsed => uso no mês (ACTIVE)
 * - user:{internalUserId}:trialUsed => uso no trial (TRIAL)
 * - user:{internalUserId}:lastPrompt => última descrição enviada (para "alterações")
 * - user:{internalUserId}:templateMode => FIXED | FREE
 * - user:{internalUserId}:fullName => nome completo
 * - user:{internalUserId}:docType => CPF | CNPJ
 * - user:{internalUserId}:docLast4 => últimos 4 dígitos
 * - user:{internalUserId}:paymentMethod => CARD | PIX
 * - user:{internalUserId}:asaasCustomerId => id do cliente no Asaas (cus_...)
 * - user:{internalUserId}:asaasSubscriptionId => id assinatura (quando existir)
 *
 * Índice:
 * - users:index (SET) => lista de internalUserIds/aliases em transição para o admin
 */

// ===================== Helpers =====================
const USERS_INDEX_KEY = "users:index";

function normalizeUserRef(userRef) {
  return safeStr(userRef);
}

const keyStatus = (userId) => redisUserKey(userId, "status");
const keyPlan = (userId) => redisUserKey(userId, "plan");
const keyQuotaUsed = (userId) => redisUserKey(userId, "quotaUsed");
const keyTrialUsed = (userId) => redisUserKey(userId, "trialUsed");
const keyLastPrompt = (userId) => redisUserKey(userId, "lastPrompt");
const keyTemplateMode = (userId) => redisUserKey(userId, "templateMode");
// ✅ controle: pergunta de template (FIXO/LIVRE) só na 1ª descrição
const keyTemplatePrompted = (userId) => redisUserKey(userId, "templatePrompted");

const keyFullName = (userId) => redisUserKey(userId, "fullName");

// ✅ doc (MASCARADO)
const keyDocType = (userId) => redisUserKey(userId, "docType");
const keyDocLast4 = (userId) => redisUserKey(userId, "docLast4");

// ⚠️ legado (não usar mais, mas migrar se existir)
const keyDocLegacy = (userId) => redisUserKey(userId, "docDigits");

const keyPaymentMethod = (userId) => redisUserKey(userId, "paymentMethod");

// ✅ Dados fiscais para emissão (sem CPF completo)
const keyBillingCityState = (userId) => redisUserKey(userId, "billingCityState");
const keyBillingAddress = (userId) => redisUserKey(userId, "billingAddress");

const keyAsaasCustomerId = (userId) => redisUserKey(userId, "asaasCustomerId");
const keyAsaasSubscriptionId = (userId) => redisUserKey(userId, "asaasSubscriptionId");


// ===================== MENU (bot) =====================
const keyMenuPrevStatus = (userId) => redisUserKey(userId, "menuPrevStatus");
const keyMenuEditContext = (userId) => redisUserKey(userId, "menuEditContext");

// ===================== CARD (assinatura) =====================
// Data (YYYY-MM-DD) até quando o usuário mantém acesso após cancelar recorrência.
const keyCardValidUntil = (userId) => redisUserKey(userId, "cardValidUntil");
// Timestamp ISO de quando o usuário cancelou (auditoria leve).
const keyCardCanceledAt = (userId) => redisUserKey(userId, "cardCanceledAt");
// ===================== BIZ PROFILE (auto preenchimento) =====================
// Perfil salvo de dados da empresa (nome/atendimento/local/horário/whatsapp etc)
const keyBizProfile = (userId) => redisUserKey(userId, "bizProfile");
// Perfil pendente (sugestão detectada) aguardando confirmação do usuário
const keyPendingBizProfile = (userId) => redisUserKey(userId, "pendingBizProfile");
// Sessão do anúncio atual (complemento estruturado / intake de categoria)
const keyCurrentAdSession = (userId) => redisUserKey(userId, "currentAdSession");
// Checkout draft / cupom / precificação
const keyCheckoutDraft = (userId) => redisUserKey(userId, "checkoutDraft");
const keySelectedPlanCode = (userId) => redisUserKey(userId, "selectedPlanCode");
const keySelectedBillingCycle = (userId) => redisUserKey(userId, "selectedBillingCycle");
const keySelectedCouponCode = (userId) => redisUserKey(userId, "selectedCouponCode");
const keyPricingQuote = (userId) => redisUserKey(userId, "pricingQuote");
const keyCouponReservationId = (userId) => redisUserKey(userId, "couponReservationId");
const keyCouponReservationCreatedAt = (userId) => redisUserKey(userId, "couponReservationCreatedAt");
const keyCheckoutCouponStatus = (userId) => redisUserKey(userId, "checkoutCouponStatus");
// Status anterior (para estados transitórios como escolha de template / salvar perfil)
const keyPrevStatus = (userId) => redisUserKey(userId, "prevStatus");
// Metadados operacionais leves (inatividade / flood)
const keyActivityMeta = (userId) => redisUserKey(userId, "activityMeta");
// Metadados de engajamento/recorrência (progresso / feedback / indicação / anúncio do dia)
const keyGrowthMeta = (userId) => redisUserKey(userId, "growthMeta");


function safeStr(v) {
  return String(v ?? "").trim();
}

const LOWERCASE_WORDS = new Set(["a", "as", "e", "o", "os", "da", "das", "de", "des", "di", "do", "dos", "du", "d", "del", "della", "delle", "la", "las", "le", "los", "na", "nas", "no", "nos"]);
const BRAZIL_UFS = new Set(["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"]);
const SOCIAL_HOST_HINTS = ["instagram.com", "facebook.com", "facebook.com.br", "tiktok.com", "linkedin.com", "youtube.com", "wa.me", "whatsapp.com"];

function compactInnerWhitespace(value) {
  return safeStr(value).replace(/\s+/g, " ").trim();
}

function capitalizeToken(token) {
  const raw = String(token || "");
  const compact = raw.trim();
  if (!compact) return "";

  const upper = compact.toUpperCase();
  if (BRAZIL_UFS.has(upper)) return upper;
  if (/^[IVXLCDM]+$/i.test(compact) && compact.length <= 6) return upper;
  if (/^[A-Z0-9&]{2,6}$/.test(compact)) return compact;
  if (/^\d+[A-Z]?$/i.test(compact)) return compact.toUpperCase();
  if (/^\d/.test(compact)) return compact;
  if (/^[A-Z]{1}[a-z]+(?:[A-Z][a-z]+)+$/.test(compact)) return compact;

  const lower = compact.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function smartTitleCase(value, { keepLowercaseConnectors = true } = {}) {
  const normalized = compactInnerWhitespace(value);
  if (!normalized) return "";

  let wordIndex = 0;
  return normalized.replace(/[A-Za-zÀ-ÿ0-9&]+(?:'[A-Za-zÀ-ÿ0-9&]+)*/g, (token) => {
    const lower = token.toLowerCase();
    const shouldLower = keepLowercaseConnectors && wordIndex > 0 && LOWERCASE_WORDS.has(lower);
    wordIndex += 1;
    return shouldLower ? lower : capitalizeToken(token);
  });
}

function normalizePersonName(value) {
  return smartTitleCase(value, { keepLowercaseConnectors: true });
}

function normalizeCompanyName(value) {
  return smartTitleCase(value, { keepLowercaseConnectors: true });
}

function normalizeAddressText(value) {
  let text = smartTitleCase(value, { keepLowercaseConnectors: true });
  if (!text) return "";
  text = text
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function normalizeHoursText(value) {
  let text = compactInnerWhitespace(value);
  if (!text) return "";
  const lower = text.toLowerCase();
  if (text === lower) {
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  text = text
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function normalizePhoneBR(value) {
  const raw = compactInnerWhitespace(value);
  if (!raw) return "";

  let digits = raw.replace(/\D+/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    digits = digits.slice(2);
  }
  if (digits.length > 11) digits = digits.slice(-11);

  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }

  return raw;
}

function normalizeUrlStored(value, { social = false } = {}) {
  let text = compactInnerWhitespace(value).replace(/\\/g, "/");
  if (!text) return "";

  if (social && text.startsWith("@")) {
    text = `instagram.com/${text.slice(1)}`;
  }

  text = text
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

  const lower = text.toLowerCase();
  const looksLikeKnownHost = SOCIAL_HOST_HINTS.some((host) => lower.includes(host)) || /^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(text);
  if (!/^https?:\/\//i.test(text) && looksLikeKnownHost) {
    text = `https://${text.replace(/^\/+/, "")}`;
  }

  return text;
}

function normalizeCityState(value) {
  const raw = compactInnerWhitespace(value);
  if (!raw) return "";

  const slashMatch = raw.match(/^(.*?)[\s\/-]*([A-Za-z]{2})$/);
  if (slashMatch) {
    const cityPart = smartTitleCase(slashMatch[1], { keepLowercaseConnectors: true }).replace(/\s*,\s*$/g, "").trim();
    const uf = String(slashMatch[2] || "").toUpperCase();
    if (cityPart && BRAZIL_UFS.has(uf)) return `${cityPart}/${uf}`;
  }

  return smartTitleCase(raw, { keepLowercaseConnectors: true }).replace(/\s*\/\s*/g, "/").trim();
}

function normalizeFreeTextField(value) {
  return compactInnerWhitespace(value);
}

function normalizeBizProfileData(profileObj) {
  const src = profileObj && typeof profileObj === "object" ? profileObj : {};
  const dst = { ...src };

  if ("companyName" in dst) dst.companyName = normalizeCompanyName(dst.companyName);
  if ("whatsapp" in dst) dst.whatsapp = normalizePhoneBR(dst.whatsapp);
  if ("address" in dst) dst.address = normalizeAddressText(dst.address);
  if ("location" in dst) {
    const normalizedLocation = compactInnerWhitespace(dst.location);
    if (/^apenas\s+atendimento\s+online$/i.test(normalizedLocation)) {
      dst.location = "Apenas atendimento online";
    } else if (/^apenas\s+online$/i.test(normalizedLocation)) {
      dst.location = "Apenas online";
    } else {
      dst.location = normalizeAddressText(normalizedLocation);
    }
  }
  if ("serviceArea" in dst) dst.serviceArea = normalizeAddressText(dst.serviceArea);
  if ("hours" in dst) dst.hours = normalizeHoursText(dst.hours);
  if ("website" in dst) dst.website = normalizeUrlStored(dst.website, { social: false });
  if ("productsUrl" in dst) dst.productsUrl = normalizeUrlStored(dst.productsUrl, { social: false });
  if ("productList" in dst) {
    const normalized = normalizeUrlStored(dst.productList, { social: false });
    dst.productList = normalized || normalizeFreeTextField(dst.productList);
  }
  if ("socials" in dst) {
    const socials = Array.isArray(dst.socials) ? dst.socials : [];
    dst.socials = Array.from(new Set(socials.map((item) => normalizeUrlStored(item, { social: true })).filter(Boolean)));
  }

  Object.keys(dst).forEach((key) => {
    const value = dst[key];
    if (typeof value === "string" && !safeStr(value)) delete dst[key];
    if (Array.isArray(value) && value.length === 0) delete dst[key];
  });

  return dst;
}

function toInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * Normaliza lixo do tipo "\"\"" (string JSON de string vazia) e afins.
 * - Se vier "\"PIX\"" vira "PIX"
 * - Se vier "\"\"" vira ""
 * - Se não for JSON válido, retorna a string original
 */
function normalizeMaybeJsonString(raw) {
  const s = safeStr(raw);
  if (!s) return "";

  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === "string") return parsed.trim();
    } catch (_) {
      // ignore
    }
  }

  // caso extremo: só aspas
  if (/^"+$/.test(s)) return "";

  return s;
}

function safeJsonParse(raw) {
  const s = safeStr(raw);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj ?? {});
  } catch (_) {
    return "{}";
  }
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeIsoTimestamp(value) {
  const raw = safeStr(value);
  if (!raw) return "";
  const dt = new Date(raw);
  return Number.isFinite(dt.getTime()) ? dt.toISOString() : "";
}

function normalizeIsoDate(value) {
  const raw = safeStr(value);
  if (!raw) return "";
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const dt = new Date(raw);
  return Number.isFinite(dt.getTime()) ? dt.toISOString().slice(0, 10) : "";
}

function normalizePlanCode(value) {
  return safeStr(normalizeMaybeJsonString(value)).toUpperCase();
}

function normalizeBillingCycle(value) {
  const cycle = safeStr(normalizeMaybeJsonString(value)).toLowerCase();
  return cycle === "annual" ? "annual" : cycle === "monthly" ? "monthly" : "";
}

function normalizeCouponCode(value) {
  return safeStr(normalizeMaybeJsonString(value)).toUpperCase();
}

function normalizeCheckoutCouponStatus(value) {
  return safeStr(normalizeMaybeJsonString(value)).toUpperCase();
}

function normalizePricingQuote(value) {
  if (!isPlainObject(value)) return null;
  const next = { ...value };

  if ("planCode" in next) next.planCode = normalizePlanCode(next.planCode);
  if ("billingCycle" in next) next.billingCycle = normalizeBillingCycle(next.billingCycle);
  if ("couponCode" in next) next.couponCode = normalizeCouponCode(next.couponCode);
  if ("couponReservationId" in next) next.couponReservationId = safeStr(next.couponReservationId);
  if ("couponReservationCreatedAt" in next) next.couponReservationCreatedAt = normalizeIsoTimestamp(next.couponReservationCreatedAt);
  if ("checkoutCouponStatus" in next) next.checkoutCouponStatus = normalizeCheckoutCouponStatus(next.checkoutCouponStatus);

  ["basePriceCents", "discountAmountCents", "finalPriceCents"].forEach((field) => {
    if (field in next) {
      const n = Number(next[field]);
      if (Number.isFinite(n)) next[field] = Math.max(0, Math.trunc(n));
      else delete next[field];
    }
  });

  ["basePrice", "discountAmount", "finalPrice"].forEach((field) => {
    if (field in next) {
      const n = Number(next[field]);
      if (Number.isFinite(n)) next[field] = n;
      else delete next[field];
    }
  });

  if ("appliesTo" in next) {
    const appliesTo = safeStr(next.appliesTo).toLowerCase();
    next.appliesTo = appliesTo === "entire_subscription" ? "entire_subscription" : appliesTo === "first_charge_only" ? "first_charge_only" : "";
    if (!next.appliesTo) delete next.appliesTo;
  }

  Object.keys(next).forEach((key) => {
    const value = next[key];
    if (typeof value === "string" && !safeStr(value)) delete next[key];
    if (Array.isArray(value) && value.length === 0) delete next[key];
    if (isPlainObject(value) && !Object.keys(value).length) delete next[key];
  });

  return Object.keys(next).length ? next : null;
}

function normalizeCheckoutDraft(draftObj) {
  if (!isPlainObject(draftObj)) return null;
  const next = { ...draftObj };

  if ("planCode" in next) next.planCode = normalizePlanCode(next.planCode);
  if ("selectedPlanCode" in next) next.selectedPlanCode = normalizePlanCode(next.selectedPlanCode);
  if ("billingCycle" in next) next.billingCycle = normalizeBillingCycle(next.billingCycle);
  if ("selectedBillingCycle" in next) next.selectedBillingCycle = normalizeBillingCycle(next.selectedBillingCycle);
  if ("couponCode" in next) next.couponCode = normalizeCouponCode(next.couponCode);
  if ("selectedCouponCode" in next) next.selectedCouponCode = normalizeCouponCode(next.selectedCouponCode);
  if ("couponReservationId" in next) next.couponReservationId = safeStr(next.couponReservationId);
  if ("couponReservationCreatedAt" in next) next.couponReservationCreatedAt = normalizeIsoTimestamp(next.couponReservationCreatedAt);
  if ("checkoutCouponStatus" in next) next.checkoutCouponStatus = normalizeCheckoutCouponStatus(next.checkoutCouponStatus);
  if ("pricingQuote" in next) next.pricingQuote = normalizePricingQuote(next.pricingQuote);
  if ("createdAt" in next) next.createdAt = normalizeIsoTimestamp(next.createdAt);
  if ("updatedAt" in next) next.updatedAt = normalizeIsoTimestamp(next.updatedAt);

  Object.keys(next).forEach((key) => {
    const value = next[key];
    if (typeof value === "string" && !safeStr(value)) delete next[key];
    if (Array.isArray(value) && value.length === 0) delete next[key];
    if (isPlainObject(value) && !Object.keys(value).length) delete next[key];
  });

  return Object.keys(next).length ? next : null;
}

function normalizeActivityMeta(metaObj) {
  const src = isPlainObject(metaObj) ? metaObj : {};
  const dst = {};

  const lastInboundAt = normalizeIsoTimestamp(src.lastInboundAt);
  if (lastInboundAt) dst.lastInboundAt = lastInboundAt;

  const idleReminderSentAt = normalizeIsoTimestamp(src.idleReminderSentAt);
  if (idleReminderSentAt) dst.idleReminderSentAt = idleReminderSentAt;

  const plansViewedAt = normalizeIsoTimestamp(src.plansViewedAt);
  if (plansViewedAt) dst.plansViewedAt = plansViewedAt;

  const checkoutStartedAt = normalizeIsoTimestamp(src.checkoutStartedAt);
  if (checkoutStartedAt) dst.checkoutStartedAt = checkoutStartedAt;

  const trialEndedAt = normalizeIsoTimestamp(src.trialEndedAt);
  if (trialEndedAt) dst.trialEndedAt = trialEndedAt;

  const lastCampaignInteractionAt = normalizeIsoTimestamp(src.lastCampaignInteractionAt);
  if (lastCampaignInteractionAt) dst.lastCampaignInteractionAt = lastCampaignInteractionAt;

  const lastPlanPromptAt = normalizeIsoTimestamp(src.lastPlanPromptAt);
  if (lastPlanPromptAt) dst.lastPlanPromptAt = lastPlanPromptAt;

  const postAdIdleState = safeStr(src.postAdIdleState).toUpperCase();
  if (["REFINE_OR_OK", "WAIT_NEXT_DESCRIPTION"].includes(postAdIdleState)) {
    dst.postAdIdleState = postAdIdleState;
  }

  const postAdIdleArmedAt = normalizeIsoTimestamp(src.postAdIdleArmedAt);
  if (postAdIdleArmedAt) dst.postAdIdleArmedAt = postAdIdleArmedAt;

  const postAdIdleReminderSentAt = normalizeIsoTimestamp(src.postAdIdleReminderSentAt);
  if (postAdIdleReminderSentAt) dst.postAdIdleReminderSentAt = postAdIdleReminderSentAt;

  const flood = isPlainObject(src.flood) ? src.flood : null;
  if (flood) {
    const normalizedFlood = {};
    const windowStartAt = normalizeIsoTimestamp(flood.windowStartAt);
    const lastMessageAt = normalizeIsoTimestamp(flood.lastMessageAt);
    const warnedAt = normalizeIsoTimestamp(flood.warnedAt);
    const count = toInt(flood.count, 0);

    if (windowStartAt) normalizedFlood.windowStartAt = windowStartAt;
    if (lastMessageAt) normalizedFlood.lastMessageAt = lastMessageAt;
    if (warnedAt) normalizedFlood.warnedAt = warnedAt;
    if (count > 0) normalizedFlood.count = count;

    if (Object.keys(normalizedFlood).length) dst.flood = normalizedFlood;
  }

  return dst;
}

function normalizeGrowthMeta(metaObj) {
  const src = isPlainObject(metaObj) ? metaObj : {};
  const dst = {};

  const adsCreatedTotal = toInt(src.adsCreatedTotal, 0);
  if (adsCreatedTotal > 0) dst.adsCreatedTotal = adsCreatedTotal;

  const lastAdCreatedAt = normalizeIsoTimestamp(src.lastAdCreatedAt);
  if (lastAdCreatedAt) dst.lastAdCreatedAt = lastAdCreatedAt;

  const lastAdCreatedDate = normalizeIsoDate(src.lastAdCreatedDate || lastAdCreatedAt);
  if (lastAdCreatedDate) dst.lastAdCreatedDate = lastAdCreatedDate;

  const habitPromptedAt = normalizeIsoTimestamp(src.habitPromptedAt);
  if (habitPromptedAt) dst.habitPromptedAt = habitPromptedAt;

  const feedbackAskedAt = normalizeIsoTimestamp(src.feedbackAskedAt);
  if (feedbackAskedAt) dst.feedbackAskedAt = feedbackAskedAt;

  const feedbackAnsweredAt = normalizeIsoTimestamp(src.feedbackAnsweredAt);
  if (feedbackAnsweredAt) dst.feedbackAnsweredAt = feedbackAnsweredAt;

  const feedbackResponse = safeStr(src.feedbackResponse);
  if (feedbackResponse) dst.feedbackResponse = feedbackResponse;

  const testimonialAskedAt = normalizeIsoTimestamp(src.testimonialAskedAt);
  if (testimonialAskedAt) dst.testimonialAskedAt = testimonialAskedAt;

  const testimonialReceivedAt = normalizeIsoTimestamp(src.testimonialReceivedAt);
  if (testimonialReceivedAt) dst.testimonialReceivedAt = testimonialReceivedAt;

  const feedbackComment = safeStr(src.feedbackComment);
  if (feedbackComment) dst.feedbackComment = feedbackComment;

  const feedbackCommentAt = normalizeIsoTimestamp(src.feedbackCommentAt);
  if (feedbackCommentAt) dst.feedbackCommentAt = feedbackCommentAt;

  const testimonialText = safeStr(src.testimonialText);
  if (testimonialText) dst.testimonialText = testimonialText;

  const testimonialTextAt = normalizeIsoTimestamp(src.testimonialTextAt || src.testimonialReceivedAt);
  if (testimonialTextAt) dst.testimonialTextAt = testimonialTextAt;

  const testimonialConsent = safeStr(src.testimonialConsent).toUpperCase();
  if (["YES", "NO"].includes(testimonialConsent)) dst.testimonialConsent = testimonialConsent;

  const testimonialConsentAt = normalizeIsoTimestamp(src.testimonialConsentAt);
  if (testimonialConsentAt) dst.testimonialConsentAt = testimonialConsentAt;

  const testimonialDisplayMode = safeStr(src.testimonialDisplayMode).toUpperCase();
  if (["FIRST_NAME", "COMPANY", "ANONYMOUS"].includes(testimonialDisplayMode)) dst.testimonialDisplayMode = testimonialDisplayMode;

  const testimonialDisplayName = safeStr(src.testimonialDisplayName);
  if (testimonialDisplayName) dst.testimonialDisplayName = testimonialDisplayName;

  const testimonialStatus = safeStr(src.testimonialStatus).toUpperCase();
  if (["PENDING_REVIEW", "APPROVED", "REJECTED", "PUBLISHED", "INTERNAL_ONLY"].includes(testimonialStatus)) dst.testimonialStatus = testimonialStatus;

  const testimonialStatusUpdatedAt = normalizeIsoTimestamp(src.testimonialStatusUpdatedAt);
  if (testimonialStatusUpdatedAt) dst.testimonialStatusUpdatedAt = testimonialStatusUpdatedAt;

  const referralAskedAt = normalizeIsoTimestamp(src.referralAskedAt);
  if (referralAskedAt) dst.referralAskedAt = referralAskedAt;

  const referralRewardGrantedAt = normalizeIsoTimestamp(src.referralRewardGrantedAt);
  if (referralRewardGrantedAt) dst.referralRewardGrantedAt = referralRewardGrantedAt;

  const adOfDaySentAt = normalizeIsoTimestamp(src.adOfDaySentAt);
  if (adOfDaySentAt) dst.adOfDaySentAt = adOfDaySentAt;

  const adOfDaySentDate = normalizeIsoDate(src.adOfDaySentDate || adOfDaySentAt);
  if (adOfDaySentDate) dst.adOfDaySentDate = adOfDaySentDate;

  return dst;
}

function maskDocFromParts(docType, docLast4) {
  const t = safeStr(docType).toUpperCase();
  const l4 = safeStr(docLast4);
  if (!t || !l4) return { docType: "", docLast4: "" };
  return { docType: t, docLast4: l4 };
}

// ✅ AGORA É EXPORTADA (para window24h.js importar corretamente)
// ✅ V16.4.1: migração segura do índice users:index quando legado estiver como STRING (ou outro tipo)
export async function indexUser(userRef, { critical = false } = {}) {
  const id = normalizeUserRef(userRef);
  if (!id) return false;

  // Detecta tipo do índice antes de usar SADD (evita WRONGTYPE)
  let t = "";
  try {
    t = safeStr(await safeStateRedisType(USERS_INDEX_KEY, { userId: id, step: "index_user:type_check", fallback: "" })).toLowerCase();
  } catch (err) {
    // Se TYPE falhar por qualquer razão, não arriscar deletar nada.
    console.warn(
      JSON.stringify({
        level: "warn",
        tag: "users_index_type_check_failed",
        key: USERS_INDEX_KEY,
        userRef: id,
        error: safeStr(err?.message || err),
      })
    );
    // Ainda tenta adicionar (pode falhar se for wrongtype, mas ao menos logamos o motivo)
    await safeStateRedisSAdd(USERS_INDEX_KEY, id, { userId: id, step: "index_user:add_after_type_check", critical });
    return true;
  }

  // Upstash TYPE costuma retornar: "none" quando não existe
  if (t && t !== "set" && t !== "none") {
    // Migração segura: apagar APENAS o índice (nunca user:*)
    console.warn(
      JSON.stringify({
        level: "warn",
        tag: "users_index_migration",
        action: "del_and_recreate_as_set",
        key: USERS_INDEX_KEY,
        previousType: t,
        userRef: id,
      })
    );
    await safeStateRedisDel(USERS_INDEX_KEY, { userId: id, step: "index_user:migration_delete", critical });
  }

  await safeStateRedisSAdd(USERS_INDEX_KEY, id, { userId: id, step: "index_user:add", critical });
  return true;
}

// ===================== Ensure =====================
export async function ensureUserExists(userRef) {
  const id = normalizeUserRef(userRef);
  if (!id) throw new Error("userRef required");

  await safeStateIndexUser(id, "ensure_user_exists:index", { critical: false });

  // status default
  const curStatus = await safeStateRedisGet(keyStatus(id), { userId: id, step: "ensure_user_exists:get_status", fallback: "" });
  if (!curStatus) await safeStateRedisSet(keyStatus(id), "TRIAL", { userId: id, step: "ensure_user_exists:set_status", critical: false });

  // template default
  const curT = await safeStateRedisGet(keyTemplateMode(id), { userId: id, step: "ensure_user_exists:get_template_mode", fallback: "" });
  if (!curT) await safeStateRedisSet(keyTemplateMode(id), "FIXED", { userId: id, step: "ensure_user_exists:set_template_mode", critical: false });

  // template prompt default
  const curTP = await safeStateRedisGet(keyTemplatePrompted(id), { userId: id, step: "ensure_user_exists:get_template_prompted", fallback: "" });
  if (!curTP) await safeStateRedisSet(keyTemplatePrompted(id), "0", { userId: id, step: "ensure_user_exists:set_template_prompted", critical: false });

  // counters default
  const curTrial = await safeStateRedisGet(keyTrialUsed(id), { userId: id, step: "ensure_user_exists:get_trial_used", fallback: "" });
  if (!curTrial) await safeStateRedisSet(keyTrialUsed(id), "0", { userId: id, step: "ensure_user_exists:set_trial_used", critical: false });

  const curQuota = await safeStateRedisGet(keyQuotaUsed(id), { userId: id, step: "ensure_user_exists:get_quota_used", fallback: "" });
  if (!curQuota) await safeStateRedisSet(keyQuotaUsed(id), "0", { userId: id, step: "ensure_user_exists:set_quota_used", critical: false });

  // ✅ IMPORTANTE (V16.4.2):
  // NÃO setar plan/paymentMethod como "".
  // Ausência da key já representa vazio e evita "SET key" sem valor no Upstash REST.
  // (plan/paymentMethod serão normalizados na leitura)

  // Migração do doc legado, se existir (docDigits completo)
  await migrateLegacyDocIfNeeded(id);

  return true;
}

// ===================== Users Index =====================
export async function listUsers() {
  const ids = await safeStateRedisSMembers(USERS_INDEX_KEY, { step: "list_users", fallback: [] });
  return Array.isArray(ids) ? ids : [];
}

export async function listUserIds() {
  return listUsers();
}

// ===================== Status / Plan =====================
export async function getUserStatus(waId) {
  const v = await safeStateRedisGet(keyStatus(waId), {
    userId: waId,
    key: keyStatus(waId),
    step: "get_user_status",
    fallback: "",
  });
  return safeStr(v) || "TRIAL";
}

export async function setUserStatus(waId, status) {
  await safeStateIndexUser(waId, "set_user_status:index");
  const s = safeStr(status).toUpperCase();
  await safeStateRedisSet(keyStatus(waId), s, {
    userId: waId,
    step: "set_user_status",
  });
  return s;
}

export async function getUserPlan(waId) {
  const v = await safeStateRedisGet(keyPlan(waId), {
    userId: waId,
    key: keyPlan(waId),
    step: "get_user_plan",
    fallback: "",
  });
  const normalized = normalizeMaybeJsonString(v);
  const p = safeStr(normalized).toUpperCase();
  return p === '""' ? "" : p;
}

export async function setUserPlan(waId, planCode) {
  await safeStateIndexUser(waId, "set_user_plan:index");

  const normalized = normalizeMaybeJsonString(planCode);
  const p = safeStr(normalized).toUpperCase();

  if (!p || p === '""') {
    await safeStateRedisDel(keyPlan(waId), {
      userId: waId,
      step: "set_user_plan:clear",
    });
    return "";
  }

  await safeStateRedisSet(keyPlan(waId), p, {
    userId: waId,
    step: "set_user_plan",
  });
  return p;
}

// ===================== Counters =====================
export async function getUserQuotaUsed(waId) {
  const v = await safeStateRedisGet(keyQuotaUsed(waId), { userId: waId, step: "get_user_quota_used", fallback: "0" });
  return toInt(v, 0);
}

export async function incUserQuotaUsed(waId, by = 1) {
  await indexUser(waId);
  const inc = toInt(by, 1);
  const v = await safeStateRedisIncrBy(keyQuotaUsed(waId), inc, { userId: waId, step: "inc_user_quota_used", fallback: 0, critical: false });
  return toInt(v, 0);
}

export async function resetUserQuotaUsed(waId) {
  await indexUser(waId);
  await safeStateRedisSet(keyQuotaUsed(waId), "0", { userId: waId, step: "reset_user_quota_used", critical: false });
  return 0;
}

export async function setUserQuotaUsed(waId, value) {
  await indexUser(waId);
  const v = Math.max(0, Number(value) || 0);
  await safeStateRedisSet(keyQuotaUsed(waId), String(Math.trunc(v)), { userId: waId, step: "set_user_quota_used", critical: false });
  return Math.trunc(v);
}

export async function setUserTrialUsed(waId, value) {
  await indexUser(waId);
  const v = Math.max(0, Number(value) || 0);
  await safeStateRedisSet(keyTrialUsed(waId), String(Math.trunc(v)), { userId: waId, step: "set_user_trial_used", critical: false });
  return Math.trunc(v);
}

export async function getUserTrialUsed(waId) {
  const v = await safeStateRedisGet(keyTrialUsed(waId), { userId: waId, step: "get_user_trial_used", fallback: "0" });
  return toInt(v, 0);
}

export async function incUserTrialUsed(waId, by = 1) {
  await indexUser(waId);
  const inc = toInt(by, 1);
  const v = await safeStateRedisIncrBy(keyTrialUsed(waId), inc, { userId: waId, step: "inc_user_trial_used", fallback: 0, critical: false });
  return toInt(v, 0);
}

export async function resetUserTrialUsed(waId) {
  await indexUser(waId);
  await safeStateRedisSet(keyTrialUsed(waId), "0", { userId: waId, step: "reset_user_trial_used", critical: false });
  return 0;
}

// ===================== Last Prompt =====================
export async function getLastPrompt(waId) {
  const v = await safeStateRedisGet(keyLastPrompt(waId), { userId: waId, step: "get_last_prompt", fallback: "" });
  return safeStr(v);
}

export async function setLastPrompt(waId, prompt) {
  await indexUser(waId);
  const p = safeStr(prompt);

  // ✅ V16.4.3: Nunca SET vazio (Upstash REST pode interpretar como SET sem value)
  // Vazio => remove a chave
  if (!p) {
    await safeStateRedisDel(keyLastPrompt(waId), { userId: waId, step: "last_prompt:clear", critical: false });
    return "";
  }

  await safeStateRedisSet(keyLastPrompt(waId), p, { userId: waId, step: "set_last_prompt", critical: false });
  return p;
}

export async function clearLastPrompt(waId) {
  await indexUser(waId);
  await safeStateRedisDel(keyLastPrompt(waId), { userId: waId, step: "clear_last_prompt", critical: false });
  return true;
}


// ===================== Last Ad (for refinements) =====================
function keyLastAd(userId) {
  return redisUserKey(userId, "lastAd");
}

export async function getLastAd(waId) {
  const v = await safeStateRedisGet(keyLastAd(waId), { userId: waId, step: "get_last_ad", fallback: "" });
  return safeStr(v);
}

export async function setLastAd(waId, adText) {
  await indexUser(waId);
  const t = safeStr(adText);

  // Nunca SET vazio (Upstash REST pode interpretar como SET sem value)
  if (!t) {
    await safeStateRedisDel(keyLastAd(waId), { userId: waId, step: "last_ad:clear", critical: false });
    return "";
  }

  await safeStateRedisSet(keyLastAd(waId), t, { userId: waId, step: "set_last_ad", critical: false });
  return t;
}

export async function clearLastAd(waId) {
  await indexUser(waId);
  await safeStateRedisDel(keyLastAd(waId), { userId: waId, step: "clear_last_ad", critical: false });
  return true;
}

// ===================== Refinement Count =====================
function keyRefineCount(userId) {
  return redisUserKey(userId, "refineCount");
}

export async function getRefineCount(waId) {
  const v = await safeStateRedisGet(keyRefineCount(waId), { userId: waId, step: "get_refine_count", fallback: "0" });
  return toInt(v, 0);
}

export async function setRefineCount(waId, n) {
  await indexUser(waId);
  const v = toInt(n, 0);
  await safeStateRedisSet(keyRefineCount(waId), String(v), { userId: waId, step: "set_refine_count", critical: false });
  return v;
}

export async function incRefineCount(waId, by = 1) {
  await indexUser(waId);
  const inc = toInt(by, 1);
  const v = await safeStateRedisIncrBy(keyRefineCount(waId), inc, { userId: waId, step: "inc_refine_count", fallback: 0, critical: false });
  return toInt(v, 0);
}

export async function clearRefineCount(waId) {
  await indexUser(waId);
  await safeStateRedisDel(keyRefineCount(waId), { userId: waId, step: "clear_refine_count", critical: false });
  return true;
}

// ===================== Template Mode =====================
export async function getTemplateMode(waId) {
  const v = await safeStateRedisGet(keyTemplateMode(waId), { userId: waId, step: "get_template_mode", fallback: "" });
  const t = safeStr(v).toUpperCase();
  return t === "FREE" ? "FREE" : "FIXED";
}

export async function setTemplateMode(waId, mode) {
  await indexUser(waId);
  const m = safeStr(mode).toUpperCase();
  const v = m === "FREE" ? "FREE" : "FIXED";
  await safeStateRedisSet(keyTemplateMode(waId), v, { userId: waId, step: "set_template_mode", critical: false });
  return v;
}

// ===================== Template Prompted (only first time) =====================
export async function getTemplatePrompted(waId) {
  const v = await safeStateRedisGet(keyTemplatePrompted(waId), { userId: waId, step: "get_template_prompted", fallback: "0" });
  const n = toInt(v, 0);
  return n > 0;
}

export async function setTemplatePrompted(waId, value) {
  await indexUser(waId);
  const v = value ? 1 : 0;
  await safeStateRedisSet(keyTemplatePrompted(waId), String(v), { userId: waId, step: "set_template_prompted", critical: false });
  return !!v;
}

export async function resetTemplatePrompted(waId) {
  await indexUser(waId);
  await safeStateRedisSet(keyTemplatePrompted(waId), "0", { userId: waId, step: "reset_template_prompted", critical: false });
  return false;
}

// ===================== Full Name =====================
export async function getUserFullName(waId) {
  const v = await safeStateRedisGet(keyFullName(waId), { userId: waId, step: "get_user_full_name", fallback: "" });
  return safeStr(v);
}

export async function setUserFullName(waId, fullName) {
  await indexUser(waId);
  const n = normalizePersonName(fullName);
  if (!n) {
    await safeStateRedisDel(keyFullName(waId), { userId: waId, step: "clear_full_name", critical: false });
    return "";
  }
  await safeStateRedisSet(keyFullName(waId), n, { userId: waId, step: "set_user_full_name", critical: false });
  return n;
}

// ===================== Doc (masked only) =====================
export async function getUserDocMasked(waId) {
  await migrateLegacyDocIfNeeded(waId);

  const [t, l4] = await Promise.all([
    safeStateRedisGet(keyDocType(waId), { userId: waId, step: "get_user_doc_masked:type", fallback: "" }),
    safeStateRedisGet(keyDocLast4(waId), { userId: waId, step: "get_user_doc_masked:last4", fallback: "" }),
  ]);

  return maskDocFromParts(t, l4);
}

export async function setUserDocMasked(waId, docType, docLast4) {
  await indexUser(waId);
  const t = safeStr(docType).toUpperCase();
  const l4 = safeStr(docLast4);

  if (!t || !l4) {
    await Promise.all([safeStateRedisDel(keyDocType(waId), { userId: waId, step: "set_user_doc_masked:clear_type", critical: false }), safeStateRedisDel(keyDocLast4(waId), { userId: waId, step: "set_user_doc_masked:clear_last4", critical: false })]);
    return { docType: "", docLast4: "" };
  }

  await Promise.all([safeStateRedisSet(keyDocType(waId), t, { userId: waId, step: "set_user_doc_masked:type", critical: false }), safeStateRedisSet(keyDocLast4(waId), l4, { userId: waId, step: "set_user_doc_masked:last4", critical: false })]);
  // garantir que legado está removido
  await safeStateRedisDel(keyDocLegacy(waId), { userId: waId, step: "clear_legacy_doc", critical: false });
  return { docType: t, docLast4: l4 };
}

export async function clearUserDoc(waId) {
  await indexUser(waId);
  await Promise.all([
    safeStateRedisDel(keyDocType(waId), { userId: waId, step: "clear_user_doc:type", critical: false }),
    safeStateRedisDel(keyDocLast4(waId), { userId: waId, step: "clear_user_doc:last4", critical: false }),
    safeStateRedisDel(keyDocLegacy(waId), { userId: waId, step: "clear_user_doc:legacy", critical: false }),
  ]);
  return true;
}

// Migração: se existir docDigits (legado), migrar para docType/docLast4 e apagar
async function migrateLegacyDocIfNeeded(waId) {
  const legacy = await safeStateRedisGet(keyDocLegacy(waId), { userId: waId, step: "migrate_legacy_doc:read", fallback: "" });
  const digits = safeStr(legacy).replace(/\D/g, "");
  if (!digits) return false;

  const docType = digits.length === 14 ? "CNPJ" : "CPF";
  const docLast4 = digits.slice(-4);

  await Promise.all([
    safeStateRedisSet(keyDocType(waId), docType, { userId: waId, step: "migrate_legacy_doc:type", critical: false }),
    safeStateRedisSet(keyDocLast4(waId), docLast4, { userId: waId, step: "migrate_legacy_doc:last4", critical: false }),
    safeStateRedisDel(keyDocLegacy(waId), { userId: waId, step: "clear_user_doc:legacy", critical: false }),
  ]);

  return true;
}

// ===================== Payment Method =====================
export async function getPaymentMethod(waId) {
  const v = await safeStateRedisGet(keyPaymentMethod(waId), {
    userId: waId,
    key: keyPaymentMethod(waId),
    step: "get_payment_method",
    fallback: "",
  });
  const normalized = normalizeMaybeJsonString(v);
  const m = safeStr(normalized).toUpperCase();
  return m === "PIX" ? "PIX" : m === "CARD" ? "CARD" : "";
}

export async function setPaymentMethod(waId, method) {
  await safeStateIndexUser(waId, "set_payment_method:index");

  const normalized = normalizeMaybeJsonString(method);
  const m = safeStr(normalized).toUpperCase();
  const v = m === "PIX" ? "PIX" : m === "CARD" ? "CARD" : "";

  if (!v) {
    await safeStateRedisDel(keyPaymentMethod(waId), {
      userId: waId,
      step: "set_payment_method:clear",
    });
    return "";
  }

  await safeStateRedisSet(keyPaymentMethod(waId), v, {
    userId: waId,
    step: "set_payment_method",
  });
  return v;
}

export async function clearPaymentMethod(waId) {
  await indexUser(waId);
  await safeStateRedisDel(keyPaymentMethod(waId), { userId: waId, step: "clear_payment_method", critical: false });
  return true;
}


// ===================== Dados fiscais (emissão de cobrança) =====================
export async function getBillingCityState(waId) {
  return safeStr(await safeStateRedisGet(keyBillingCityState(waId), {
    userId: waId,
    key: keyBillingCityState(waId),
    step: "get_billing_city_state",
    fallback: "",
  }));
}

export async function setBillingCityState(waId, value) {
  await safeStateIndexUser(waId, "set_billing_city_state:index");
  const v = normalizeCityState(value);
  if (!v) {
    await safeStateRedisDel(keyBillingCityState(waId), {
      userId: waId,
      step: "set_billing_city_state:clear",
    });
    return "";
  }
  await safeStateRedisSet(keyBillingCityState(waId), v, {
    userId: waId,
    step: "set_billing_city_state",
  });
  return v;
}

export async function clearBillingCityState(waId) {
  await indexUser(waId);
  await safeStateRedisDel(keyBillingCityState(waId), { userId: waId, step: "clear_billing_city_state", critical: false });
  return true;
}

export async function getBillingAddress(waId) {
  return safeStr(await safeStateRedisGet(keyBillingAddress(waId), {
    userId: waId,
    key: keyBillingAddress(waId),
    step: "get_billing_address",
    fallback: "",
  }));
}

export async function setBillingAddress(waId, value) {
  await safeStateIndexUser(waId, "set_billing_address:index");
  const raw = compactInnerWhitespace(value);
  const v = /^apenas\s+online$/i.test(raw) ? "APENAS ONLINE" : normalizeAddressText(raw);
  if (!v) {
    await safeStateRedisDel(keyBillingAddress(waId), {
      userId: waId,
      step: "set_billing_address:clear",
    });
    return "";
  }
  await safeStateRedisSet(keyBillingAddress(waId), v, {
    userId: waId,
    step: "set_billing_address",
  });
  return v;
}

export async function clearBillingAddress(waId) {
  await indexUser(waId);
  await safeStateRedisDel(keyBillingAddress(waId), { userId: waId, step: "clear_billing_address", critical: false });
  return true;
}

// ===================== Asaas IDs =====================
export async function setAsaasCustomerId(waId, customerId) {
  await safeStateIndexUser(waId, "set_asaas_customer_id:index");
  const id = safeStr(customerId);
  if (!id) {
    await safeStateRedisDel(keyAsaasCustomerId(waId), {
      userId: waId,
      step: "set_asaas_customer_id:clear",
    });
    return "";
  }
  await safeStateRedisSet(keyAsaasCustomerId(waId), id, {
    userId: waId,
    step: "set_asaas_customer_id",
  });
  return id;
}

export async function getAsaasCustomerId(waId) {
  const v = await safeStateRedisGet(keyAsaasCustomerId(waId), {
    userId: waId,
    key: keyAsaasCustomerId(waId),
    step: "get_asaas_customer_id",
    fallback: "",
  });
  return safeStr(v);
}

export async function setAsaasSubscriptionId(waId, subId) {
  await safeStateIndexUser(waId, "set_asaas_subscription_id:index");
  const id = safeStr(subId);
  if (!id) {
    await safeStateRedisDel(keyAsaasSubscriptionId(waId), {
      userId: waId,
      step: "set_asaas_subscription_id:clear",
    });
    return "";
  }
  await safeStateRedisSet(keyAsaasSubscriptionId(waId), id, {
    userId: waId,
    step: "set_asaas_subscription_id",
  });
  return id;
}

export async function getAsaasSubscriptionId(waId) {
  const v = await safeStateRedisGet(keyAsaasSubscriptionId(waId), {
    userId: waId,
    key: keyAsaasSubscriptionId(waId),
    step: "get_asaas_subscription_id",
    fallback: "",
  });
  return safeStr(v);
}


// ===================== Menu Prev Status =====================
export async function setMenuPrevStatus(waId, prevStatus) {
  await indexUser(waId);
  const s = safeStr(prevStatus).toUpperCase();
  if (!s) {
    await safeStateRedisDel(keyMenuPrevStatus(waId), { userId: waId, step: "clear_menu_prev_status", critical: false });
    return "";
  }
  await safeStateRedisSet(keyMenuPrevStatus(waId), s, { userId: waId, step: "set_menu_prev_status", critical: false });
  return s;
}

export async function getMenuPrevStatus(waId) {
  const v = await safeStateRedisGet(keyMenuPrevStatus(waId), { userId: waId, step: "get_menu_prev_status", fallback: "" });
  return safeStr(v).toUpperCase();
}

export async function clearMenuPrevStatus(waId) {
  await indexUser(waId);
  await safeStateRedisDel(keyMenuPrevStatus(waId), { userId: waId, step: "clear_menu_prev_status", critical: false });
  return true;
}

export async function setMenuEditContext(waId, context) {
  await safeStateIndexUser(waId, "set_menu_edit_context:index");
  const payload = context && typeof context === "object" ? context : {};
  if (!Object.keys(payload).length) {
    await safeStateRedisDel(keyMenuEditContext(waId), {
      userId: waId,
      step: "set_menu_edit_context:clear",
    });
    return null;
  }
  await safeStateRedisSet(keyMenuEditContext(waId), safeJsonStringify(payload), {
    userId: waId,
    step: "set_menu_edit_context",
  });
  return payload;
}

export async function getMenuEditContext(waId) {
  const raw = await safeStateRedisGet(keyMenuEditContext(waId), {
    userId: waId,
    key: keyMenuEditContext(waId),
    step: "get_menu_edit_context:read",
    fallback: "",
  });
  const parsed = safeStateJsonParse(raw, null, {
    userId: waId,
    key: keyMenuEditContext(waId),
    step: "get_menu_edit_context:parse",
  });
  return parsed && typeof parsed === "object" ? parsed : null;
}

export async function clearMenuEditContext(waId) {
  await indexUser(waId);
  await redisDel(keyMenuEditContext(waId));
  return true;
}


// ===================== Prev Status (transitórios) =====================
export async function setPrevStatus(waId, prevStatus) {
  await indexUser(waId);
  const s = safeStr(prevStatus).toUpperCase();
  if (!s) {
    await safeStateRedisDel(keyPrevStatus(waId), { userId: waId, step: "clear_prev_status", critical: false });
    return "";
  }
  await safeStateRedisSet(keyPrevStatus(waId), s, { userId: waId, step: "set_prev_status", critical: false });
  return s;
}

export async function getPrevStatus(waId) {
  const v = await safeStateRedisGet(keyPrevStatus(waId), { userId: waId, step: "get_prev_status", fallback: "" });
  return safeStr(v).toUpperCase();
}

export async function clearPrevStatus(waId) {
  await indexUser(waId);
  await safeStateRedisDel(keyPrevStatus(waId), { userId: waId, step: "clear_prev_status", critical: false });
  return true;
}

// ===================== Biz Profile (salvo) =====================
export async function getBizProfile(waId) {
  const raw = await safeStateRedisGet(keyBizProfile(waId), {
    userId: waId,
    key: keyBizProfile(waId),
    step: "get_biz_profile:read",
    fallback: "",
  });
  const obj = safeStateJsonParse(raw, null, {
    userId: waId,
    key: keyBizProfile(waId),
    step: "get_biz_profile:parse",
  });
  return obj && typeof obj === "object" ? obj : null;
}

export async function setBizProfile(waId, profileObj) {
  await safeStateIndexUser(waId, "set_biz_profile:index");
  const normalized = normalizeBizProfileData(profileObj);
  const s = safeJsonStringify(normalized);
  await safeStateRedisSet(keyBizProfile(waId), s, {
    userId: waId,
    step: "set_biz_profile",
  });
  return true;
}

export async function clearBizProfile(waId) {
  await safeStateIndexUser(waId, "clear_biz_profile:index");
  await safeStateRedisDel(keyBizProfile(waId), {
    userId: waId,
    step: "clear_biz_profile",
  });
  return true;
}

// ===================== Biz Profile (pendente) =====================
export async function getPendingBizProfile(waId) {
  const raw = await safeStateRedisGet(keyPendingBizProfile(waId), {
    userId: waId,
    key: keyPendingBizProfile(waId),
    step: "get_pending_biz_profile:read",
    fallback: "",
  });
  const obj = safeStateJsonParse(raw, null, {
    userId: waId,
    key: keyPendingBizProfile(waId),
    step: "get_pending_biz_profile:parse",
  });
  return obj && typeof obj === "object" ? obj : null;
}

export async function setPendingBizProfile(waId, profileObj) {
  await safeStateIndexUser(waId, "set_pending_biz_profile:index");
  const normalized = normalizeBizProfileData(profileObj);
  const s = safeJsonStringify(normalized);
  await safeStateRedisSet(keyPendingBizProfile(waId), s, {
    userId: waId,
    step: "set_pending_biz_profile",
  });
  return true;
}

export async function clearPendingBizProfile(waId) {
  await safeStateIndexUser(waId, "clear_pending_biz_profile:index");
  await safeStateRedisDel(keyPendingBizProfile(waId), {
    userId: waId,
    step: "clear_pending_biz_profile",
  });
  return true;
}

// ===================== Ad Session (anúncio atual) =====================
export async function getCurrentAdSession(waId) {
  const raw = await safeStateRedisGet(keyCurrentAdSession(waId), {
    userId: waId,
    key: keyCurrentAdSession(waId),
    step: "get_current_ad_session:read",
    fallback: "",
  });
  const obj = safeStateJsonParse(raw, null, {
    userId: waId,
    key: keyCurrentAdSession(waId),
    step: "get_current_ad_session:parse",
  });
  return obj && typeof obj === "object" ? obj : null;
}

export async function setCurrentAdSession(waId, sessionObj) {
  await safeStateIndexUser(waId, "set_current_ad_session:index");
  const s = safeJsonStringify(sessionObj);
  await safeStateRedisSet(keyCurrentAdSession(waId), s, {
    userId: waId,
    step: "set_current_ad_session",
  });
  return true;
}

export async function clearCurrentAdSession(waId) {
  await safeStateIndexUser(waId, "clear_current_ad_session:index");
  await safeStateRedisDel(keyCurrentAdSession(waId), {
    userId: waId,
    step: "clear_current_ad_session",
  });
  return true;
}

// ===================== Checkout / Coupon =====================
export async function getCheckoutDraft(waId) {
  const raw = await safeStateRedisGet(keyCheckoutDraft(waId), {
    userId: waId,
    key: keyCheckoutDraft(waId),
    step: "get_checkout_draft:read",
    fallback: "",
  });
  const parsed = safeStateJsonParse(raw, null, {
    userId: waId,
    key: keyCheckoutDraft(waId),
    step: "get_checkout_draft:parse",
  });
  return normalizeCheckoutDraft(parsed);
}

export async function setCheckoutDraft(waId, draftObj) {
  await safeStateIndexUser(waId, "set_checkout_draft:index");
  const normalized = normalizeCheckoutDraft(draftObj);
  if (!normalized) {
    await safeStateRedisDel(keyCheckoutDraft(waId), {
      userId: waId,
      step: "set_checkout_draft:clear",
    critical: true,
    });
    return null;
  }
  await safeStateRedisSet(keyCheckoutDraft(waId), safeJsonStringify(normalized), {
    userId: waId,
    step: "set_checkout_draft",
    critical: true,
  });
  return normalized;
}

export async function clearCheckoutDraft(waId) {
  await indexUser(waId);
  await redisDel(keyCheckoutDraft(waId));
  return true;
}

export async function getSelectedPlanCode(waId) {
  return normalizePlanCode(await safeStateRedisGet(keySelectedPlanCode(waId), {
    userId: waId,
    key: keySelectedPlanCode(waId),
    step: "get_selected_plan_code",
    fallback: "",
  }));
}

export async function setSelectedPlanCode(waId, planCode) {
  await safeStateIndexUser(waId, "set_selected_plan_code:index");
  const normalized = normalizePlanCode(planCode);
  if (!normalized) {
    await safeStateRedisDel(keySelectedPlanCode(waId), {
      userId: waId,
      step: "set_selected_plan_code:clear",
    });
    return "";
  }
  await safeStateRedisSet(keySelectedPlanCode(waId), normalized, {
    userId: waId,
    step: "set_selected_plan_code",
  });
  return normalized;
}

export async function clearSelectedPlanCode(waId) {
  await indexUser(waId);
  await redisDel(keySelectedPlanCode(waId));
  return true;
}

export async function getSelectedBillingCycle(waId) {
  return normalizeBillingCycle(await safeStateRedisGet(keySelectedBillingCycle(waId), {
    userId: waId,
    key: keySelectedBillingCycle(waId),
    step: "get_selected_billing_cycle",
    fallback: "",
  }));
}

export async function setSelectedBillingCycle(waId, billingCycle) {
  await safeStateIndexUser(waId, "set_selected_billing_cycle:index");
  const normalized = normalizeBillingCycle(billingCycle);
  if (!normalized) {
    await safeStateRedisDel(keySelectedBillingCycle(waId), {
      userId: waId,
      step: "set_selected_billing_cycle:clear",
    });
    return "";
  }
  await safeStateRedisSet(keySelectedBillingCycle(waId), normalized, {
    userId: waId,
    step: "set_selected_billing_cycle",
  });
  return normalized;
}

export async function clearSelectedBillingCycle(waId) {
  await indexUser(waId);
  await redisDel(keySelectedBillingCycle(waId));
  return true;
}

export async function getSelectedCouponCode(waId) {
  return normalizeCouponCode(await safeStateRedisGet(keySelectedCouponCode(waId), {
    userId: waId,
    key: keySelectedCouponCode(waId),
    step: "get_selected_coupon_code",
    fallback: "",
  }));
}

export async function setSelectedCouponCode(waId, couponCode) {
  await safeStateIndexUser(waId, "set_selected_coupon_code:index");
  const normalized = normalizeCouponCode(couponCode);
  if (!normalized) {
    await safeStateRedisDel(keySelectedCouponCode(waId), {
      userId: waId,
      step: "set_selected_coupon_code:clear",
    });
    return "";
  }
  await safeStateRedisSet(keySelectedCouponCode(waId), normalized, {
    userId: waId,
    step: "set_selected_coupon_code",
  });
  return normalized;
}

export async function clearSelectedCouponCode(waId) {
  await indexUser(waId);
  await redisDel(keySelectedCouponCode(waId));
  return true;
}

export async function getPricingQuote(waId) {
  const raw = await safeStateRedisGet(keyPricingQuote(waId), {
    userId: waId,
    key: keyPricingQuote(waId),
    step: "get_pricing_quote:read",
    fallback: "",
  });
  const parsed = safeStateJsonParse(raw, null, {
    userId: waId,
    key: keyPricingQuote(waId),
    step: "get_pricing_quote:parse",
  });
  return normalizePricingQuote(parsed);
}

export async function setPricingQuote(waId, pricingQuote) {
  await safeStateIndexUser(waId, "set_pricing_quote:index");
  const normalized = normalizePricingQuote(pricingQuote);
  if (!normalized) {
    await safeStateRedisDel(keyPricingQuote(waId), {
      userId: waId,
      step: "set_pricing_quote:clear",
    critical: true,
    });
    return null;
  }
  await safeStateRedisSet(keyPricingQuote(waId), safeJsonStringify(normalized), {
    userId: waId,
    step: "set_pricing_quote",
    critical: true,
  });
  return normalized;
}

export async function clearPricingQuote(waId) {
  await indexUser(waId);
  await redisDel(keyPricingQuote(waId));
  return true;
}

export async function getCouponReservationId(waId) {
  return safeStr(await safeStateRedisGet(keyCouponReservationId(waId), {
    userId: waId,
    key: keyCouponReservationId(waId),
    step: "get_coupon_reservation_id",
    fallback: "",
  }));
}

export async function setCouponReservationId(waId, reservationId) {
  await safeStateIndexUser(waId, "set_coupon_reservation_id:index");
  const normalized = safeStr(reservationId);
  if (!normalized) {
    await safeStateRedisDel(keyCouponReservationId(waId), {
      userId: waId,
      step: "set_coupon_reservation_id:clear",
    critical: true,
    });
    return "";
  }
  await safeStateRedisSet(keyCouponReservationId(waId), normalized, {
    userId: waId,
    step: "set_coupon_reservation_id",
    critical: true,
  });
  return normalized;
}

export async function clearCouponReservationId(waId) {
  await indexUser(waId);
  await redisDel(keyCouponReservationId(waId));
  return true;
}

export async function getCouponReservationCreatedAt(waId) {
  return normalizeIsoTimestamp(await safeStateRedisGet(keyCouponReservationCreatedAt(waId), {
    userId: waId,
    key: keyCouponReservationCreatedAt(waId),
    step: "get_coupon_reservation_created_at",
    fallback: "",
  }));
}

export async function setCouponReservationCreatedAt(waId, isoTs) {
  await safeStateIndexUser(waId, "set_coupon_reservation_created_at:index");
  const normalized = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  await safeStateRedisSet(keyCouponReservationCreatedAt(waId), normalized, {
    userId: waId,
    step: "set_coupon_reservation_created_at",
    critical: true,
  });
  return normalized;
}

export async function clearCouponReservationCreatedAt(waId) {
  await indexUser(waId);
  await redisDel(keyCouponReservationCreatedAt(waId));
  return true;
}

export async function getCheckoutCouponStatus(waId) {
  return normalizeCheckoutCouponStatus(await safeStateRedisGet(keyCheckoutCouponStatus(waId), {
    userId: waId,
    key: keyCheckoutCouponStatus(waId),
    step: "get_checkout_coupon_status",
    fallback: "",
  }));
}

export async function setCheckoutCouponStatus(waId, status) {
  await safeStateIndexUser(waId, "set_checkout_coupon_status:index");
  const normalized = normalizeCheckoutCouponStatus(status);
  if (!normalized) {
    await safeStateRedisDel(keyCheckoutCouponStatus(waId), {
      userId: waId,
      step: "set_checkout_coupon_status:clear",
    critical: true,
    });
    return "";
  }
  await safeStateRedisSet(keyCheckoutCouponStatus(waId), normalized, {
    userId: waId,
    step: "set_checkout_coupon_status",
    critical: true,
  });
  return normalized;
}

export async function clearCheckoutCouponStatus(waId) {
  await indexUser(waId);
  await redisDel(keyCheckoutCouponStatus(waId));
  return true;
}

export async function resetCheckoutCouponState(waId) {
  await safeStateIndexUser(waId, "reset_checkout_coupon_state:index");

  const jobs = [
    ["checkout_draft", () => clearCheckoutDraft(waId)],
    ["selected_plan_code", () => clearSelectedPlanCode(waId)],
    ["selected_billing_cycle", () => clearSelectedBillingCycle(waId)],
    ["selected_coupon_code", () => clearSelectedCouponCode(waId)],
    ["pricing_quote", () => clearPricingQuote(waId)],
    ["coupon_reservation_id", () => clearCouponReservationId(waId)],
    ["coupon_reservation_created_at", () => clearCouponReservationCreatedAt(waId)],
    ["checkout_coupon_status", () => clearCheckoutCouponStatus(waId)],
  ];

  const results = await Promise.allSettled(jobs.map(([, run]) => run()));
  const failures = results
    .map((result, index) => ({ result, key: jobs[index][0] }))
    .filter(({ result }) => result.status === "rejected");

  if (failures.length) {
    await logStateOperationalError({
      userId: waId,
      key: "checkout_coupon_state",
      step: "reset_checkout_coupon_state",
      errorCode: STATE_ERROR_CODE.RUNTIME,
      error: failures[0].result.reason,
      event: "state_reset_partial_failure",
      meta: {
        failedKeys: failures.map((item) => item.key),
        failureCount: failures.length,
      },
    });
    throw failures[0].result.reason;
  }

  return true;
}

// ===================== Card Validity / Cancel =====================
export async function setCardValidUntil(waId, isoDate) {
  await safeStateIndexUser(waId, "set_card_valid_until:index");
  const d = safeStr(isoDate);
  if (!d) {
    await safeStateRedisDel(keyCardValidUntil(waId), {
      userId: waId,
      step: "set_card_valid_until:clear",
    });
    return "";
  }
  await safeStateRedisSet(keyCardValidUntil(waId), d, {
    userId: waId,
    step: "set_card_valid_until",
  });
  return d;
}

export async function getCardValidUntil(waId) {
  const v = await safeStateRedisGet(keyCardValidUntil(waId), {
    userId: waId,
    key: keyCardValidUntil(waId),
    step: "get_card_valid_until",
    fallback: "",
  });
  return safeStr(v);
}

export async function setCardCanceledAt(waId, isoTs) {
  await safeStateIndexUser(waId, "set_card_canceled_at:index");
  const ts = safeStr(isoTs);
  if (!ts) {
    await safeStateRedisDel(keyCardCanceledAt(waId), {
      userId: waId,
      step: "set_card_canceled_at:clear",
    });
    return "";
  }
  await safeStateRedisSet(keyCardCanceledAt(waId), ts, {
    userId: waId,
    step: "set_card_canceled_at",
  });
  return ts;
}

export async function getCardCanceledAt(waId) {
  const v = await safeStateRedisGet(keyCardCanceledAt(waId), {
    userId: waId,
    key: keyCardCanceledAt(waId),
    step: "get_card_canceled_at",
    fallback: "",
  });
  return safeStr(v);
}

// ===================== Activity / Growth Meta =====================
export async function getActivityMeta(waId) {
  const raw = await safeStateRedisGet(keyActivityMeta(waId), {
    userId: waId,
    key: keyActivityMeta(waId),
    step: "get_activity_meta:read",
    fallback: "",
  });
  const parsed = safeStateJsonParse(raw, null, {
    userId: waId,
    key: keyActivityMeta(waId),
    step: "get_activity_meta:parse",
  });
  return normalizeActivityMeta(parsed);
}

export async function setActivityMeta(waId, metaObj) {
  await safeStateIndexUser(waId, "set_activity_meta:index");
  const normalized = normalizeActivityMeta(metaObj);
  if (!Object.keys(normalized).length) {
    await safeStateRedisDel(keyActivityMeta(waId), {
      userId: waId,
      step: "set_activity_meta:clear",
    });
    return {};
  }
  await safeStateRedisSet(keyActivityMeta(waId), safeJsonStringify(normalized), {
    userId: waId,
    step: "set_activity_meta",
  });
  return normalized;
}

export async function clearActivityMeta(waId) {
  await safeStateIndexUser(waId, "clear_activity_meta:index");
  await safeStateRedisDel(keyActivityMeta(waId), {
    userId: waId,
    step: "clear_activity_meta",
  });
  return true;
}

export async function getLastInboundAt(waId) {
  const meta = await getActivityMeta(waId);
  return safeStr(meta.lastInboundAt);
}

export async function setLastInboundAt(waId, isoTs) {
  const meta = await getActivityMeta(waId);
  meta.lastInboundAt = normalizeIsoTimestamp(isoTs || new Date().toISOString());
  return setActivityMeta(waId, meta);
}

export async function getFloodMeta(waId) {
  const meta = await getActivityMeta(waId);
  return isPlainObject(meta.flood) ? meta.flood : {};
}

export async function setFloodMeta(waId, floodMeta) {
  const meta = await getActivityMeta(waId);
  const normalizedFlood = normalizeActivityMeta({ flood: floodMeta }).flood;
  if (normalizedFlood) meta.flood = normalizedFlood;
  else delete meta.flood;
  return setActivityMeta(waId, meta);
}

export async function clearFloodMeta(waId) {
  const meta = await getActivityMeta(waId);
  delete meta.flood;
  return setActivityMeta(waId, meta);
}

export async function getPlansViewedAt(waId) {
  const meta = await getActivityMeta(waId);
  return safeStr(meta.plansViewedAt);
}

export async function setPlansViewedAt(waId, isoTs = new Date().toISOString()) {
  const meta = await getActivityMeta(waId);
  meta.plansViewedAt = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  return setActivityMeta(waId, meta);
}

export async function clearPlansViewedAt(waId) {
  const meta = await getActivityMeta(waId);
  delete meta.plansViewedAt;
  return setActivityMeta(waId, meta);
}

export async function getCheckoutStartedAt(waId) {
  const meta = await getActivityMeta(waId);
  return safeStr(meta.checkoutStartedAt);
}

export async function setCheckoutStartedAt(waId, isoTs = new Date().toISOString()) {
  const meta = await getActivityMeta(waId);
  meta.checkoutStartedAt = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  return setActivityMeta(waId, meta);
}

export async function clearCheckoutStartedAt(waId) {
  const meta = await getActivityMeta(waId);
  delete meta.checkoutStartedAt;
  return setActivityMeta(waId, meta);
}

export async function getTrialEndedAt(waId) {
  const meta = await getActivityMeta(waId);
  return safeStr(meta.trialEndedAt);
}

export async function setTrialEndedAt(waId, isoTs = new Date().toISOString()) {
  const meta = await getActivityMeta(waId);
  meta.trialEndedAt = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  return setActivityMeta(waId, meta);
}

export async function clearTrialEndedAt(waId) {
  const meta = await getActivityMeta(waId);
  delete meta.trialEndedAt;
  return setActivityMeta(waId, meta);
}

export async function getLastCampaignInteractionAt(waId) {
  const meta = await getActivityMeta(waId);
  return safeStr(meta.lastCampaignInteractionAt);
}

export async function setLastCampaignInteractionAt(waId, isoTs = new Date().toISOString()) {
  const meta = await getActivityMeta(waId);
  meta.lastCampaignInteractionAt = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  return setActivityMeta(waId, meta);
}

export async function clearLastCampaignInteractionAt(waId) {
  const meta = await getActivityMeta(waId);
  delete meta.lastCampaignInteractionAt;
  return setActivityMeta(waId, meta);
}

export async function getLastPlanPromptAt(waId) {
  const meta = await getActivityMeta(waId);
  return safeStr(meta.lastPlanPromptAt);
}

export async function setLastPlanPromptAt(waId, isoTs = new Date().toISOString()) {
  const meta = await getActivityMeta(waId);
  meta.lastPlanPromptAt = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  return setActivityMeta(waId, meta);
}

export async function clearLastPlanPromptAt(waId) {
  const meta = await getActivityMeta(waId);
  delete meta.lastPlanPromptAt;
  return setActivityMeta(waId, meta);
}

export async function getPostAdIdleMeta(waId) {
  const meta = await getActivityMeta(waId);
  return {
    postAdIdleState: safeStr(meta.postAdIdleState).toUpperCase(),
    postAdIdleArmedAt: safeStr(meta.postAdIdleArmedAt),
    postAdIdleReminderSentAt: safeStr(meta.postAdIdleReminderSentAt),
  };
}

export async function armPostAdIdleReminder(waId, idleState, isoTs = new Date().toISOString()) {
  const meta = await getActivityMeta(waId);
  const normalizedState = safeStr(idleState).toUpperCase();
  if (!["REFINE_OR_OK", "WAIT_NEXT_DESCRIPTION"].includes(normalizedState)) {
    delete meta.postAdIdleState;
    delete meta.postAdIdleArmedAt;
    delete meta.postAdIdleReminderSentAt;
    return setActivityMeta(waId, meta);
  }
  meta.postAdIdleState = normalizedState;
  meta.postAdIdleArmedAt = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  delete meta.postAdIdleReminderSentAt;
  return setActivityMeta(waId, meta);
}

export async function markPostAdIdleReminderSent(waId, isoTs = new Date().toISOString()) {
  const meta = await getActivityMeta(waId);
  meta.postAdIdleReminderSentAt = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  return setActivityMeta(waId, meta);
}

export async function clearPostAdIdleReminder(waId) {
  const meta = await getActivityMeta(waId);
  delete meta.postAdIdleState;
  delete meta.postAdIdleArmedAt;
  delete meta.postAdIdleReminderSentAt;
  return setActivityMeta(waId, meta);
}

export async function getGrowthMeta(waId) {
  const raw = await safeStateRedisGet(keyGrowthMeta(waId), {
    userId: waId,
    key: keyGrowthMeta(waId),
    step: "get_growth_meta:read",
    fallback: "",
  });
  const parsed = safeStateJsonParse(raw, null, {
    userId: waId,
    key: keyGrowthMeta(waId),
    step: "get_growth_meta:parse",
  });
  return normalizeGrowthMeta(parsed);
}

export async function setGrowthMeta(waId, metaObj) {
  await safeStateIndexUser(waId, "set_growth_meta:index");
  const normalized = normalizeGrowthMeta(metaObj);
  if (!Object.keys(normalized).length) {
    await safeStateRedisDel(keyGrowthMeta(waId), {
      userId: waId,
      step: "set_growth_meta:clear",
    });
    return {};
  }
  await safeStateRedisSet(keyGrowthMeta(waId), safeJsonStringify(normalized), {
    userId: waId,
    step: "set_growth_meta",
  });
  return normalized;
}

export async function clearGrowthMeta(waId) {
  await safeStateIndexUser(waId, "clear_growth_meta:index");
  await safeStateRedisDel(keyGrowthMeta(waId), {
    userId: waId,
    step: "clear_growth_meta",
  });
  return true;
}

export async function getUserAdsCreatedTotal(waId) {
  const meta = await getGrowthMeta(waId);
  return toInt(meta.adsCreatedTotal, 0);
}

export async function setUserAdsCreatedTotal(waId, value) {
  const meta = await getGrowthMeta(waId);
  meta.adsCreatedTotal = Math.max(0, toInt(value, 0));
  return setGrowthMeta(waId, meta);
}

export async function incUserAdsCreatedTotal(waId, by = 1) {
  const meta = await getGrowthMeta(waId);
  meta.adsCreatedTotal = Math.max(0, toInt(meta.adsCreatedTotal, 0) + toInt(by, 1));
  await setGrowthMeta(waId, meta);
  return toInt(meta.adsCreatedTotal, 0);
}

export async function markUserAdCreated(waId, isoTs = new Date().toISOString()) {
  const meta = await getGrowthMeta(waId);
  const normalizedTs = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  meta.adsCreatedTotal = Math.max(0, toInt(meta.adsCreatedTotal, 0) + 1);
  meta.lastAdCreatedAt = normalizedTs;
  meta.lastAdCreatedDate = normalizeIsoDate(normalizedTs);
  await setGrowthMeta(waId, meta);
  return {
    adsCreatedTotal: toInt(meta.adsCreatedTotal, 0),
    lastAdCreatedAt: meta.lastAdCreatedAt,
    lastAdCreatedDate: meta.lastAdCreatedDate,
  };
}

export async function markFeedbackAsked(waId, isoTs = new Date().toISOString()) {
  const meta = await getGrowthMeta(waId);
  meta.feedbackAskedAt = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  return setGrowthMeta(waId, meta);
}

export async function markFeedbackAnswered(waId, response, isoTs = new Date().toISOString()) {
  const meta = await getGrowthMeta(waId);
  meta.feedbackAnsweredAt = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  meta.feedbackResponse = safeStr(response);
  return setGrowthMeta(waId, meta);
}

export async function markTestimonialAsked(waId, isoTs = new Date().toISOString()) {
  const meta = await getGrowthMeta(waId);
  meta.testimonialAskedAt = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  return setGrowthMeta(waId, meta);
}

export async function saveFeedbackComment(waId, comment, isoTs = new Date().toISOString()) {
  const meta = await getGrowthMeta(waId);
  const normalizedComment = normalizeFreeTextField(comment);
  if (!normalizedComment) {
    delete meta.feedbackComment;
    delete meta.feedbackCommentAt;
  } else {
    meta.feedbackComment = normalizedComment;
    meta.feedbackCommentAt = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  }
  return setGrowthMeta(waId, meta);
}

export async function saveTestimonialText(waId, testimonialText, isoTs = new Date().toISOString()) {
  const meta = await getGrowthMeta(waId);
  const normalizedText = normalizeFreeTextField(testimonialText);
  if (!normalizedText) {
    delete meta.testimonialText;
    delete meta.testimonialTextAt;
    delete meta.testimonialReceivedAt;
  } else {
    const nowIso = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
    meta.testimonialText = normalizedText;
    meta.testimonialTextAt = nowIso;
    meta.testimonialReceivedAt = nowIso;
  }
  return setGrowthMeta(waId, meta);
}

export async function setTestimonialConsent(waId, consent, isoTs = new Date().toISOString()) {
  const meta = await getGrowthMeta(waId);
  const normalizedConsent = safeStr(consent).toUpperCase() === "YES" ? "YES" : "NO";
  meta.testimonialConsent = normalizedConsent;
  meta.testimonialConsentAt = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  if (normalizedConsent === "YES") {
    if (!safeStr(meta.testimonialStatus)) meta.testimonialStatus = "PENDING_REVIEW";
  } else {
    meta.testimonialStatus = "INTERNAL_ONLY";
    delete meta.testimonialDisplayMode;
    delete meta.testimonialDisplayName;
  }
  meta.testimonialStatusUpdatedAt = meta.testimonialConsentAt;
  return setGrowthMeta(waId, meta);
}

function resolveTestimonialDisplayName(mode, fullName, companyName) {
  const normalizedMode = safeStr(mode).toUpperCase();
  const safeFullName = safeStr(fullName);
  const safeCompanyName = safeStr(companyName);
  const firstName = safeFullName ? safeFullName.split(/\s+/).filter(Boolean)[0] || safeFullName : "";

  if (normalizedMode === "COMPANY") {
    if (safeCompanyName) return { mode: "COMPANY", name: safeCompanyName };
    if (firstName) return { mode: "FIRST_NAME", name: firstName };
    return { mode: "ANONYMOUS", name: "Cliente do Amigo das Vendas" };
  }

  if (normalizedMode === "ANONYMOUS") {
    return { mode: "ANONYMOUS", name: "Cliente do Amigo das Vendas" };
  }

  if (firstName) return { mode: "FIRST_NAME", name: firstName };
  if (safeCompanyName) return { mode: "COMPANY", name: safeCompanyName };
  return { mode: "ANONYMOUS", name: "Cliente do Amigo das Vendas" };
}

export async function setTestimonialDisplayPreference(waId, mode, isoTs = new Date().toISOString()) {
  const meta = await getGrowthMeta(waId);
  const profile = await getBizProfile(waId);
  const fullName = await getUserFullName(waId);
  const companyName = normalizeCompanyName(profile?.companyName || "");
  const resolved = resolveTestimonialDisplayName(mode, fullName, companyName);
  const nowIso = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();

  meta.testimonialDisplayMode = resolved.mode;
  meta.testimonialDisplayName = resolved.name;
  meta.testimonialStatus = meta.testimonialConsent === "YES" ? "PENDING_REVIEW" : "INTERNAL_ONLY";
  meta.testimonialStatusUpdatedAt = nowIso;
  return setGrowthMeta(waId, meta);
}

export async function setTestimonialReviewStatus(waId, status, isoTs = new Date().toISOString()) {
  const meta = await getGrowthMeta(waId);
  const normalizedStatus = safeStr(status).toUpperCase();
  if (!["PENDING_REVIEW", "APPROVED", "REJECTED", "PUBLISHED", "INTERNAL_ONLY"].includes(normalizedStatus)) {
    throw new Error("invalid testimonial status");
  }
  meta.testimonialStatus = normalizedStatus;
  meta.testimonialStatusUpdatedAt = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  return setGrowthMeta(waId, meta);
}

export async function markReferralAsked(waId, isoTs = new Date().toISOString()) {
  const meta = await getGrowthMeta(waId);
  meta.referralAskedAt = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  return setGrowthMeta(waId, meta);
}

export async function markAdOfDaySent(waId, isoTs = new Date().toISOString()) {
  const meta = await getGrowthMeta(waId);
  const normalizedTs = normalizeIsoTimestamp(isoTs || new Date().toISOString()) || new Date().toISOString();
  meta.adOfDaySentAt = normalizedTs;
  meta.adOfDaySentDate = normalizeIsoDate(normalizedTs);
  return setGrowthMeta(waId, meta);
}

// ===================== Reset helpers =====================
export async function resetUserToTrial(waId) {
  await ensureUserExists(waId);
  await Promise.all([
    setUserStatus(waId, "TRIAL"),
    setUserPlan(waId, ""), // ✅ agora faz DEL internamente, não SET ""
    resetUserQuotaUsed(waId),
    resetUserTrialUsed(waId),
    clearLastPrompt(waId),
    setTemplateMode(waId, "FIXED"),
    clearPaymentMethod(waId),
    clearUserDoc(waId),
    setAsaasCustomerId(waId, ""), // já faz DEL internamente
    setAsaasSubscriptionId(waId, ""), // já faz DEL internamente
    clearMenuPrevStatus(waId),
    clearMenuEditContext(waId),
    clearPrevStatus(waId),
    clearBizProfile(waId),
    clearPendingBizProfile(waId),
    clearCurrentAdSession(waId),
    resetCheckoutCouponState(waId),
    clearLastAd(waId),
    clearRefineCount(waId),
    clearBillingCityState(waId),
    clearBillingAddress(waId),
    clearActivityMeta(waId),
    clearGrowthMeta(waId),
    setCardValidUntil(waId, ""),
    setCardCanceledAt(waId, ""),
  ]);
  return true;
}

// ⚠️ Reset TOTAL (para número de teste) — remove tudo como se nunca tivesse escrito
// Regras:
// - NÃO chama ensureUserExists (para não recriar chaves)
// - NÃO usa SCAN/KEYS
// - Remove do índice users:index
// - Não mexe em métricas/copy/window24h (isso é feito por módulos específicos)
export async function resetUserAsNew(waId) {
  const id = safeStr(waId);
  if (!id) throw new Error("userRef required");

  const keys = [
    keyStatus(id),
    keyPlan(id),
    keyQuotaUsed(id),
    keyTrialUsed(id),
    keyLastPrompt(id),
    keyLastAd(id),
    keyRefineCount(id),
    keyTemplateMode(id),
    keyTemplatePrompted(id),
    keyFullName(id),
    keyDocType(id),
    keyDocLast4(id),
    keyDocLegacy(id),
    keyPaymentMethod(id),
    keyAsaasCustomerId(id),
    keyAsaasSubscriptionId(id),
    keyMenuPrevStatus(id),
    keyMenuEditContext(id),
    keyBillingCityState(id),
    keyBillingAddress(id),
    keyCardValidUntil(id),
    keyCardCanceledAt(id),
    keyPrevStatus(id),
    keyBizProfile(id),
    keyPendingBizProfile(id),
    keyCurrentAdSession(id),
    keyCheckoutDraft(id),
    keySelectedPlanCode(id),
    keySelectedBillingCycle(id),
    keySelectedCouponCode(id),
    keyPricingQuote(id),
    keyCouponReservationId(id),
    keyCouponReservationCreatedAt(id),
    keyCheckoutCouponStatus(id),
    keyActivityMeta(id),
    keyGrowthMeta(id),
  ];

  // best-effort: apaga todas as chaves conhecidas
  await Promise.allSettled(keys.map((k) => safeStateRedisDel(k, { userId: id, step: "reset_user_as_new:delete_key", critical: false })));

  // remove do índice para que o usuário só volte a existir quando reentrar no fluxo
  await safeStateRedisSRem(USERS_INDEX_KEY, id, { userId: id, step: "reset_user_as_new:remove_index", critical: false }).catch(() => null);

  return { ok: true, userId: id, waId: id, deletedKeys: keys.length };
}

// ===================== Admin user editing helpers =====================
const ADMIN_ALLOWED_USER_STATUSES = new Set([
  "TRIAL",
  "ACTIVE",
  "PAYMENT_PENDING",
  "BLOCKED",
  "WAIT_NAME",
  "WAIT_PLAN",
  "WAIT_PAYMENT_METHOD",
  "WAIT_BILLING_CITY_STATE",
  "WAIT_BILLING_ADDRESS",
  "WAIT_TEMPLATE_MODE",
  "WAIT_BIZ_PROFILE_CONFIRM",
  "WAIT_BIZ_PROFILE_FIELD",
  "WAIT_FEEDBACK_COMMENT",
  "WAIT_TESTIMONIAL_TEXT",
  "WAIT_TESTIMONIAL_CONSENT",
  "WAIT_TESTIMONIAL_DISPLAY_MODE",
]);

const ADMIN_EDITABLE_FIELD_KEYS = Object.freeze([
  "fullName",
  "status",
  "plan",
  "quotaUsed",
  "trialUsed",
  "templateMode",
  "paymentMethod",
  "billingCityState",
  "billingAddress",
  "docType",
  "docLast4",
  "asaasCustomerId",
  "asaasSubscriptionId",
  "cardValidUntil",
  "cardCanceledAt",
  "bizProfile",
  "pendingBizProfile",
  "activityMeta",
  "growthMeta",
  "selectedPlanCode",
  "selectedBillingCycle",
  "selectedCouponCode",
  "pricingQuote",
  "couponReservationId",
  "couponReservationCreatedAt",
  "checkoutCouponStatus",
  "checkoutDraft",
  "currentAdSession",
]);

const ADMIN_EDITABLE_FIELD_SET = new Set(ADMIN_EDITABLE_FIELD_KEYS);

function adminReject(field, code, message, value = undefined) {
  return {
    field: safeStr(field),
    code: safeStr(code) || "INVALID_FIELD",
    message: safeStr(message) || "Campo inválido para edição administrativa.",
    ...(value !== undefined ? { value } : {}),
  };
}

function adminHasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function adminJsonStable(value) {
  try { return JSON.stringify(value ?? null); } catch (_) { return "null"; }
}

function adminValuesEqual(a, b) {
  return adminJsonStable(a) === adminJsonStable(b);
}

function normalizeAdminNonNegativeInt(value) {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

function normalizeAdminStatus(value) {
  const status = safeStr(normalizeMaybeJsonString(value)).toUpperCase();
  if (!status) return null;
  return ADMIN_ALLOWED_USER_STATUSES.has(status) ? status : null;
}

function normalizeAdminTemplateMode(value) {
  const mode = safeStr(normalizeMaybeJsonString(value)).toUpperCase();
  if (!mode) return null;
  if (mode === "FIXED" || mode === "FREE") return mode;
  return null;
}

function normalizeAdminPaymentMethod(value) {
  const method = safeStr(normalizeMaybeJsonString(value)).toUpperCase();
  if (!method) return "";
  if (method === "PIX" || method === "CARD") return method;
  return null;
}

function normalizeAdminDocType(value) {
  const docType = safeStr(normalizeMaybeJsonString(value)).toUpperCase();
  if (!docType) return "";
  if (docType === "CPF" || docType === "CNPJ") return docType;
  return null;
}

function normalizeAdminDocLast4(value) {
  const raw = safeStr(normalizeMaybeJsonString(value));
  if (!raw) return "";
  const digits = raw.replace(/\D+/g, "");
  return digits.length === 4 ? digits : null;
}

function normalizeAdminIsoDate(value) {
  const raw = safeStr(normalizeMaybeJsonString(value));
  if (!raw) return "";
  return normalizeIsoDate(raw) || null;
}

function normalizeAdminIsoTimestamp(value) {
  const raw = safeStr(normalizeMaybeJsonString(value));
  if (!raw) return "";
  return normalizeIsoTimestamp(raw) || null;
}

function parseAdminEditableObject(value, field, rejectedFields) {
  if (value === undefined) return { provided: false, value: null };
  if (value === null) return { provided: true, value: null };
  if (typeof value === "string") {
    const raw = safeStr(value);
    if (!raw) return { provided: true, value: null };
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null) return { provided: true, value: null };
      if (isPlainObject(parsed)) return { provided: true, value: parsed };
      rejectedFields.push(adminReject(field, "INVALID_JSON_OBJECT", "O campo deve ser um objeto JSON ou vazio."));
      return { provided: false, value: null };
    } catch (_) {
      rejectedFields.push(adminReject(field, "INVALID_JSON", "O campo contém JSON inválido."));
      return { provided: false, value: null };
    }
  }
  if (isPlainObject(value)) return { provided: true, value };
  rejectedFields.push(adminReject(field, "INVALID_OBJECT", "O campo deve ser um objeto ou vazio."));
  return { provided: false, value: null };
}

function normalizeAdminEditablePatch(rawPatch = {}) {
  const patch = isPlainObject(rawPatch) ? rawPatch : {};
  const normalized = {};
  const rejectedFields = [];

  for (const key of Object.keys(patch)) {
    if (key === "doc") continue;
    if (!ADMIN_EDITABLE_FIELD_SET.has(key)) {
      rejectedFields.push(adminReject(key, "UNKNOWN_FIELD", "Campo não permitido para edição administrativa."));
    }
  }

  if (adminHasOwn(patch, "fullName")) normalized.fullName = normalizePersonName(patch.fullName);
  if (adminHasOwn(patch, "status")) {
    const value = normalizeAdminStatus(patch.status);
    if (value === null) rejectedFields.push(adminReject("status", "INVALID_STATUS", "Status não permitido para edição administrativa.", patch.status));
    else normalized.status = value;
  }
  if (adminHasOwn(patch, "plan")) normalized.plan = normalizePlanCode(patch.plan);
  if (adminHasOwn(patch, "quotaUsed")) {
    const value = normalizeAdminNonNegativeInt(patch.quotaUsed);
    if (value === null) rejectedFields.push(adminReject("quotaUsed", "INVALID_COUNTER", "quotaUsed deve ser inteiro maior ou igual a zero.", patch.quotaUsed));
    else normalized.quotaUsed = value;
  }
  if (adminHasOwn(patch, "trialUsed")) {
    const value = normalizeAdminNonNegativeInt(patch.trialUsed);
    if (value === null) rejectedFields.push(adminReject("trialUsed", "INVALID_COUNTER", "trialUsed deve ser inteiro maior ou igual a zero.", patch.trialUsed));
    else normalized.trialUsed = value;
  }
  if (adminHasOwn(patch, "templateMode")) {
    const value = normalizeAdminTemplateMode(patch.templateMode);
    if (value === null) rejectedFields.push(adminReject("templateMode", "INVALID_TEMPLATE_MODE", "templateMode deve ser FIXED ou FREE.", patch.templateMode));
    else normalized.templateMode = value;
  }
  if (adminHasOwn(patch, "paymentMethod")) {
    const value = normalizeAdminPaymentMethod(patch.paymentMethod);
    if (value === null) rejectedFields.push(adminReject("paymentMethod", "INVALID_PAYMENT_METHOD", "paymentMethod deve ser PIX, CARD ou vazio.", patch.paymentMethod));
    else normalized.paymentMethod = value;
  }
  if (adminHasOwn(patch, "billingCityState")) normalized.billingCityState = normalizeCityState(patch.billingCityState);
  if (adminHasOwn(patch, "billingAddress")) {
    const raw = compactInnerWhitespace(patch.billingAddress);
    normalized.billingAddress = /^apenas\s+online$/i.test(raw) ? "APENAS ONLINE" : normalizeAddressText(raw);
  }

  const docPatch = isPlainObject(patch.doc) ? patch.doc : {};
  if (adminHasOwn(patch, "doc") && !isPlainObject(patch.doc) && patch.doc !== null) {
    rejectedFields.push(adminReject("doc", "INVALID_DOC_OBJECT", "doc deve conter apenas docType/docLast4."));
  }
  for (const key of Object.keys(docPatch)) {
    if (key !== "docType" && key !== "docLast4") rejectedFields.push(adminReject(`doc.${key}`, "UNKNOWN_DOC_FIELD", "Documento completo não pode ser salvo; use apenas docType/docLast4."));
  }
  if (adminHasOwn(patch, "docType") || adminHasOwn(docPatch, "docType")) {
    const raw = adminHasOwn(patch, "docType") ? patch.docType : docPatch.docType;
    const value = normalizeAdminDocType(raw);
    if (value === null) rejectedFields.push(adminReject("docType", "INVALID_DOC_TYPE", "docType deve ser CPF, CNPJ ou vazio.", raw));
    else normalized.docType = value;
  }
  if (adminHasOwn(patch, "docLast4") || adminHasOwn(docPatch, "docLast4")) {
    const raw = adminHasOwn(patch, "docLast4") ? patch.docLast4 : docPatch.docLast4;
    const value = normalizeAdminDocLast4(raw);
    if (value === null) rejectedFields.push(adminReject("docLast4", "INVALID_DOC_LAST4", "docLast4 deve conter exatamente 4 dígitos ou vazio.", raw));
    else normalized.docLast4 = value;
  }

  if (adminHasOwn(patch, "asaasCustomerId")) normalized.asaasCustomerId = safeStr(patch.asaasCustomerId);
  if (adminHasOwn(patch, "asaasSubscriptionId")) normalized.asaasSubscriptionId = safeStr(patch.asaasSubscriptionId);
  if (adminHasOwn(patch, "cardValidUntil")) {
    const value = normalizeAdminIsoDate(patch.cardValidUntil);
    if (value === null) rejectedFields.push(adminReject("cardValidUntil", "INVALID_DATE", "cardValidUntil deve ser uma data ISO válida ou vazio.", patch.cardValidUntil));
    else normalized.cardValidUntil = value;
  }
  if (adminHasOwn(patch, "cardCanceledAt")) {
    const value = normalizeAdminIsoTimestamp(patch.cardCanceledAt);
    if (value === null) rejectedFields.push(adminReject("cardCanceledAt", "INVALID_TIMESTAMP", "cardCanceledAt deve ser timestamp ISO válido ou vazio.", patch.cardCanceledAt));
    else normalized.cardCanceledAt = value;
  }

  for (const field of ["bizProfile", "pendingBizProfile", "activityMeta", "growthMeta", "pricingQuote", "checkoutDraft", "currentAdSession"]) {
    if (!adminHasOwn(patch, field)) continue;
    const parsed = parseAdminEditableObject(patch[field], field, rejectedFields);
    if (parsed.provided) normalized[field] = parsed.value;
  }
  if (adminHasOwn(patch, "selectedPlanCode")) normalized.selectedPlanCode = normalizePlanCode(patch.selectedPlanCode);
  if (adminHasOwn(patch, "selectedBillingCycle")) {
    const raw = safeStr(normalizeMaybeJsonString(patch.selectedBillingCycle));
    const value = normalizeBillingCycle(raw);
    if (raw && !value) rejectedFields.push(adminReject("selectedBillingCycle", "INVALID_BILLING_CYCLE", "selectedBillingCycle deve ser monthly, annual ou vazio.", patch.selectedBillingCycle));
    else normalized.selectedBillingCycle = value;
  }
  if (adminHasOwn(patch, "selectedCouponCode")) normalized.selectedCouponCode = normalizeCouponCode(patch.selectedCouponCode);
  if (adminHasOwn(patch, "couponReservationId")) normalized.couponReservationId = safeStr(patch.couponReservationId);
  if (adminHasOwn(patch, "couponReservationCreatedAt")) {
    const value = normalizeAdminIsoTimestamp(patch.couponReservationCreatedAt);
    if (value === null) rejectedFields.push(adminReject("couponReservationCreatedAt", "INVALID_TIMESTAMP", "couponReservationCreatedAt deve ser timestamp ISO válido ou vazio.", patch.couponReservationCreatedAt));
    else normalized.couponReservationCreatedAt = value;
  }
  if (adminHasOwn(patch, "checkoutCouponStatus")) normalized.checkoutCouponStatus = normalizeCheckoutCouponStatus(patch.checkoutCouponStatus);

  return { normalized, rejectedFields };
}

function buildAdminEditableFieldsFromSnapshot(snapshot) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  return {
    userId: safeStr(snap.userId || snap.waId),
    waId: safeStr(snap.waId || snap.userId),
    fullName: safeStr(snap.fullName),
    status: safeStr(snap.status).toUpperCase() || "TRIAL",
    plan: normalizePlanCode(snap.plan),
    quotaUsed: Math.max(0, toInt(snap.quotaUsed, 0)),
    trialUsed: Math.max(0, toInt(snap.trialUsed, 0)),
    templateMode: safeStr(snap.templateMode).toUpperCase() === "FREE" ? "FREE" : "FIXED",
    paymentMethod: normalizeAdminPaymentMethod(snap.paymentMethod) || "",
    billingCityState: safeStr(snap.billingCityState),
    billingAddress: safeStr(snap.billingAddress),
    docType: safeStr(snap.doc?.docType).toUpperCase(),
    docLast4: safeStr(snap.doc?.docLast4),
    asaasCustomerId: safeStr(snap.asaasCustomerId),
    asaasSubscriptionId: safeStr(snap.asaasSubscriptionId),
    cardValidUntil: normalizeIsoDate(snap.cardValidUntil),
    cardCanceledAt: normalizeIsoTimestamp(snap.cardCanceledAt),
    bizProfile: isPlainObject(snap.bizProfile) ? snap.bizProfile : null,
    pendingBizProfile: isPlainObject(snap.pendingBizProfile) ? snap.pendingBizProfile : null,
    activityMeta: isPlainObject(snap.activityMeta) ? snap.activityMeta : {},
    growthMeta: isPlainObject(snap.growthMeta) ? snap.growthMeta : {},
    selectedPlanCode: normalizePlanCode(snap.selectedPlanCode),
    selectedBillingCycle: normalizeBillingCycle(snap.selectedBillingCycle),
    selectedCouponCode: normalizeCouponCode(snap.selectedCouponCode),
    pricingQuote: normalizePricingQuote(snap.pricingQuote),
    couponReservationId: safeStr(snap.couponReservationId),
    couponReservationCreatedAt: normalizeIsoTimestamp(snap.couponReservationCreatedAt),
    checkoutCouponStatus: normalizeCheckoutCouponStatus(snap.checkoutCouponStatus),
    checkoutDraft: normalizeCheckoutDraft(snap.checkoutDraft),
    currentAdSession: isPlainObject(snap.currentAdSession) ? snap.currentAdSession : null,
  };
}

async function applyAdminFieldUpdate(userId, field, value) {
  switch (field) {
    case "fullName": return setUserFullName(userId, value);
    case "status": return setUserStatus(userId, value);
    case "plan": return setUserPlan(userId, value);
    case "quotaUsed": return setUserQuotaUsed(userId, value);
    case "trialUsed": return setUserTrialUsed(userId, value);
    case "templateMode": return setTemplateMode(userId, value || "FIXED");
    case "paymentMethod": return value ? setPaymentMethod(userId, value) : clearPaymentMethod(userId);
    case "billingCityState": return value ? setBillingCityState(userId, value) : clearBillingCityState(userId);
    case "billingAddress": return value ? setBillingAddress(userId, value) : clearBillingAddress(userId);
    case "asaasCustomerId": return setAsaasCustomerId(userId, value);
    case "asaasSubscriptionId": return setAsaasSubscriptionId(userId, value);
    case "cardValidUntil": return setCardValidUntil(userId, value);
    case "cardCanceledAt": return setCardCanceledAt(userId, value);
    case "bizProfile": return value ? setBizProfile(userId, value) : clearBizProfile(userId);
    case "pendingBizProfile": return value ? setPendingBizProfile(userId, value) : clearPendingBizProfile(userId);
    case "activityMeta": return setActivityMeta(userId, value || {});
    case "growthMeta": return setGrowthMeta(userId, value || {});
    case "selectedPlanCode": return value ? setSelectedPlanCode(userId, value) : clearSelectedPlanCode(userId);
    case "selectedBillingCycle": return value ? setSelectedBillingCycle(userId, value) : clearSelectedBillingCycle(userId);
    case "selectedCouponCode": return value ? setSelectedCouponCode(userId, value) : clearSelectedCouponCode(userId);
    case "pricingQuote": return value ? setPricingQuote(userId, value) : clearPricingQuote(userId);
    case "couponReservationId": return value ? setCouponReservationId(userId, value) : clearCouponReservationId(userId);
    case "couponReservationCreatedAt": return value ? setCouponReservationCreatedAt(userId, value) : clearCouponReservationCreatedAt(userId);
    case "checkoutCouponStatus": return value ? setCheckoutCouponStatus(userId, value) : clearCheckoutCouponStatus(userId);
    case "checkoutDraft": return value ? setCheckoutDraft(userId, value) : clearCheckoutDraft(userId);
    case "currentAdSession": return value ? setCurrentAdSession(userId, value) : clearCurrentAdSession(userId);
    default: return undefined;
  }
}

export async function getUserAdminEditableFields(userRef) {
  const userId = normalizeUserRef(userRef);
  if (!userId) throw new Error("userRef required");
  const snapshot = await getUserSnapshot(userId);
  return buildAdminEditableFieldsFromSnapshot(snapshot);
}

export async function updateUserAdminFields(userRef, patch = {}, options = {}) {
  const userId = normalizeUserRef(userRef);
  if (!userId) throw new Error("userRef required");
  const { normalized, rejectedFields } = normalizeAdminEditablePatch(patch);
  const beforeSnapshot = await getUserSnapshot(userId);
  const before = buildAdminEditableFieldsFromSnapshot(beforeSnapshot);
  const fieldsToApply = [];

  if (adminHasOwn(normalized, "docType") || adminHasOwn(normalized, "docLast4")) {
    const docType = adminHasOwn(normalized, "docType") ? normalized.docType : before.docType;
    const docLast4 = adminHasOwn(normalized, "docLast4") ? normalized.docLast4 : before.docLast4;
    if ((docType && !docLast4) || (!docType && docLast4)) {
      rejectedFields.push(adminReject("doc", "INCOMPLETE_DOC_MASK", "Documento mascarado exige docType e docLast4 juntos, ou ambos vazios."));
    } else if (!adminValuesEqual({ docType: before.docType, docLast4: before.docLast4 }, { docType, docLast4 })) {
      fieldsToApply.push({ field: "doc", value: { docType, docLast4 } });
    }
  }

  for (const field of ADMIN_EDITABLE_FIELD_KEYS) {
    if (field === "docType" || field === "docLast4") continue;
    if (!adminHasOwn(normalized, field)) continue;
    const nextValue = normalized[field];
    if (!adminValuesEqual(before[field], nextValue)) fieldsToApply.push({ field, value: nextValue });
  }

  const changedFields = [];
  const failedFields = [];
  for (const item of fieldsToApply) {
    try {
      if (item.field === "doc") {
        await setUserDocMasked(userId, item.value.docType, item.value.docLast4);
        changedFields.push("doc");
        continue;
      }
      await applyAdminFieldUpdate(userId, item.field, item.value);
      changedFields.push(item.field);
    } catch (error) {
      failedFields.push(adminReject(item.field, "WRITE_FAILED", safeStr(error?.message || error) || "Falha ao gravar campo."));
      await logStateOperationalError({
        userId,
        key: item.field,
        step: "update_user_admin_fields",
        errorCode: STATE_ERROR_CODE.WRITE,
        error,
        event: "admin_user_field_update_failed",
      });
    }
  }

  const afterSnapshot = await getUserSnapshot(userId);
  const after = buildAdminEditableFieldsFromSnapshot(afterSnapshot);
  return {
    ok: failedFields.length === 0,
    userId,
    changedFields,
    rejectedFields: [...rejectedFields, ...failedFields],
    before,
    after,
    ...(options && options.includeSnapshot ? { snapshot: afterSnapshot } : {}),
  };
}

// ===================== SNAPSHOT =====================
export async function getUserSnapshot(waId) {
  await ensureUserExists(waId);

  const [
    status,
    plan,
    quotaUsed,
    trialUsed,
    lastPrompt,
    lastAd,
    refineCount,
    templateMode,
    fullName,
    docMasked,
    paymentMethod,
    billingCityState,
    billingAddress,
    bizProfile,
    pendingBizProfile,
    currentAdSession,
    checkoutDraft,
    selectedPlanCode,
    selectedBillingCycle,
    selectedCouponCode,
    pricingQuote,
    couponReservationId,
    couponReservationCreatedAt,
    checkoutCouponStatus,
    activityMeta,
    growthMeta,
    asaasCustomerId,
    asaasSubscriptionId,
    cardValidUntil,
    cardCanceledAt,
  ] = await Promise.all([
    getUserStatus(waId),
    getUserPlan(waId),
    getUserQuotaUsed(waId),
    getUserTrialUsed(waId),
    getLastPrompt(waId),
    getLastAd(waId),
    getRefineCount(waId),
    getTemplateMode(waId),
    getUserFullName(waId),
    getUserDocMasked(waId),
    getPaymentMethod(waId),
    getBillingCityState(waId),
    getBillingAddress(waId),
    getBizProfile(waId),
    getPendingBizProfile(waId),
    getCurrentAdSession(waId),
    getCheckoutDraft(waId),
    getSelectedPlanCode(waId),
    getSelectedBillingCycle(waId),
    getSelectedCouponCode(waId),
    getPricingQuote(waId),
    getCouponReservationId(waId),
    getCouponReservationCreatedAt(waId),
    getCheckoutCouponStatus(waId),
    getActivityMeta(waId),
    getGrowthMeta(waId),
    getAsaasCustomerId(waId),
    getAsaasSubscriptionId(waId),
    getCardValidUntil(waId),
    getCardCanceledAt(waId),
  ]);

  return {
    userId: waId,
    waId,
    status,
    plan,
    quotaUsed,
    trialUsed,
    lastPrompt,
    lastAd: lastAd || "",
    refineCount,
    templateMode,
    fullName: fullName || "",
    doc: docMasked, // {docType, docLast4}
    paymentMethod: paymentMethod || "",
    billingCityState: billingCityState || "",
    billingAddress: billingAddress || "",
    bizProfile: bizProfile || null,
    pendingBizProfile: pendingBizProfile || null,
    currentAdSession: currentAdSession || null,
    checkoutDraft: checkoutDraft || null,
    selectedPlanCode: selectedPlanCode || "",
    selectedBillingCycle: selectedBillingCycle || "",
    selectedCouponCode: selectedCouponCode || "",
    pricingQuote: pricingQuote || null,
    couponReservationId: couponReservationId || "",
    couponReservationCreatedAt: couponReservationCreatedAt || "",
    checkoutCouponStatus: checkoutCouponStatus || "",
    activityMeta: activityMeta || {},
    growthMeta: growthMeta || {},
    asaasCustomerId: asaasCustomerId || "",
    asaasSubscriptionId: asaasSubscriptionId || "",
    cardValidUntil: cardValidUntil || "",
    cardCanceledAt: cardCanceledAt || "",
  };
}
