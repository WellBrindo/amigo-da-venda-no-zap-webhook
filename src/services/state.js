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
} from "./redis.js";

/**
 * ✅ Estado do usuário (Redis)
 *
 * Regras importantes:
 * - NUNCA armazenar CPF/CNPJ completo (LGPD + segurança).
 * - Só guardamos: docType ("CPF"|"CNPJ") e docLast4 (últimos 4 dígitos).
 * - Snapshot do admin NUNCA deve expor documento completo.
 *
 * Chaves:
 * - user:{waId}:status           => TRIAL | ACTIVE | PAYMENT_PENDING | BLOCKED
 * - user:{waId}:plan             => plano (ex: DE_VEZ_EM_QUANDO)
 * - user:{waId}:quotaUsed        => uso no mês (ACTIVE)
 * - user:{waId}:trialUsed        => uso no trial (TRIAL)
 * - user:{waId}:lastPrompt       => última descrição enviada (para "alterações")
 * - user:{waId}:templateMode     => FIXED | FREE
 * - user:{waId}:fullName         => nome completo
 * - user:{waId}:docType          => CPF | CNPJ
 * - user:{waId}:docLast4         => últimos 4 dígitos
 * - user:{waId}:paymentMethod    => CARD | PIX
 * - user:{waId}:asaasCustomerId  => id do cliente no Asaas (cus_...)
 * - user:{waId}:asaasSubscriptionId => id assinatura (quando existir)
 *
 * Índice:
 * - users:index (SET) => lista de waIds para o admin
 */

// ===================== Helpers =====================
const USERS_INDEX_KEY = "users:index";

const keyStatus = (waId) => `user:${waId}:status`;
const keyPlan = (waId) => `user:${waId}:plan`;
const keyQuotaUsed = (waId) => `user:${waId}:quotaUsed`;
const keyTrialUsed = (waId) => `user:${waId}:trialUsed`;
const keyLastPrompt = (waId) => `user:${waId}:lastPrompt`;
const keyTemplateMode = (waId) => `user:${waId}:templateMode`;
// ✅ controle: pergunta de template (FIXO/LIVRE) só na 1ª descrição
const keyTemplatePrompted = (waId) => `user:${waId}:templatePrompted`;

const keyFullName = (waId) => `user:${waId}:fullName`;

// ✅ doc (MASCARADO)
const keyDocType = (waId) => `user:${waId}:docType`;
const keyDocLast4 = (waId) => `user:${waId}:docLast4`;

// ⚠️ legado (não usar mais, mas migrar se existir)
const keyDocLegacy = (waId) => `user:${waId}:docDigits`;

const keyPaymentMethod = (waId) => `user:${waId}:paymentMethod`;

// ✅ Dados fiscais para emissão (sem CPF completo)
const keyBillingCityState = (waId) => `user:${waId}:billingCityState`;
const keyBillingAddress = (waId) => `user:${waId}:billingAddress`;

const keyAsaasCustomerId = (waId) => `user:${waId}:asaasCustomerId`;
const keyAsaasSubscriptionId = (waId) => `user:${waId}:asaasSubscriptionId`;


// ===================== MENU (bot) =====================
const keyMenuPrevStatus = (waId) => `user:${waId}:menuPrevStatus`;

// ===================== CARD (assinatura) =====================
// Data (YYYY-MM-DD) até quando o usuário mantém acesso após cancelar recorrência.
const keyCardValidUntil = (waId) => `user:${waId}:cardValidUntil`;
// Timestamp ISO de quando o usuário cancelou (auditoria leve).
const keyCardCanceledAt = (waId) => `user:${waId}:cardCanceledAt`;
// ===================== BIZ PROFILE (auto preenchimento) =====================
// Perfil salvo de dados da empresa (nome/atendimento/local/horário/whatsapp etc)
const keyBizProfile = (waId) => `user:${waId}:bizProfile`;
// Perfil pendente (sugestão detectada) aguardando confirmação do usuário
const keyPendingBizProfile = (waId) => `user:${waId}:pendingBizProfile`;
// Status anterior (para estados transitórios como escolha de template / salvar perfil)
const keyPrevStatus = (waId) => `user:${waId}:prevStatus`;


