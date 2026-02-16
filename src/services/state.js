import { redisGet, redisSet, redisSAdd } from "./redis.js";

export const USER_STATUSES = [
  "TRIAL",
  "ACTIVE",
  "WAIT_PLAN",
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

function normalizeStatus(status) {
  if (!status) return "OTHER";
  const s = String(status).toUpperCase().trim();
  if (USER_STATUSES.includes(s)) return s;
  return "OTHER";
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
    await redisSet(keyPlan(waId), "");
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
  if (!v) return DEFAULT_NEW_USER_STATUS; // usuário novo sem status explícito
  return normalizeStatus(v);
}

export async function setUserPlan(waId, planCode) {
  await indexUser(waId);
  await redisSet(keyPlan(waId), String(planCode || ""));
  return String(planCode || "");
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
  await redisSet(keyLastPrompt(waId), String(text || ""));
  return String(text || "");
}

export async function getLastPrompt(waId) {
  const v = await redisGet(keyLastPrompt(waId));
  return v ? String(v) : "";
}

export async function getUserSnapshot(waId) {
  const [status, plan, quotaUsed, trialUsed, lastPrompt] = await Promise.all([
    getUserStatus(waId),
    getUserPlan(waId),
    getUserQuotaUsed(waId),
    getUserTrialUsed(waId),
    getLastPrompt(waId),
  ]);

  return {
    waId,
    status,
    plan,
    quotaUsed,
    trialUsed,
    lastPrompt,
  };
}
