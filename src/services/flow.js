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
  getTemplatePrompted,
  setTemplatePrompted,
  getUserTrialUsed,
  incUserTrialUsed,
  getUserPlan,
  setUserPlan,
  getUserQuotaUsed,
  incUserQuotaUsed,
  setLastPrompt,
  clearLastPrompt,
  getLastAd,
  setLastAd,
  clearLastAd,
  getRefineCount,
  setRefineCount,
  incRefineCount,
  clearRefineCount,
  getPaymentMethod,
  setPaymentMethod,
  getUserDocMasked,
  setUserDocMasked,
  getBillingCityState,
  setBillingCityState,
  getBillingAddress,
  setBillingAddress,
  getAsaasCustomerId,
  setAsaasCustomerId,
  getAsaasSubscriptionId,
  setAsaasSubscriptionId,
  setMenuPrevStatus,
  getMenuPrevStatus,
  clearMenuPrevStatus,
  setPrevStatus,
  getPrevStatus,
  clearPrevStatus,
  getBizProfile,
  setBizProfile,
  clearBizProfile,
  getPendingBizProfile,
  setPendingBizProfile,
  clearPendingBizProfile,
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
  WAIT_BILLING_CITY_STATE: "WAIT_BILLING_CITY_STATE",
  WAIT_BILLING_ADDRESS: "WAIT_BILLING_ADDRESS",

  WAIT_MENU: "WAIT_MENU",
  WAIT_MENU_NEW_NAME: "WAIT_MENU_NEW_NAME",
  WAIT_MENU_NEW_DOC: "WAIT_MENU_NEW_DOC",
  WAIT_MENU_PROFILE: "WAIT_MENU_PROFILE",


  // Pós-anúncio
  WAIT_TEMPLATE_MODE: "WAIT_TEMPLATE_MODE",
  WAIT_SAVE_PROFILE: "WAIT_SAVE_PROFILE",

  // Wizard: adicionar/ajustar dados da empresa (manual)
  WAIT_PROFILE_ADD_COMPANY: "WAIT_PROFILE_ADD_COMPANY",
  WAIT_PROFILE_ADD_WHATSAPP: "WAIT_PROFILE_ADD_WHATSAPP",
  WAIT_PROFILE_ADD_ADDRESS: "WAIT_PROFILE_ADD_ADDRESS",
  WAIT_PROFILE_ADD_HOURS: "WAIT_PROFILE_ADD_HOURS",
  WAIT_PROFILE_ADD_SOCIAL: "WAIT_PROFILE_ADD_SOCIAL",
  WAIT_PROFILE_ADD_WEBSITE: "WAIT_PROFILE_ADD_WEBSITE",
  WAIT_PROFILE_ADD_PRODUCTS: "WAIT_PROFILE_ADD_PRODUCTS",
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

function wantsOkCommand(t) {
  const s = upper(t);
  return s === "OK" || s === "PRONTO" || s === "PROXIMO" || s === "PRÓXIMO";
}

function wantsSkipCommand(t) {
  const s = upper(t);
  return s === "PULAR" || s === "PULA" || s === "SKIP" || s === "0" || s === "-" || s === "NAO" || s === "NÃO";
}

function wantsFinishCommand(t) {
  const s = upper(t);
  return s === "FIM" || s === "FINALIZAR" || s === "PRONTO" || s === "CONCLUIR";
}

function normalizeUrlLike(t) {
  const s = cleanText(t);
  if (!s) return "";
  // aceita @instagram como atalho
  if (s.startsWith("@")) return "https://instagram.com/" + s.slice(1);
  return s;
}

function ensureArray(v) {
  return Array.isArray(v) ? v : [];
}


function normalizeMenuChoice(t) {
  const s = cleanText(t);
  // aceita "1", "1)", "1." etc
  const m = s.match(/^(\d{1,2})\s*[)\.\-:]?/);
  if (!m) return "";
  const n = String(m[1] || "").trim();
  // menu tem 1..11
  if (!n) return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  if (num < 1 || num > 11) return "";
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

function replyMulti(texts) {
  const arr = Array.isArray(texts) ? texts : [texts];
  const replies = arr.map((t) => String(t || "").trim()).filter(Boolean);
  return { shouldReply: true, replies, replyText: replies[0] || "" };
}