function safeStr(v) {
  return String(v ?? "").trim();
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

function maskDocFromParts(docType, docLast4) {
  const t = safeStr(docType).toUpperCase();
  const l4 = safeStr(docLast4);
  if (!t || !l4) return { docType: "", docLast4: "" };
  return { docType: t, docLast4: l4 };
}

// ✅ AGORA É EXPORTADA (para window24h.js importar corretamente)
// ✅ V16.4.1: migração segura do índice users:index quando legado estiver como STRING (ou outro tipo)
export async function indexUser(waId) {
  const id = safeStr(waId);
  if (!id) return false;

  // Detecta tipo do índice antes de usar SADD (evita WRONGTYPE)
  let t = "";
  try {
    t = safeStr(await redisType(USERS_INDEX_KEY)).toLowerCase();
  } catch (err) {
    // Se TYPE falhar por qualquer razão, não arriscar deletar nada.
    console.warn(
      JSON.stringify({
        level: "warn",
        tag: "users_index_type_check_failed",
        key: USERS_INDEX_KEY,
        waId: id,
        error: safeStr(err?.message || err),
      })
    );
    // Ainda tenta adicionar (pode falhar se for wrongtype, mas ao menos logamos o motivo)
    await redisSAdd(USERS_INDEX_KEY, id);
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
        waId: id,
      })
    );
    await redisDel(USERS_INDEX_KEY);
  }

  await redisSAdd(USERS_INDEX_KEY, id);
  return true;
}

// ===================== Ensure =====================
export async function ensureUserExists(waId) {
  const id = safeStr(waId);
  if (!id) throw new Error("waId required");

  await indexUser(id);

  // status default
  const curStatus = await redisGet(keyStatus(id));
  if (!curStatus) await redisSet(keyStatus(id), "TRIAL");

  // template default
  const curT = await redisGet(keyTemplateMode(id));
  if (!curT) await redisSet(keyTemplateMode(id), "FIXED");

  // template prompt default
  const curTP = await redisGet(keyTemplatePrompted(id));
  if (!curTP) await redisSet(keyTemplatePrompted(id), "0");

  // counters default
  const curTrial = await redisGet(keyTrialUsed(id));
  if (!curTrial) await redisSet(keyTrialUsed(id), "0");

  const curQuota = await redisGet(keyQuotaUsed(id));
  if (!curQuota) await redisSet(keyQuotaUsed(id), "0");

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
  const ids = await redisSMembers(USERS_INDEX_KEY);
  return Array.isArray(ids) ? ids : [];
}

// ===================== Status / Plan =====================
export async function getUserStatus(waId) {
  const v = await redisGet(keyStatus(waId));
  return safeStr(v) || "TRIAL";
}

export async function setUserStatus(waId, status) {
  await indexUser(waId);
  const s = safeStr(status).toUpperCase();
  await redisSet(keyStatus(waId), s);
  return s;
}

export async function getUserPlan(waId) {
  const v = await redisGet(keyPlan(waId));
  const normalized = normalizeMaybeJsonString(v);
  // Se estiver vazio ou sujo, tratamos como sem plano
  const p = safeStr(normalized).toUpperCase();
  return p === '""' ? "" : p;
}

export async function setUserPlan(waId, planCode) {
  await indexUser(waId);

  const normalized = normalizeMaybeJsonString(planCode);
  const p = safeStr(normalized).toUpperCase();

  // ✅ V16.4.2: Sem plano => DEL (não SET "")
  if (!p || p === '""') {
    await redisDel(keyPlan(waId));
    return "";
  }

  await redisSet(keyPlan(waId), p);
  return p;
}

// ===================== Counters =====================
export async function getUserQuotaUsed(waId) {
  const v = await redisGet(keyQuotaUsed(waId));
  return toInt(v, 0);
}

