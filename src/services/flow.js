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
  getUserDocMasked,
  setUserDocMasked,
  getAsaasCustomerId,
  setAsaasCustomerId,
  getAsaasSubscriptionId,
  setAsaasSubscriptionId,
  setMenuPrevStatus,
  getMenuPrevStatus,
  clearMenuPrevStatus,
  setCardValidUntil,
  getCardValidUntil,
  setCardCanceledAt,
} from "./state.js";

import { getMenuPlans, getPlanByChoice, renderPlansMenu } from "./Plans.js";
import { validateDoc } from "./brDoc.js";

import {
  findCustomerByExternalReference,
  createCustomer,
  createPixPayment,
  createRecurringCardPaymentLink,
  getSubscription,
  cancelSubscription,
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

  WAIT_MENU: "WAIT_MENU",
  WAIT_MENU_NEW_NAME: "WAIT_MENU_NEW_NAME",
  WAIT_MENU_NEW_DOC: "WAIT_MENU_NEW_DOC",
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


function wantsMenuCommand(t) {
  const s = upper(t);
  return s === "MENU" || s === "MENÚ";
}

function normalizeMenuChoice(t) {
  const s = cleanText(t);
  // aceita "1", "1)", "1." etc
  const m = s.match(/^(\d{1,2})\s*[)\.\-:]?/);
  if (!m) return "";
  const n = String(m[1] || "").trim();
  // menu tem 1..10
  if (!n) return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  if (num < 1 || num > 10) return "";
  return String(num);
}