function normalizeNewlines(s) {
  return String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripOuterStars(s) {
  return String(s || "").replace(/^\*+/, "").replace(/\*+$/, "").trim();
}

function boldWrapSafe(s) {
  const core = stripOuterStars(s);
  if (!core) return "";
  return `*${core.replace(/\*/g, "").trim()}*`;
}


function enforceAdFormatting(adText) {
  const raw = normalizeNewlines(adText);
  const lines0 = raw.split("\n").map((l) => String(l || "").trimRight());

  // remove leading/trailing empty
  while (lines0.length && !String(lines0[0] || "").trim()) lines0.shift();
  while (lines0.length && !String(lines0[lines0.length - 1] || "").trim()) lines0.pop();

  let lines = [...lines0];

  // --------------------------
  // 1) Título (primeira linha)
  // - Evita duplicar asteriscos quando o GPT já colocou *...*
  // - Se houver emoji no começo, deixa o emoji fora do negrito
  // - Sempre insere uma linha em branco após o título
  // --------------------------
  if (lines.length > 0) {
    let titleLine = String(lines[0] || "").trim();

    // Se veio com "duplo wrap" (ex.: *🏢 *Título**), remove o wrap externo
    const starCount = (titleLine.match(/\*/g) || []).length;
    if (titleLine.startsWith("*") && titleLine.endsWith("*") && starCount > 2) {
      titleLine = titleLine.slice(1, -1).trim();
    }

    // Se o título já tem *...* dentro, mantemos — só limpamos asteriscos soltos no começo/fim
    titleLine = titleLine.replace(/^\*+/, "").replace(/\*+$/, "").trim();

    // Se o emoji estiver dentro do título, tenta separar
    let lead = "";
    let core = titleLine;

    const mEmoji = core.match(/^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?\s+)(.+)$/u);
    if (mEmoji) {
      lead = mEmoji[1];
      core = String(mEmoji[2] || "").trim();
    }

    // Se o core já estiver em negrito *...*, apenas garante que não há asteriscos "sobrando"
    const mBold = core.match(/^\*([^*]{1,120})\*$/);
    if (mBold) {
      core = mBold[1].trim();
    } else {
      // remove asteriscos internos soltos, para não quebrar
      core = core.replace(/\*/g, "").trim();
    }

    if (core) {
      lines[0] = `${lead}${boldWrapSafe(core)}`;
    } else {
      lines[0] = `${lead}${boldWrapSafe(titleLine)}`;
    }

    // linha em branco após o título
    if (lines.length > 1 && String(lines[1] || "").trim() !== "") {
      lines.splice(1, 0, "");
    }
  }

  // --------------------------
  // 2) Empresa em negrito (se houver) — sem bloquear por causa do título
  // --------------------------
  const companyPattern1 = /\b([AaOo])\s+([A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ][\wÀ-ÿ&\-\. ]{2,80}?)\s+é\b/;
  const companyPattern2 = /\b([A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ][\wÀ-ÿ&\-\. ]{2,80}?)\s+(é|oferece|atua|ajuda|entrega|faz)\b/;

  // aplica em linhas do corpo (ignora título e linhas vazias)
  for (let i = 1; i < lines.length; i++) {
    const line = String(lines[i] || "");
    if (!line.trim()) continue;

    // evita duplo negrito (ex.: já veio com *Nome*)
    if (line.includes("*")) continue;

    // não mexer em bullets (normalmente começam com emoji)
    if (/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(line.trim())) continue;

    // se já tem um *Nome* no começo, considera ok
    if (/^\*\s*[A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ]/.test(line.trim())) continue;

    let replaced = "";
    const m1 = line.match(companyPattern1);
    if (m1 && m1[2]) {
      const nm = String(m1[2]).trim();
      if (nm && !nm.includes("*")) {
        replaced = line.replace(companyPattern1, (all, art, name) => `${art} ${boldWrapSafe(String(name).trim())} é`);
      }
    }

    if (!replaced) {
      const m2 = line.match(companyPattern2);
      if (m2 && m2[1]) {
        const nm = String(m2[1]).trim();
        if (nm && !nm.includes("*")) {
          replaced = line.replace(companyPattern2, (all, name, verb) => `${boldWrapSafe(String(name).trim())} ${verb}`);
        }
      }
    }

    if (replaced && replaced !== line) {
      lines[i] = replaced;
      break; // aplica uma vez
    }
  }

  // --------------------------
  // 3) Preço em negrito (somente o preço)
  // --------------------------
  let text = lines.join("\n");
  text = text.replace(/R\$\s*\d[\d\.\s]*([,]\d{2})?/g, (m) => {
    const cleaned = m.replace(/\s+/g, " ").trim();
    if (!cleaned) return m;
    if (cleaned.includes("*")) return cleaned;
    return boldWrapSafe(cleaned);
  });

  // --------------------------
  // 4) Mais 2 destaques (sem exagero): bullets informativos
  // --------------------------
  let arr = text.split("\n").map((l) => String(l || "").trimRight());
  const infoEmojiRe = /^(🇧🇷|🕒|📍|🚚|📞|🌐|💬|✅)\s+/;
  let applied = 0;

  for (let i = 0; i < arr.length; i++) {
    if (applied >= 2) break;
    const line = String(arr[i] || "");
    if (!line.trim()) continue;

    const m = line.match(infoEmojiRe);
    if (!m) continue;

    // evita se já tiver negrito na linha
    if (line.includes("*")) continue;

    const emoji = m[1];
    const rest = line.replace(infoEmojiRe, "").trim();
    if (!rest) continue;

    arr[i] = `${emoji} ${boldWrapSafe(rest)}`;
    applied += 1;
  }

  // --------------------------
  // 5) Ordenação: CTA de avanço ("Envie...") antes de informações (🇧🇷/🕒/📍...)
  // --------------------------
  const isInfoLine = (l) => infoEmojiRe.test(String(l || "").trim());
  const isAdvanceCTA = (l) => {
    const s = String(l || "").trim().toLowerCase();
    return s.startsWith("envie ") || s.startsWith("mande ") || s.startsWith("me envie ") || s.startsWith("me mande ");
  };

  const infoBefore = [];
  let advanceIdx = -1;

  for (let i = 0; i < arr.length; i++) {
    const line = String(arr[i] || "");
    if (advanceIdx < 0 && isAdvanceCTA(line)) advanceIdx = i;
  }

  if (advanceIdx >= 0) {
    // coleta info lines que aparecem antes do CTA de avanço
    const kept = [];
    for (let i = 0; i < arr.length; i++) {
      const line = String(arr[i] || "");
      if (i < advanceIdx && isInfoLine(line)) {
        infoBefore.push(line);
        continue;
      }
      kept.push(line);
    }
    arr = kept;

    // recalcula advanceIdx após remoção
    advanceIdx = -1;
    for (let i = 0; i < arr.length; i++) {
      if (advanceIdx < 0 && isAdvanceCTA(arr[i])) advanceIdx = i;
    }

    if (infoBefore.length && advanceIdx >= 0) {
      // garante uma linha em branco após o CTA
      const insertAt = advanceIdx + 1;
      if (arr[insertAt] !== "") arr.splice(insertAt, 0, "");

      // insere infos logo abaixo do CTA
      arr.splice(insertAt + 1, 0, ...infoBefore);

      // garante uma linha em branco antes do CTA final (se houver)
      // (CTA final normalmente começa com "Converse", "Chame", "Fale")
      for (let i = arr.length - 1; i >= 0; i--) {
        const s = String(arr[i] || "").trim().toLowerCase();
        if (!s) continue;
        if (s.startsWith("converse") || s.startsWith("chame") || s.startsWith("fale") || s.startsWith("me chame")) {
          if (i - 1 >= 0 && arr[i - 1] !== "") arr.splice(i, 0, "");
          break;
        }
      }
    }
  }

  // --------------------------
  // 6) Sempre pular uma linha entre os dois CTAs finais (se estiverem colados)
  // --------------------------
  const nonEmptyIdx = [];
  for (let i = 0; i < arr.length; i++) {
    if (String(arr[i] || "").trim()) nonEmptyIdx.push(i);
  }
  if (nonEmptyIdx.length >= 2) {
    const a = nonEmptyIdx[nonEmptyIdx.length - 2];
    const b = nonEmptyIdx[nonEmptyIdx.length - 1];
    if (b === a + 1) {
      arr.splice(b, 0, "");
    }
  }

  return arr.join("\n").trim().replace(/\*{2,}/g, "*");
}

