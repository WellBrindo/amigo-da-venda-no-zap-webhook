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
  const ordered = order.map((c) => byCode.get(c)).filter(Boolean);

  // se tiver planos customizados além desses, adiciona ao final (em ordem alfabética)
  const extras = plans
    .filter((p) => !order.includes(String(p.code || "").toUpperCase()))
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));

  const finalList = [...ordered, ...extras];

  const lines = finalList.map((p, idx) => {
    const n = idx + 1;
    const price = formatBRLFromCents(p.priceCents);
    const quota = `${p.monthlyQuota} descrições/mês`;
    return `${n}) *${p.name}* — ${price} — ${quota}`;
  });

  return `📌 *Planos disponíveis*\n\n${lines.join("\n")}\n\n👉 Responda com *1*, *2* ou *3* para escolher.`;
}

async function pickPlanByNumber(n) {
  const plans = await listPlans({ includeInactive: false });
  if (!plans || plans.length === 0) return null;

  const order = ["DE_VEZ_EM_QUANDO", "SEMPRE_POR_PERTO", "MELHOR_AMIGO"];
  const byCode = new Map(plans.map((p) => [String(p.code || "").toUpperCase(), p]));
  const ordered = order.map((c) => byCode.get(c)).filter(Boolean);
  const extras = plans
    .filter((p) => !order.includes(String(p.code || "").toUpperCase()))
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));

  const finalList = [...ordered, ...extras];

  const idx = Number(n) - 1;
  if (!Number.isFinite(idx) || idx < 0 || idx >= finalList.length) return null;
  return finalList[idx];
}

// ===== Mensagens =====
function msgBlocked() {
  return `🚫 Seu acesso está bloqueado no momento.\nSe achar que foi um engano, fale com o suporte.`;
}

