// src/services/state.js
import { redisGet, redisSet, redisDel, redisSAdd } from "./redis.js";

export const USER_STATUSES = [
  "TRIAL",
  "ACTIVE",
  "WAIT_PLAN",
  "WAIT_DOC",        // ✅ novo
  "WAIT_PAY_METHOD", // ✅ novo
  "PAYMENT_PENDING",
  "BLOCKED",
  "OTHER",
];

export const DEFAULT_NEW_USER_STATUS = "TRIAL";

function keyUserIndexAll() {
  return "users:all";
}

function keyStatus(waId) {
  return `status:${waId}`;
}

function keyPlan(waId) {
  return `plan:${waId}`;
}

function keyQuotaUsed(waId) {
  return `quotaused:${waId}`;
}

function keyTrialUsed(waId) {
  return `trialused:${waId}`;
}

function keyLastPrompt(waId) {
  return `last_prompt:${waId}`;
}

function keyTemplateMode(waId) {
  return `template_mode:${waId}`; // FIXED | FREE
}

// ✅ NOVOS CAMPOS (Passo 16.1)
function keyFullName(waId) {
  return `full_name:${waId}`;
}

function keyDoc(waId) {
  return `doc:${waId}`; // CPF/CNPJ somente números
}

// (já preparando próximos passos)
function keyAsaasCustomerId(waId) {
  return `asaas_customer_id:${waId}`;
}
function keyAsaasSubscriptionId(waId) {
  return `asaas_subscription_id:${waId}`;
}

function normalizeStatus(status) {
  if (!status) return "OTHER";
  const s = String(status).toUpperCase().trim();
  if (USER_STATUSES.includes(s)) return s;
  return "OTHER";
}

function normalizeTemplateMode(mode) {
  const m = String(mode || "").toUpperCase().trim();
  if (m === "FREE" || m === "LIVRE") return "FREE";
  return "FIXED";
}

function normalizeFullName(name) {
  const n = String(name || "")
    .replace(/\s+/g, " ")
    .trim();
  return n;
}

function normalizeDocDigits(doc) {
  return String(doc || "").replace(/\D+/g, "").trim();
}

function maskDoc(docDigits) {
  const d = normalizeDocDigits(docDigits);
  if (!d) return { docType: "", docLast4: "" };
  const docType = d.length === 11 ? "CPF" : d.length === 14 ? "CNPJ" : "DOC";
  const docLast4 = d.slice(-4);
  return { docType, docLast4 };
}

export async function indexUser(waId) {
  if (!waId) return;
  await redisSAdd(keyUserIndexAll(), waId);
}

export async function ensureUserExists(waId) {
  if (!waId) throw new Error("Missing waId");

  await indexUser(waId);

  const currentStatusRaw = await redisGet(keyStatus(waId));
  if (!currentStatusRaw) {
    await redisSet(keyStatus(waId), DEFAULT_NEW_USER_STATUS);
    await redisSet(keyTrialUsed(waId), "0");
    await redisSet(keyQuotaUsed(waId), "0");
    await redisDel(keyPlan(waId));
    await redisDel(keyLastPrompt(waId));
    // padrão = FIXED
    await redisSet(keyTemplateMode(waId), "FIXED");

    // ✅ novos campos iniciam vazios (não grava nada)
    await redisDel(keyFullName(waId));
    await redisDel(keyDoc(waId));
    await redisDel(keyAsaasCustomerId(waId));
    await redisDel(keyAsaasSubscriptionId(waId));
  }

  const status = await getUserStatus(waId);
  return { waId, status };
}

export async function setUserStatus(waId, status) {
  const s = normalizeStatus(status);
  await indexUser(waId);
  await redisSet(keyStatus(waId), s);
  return s;
}

export async function getUserStatus(waId) {
  const v = await redisGet(keyStatus(waId));
  if (!v) return DEFAULT_NEW_USER_STATUS;
  return normalizeStatus(v);
}

export async function setUserPlan(waId, planCode) {
  await indexUser(waId);

  const plan = String(planCode || "").trim();
  if (!plan) {
    await redisDel(keyPlan(waId));
    return "";
  }

  await redisSet(keyPlan(waId), plan);
  return plan;
}

export async function getUserPlan(waId) {
  const v = await redisGet(keyPlan(waId));
  return v ? String(v) : "";
}

export async function setUserQuotaUsed(waId, n) {
  await indexUser(waId);
  const val = String(Number(n || 0));
  await redisSet(keyQuotaUsed(waId), val);
  return Number(val);
}