function extractBizProfileFromText(text) {
  const raw = normalizeNewlines(text);
  // Para detectar dados, usamos uma versão "plain" (sem *), porque o formatter aplica negrito.
  const plain = raw.replace(/\*/g, "");
  const profile = {};

  // Nome da empresa (heurística robusta)
  // Ex.: "A Simetria Group é ..." | "O X é ..." | "*Simetria Group* é ..."
  const companyRe = /\b([AaOo])\s+([A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ][\wÀ-ÿ&\-\. ]{2,80}?)\s+é\b/;
  const m1 = plain.match(companyRe);
  if (m1 && m1[2]) profile.companyName = String(m1[2]).trim();

  // Alternativa: "Somos a X" / "Aqui é a X"
  if (!profile.companyName) {
    const altRe = /\b(somos|aqui\s+é|eu\s+sou)\s+(a|o)\s+([A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ][\wÀ-ÿ&\-\. ]{2,80}?)(\b|\.|,)/i;
    const m2 = plain.match(altRe);
    if (m2 && m2[3]) profile.companyName = String(m2[3]).trim();
  }

  // Atendimento (linha com "Atendimento")
  const attLine = plain
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /atendimento/i.test(l));
  if (attLine) profile.serviceArea = attLine;

  // Horário (heurística)
  const hoursRe =
    /(\bSeg\b.*\bSex\b.*\d{1,2}h\s*[–\-]\s*\d{1,2}h)|(\d{1,2}:\d{2}\s*[–\-]\s*\d{1,2}:\d{2})/i;
  const hm = plain.match(hoursRe);
  if (hm) profile.hours = String(hm[0]).trim();

  // Local (linha com 📍)
  const loc = plain
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("📍"));
  if (loc) profile.location = loc.replace(/^📍\s*/, "").trim();

  // WhatsApp (se houver)
  const wa = plain.match(/\+?55\s*\(?\d{2}\)?\s*\d{4,5}[\-\s]?\d{4}/);
  if (wa) profile.whatsapp = String(wa[0]).replace(/\s+/g, " ").trim();

  // Fallback: se não detectou nome, tenta pegar o 1º trecho em negrito no corpo
  if (!profile.companyName) {
    const rawBold = raw.match(/\*([^*]{2,80})\*\s+(é|oferece|atua|ajuda|entrega|faz)\b/i);
    if (rawBold && rawBold[1]) profile.companyName = String(rawBold[1]).trim();
  }

  // remove vazios
  for (const k of Object.keys(profile)) {
    if (!String(profile[k] || "").trim()) delete profile[k];
  }
  if (Object.keys(profile).length === 0) return null;
  return profile;
}




function firstNameFromFullName(fullName) {
  const s = cleanText(fullName);
  if (!s) return "";
  const parts = s.split(/\s+/).filter(Boolean);
  return parts.length ? parts[0] : "";
}

// -------------------- Copy / Mensagens --------------------
async function msgAskName(waId){
  return await getCopyText("FLOW_ASK_NAME", { waId });
}

