// src/services/plans.js
import { redisGet, redisSet, redisSAdd, redisSMembers, redisDel } from "./redis.js";

const PLANS_SET_KEY = "plans:all";
const PLAN_KEY_PREFIX = "plan_def:"; // evita conflito com plan:{waId} do state

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

function planKey(code) {
  return PLAN_KEY_PREFIX + normalizeCode(code);
}

export async function getPlan(code) {
  const raw = await redisGet(planKey(code));
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

  await redisSet(planKey(code), JSON.stringify(plan));
  await redisSAdd(PLANS_SET_KEY, code);
  return plan;
}

export async function setPlanActive(code, active) {
  const plan = await getPlan(code);
  if (!plan) throw new Error("Plan not found");
  plan.active = Boolean(active);
  await redisSet(planKey(plan.code), JSON.stringify(plan));
  return plan;
}

export async function deletePlan(code) {
  await redisDel(planKey(code));
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

// Ajuda para o fluxo: retorna os 3 planos ativos na ordem do menu (1/2/3)
export async function getMenuPlans() {
  const plans = await listPlans({ includeInactive: false });
  // garante a ordem padrão do produto
  const order = ["DE_VEZ_EM_QUANDO", "SEMPRE_POR_PERTO", "MELHOR_AMIGO"];
  const map = new Map(plans.map((p) => [p.code, p]));
  return order.map((c) => map.get(c)).filter(Boolean);
}

export async function getPlanByChoice(choice) {
  const c = String(choice || "").trim();
  const menu = await getMenuPlans();
  if (c === "1") return menu[0] || null;
  if (c === "2") return menu[1] || null;
  if (c === "3") return menu[2] || null;
  // também aceita o código por texto
  const upper = c.toUpperCase();
  return menu.find((p) => p.code === upper) || null;
}

export async function renderPlansMenu() {
  const menu = await getMenuPlans();
  // fallback (se não tiver seed por algum motivo)
  if (menu.length === 0) {
    return (
      `😄 Seu trial gratuito foi concluído!\n\n` +
      `Para continuar, escolha um plano:\n\n` +
      `1) De Vez em Quando — R$ 24.90\n   • 20 descrições/mês\n\n` +
      `2) Sempre por Perto — R$ 34.90\n   • 60 descrições/mês\n\n` +
      `3) Melhor Amigo — R$ 49.90\n   • 200 descrições/mês\n\n` +
      `Responda com 1, 2 ou 3.`
    );
  }

  const lines = [];
  lines.push(`😄 Seu trial gratuito foi concluído!`);
  lines.push(``);
  lines.push(`Para continuar, escolha um plano:`);
  lines.push(``);

  menu.forEach((p, idx) => {
    const n = idx + 1;
    const price = formatBRLFromCents(p.priceCents).replace("R$", "R$ ").replace(".", ",");
    lines.push(`${n}) ${p.name} — ${price}`);
    lines.push(`   • ${p.description || `${p.monthlyQuota} descrições/mês`}`);
    lines.push(``);
  });

  lines.push(`Responda com 1, 2 ou 3.`);
  return lines.join("\n");
}
