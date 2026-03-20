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

function normalizeActivityMeta(metaObj) {
  const src = isPlainObject(metaObj) ? metaObj : {};
  const dst = {};

  const lastInboundAt = normalizeIsoTimestamp(src.lastInboundAt);
  if (lastInboundAt) dst.lastInboundAt = lastInboundAt;

  const idleReminderSentAt = normalizeIsoTimestamp(src.idleReminderSentAt);
  if (idleReminderSentAt) dst.idleReminderSentAt = idleReminderSentAt;

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
export async function indexUser(userRef) {
  const id = normalizeUserRef(userRef);
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
        userRef: id,
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
        userRef: id,
      })
    );
    await redisDel(USERS_INDEX_KEY);
  }

  await redisSAdd(USERS_INDEX_KEY, id);
  return true;
}

// ===================== Ensure =====================
export async function ensureUserExists(userRef) {
  const id = normalizeUserRef(userRef);
  if (!id) throw new Error("userRef required");

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

export async function listUserIds() {
  return listUsers();
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
function keyLastAd(userId) {
  return redisUserKey(userId, "lastAd");
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
function keyRefineCount(userId) {
  return redisUserKey(userId, "refineCount");
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
  const n = normalizePersonName(fullName);
  if (!n) {
    await redisDel(keyFullName(waId));
    return "";
  }
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
  const v = normalizeCityState(value);
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
  const raw = compactInnerWhitespace(value);
  const v = /^apenas\s+online$/i.test(raw) ? "APENAS ONLINE" : normalizeAddressText(raw);
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

export async function setMenuEditContext(waId, context) {
  await indexUser(waId);
  const payload = context && typeof context === "object" ? context : {};
  if (!Object.keys(payload).length) {
    await redisDel(keyMenuEditContext(waId));
    return null;
  }
  await redisSet(keyMenuEditContext(waId), safeJsonStringify(payload));
  return payload;
}

export async function getMenuEditContext(waId) {
  const raw = await redisGet(keyMenuEditContext(waId));
  const parsed = safeJsonParse(raw);
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
  const normalized = normalizeBizProfileData(profileObj);
  const s = safeJsonStringify(normalized);
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
  const normalized = normalizeBizProfileData(profileObj);
  const s = safeJsonStringify(normalized);
  await redisSet(keyPendingBizProfile(waId), s);
  return true;
}

export async function clearPendingBizProfile(waId) {
  await indexUser(waId);
  await redisDel(keyPendingBizProfile(waId));
  return true;
}

// ===================== Ad Session (anúncio atual) =====================
export async function getCurrentAdSession(waId) {
  const raw = await redisGet(keyCurrentAdSession(waId));
  const obj = safeJsonParse(raw);
  return obj && typeof obj === "object" ? obj : null;
}

export async function setCurrentAdSession(waId, sessionObj) {
  await indexUser(waId);
  const s = safeJsonStringify(sessionObj);
  await redisSet(keyCurrentAdSession(waId), s);
  return true;
}

export async function clearCurrentAdSession(waId) {
  await indexUser(waId);
  await redisDel(keyCurrentAdSession(waId));
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

// ===================== Activity / Growth Meta =====================
export async function getActivityMeta(waId) {
  const parsed = safeJsonParse(await redisGet(keyActivityMeta(waId)));
  return normalizeActivityMeta(parsed);
}

export async function setActivityMeta(waId, metaObj) {
  await indexUser(waId);
  const normalized = normalizeActivityMeta(metaObj);
  if (!Object.keys(normalized).length) {
    await redisDel(keyActivityMeta(waId));
    return {};
  }
  await redisSet(keyActivityMeta(waId), safeJsonStringify(normalized));
  return normalized;
}

export async function clearActivityMeta(waId) {
  await indexUser(waId);
  await redisDel(keyActivityMeta(waId));
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
  const parsed = safeJsonParse(await redisGet(keyGrowthMeta(waId)));
  return normalizeGrowthMeta(parsed);
}

export async function setGrowthMeta(waId, metaObj) {
  await indexUser(waId);
  const normalized = normalizeGrowthMeta(metaObj);
  if (!Object.keys(normalized).length) {
    await redisDel(keyGrowthMeta(waId));
    return {};
  }
  await redisSet(keyGrowthMeta(waId), safeJsonStringify(normalized));
  return normalized;
}

export async function clearGrowthMeta(waId) {
  await indexUser(waId);
  await redisDel(keyGrowthMeta(waId));
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
    keyActivityMeta(id),
    keyGrowthMeta(id),
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
    activityMeta: activityMeta || {},
    growthMeta: growthMeta || {},
    asaasCustomerId: asaasCustomerId || "",
    asaasSubscriptionId: asaasSubscriptionId || "",
    cardValidUntil: cardValidUntil || "",
    cardCanceledAt: cardCanceledAt || "",
  };
}