async function msgAskProduct(waId){
  const fullName = await getUserFullName(waId);
  const firstName = firstNameFromFullName(fullName);
  return await getCopyText("FLOW_ASK_PRODUCT", { waId, vars: { firstName } });
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

async function msgAskBillingCityState(waId){
  return "Perfeito! ✅ Agora preciso só de mais 2 informações para emitir sua cobrança.\n\n📍 Qual é sua *Cidade/UF*? (ex: Atibaia/SP)";
}

async function msgAskBillingAddress(waId){
  return "Ótimo! ✅ Agora me diga seu *endereço* (rua, número, bairro).\n\nSe for apenas atendimento online, responda: *APENAS ONLINE*";
}


async function msgAfterAdAskTemplateChoice(waId, currentMode){
  return await getCopyText("FLOW_ASK_TEMPLATE_CHOICE", { waId });
}

async function msgTemplateSet(waId, mode){
  if (mode === "FREE") {
    return `Perfeito! ✅ Vou deixar como padrão a formatação *LIVRE*.

Quando quiser voltar para o modelo FIXO, digite *TEMPLATE*.
E a qualquer momento você pode digitar *MENU* para ajustar.`;
  }
  return `Perfeito! ✅ Vou deixar como padrão o modelo *FIXO (Template)*.

Quando quiser mudar para livre, digite *LIVRE*.
E a qualquer momento você pode digitar *MENU* para ajustar.`;
}


function renderProfileForConfirmation(profile) {
  const lines = [];
  if (profile.companyName) lines.push(`• Empresa: ${boldWrapSafe(profile.companyName)}`);
  if (profile.serviceArea) lines.push(`• ${profile.serviceArea}`);
  if (profile.hours) lines.push(`• Horário: ${profile.hours}`);
  if (profile.location) lines.push(`• Local: ${profile.location}`);
  if (profile.whatsapp) lines.push(`• WhatsApp: ${profile.whatsapp}`);
  return lines;
}

async function msgAskSaveProfile(waId, profile) {
  const lines = [];
  lines.push(await getCopyText("FLOW_SAVE_PROFILE_INTRO", { waId }));
  lines.push(await getCopyText("FLOW_SAVE_PROFILE_ASK", { waId }));
  lines.push("");
  const items = renderProfileForConfirmation(profile);
  if (items.length) {
    lines.push(await getCopyText("FLOW_SAVE_PROFILE_WILL_SAVE", { waId }));
    lines.push(...items);
    lines.push("");
  }
  lines.push(await getCopyText("FLOW_SAVE_PROFILE_OPT_YES", { waId }));
  lines.push(await getCopyText("FLOW_SAVE_PROFILE_OPT_NO", { waId }));
  lines.push(await getCopyText("FLOW_SAVE_PROFILE_OPT_ADD", { waId }));
  lines.push("");
  lines.push(await getCopyText("FLOW_SAVE_PROFILE_BENEFIT", { waId }));
  return lines.join("\n");
}

async function msgAfterSaveProfile(waId, saved, maxRefinements) {
  const lines = [];
  lines.push(
    saved
      ? await getCopyText("FLOW_SAVE_PROFILE_SAVED_CONFIRM", { waId })
      : await getCopyText("FLOW_SAVE_PROFILE_NOT_SAVED_CONFIRM", { waId })
  );
  lines.push("");
  lines.push(await getCopyText("FLOW_AFTER_SAVE_PROFILE_QUESTION", { waId }));
  lines.push(await getCopyText("FLOW_AFTER_SAVE_PROFILE_REFINE_HINT", { waId, vars: { maxRefinements } }));
  lines.push(await getCopyText("FLOW_AFTER_SAVE_PROFILE_OK_HINT", { waId }));
  return lines.join("\n");
}

async function msgMenuMain(waId) {
  return await getCopyText("FLOW_MENU_MAIN", { waId });
}

async function msgMenuProfileView(waId) {
  const biz = await getBizProfile(waId);
  const lines = [];
  lines.push(await getCopyText("FLOW_MENU_PROFILE_VIEW_TITLE", { waId }));
  lines.push("");

  if (!biz || typeof biz !== "object" || Object.keys(biz).length === 0) {
    lines.push(await getCopyText("FLOW_MENU_PROFILE_EMPTY", { waId }));
  } else {
    // Mostra o que está salvo (visualização)
    const get = (k) => {
      const v = biz?.[k];
      if (v === undefined || v === null) return "";
      if (Array.isArray(v)) return v.filter(Boolean).join(", ");
      return String(v || "").trim();
    };

    const companyName = get("companyName");
    const whatsapp = get("whatsapp");
    const address = get("address");
    const hours = get("hours");
    const socials = get("socials");
    const website = get("website");
    const productsUrl = get("productsUrl");

    if (companyName) lines.push(`🏢 Nome: ${companyName}`);
    if (whatsapp) lines.push(`📲 WhatsApp: ${whatsapp}`);
    if (address) lines.push(`📍 Endereço: ${address}`);
    if (hours) lines.push(`🕒 Horário: ${hours}`);
    if (socials) lines.push(`📱 Redes: ${socials}`);
    if (website) lines.push(`🌐 Site: ${website}`);
    if (productsUrl) lines.push(`🛍️ Catálogo: ${productsUrl}`);

    if (lines.length === 2) {
      // só título e linha em branco
      lines.push(await getCopyText("FLOW_MENU_PROFILE_EMPTY", { waId }));
    }
  }

  lines.push("");
  lines.push(await getCopyText("FLOW_MENU_PROFILE_ACTIONS", { waId }));
  return lines.join("\n");
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
  const status = await getUserStatus(waId);

  // TRIAL: mostra como plano Trial (5 grátis) mesmo sem user:plan
  const planCodeForTrialCheck = await getUserPlan(waId);
  if (
    status === ST.TRIAL ||
    status === ST.WAIT_NAME ||
    status === ST.WAIT_PRODUCT ||
    status === ST.WAIT_MENU ||
    status === ST.WAIT_TEMPLATE_MODE ||
    status === ST.WAIT_SAVE_PROFILE
  ) {
    // Se ainda não há plano pago associado, tratamos como Trial para a tela de assinatura
    if (!planCodeForTrialCheck) {
      const usedTrial = await getUserTrialUsed(waId);
      const base = [
        "*Minha assinatura*",
        "",
        "📦 Plano: Trial",
        `📊 Uso no mês: ${usedTrial} / ${TRIAL_LIMIT}`,
        "📅 Renovação (Cartão): — — faltam — dia(s)",
        "",
        "Instagram: https://www.instagram.com/amigo.das.vendas/",
      ].join("\n");
      return base;
    }
    // Se houver plano pago associado mesmo em estados iniciais, seguimos com o fluxo de plano pago abaixo.
  }

  const planCode = await getUserPlan(waId);

  // ✅ ACTIVE sem plano: instruir usuário a regularizar
  if (status === ST.ACTIVE && !planCode) {
    return await getCopyText("FLOW_ACTIVE_NO_PLAN_ERROR", { waId });
  }

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

  // ✅ Regra de consistência: usuário só pode estar ACTIVE com plano pago associado.
  // Se por qualquer motivo estiver ACTIVE sem plano, rebaixamos para TRIAL automaticamente.
  const _st0 = await getUserStatus(id);
  const _pl0 = await getUserPlan(id);
  if (_st0 === ST.ACTIVE && !_pl0) {
    await setUserStatus(id, ST.TRIAL);
  }


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

  // ✅ Segurança: ACTIVE sem plano nunca pode continuar
  if (status === ST.ACTIVE) {
    const planCode = await getUserPlan(id);
    if (!planCode) {
      return reply(await getCopyText("FLOW_ACTIVE_NO_PLAN_ERROR", { waId: id }));
    }
  }


  // ✅ Primeiro contato (ou usuário sem nome): sempre pedir nome antes de seguir no fluxo.
  // Mantém comandos globais (TEMPLATE/LIVRE/MENU) funcionando acima.
  const __name = await getUserFullName(id);
  if (!__name && status !== ST.WAIT_NAME && status !== ST.WAIT_MENU_NEW_NAME && status !== ST.WAIT_MENU_NEW_DOC) {
    await setUserStatus(id, ST.WAIT_NAME);
    return reply(await msgAskName(id));
  }

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

    // opção 11: Dados da empresa (ver/atualizar)
    if (choice === "11") {
      await setUserStatus(id, ST.WAIT_MENU_PROFILE);
      return reply(await msgMenuProfileView(id));
    }

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
    return reply(`${await getCopyText("FLOW_MENU_NAME_UPDATED", { waId: id })}\n\n${await msgMenuMain(id)}`);
  }

  // 0.2) MENU — alteração de CPF/CNPJ
  if (status === ST.WAIT_MENU_NEW_DOC) {
    const v = validateDoc(inbound);
    if (!v.ok) return reply(await msgInvalidDoc(id));

    await setUserDocMasked(id, v.type, v.last4);

    // volta ao menu
    await setUserStatus(id, ST.WAIT_MENU);
    return reply(`${await getCopyText("FLOW_MENU_DOC_UPDATED", { waId: id })}\n\n${await msgMenuMain(id)}`);
  }


  
  
  // 0.25) MENU — Dados da empresa (visualizar/atualizar)
  if (status === ST.WAIT_MENU_PROFILE) {
    const c = normalizeChoice(inbound);

    if (c !== "1" && c !== "2" && c !== "3") {
      return reply(await getCopyText("FLOW_MENU_PROFILE_INVALID_CHOICE", { waId: id }));
    }

    // 1) Atualizar/Completar (abre wizard)
    if (c === "1") {
      const current = await getBizProfile(id);
      // Wizard trabalha em cima de um "pending" para só salvar no fim
      await setPendingBizProfile(id, (current && typeof current === "object") ? current : {});
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_COMPANY);
      return reply(await getCopyText("FLOW_PROFILE_WIZARD_INTRO", { waId: id }));
    }

    // 2) Limpar dados
    if (c === "2") {
      await clearBizProfile(id);
      await clearPendingBizProfile(id);
      await setUserStatus(id, ST.WAIT_MENU);
      return reply(`${await getCopyText("FLOW_MENU_PROFILE_CLEARED", { waId: id })}\n\n${await msgMenuMain(id)}`);
    }

    // 3) Voltar
    await setUserStatus(id, ST.WAIT_MENU);
    return reply(await msgMenuMain(id));
  }