function formatDateBR(iso) {
  const s = String(iso || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  return `${m[3]}/${m[2]}`;
}

function daysUntilISO(iso) {
  const s = String(iso || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const target = new Date(y, mo, d, 23, 59, 59);
  const now = new Date();
  const diffMs = target.getTime() - now.getTime();
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

function isISODateInFutureOrToday(iso) {
  const days = daysUntilISO(iso);
  if (days === null) return false;
  return days >= 0;
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

async function msgTrialOverAndPlans() {
  // renderPlansMenu já vem com o cabeçalho do trial concluído
  return "Não entendi 😅\n\n" + (await renderPlansMenu());
}

async function msgPlansOnly() {
  // Versão sem o "trial concluído"
  const menu = await getMenuPlans();
  if (!menu || menu.length === 0) {
    return (
      "Para continuar, escolha um plano:\n\n" +
      "1) De Vez em Quando — R$ 24.90\n   • 20 descrições/mês\n\n" +
      "2) Sempre por Perto — R$ 34.90\n   • 60 descrições/mês\n\n" +
      "3) Melhor Amigo — R$ 49.90\n   • 200 descrições/mês\n\n" +
      "Responda com *1*, *2* ou *3*."
    );
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


async function msgMenuMain(waId) {
  return await getCopyText("FLOW_MENU_MAIN", { waId });
}

async function msgMenuAskNewName(waId) {
  return await getCopyText("FLOW_MENU_ASK_NEW_NAME", { waId });
}

async function msgMenuAskNewDoc(waId) {
  return await getCopyText("FLOW_MENU_ASK_NEW_DOC", { waId });
}

async function msgMenuUrlHelp(waId) {
  return await getCopyText("FLOW_MENU_URL_HELP", { waId });
}

async function msgMenuUrlFeedback(waId) {
  return await getCopyText("FLOW_MENU_URL_FEEDBACK", { waId });
}

async function msgMenuUrlInstagram(waId) {
  return await getCopyText("FLOW_MENU_URL_INSTAGRAM", { waId });
}

async function msgMenuCancelNotFound(waId) {
  return await getCopyText("FLOW_MENU_CANCEL_NOT_FOUND", { waId });
}

async function msgMenuCancelOk(waId, { renewalBr = "", daysLeft = "" } = {}) {
  return await getCopyText("FLOW_MENU_CANCEL_OK", {
    waId,
    vars: { renewalBr, daysLeft },
  });
}

async function msgMenuMySubscription(waId) {
  const planCode = await getUserPlan(waId);
  const plans = await getMenuPlans();
  const plan = (plans || []).find((p) => p.code === planCode) || null;

  const planName = plan?.name || (planCode ? String(planCode) : "Sem plano");
  const quotaTotal = Number(plan?.monthlyQuota || 0) || 0;
  const used = await getUserQuotaUsed(waId);

  // renovação do cartão (quando existir)
  const validUntil = await getCardValidUntil(waId);
  const renewalBr = formatDateBR(validUntil) || "—";
  const days = daysUntilISO(validUntil);
  const daysLeft = typeof days === "number" ? String(days) : "—";

  const base = [
    "*Minha assinatura*",
    "",
    `📦 Plano: ${planName}`,
    `📊 Uso no mês: ${used} / ${quotaTotal || "—"}`,
    `📅 Renovação (Cartão): ${renewalBr} — faltam ${daysLeft} dia(s)`,
    "",
    "Instagram: https://www.instagram.com/amigo.das.vendas/",
  ].join("\n");

  return base;
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

  // Comando global: MENU
  if (wantsMenuCommand(inbound)) {
    const cur = await getUserStatus(id);
    await setMenuPrevStatus(id, cur);
    await setUserStatus(id, ST.WAIT_MENU);
    return reply(await msgMenuMain(id));
  }


  const status = await getUserStatus(id);

  if (status === ST.BLOCKED) {
    return reply(await getCopyText("FLOW_BLOCKED", { waId: id }));
  }

  // 0) MENU (estado dedicado)
  if (status === ST.WAIT_MENU) {
    const choice = normalizeMenuChoice(inbound);

    // Se não for número válido, sai do menu e trata como "próxima descrição"
    if (!choice) {
      const prev = await getMenuPrevStatus(id);
      await clearMenuPrevStatus(id);
      if (prev && prev !== ST.WAIT_MENU) {
        await setUserStatus(id, prev);
      } else {
        // fallback seguro
        await setUserStatus(id, ST.WAIT_PRODUCT);
      }
      // Reprocessa a mesma mensagem com o status restaurado
      return await handleInboundText({ waId: id, text: inbound });
    }

    // opção 1: Minha assinatura
    if (choice === "1") {
      return reply(await msgMenuMySubscription(id));
    }

    // opção 2: Alterar para anúncio FIXO
    if (choice === "2") {
      await setTemplateMode(id, "FIXED");
      return reply(await msgTemplateSet(id, "FIXED"));
    }

    // opção 3: Alterar para anúncio LIVRE
    if (choice === "3") {
      await setTemplateMode(id, "FREE");
      return reply(await msgTemplateSet(id, "FREE"));
    }

    // opção 4: Planos
    if (choice === "4") {
      return reply(await msgPlansOnly());
    }

    // opção 5: Cancelar plano (cartão)
    if (choice === "5") {
      const subId = await getAsaasSubscriptionId(id);
      if (!subId) return reply(await msgMenuCancelNotFound(id));

      // tenta capturar próxima renovação antes de cancelar
      let nextDue = "";
      try {
        const sub = await getSubscription({ subscriptionId: subId });
        nextDue = String(sub?.nextDueDate || sub?.nextPaymentDate || "").trim();
        if (nextDue) {
          await setCardValidUntil(id, nextDue);
        }
      } catch (_) {
        // best-effort; não quebra produção
      }

      // cancela recorrência
      await cancelSubscription({ subscriptionId: subId });

      await setCardCanceledAt(id, new Date().toISOString());

      const renewalBr = formatDateBR(nextDue) || formatDateBR(await getCardValidUntil(id)) || "—";
      const days = daysUntilISO(nextDue || (await getCardValidUntil(id)));
      const daysLeft = typeof days === "number" ? String(days) : "—";

      return reply(await msgMenuCancelOk(id, { renewalBr, daysLeft }));
    }

    // opção 6: Alterar nome
    if (choice === "6") {
      await setUserStatus(id, ST.WAIT_MENU_NEW_NAME);
      return reply(await msgMenuAskNewName(id));
    }

    // opção 7: Alterar CPF/CNPJ
    if (choice === "7") {
      await setUserStatus(id, ST.WAIT_MENU_NEW_DOC);
      return reply(await msgMenuAskNewDoc(id));
    }

    // opção 8: Ajuda
    if (choice === "8") return reply(await msgMenuUrlHelp(id));

    // opção 9: Formulário
    if (choice === "9") return reply(await msgMenuUrlFeedback(id));

    // opção 10: Instagram
    if (choice === "10") return reply(await msgMenuUrlInstagram(id));

    // fallback (não deve acontecer)
    return reply(await msgMenuMain(id));
  }

  // 0.1) MENU — alteração de nome
  if (status === ST.WAIT_MENU_NEW_NAME) {
    const name = inbound;
    if (name.length < 3) return reply(await getCopyText("FLOW_NAME_TOO_SHORT", { waId: id }));
    await setUserFullName(id, name);

    // volta ao menu
    await setUserStatus(id, ST.WAIT_MENU);
    return reply("✅ Nome atualizado!

" + (await msgMenuMain(id)));
  }

  // 0.2) MENU — alteração de CPF/CNPJ
  if (status === ST.WAIT_MENU_NEW_DOC) {
    const v = validateDoc(inbound);
    if (!v.ok) return reply(await msgInvalidDoc(id));

    await setUserDocMasked(id, v.type, v.last4);

    // volta ao menu
    await setUserStatus(id, ST.WAIT_MENU);
    return reply("✅ CPF/CNPJ atualizado!

" + (await msgMenuMain(id)));
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
    if (name.length < 3) return reply("Me envia seu *nome completo* por favor 🙂");
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
    if (!plan) return reply(await msgPlansOnly());

    await setUserPlan(id, plan.code);
    await setUserStatus(id, ST.WAIT_PAYMENT_METHOD);

    return reply(await msgAskPaymentMethod(id, plan));
  }

  // 5) Forma de pagamento
  if (status === ST.WAIT_PAYMENT_METHOD) {
    const c = normalizeChoice(inbound);
    if (c !== "1" && c !== "2") return reply("Me diga *1* (Cartão) ou *2* (PIX), por favor 🙂");

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
      return reply(await msgPlansOnly());
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
      const line1 = "✅ Pronto! Gerei sua cobrança via *PIX*.\n\n";
      const line2 = url ? `Pague por aqui: ${url}\n\n` : "Pague pelo link dentro do Asaas.\n\n";
      const line3 = "Assim que o pagamento for confirmado, seu plano ativa automaticamente. 🚀";
      return reply(line1 + line2 + line3);
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
    const line1 = "✅ Pronto! Agora é só concluir no *Cartão* (assinatura).\n\n";
    const line2 = url ? `Finalize por aqui: ${url}\n\n` : "Finalize pelo link no Asaas.\n\n";
    const line3 = "Assim que confirmar, seu plano ativa automaticamente. 🚀";
    return reply(line1 + line2 + line3);
  }

  // 7) Pagamento pendente
  if (status === ST.PAYMENT_PENDING) {
    const planCode = await getUserPlan(id);
    const plan = (await getMenuPlans()).find((p) => p.code === planCode);
    const planTxt = plan ? `Plano: *${plan.name}*.` : "";
    return reply(`Seu pagamento ainda está *pendente* no Asaas. ${planTxt}\n\nAssim que confirmar, eu libero automaticamente. 🚀`);
  }

  // 8) ACTIVE
  if (status === ST.ACTIVE) {
    if (isGreeting(inbound)) return reply(await msgAskProduct(id));
    return await handleGenerateAdInTrialOrActive({ waId: id, inboundText: inbound, isTrial: false });
  }

  // fallback seguro
  return reply("Não entendi 😅\n\nMe diga o que você vende ou qual serviço você presta, e eu monto o anúncio.");
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
      return reply(await msgTrialOverAndPlans());
    }
  } else {
    // ACTIVE: checa validade do cartão (quando recorrência foi cancelada)
    const validUntil = await getCardValidUntil(id);
    if (validUntil && !isISODateInFutureOrToday(validUntil)) {
      const pm = await getPaymentMethod(id);
      if (pm === "CARD") {
        await setUserStatus(id, ST.WAIT_PLAN);
        return reply((await getCopyText("FLOW_QUOTA_BLOCKED", { waId: id })) + "\n\n" + (await msgPlansOnly()));
      }
    }

    // ACTIVE: checa quota do plano
    const planCode = await getUserPlan(id);
    const plan = (await getMenuPlans()).find((p) => p.code === planCode);
    if (!plan) {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply(await msgPlansOnly());
    }

    const used = await getUserQuotaUsed(id);
    if (used >= Number(plan.monthlyQuota || 0)) {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply("Você atingiu seu limite mensal 😅\n\n" + (await msgPlansOnly()));
    }
  }

  const mode = await getTemplateMode(id);

  // OpenAI
  let ad = "";
  try {
    const r = await generateAdText({ userText, mode });
    ad = r.text;
  } catch {
    return reply("Tive um probleminha técnico para gerar sua descrição agora 😕\n\nPode tentar novamente em alguns instantes?");
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

  return reply(ad + msgAfterAdAskTemplateChoice(mode));
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