export async function incUserQuotaUsed(waId, by = 1) {
  await indexUser(waId);
  const inc = toInt(by, 1);
  const v = await redisIncrBy(keyQuotaUsed(waId), inc);
  return toInt(v, 0);
}

export async function resetUserQuotaUsed(waId) {
  await indexUser(waId);
  await redisSet(keyQuotaUsed(waId), "0");
  return 0;
}

export async function setUserQuotaUsed(waId, value) {
  await indexUser(waId);
  const v = Math.max(0, Number(value) || 0);
  await redisSet(keyQuotaUsed(waId), String(Math.trunc(v)));
  return Math.trunc(v);
}

export async function setUserTrialUsed(waId, value) {
  await indexUser(waId);
  const v = Math.max(0, Number(value) || 0);
  await redisSet(keyTrialUsed(waId), String(Math.trunc(v)));
  return Math.trunc(v);
}

export async function getUserTrialUsed(waId) {
  const v = await redisGet(keyTrialUsed(waId));
  return toInt(v, 0);
}

export async function incUserTrialUsed(waId, by = 1) {
  await indexUser(waId);
  const inc = toInt(by, 1);
  const v = await redisIncrBy(keyTrialUsed(waId), inc);
  return toInt(v, 0);
}

export async function resetUserTrialUsed(waId) {
  await indexUser(waId);
  await redisSet(keyTrialUsed(waId), "0");
  return 0;
}

// ===================== Last Prompt =====================
export async function getLastPrompt(waId) {
  const v = await redisGet(keyLastPrompt(waId));
  return safeStr(v);
}

export async function setLastPrompt(waId, prompt) {
  await indexUser(waId);
  const p = safeStr(prompt);

  // ✅ V16.4.3: Nunca SET vazio (Upstash REST pode interpretar como SET sem value)
  // Vazio => remove a chave
  if (!p) {
    await redisDel(keyLastPrompt(waId));
    return "";
  }

  await redisSet(keyLastPrompt(waId), p);
  return p;
}

export async function clearLastPrompt(waId) {
  await indexUser(waId);
  await redisDel(keyLastPrompt(waId));
  return true;
}


// ===================== Last Ad (for refinements) =====================
function keyLastAd(waId) {
  return `user:${waId}:lastAd`;
}

export async function getLastAd(waId) {
  const v = await redisGet(keyLastAd(waId));
  return safeStr(v);
}

export async function setLastAd(waId, adText) {
  await indexUser(waId);
  const t = safeStr(adText);

  // Nunca SET vazio (Upstash REST pode interpretar como SET sem value)
  if (!t) {
    await redisDel(keyLastAd(waId));
    return "";
  }

  await redisSet(keyLastAd(waId), t);
  return t;
}

export async function clearLastAd(waId) {
  await indexUser(waId);
  await redisDel(keyLastAd(waId));
  return true;
}

// ===================== Refinement Count =====================
function keyRefineCount(waId) {
  return `user:${waId}:refineCount`;
}

export async function getRefineCount(waId) {
  const v = await redisGet(keyRefineCount(waId));
  return toInt(v, 0);
}

export async function setRefineCount(waId, n) {
  await indexUser(waId);
  const v = toInt(n, 0);
  await redisSet(keyRefineCount(waId), String(v));
  return v;
}

export async function incRefineCount(waId, by = 1) {
  await indexUser(waId);
  const inc = toInt(by, 1);
  const v = await redisIncrBy(keyRefineCount(waId), inc);
  return toInt(v, 0);
}

export async function clearRefineCount(waId) {
  await indexUser(waId);
  await redisDel(keyRefineCount(waId));
  return true;
}

// ===================== Template Mode =====================
export async function getTemplateMode(waId) {
  const v = await redisGet(keyTemplateMode(waId));
  const t = safeStr(v).toUpperCase();
  return t === "FREE" ? "FREE" : "FIXED";
}