// 0.3) Pós-anúncio — escolha de template (1/2)
  if (status === ST.WAIT_TEMPLATE_MODE) {
    const c = normalizeChoice(inbound);

    // se não for escolha válida, volta ao status anterior e reprocessa (pode ser um refinamento direto)
    if (c !== "1" && c !== "2") {
      const prev = await getPrevStatus(id);
      await clearPrevStatus(id);
      if (prev && prev !== ST.WAIT_TEMPLATE_MODE) {
        await setUserStatus(id, prev);
      } else {
        await setUserStatus(id, ST.WAIT_PRODUCT);
      }
      return await handleInboundText({ waId: id, text: inbound });
    }

    const mode = c === "2" ? "FREE" : "FIXED";
    await setTemplateMode(id, mode);
    await setTemplatePrompted(id, true);

    // prepara sugestão de perfil (se houver dados)
    const ad = await getLastAd(id);
    const suggestion = extractBizProfileFromText(ad);
    if (suggestion) {
      await setPendingBizProfile(id, suggestion);
      await setUserStatus(id, ST.WAIT_SAVE_PROFILE);
      return replyMulti([await msgTemplateSet(id, mode), await msgAskSaveProfile(id, suggestion)]);
    }

    // sem dados detectados: volta ao status anterior e encerra
    const prev = await getPrevStatus(id);
    await clearPrevStatus(id);
    if (prev && prev !== ST.WAIT_TEMPLATE_MODE) await setUserStatus(id, prev);
    else await setUserStatus(id, ST.WAIT_PRODUCT);

    const maxRef = await resolveMaxRefinementsForUser(id, prev === ST.ACTIVE ? false : true);
    return replyMulti([await msgTemplateSet(id, mode), await msgAfterSaveProfile(id, false, maxRef)]);
  }

  // 0.4) Pós-anúncio — salvar perfil (1/2/3)
  if (status === ST.WAIT_SAVE_PROFILE) {
    const c = normalizeChoice(inbound);

    // Opção 3: wizard para complementar/cadastrar dados manualmente
    if (c === "3") {
      // usa a sugestão pendente como ponto de partida (se existir)
      const pending = (await getPendingBizProfile(id)) || {};
      await setPendingBizProfile(id, pending);
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_COMPANY);

      const msg = [
        await getCopyText("FLOW_PROFILE_WIZARD_INTRO", { waId: id }),
        "",
        await getCopyText("FLOW_PROFILE_WIZARD_STEP1_COMPANY", { waId: id }),
      ].join("\n");
      return reply(msg);
    }

    // se não for escolha válida, volta ao status anterior e reprocessa (pode ser refinamento)
    if (c !== "1" && c !== "2") {
      const prev = await getPrevStatus(id);
      await clearPrevStatus(id);
      await clearPendingBizProfile(id);
      if (prev && prev !== ST.WAIT_SAVE_PROFILE) {
        await setUserStatus(id, prev);
      } else {
        await setUserStatus(id, ST.WAIT_PRODUCT);
      }
      return await handleInboundText({ waId: id, text: inbound });
    }

    let saved = false;
    if (c === "1") {
      const pending = await getPendingBizProfile(id);
      if (pending) {
        await setBizProfile(id, pending);
        saved = true;
      }
    }

    await clearPendingBizProfile(id);

    const prev = await getPrevStatus(id);
    await clearPrevStatus(id);
    if (prev && prev !== ST.WAIT_SAVE_PROFILE) await setUserStatus(id, prev);
    else await setUserStatus(id, ST.WAIT_PRODUCT);

    const isTrialNow = prev !== ST.ACTIVE;
    const maxRef = await resolveMaxRefinementsForUser(id, isTrialNow);
    return replyMulti([await msgAfterSaveProfile(id, saved, maxRef)]);
  }


  // 0.5) Wizard — adicionar/ajustar dados da empresa (manual)
  if (
    status === ST.WAIT_PROFILE_ADD_COMPANY ||
    status === ST.WAIT_PROFILE_ADD_WHATSAPP ||
    status === ST.WAIT_PROFILE_ADD_ADDRESS ||
    status === ST.WAIT_PROFILE_ADD_HOURS ||
    status === ST.WAIT_PROFILE_ADD_SOCIAL ||
    status === ST.WAIT_PROFILE_ADD_WEBSITE ||
    status === ST.WAIT_PROFILE_ADD_PRODUCTS
  ) {
    const pending = (await getPendingBizProfile(id)) || {};
    const profile = pending && typeof pending === "object" ? pending : {};

    // Etapa 1: nome da empresa
    if (status === ST.WAIT_PROFILE_ADD_COMPANY) {
      if (!wantsSkipCommand(inbound)) {
        const name = cleanText(inbound);
        if (name.length >= 2) profile.companyName = name;
      }
      await setPendingBizProfile(id, profile);
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_WHATSAPP);
      return reply(await getCopyText("FLOW_PROFILE_WIZARD_STEP2_WHATSAPP", { waId: id }));
    }

    // Etapa 2: whatsapp
    if (status === ST.WAIT_PROFILE_ADD_WHATSAPP) {
      if (!wantsSkipCommand(inbound)) {
        const wa = cleanText(inbound);
        if (wa.length >= 8) profile.whatsapp = wa;
      }
      await setPendingBizProfile(id, profile);
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_ADDRESS);
      return reply(await getCopyText("FLOW_PROFILE_WIZARD_STEP3_ADDRESS", { waId: id }));
    }

    // Etapa 3: endereço/local
    if (status === ST.WAIT_PROFILE_ADD_ADDRESS) {
      if (!wantsSkipCommand(inbound)) {
        const s = cleanText(inbound);
        if (upper(s) === "APENAS ATENDIMENTO ONLINE") {
          profile.location = "Apenas atendimento online";
        } else if (s.length >= 2) {
          profile.location = s;
        }
      }
      await setPendingBizProfile(id, profile);
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_HOURS);
      return reply(await getCopyText("FLOW_PROFILE_WIZARD_STEP4_HOURS", { waId: id }));
    }

    // Etapa 4: horário
    if (status === ST.WAIT_PROFILE_ADD_HOURS) {
      if (!wantsSkipCommand(inbound)) {
        const s = cleanText(inbound);
        if (s.length >= 2) profile.hours = s;
      }
      await setPendingBizProfile(id, profile);
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_SOCIAL);
      return reply(await getCopyText("FLOW_PROFILE_WIZARD_STEP5_SOCIAL", { waId: id }));
    }

    // Etapa 5: redes sociais (loop)
    if (status === ST.WAIT_PROFILE_ADD_SOCIAL) {
      if (wantsSkipCommand(inbound) || wantsFinishCommand(inbound)) {
        await setPendingBizProfile(id, profile);
        await setUserStatus(id, ST.WAIT_PROFILE_ADD_WEBSITE);
        return reply(await getCopyText("FLOW_PROFILE_WIZARD_STEP6_WEBSITE", { waId: id }));
      }

      const url = normalizeUrlLike(inbound);
      if (url) {
        const arr = ensureArray(profile.socials);
        arr.push(url);
        // dedupe simples
        profile.socials = Array.from(new Set(arr.map((x) => String(x).trim()).filter(Boolean)));
        await setPendingBizProfile(id, profile);
        return reply(await getCopyText("FLOW_PROFILE_WIZARD_SOCIAL_ADDED", { waId: id }));
      }

      return reply(await getCopyText("FLOW_PROFILE_WIZARD_SOCIAL_INVALID", { waId: id }));
    }

    // Etapa 6: website
    if (status === ST.WAIT_PROFILE_ADD_WEBSITE) {
      if (!wantsSkipCommand(inbound)) {
        const url = normalizeUrlLike(inbound);
        if (url) profile.website = url;
      }
      await setPendingBizProfile(id, profile);
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_PRODUCTS);
      return reply(await getCopyText("FLOW_PROFILE_WIZARD_STEP7_PRODUCTS", { waId: id }));
    }

    // Etapa 7: lista de produtos
    if (status === ST.WAIT_PROFILE_ADD_PRODUCTS) {
      if (!wantsSkipCommand(inbound)) {
        const url = normalizeUrlLike(inbound);
        if (url) profile.productList = url;
      }

      // salva direto (o usuário escolheu "Adicionar dados")
      await setBizProfile(id, profile);
      await clearPendingBizProfile(id);

      const prev = await getPrevStatus(id);
      await clearPrevStatus(id);
      if (prev && prev !== ST.WAIT_SAVE_PROFILE) await setUserStatus(id, prev);
      else await setUserStatus(id, ST.WAIT_PRODUCT);

      const isTrialNow = prev !== ST.ACTIVE;
      const maxRef = await resolveMaxRefinementsForUser(id, isTrialNow);
      return replyMulti([await msgAfterSaveProfile(id, true, maxRef)]);
    }
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
    return await handleGenerateAdInTrialOrActive({ waId: id, inboundText: inbound, isTrial: true, currentStatus: status });
  }

  // 3) Trial
  if (status === ST.TRIAL) {
    if (isGreeting(inbound)) return reply(await msgAskProduct(id));
    return await handleGenerateAdInTrialOrActive({ waId: id, inboundText: inbound, isTrial: true, currentStatus: status });
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
    if (c !== "1" && c !== "2") return reply(await getCopyText("FLOW_INVALID_PAYMENT_METHOD", { waId: id }));

    const pm = c === "1" ? "CARD" : "PIX";
    await setPaymentMethod(id, pm);
    await setUserStatus(id, ST.WAIT_DOC);

    return reply(await msgAskDoc(id));
  }

  // 6) Documento (CPF/CNPJ) + prepara cobrança (coleta dados fiscais antes de emitir)
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

    // customer (CPF/CNPJ só é usado aqui; nunca persistimos o número completo)
    await ensureAsaasCustomer({ waId: id, fullName: await getUserFullName(id), cpfCnpj: v.digits });

    // Coletar Cidade/UF e Endereço antes de emitir cobrança/assinatura
    await setUserStatus(id, ST.WAIT_BILLING_CITY_STATE);
    return reply(await msgAskBillingCityState(id));
  }

  // 6.1) Cidade/UF (para emissão da cobrança)
  if (status === ST.WAIT_BILLING_CITY_STATE) {
    const v = String(inbound || "").trim();
    if (!v) return reply(await msgAskBillingCityState(id));

    await setBillingCityState(id, v);
    await setUserStatus(id, ST.WAIT_BILLING_ADDRESS);
    return reply(await msgAskBillingAddress(id));
  }

  // 6.2) Endereço (para emissão da cobrança) + cria cobrança/assinatura
  if (status === ST.WAIT_BILLING_ADDRESS) {
    const v = String(inbound || "").trim();
    if (!v) return reply(await msgAskBillingAddress(id));

    const addr = v.toUpperCase() === "APENAS ONLINE" ? "APENAS ONLINE" : v;
    await setBillingAddress(id, addr);

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

    const customerId = await getAsaasCustomerId(id);
    if (!customerId) {
      // estado inconsistente: força reentrada no fluxo de documento (único ponto onde temos CPF/CNPJ)
      await setUserStatus(id, ST.WAIT_DOC);
      return reply(await msgAskDoc(id));
    }

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
      const line1 = "✅ Pronto! Gerei sua cobrança via *PIX*.

";
      const line2 = url ? `Pague por aqui: ${url}

` : "Pague pelo link dentro do Asaas.

";
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
    const line1 = "✅ Pronto! Agora é só concluir no *Cartão* (assinatura).

";
    const line2 = url ? `Finalize por aqui: ${url}

` : "Finalize pelo link no Asaas.

";
    const line3 = "Assim que confirmar, seu plano ativa automaticamente. 🚀";
    return reply(line1 + line2 + line3);
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
    if (wantsOkCommand(inbound)) {
      await clearLastAd(id);
      await clearRefineCount(id);
      await clearLastPrompt(id);
      return reply(await getCopyText("FLOW_OK_NEXT_DESCRIPTION", { waId: id }));
    }
    if (isGreeting(inbound)) return reply(await msgAskProduct(id));
    return await handleGenerateAdInTrialOrActive({ waId: id, inboundText: inbound, isTrial: false, currentStatus: status });
  }

  // fallback seguro
  return reply(await getCopyText("FLOW_FALLBACK_UNKNOWN", { waId: id }));
}