export async function getUserQuotaUsed(waId) {
  const v = await redisGet(keyQuotaUsed(waId));
  return Number(v || 0);
}

export async function setUserTrialUsed(waId, n) {
  await indexUser(waId);
  const val = String(Number(n || 0));
  await redisSet(keyTrialUsed(waId), val);
  return Number(val);
}

export async function getUserTrialUsed(waId) {
  const v = await redisGet(keyTrialUsed(waId));
  return Number(v || 0);
}

export async function incUserTrialUsed(waId, delta = 1) {
  const cur = await getUserTrialUsed(waId);
  const next = cur + Number(delta || 0);
  await setUserTrialUsed(waId, next);
  return next;
}

export async function setLastPrompt(waId, text) {
  await indexUser(waId);

  const t = String(text || "").trim();
  if (!t) {
    await redisDel(keyLastPrompt(waId));
    return "";
  }

  await redisSet(keyLastPrompt(waId), t);
  return t;
}

export async function getLastPrompt(waId) {
  const v = await redisGet(keyLastPrompt(waId));
  return v ? String(v) : "";
}

export async function setTemplateMode(waId, mode) {
  await indexUser(waId);
  const m = normalizeTemplateMode(mode);
  await redisSet(keyTemplateMode(waId), m);
  return m;
}

export async function getTemplateMode(waId) {
  const v = await redisGet(keyTemplateMode(waId));
  return normalizeTemplateMode(v || "FIXED");
}

// ===================== ✅ NOVO: NOME COMPLETO =====================
export async function setUserFullName(waId, fullName) {
  await indexUser(waId);
  const n = normalizeFullName(fullName);

  if (!n) {
    await redisDel(keyFullName(waId));
    return "";
  }

  await redisSet(keyFullName(waId), n);
  return n;
}

export async function getUserFullName(waId) {
  const v = await redisGet(keyFullName(waId));
  return v ? String(v) : "";
}

export async function clearUserFullName(waId) {
  await redisDel(keyFullName(waId));
  return true;
}

// ===================== ✅ NOVO: DOC (CPF/CNPJ) =====================
export async function setUserDoc(waId, docDigits) {
  await indexUser(waId);
  const d = normalizeDocDigits(docDigits);

  if (!d) {
    await redisDel(keyDoc(waId));
    return "";
  }

  // aqui ainda NÃO valida dígito verificador (isso entra no Passo 16.4)
  await redisSet(keyDoc(waId), d);
  return d;
}

export async function getUserDoc(waId) {
  const v = await redisGet(keyDoc(waId));
  return v ? normalizeDocDigits(v) : "";
}

export async function clearUserDoc(waId) {
  await redisDel(keyDoc(waId));
  return true;
}

// ===================== (Preparação) Asaas IDs =====================
export async function setAsaasCustomerId(waId, customerId) {
  await indexUser(waId);
  const id = String(customerId || "").trim();
  if (!id) {
    await redisDel(keyAsaasCustomerId(waId));
    return "";
  }
  await redisSet(keyAsaasCustomerId(waId), id);
  return id;
}

export async function getAsaasCustomerId(waId) {
  const v = await redisGet(keyAsaasCustomerId(waId));
  return v ? String(v) : "";
}

export async function setAsaasSubscriptionId(waId, subId) {
  await indexUser(waId);
  const id = String(subId || "").trim();
  if (!id) {
    await redisDel(keyAsaasSubscriptionId(waId));
    return "";
  }
  await redisSet(keyAsaasSubscriptionId(waId), id);
  return id;
}

export async function getAsaasSubscriptionId(waId) {
  const v = await redisGet(keyAsaasSubscriptionId(waId));
  return v ? String(v) : "";
}

// ===================== SNAPSHOT =====================
export async function getUserSnapshot(waId) {
  const [
    status,
    plan,
    quotaUsed,
    trialUsed,
    lastPrompt,
    templateMode,
    fullName,
    docDigits,
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
    getUserDoc(waId),
    getAsaasCustomerId(waId),
    getAsaasSubscriptionId(waId),
  ]);

  const docMasked = maskDoc(docDigits);

  return {
    waId,
    status,
    plan,
    quotaUsed,
    trialUsed,
    lastPrompt,
    templateMode,

    // ✅ novos campos
    fullName: fullName || "",
    doc: docMasked, // NÃO retorna o doc completo no snapshot

    // preparação
    asaasCustomerId: asaasCustomerId || "",
    asaasSubscriptionId: asaasSubscriptionId || "",
  };
}