export async function setTemplateMode(waId, mode) {
  await indexUser(waId);
  const m = safeStr(mode).toUpperCase();
  const v = m === "FREE" ? "FREE" : "FIXED";
  await redisSet(keyTemplateMode(waId), v);
  return v;
}

// ===================== Template Prompted (only first time) =====================
export async function getTemplatePrompted(waId) {
  const v = await redisGet(keyTemplatePrompted(waId));
  const n = toInt(v, 0);
  return n > 0;
}

export async function setTemplatePrompted(waId, value) {
  await indexUser(waId);
  const v = value ? 1 : 0;
  await redisSet(keyTemplatePrompted(waId), String(v));
  return !!v;
}

export async function resetTemplatePrompted(waId) {
  await indexUser(waId);
  await redisSet(keyTemplatePrompted(waId), "0");
  return false;
}

// ===================== Full Name =====================
export async function getUserFullName(waId) {
  const v = await redisGet(keyFullName(waId));
  return safeStr(v);
}

export async function setUserFullName(waId, fullName) {
  await indexUser(waId);
  const n = safeStr(fullName);
  await redisSet(keyFullName(waId), n);
  return n;
}

// ===================== Doc (masked only) =====================
export async function getUserDocMasked(waId) {
  await migrateLegacyDocIfNeeded(waId);

  const [t, l4] = await Promise.all([
    redisGet(keyDocType(waId)),
    redisGet(keyDocLast4(waId)),
  ]);

  return maskDocFromParts(t, l4);
}

export async function setUserDocMasked(waId, docType, docLast4) {
  await indexUser(waId);
  const t = safeStr(docType).toUpperCase();
  const l4 = safeStr(docLast4);

  if (!t || !l4) {
    await Promise.all([redisDel(keyDocType(waId)), redisDel(keyDocLast4(waId))]);
    return { docType: "", docLast4: "" };
  }

  await Promise.all([redisSet(keyDocType(waId), t), redisSet(keyDocLast4(waId), l4)]);
  // garantir que legado está removido
  await redisDel(keyDocLegacy(waId));
  return { docType: t, docLast4: l4 };
}

export async function clearUserDoc(waId) {
  await indexUser(waId);
  await Promise.all([
    redisDel(keyDocType(waId)),
    redisDel(keyDocLast4(waId)),
    redisDel(keyDocLegacy(waId)),
  ]);
  return true;
}

// Migração: se existir docDigits (legado), migrar para docType/docLast4 e apagar
async function migrateLegacyDocIfNeeded(waId) {
  const legacy = await redisGet(keyDocLegacy(waId));
  const digits = safeStr(legacy).replace(/\D/g, "");
  if (!digits) return false;

  const docType = digits.length === 14 ? "CNPJ" : "CPF";
  const docLast4 = digits.slice(-4);

  await Promise.all([
    redisSet(keyDocType(waId), docType),
    redisSet(keyDocLast4(waId), docLast4),
    redisDel(keyDocLegacy(waId)),
  ]);

  return true;
}

// ===================== Payment Method =====================
export async function getPaymentMethod(waId) {
  const v = await redisGet(keyPaymentMethod(waId));
  const normalized = normalizeMaybeJsonString(v);
  const m = safeStr(normalized).toUpperCase();
  return m === "PIX" ? "PIX" : m === "CARD" ? "CARD" : "";
}

export async function setPaymentMethod(waId, method) {
  await indexUser(waId);

  const normalized = normalizeMaybeJsonString(method);
  const m = safeStr(normalized).toUpperCase();
  const v = m === "PIX" ? "PIX" : m === "CARD" ? "CARD" : "";

  // ✅ V16.4.2: Sem método => DEL (não SET "")
  if (!v) {
    await redisDel(keyPaymentMethod(waId));
    return "";
  }

  await redisSet(keyPaymentMethod(waId), v);
  return v;
}

export async function clearPaymentMethod(waId) {
  await indexUser(waId);
  await redisDel(keyPaymentMethod(waId));
  return true;
}