async function resolveMaxRefinementsForUser(waId, isTrial) {
  const DEFAULT_MAX_REFINEMENTS = 2;
  if (isTrial) return DEFAULT_MAX_REFINEMENTS;

  let maxRefinements = DEFAULT_MAX_REFINEMENTS;
  const planCode = await getUserPlan(waId);
  const plan = (await getMenuPlans()).find((p) => p.code === planCode);
  const fromPlan = Number(plan?.maxRefinements);
  if (Number.isFinite(fromPlan) && fromPlan >= 0) maxRefinements = Math.trunc(fromPlan);
  return maxRefinements;
}

// -------------------- Generate Ad --------------------
async function handleGenerateAdInTrialOrActive({ waId, inboundText, isTrial, currentStatus }) {
  const id = waId;
  const userText = inboundText;

  const lastAd = await getLastAd(id);
  const isRefinement = !!lastAd;

  // Regra de consumo (refinamentos):
  // - 1 descrição inicial sempre consome 1 crédito
  // - Refinamentos "grátis" por descrição = maxRefinements do plano
  // - Ao ultrapassar o limite, consome +1 crédito e reinicia o ciclo (refineCount volta para 1)
  //   Ex.: maxRefinements=2 => consome no refinamento 3,5,7...

  const maxRefinements = await resolveMaxRefinementsForUser(id, isTrial);


  const currentRefines = isRefinement ? await getRefineCount(id) : 0; // refinamentos na "rodada" atual
  const attemptedNext = isRefinement ? (currentRefines + 1) : 0;

  const willConsumeExtraCredit = isRefinement && attemptedNext > maxRefinements;
  const nextRefines = isRefinement ? (willConsumeExtraCredit ? 1 : attemptedNext) : 0;

  const creditsNeeded = isRefinement ? (willConsumeExtraCredit ? 1 : 0) : 1;


  // TRIAL: checa limite (considera refinamentos que não consomem crédito)
  if (isTrial) {
    const used = await getUserTrialUsed(id);
    if (creditsNeeded > 0 && used >= TRIAL_LIMIT) {
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
      return reply(`${await getCopyText("FLOW_QUOTA_REACHED_PREFIX", { waId: id })}\n\n${await msgPlansOnly()}`);
    }
  }

  const mode = await getTemplateMode(id);

  // OpenAI
  let ad = "";
  try {
    let promptToSend = isRefinement
      ? `ANUNCIO_ATUAL:\n${lastAd}\n\nAJUSTES_SOLICITADOS:\n${userText}`
      : userText;

    // Se já temos um perfil salvo da empresa, envia como contexto (sem obrigar o usuário a repetir)
    if (!isRefinement) {
      const prof = await getBizProfile(id);
      if (prof && typeof prof === "object") {
        const parts = [];
        if (prof.companyName) parts.push(`Empresa: ${prof.companyName}`);
        if (prof.serviceArea) parts.push(`Atendimento: ${prof.serviceArea}`);
        if (prof.location) parts.push(`Local: ${prof.location}`);
        if (prof.hours) parts.push(`Horário: ${prof.hours}`);
        if (prof.whatsapp) parts.push(`WhatsApp: ${prof.whatsapp}`);
        if (prof.website) parts.push(`Site: ${prof.website}`);
        if (prof.productList) parts.push(`Catálogo/Lista: ${prof.productList}`);
        if (Array.isArray(prof.socials) && prof.socials.length) parts.push(`Redes: ${prof.socials.join(' | ')}`);
        if (parts.length) {
          promptToSend = `CONTEXTO_DA_EMPRESA (use somente se ajudar; não é obrigatório repetir literalmente):\n${parts.join("\n")}\n\nDESCRIÇÃO_DO_USUÁRIO:\n${userText}`;
        }
      }
    }

    const r = await generateAdText({ userText: promptToSend, mode });
    ad = r.text;
  } catch {
    return reply(await getCopyText("FLOW_OPENAI_ERROR", { waId: id }));
  }

  // salva prompt (último texto do usuário)
  await setLastPrompt(id, userText);

  // salva o último anúncio para refinamentos
  await setLastAd(id, ad);

  // controla contagem de refinamentos e consumo de créditos
  if (isRefinement) {
    await setRefineCount(id, nextRefines);
  } else {
    await clearRefineCount(id);
  }

  // conta uso apenas quando há consumo de crédito
  if (creditsNeeded > 0) {
    if (isTrial) await incUserTrialUsed(id, creditsNeeded);
    else await incUserQuotaUsed(id, creditsNeeded);

    // métricas globais + por usuário (best-effort; não pode quebrar produção)
    try {
      await incDescriptionMetrics(id, creditsNeeded);
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
  }

  const formattedAd = enforceAdFormatting(ad);

  // Pós-anúncio:
  // - A escolha FIXO/LIVRE aparece apenas na 1ª descrição (templatePrompted = false)
  // - Depois disso, seguimos direto para a mensagem curta de refinamento
  const alreadyPrompted = await getTemplatePrompted(id);

  if (!alreadyPrompted) {
    await setPrevStatus(id, currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE));
    await setUserStatus(id, ST.WAIT_TEMPLATE_MODE);
    return replyMulti([formattedAd, await msgAfterAdAskTemplateChoice(id, mode)]);
  }

  // Mantém o status atual e apenas orienta refinamentos
  const refineMsg = await getCopyText("FLOW_REFINE_PROMPT_SHORT", { waId: id });
  return replyMulti([formattedAd, refineMsg]);
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
