import {
  ensureUserExists,
  getUserStatus,
  setUserStatus,
  getUserTrialUsed,
  incUserTrialUsed,
  setLastPrompt,
  getUserPlan,
} from "./state.js";

const TRIAL_LIMIT = 5;

function msgTrialProgress(n) {
  return (
    `✅ Recebi sua solicitação de descrição.\n\n` +
    `🎁 *Trial (grátis)*: ${n}/${TRIAL_LIMIT}\n\n` +
    `⏳ Em breve vamos ligar o gerador completo (OpenAI) no modular.\n` +
    `Por enquanto, estou confirmando o recebimento para validarmos o fluxo.`
  );
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
  return (
    `📌 Você precisa escolher um plano para continuar.\n\n` +
    `Responda *PLANOS* para ver as opções.`
  );
}

function msgPaymentPending() {
  return (
    `⏳ Seu pagamento ainda está pendente.\n\n` +
    `Assim que compensar, eu libero automaticamente.`
  );
}

function msgBlocked() {
  return (
    `🚫 Seu acesso está bloqueado no momento.\n` +
    `Se achar que foi um engano, fale com o suporte.`
  );
}

function msgActivePlaceholder(plan) {
  return (
    `✅ Recebi sua solicitação.\n\n` +
    `📦 Plano: *${plan || "ATIVO"}*\n\n` +
    `⏳ Em breve vamos ligar o gerador completo (OpenAI) no modular.\n` +
    `Por enquanto, estou confirmando o recebimento para validarmos o fluxo.`
  );
}

export async function handleInboundText({ waId, text }) {
  const clean = String(text || "").trim();
  if (!waId || !clean) {
    return { shouldReply: false, replyText: "" };
  }

  // garante usuário
  await ensureUserExists(waId);

  // salva última solicitação (para futura geração/refino)
  await setLastPrompt(waId, clean);

  const upper = clean.toUpperCase();

  // comandos simples
  if (upper === "PLANOS") {
    return { shouldReply: true, replyText: msgPlansList() };
  }

  // seleção de plano (placeholder: ainda não chama Asaas)
  if (upper === "DE_VEZ_EM_QUANDO" || upper === "PROFISSIONAL" || upper === "PREMIUM") {
    // Aqui futuramente você ligará a lógica real (Asaas / assinatura).
    // Por enquanto, só confirma e mantém WAIT_PLAN (não ativa de verdade sem cobrança).
    return {
      shouldReply: true,
      replyText:
        `Perfeito ✅ Você escolheu *${upper}*.\n\n` +
        `⏳ Em breve vamos ligar a contratação automática (Asaas) no modular.\n` +
        `Por enquanto, essa etapa está em modo de validação.`,
    };
  }

  // status atual
  const status = await getUserStatus(waId);

  if (status === "BLOCKED") {
    return { shouldReply: true, replyText: msgBlocked() };
  }

  if (status === "PAYMENT_PENDING") {
    return { shouldReply: true, replyText: msgPaymentPending() };
  }

  if (status === "WAIT_PLAN") {
    return { shouldReply: true, replyText: msgWaitingPlan() };
  }

  if (status === "ACTIVE") {
    const plan = await getUserPlan(waId);
    return { shouldReply: true, replyText: msgActivePlaceholder(plan) };
  }

  // TRIAL (padrão)
  if (status === "TRIAL" || status === "OTHER") {
    const usedBefore = await getUserTrialUsed(waId);

    // se já estourou
    if (usedBefore >= TRIAL_LIMIT) {
      await setUserStatus(waId, "WAIT_PLAN");
      return { shouldReply: true, replyText: msgChoosePlan() };
    }

    const usedNow = await incUserTrialUsed(waId, 1);

    // se ao incrementar passou do limite, já pede plano
    if (usedNow > TRIAL_LIMIT) {
      await setUserStatus(waId, "WAIT_PLAN");
      return { shouldReply: true, replyText: msgChoosePlan() };
    }

    // ainda dentro do trial
    if (usedNow === TRIAL_LIMIT) {
      // manda progresso e já avisa que acabou (opcional)
      return {
        shouldReply: true,
        replyText:
          msgTrialProgress(usedNow) +
          `\n\n⚠️ Você acabou de usar a última descrição grátis.\n` +
          `Na próxima, você precisará escolher um plano (responda *PLANOS*).`,
      };
    }

    return { shouldReply: true, replyText: msgTrialProgress(usedNow) };
  }

  // fallback
  return { shouldReply: true, replyText: "✅ Recebi sua mensagem." };
}