// ===================== Dados fiscais (emissão de cobrança) =====================
export async function getBillingCityState(waId) {
  return safeStr(await redisGet(keyBillingCityState(waId)));
}

export async function setBillingCityState(waId, value) {
  await indexUser(waId);
  const v = safeStr(value);
  if (!v) {
    await redisDel(keyBillingCityState(waId));
    return "";
  }
  await redisSet(keyBillingCityState(waId), v);
  return v;
}

export async function clearBillingCityState(waId) {
  await indexUser(waId);
  await redisDel(keyBillingCityState(waId));
  return true;
}

export async function getBillingAddress(waId) {
  return safeStr(await redisGet(keyBillingAddress(waId)));
}

export async function setBillingAddress(waId, value) {
  await indexUser(waId);
  const v = safeStr(value);
  if (!v) {
    await redisDel(keyBillingAddress(waId));
    return "";
  }
  await redisSet(keyBillingAddress(waId), v);
  return v;
}

export async function clearBillingAddress(waId) {
  await indexUser(waId);
  await redisDel(keyBillingAddress(waId));
  return true;
}

// ===================== Asaas IDs =====================
export async function setAsaasCustomerId(waId, customerId) {
  await indexUser(waId);
  const id = safeStr(customerId);
  if (!id) {
    await redisDel(keyAsaasCustomerId(waId));
    return "";
  }
  await redisSet(keyAsaasCustomerId(waId), id);
  return id;
}

export async function getAsaasCustomerId(waId) {
  const v = await redisGet(keyAsaasCustomerId(waId));
  return safeStr(v);
}

export async function setAsaasSubscriptionId(waId, subId) {
  await indexUser(waId);
  const id = safeStr(subId);
  if (!id) {
    await redisDel(keyAsaasSubscriptionId(waId));
    return "";
  }
  await redisSet(keyAsaasSubscriptionId(waId), id);
  return id;
}

export async function getAsaasSubscriptionId(waId) {
  const v = await redisGet(keyAsaasSubscriptionId(waId));
  return safeStr(v);
}


// ===================== Menu Prev Status =====================
export async function setMenuPrevStatus(waId, prevStatus) {
  await indexUser(waId);
  const s = safeStr(prevStatus).toUpperCase();
  if (!s) {
    await redisDel(keyMenuPrevStatus(waId));
    return "";
  }
  await redisSet(keyMenuPrevStatus(waId), s);
  return s;
}

export async function getMenuPrevStatus(waId) {
  const v = await redisGet(keyMenuPrevStatus(waId));
  return safeStr(v).toUpperCase();
}

export async function clearMenuPrevStatus(waId) {
  await indexUser(waId);
  await redisDel(keyMenuPrevStatus(waId));
  return true;
}


// ===================== Prev Status (transitórios) =====================
export async function setPrevStatus(waId, prevStatus) {
  await indexUser(waId);
  const s = safeStr(prevStatus).toUpperCase();
  if (!s) {
    await redisDel(keyPrevStatus(waId));
    return "";
  }
  await redisSet(keyPrevStatus(waId), s);
  return s;
}

export async function getPrevStatus(waId) {
  const v = await redisGet(keyPrevStatus(waId));
  return safeStr(v).toUpperCase();
}

export async function clearPrevStatus(waId) {
  await indexUser(waId);
  await redisDel(keyPrevStatus(waId));
  return true;
}

// ===================== Biz Profile (salvo) =====================
export async function getBizProfile(waId) {
  const raw = await redisGet(keyBizProfile(waId));
  const obj = safeJsonParse(raw);
  return obj && typeof obj === "object" ? obj : null;
}

export async function setBizProfile(waId, profileObj) {
  await indexUser(waId);
  const s = safeJsonStringify(profileObj);
  await redisSet(keyBizProfile(waId), s);
  return true;
}

export async function clearBizProfile(waId) {
  await indexUser(waId);
  await redisDel(keyBizProfile(waId));
  return true;
}

