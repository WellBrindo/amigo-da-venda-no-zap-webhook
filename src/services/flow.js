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
  setMenuEditContext,
  getMenuEditContext,
  clearMenuEditContext,
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
  getCurrentAdSession,
  setCurrentAdSession,
  clearCurrentAdSession,
} from "./state.js";

import { getMenuPlans, getPlan, getPlanByChoice, renderPlansMenu } from "./Plans.js";
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
  WAIT_MENU_SUBSCRIPTION: "WAIT_MENU_SUBSCRIPTION",
  WAIT_MENU_EDIT_ROOT: "WAIT_MENU_EDIT_ROOT",
  WAIT_MENU_EDIT_PERSONAL: "WAIT_MENU_EDIT_PERSONAL",
  WAIT_MENU_EDIT_COMPANY: "WAIT_MENU_EDIT_COMPANY",
  WAIT_MENU_EDIT_FLOW: "WAIT_MENU_EDIT_FLOW",
  WAIT_MENU_EDIT_FIELD: "WAIT_MENU_EDIT_FIELD",
  WAIT_MENU_NEW_NAME: "WAIT_MENU_NEW_NAME",
  WAIT_MENU_NEW_DOC: "WAIT_MENU_NEW_DOC",
  WAIT_MENU_PROFILE: "WAIT_MENU_PROFILE",


  // Pós-anúncio
  WAIT_TEMPLATE_MODE: "WAIT_TEMPLATE_MODE",
  WAIT_SAVE_PROFILE: "WAIT_SAVE_PROFILE",
  WAIT_CATEGORY_DETAILS: "WAIT_CATEGORY_DETAILS",

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

function normalizeChoiceMax(t, max = 9) {
  const s = cleanText(t);
  const m = s.match(/^(\d{1,2})\b/);
  if (!m) return "";
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < 1 || n > Number(max || 9)) return "";
  return String(n);
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

function wantsChangePaymentMethodCommand(t) {
  const s = upper(t);
  return s === "2" || s.includes("MUDAR FORMA") || s.includes("TROCAR FORMA") || s.includes("ALTERAR FORMA") || s.includes("MUDAR PAGAMENTO");
}

function withMenuHint(text) {
  const msg = String(text || "").trim();
  if (!msg) return "";
  if (/\bMENU\b/i.test(msg)) return msg;
  return `${msg}

A qualquer momento, você pode digitar *MENU* para acessar as opções de configuração.`;
}

function menuDisplayValue(value, fallback = "Não informado") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function docMenuPreview(doc) {
  if (!doc || !doc.docType) return "CPF/CNPJ (não informado)";
  return `${doc.docType} (cadastrado)`;
}

function socialPreviewList(socials) {
  return ensureArray(socials)
    .map((item) => normalizeUrlLike(String(item || "").trim()))
    .filter(Boolean);
}

function splitSocialInputs(value) {
  return String(value || "")
    .split(/[\n,;]+/)
    .map((item) => normalizeUrlLike(String(item || "").trim()))
    .filter(Boolean);
}

function formatPaymentMethodLabel(method) {
  return method === "CARD" ? "Cartão" : method === "PIX" ? "PIX" : "Não definido";
}

function wantsFinishCommand(t) {
  const s = upper(t);
  return s === "FIM" || s === "FINALIZAR" || s === "PRONTO" || s === "CONCLUIR";
}

function normalizeUrlLike(t) {
  let s = cleanText(t);
  if (!s) return "";

  if (s.startsWith("@")) {
    s = "instagram.com/" + s.slice(1);
  }

  s = s.replace(/\s+/g, "");
  s = s
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

  if (/^www\./i.test(s)) s = `https://${s}`;
  return s;
}

function normalizeWhatsappLike(t) {
  const raw = cleanText(t);
  if (!raw) return "";

  const digits = raw.replace(/\D+/g, "");
  if (digits.length >= 10) {
    let local = digits;
    if ((local.length === 12 || local.length === 13) && local.startsWith("55")) {
      local = local.slice(2);
    }
    if (local.length > 11) local = local.slice(-11);

    if (local.length === 11) {
      return `${local.slice(0, 2)} ${local.slice(2, 7)}-${local.slice(7)}`;
    }
    if (local.length === 10) {
      return `${local.slice(0, 2)} ${local.slice(2, 6)}-${local.slice(6)}`;
    }
  }

  return raw.replace(/\*/g, "-").trim();
}

