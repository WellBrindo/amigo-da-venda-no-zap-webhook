// src/services/state.js
import { redisGet, redisSet, redisIncrBy, redisDel, redisSAdd, redisSMembers } from "./redis.js";

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

const keyFullName = (waId) => `user:${waId}:fullName`;

// ✅ doc (MASCARADO)
const keyDocType = (waId) => `user:${waId}:docType`;
const keyDocLast4 = (waId) => `user:${waId}:docLast4`;

// ⚠️ legado (não usar mais, mas migrar se existir)
const keyDocLegacy = (waId) => `user:${waId}:docDigits`;

const keyPaymentMethod = (waId) => `user:${waId}:paymentMethod`;

const keyAsaasCustomerId = (waId) => `user:${waId}:asaasCustomerId`;
const keyAsaasSubscriptionId = (waId) => `user:${waId}:asaasSubscriptionId`;

function safeStr(v) {
  return String(v ?? "").trim();
}

function toInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function maskDocFromParts(docType, docLast4) {
  const t = safeStr(docType).toUpperCase();
  const l4 = safeStr(docLast4);
  if (!t || !l4) return { docType: "", docLast4: "" };
  return { docType: t, docLast4: l4 };
}

async function indexUser(waId) {
  const id = safeStr(waId);
  if (!id) return false;
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

  // counters default
  const curTrial = await redisGet(keyTrialUsed(id));
  if (!curTrial) await redisSet(keyTrialUsed(id), "0");

  const curQuota = await redisGet(keyQuotaUsed(id));
  if (!curQuota) await redisSet(keyQuotaUsed(id), "0");

  // plan default
  const curPlan = await redisGet(keyPlan(id));
  if (!curPlan) await redisSet(keyPlan(id), "");

  // paymentMethod default
  const curPm = await redisGet(keyPaymentMethod(id));
  if (!curPm) await redisSet(keyPaymentMethod(id), "");

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
  return safeStr(v);
}

export async function setUserPlan(waId, planCode) {
  await indexUser(waId);
  const p = safeStr(planCode).toUpperCase();
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
  await redisSet(keyLastPrompt(waId), p);
  return p;
}

export async function clearLastPrompt(waId) {
  await indexUser(waId);
  await redisDel(keyLastPrompt(waId));
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
  await Promise.all([redisDel(keyDocType(waId)), redisDel(keyDocLast4(waId)), redisDel(keyDocLegacy(waId))]);
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
  const m = safeStr(v).toUpperCase();
  return m === "PIX" ? "PIX" : m === "CARD" ? "CARD" : "";
}

export async function setPaymentMethod(waId, method) {
  await indexUser(waId);
  const m = safeStr(method).toUpperCase();
  const v = m === "PIX" ? "PIX" : m === "CARD" ? "CARD" : "";
  await redisSet(keyPaymentMethod(waId), v);
  return v;
}

export async function clearPaymentMethod(waId) {
  await indexUser(waId);
  await redisDel(keyPaymentMethod(waId));
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

// ===================== Reset helpers =====================
export async function resetUserToTrial(waId) {
  await ensureUserExists(waId);
  await Promise.all([
    setUserStatus(waId, "TRIAL"),
    setUserPlan(waId, ""),
    resetUserQuotaUsed(waId),
    resetUserTrialUsed(waId),
    clearLastPrompt(waId),
    setTemplateMode(waId, "FIXED"),
    clearPaymentMethod(waId),
    clearUserDoc(waId),
    setAsaasCustomerId(waId, ""),
    setAsaasSubscriptionId(waId, ""),
  ]);
  return true;
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
    asaasCustomerId,
    asaasSubscriptionId,
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
    getAsaasCustomerId(waId),
    getAsaasSubscriptionId(waId),
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
    asaasCustomerId: asaasCustomerId || "",
    asaasSubscriptionId: asaasSubscriptionId || "",
  };
}