// ===================== Biz Profile (pendente) =====================
export async function getPendingBizProfile(waId) {
  const raw = await redisGet(keyPendingBizProfile(waId));
  const obj = safeJsonParse(raw);
  return obj && typeof obj === "object" ? obj : null;
}

export async function setPendingBizProfile(waId, profileObj) {
  await indexUser(waId);
  const s = safeJsonStringify(profileObj);
  await redisSet(keyPendingBizProfile(waId), s);
  return true;
}

export async function clearPendingBizProfile(waId) {
  await indexUser(waId);
  await redisDel(keyPendingBizProfile(waId));
  return true;
}

// ===================== Card Validity / Cancel =====================
export async function setCardValidUntil(waId, isoDate) {
  await indexUser(waId);
  const d = safeStr(isoDate);
  if (!d) {
    await redisDel(keyCardValidUntil(waId));
    return "";
  }
  // formato esperado: YYYY-MM-DD (não validar pesado aqui)
  await redisSet(keyCardValidUntil(waId), d);
  return d;
}

export async function getCardValidUntil(waId) {
  const v = await redisGet(keyCardValidUntil(waId));
  return safeStr(v);
}

export async function setCardCanceledAt(waId, isoTs) {
  await indexUser(waId);
  const ts = safeStr(isoTs);
  if (!ts) {
    await redisDel(keyCardCanceledAt(waId));
    return "";
  }
  await redisSet(keyCardCanceledAt(waId), ts);
  return ts;
}

export async function getCardCanceledAt(waId) {
  const v = await redisGet(keyCardCanceledAt(waId));
  return safeStr(v);
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
    clearPrevStatus(waId),
    clearBizProfile(waId),
    clearPendingBizProfile(waId),
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
  if (!id) throw new Error("waId required");

  const keys = [
    keyStatus(id),
    keyPlan(id),
    keyQuotaUsed(id),
    keyTrialUsed(id),
    keyLastPrompt(id),
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
    keyCardValidUntil(id),
    keyCardCanceledAt(id),
    keyPrevStatus(id),
    keyBizProfile(id),
    keyPendingBizProfile(id),
  ];

  // best-effort: apaga todas as chaves conhecidas
  await Promise.allSettled(keys.map((k) => redisDel(k)));

  // ✅ Garante defaults mínimos IMEDIATAMENTE (evita "Sem plano" após reset)
  await indexUser(id);
  await redisSet(keyStatus(id), "TRIAL");
  await redisSet(keyTemplateMode(id), "FIXED");
  await redisSet(keyTemplatePrompted(id), "0");
  await redisSet(keyTrialUsed(id), "0");
  await redisSet(keyQuotaUsed(id), "0");

  return { ok: true, waId: id, deletedKeys: keys.length };
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
    templateMode,
    fullName,
    docMasked,
    paymentMethod,
    billingCityState,
    billingAddress,
    bizProfile,
    pendingBizProfile,
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
    getTemplateMode(waId),
    getUserFullName(waId),
    getUserDocMasked(waId),
    getPaymentMethod(waId),
    getBillingCityState(waId),
    getBillingAddress(waId),
    getBizProfile(waId),
    getPendingBizProfile(waId),
    getAsaasCustomerId(waId),
    getAsaasSubscriptionId(waId),
    getCardValidUntil(waId),
    getCardCanceledAt(waId),
  ]);

  return {
    waId,
    status,
    plan,
    quotaUsed,
    trialUsed,
    lastPrompt,
    templateMode,
    fullName: fullName || "",
    doc: docMasked, // {docType, docLast4}
    paymentMethod: paymentMethod || "",
    billingCityState: billingCityState || "",
    billingAddress: billingAddress || "",
    bizProfile: bizProfile || null,
    pendingBizProfile: pendingBizProfile || null,
    asaasCustomerId: asaasCustomerId || "",
    asaasSubscriptionId: asaasSubscriptionId || "",
    cardValidUntil: cardValidUntil || "",
    cardCanceledAt: cardCanceledAt || "",
  };
}