function normalizeBusinessVoice(adText, bizProfile) {
  const companyName = normalizeProfileScalar(bizProfile?.companyName);
  if (!companyName) return String(adText || "");

  return String(adText || "")
    .replace(/^Sou\s+/im, "Somos ")
    .replace(/^Atendo\s+/im, "Atendemos ")
    .replace(/^Faço\s+/im, "Fazemos ")
    .replace(/^Ofereço\s+/im, "Oferecemos ")
    .replace(/^Trabalho\s+/im, "Trabalhamos ")
    .replace(/\bmeu atendimento\b/gi, "nosso atendimento")
    .replace(/\bmeus servi[cç]os\b/gi, "nossos serviços")
    .replace(/\bminha consultoria\b/gi, "nossa consultoria")
    .replace(/\bmeu trabalho\b/gi, "nosso trabalho");
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
  // 3) Normalização de bullets e labels
  // - separa bullets colados na mesma linha
  // - garante "- *Campo:* valor" sem capturar a linha seguinte
  // --------------------------
  let text = lines.join("\n");

  // separa itens de lista quando o GPT colar "- Campo: valor- Outro: valor"
  text = text
    .replace(/([^\n])\s*(-\s*[A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ][^\n:]{1,80}:)/g, "$1\n$2")
    .replace(/([^\n])\s*(•\s*[A-ZÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ][^\n:]{1,80}:)/g, "$1\n$2");

  const bulletLabelRe = /^(\s*[-•]\s*)([^\n:*]{1,80}?)(\s*:\s*)(.*)$/;
  text = text
    .split("\n")
    .map((line) => {
      const current = String(line || "").trimRight();
      const match = current.match(bulletLabelRe);
      if (!match) return current;

      const prefix = match[1] || "";
      const label = stripOuterStars(match[2] || "");
      const separator = ":";
      const value = String(match[4] || "").trim();

      if (!label) return current;
      return value
        ? `${prefix}${boldWrapSafe(label)}${separator} ${value}`
        : `${prefix}${boldWrapSafe(label)}${separator}`;
    })
    .join("\n");

  // --------------------------
  // 4) Preço em negrito (somente o valor)
  // --------------------------
  text = text.replace(/R\$\s*\d[\d\.\s]*([,]\d{2})?/g, (m) => {
    const cleaned = m.replace(/\s+/g, " ").trim();
    if (!cleaned) return m;
    if (cleaned.includes("*")) return cleaned;
    return boldWrapSafe(cleaned);
  });

  // --------------------------
  // 5) Linhas informativas no padrão FIXO
  // - 📍 *Localização:* valor
  // - 🕒 *Horário:* valor
  // - 📞 *WhatsApp:* valor
  // --------------------------
  let arr = text.split("\n").map((l) => String(l || "").trimRight());
  const infoEmojiRe = /^(🇧🇷|🕒|📍|🚚|📞|🌐|💬|✅)\s+/;
  const infoLabelMap = {
    "📍": ["Localização", "Local", "Endereço", "Região"],
    "🕒": ["Horário"],
    "📞": ["WhatsApp", "Contato", "Telefone"],
    "💬": ["WhatsApp", "Contato"],
    "🌐": ["Site"],
    "🚚": ["Entrega"],
    "✅": ["Observação"],
    "🇧🇷": ["Brasil"],
  };

  const formatInfoLine = (line) => {
    const current = String(line || "").trimRight();
    const m = current.match(/^\s*(🇧🇷|🕒|📍|🚚|📞|🌐|💬|✅)\s+([^\n]+)$/);
    if (!m) return current;

    const emoji = m[1];
    let rest = String(m[2] || "").trim();
    if (!rest) return current;

    const colonMatch = rest.match(/^\*?([^:*]{1,40})\*?\s*:\s*(.+)$/);
    if (colonMatch) {
      const label = stripOuterStars(colonMatch[1] || "");
      const value = String(colonMatch[2] || "").trim();
      if (!label || !value) return current;
      return `${emoji} ${boldWrapSafe(label)}: ${value}`;
    }

    const knownLabels = infoLabelMap[emoji] || [];
    for (const label of knownLabels) {
      const rx = new RegExp(`^${escapeRegex(label)}\s*[-–—]?\s*(.+)$`, "i");
      const mm = rest.match(rx);
      if (mm && mm[1]) {
        return `${emoji} ${boldWrapSafe(label)}: ${String(mm[1]).trim()}`;
      }
    }

    return `${emoji} ${rest}`;
  };

  arr = arr.map(formatInfoLine);

  // --------------------------
  // 6) Ordenação: CTA de avanço ("Envie...") antes de informações (🇧🇷/🕒/📍...)
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
  // 7) Sempre pular uma linha entre os dois CTAs finais (se estiverem colados)
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





function firstNameFromFullName(fullName) {
  const s = cleanText(fullName);
  if (!s) return "";
  const parts = s.split(/\s+/).filter(Boolean);
  return parts.length ? parts[0] : "";
}



const CATEGORY_SCHEMAS = Object.freeze({
  VEHICLE: {
    key: "VEHICLE",
    label: "veículo",
    minAskScore: 75,
    detect(text) {
      const s = upper(text);
      return /\b(CARRO|VE[IÍ]CULO|VEICULO|MOTO|MOTOCICLETA|CAMINHONETE|SUV|SEDAN|HATCH|PICK[- ]?UP|ONIX|HB20|PALIO|GOL|UNO|CORSA|CELTA|CRUZE|CIVIC|COROLLA|JETTA|FOX|SAVEIRO|STRADA|TORO|RENEGADE|COMPASS|HR-V|T-CROSS|FASTBACK|PULSE|NIVUS|ARGO|MOBI|TRACKER|CRETA)\b/.test(s);
    },
    fields: [
      { key: "price", label: "Preço", weight: 20, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "year", label: "Ano / modelo", weight: 10, importance: "desired", allowProfileSupport: false, detect: hasVehicleYearSignal },
      { key: "km", label: "Quilometragem", weight: 16, importance: "critical", allowProfileSupport: false, detect: hasKmSignal },
      { key: "transmission", label: "Câmbio", weight: 12, importance: "critical", allowProfileSupport: false, detect: hasTransmissionSignal },
      { key: "fuel", label: "Combustível", weight: 10, importance: "critical", allowProfileSupport: false, detect: hasFuelSignal },
      { key: "version", label: "Versão / motor", weight: 6, importance: "desired", allowProfileSupport: false, detect: hasVehicleVersionSignal },
      { key: "conditionDocs", label: "Estado do veículo / documentação", weight: 16, importance: "critical", allowProfileSupport: false, detect: hasVehicleConditionOrDocsSignal },
      { key: "location", label: "Cidade / retirada / entrega", weight: 5, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "highlights", label: "Opcionais ou destaque principal", weight: 5, importance: "desired", allowProfileSupport: false, detect: hasHighlightsSignal },
    ],
  },
  PROPERTY: {
    key: "PROPERTY",
    label: "imóvel",
    minAskScore: 70,
    detect(text) {
      const s = upper(text);
      return /\b(APARTAMENTO|APTO|CASA|SOBRADO|KITNET|TERRENO|LOTE|IM[ÓO]VEL|SALA COMERCIAL|GALP[ÃA]O|CH[ÁA]CARA|FAZENDA|COBERTURA|ALUGO|ALUGUEL)\b/.test(s);
    },
    fields: [
      { key: "price", label: "Preço / aluguel / condomínio", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "location", label: "Bairro / região / cidade", weight: 20, importance: "critical", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "size", label: "Metragem / quartos / vagas", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasPropertySizeSignal },
      { key: "condition", label: "Estado / diferenciais", weight: 16, importance: "desired", allowProfileSupport: false, detect: hasPropertyConditionSignal },
      { key: "availability", label: "Se está pronto para mudar / visitar", weight: 8, importance: "desired", allowProfileSupport: false, detect: hasAvailabilitySignal },
      { key: "highlights", label: "Destaque principal do imóvel", weight: 8, importance: "desired", allowProfileSupport: false, detect: hasPropertyHighlightSignal },
    ],
  },
  ELECTRONICS: {
    key: "ELECTRONICS",
    label: "produto eletrônico",
    minAskScore: 68,
    detect(text) {
      const s = upper(text);
      return /\b(IPHONE|SAMSUNG|MOTOROLA|XIAOMI|CELULAR|SMARTPHONE|NOTEBOOK|MACBOOK|COMPUTADOR|TV|PLAYSTATION|PS4|PS5|XBOX|NINTENDO|IPAD|TABLET|AIRPODS|SMARTWATCH|APPLE WATCH)\b/.test(s);
    },
    fields: [
      { key: "price", label: "Preço", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "exactModel", label: "Modelo exato / armazenamento / configuração", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasElectronicsModelSignal },
      { key: "condition", label: "Estado de conservação", weight: 20, importance: "critical", allowProfileSupport: false, detect: hasConditionSignal },
      { key: "usage", label: "Tempo de uso / bateria / funcionamento", weight: 18, importance: "desired", allowProfileSupport: false, detect: hasBatteryOrUsageSignal },
      { key: "accessories", label: "Acessórios / caixa / nota / garantia", weight: 10, importance: "desired", allowProfileSupport: false, detect: hasAccessorySignal },
      { key: "location", label: "Entrega / retirada / cidade", weight: 6, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
    ],
  },
  SERVICE: {
    key: "SERVICE",
    label: "serviço",
    minAskScore: 68,
    detect(text) {
      const s = upper(text);
      return /\b(SERVI[CÇ]O|FA[ÇC]O|ATENDO|ATENDEMOS|MANICURE|DIARISTA|PEDREIRO|PINTOR|ELETRICISTA|ENCANADOR|MEC[ÂA]NICO|FRETE|MASSAGEM|DESIGNER|AULA|CONSULTORIA|INSTALA[CÇ][ÃA]O|MANUTEN[CÇ][ÃA]O|ADVOGADO|ADVOGADA|ADVOCACIA|JUR[IÍ]DIC[OA]|JURIDIC[OA]|CONDOMINIAL)\b/.test(s);
    },
    fields: [
      { key: "what", label: "O que você faz exatamente", weight: 30, importance: "critical", allowProfileSupport: false, detect: hasServiceDefinitionSignal },
      { key: "price", label: "Preço ou forma de orçamento", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasPriceOrBudgetSignal },
      { key: "location", label: "Região de atendimento", weight: 18, importance: "critical", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "hours", label: "Horário / disponibilidade", weight: 12, importance: "desired", allowProfileSupport: true, detect: hasHoursSignal },
      { key: "differential", label: "Seu principal diferencial", weight: 18, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
  FOOD: {
    key: "FOOD",
    label: "produto de alimentação",
    minAskScore: 68,
    detect(text) {
      const s = upper(text);
      return /\b(BOLO|DOCINHO|DOCINHOS|DOCE|SALGADO|SALGADINHO|MARMITA|LANCHE|LANCHES|PIZZA|A[ÇC][AÁ]I|HAMB[ÚU]RGUER|BRIGADEIRO|CONFEITARIA|SOBREMESA|COMIDA|POR[CÇ][ÃA]O|PRATO)\b/.test(s);
    },
    fields: [
      { key: "items", label: "Sabores / produtos principais", weight: 24, importance: "critical", allowProfileSupport: true, detect: hasFoodItemsSignal },
      { key: "price", label: "Preço ou faixa de valores", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "location", label: "Entrega / retirada / região", weight: 20, importance: "critical", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "hours", label: "Horário de atendimento", weight: 10, importance: "desired", allowProfileSupport: true, detect: hasHoursSignal },
      { key: "availability", label: "Disponibilidade / encomenda / pronta entrega", weight: 10, importance: "desired", allowProfileSupport: false, detect: hasFoodAvailabilitySignal },
      { key: "differential", label: "Seu destaque principal", weight: 12, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
  FASHION: {
    key: "FASHION",
    label: "roupa ou acessório",
    minAskScore: 65,
    detect(text) {
      const s = upper(text);
      return /\b(VESTIDO|CAMISETA|CAL[CÇ]A|TENIS|T[ÊE]NIS|SAPATO|BOLSA|JAQUETA|ROUPA|LOOK|ACESS[ÓO]RIO|REL[ÓO]GIO|BON[ÉE]|SHORT|SAIA)\b/.test(s);
    },
    fields: [
      { key: "price", label: "Preço", weight: 26, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "size", label: "Tamanho / numeração", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasFashionSizeSignal },
      { key: "condition", label: "Estado / cor / marca", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasFashionConditionSignal },
      { key: "location", label: "Entrega / retirada / cidade", weight: 14, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "highlight", label: "Destaque principal da peça", weight: 12, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
  HOME: {
    key: "HOME",
    label: "móvel ou eletrodoméstico",
    minAskScore: 68,
    detect(text) {
      const s = upper(text);
      return /\b(GELADEIRA|FREEZER|FOG[ÃA]O|MICRO-?ONDAS|M[ÁA]QUINA|LAVA E SECA|SOF[ÁA]|ARM[ÁA]RIO|MESA|CADEIRA|GUARDA-ROUPA|COLCH[ÃA]O|COOKTOP|PAINEL|RAQUE|LAVADORA|SECADORA)\b/.test(s);
    },
    fields: [
      { key: "price", label: "Preço", weight: 24, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "model", label: "Marca / modelo / tamanho / capacidade", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasHomeModelSignal },
      { key: "condition", label: "Estado de conservação", weight: 22, importance: "critical", allowProfileSupport: false, detect: hasConditionSignal },
      { key: "voltageOrMeasure", label: "Voltagem / medidas", weight: 18, importance: "desired", allowProfileSupport: false, detect: hasVoltageOrMeasureSignal },
      { key: "location", label: "Entrega / retirada / cidade", weight: 14, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
    ],
  },
  GENERIC: {
    key: "GENERIC",
    label: "produto",
    minAskScore: 60,
    detect() {
      return true;
    },
    fields: [
      { key: "price", label: "Preço", weight: 28, importance: "critical", allowProfileSupport: false, detect: hasPriceSignal },
      { key: "condition", label: "Estado / tempo de uso", weight: 26, importance: "critical", allowProfileSupport: false, detect: hasConditionSignal },
      { key: "location", label: "Cidade / entrega / retirada", weight: 20, importance: "desired", allowProfileSupport: true, detect: hasLocationSignal },
      { key: "differential", label: "Principal destaque do item", weight: 26, importance: "desired", allowProfileSupport: false, detect: hasDifferentialSignal },
    ],
  },
});

function countWords(text) {
  return cleanText(text).split(/\s+/).filter(Boolean).length;
}

function hasPriceSignal(text) {
  const s = upper(text);
  return /R\$\s*\d/.test(s) || /\b\d+\s*(MIL|REAIS|R\$)\b/.test(s);
}

function hasKmSignal(text) {
  return /\b\d{1,3}(\.\d{3})*\s*KM\b/i.test(text) || /\b\d{1,3}\s*MIL\s*KM\b/i.test(text);
}

function hasVehicleYearSignal(text) {
  return /\b(19|20)\d{2}\b/.test(text);
}

function hasVehicleVersionSignal(text) {
  const s = upper(text);
  return /\b(LTZ|LT|EX|EXL|XLT|TITANIUM|TREND|SE|SEL|GL|GLS|GLX|SPORT|TURBO|1\.0|1\.6|2\.0|V6|V8)\b/.test(s);
}

function hasTransmissionSignal(text) {
  const s = upper(text);
  return /\b(MANUAL|AUTOM[AÁ]TICO|AUTOMATICO|CVT)\b/.test(s);
}

function hasFuelSignal(text) {
  const s = upper(text);
  return /\b(FLEX|GASOLINA|DIESEL|ETANOL|H[ÍI]BRIDO|HIBRIDO|EL[ÉE]TRICO|ELETRICO|GNV)\b/.test(s);
}

function hasConditionSignal(text) {
  const s = upper(text);
  return /\b(CONSERVADO|CONSERVADA|NOVO|NOVA|SEMINOVO|SEMINOVA|REVISADO|REVISADA|PERFEITO ESTADO|ESTADO DE NOVO|USADO|USADA|FUNCIONANDO|FUNCIONA|BOAS? CONDI[CÇ][ÕO]ES|BOM ESTADO|PINTURA|POUCO USO|CARRO DE GARAGEM|GARAGEM|IMPEC[ÁA]VEL|ZERADO)\b/.test(s);
}

function hasVehicleConditionOrDocsSignal(text) {
  const s = upper(text);
  return hasConditionSignal(s) || /\b(DOCUMENTA[CÇ][AÃ]O|DOCS?|DOC OK|DOCUMENTA[CÇ][AÃ]O OK|SEM D[ÉE]BITOS|LICENCIADO|IPVA PAGO)\b/.test(s);
}

function hasHighlightsSignal(text) {
  const s = upper(text);
  return /\b(AR[- ]CONDICIONADO|MULTIM[ÍI]DIA|COURO|AIRBAG|ABS|RODA|TETO|CAMERA DE R[ÉE]|C[ÂA]MERA DE R[ÉE]|COMPLETO|OPCIONAIS?)\b/.test(s);
}

function hasLocationSignal(text) {
  const s = upper(text);
  return /\b(ENTREGO|RETIRAR|RETIRADA|ENTREGA|BAIRRO|CIDADE|REGI[AÃ]O|ATENDO|ATENDIMENTO|ONLINE|DOMIC[ÍI]LIO|DOMICILIO|FRETE)\b/.test(s);
}

function hasPropertySizeSignal(text) {
  const s = upper(text);
  return /\b(M2|M²|QUARTO|QUARTOS|SU[ÍI]TE|SUITE|VAGA|VAGAS|BANHEIRO|BANHEIROS)\b/.test(s);
}

function hasAvailabilitySignal(text) {
  const s = upper(text);
  return /\b(PRONTO|DISPON[ÍI]VEL|VISITA|VISITAR|MUDAR|IMEDIATO|IMEDIATA)\b/.test(s);
}

function hasPropertyConditionSignal(text) {
  const s = upper(text);
  return hasConditionSignal(s) || /\b(REFORMADO|MOBILIADO|PLANEJADO|VARANDA|SU[ÍI]TE|CONDOM[ÍI]NIO|LAZER)\b/.test(s);
}

function hasPropertyHighlightSignal(text) {
  const s = upper(text);
  return /\b(VISTA|VARANDA|SU[ÍI]TE|CONDOM[ÍI]NIO|LAZER|CHURRASQUEIRA|PISCINA|PORTARIA|PR[ÓO]XIMO|LOCALIZA[CÇ][AÃ]O)\b/.test(s);
}

function hasElectronicsModelSignal(text) {
  const s = upper(text);
  return /\b(64GB|128GB|256GB|512GB|I5|I7|I9|M1|M2|M3|POLEGADAS?|INCH|\"|GB|SSD|RAM)\b/.test(s);
}

function hasAccessorySignal(text) {
  const s = upper(text);
  return /\b(CAIXA|CARREGADOR|NOTA FISCAL|GARANTIA|CABO|CAPA|PEL[ÍI]CULA|FONE|ACESS[ÓO]RIOS?)\b/.test(s);
}

function hasBatteryOrUsageSignal(text) {
  const s = upper(text);
  return /\b(BATERIA|SA[ÚU]DE DA BATERIA|USO|ANO DE USO|FUNCIONANDO|SEM MARCAS|SEM DETALHES)\b/.test(s);
}

function hasServiceDefinitionSignal(text) {
  const s = upper(text);
  return countWords(s) >= 3;
}

function hasPriceOrBudgetSignal(text) {
  const s = upper(text);
  return hasPriceSignal(s) || /\b(OR[CÇ]AMENTO|A COMBINAR|CONSULTAR|SOB CONSULTA)\b/.test(s);
}

function hasHoursSignal(text) {
  const s = upper(text);
  return /\b(SEG|SEGUNDA|TER|QUA|QUI|SEX|SAB|SÁB|DOM|HOR[ÁA]RIO|HORARIO|\d{1,2}H)\b/.test(s);
}

function hasDifferentialSignal(text) {
  const s = upper(text);
  return /\b(EXPERI[ÊE]NCIA|QUALIDADE|R[ÁA]PIDO|RAPIDO|CAPRICHO|GARANTIA|ATENDIMENTO|PERSONALIZADO|ARTESANAL|CASEIRO|ORIGINAL|ÚNICO DONO|UNICO DONO)\b/.test(s);
}

function hasFoodItemsSignal(text) {
  const s = upper(text);
  return /\b(SABOR|SABORES|BRIGADEIRO|BOLO|POTE|PIZZA|HAMB[ÚU]RGUER|COMBO|KIT|ENCOMENDA|MARMITA|LANCHE|POR[CÇ][ÃA]O)\b/.test(s);
}

function hasFoodAvailabilitySignal(text) {
  const s = upper(text);
  return /\b(ENCOMENDA|PRONTA ENTREGA|DISPON[ÍI]VEL HOJE|HOJE|SOB ENCOMENDA|RETIRADA HOJE)\b/.test(s);
}

function hasFashionSizeSignal(text) {
  const s = upper(text);
  return /\b(PP|P|M|G|GG|XG|36|37|38|39|40|41|42|43|44|NUMERA[CÇ][AÃ]O|TAMANHO)\b/.test(s);
}

function hasFashionConditionSignal(text) {
  const s = upper(text);
  return hasConditionSignal(s) || /\b(COR|MARCA|SEM USO|USADO UMA VEZ|ORIGINAL)\b/.test(s);
}

function hasHomeModelSignal(text) {
  const s = upper(text);
  return /\b(LITROS|L|KG|BRASTEMP|ELECTROLUX|CONSUL|SAMSUNG|LG|PHILCO|MIDEA|6 BOCAS|4 BOCAS|PORTAS?)\b/.test(s);
}

function hasVoltageOrMeasureSignal(text) {
  const s = upper(text);
  return /\b(110V|127V|220V|VOLTS?|CM|METROS?|LARGURA|ALTURA|PROFUNDIDADE|MEDIDAS?)\b/.test(s);
}

const CATEGORY_HINTS = Object.freeze({
  VEHICLE: [
    "CARRO", "VEICULO", "VEÍCULO", "AUTO", "AUTOMOVEL", "AUTOMÓVEL", "MOTO", "MOTOCICLETA", "CAMINHONETE", "SUV", "SEDAN", "HATCH",
    "PICKUP", "PICK-UP", "PICK UP", "ONIX", "HB20", "PALIO", "GOL", "UNO", "CORSA", "CELTA", "CRUZE", "CIVIC", "COROLLA", "JETTA",
    "FOX", "SAVEIRO", "STRADA", "TORO", "RENEGADE", "COMPASS", "HR-V", "HRV", "T-CROSS", "TCROSS", "FASTBACK", "PULSE", "NIVUS",
    "ARGO", "MOBI", "TRACKER", "CRETA", "KWID", "S10", "HILUX", "SW4", "FIAT", "CHEVROLET", "VW", "VOLKSWAGEN", "HYUNDAI", "TOYOTA", "HONDA"
  ],
  PROPERTY: [
    "APARTAMENTO", "APTO", "CASA", "SOBRADO", "KITNET", "TERRENO", "LOTE", "IMOVEL", "IMÓVEL", "SALA COMERCIAL", "GALPAO", "GALPÃO",
    "CHACARA", "CHÁCARA", "FAZENDA", "COBERTURA", "ALUGO", "ALUGUEL", "CONDOMINIO", "CONDOMÍNIO"
  ],
  ELECTRONICS: [
    "IPHONE", "SAMSUNG", "MOTOROLA", "XIAOMI", "CELULAR", "SMARTPHONE", "NOTEBOOK", "MACBOOK", "COMPUTADOR", "TV", "PLAYSTATION",
    "PS4", "PS5", "XBOX", "NINTENDO", "IPAD", "TABLET", "AIRPODS", "SMARTWATCH", "APPLE WATCH", "MONITOR", "IMPRESSORA"
  ],
  SERVICE: [
    "SERVIÇO", "SERVICO", "FAÇO", "FACO", "ATENDO", "ATENDEMOS", "CONSULTORIA", "ASSESSORIA", "ADVOGADO", "ADVOGADA", "ADVOCACIA",
    "JURÍDICO", "JURIDICO", "CONDOMINIAL", "MANICURE", "DIARISTA", "PEDREIRO", "PINTOR", "ELETRICISTA", "ENCANADOR", "MECÂNICO", "MECANICO",
    "FRETE", "MASSAGEM", "DESIGNER", "AULA", "INSTALAÇÃO", "INSTALACAO", "MANUTENÇÃO", "MANUTENCAO", "LIMPEZA", "CABELO", "BARBEIRO", "UNHAS"
  ],
  FOOD: [
    "BOLO", "DOCINHO", "DOCINHOS", "DOCE", "SALGADO", "SALGADINHO", "MARMITA", "LANCHE", "LANCHES", "PIZZA", "AÇAÍ", "ACAI",
    "HAMBÚRGUER", "HAMBURGUER", "BRIGADEIRO", "CONFEITARIA", "SOBREMESA", "COMIDA", "PORÇÃO", "PORCAO", "PRATO", "TRUFA"
  ],
  FASHION: [
    "VESTIDO", "CAMISETA", "CALÇA", "CALCA", "TENIS", "TÊNIS", "SAPATO", "BOLSA", "JAQUETA", "ROUPA", "LOOK", "ACESSORIO", "ACESSÓRIO",
    "RELÓGIO", "RELOGIO", "BONÉ", "BONE", "SHORT", "SAIA", "BLUSA", "CROPPED"
  ],
  HOME: [
    "GELADEIRA", "FREEZER", "FOGÃO", "FOGAO", "MICROONDAS", "MICRO-ONDAS", "MÁQUINA", "MAQUINA", "LAVA E SECA", "SOFÁ", "SOFA",
    "ARMÁRIO", "ARMARIO", "MESA", "CADEIRA", "GUARDA-ROUPA", "COLCHÃO", "COLCHAO", "COOKTOP", "PAINEL", "RAQUE", "LAVADORA", "SECADORA"
  ],
});

function scoreKeywordHits(text, hints) {
  const normalized = ` ${upper(text).replace(/[^A-Z0-9ÁÀÂÃÉÈÊÍÌÎÓÒÔÕÚÙÛÇ\- ]+/g, " ")} `;
  let score = 0;

  for (const hint of ensureArray(hints)) {
    const token = cleanText(hint).toUpperCase();
    if (!token) continue;
    if (normalized.includes(` ${token} `)) score += token.length >= 6 ? 8 : 6;
  }

  return score;
}

function scoreCategorySchema(text, schema) {
  if (!schema || schema.key === "GENERIC") return 0;

  let score = 0;
  if (schema.detect(text)) score += 40;
  score += scoreKeywordHits(text, CATEGORY_HINTS[schema.key]);

  const completeness = computeCategoryCompleteness({ schema, text, bizProfile: null });
  score += Math.min(36, completeness.presentWeight);

  const words = countWords(text);
  if (schema.key === "SERVICE" && words <= 2) score -= 10;

  return score;
}

function detectCategorySchema(text) {
  const candidates = Object.values(CATEGORY_SCHEMAS).filter((schema) => schema.key !== "GENERIC");
  let bestSchema = CATEGORY_SCHEMAS.GENERIC;
  let bestScore = 0;

  for (const schema of candidates) {
    const score = scoreCategorySchema(text, schema);
    if (score > bestScore) {
      bestSchema = schema;
      bestScore = score;
    }
  }

  return bestScore >= 40 ? bestSchema : CATEGORY_SCHEMAS.GENERIC;
}

function profileHasUsefulValue(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.map((item) => cleanText(item)).filter(Boolean).length > 0;
  return cleanText(value).length > 0;
}

function hasProfileSupportForField(fieldKey, bizProfile) {
  const profile = bizProfile && typeof bizProfile === "object" ? bizProfile : null;
  if (!profile) return false;

  if (fieldKey === "location") {
    return [profile.location, profile.address, profile.serviceArea].some(profileHasUsefulValue);
  }

  if (fieldKey === "hours") {
    return profileHasUsefulValue(profile.hours);
  }

  if (fieldKey === "items") {
    return profileHasUsefulValue(profile.productList) || profileHasUsefulValue(profile.productsUrl);
  }

  return false;
}

function getFieldPresence(field, text, bizProfile) {
  const detectedInText = !!field?.detect?.(text || "");
  const detectedFromProfile = !!field?.allowProfileSupport && hasProfileSupportForField(field.key, bizProfile);
  return {
    inText: detectedInText,
    fromProfile: detectedFromProfile,
    present: detectedInText || detectedFromProfile,
  };
}

function computeCategoryCompleteness({ schema, text, bizProfile }) {
  const fields = ensureArray(schema?.fields);
  const details = fields.map((field) => {
    const presence = getFieldPresence(field, text, bizProfile);
    const weight = Number(field.weight || 0);
    return {
      key: field.key,
      label: field.label,
      importance: field.importance || "desired",
      weight,
      allowProfileSupport: !!field.allowProfileSupport,
      ...presence,
    };
  });

  const totalWeight = details.reduce((sum, item) => sum + item.weight, 0) || 1;
  const presentWeight = details.reduce((sum, item) => sum + (item.present ? item.weight : 0), 0);
  const score = Math.round((presentWeight / totalWeight) * 100);

  const missingCritical = details.filter((item) => item.importance === "critical" && !item.present);
  const missingDesired = details.filter((item) => item.importance !== "critical" && !item.present);

  return {
    schema,
    score,
    totalWeight,
    presentWeight,
    details,
    missingCritical,
    missingDesired,
    missingAll: details.filter((item) => !item.present),
  };
}

function pickFieldsToAsk({ completeness, maxFields = 5 }) {
  const sortByWeightDesc = (a, b) => {
    const wa = Number(a?.weight || 0);
    const wb = Number(b?.weight || 0);
    return wb - wa;
  };

  const critical = [...ensureArray(completeness?.missingCritical)].sort(sortByWeightDesc);
  const desired = [...ensureArray(completeness?.missingDesired)].sort(sortByWeightDesc);
  const ordered = [...critical, ...desired];
  return ordered.slice(0, maxFields);
}

function shouldAskCategoryQuestions({ schema, text, completeness, attemptCount = 0 }) {
  if (!schema || !completeness) return false;
  if (attemptCount >= 1) return false;

  const words = countWords(text);
  const askable = pickFieldsToAsk({ completeness });
  if (!askable.length) return false;

  if (completeness.missingCritical.length > 0) return true;

  const threshold = Number(schema.minAskScore || 65);
  if (completeness.score < threshold) return true;

  if (schema.key === "SERVICE") {
    const missingDesiredWeighted = ensureArray(completeness.missingDesired)
      .filter((item) => Number(item.weight || 0) >= 12);
    if (missingDesiredWeighted.length >= 2) return true;
    if (missingDesiredWeighted.length >= 1 && words <= 12) return true;
  }

  if (schema.key === "GENERIC") {
    return words <= 5 && completeness.missingAll.length >= 2;
  }

  return words <= 3 && completeness.missingAll.length >= 1;
}

function buildCategoryQuestionPrompt({ schema, fieldsToAsk, bizProfile }) {
  const hints = [];

  if (hasProfileSupportForField("location", bizProfile)) {
    hints.push("região eu já posso aproveitar dos seus dados salvos");
  }
  if (hasProfileSupportForField("hours", bizProfile)) {
    hints.push("horário eu já posso aproveitar dos seus dados salvos");
  }

  const lines = [
    `Perfeito! Para o anúncio de ${schema.label} ficar mais forte, me manda em *uma única mensagem* só o que você quiser informar destes pontos:`,
    "",
    ...fieldsToAsk.map((field) => `* ${field.label}`),
    "",
    "Pode mandar apenas o que você tiver.",
  ];

  if (hints.length) {
    lines.push(`✅ ${hints.join(" e ")}.`);
  }

  lines.push("");
  lines.push("Se preferir, digite *PULAR* e eu gero com o que já tenho. ✅");
  return lines.join("\n");
}

function buildCategoryIntakePlan({ text, bizProfile, attemptCount = 0 }) {
  const schema = detectCategorySchema(text);
  const completeness = computeCategoryCompleteness({ schema, text, bizProfile });
  const fieldsToAsk = pickFieldsToAsk({ completeness });

  if (!shouldAskCategoryQuestions({ schema, text, completeness, attemptCount })) {
    return {
      shouldAsk: false,
      schema,
      completeness,
      fieldsToAsk: [],
      prompt: "",
    };
  }

  return {
    shouldAsk: true,
    schema,
    completeness,
    fieldsToAsk,
    prompt: buildCategoryQuestionPrompt({ schema, fieldsToAsk, bizProfile }),
  };
}

async function setAdSessionPayload(waId, payload) {
  await setCurrentAdSession(waId, payload);
}

async function getAdSessionPayload(waId) {
  return await getCurrentAdSession(waId);
}

async function clearAdSessionPayload(waId) {
  await clearCurrentAdSession(waId);
}

function buildLeadIntakeCombinedText(baseText, complementText) {
  return [
    baseText,
    "",
    "INFORMAÇÕES COMPLEMENTARES DO USUÁRIO:",
    complementText,
  ].join("\n");
}

function buildGenerationPrompt({ userText, lastAd, isRefinement, bizContext }) {
  const sections = [];

  sections.push([
    "REGRA_DE_PRIORIDADE:",
    "1. O que o usuário escreveu na descrição atual.",
    "2. As informações complementares respondidas nesta conversa.",
    "3. Os dados salvos da empresa, apenas para preencher o que faltar.",
    "Se houver conflito, siga exatamente essa ordem e nunca invente placeholders.",
  ].join("\n"));

  sections.push([
    "REGRAS_FIXAS_DE_MARCA_E_CONTATO:",
    "- Se houver nome da empresa salvo, ele deve aparecer em TODO anúncio final e em negrito.",
    "- Se houver site salvo, ele deve aparecer em TODO anúncio final.",
    "- Se houver redes sociais salvas, elas devem aparecer em TODO anúncio final.",
    "- Só deixe de mostrar nome da empresa, site ou redes sociais se o usuário pedir explicitamente para retirar, remover, ocultar ou não mostrar esses dados no refinamento.",
  ].join("\n"));

  if (bizContext) sections.push(bizContext);

  if (isRefinement) {
    sections.push(`ANUNCIO_ATUAL:
${lastAd}`);
    sections.push(`AJUSTES_SOLICITADOS:
${userText}`);
  } else {
    sections.push(`DESCRIÇÃO_DO_USUÁRIO:
${userText}`);
  }

  return sections.join("\n\n");
}

// -------------------- Copy / Mensagens --------------------
async function msgAskName(waId){
  return withMenuHint(await getCopyText("FLOW_ASK_NAME", { waId }));
}

async function msgAskProduct(waId){
  const fullName = await getUserFullName(waId);
  const firstName = firstNameFromFullName(fullName);
  return withMenuHint(await getCopyText("FLOW_ASK_PRODUCT", { waId, vars: { firstName } }));
}

async function msgTrialOverAndPlans() {
  return await renderPlansMenu();
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
    const emoji = n === 1 ? "1️⃣" : n === 2 ? "2️⃣" : n === 3 ? "3️⃣" : `${n})`;
    const price = String(moneyBRFromCents(p.priceCents)).replace('.', ',');
    const quotaText = p.description || `${p.monthlyQuota} descrições/mês`;
    lines.push(`${emoji} *${p.name}* — R$ ${price} (${quotaText})`);
  });
  lines.push("");

  lines.push("Responda com *1*, *2* ou *3*.");
  return lines.join("\n");
}

async function msgAskPaymentMethod(waId, plan){
  return withMenuHint(await getCopyText("FLOW_ASK_PAYMENT_METHOD_WITH_PLAN", {
    waId,
    vars: {
      planName: plan?.name || "",
      planPrice: plan?.priceCents ? moneyBRFromCents(plan.priceCents) : "",
    },
  }));
}

async function msgAskDoc(waId){
  return withMenuHint(await getCopyText("FLOW_ASK_DOC", { waId }));
}

async function msgInvalidDoc(waId){
  return await getCopyText("FLOW_INVALID_DOC", { waId });
}

async function msgAskBillingCityState(waId){
  return withMenuHint("Perfeito! ✅ Agora preciso só de mais 2 informações para finalizar seu cadastro de cobrança.\n\n📍 Qual é sua *Cidade/UF*? (ex: Atibaia/SP)");
}

async function msgAskBillingAddress(waId){
  return withMenuHint("Ótimo! ✅ Agora me diga seu *endereço* (rua, número, bairro).\n\nSe for apenas atendimento online, responda: *APENAS ONLINE*");
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



async function msgAskProfileRegistration(waId) {
  return withMenuHint([
    "Quer cadastrar os dados da sua empresa para eu usar automaticamente nos próximos anúncios? 🙂",
    "",
    "1) Sim, cadastrar agora",
    "2) Agora não",
    "",
    "Assim você não precisa repetir essas informações toda vez. ✅",
  ].join("\n"));
}


function buildRefinementReminder(maxRefinements) {
  const qty = Number.isFinite(Number(maxRefinements)) && Number(maxRefinements) >= 0
    ? Math.trunc(Number(maxRefinements))
    : 2;

  return `* Para refinar: responda com o que você quer mudar (ex.: "deixa mais curto", "mais emocional", "com mais emoji", etc...).

(Lembrete: até ${qty} refinamento(s) por descrição. No próximo, conta como uma nova descrição.)`;
}

async function msgRefinementPrompt(waId, maxRefinements) {
  const lines = [];
  lines.push(await getCopyText("FLOW_AFTER_SAVE_PROFILE_QUESTION", { waId }));
  lines.push(buildRefinementReminder(maxRefinements));
  lines.push(await getCopyText("FLOW_AFTER_SAVE_PROFILE_OK_HINT", { waId }));
  return lines.join("\n");
}

function normalizeProfileScalar(value) {
  return String(value ?? "").replace(/\\/g, "/").trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textRequestsRemovingCompanyInfo(text) {
  const s = upper(text);
  return /(RETIRA|RETIRAR|REMOVE|REMOVER|SEM|TIRA|OCULTA|OCULTAR|N[ÃA]O COLOCA|NAO COLOCA|N[ÃA]O MOSTRA|NAO MOSTRA)/.test(s)
    && /(EMPRESA|NOME DA EMPRESA|MARCA|SITE|REDES?|REDE SOCIAL|INSTAGRAM|FACEBOOK|TIKTOK)/.test(s);
}

function textRequestsRemovingField(text, fieldType) {
  const s = upper(text);
  const removeIntent = /(RETIRA|RETIRAR|REMOVE|REMOVER|SEM|TIRA|OCULTA|OCULTAR|N[ÃA]O COLOCA|NAO COLOCA|N[ÃA]O MOSTRA|NAO MOSTRA)/.test(s);
  if (!removeIntent) return false;

  if (fieldType === "website") {
    return /(SITE|LINK|WEBSITE|WWW)/.test(s);
  }

  if (fieldType === "socials") {
    return /(REDES?|REDE SOCIAL|INSTAGRAM|FACEBOOK|TIKTOK|SOCIAL)/.test(s);
  }

  if (fieldType === "companyName") {
    return /(EMPRESA|NOME DA EMPRESA|MARCA)/.test(s);
  }

  return false;
}

function hasLineWithText(lines, value) {
  const target = normalizeProfileScalar(value).toLowerCase();
  if (!target) return false;
  return lines.some((line) => normalizeProfileScalar(line).toLowerCase().includes(target));
}

function normalizeCompanyCtas(adText, bizProfile) {
  const companyName = normalizeProfileScalar(bizProfile?.companyName);
  if (!companyName) return String(adText || "");

  return String(adText || "")
    .replace(/Fale comigo/gi, "Fale conosco")
    .replace(/Entre em contato comigo/gi, "Entre em contato conosco")
    .replace(/Me chame/gi, "Nos chame")
    .replace(/Agende comigo/gi, "Agende conosco");
}

function normalizeGenericCtas(adText) {
  return String(adText || "")
    .replace(/Fale comigo para mais informa[cç][õo]es!?/gi, "Entre em contato para mais informações.")
    .replace(/Fale comigo para saber mais!?/gi, "Entre em contato para mais informações.")
    .replace(/Fale comigo/gi, "Entre em contato")
    .replace(/Entre em contato comigo/gi, "Entre em contato")
    .replace(/Me chame/gi, "Entre em contato")
    .replace(/Agende comigo/gi, "Agende seu atendimento");
}

function removeGeneratedPlaceholders(adText) {
  const placeholderPatterns = [
    /^\s*\*?\s*\[(Seu|Sua|Seus|Suas)\s+[^\]]+\]\s*\*?\s*$/gim,
    /^\s*\*?\s*\[Contato\]\s*\*?\s*$/gim,
    /\*?\s*\[(Seu|Sua|Seus|Suas)\s+[^\]]+\]\s*\*?/gi,
    /\*?\s*\[Contato\]\s*\*?/gi,
  ];

  let text = String(adText || "");
  for (const rx of placeholderPatterns) {
    text = text.replace(rx, "");
  }

  const lines = text
    .split("\n")
    .map((line) => String(line || "").trim())
    .filter((line) => !/^\*?\s*\[(Seu|Sua|Seus|Suas)\s+[^\]]+\]\s*\*?$/i.test(line))
    .filter((line) => !/^\*?\s*\[Contato\]\s*\*?$/i.test(line))
    .filter((line) => !/^\*+\s*$/i.test(line));

  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

  const compact = [];
  for (const line of lines) {
    if (!line.trim() && compact.length && !compact[compact.length - 1].trim()) continue;
    compact.push(line);
  }

  return compact.join("\n").trim();
}

function sanitizeGeneratedAd(adText, bizProfile) {
  const hasCompany = !!normalizeProfileScalar(bizProfile?.companyName);
  let text = String(adText || "");
  text = removeGeneratedPlaceholders(text);
  if (hasCompany) text = normalizeBusinessVoice(text, bizProfile);
  text = hasCompany ? normalizeCompanyCtas(text, bizProfile) : normalizeGenericCtas(text);
  text = removeGeneratedPlaceholders(text);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}


function ensureCompanyNameBold(adText, companyName) {
  const name = normalizeProfileScalar(companyName);
  if (!name) return adText;

  const escaped = escapeRegex(name);
  const alreadyBold = new RegExp(`\\*${escaped}\\*`, "i");
  if (alreadyBold.test(adText)) return adText;

  const plain = new RegExp(escaped, "i");
  if (plain.test(adText)) {
    return adText.replace(plain, `*${name}*`);
  }

  const lines = String(adText || "").split("\n");
  const insertLine = `🏢 *${name}*`;

  if (!lines.length) return insertLine;

  if (lines.length === 1) {
    return [lines[0], "", insertLine].join("\n");
  }

  lines.splice(2, 0, insertLine, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function applyPersistentBusinessInfo(adText, bizProfile, userText, isRefinement) {
  if (!bizProfile || typeof bizProfile !== "object") return adText;

  const refinementText = isRefinement ? String(userText || "") : "";
  let text = normalizeBusinessVoice(adText, bizProfile);
  text = normalizeCompanyCtas(text, bizProfile);

  const companyName = normalizeProfileScalar(bizProfile.companyName);
  const website = normalizeUrlLike(normalizeProfileScalar(bizProfile.website));
  const whatsapp = normalizeWhatsappLike(normalizeProfileScalar(bizProfile.whatsapp));
  const socials = ensureArray(bizProfile.socials)
    .map((item) => normalizeUrlLike(normalizeProfileScalar(item)))
    .filter(Boolean);

  if (companyName && !textRequestsRemovingField(refinementText, "companyName") && !textRequestsRemovingCompanyInfo(refinementText)) {
    text = ensureCompanyNameBold(text, companyName);
  }

  const lines = String(text || "").split("\n").map((line) => String(line || "").trimRight());
  const infoLinesToAdd = [];

  if (website && !textRequestsRemovingField(refinementText, "website") && !hasLineWithText(lines, website)) {
    infoLinesToAdd.push(`🌐 *Site:* ${website}`);
  }

  if (whatsapp && !hasLineWithText(lines, whatsapp)) {
    infoLinesToAdd.push(`📞 *WhatsApp:* ${whatsapp}`);
  }

  if (socials.length && !textRequestsRemovingField(refinementText, "socials")) {
    const missingSocials = socials.filter((item) => !hasLineWithText(lines, item));
    if (missingSocials.length) {
      infoLinesToAdd.push(`📱 ${missingSocials.join(" | ")}`);
    }
  }

  if (!infoLinesToAdd.length) return text;

  let insertAt = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = String(lines[i] || "").trim().toLowerCase();
    if (!s) continue;
    if (s.startsWith("converse") || s.startsWith("chame") || s.startsWith("fale") || s.startsWith("me chame") || s.startsWith("📲") || s.startsWith("💬")) {
      insertAt = i;
      break;
    }
  }

  const payload = [];
  if (insertAt > 0 && String(lines[insertAt - 1] || "").trim() !== "") payload.push("");
  payload.push(...infoLinesToAdd);
  if (insertAt < lines.length && String(lines[insertAt] || "").trim() !== "") payload.push("");

  lines.splice(insertAt, 0, ...payload);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildBizProfileContext(profile) {
  if (!profile || typeof profile !== "object") return "";

  const parts = [];
  const companyName = normalizeProfileScalar(profile.companyName);
  const serviceArea = normalizeProfileScalar(profile.serviceArea);
  const location = normalizeProfileScalar(profile.location);
  const hours = normalizeProfileScalar(profile.hours);
  const whatsapp = normalizeWhatsappLike(normalizeProfileScalar(profile.whatsapp));
  const website = normalizeUrlLike(normalizeProfileScalar(profile.website));
  const productList = normalizeProfileScalar(profile.productList || profile.productsUrl);
  const socials = ensureArray(profile.socials)
    .map((item) => normalizeUrlLike(normalizeProfileScalar(item)))
    .filter(Boolean);

  if (companyName) parts.push(`Empresa: ${companyName}`);
  if (serviceArea) parts.push(`Atendimento: ${serviceArea}`);
  if (location) parts.push(`Local: ${location}`);
  if (hours) parts.push(`Horário: ${hours}`);
  if (whatsapp) parts.push(`WhatsApp: ${whatsapp}`);
  if (website) parts.push(`Site: ${website}`);
  if (productList) parts.push(`Catálogo/Lista: ${productList}`);
  if (socials.length) parts.push(`Redes: ${socials.join(" | ")}`);

  if (!parts.length) return "";

  return [
    "CONTEXTO_DA_EMPRESA (dados salvos do usuário; trate como fonte de verdade quando ele pedir para incluir ou ajustar dados da empresa, sem inventar placeholders ou substituir por exemplos):",
    parts.join("\n"),
  ].join("\n");
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
  lines.push(buildRefinementReminder(maxRefinements));
  lines.push(await getCopyText("FLOW_AFTER_SAVE_PROFILE_OK_HINT", { waId }));
  return lines.join("\n");
}

async function msgMenuMain(waId) {
  return await getCopyText("FLOW_MENU_MAIN", { waId });
}

async function msgMenuSubscriptionMenu(waId) {
  const status = await getUserStatus(waId);
  const planCode = await getUserPlan(waId);
  const paymentMethod = await getPaymentMethod(waId);
  const doc = await getUserDocMasked(waId);
  const validUntil = await getCardValidUntil(waId);
  const usedTrial = await getUserTrialUsed(waId);
  const usedQuota = await getUserQuotaUsed(waId);

  let planName = "Trial";
  let total = TRIAL_LIMIT;
  if (planCode) {
    const plans = await getMenuPlans();
    const plan = (plans || []).find((p) => p.code === planCode) || null;
    planName = plan?.name || planCode;
    total = Number(plan?.monthlyQuota || 0) || 0;
  }

  const used = planCode ? usedQuota : usedTrial;
  const renewalBr = formatDateBR(validUntil) || "Não disponível";
  const lines = [
    "*Minha assinatura*",
    "",
    `📦 Plano: ${planName}`,
    `📈 Descrições utilizadas: ${used} / ${total || "—"}`,
    `💳 Forma de pagamento: ${formatPaymentMethodLabel(paymentMethod)}`,
    `🗓️ Data de vencimento/renovação: ${renewalBr}`,
    `🪪 Documento: ${docMenuPreview(doc)}`,
    status === ST.PAYMENT_PENDING ? "⏳ Status: pagamento pendente" : status === ST.ACTIVE ? "✅ Status: ativo" : `ℹ️ Status: ${status}`,
    "",
    "1) Alterar plano",
    "2) Cancelar plano",
    "3) Ajuda",
    "4) Voltar",
  ];
  return lines.join("\n");
}

async function msgMenuEditRoot() {
  return [
    "*Alterar dados preenchidos*",
    "",
    "1) Dados pessoais",
    "2) Dados da empresa",
    "3) Fluxo FIXO ou LIVRE",
    "4) Ajuda",
    "5) Voltar",
  ].join("\n");
}

async function msgMenuEditPersonal(waId) {
  const [fullName, doc, billingCityState, billingAddress] = await Promise.all([
    getUserFullName(waId),
    getUserDocMasked(waId),
    getBillingCityState(waId),
    getBillingAddress(waId),
  ]);

  return [
    "*Dados pessoais preenchidos*",
    "",
    `1) ${menuDisplayValue(fullName)}`,
    `2) ${docMenuPreview(doc)} — não exibimos o número por segurança`,
    `3) ${menuDisplayValue(billingCityState)}`,
    `4) ${menuDisplayValue(billingAddress)}`,
    "5) Voltar",
    "",
    "Responda com o número do dado que você quer alterar.",
  ].join("\n");
}

async function msgMenuEditCompany(waId) {
  const biz = (await getBizProfile(waId)) || {};
  const socials = socialPreviewList(biz.socials).join(", ");
  return [
    "*Dados da empresa preenchidos*",
    "",
    `1) Nome da empresa: ${menuDisplayValue(biz.companyName)}`,
    `2) WhatsApp da empresa: ${menuDisplayValue(normalizeWhatsappLike(String(biz.whatsapp || "")))}`,
    `3) Local de atendimento: ${menuDisplayValue(biz.location || biz.address || biz.serviceArea)}`,
    `4) Horário de atendimento: ${menuDisplayValue(biz.hours)}`,
    `5) Redes sociais: ${menuDisplayValue(socials)}`,
    `6) Site: ${menuDisplayValue(normalizeUrlLike(String(biz.website || "")))}`,
    `7) Catálogo / lista de produtos: ${menuDisplayValue(normalizeUrlLike(String(biz.productList || biz.productsUrl || "")) || String(biz.productList || biz.productsUrl || ""))}`,
    "8) Voltar",
    "",
    "Responda com o número do dado que você quer alterar.",
  ].join("\n");
}

async function msgMenuEditFlow(waId) {
  const mode = await getTemplateMode(waId);
  const current = mode === "FREE" ? "LIVRE" : "FIXO";
  return [
    "*Fluxo de anúncio*",
    "",
    `Atual: ${current}`,
    "",
    "1) Usar anúncio FIXO",
    "2) Usar anúncio LIVRE",
    "3) Voltar",
  ].join("\n");
}

async function msgMenuAskNewName(waId) {
  return withMenuHint(await getCopyText("FLOW_MENU_ASK_NEW_NAME", { waId }));
}

async function msgMenuAskNewDoc(waId) {
  return withMenuHint(await getCopyText("FLOW_MENU_ASK_NEW_DOC", { waId }));
}

async function msgMenuAskEditField(waId, context) {
  const field = String(context?.field || "");
  if (field === "billingCityState") {
    return withMenuHint(["Perfeito! ✅", "", "Me envie a *Cidade/UF* que você quer salvar.", "Ex.: Atibaia/SP"].join("
"));
  }
  if (field === "billingAddress") {
    return withMenuHint(["Perfeito! ✅", "", "Me envie o *endereço* que você quer salvar.", "Se for só atendimento online, responda: *APENAS ONLINE*"].join("
"));
  }
  if (field === "companyName") {
    return withMenuHint(["Perfeito! ✅", "", "Me envie o *nome da empresa* como você quer que eu salve."].join("
"));
  }
  if (field === "whatsapp") {
    return withMenuHint(["Perfeito! ✅", "", "Me envie o *WhatsApp da empresa*."].join("
"));
  }
  if (field === "location") {
    return withMenuHint(["Perfeito! ✅", "", "Me envie o *local de atendimento* da empresa.", "Se for apenas online, responda: *APENAS ATENDIMENTO ONLINE*"].join("
"));
  }
  if (field === "hours") {
    return withMenuHint(["Perfeito! ✅", "", "Me envie o *horário de atendimento* da empresa."].join("
"));
  }
  if (field === "socials") {
    return withMenuHint(["Perfeito! ✅", "", "Me envie os links das *redes sociais* separados por vírgula ou uma por linha.", "Ex.: https://instagram.com/seuusuario, https://facebook.com/suaempresa"].join("
"));
  }
  if (field === "website") {
    return withMenuHint(["Perfeito! ✅", "", "Me envie o link do *site* da empresa."].join("
"));
  }
  if (field === "productList") {
    return withMenuHint(["Perfeito! ✅", "", "Me envie o link do *catálogo / lista de produtos* da empresa."].join("
"));
  }
  return withMenuHint(["Perfeito! ✅", "", "Me envie o dado atualizado."].join("
"));
}

async function msgMenuUrlHelp(waId) {
  return await getCopyText("FLOW_MENU_URL_HELP", { waId });
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

async function msgPaymentReady({ waId, method, url }) {
  const isCard = method === "CARD";
  const line1 = isCard
    ? "✅ Pronto! Agora é só concluir no *Cartão* (assinatura)."
    : "✅ Pronto! Gerei sua cobrança via *PIX*.";
  const line2 = isCard
    ? (url ? `Finalize por aqui: ${url}` : "Finalize pelo link no Asaas.")
    : (url ? `Pague por aqui: ${url}` : "Pague pelo link dentro do Asaas.");
  return [
    line1,
    "",
    line2,
    "",
    "Assim que o pagamento for confirmado, seu plano ativa automaticamente. 🚀",
    "",
    "1) Já vou finalizar",
    "2) Mudar forma de pagamento",
  ].join("\n");
}

async function createPendingChargeMessage({ waId, method, customerId, plan }) {
  if (method === "PIX") {
    const pay = await createPixPayment({
      customerId,
      value: (Number(plan.priceCents) || 0) / 100,
      description: `Amigo das Vendas - Plano ${plan.code} (PIX mensal)`,
      externalReference: waId,
      dueDate: todayISO(),
    });
    const url = pay?.invoiceUrl || pay?.bankSlipUrl || pay?.paymentLink || "";
    await setUserStatus(waId, ST.PAYMENT_PENDING);
    return await msgPaymentReady({ waId, method, url });
  }

  const link = await createRecurringCardPaymentLink({
    name: `Assinatura ${plan.name}`,
    description: `Amigo das Vendas - Plano ${plan.code} (Cartão recorrente)`,
    value: (Number(plan.priceCents) || 0) / 100,
    externalReference: waId,
    subscriptionCycle: "MONTHLY",
  });

  const url = link?.url || link?.paymentLink || link?.link || "";
  await setUserStatus(waId, ST.PAYMENT_PENDING);
  return await msgPaymentReady({ waId, method, url });
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
    const choice = normalizeChoiceMax(inbound, 4);

    if (!choice) {
      const prev = await getMenuPrevStatus(id);
      await clearMenuPrevStatus(id);
      if (prev && prev !== ST.WAIT_MENU) {
        await setUserStatus(id, prev);
      } else {
        await setUserStatus(id, ST.WAIT_PRODUCT);
      }
      return await handleInboundText({ waId: id, text: inbound });
    }

    if (choice === "1") {
      await setUserStatus(id, ST.WAIT_MENU_SUBSCRIPTION);
      return reply(await msgMenuSubscriptionMenu(id));
    }

    if (choice === "2") {
      await setUserStatus(id, ST.WAIT_MENU_EDIT_ROOT);
      return reply(await msgMenuEditRoot());
    }

    if (choice === "3") {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply(await msgPlansOnly());
    }

    return reply(`${await msgMenuUrlHelp(id)}\n\n${await msgMenuMain(id)}`);
  }

  if (status === ST.WAIT_MENU_SUBSCRIPTION) {
    const choice = normalizeChoiceMax(inbound, 4);
    if (!choice) return reply(await msgMenuSubscriptionMenu(id));

    if (choice === "1") {
      await setUserStatus(id, ST.WAIT_PLAN);
      return reply(await msgPlansOnly());
    }

    if (choice === "2") {
      const subId = await getAsaasSubscriptionId(id);
      if (!subId) return reply(`${await msgMenuCancelNotFound(id)}\n\n${await msgMenuSubscriptionMenu(id)}`);

      let nextDue = "";
      try {
        const sub = await getSubscription({ subscriptionId: subId });
        nextDue = String(sub?.nextDueDate || sub?.nextPaymentDate || "").trim();
        if (nextDue) await setCardValidUntil(id, nextDue);
      } catch (_) {}

      await cancelSubscription({ subscriptionId: subId });
      await setCardCanceledAt(id, new Date().toISOString());

      const renewalBr = formatDateBR(nextDue) || formatDateBR(await getCardValidUntil(id)) || "—";
      const days = daysUntilISO(nextDue || (await getCardValidUntil(id)));
      const daysLeft = typeof days === "number" ? String(days) : "—";

      await setUserStatus(id, ST.WAIT_MENU_SUBSCRIPTION);
      return reply(`${await msgMenuCancelOk(id, { renewalBr, daysLeft })}\n\n${await msgMenuSubscriptionMenu(id)}`);
    }

    if (choice === "3") {
      return reply(`${await msgMenuUrlHelp(id)}\n\n${await msgMenuSubscriptionMenu(id)}`);
    }

    await setUserStatus(id, ST.WAIT_MENU);
    return reply(await msgMenuMain(id));
  }

  if (status === ST.WAIT_MENU_EDIT_ROOT) {
    const choice = normalizeChoiceMax(inbound, 5);
    if (!choice) return reply(await msgMenuEditRoot());

    if (choice === "1") {
      await setUserStatus(id, ST.WAIT_MENU_EDIT_PERSONAL);
      return reply(await msgMenuEditPersonal(id));
    }
    if (choice === "2") {
      await setUserStatus(id, ST.WAIT_MENU_EDIT_COMPANY);
      return reply(await msgMenuEditCompany(id));
    }
    if (choice === "3") {
      await setUserStatus(id, ST.WAIT_MENU_EDIT_FLOW);
      return reply(await msgMenuEditFlow(id));
    }
    if (choice === "4") {
      return reply(`${await msgMenuUrlHelp(id)}\n\n${await msgMenuEditRoot()}`);
    }

    await setUserStatus(id, ST.WAIT_MENU);
    return reply(await msgMenuMain(id));
  }

  if (status === ST.WAIT_MENU_EDIT_PERSONAL) {
    const choice = normalizeChoiceMax(inbound, 5);
    if (!choice) return reply(await msgMenuEditPersonal(id));

    if (choice === "1") {
      await clearMenuEditContext(id);
      await setUserStatus(id, ST.WAIT_MENU_NEW_NAME);
      return reply(await msgMenuAskNewName(id));
    }
    if (choice === "2") {
      await clearMenuEditContext(id);
      await setUserStatus(id, ST.WAIT_MENU_NEW_DOC);
      return reply(await msgMenuAskNewDoc(id));
    }
    if (choice === "3") {
      await setMenuEditContext(id, { scope: "PERSONAL", field: "billingCityState" });
      await setUserStatus(id, ST.WAIT_MENU_EDIT_FIELD);
      return reply(await msgMenuAskEditField(id, { field: "billingCityState" }));
    }
    if (choice === "4") {
      await setMenuEditContext(id, { scope: "PERSONAL", field: "billingAddress" });
      await setUserStatus(id, ST.WAIT_MENU_EDIT_FIELD);
      return reply(await msgMenuAskEditField(id, { field: "billingAddress" }));
    }

    await setUserStatus(id, ST.WAIT_MENU_EDIT_ROOT);
    return reply(await msgMenuEditRoot());
  }

  if (status === ST.WAIT_MENU_EDIT_COMPANY) {
    const choice = normalizeChoiceMax(inbound, 8);
    if (!choice) return reply(await msgMenuEditCompany(id));

    const mapping = {
      "1": "companyName",
      "2": "whatsapp",
      "3": "location",
      "4": "hours",
      "5": "socials",
      "6": "website",
      "7": "productList",
    };

    if (choice === "8") {
      await setUserStatus(id, ST.WAIT_MENU_EDIT_ROOT);
      return reply(await msgMenuEditRoot());
    }

    const field = mapping[choice];
    if (!field) return reply(await msgMenuEditCompany(id));

    await setMenuEditContext(id, { scope: "COMPANY", field });
    await setUserStatus(id, ST.WAIT_MENU_EDIT_FIELD);
    return reply(await msgMenuAskEditField(id, { field }));
  }

  if (status === ST.WAIT_MENU_EDIT_FLOW) {
    const choice = normalizeChoiceMax(inbound, 3);
    if (!choice) return reply(await msgMenuEditFlow(id));

    if (choice === "1") {
      await setTemplateMode(id, "FIXED");
      return reply(`${await msgTemplateSet(id, "FIXED")}\n\n${await msgMenuEditFlow(id)}`);
    }
    if (choice === "2") {
      await setTemplateMode(id, "FREE");
      return reply(`${await msgTemplateSet(id, "FREE")}\n\n${await msgMenuEditFlow(id)}`);
    }

    await setUserStatus(id, ST.WAIT_MENU_EDIT_ROOT);
    return reply(await msgMenuEditRoot());
  }

  // 0.1) MENU — alteração de nome
  if (status === ST.WAIT_MENU_NEW_NAME) {
    const name = inbound;
    if (name.length < 3) return reply(await getCopyText("FLOW_NAME_TOO_SHORT", { waId: id }));
    await setUserFullName(id, name);
    await clearMenuEditContext(id);
    await setUserStatus(id, ST.WAIT_MENU_EDIT_PERSONAL);
    return reply(`${await getCopyText("FLOW_MENU_NAME_UPDATED", { waId: id })}\n\n${await msgMenuEditPersonal(id)}`);
  }

  // 0.2) MENU — alteração de CPF/CNPJ
  if (status === ST.WAIT_MENU_NEW_DOC) {
    const v = validateDoc(inbound);
    if (!v.ok) return reply(await msgInvalidDoc(id));

    await setUserDocMasked(id, v.type, v.last4);
    await clearMenuEditContext(id);
    await setUserStatus(id, ST.WAIT_MENU_EDIT_PERSONAL);
    return reply(`${await getCopyText("FLOW_MENU_DOC_UPDATED", { waId: id })}\n\n${await msgMenuEditPersonal(id)}`);
  }

  if (status === ST.WAIT_MENU_EDIT_FIELD) {
    const ctx = await getMenuEditContext(id);
    if (!ctx?.field) {
      await setUserStatus(id, ST.WAIT_MENU_EDIT_ROOT);
      return reply(await msgMenuEditRoot());
    }

    if (wantsSkipCommand(inbound)) {
      await clearMenuEditContext(id);
      const backTo = ctx.scope === "COMPANY" ? ST.WAIT_MENU_EDIT_COMPANY : ST.WAIT_MENU_EDIT_PERSONAL;
      await setUserStatus(id, backTo);
      return reply(ctx.scope === "COMPANY" ? await msgMenuEditCompany(id) : await msgMenuEditPersonal(id));
    }

    if (ctx.scope === "PERSONAL") {
      if (ctx.field === "billingCityState") {
        const v = String(inbound || "").trim();
        if (!v) return reply(await msgMenuAskEditField(id, ctx));
        await setBillingCityState(id, v);
      } else if (ctx.field === "billingAddress") {
        const v = String(inbound || "").trim();
        if (!v) return reply(await msgMenuAskEditField(id, ctx));
        await setBillingAddress(id, v.toUpperCase() === "APENAS ONLINE" ? "APENAS ONLINE" : v);
      }
      await clearMenuEditContext(id);
      await setUserStatus(id, ST.WAIT_MENU_EDIT_PERSONAL);
      return reply(`✅ Dado atualizado!\n\n${await msgMenuEditPersonal(id)}`);
    }

    const profile = (await getBizProfile(id)) || {};
    if (ctx.field === "companyName") {
      profile.companyName = inbound;
    } else if (ctx.field === "whatsapp") {
      profile.whatsapp = normalizeWhatsappLike(inbound);
    } else if (ctx.field === "location") {
      profile.location = upper(inbound) === "APENAS ATENDIMENTO ONLINE" ? "Apenas atendimento online" : inbound;
    } else if (ctx.field === "hours") {
      profile.hours = inbound;
    } else if (ctx.field === "socials") {
      const socials = splitSocialInputs(inbound);
      if (!socials.length) return reply(await msgMenuAskEditField(id, ctx));
      profile.socials = Array.from(new Set(socials));
    } else if (ctx.field === "website") {
      const url = normalizeUrlLike(inbound) || String(inbound || "").trim();
      if (!url) return reply(await msgMenuAskEditField(id, ctx));
      profile.website = url;
    } else if (ctx.field === "productList") {
      const url = normalizeUrlLike(inbound) || String(inbound || "").trim();
      if (!url) return reply(await msgMenuAskEditField(id, ctx));
      profile.productList = url;
    }

    await setBizProfile(id, profile);
    await clearMenuEditContext(id);
    await setUserStatus(id, ST.WAIT_MENU_EDIT_COMPANY);
    return reply(`✅ Dado atualizado!\n\n${await msgMenuEditCompany(id)}`);
  }

  // 0.25) MENU — Dados da empresa (visualizar/atualizar)
  if (status === ST.WAIT_MENU_PROFILE) {
    const c = normalizeChoice(inbound);

    if (c !== "1" && c !== "2" && c !== "3") {
      return reply(await getCopyText("FLOW_MENU_PROFILE_INVALID_CHOICE", { waId: id }));
    }

    if (c === "1") {
      const current = await getBizProfile(id);
      await setPendingBizProfile(id, (current && typeof current === "object") ? current : {});
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_COMPANY);
      return reply(withMenuHint(await getCopyText("FLOW_PROFILE_WIZARD_INTRO", { waId: id })));
    }

    if (c === "2") {
      await clearBizProfile(id);
      await clearPendingBizProfile(id);
      await setUserStatus(id, ST.WAIT_MENU_EDIT_COMPANY);
      return reply(`✅ Dados da empresa removidos.\n\n${await msgMenuEditCompany(id)}`);
    }

    await setUserStatus(id, ST.WAIT_MENU_EDIT_COMPANY);
    return reply(await msgMenuEditCompany(id));
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

    const currentBiz = await getBizProfile(id);
    await setPendingBizProfile(id, (currentBiz && typeof currentBiz === "object") ? currentBiz : {});
    await setUserStatus(id, ST.WAIT_SAVE_PROFILE);
    return replyMulti([await msgTemplateSet(id, mode), await msgAskProfileRegistration(id)]);
  }

  // 0.4) Pós-anúncio — cadastro dos dados da empresa (1/2)
  if (status === ST.WAIT_SAVE_PROFILE) {
    const c = normalizeChoice(inbound);

    if (c === "1") {
      const current = await getBizProfile(id);
      const pending =
        (await getPendingBizProfile(id)) ||
        (current && typeof current === "object" ? current : {});

      await setPendingBizProfile(id, pending);
      await setUserStatus(id, ST.WAIT_PROFILE_ADD_COMPANY);

      const msg = [
        await getCopyText("FLOW_PROFILE_WIZARD_INTRO", { waId: id }),
        "",
        await getCopyText("FLOW_PROFILE_WIZARD_STEP1_COMPANY", { waId: id }),
      ].join("\n");
      return reply(msg);
    }

    if (c === "2") {
      await clearPendingBizProfile(id);

      const prev = await getPrevStatus(id);
      await clearPrevStatus(id);
      if (prev && prev !== ST.WAIT_SAVE_PROFILE) await setUserStatus(id, prev);
      else await setUserStatus(id, ST.WAIT_PRODUCT);

      const isTrialNow = prev !== ST.ACTIVE;
      const maxRef = await resolveMaxRefinementsForUser(id, isTrialNow);
      return replyMulti([await msgAfterSaveProfile(id, false, maxRef)]);
    }

    return reply(await msgAskProfileRegistration(id));
  }


  // 0.45) Complemento de informações antes de gerar anúncio
  if (status === ST.WAIT_CATEGORY_DETAILS) {
    const intake = await getAdSessionPayload(id);

    if (!intake?.baseText) {
      await clearAdSessionPayload(id);
      await setUserStatus(id, ST.WAIT_PRODUCT);
      return reply(await msgAskProduct(id));
    }

    const baseStatus = intake.prevStatus === ST.ACTIVE ? ST.ACTIVE : ST.TRIAL;
    const isTrialFlow = baseStatus !== ST.ACTIVE;

    await clearAdSessionPayload(id);
    await setUserStatus(id, baseStatus);

    if (wantsSkipCommand(inbound) || wantsOkCommand(inbound)) {
      return await handleGenerateAdInTrialOrActive({
        waId: id,
        inboundText: intake.baseText,
        isTrial: isTrialFlow,
        currentStatus: baseStatus,
        skipCategoryIntake: true,
      });
    }

    const combinedText = buildLeadIntakeCombinedText(intake.baseText, inbound);
    return await handleGenerateAdInTrialOrActive({
      waId: id,
      inboundText: combinedText,
      isTrial: isTrialFlow,
      currentStatus: baseStatus,
      skipCategoryIntake: true,
    });
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
        if (wa.length >= 8) profile.whatsapp = normalizeWhatsappLike(wa);
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

  // 6) Documento (CPF/CNPJ) + prepara cobrança
  if (status === ST.WAIT_DOC) {
    const v = validateDoc(inbound);
    if (!v.ok) return reply(await msgInvalidDoc(id));

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

    const customerId = await ensureAsaasCustomer({ waId: id, fullName: await getUserFullName(id), cpfCnpj: v.digits });
    return reply(await createPendingChargeMessage({ waId: id, method: pm, customerId, plan }));
  }

  // 6.1) Cidade/UF (solicitada após pagamento confirmado)
  if (status === ST.WAIT_BILLING_CITY_STATE) {
    const v = String(inbound || "").trim();
    if (!v) return reply(await msgAskBillingCityState(id));

    await setBillingCityState(id, v);
    await setUserStatus(id, ST.WAIT_BILLING_ADDRESS);
    return reply(await msgAskBillingAddress(id));
  }

  // 6.2) Endereço (solicitado após pagamento confirmado)
  if (status === ST.WAIT_BILLING_ADDRESS) {
    const v = String(inbound || "").trim();
    if (!v) return reply(await msgAskBillingAddress(id));

    const addr = v.toUpperCase() === "APENAS ONLINE" ? "APENAS ONLINE" : v;
    await setBillingAddress(id, addr);
    await setUserStatus(id, ST.ACTIVE);
    return reply(withMenuHint(["✅ Pronto! Seus dados de cobrança foram atualizados com sucesso.", "", "Agora você já pode continuar usando o Amigo normalmente. 🚀"].join("
")));
  }

  // 7) Pagamento pendente
  if (status === ST.PAYMENT_PENDING) {
    if (wantsChangePaymentMethodCommand(inbound)) {
      const planCode = await getUserPlan(id);
      const plan = (await getMenuPlans()).find((p) => p.code === planCode);
      if (!plan) {
        await setUserStatus(id, ST.WAIT_PLAN);
        return reply(await msgPlansOnly());
      }
      await setUserStatus(id, ST.WAIT_PAYMENT_METHOD);
      return reply(withMenuHint(`Perfeito! ✅ Vamos mudar a forma de pagamento.\n\n${await getCopyText("FLOW_ASK_PAYMENT_METHOD_WITH_PLAN", { waId: id, vars: { planName: plan?.name || "", planPrice: plan?.priceCents ? moneyBRFromCents(plan.priceCents) : "" } })}`));
    }

    const planCode = await getUserPlan(id);
    const plan = (await getMenuPlans()).find((p) => p.code === planCode);
    const planTxt = plan ? `Plano: *${plan.name}*.` : "";
    return reply(await getCopyText("FLOW_PAYMENT_PENDING", { waId: id, vars: { planTxt } }));
  }

  // 8) ACTIVE
  if (status === ST.ACTIVE) {
    if (isGreeting(inbound)) return reply(await msgAskProduct(id));
    return await handleGenerateAdInTrialOrActive({ waId: id, inboundText: inbound, isTrial: false, currentStatus: status });
  }

  // fallback seguro
  return reply(await getCopyText("FLOW_FALLBACK_UNKNOWN", { waId: id }));
}

async function getRefinementPolicyForUser(waId, isTrial) {
  const DEFAULT_MAX_REFINEMENTS = 2;

  if (isTrial) {
    return {
      isTrial: true,
      planCode: "",
      maxRefinements: DEFAULT_MAX_REFINEMENTS,
      source: "TRIAL_DEFAULT",
    };
  }

  const planCode = await getUserPlan(waId);
  if (!planCode) {
    return {
      isTrial: false,
      planCode: "",
      maxRefinements: DEFAULT_MAX_REFINEMENTS,
      source: "NO_PLAN_DEFAULT",
    };
  }

  let plan = await getPlan(planCode);
  if (!plan) {
    plan = (await getMenuPlans()).find((p) => p.code === planCode) || null;
  }

  const fromPlan = Number(plan?.maxRefinements);
  const maxRefinements =
    Number.isFinite(fromPlan) && fromPlan >= 0
      ? Math.trunc(fromPlan)
      : DEFAULT_MAX_REFINEMENTS;

  return {
    isTrial: false,
    planCode,
    maxRefinements,
    source: plan ? "PLAN" : "PLAN_NOT_FOUND_DEFAULT",
  };
}

async function resolveMaxRefinementsForUser(waId, isTrial) {
  const policy = await getRefinementPolicyForUser(waId, isTrial);
  return policy.maxRefinements;
}

async function handlePostAdDecisionCommand({ waId, inboundText }) {
  const lastAd = await getLastAd(waId);
  if (!lastAd) return null;
  if (!wantsOkCommand(inboundText)) return null;

  await clearLastAd(waId);
  await clearRefineCount(waId);
  await clearLastPrompt(waId);

  return reply(await getCopyText("FLOW_OK_NEXT_DESCRIPTION", { waId }));
}

// -------------------- Generate Ad --------------------
async function handleGenerateAdInTrialOrActive({ waId, inboundText, isTrial, currentStatus, skipCategoryIntake = false }) {
  const id = waId;
  const userText = inboundText;

  const postAdDecision = await handlePostAdDecisionCommand({ waId: id, inboundText: userText });
  if (postAdDecision) return postAdDecision;

  const lastAd = await getLastAd(id);
  const isRefinement = !!lastAd;
  const bizProfile = await getBizProfile(id);

  if (!isRefinement && !skipCategoryIntake) {
    const intakePlan = buildCategoryIntakePlan({ text: userText, bizProfile, attemptCount: 0 });
    if (intakePlan.shouldAsk) {
      await setAdSessionPayload(id, {
        kind: "CATEGORY_DETAILS",
        baseText: userText,
        prevStatus: currentStatus || (isTrial ? ST.TRIAL : ST.ACTIVE),
        categoryKey: intakePlan.schema.key,
        categoryLabel: intakePlan.schema.label,
        askedFieldKeys: intakePlan.fieldsToAsk.map((field) => field.key),
        scoreBeforeAsk: intakePlan.completeness.score,
        attemptCount: 1,
      });
      await setUserStatus(id, ST.WAIT_CATEGORY_DETAILS);
      return reply(intakePlan.prompt);
    }
  }

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
    const bizContext = buildBizProfileContext(bizProfile);
    const promptToSend = buildGenerationPrompt({
      userText,
      lastAd,
      isRefinement,
      bizContext,
    });

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

  let formattedAd = enforceAdFormatting(ad);
  formattedAd = sanitizeGeneratedAd(formattedAd, bizProfile);
  formattedAd = applyPersistentBusinessInfo(formattedAd, bizProfile, userText, isRefinement);
  formattedAd = sanitizeGeneratedAd(formattedAd, bizProfile);
  formattedAd = enforceAdFormatting(formattedAd);

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
  const refineMsg = await msgRefinementPrompt(id, maxRefinements);
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
