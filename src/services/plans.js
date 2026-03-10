// src/services/plans.js
import {
  redisGet,
  redisSet,
  redisSAdd,
  redisSMembers,
  redisDel,
  redisType,
  redisLPush,
  redisLRange,
  redisLLen,
  redisExpire,
} from "./redis.js";

const PLANS_SET_KEY = "plans:all";
const PLAN_KEY_PREFIX = "plan_def:"; // evita conflito com plan:{waId} do state

// ✅ Telemetria persistida (7 dias)
const ALERTS_KEY = "alerts:system";
const ALERTS_TTL_SECONDS = 7 * 24 * 60 * 60;

// Default plans (seed only if no plans exist yet)
const DEFAULT_PLANS = [
  {
    code: "DE_VEZ_EM_QUANDO",
    name: "De Vez em Quando",
    priceCents: 2490,
    monthlyQuota: 20,
    active: true,
    maxRefinements: 2,
    description: "20 descrições/mês",
  },
  {
    code: "SEMPRE_POR_PERTO",
    name: "Sempre por Perto",
    priceCents: 3490,
    monthlyQuota: 60,
    active: true,
    maxRefinements: 2,
    description: "60 descrições/mês",
  },
  {
    code: "MELHOR_AMIGO",
    name: "Melhor Amigo",
    priceCents: 4990,
    monthlyQuota: 200,
    active: true,
    maxRefinements: 2,
    description: "200 descrições/mês",
  },
];

function safeStr(v) {
  return String(v ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function isWrongTypeError(err) {
  const msg = safeStr(err?.message || err).toUpperCase();
  return msg.includes("WRONGTYPE");
}

async function pushSystemAlert(event, payload = {}) {
  try {
    const item = {
      event: safeStr(event),
      ts: nowIso(),
      ...payload,
    };
    await redisLPush(ALERTS_KEY, JSON.stringify(item));
    await redisExpire(ALERTS_KEY, ALERTS_TTL_SECONDS);

    console.warn(
      JSON.stringify({
        level: "warn",
        tag: "system_alert",
        event: item.event,
        ts: item.ts,
        ...payload,
      })
    );
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        tag: "system_alert_failed",
        event: safeStr(event),
        error: safeStr(err?.message || err),
      })
    );
  }
}

