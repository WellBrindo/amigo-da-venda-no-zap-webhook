// src/services/flow.js
/**
 * Motor principal de conversa (WhatsApp).
 *
 * Objetivo deste passo (16.4):
 * ✅ Trial e Active gerando anúncio via OpenAI
 * ✅ Template FIXED x FREE com preferência persistida (TEMPLATE/LIVRE)
 * ✅ Fim do trial -> mostra planos direto (1/2/3)
 * ✅ Após plano -> escolhe forma de pagamento (Cartão / PIX)
 * ✅ Antes de Asaas -> pede CPF/CNPJ e valida DV
 * ✅ Integração Asaas:
 *    - Cartão: link recorrente (paymentLinks / chargeType RECURRENT)
 *    - PIX: cobrança mensal avulsa (payments / billingType PIX)
 *
 * Regras:
 * - Nunca logar CPF/CNPJ.
 * - Sem gambiarras: fluxo por status + funções pequenas e claras.
 */

import { generateAdText } from "./openai/generate.js";
import { incDescriptionMetrics } from "./metrics.js";
import { getCopyText } from "./copy.js";

import {
  ensureUserExists,
  getUserStatus,
  setUserStatus,
  getUserFullName,
  setUserFullName,
  getTemplateMode,
  setTemplateMode,
  getUserTrialUsed,
  incUserTrialUsed,
  getUserPlan,
  setUserPlan,
  getUserQuotaUsed,
  incUserQuotaUsed,
  setLastPrompt,
  getPaymentMethod,
  setPaymentMethod,
  setUserDocMasked,
  getAsaasCustomerId,
  setAsaasCustomerId,
} from "./state.js";

import { getMenuPlans, getPlanByChoice, renderPlansMenu } from "./Plans.js";
import { validateDoc } from "./brDoc.js";

import {
  findCustomerByExternalReference,
  createCustomer,
  createPixPayment,
  createRecurringCardPaymentLink,
} from "./asaas/client.js";

// -------------------- Config --------------------
const TRIAL_LIMIT = 5;

// -------------------- Statuses (FSM) --------------------
const ST = Object.freeze({
  TRIAL: "TRIAL",
  ACTIVE: "ACTIVE",
  PAYMENT_PENDING: "PAYMENT_PENDING",
  BLOCKED: "BLOCKED",

  WAIT_NAME: "WAIT_NAME",
  WAIT_PRODUCT: "WAIT_PRODUCT",

  WAIT_PLAN: "WAIT_PLAN",
  WAIT_PAYMENT_METHOD: "WAIT_PAYMENT_METHOD",
  WAIT_DOC: "WAIT_DOC",
});

// -------------------- Helpers --------------------
function cleanText(t) {
  return String(t ?? "").trim();
}

function upper(t) {
  return cleanText(t).toUpperCase();
}

function isGreeting(t) {
  const s = upper(t);
  return ["OI", "OLA", "OLÁ", "BOM DIA", "BOA TARDE", "BOA NOITE", "INICIO", "INÍCIO", "START"].includes(s);
}

function normalizeChoice(t) {
  const s = upper(t);
  if (s === "1" || s.startsWith("1 ")) return "1";
  if (s === "2" || s.startsWith("2 ")) return "2";
  if (s === "3" || s.startsWith("3 ")) return "3";
  return "";
}

function wantsTemplateCommand(t) {
  const s = upper(t);
  return s === "TEMPLATE" || s === "FIXO" || s === "FIXED";
}

