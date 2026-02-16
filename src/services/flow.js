import {
  ensureUserExists,
  getUserStatus,
  setUserStatus,
  getUserTrialUsed,
  incUserTrialUsed,
  setLastPrompt,
  getUserPlan,
  getTemplateMode,
  setTemplateMode,
} from "./state.js";

import { generateAdText } from "./openai/generate.js";

const TRIAL_LIMIT = 5;

// filtro simples para evitar custo com “oi”, “teste”, etc.
function isTooShortForGeneration(text) {
  const t = String(text || "").trim();
  if (t.length < 8) return true;
  const upper = t.toUpperCase();
  if (upper === "OI" || upper === "OLÁ" || upper === "OLA" || upper === "TESTE") return true;
  return false;
}

function msgChoosePlan() {
  return (
    `😄 Seu trial gratuito foi concluído!\n\n` +
    `Para continuar, escolha um plano.\n\n` +
    `💳 Responda com a palavra *PLANOS* para ver as opções.`
  );
}

function msgPlansList() {
  return (
    `📌 *Planos disponíveis*\n\n` +
    `🟦 *De Vez em Quando*\n` +
    `Ideal para uso leve.\n\n` +
    `🟩 *Profissional*\n` +
    `Para quem vende todo dia.\n\n` +
    `🟨 *Premium*\n` +
    `Para alto volume + recursos avançados (ex.: áudio).\n\n` +
    `👉 Para contratar, me diga qual plano você quer: *DE_VEZ_EM_QUANDO*, *PROFISSIONAL* ou *PREMIUM*.`
  );
}

function msgWaitingPlan() {
  return `📌 Você precisa escolher um plano para continuar.\n\nResponda *PLANOS* para ver as opções.`;
}

function msgPaymentPending() {
  return `⏳ Seu pagamento ainda está pendente.\n\nAssim que compensar, eu libero automaticamente.`;
}

function msgBlocked() {
  return `🚫 Seu acesso está bloqueado no momento.\nSe achar que foi um engano, fale com o suporte.`;
}

function msgAskTemplateChoice(currentMode) {
  const modeTxt = currentMode === "FREE" ? "LIVRE" : "FIXO";
  return (
    `\n\n—\n` +
    `📌 *Formatação atual:* ${modeTxt}\n` +
    `Quer manter assim?\n\n` +
    `✅ Responda *FIXO* para manter o template\n` +
    `✨ Responda *LIVRE* para eu formatar do meu jeito\n\n` +
    `Obs.: na prática, o template fixo costuma converter melhor no WhatsApp por ser mais rápido de ler e ter CTA claro.`
  );
}

export async function handleInboundText({ waId, text }) {
  const clean = String(text || "").trim();
  if (!waId || !clean) return { shouldReply: false, replyText: "" };

  await ensureUserExists(waId);
  await setLastPrompt(waId, clean);

  const upper = clean.toUpperCase();

  // comandos de template
  if (upper === "FIXO" || upper === "TEMPLATE") {
    await setTemplateMode(waId, "FIXED");
    return {
      shouldReply: true,
      replyText: `Perfeito ✅ A partir de agora vou manter o *template fixo* nas descrições.`,
    };
  }
  if (upper === "LIVRE") {
    await setTemplateMode(waId, "FREE");
    return {
      shouldReply: true,
      replyText: `Fechado ✨ A partir de agora eu vou usar *formatação livre* (mais flexível).`,
    };
  }

  // comandos gerais
  if (upper === "PLANOS") {
    return { shouldReply: true, replyText: msgPlansList() };
  }

  // seleção de plano (placeholder: ainda não chama Asaas aqui)
  if (upper === "DE_VEZ_EM_QUANDO" || upper === "PROFISSIONAL" || upper === "PREMIUM") {
    return {
      shouldReply: true,
      replyText:
        `Perfeito ✅ Você escolheu *${upper}*.\n\n` +
        `⏳ Em breve vamos ligar a contratação automática (Asaas) no modular.\n` +
        `Por enquanto, essa etapa está em modo de validação.`,
    };
  }

  const status = await getUserStatus(waId);

  if (status === "BLOCKED") return { shouldReply: true, replyText: msgBlocked() };
  if (status === "PAYMENT_PENDING") return { shouldReply: true, replyText: msgPaymentPending() };
  if (status === "WAIT_PLAN") return { shouldReply: true, replyText: msgWaitingPlan() };

  // se for curto demais, evita custo OpenAI
  if (isTooShortForGeneration(clean)) {
    return {
      shouldReply: true,
      replyText:
        `Me manda uma descrição um pouquinho mais completa 🙂\n` +
        `Ex.: “vendo bolo de chocolate por R$30, entrego no bairro X”.`,
    };
  }

  // modo atual de template
  const mode = await getTemplateMode(waId);

  // ACTIVE: gera com OpenAI e pergunta preferência
  if (status === "ACTIVE") {
    const plan = await getUserPlan(waId);

    const { text: adText } = await generateAdText({
      userText: clean,
      mode,
      maxOutputTokens: 650,
    });

    return {
      shouldReply: true,
      replyText: `${adText}${msgAskTemplateChoice(mode)}\n\n📦 Plano: *${plan || "ATIVO"}*`,
    };
  }

  // TRIAL (padrão)
  if (status === "TRIAL" || status === "OTHER") {
    const usedBefore = await getUserTrialUsed(waId);

    if (usedBefore >= TRIAL_LIMIT) {
      await setUserStatus(waId, "WAIT_PLAN");
      return { shouldReply: true, replyText: msgChoosePlan() };
    }

    const usedNow = await incUserTrialUsed(waId, 1);

    if (usedNow > TRIAL_LIMIT) {
      await setUserStatus(waId, "WAIT_PLAN");
      return { shouldReply: true, replyText: msgChoosePlan() };
    }

    const { text: adText } = await generateAdText({
      userText: clean,
      mode,
      maxOutputTokens: 650,
    });

    const header = `🎁 *Trial (grátis)*: ${usedNow}/${TRIAL_LIMIT}`;

    if (usedNow === TRIAL_LIMIT) {
      return {
        shouldReply: true,
        replyText:
          `${adText}\n\n${header}` +
          `\n\n⚠️ Você acabou de usar a última descrição grátis.\n` +
          `Na próxima, você precisará escolher um plano (responda *PLANOS*).` +
          msgAskTemplateChoice(mode),
      };
    }

    return {
      shouldReply: true,
      replyText: `${adText}\n\n${header}${msgAskTemplateChoice(mode)}`,
    };
  }

  // fallback
  return { shouldReply: true, replyText: "✅ Recebi sua mensagem." };
}