async function ensurePlansIndexIsSet({ ctx = "" } = {}) {
  let t = "";
  try {
    t = safeStr(await redisType(PLANS_SET_KEY)).toLowerCase();
  } catch (err) {
    await pushSystemAlert("PLANS_REDIS_TYPE_ERROR", {
      ctx: safeStr(ctx || "ensurePlansIndexIsSet"),
      key: PLANS_SET_KEY,
      error: safeStr(err?.message || err),
    });
    return false;
  }

  // TYPE pode ser "none" (não existe)
  if (t && t !== "set" && t !== "none") {
    await pushSystemAlert("PLANS_INDEX_MIGRATION", {
      ctx: safeStr(ctx || "ensurePlansIndexIsSet"),
      key: PLANS_SET_KEY,
      previousType: t,
      action: "DEL_PLANS_SET_KEY",
    });
    await redisDel(PLANS_SET_KEY);
  }

  return true;
}

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
    const plan = JSON.parse(raw);
    // Backward-compatible default
    if (typeof plan?.maxRefinements !== "number" || !Number.isFinite(plan.maxRefinements)) {
      plan.maxRefinements = 2;
    }
    return plan;
  } catch {
    await pushSystemAlert("PLAN_PARSE_ERROR", {
      key: planKey(code),
      code: safeStr(code),
    });
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


  const maxRefinements = toInt(input?.maxRefinements ?? 2, "maxRefinements");
  if (maxRefinements < 0) throw new Error("maxRefinements must be >= 0");
  const active = Boolean(input?.active);
  const description = String(input?.description || "").trim();

  const plan = { code, name, priceCents, monthlyQuota, maxRefinements, active, description };

  await redisSet(planKey(code), JSON.stringify(plan));

  // ✅ garante o set correto antes de SADD
  await ensurePlansIndexIsSet({ ctx: "upsertPlan" });
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

async function seedDefaultPlansIfNeeded() {
  for (const p of DEFAULT_PLANS) {
    await upsertPlan(p);
  }
}

/**
 * List plans:
 * - Se não existir nenhum, faz seed automático (auto-heal)
 * - Se PLANS_SET_KEY estiver com tipo errado, faz migração segura (DEL só do índice)
 * - Se Redis der erro, registra alerta estruturado
 */
export async function listPlans({ includeInactive = true } = {}) {
  const okIndex = await ensurePlansIndexIsSet({ ctx: "listPlans" });
  if (!okIndex) {
    await pushSystemAlert("PLANS_INDEX_UNAVAILABLE", {
      ctx: "listPlans",
      key: PLANS_SET_KEY,
      reason: "TYPE_ERROR",
    });
    return [];
  }

  let codes = [];
  try {
    codes = (await redisSMembers(PLANS_SET_KEY)) || [];
  } catch (err) {
    if (isWrongTypeError(err)) {
      await pushSystemAlert("PLANS_INDEX_WRONGTYPE_RECOVER", {
        ctx: "listPlans",
        key: PLANS_SET_KEY,
        action: "DEL_AND_RETRY_SMEMBERS",
        error: safeStr(err?.message || err),
      });
      await redisDel(PLANS_SET_KEY);
      codes = (await redisSMembers(PLANS_SET_KEY)) || [];
    } else {
      await pushSystemAlert("PLANS_REDIS_ERROR", {
        ctx: "listPlans",
        key: PLANS_SET_KEY,
        error: safeStr(err?.message || err),
      });
      return [];
    }
  }

  const unique = Array.from(new Set(codes.map((c) => safeStr(c)).filter(Boolean)));

  // Seed default plans on first run (não sobrescreve se já existir)
  if (unique.length === 0) {
    await pushSystemAlert("PLANS_EMPTY", {
      ctx: "listPlans",
      key: PLANS_SET_KEY,
      action: "SEED_DEFAULT_PLANS",
    });
    await seedDefaultPlansIfNeeded();
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
  const menu = order.map((c) => map.get(c)).filter(Boolean);

  // Telemetria explícita: menu vazio (evita “loop silencioso”)
  if (menu.length === 0) {
    await pushSystemAlert("PLANS_MENU_EMPTY_OR_ALL_INACTIVE", {
      ctx: "getMenuPlans",
      key: PLANS_SET_KEY,
      countActive: 0,
      reason: plans.length === 0 ? "NO_PLANS" : "ALL_INACTIVE_OR_MISSING_DEFAULT_CODES",
    });
  }

  return menu;
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

function renderPlanLine(plan, index) {
  const price = formatBRLFromCents(plan?.priceCents || 0);
  const description = safeStr(plan?.description) || `${Number(plan?.monthlyQuota || 0)} descrições/mês`;
  const emojiNumber = ["1️⃣", "2️⃣", "3️⃣"][index] || `${index + 1})`;
  return `${emojiNumber} *${safeStr(plan?.name)}* — ${price} (${description})`;
}

export async function renderPlansMenu({ variant = "trialEnded" } = {}) {
  const menu = await getMenuPlans();
  const isTrialEnded = String(variant || "trialEnded") === "trialEnded";

  // fallback (se não tiver seed por algum motivo)
  if (menu.length === 0) {
    // ✅ também registra “fallback visual” (porque isso afeta conversão)
    await pushSystemAlert("PLANS_MENU_FALLBACK_RENDERED", {
      ctx: "renderPlansMenu",
      key: PLANS_SET_KEY,
      reason: "MENU_EMPTY",
      variant: isTrialEnded ? "trialEnded" : "plansOnly",
    });

    if (isTrialEnded) {
      return (
        `Seu teste grátis acabou 😄

` +
        `Para continuar, escolha um plano:

` +
        `1️⃣ *De Vez em Quando* — R$ 24,90 (20 descrições/mês)
` +
        `2️⃣ *Sempre por Perto* — R$ 34,90 (60 descrições/mês)
` +
        `3️⃣ *Melhor Amigo* — R$ 49,90 (200 descrições/mês)

` +
        `Responda com *1*, *2* ou *3*.`
      );
    }

    return (
      `Para continuar, escolha um plano:

` +
      `1️⃣ *De Vez em Quando* — R$ 24,90 (20 descrições/mês)
` +
      `2️⃣ *Sempre por Perto* — R$ 34,90 (60 descrições/mês)
` +
      `3️⃣ *Melhor Amigo* — R$ 49,90 (200 descrições/mês)

` +
      `Responda com *1*, *2* ou *3*.`
    );
  }

  const lines = [];
  if (isTrialEnded) {
    lines.push(`Seu teste grátis acabou 😄`);
    lines.push("");
  }
  lines.push(`Para continuar, escolha um plano:`);
  lines.push("");

  menu.forEach((p, idx) => {
    lines.push(renderPlanLine(p, idx));
  });

  lines.push("");
  lines.push(`Responda com *1*, *2* ou *3*.`);
  return lines.join("\n");
}

// -------------------------
// Admin helpers: Health + Alerts
// -------------------------

export async function getPlansHealth() {
  try {
    const all = await listPlans({ includeInactive: true });
    const active = all.filter((p) => p && p.active);

    let ok = true;
    let reason = "OK";
    if (all.length === 0) {
      ok = false;
      reason = "NO_PLANS";
    } else if (active.length === 0) {
      ok = false;
      reason = "ALL_INACTIVE";
    }

    return {
      ok,
      reason,
      counts: {
        all: all.length,
        active: active.length,
      },
      keys: {
        plansSetKey: PLANS_SET_KEY,
      },
    };
  } catch (err) {
    await pushSystemAlert("PLANS_HEALTH_ERROR", {
      ctx: "getPlansHealth",
      key: PLANS_SET_KEY,
      error: safeStr(err?.message || err),
    });
    return {
      ok: false,
      reason: "ERROR",
      error: safeStr(err?.message || err),
      keys: { plansSetKey: PLANS_SET_KEY },
    };
  }
}

export async function getSystemAlertsCount() {
  try {
    const n = await redisLLen(ALERTS_KEY);
    return Number(n) || 0;
  } catch {
    return 0;
  }
}

export async function listSystemAlerts({ limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(500, Number(limit) || 50));
  try {
    const raw = await redisLRange(ALERTS_KEY, 0, lim - 1);
    const arr = Array.isArray(raw) ? raw : [];
    return arr
      .map((s) => {
        try {
          return JSON.parse(String(s));
        } catch {
          return { event: "ALERT_RAW", ts: nowIso(), raw: safeStr(s) };
        }
      })
      .filter(Boolean);
  } catch (err) {
    await pushSystemAlert("ALERTS_READ_ERROR", {
      ctx: "listSystemAlerts",
      key: ALERTS_KEY,
      error: safeStr(err?.message || err),
    });
    return [];
  }
}
