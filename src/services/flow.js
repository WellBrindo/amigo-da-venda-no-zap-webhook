// src/services/flow.js
import {
  ensureUserExists,
  getUserStatus,
  setUserStatus,
  getUserTrialUsed,
  incUserTrialUsed,
  setLastPrompt,
  getUserPlan,
  setUserPlan,
  getTemplateMode,
  setTemplateMode,
} from "./state.js";

import { generateAdText } from "./openai/generate.js";
import { listPlans, formatBRLFromCents } from "./Plans.js";

const FLOW_BUILD = "V16.3.1"; // ✅ assinatura pra você testar no WhatsApp
const TRIAL_LIMIT = 5;

// filtro simples para evitar custo com “oi”, “teste”, etc.
function isTooShortForGeneration(text) {
  const t = String(text || "").trim();
  if (t.length < 8) return true;
  const upper = t.toUpperCase();
  if (upper === "OI" || upper === "OLÁ" || upper === "OLA" || upper === "TESTE") return true;
  return false;
}

// ===== Planos (menu 1/2/3) =====
async function buildPlansMenuText() {
  const plans = await listPlans({ includeInactive: false });

  // fallback extremo (não deveria acontecer, porque Plans.js faz seed)
  if (!plans || plans.length === 0) {
    return (
      `📌 *Planos disponíveis*\n\n` +
      `1) *De Vez em Quando* — R$ 24,90 — 20 descrições/mês\n` +
      `2) *Sempre por Perto* — R$ 34,90 — 60 descrições/mês\n` +
      `3) *Melhor Amigo* — R$ 49,90 — 200 descrições/mês\n\n` +
      `👉 Responda com *1*, *2* ou *3* para escolher.`
    );
  }

  // garante ordem pelos 3 planos principais (se existirem)
  const order = ["DE_VEZ_EM_QUANDO", "SEMPRE_POR_PERTO", "MELHOR_AMIGO"];
  const byCode = new Map(plans.map((p) => [String(p.code || "").toUpperCase(), p]));