function wantsFreeCommand(t) {
  const s = upper(t);
  return s === "LIVRE" || s === "FREE";
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function moneyBRFromCents(cents) {
  const v = (Number(cents) || 0) / 100;
  return v.toFixed(2);
}

function reply(text) {
  return { shouldReply: true, replyText: String(text || "") };
}

function noReply() {
  return { shouldReply: false, replyText: "" };
}

// -------------------- Copy / Mensagens --------------------
async function msgAskName(waId){
  return await getCopyText("FLOW_ASK_NAME", { waId });
}

async function msgAskProduct(waId){
  return await getCopyText("FLOW_ASK_PRODUCT", { waId });
}

async function msgTrialOverAndPlans(waId) {
  // renderPlansMenu já vem com o cabeçalho do trial concluído
  const prefix = await getCopyText("FLOW_TRIAL_PREFIX", { waId });
  return prefix + "

" + (await renderPlansMenu());
}

async function msgPlansOnly(waId) {
  // Versão sem o "trial concluído"
  const menu = await getMenuPlans();
  if (!menu || menu.length === 0) {
    return await getCopyText("FLOW_PLANS_FALLBACK_STATIC", { waId });
  }

  const lines = [];
  lines.push("Para continuar, escolha um plano:");
  lines.push("");

  menu.forEach((p, idx) => {
    const n = idx + 1;
    lines.push(`${n}) ${p.name} — R$ ${moneyBRFromCents(p.priceCents)}`);
    lines.push(`   • ${p.description || `${p.monthlyQuota} descrições/mês`}`);
    lines.push("");
  });

  lines.push("Responda com *1*, *2* ou *3*.");
  return lines.join("\n");
}

async function msgAskPaymentMethod(waId, plan){
  return await getCopyText("FLOW_ASK_PAYMENT_METHOD_WITH_PLAN", {
    waId,
    vars: {
      planName: plan?.name || "",
      planPrice: plan?.priceCents ? moneyBRFromCents(plan.priceCents) : "",
    },
  });
}

async function msgAskDoc(waId){
  return await getCopyText("FLOW_ASK_DOC", { waId });
}

async function msgInvalidDoc(waId){
  return await getCopyText("FLOW_INVALID_DOC", { waId });
}

async function msgAfterAdAskTemplateChoice(waId, currentMode){
  const hintKey = currentMode === "FIXED" ? "FLOW_HINT_TEMPLATE_FIXED" : "FLOW_HINT_TEMPLATE_FREE";
  const hint = await getCopyText(hintKey, { waId });
  return await getCopyText("FLOW_AFTER_AD_TEMPLATE_CHOICE", { waId, vars: { hint } });
}

async function msgTemplateSet(waId, mode){
  if (mode === "FREE") return await getCopyText("FLOW_TEMPLATE_SWITCH_TO_FREE", { waId });
  return await getCopyText("FLOW_TEMPLATE_KEEP_FIXED", { waId });
}

// -------------------- Core --------------------
export async function handleInboundText({ waId, text }) {
  const id = cleanText(waId);
  const inbound = cleanText(text);

  if (!id || !inbound) return noReply();

  await ensureUserExists(id);

  // Comandos globais de preferência de template
  if (wantsTemplateCommand(inbound)) {
    await setTemplateMode(id, "FIXED");
    return reply(await msgTemplateSet(id, "FIXED"));
  }
  if (wantsFreeCommand(inbound)) {
    await setTemplateMode(id, "FREE");
    return reply(await msgTemplateSet(id, "FREE"));
  }

  const status = await getUserStatus(id);

  if (status === ST.BLOCKED) {
    return reply(await getCopyText("FLOW_BLOCKED", { waId: id }));
  }

  // ✅ Se o usuário manda "oi" e ainda não tem nome, inicia onboarding
  if (isGreeting(inbound)) {
    const name = await getUserFullName(id);
    if (!name) {
      await setUserStatus(id, ST.WAIT_NAME);
      return reply(await msgAskName(id));
    }
  }

  // 1) Onboarding: nome
  if (status === ST.WAIT_NAME) {
    const name = inbound;
    if (name.length < 3) return reply(await getCopyText("FLOW_NAME_TOO_SHORT", { waId: id }));
    await setUserFullName(id, name);
    await setUserStatus(id, ST.WAIT_PRODUCT);
    return reply(await msgAskProduct(id));
  }

  // 2) Onboarding: produto/serviço
  if (status === ST.WAIT_PRODUCT) {
    if (isGreeting(inbound)) return reply(await msgAskProduct(id));
    return await handleGenerateAdInTrialOrActive({ waId: id, inboundText: inbound, isTrial: true });
  }

  // 3) Trial
  if (status === ST.TRIAL) {
    if (isGreeting(inbound)) return reply(await msgAskProduct(id));
    return await handleGenerateAdInTrialOrActive({ waId: id, inboundText: inbound, isTrial: true });
  }

  // 4) Escolha de plano
  if (status === ST.WAIT_PLAN) {
    const choice = normalizeChoice(inbound);
    const plan = await getPlanByChoice(choice);
    if (!plan) return reply(await msgPlansOnly(id));

    await setUserPlan(id, plan.code);
    await setUserStatus(id, ST.WAIT_PAYMENT_METHOD);

    return reply(await msgAskPaymentMethod(id, plan));
  }

  // 5) Forma de pagamento
  if (status === ST.WAIT_PAYMENT_METHOD) {
    const c = normalizeChoice(inbound);
    if (c !== "1" && c !== "2") return reply(await getCopyText("FLOW_INVALID_PAYMENT_METHOD", { waId: id }));

    const pm = c === "1" ? "CARD" : "PIX";
    await setPaymentMethod(id, pm);
    await setUserStatus(id, ST.WAIT_DOC);

    return reply(await msgAskDoc(id));
  }

  // 6) Documento (CPF/CNPJ) + cria cobrança/assinatura
  if (status === ST.WAIT_DOC) {
    const v = validateDoc(inbound);
    if (!v.ok) return reply(await msgInvalidDoc(id));

    // Guarda somente mascarado
    await setUserDocMasked(id, v.type, v.last4);

    const planCode = await getUserPlan(id);
    const plan = (await getMenuPlans()).find((p) => p.code === planCode);
    if (!plan) {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply(await msgPlansOnly(id));
    }

    const pm = await getPaymentMethod(id);
    if (!pm) {
      await setUserStatus(id, ST.WAIT_PAYMENT_METHOD);
      return reply(await msgAskPaymentMethod(id, plan));
    }

    // customer
    const customerId = await ensureAsaasCustomer({ waId: id, fullName: await getUserFullName(id), cpfCnpj: v.digits });

    // PIX mensal avulso
    if (pm === "PIX") {
      const pay = await createPixPayment({
        customerId,
        value: (Number(plan.priceCents) || 0) / 100,
        description: `Amigo das Vendas - Plano ${plan.code} (PIX mensal)`,
        externalReference: id,
        dueDate: todayISO(),
      });

      await setUserStatus(id, ST.PAYMENT_PENDING);

      const url = pay?.invoiceUrl || pay?.bankSlipUrl || pay?.paymentLink || "";
      const methodTitle = "Gerei sua cobrança via *PIX*.";
      const linkLine = url ? `Pague por aqui: ${url}

` : "Pague pelo link dentro do Asaas.

";
      const msg = await getCopyText("FLOW_PAYMENT_SUCCESS", { waId: id, vars: { methodTitle, linkLine } });
      return reply(msg);
    }

    // Cartão recorrente: Payment Link
    const link = await createRecurringCardPaymentLink({
      name: `Assinatura ${plan.name}`,
      description: `Amigo das Vendas - Plano ${plan.code} (Cartão recorrente)`,
      value: (Number(plan.priceCents) || 0) / 100,
      externalReference: id,
      subscriptionCycle: "MONTHLY",
    });

    await setUserStatus(id, ST.PAYMENT_PENDING);

    const url = link?.url || link?.paymentLink || link?.link || "";
    const methodTitle = "Agora é só concluir no *Cartão* (assinatura).";
    const linkLine = url ? `Finalize por aqui: ${url}

` : "Finalize pelo link no Asaas.

";
    const msg = await getCopyText("FLOW_PAYMENT_SUCCESS", { waId: id, vars: { methodTitle, linkLine } });
    return reply(msg);
  }

  // 7) Pagamento pendente
  if (status === ST.PAYMENT_PENDING) {
    const planCode = await getUserPlan(id);
    const plan = (await getMenuPlans()).find((p) => p.code === planCode);
    const planTxt = plan ? `Plano: *${plan.name}*.` : "";
    return reply(await getCopyText("FLOW_PAYMENT_PENDING", { waId: id, vars: { planTxt } }));
  }

  // 8) ACTIVE
  if (status === ST.ACTIVE) {
    if (isGreeting(inbound)) return reply(await msgAskProduct(id));
    return await handleGenerateAdInTrialOrActive({ waId: id, inboundText: inbound, isTrial: false });
  }

  // fallback seguro
  return reply(await getCopyText("FLOW_FALLBACK_UNKNOWN", { waId: id }));
}

// -------------------- Generate Ad --------------------
async function handleGenerateAdInTrialOrActive({ waId, inboundText, isTrial }) {
  const id = waId;
  const userText = inboundText;

  // TRIAL: checa limite
  if (isTrial) {
    const used = await getUserTrialUsed(id);
    if (used >= TRIAL_LIMIT) {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply(await msgTrialOverAndPlans(id));
    }
  } else {
    // ACTIVE: checa quota do plano
    const planCode = await getUserPlan(id);
    const plan = (await getMenuPlans()).find((p) => p.code === planCode);
    if (!plan) {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply(await msgPlansOnly(id));
    }

    const used = await getUserQuotaUsed(id);
    if (used >= Number(plan.monthlyQuota || 0)) {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply((await getCopyText("FLOW_QUOTA_REACHED_PREFIX", { waId: id })) + "

" + (await msgPlansOnly(id)));
    }
  }

  const mode = await getTemplateMode(id);

  // OpenAI
  let ad = "";
  try {
    const r = await generateAdText({ userText, mode });
    ad = r.text;
  } catch {
    return reply(await getCopyText("FLOW_OPENAI_ERROR", { waId: id }));
  }

  // salva prompt
  await setLastPrompt(id, userText);

  // conta uso
  if (isTrial) await incUserTrialUsed(id, 1);
  else await incUserQuotaUsed(id, 1);

  // métricas globais + por usuário (best-effort; não pode quebrar produção)
  try {
    await incDescriptionMetrics(id, 1);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        tag: "metrics_inc_failed",
        waId: id,
        isTrial: !!isTrial,
        error: String(err?.message || err),
      })
    );
  }

  return reply(ad + (await msgAfterAdAskTemplateChoice(id, mode)));
}

// -------------------- Asaas helpers --------------------
async function ensureAsaasCustomer({ waId, fullName, cpfCnpj }) {
  // 1) se já tem customerId, usa
  const existing = await getAsaasCustomerId(waId);
  if (existing) return existing;

  // 2) tenta achar por externalReference
  const found = await findCustomerByExternalReference(waId).catch(() => null);
  if (found?.id) {
    await setAsaasCustomerId(waId, found.id);
    return found.id;
  }

  // 3) cria
  const customer = await createCustomer({
    name: fullName || waId,
    cpfCnpj, // ⚠️ não logar
    externalReference: waId,
  });

  if (!customer?.id) throw new Error("Asaas: customer not created");
  await setAsaasCustomerId(waId, customer.id);
  return customer.id;
}