function msgPaymentPending() {
  return `⏳ Seu pagamento ainda está pendente.\n\nAssim que compensar, eu libero automaticamente.`;
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

function msgOpenAiFail() {
  return (
    `⚠️ Tive uma instabilidade rápida aqui.\n` +
    `Pode me enviar de novo a sua descrição? 🙂\n\n` +
    `Ex.: “vendo bolo de chocolate por R$30, entrego no bairro X”.`
  );
}

function msgNeedPlan() {
  return `📌 Para continuar, você precisa escolher um plano.\n\nResponda *1*, *2* ou *3*.`;
}

function normalizeUpper(text) {
  return String(text || "").trim().toUpperCase();
}

export async function handleInboundText({ waId, text }) {
  const clean = String(text || "").trim();
  if (!waId || !clean) return { shouldReply: false, replyText: "" };

  await ensureUserExists(waId);
  await setLastPrompt(waId, clean);

  const upper = normalizeUpper(clean);

  // ✅ assinatura (pra você validar versão em produção)
  const signature = `🧩 Flow ${FLOW_BUILD}`;

  // comandos de template
  if (upper === "FIXO" || upper === "TEMPLATE") {
    await setTemplateMode(waId, "FIXED");
    return {
      shouldReply: true,
      replyText: `${signature}\n\nPerfeito ✅ A partir de agora vou manter o *template fixo* nas descrições.`,
    };
  }
  if (upper === "LIVRE") {
    await setTemplateMode(waId, "FREE");
    return {
      shouldReply: true,
      replyText: `${signature}\n\nFechado ✨ A partir de agora eu vou usar *formatação livre* (mais flexível).`,
    };
  }

  // comando geral: PLANOS (ainda pode existir, mas não é obrigatório no fluxo)
  if (upper === "PLANOS") {
    const menu = await buildPlansMenuText();
    return { shouldReply: true, replyText: `${signature}\n\n${menu}` };
  }

  // atalho: aceitar também os códigos antigos por texto (não atrapalha)
  const isLegacyPlanWord = upper === "DE_VEZ_EM_QUANDO" || upper === "PROFISSIONAL" || upper === "PREMIUM";

  const status = await getUserStatus(waId);

  // status bloqueados/pagamento pendente
  if (status === "BLOCKED") return { shouldReply: true, replyText: `${signature}\n\n${msgBlocked()}` };
  if (status === "PAYMENT_PENDING") return { shouldReply: true, replyText: `${signature}\n\n${msgPaymentPending()}` };

  // se for curto demais, evita custo OpenAI
  if (isTooShortForGeneration(clean)) {
    return {
      shouldReply: true,
      replyText:
        `${signature}\n\n` +
        `Me manda uma descrição um pouquinho mais completa 🙂\n` +
        `Ex.: “vendo bolo de chocolate por R$30, entrego no bairro X”.`,
    };
  }

  // modo atual de template
  const mode = await getTemplateMode(waId);

  // =========================
  // 1) WAIT_PLAN (agora por 1/2/3)
  // =========================
  if (status === "WAIT_PLAN") {
    // aceita 1/2/3
    if (upper === "1" || upper === "2" || upper === "3") {
      const chosen = await pickPlanByNumber(upper);
      if (!chosen) {
        const menu = await buildPlansMenuText();
        return { shouldReply: true, replyText: `${signature}\n\n${menu}` };
      }

      await setUserPlan(waId, chosen.code);

      // ✅ Próximo passo (pagamento/CPF) entra depois; por enquanto vamos preparar
      // Criamos estados novos no state.js: WAIT_DOC e WAIT_PAY_METHOD
      await setUserStatus(waId, "WAIT_DOC");

      return {
        shouldReply: true,
        replyText:
          `${signature}\n\n` +
          `Perfeito ✅ Você escolheu o plano *${chosen.name}* (${formatBRLFromCents(chosen.priceCents)}).\n\n` +
          `Agora, para eu gerar e registrar o pagamento, preciso do seu *CPF ou CNPJ* (somente números).\n` +
          `Pode me enviar, por favor?\n\n` +
          `Fica tranquilo(a): eu uso só pra isso e não aparece em mensagens nem em logs.`,
      };
    }

    // mantém compatibilidade com o “PLANOS”
    if (upper === "PLANOS") {
      const menu = await buildPlansMenuText();
      return { shouldReply: true, replyText: `${signature}\n\n${menu}` };
    }

    // aceita palavras antigas (não recomendado, mas não vamos travar usuário)
    if (isLegacyPlanWord) {
      // mapa simples antigo -> novo (best-effort)
      const map = {
        DE_VEZ_EM_QUANDO: "DE_VEZ_EM_QUANDO",
        PROFISSIONAL: "SEMPRE_POR_PERTO",
        PREMIUM: "MELHOR_AMIGO",
      };
      const code = map[upper] || "";
      if (code) {
        await setUserPlan(waId, code);
        await setUserStatus(waId, "WAIT_DOC");
        return {
          shouldReply: true,
          replyText:
            `${signature}\n\n` +
            `Perfeito ✅ Plano selecionado.\n\n` +
            `Agora me envie seu *CPF ou CNPJ* (somente números), por favor.\n\n` +
            `Fica tranquilo(a): eu uso só pra isso e não aparece em mensagens nem em logs.`,
        };
      }
    }

    // se usuário digitar outra coisa
    const menu = await buildPlansMenuText();
    return { shouldReply: true, replyText: `${signature}\n\n${msgNeedPlan()}\n\n${menu}` };
  }

  // =========================
  // 2) WAIT_DOC (passo seguinte do pagamento)
  // =========================
  // Aqui ainda NÃO vamos validar DV nem chamar Asaas (isso é o Passo 16.4/16.5).
  // Mas já deixamos a UX pronta.
  if (status === "WAIT_DOC") {
    // por enquanto só orienta (validação DV entra no próximo passo)
    const digits = clean.replace(/\D+/g, "");
    if (digits.length !== 11 && digits.length !== 14) {
      return {
        shouldReply: true,
        replyText:
          `${signature}\n\n` +
          `Uhmm… acho que algum dígito ficou diferente aí 🥺😄\n` +
          `Dá uma olhadinha e me envia de novo, por favor, somente números:\n\n` +
          `CPF: 11 dígitos\n` +
          `CNPJ: 14 dígitos`,
      };
    }

    // Vamos só confirmar que recebemos (sem logar, sem ecoar número).
    // DV e Asaas entram no próximo passo.
    await setUserStatus(waId, "WAIT_PAY_METHOD");

    return {
      shouldReply: true,
      replyText:
        `${signature}\n\n` +
        `Perfeito ✅ Agora me diga como você prefere pagar:\n\n` +
        `1) 💳 *Cartão* (assinatura mensal automática)\n` +
        `2) 🧾 *PIX* (pagamento mensal avulso)\n\n` +
        `👉 Responda com *1* ou *2*.`,
    };
  }

  // =========================
  // 3) WAIT_PAY_METHOD (pagamento)
  // =========================
  if (status === "WAIT_PAY_METHOD") {
    if (upper === "1" || upper === "2") {
      // Aqui entra Asaas no próximo passo (16.4/16.5).
      // Por enquanto: placeholder claro.
      await setUserStatus(waId, "PAYMENT_PENDING");
      return {
        shouldReply: true,
        replyText:
          `${signature}\n\n` +
          `Perfeito ✅ Entendi.\n\n` +
          `⏳ Próximo passo: vou gerar seu pagamento automaticamente (Asaas).\n` +
          `Essa etapa entra no *PASSO 16.4*.\n\n` +
          `Assim que estiver pronto, eu libero automaticamente.`,
      };
    }

    return {
      shouldReply: true,
      replyText:
        `${signature}\n\n` +
        `Só para eu seguir certinho 🙂\n` +
        `Responda com:\n\n` +
        `1) Cartão\n` +
        `2) PIX`,
    };
  }

  // =========================
  // 4) ACTIVE: gera com OpenAI e pergunta preferência
  // =========================
  if (status === "ACTIVE") {
    const plan = await getUserPlan(waId);

    try {
      const { text: adText } = await generateAdText({
        userText: clean,
        mode,
        maxOutputTokens: 650,
      });

      return {
        shouldReply: true,
        replyText: `${signature}\n\n${adText}${msgAskTemplateChoice(mode)}\n\n📦 Plano: *${plan || "ATIVO"}*`,
      };
    } catch {
      return { shouldReply: true, replyText: `${signature}\n\n${msgOpenAiFail()}` };
    }
  }

  // =========================
  // 5) TRIAL: gera com OpenAI e ao acabar mostra planos direto
  // =========================
  if (status === "TRIAL" || status === "OTHER") {
    const usedBefore = await getUserTrialUsed(waId);

    if (usedBefore >= TRIAL_LIMIT) {
      await setUserStatus(waId, "WAIT_PLAN");
      const menu = await buildPlansMenuText();
      return {
        shouldReply: true,
        replyText:
          `${signature}\n\n` +
          `😄 Seu trial gratuito foi concluído!\n\n` +
          `Para continuar, escolha um plano:\n\n` +
          `${menu}`,
      };
    }

    const usedNow = await incUserTrialUsed(waId, 1);

    if (usedNow > TRIAL_LIMIT) {
      await setUserStatus(waId, "WAIT_PLAN");
      const menu = await buildPlansMenuText();
      return {
        shouldReply: true,
        replyText:
          `${signature}\n\n` +
          `😄 Seu trial gratuito foi concluído!\n\n` +
          `Para continuar, escolha um plano:\n\n` +
          `${menu}`,
      };
    }

    try {
      const { text: adText } = await generateAdText({
        userText: clean,
        mode,
        maxOutputTokens: 650,
      });

      const header = `🎁 *Trial (grátis)*: ${usedNow}/${TRIAL_LIMIT}`;

      // se acabou agora, já mostra planos direto (sem “PLANOS”)
      if (usedNow === TRIAL_LIMIT) {
        await setUserStatus(waId, "WAIT_PLAN");
        const menu = await buildPlansMenuText();

        return {
          shouldReply: true,
          replyText:
            `${signature}\n\n` +
            `${adText}\n\n${header}` +
            `\n\n⚠️ Você acabou de usar a última descrição grátis.\n` +
            `Para continuar, escolha um plano agora:\n\n` +
            `${menu}` +
            msgAskTemplateChoice(mode),
        };
      }

      return {
        shouldReply: true,
        replyText: `${signature}\n\n${adText}\n\n${header}${msgAskTemplateChoice(mode)}`,
      };
    } catch {
      return { shouldReply: true, replyText: `${signature}\n\n${msgOpenAiFail()}` };
    }
  }

  // fallback
  return { shouldReply: true, replyText: `${signature}\n\n✅ Recebi sua mensagem.` };
}
