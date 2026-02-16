import { redisGet, redisSet, redisSAdd, redisSMembers, redisDel } from "./redis.js";

const PLANS_SET_KEY = "plans:all";
const PLAN_KEY_PREFIX = "plan:";

// Default plans (seed only if no plans exist yet)
const DEFAULT_PLANS = [
  {
    code: "DE_VEZ_EM_QUANDO",
    name: "De Vez em Quando",
    priceCents: 2490,
    monthlyQuota: 20,
    active: true,
    description: "20 descrições/mês",
  },
  {
    code: "SEMPRE_POR_PERTO",
    name: "Sempre por Perto",
    priceCents: 3490,
    monthlyQuota: 60,
    active: true,
    description: "60 descrições/mês",
  },
  {
    code: "MELHOR_AMIGO",
    name: "Melhor Amigo",
    priceCents: 4990,
    monthlyQuota: 200,
    active: true,
    description: "200 descrições/mês",
  },
];

function normalizeCode(code) {
  const c = String(code || "").trim().toUpperCase();
  if (!c) throw new Error("Missing plan code");
  if (!/^[A-Z0-9_]{3,40}$/.test(c)) {
    throw new Error("Invalid plan code. Use A-Z, 0-9 and underscore (3-40 chars).");
  }
  return c;
}

function toInt(n, field) {
  const v = Number(n);
  if (!Number.isFinite(v)) throw new Error(`Invalid ${field}`);
  return Math.trunc(v);
}

export function formatBRLFromCents(cents) {
  const v = (Number(cents) || 0) / 100;
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export async function getPlan(code) {
  const c = normalizeCode(code);
  const raw = await redisGet(PLAN_KEY_PREFIX + c);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function upsertPlan(input) {
  const code = normalizeCode(input?.code);
  const name = String(input?.name || "").trim();
  if (!name) throw new Error("Missing plan name");

  const priceCents = toInt(input?.priceCents, "priceCents");
  if (priceCents < 0) throw new Error("priceCents must be >= 0");

  const monthlyQuota = toInt(input?.monthlyQuota, "monthlyQuota");
  if (monthlyQuota < 0) throw new Error("monthlyQuota must be >= 0");

  const active = Boolean(input?.active);
  const description = String(input?.description || "").trim();

  const plan = { code, name, priceCents, monthlyQuota, active, description };

  await redisSet(PLAN_KEY_PREFIX + code, JSON.stringify(plan), null);
  await redisSAdd(PLANS_SET_KEY, code);
  return plan;
}

export async function setPlanActive(code, active) {
  const plan = await getPlan(code);
  if (!plan) throw new Error("Plan not found");
  plan.active = Boolean(active);
  await redisSet(PLAN_KEY_PREFIX + plan.code, JSON.stringify(plan), null);
  return plan;
}

export async function deletePlan(code) {
  const c = normalizeCode(code);
  await redisDel(PLAN_KEY_PREFIX + c);
  return { ok: true };
}

export async function listPlans({ includeInactive = true } = {}) {
  const codes = (await redisSMembers(PLANS_SET_KEY)) || [];
  const unique = Array.from(new Set(codes.map((c) => String(c || "").trim()).filter(Boolean)));

  // Seed default plans on first run (não sobrescreve se já existir)
  if (unique.length === 0) {
    for (const p of DEFAULT_PLANS) {
      await upsertPlan(p);
    }
    return listPlans({ includeInactive });
  }

  const plans = [];
  for (const code of unique) {
    const plan = await getPlan(code);
    if (!plan) continue;
    if (!includeInactive && !plan.active) continue;
    plans.push(plan);
  }

  plans.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  return plans;
}
