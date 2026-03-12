// src/services/copy.js
// V16.6.0 — Central de textos (Copy) editável via Admin.
// Regras:
// - Texto padrão (DEFAULT_COPY) é fallback (não depende do Redis)
// - Override global: copy:global:{KEY}
// - Override por usuário: copy:user:{waId}:{KEY}
// - Index de chaves conhecidas: copy:index (SET) — evita scan e mantém compatibilidade

import { redisGet, redisSet, redisDel, redisSAdd, redisSMembers } from "./redis.js";
import { getUserFullName } from "./state.js";

const KEY_INDEX = "copy:index";
const K_GLOBAL = (key) => `copy:global:${key}`;
const K_USER = (waId, key) => `copy:user:${waId}:${key}`;

function escapeKey(key) {
  return String(key || "").trim().toUpperCase();
}

function applyVars(text, vars = {}) {
  let out = String(text ?? "");
  // {{var}} simples
  out = out.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => {
    const v = vars?.[k];
    return v === undefined || v === null ? "" : String(v);
  });
  return out;
}


async function resolveVars({ waId = null, vars = null } = {}) {
  const base = vars && typeof vars === "object" ? { ...vars } : {};
  if (!waId) return base;

  // Auto vars (não dependem do fluxo passar "vars")
  try {
    const fullName = String((await getUserFullName(String(waId))) || "").trim();
    const firstName = fullName ? fullName.split(/\s+/)[0] : "";
    base.fullName = base.fullName ?? fullName;
    base.firstName = base.firstName ?? firstName;
    base.firstNameComma =
      base.firstNameComma ??
      (firstName ? `, *${firstName}*` : "");
  } catch (_) {
    // silencioso: não quebrar produção por erro de redis
  }

  return base;
}
// ==============================
// DEFAULT COPY (FALLBACK)
// ==============================
// Observação: manter chaves estáveis; a UI do Admin trabalha em cima dessas keys.
export const DEFAULT_COPY = Object.freeze({
  // FLOW — Identidade / Onboarding
  FLOW_WELCOME: "Oi! 👋😊\n\nEu sou o *Amigo das Vendas*.",
  FLOW_MENU_HINT: "A qualquer momento, você pode digitar *MENU* para acessar as opções de configuração.",
  FLOW_ASK_NAME: `Oi! 👋😊

Eu sou o Amigo das Vendas — pode me chamar de Amigo.

Você me diz o que você vende ou o serviço que você presta, e eu te devolvo um anúncio prontinho pra você copiar e mandar nos grupos do WhatsApp.

Antes que eu esqueça 😄
Qual é o seu NOME COMPLETO?

A qualquer momento, você pode digitar *MENU* para acessar as opções de configuração.`,

  // FLOW — Coleta de contexto
  FLOW_ASK_PRODUCT: "Perfeito{{firstNameComma}}! ✅\n\nAgora me diga: *o que você vende* ou *qual serviço você presta*?\n\nPode ser simples, tipo: “vendo bolo R$30” 😄",
  FLOW_ASK_REFINEMENT: "Certo! ✅\n\nAgora me diga o que você quer *melhorar* nesse anúncio.\n\nExemplo: “deixa mais curto”, “coloca mais emoção”, “foca no preço”, etc.",
  FLOW_ASK_TEMPLATE_CHOICE:
    "Agora me diga como você prefere as próximas descrições:\n\n1) *Modelo FIXO* (padrão, sempre no mesmo formato)\n2) *Modelo LIVRE* (o Amigo escolhe o melhor formato)\n\nResponda com *1* ou *2* 🙂",


  FLOW_ASK_TEMPLATE_CHOICE_LONG:
    "Quer manter a estrutura do anúncio como *FIXO* (Template) ou prefere *LIVRE* (formatação por pedido)?\n\n📌 *Por que isso importa?*\nA gente atualiza nossos templates com frequência para acompanhar tendências de mercado e melhorar a conversão.\n\n✅ Sua escolha atual: *{{modeLabel}}*\n\n1) *FIXO* — eu mantenho a estrutura padrão (o que costuma converter mais)\n2) *LIVRE* — você me diz como quer a estrutura em cada refinamento\n\nResponda com *1* ou *2* (ou digite *TEMPLATE* / *LIVRE* a qualquer momento).",

  FLOW_TEMPLATE_SET_FIXED: "Perfeito! ✅ Vou deixar como padrão o modelo *FIXO (Template)*.\n\nQuando quiser mudar para livre, digite *LIVRE*.\nE a qualquer momento você pode digitar *MENU* para ajustar.",
  FLOW_TEMPLATE_SET_FREE: "Perfeito! ✅ Vou deixar como padrão a formatação *LIVRE*.\n\nQuando quiser voltar para o modelo FIXO, digite *TEMPLATE*.\nE a qualquer momento você pode digitar *MENU* para ajustar.",

  // FLOW — Trial / Limites
  FLOW_TRIAL_BLOCKED:
    "Seu teste grátis acabou 😄\n\nPara continuar, escolha um plano:\n\n1️⃣ *De Vez em Quando* — R$ 24,90 (20 descrições/mês)\n2️⃣ *Sempre por Perto* — R$ 34,90 (60 descrições/mês)\n3️⃣ *Melhor Amigo* — R$ 49,90 (200 descrições/mês)\n\nResponda com *1*, *2* ou *3*.",

  FLOW_TRIAL_PREFIX: "Seu teste grátis acabou 😄",

  // FLOW — Fallback de planos (quando o Redis não tem planos cadastrados)
  FLOW_PLANS_FALLBACK_STATIC:
    `Seu teste grátis acabou 😄

Para continuar, escolha um plano:

1️⃣ *De Vez em Quando* — R$ 24,90 (20 descrições/mês)
2️⃣ *Sempre por Perto* — R$ 34,90 (60 descrições/mês)
3️⃣ *Melhor Amigo* — R$ 49,90 (200 descrições/mês)

Responda com *1*, *2* ou *3*.`,


  FLOW_PLANS_ONLY_HEADER: "Para continuar, escolha um plano:",
  FLOW_PLANS_ONLY_FOOTER: "Responda com *1*, *2* ou *3*.",

  FLOW_QUOTA_BLOCKED:
    "Você atingiu o limite do seu plano neste mês 😕\n\nSe quiser, posso te ajudar a escolher um plano maior.\n\nResponda: *PLANOS*",

  FLOW_UNKNOWN_COMMAND:
    "Uhmm… acho que não entendi 😄\n\nMe envie uma descrição do que você vende, ou responda com:\n\n• *PLANOS*\n• *TEMPLATE*\n• *AJUDA*",

  // FLOW — Pagamento
  FLOW_ASK_PAYMENT_METHOD:
    "Perfeito! ✅\n\nAgora escolha como prefere pagar:\n\n1) *PIX*\n2) *Cartão*\n\nResponda com *1* ou *2* 🙂",

  FLOW_ASK_DOC:
    "Nossa, quase esqueci 😄\n\nPra eu conseguir gerar e registrar o pagamento, preciso do seu CPF ou CNPJ (somente números).\n\nPode me enviar, por favor?\nFica tranquilo(a): eu uso só pra isso e não aparece em mensagens nem em logs. É totalmente *seguro* 🔒",

  FLOW_INVALID_DOC:
    "Uhmm… acho que algum dígito ficou diferente aí 🥺😄\nDá uma olhadinha e me envia de novo, por favor, somente números:\n\nCPF: 11 dígitos\n\nCNPJ: 14 dígitos",

  // FLOW — Validações pontuais
  FLOW_NAME_TOO_SHORT: "Me envia seu *nome completo* por favor 🙂",
  FLOW_INVALID_PAYMENT_METHOD: "Me diga *1* (Cartão) ou *2* (PIX), por favor 🙂",

  // FLOW — Pagamento (mensagens unificadas)
  // Vars:
  // - methodTitle: ex "Gerei sua cobrança via *PIX*." / "Agora é só concluir no *Cartão* (assinatura)."
  // - linkLine: ex "Pague por aqui: <url>\n\n" / "Finalize pelo link no Asaas.\n\n"
  FLOW_PAYMENT_SUCCESS:
    "✅ Pronto! {{methodTitle}}\n\n{{linkLine}}Assim que o pagamento for confirmado, seu plano ativa automaticamente. 🚀",

  // Vars: planTxt (opcional)
  FLOW_PAYMENT_PENDING:
    "Seu pagamento ainda está *pendente* no Asaas. {{planTxt}}\n\nAssim que confirmar, eu libero automaticamente. 🚀",

  FLOW_QUOTA_REACHED_PREFIX: "Você atingiu seu limite mensal 😅",

  FLOW_FALLBACK_UNKNOWN: "Não entendi 😅\n\nMe diga o que você vende ou qual serviço você presta, e eu monto o anúncio.",

  FLOW_OPENAI_ERROR:
    "Tive um probleminha técnico para gerar sua descrição agora 😕\n\nPode tentar novamente em alguns instantes?",


  FLOW_BLOCKED:
    "Seu acesso está bloqueado no momento. Se isso for um engano, fale com o suporte.",

  FLOW_AFTER_AD_TEMPLATE_CHOICE:
    "\n\nQuer manter o *template*?\n\n1) Sim (manter template)\n2) Quero *formatação livre*\n\n{{hint}}\n\nVocê também pode digitar *TEMPLATE* ou *LIVRE* a qualquer momento.",

  FLOW_ASK_SAVE_PROFILE:
    "Notei que você incluiu alguns dados da sua empresa. Quer que eu salve isso para usar automaticamente nos próximos anúncios?\n\nVou salvar:\n{{profileLines}}\n\n1) Sim, pode salvar\n2) Não, obrigado",

  FLOW_HINT_TEMPLATE_FIXED: "(*Hoje você está no TEMPLATE, que costuma converter mais.*)",
  FLOW_HINT_TEMPLATE_FREE: "(*Hoje você está no modo LIVRE.*)",

  FLOW_TEMPLATE_SWITCH_TO_FREE:
    "Fechado! ✅ A partir de agora vou gerar em *formatação livre*.\n\nQuando quiser voltar, digite *TEMPLATE*.",
  FLOW_TEMPLATE_KEEP_FIXED:
    "Boa! ✅ Vou manter o *template* (ele costuma converter mais).\n\nQuando quiser mudar, digite *LIVRE*.",

  FLOW_ASK_PAYMENT_METHOD_WITH_PLAN:
    "Show! ✅ Plano escolhido: *{{planName}}* (R$ {{planPrice}} / mês)\n\nAgora escolha a forma de pagamento:\n\n1) *Cartão* (assinatura recorrente)\n2) *PIX* (pagamento manual todo mês)\n\nResponda com *1* ou *2*.",

  // FLOW — MENU (comando "MENU")
  // FLOW — MENU (comando "MENU")
FLOW_MENU_MAIN:
  "MENU — Amigo das Vendas 📌\n\n1) Minha assinatura\n2) Alterar para Anuncio Fixo\n3) Alterar para Anuncio Livre\n4) Planos\n5) Cancelar plano (cartão)\n6) Alterar nome\n7) Alterar CPF/CNPJ\n8) Ajuda\n9) Elogios/Solicitações/Reclamações\n10) Instagram\n11) Dados da empresa (ver/atualizar)\n\nResponda com o número.\n\nSe quiser sair do menu, é só mandar sua próxima descrição 🙂",

FLOW_MENU_SUBSCRIPTION:
  "*Minha assinatura*\n\n📦 Plano: {{planName}}\n📌 Status: {{status}}\n💳 Pagamento: {{paymentMethodLabel}}\n📅 Vencimento / renovação: {{dueDate}}\n📊 Descrições utilizadas: {{used}} / {{total}}\n\n1) Alterar plano\n2) Cancelar plano\n3) Ajuda\n4) Voltar",
FLOW_MENU_EDIT_ROOT:
  "*Alterar dados preenchidos*\n\n1) Dados pessoais\n2) Dados da empresa\n3) Fluxo FIXO ou LIVRE\n4) Ajuda\n5) Voltar",
FLOW_MENU_EDIT_PERSONAL:
  "*Dados pessoais preenchidos*\n\n{{options}}\n\n5) Voltar\n\nResponda com o número do dado que você quer alterar.",
FLOW_MENU_EDIT_COMPANY:
  "*Dados da empresa preenchidos*\n\n{{options}}\n\n8) Voltar\n\nResponda com o número do dado que você quer alterar.",
FLOW_MENU_EDIT_TEMPLATE:
  "*Fluxo de anúncio*\n\nModo atual: *{{mode}}*\n\n1) Usar anúncio FIXO\n2) Usar anúncio LIVRE\n3) Voltar",
FLOW_MENU_EDIT_FIELD_FULLNAME:
  "Perfeito! ✅\n\nMe envie seu *nome completo* atualizado.",
FLOW_MENU_EDIT_FIELD_DOC:
  "Certo! ✅\n\nMe envie seu *CPF ou CNPJ* (somente números) para atualizar.",
FLOW_MENU_EDIT_FIELD_BILLING_CITY_STATE:
  "Perfeito! ✅\n\nMe envie a *Cidade/UF* que você quer salvar.\nEx.: Atibaia/SP",
FLOW_MENU_EDIT_FIELD_BILLING_ADDRESS:
  "Perfeito! ✅\n\nMe envie o *endereço* que você quer salvar.\nSe for somente online, responda *APENAS ONLINE*.",
FLOW_MENU_EDIT_FIELD_GENERIC:
  "Perfeito! ✅\n\nMe envie o novo valor para *{{label}}*.",
FLOW_MENU_EDIT_SUCCESS:
  "✅ Dado atualizado com sucesso!",
FLOW_BILLING_UPDATED_SUCCESS:
  "✅ Perfeito! Seus dados foram atualizados com sucesso.",
FLOW_ASK_BILLING_CITY_STATE:
  "✅ Pagamento confirmado! Seu plano já está ativo.\n\nAgora preciso de uma informação para completar o seu cadastro.\n\n📍 Qual é sua *Cidade/UF*? (ex: Atibaia/SP)",
FLOW_ASK_BILLING_ADDRESS:
  "Perfeito! ✅\n\nAgora me diga seu *endereço* (rua, número, bairro).\n\nSe for apenas atendimento online, responda: *APENAS ONLINE*",
FLOW_ASK_PROFILE_REGISTRATION:
  "Quer cadastrar os dados da sua empresa para eu usar automaticamente nos próximos anúncios? 🙂\n\n1) Sim, cadastrar agora\n2) Agora não\n\nAssim você não precisa repetir essas informações toda vez. ✅",
FLOW_PAYMENT_PIX_READY:
  "✅ Pronto! Gerei sua cobrança via *PIX*.\n\n{{paymentLinkLine}}\n\nAssim que o pagamento for confirmado, seu plano ativa automaticamente. 🚀\n\nSe quiser mudar a forma de pagamento agora, responda *MUDAR PAGAMENTO*.",
FLOW_PAYMENT_CARD_READY:
  "✅ Pronto! Agora é só concluir no *Cartão* (assinatura).\n\n{{paymentLinkLine}}\n\nAssim que confirmar, seu plano ativa automaticamente. 🚀\n\nSe quiser mudar a forma de pagamento agora, responda *MUDAR PAGAMENTO*.",

// FLOW — MENU (Dados da empresa)
FLOW_MENU_PROFILE_VIEW_TITLE: "📇 *Dados da empresa*",
FLOW_MENU_PROFILE_EMPTY: "Ainda não tenho dados salvos da sua empresa por aqui 🙂",
FLOW_MENU_PROFILE_ACTIONS:
  "1) Atualizar/Completar\n2) Limpar dados salvos\n3) Voltar ao menu",
FLOW_MENU_PROFILE_INVALID_CHOICE:
  "Responda com *1*, *2* ou *3*, por favor 🙂",
FLOW_MENU_PROFILE_CLEARED: "✅ Dados da empresa removidos.",

FLOW_ACTIVE_NO_PLAN_ERROR: "⚠️ Identificamos uma inconsistência na sua assinatura (conta ativa sem plano associado).\n\nPor favor, acesse nosso site para regularizar ou fale com nosso suporte.\n\nInstagram: https://www.instagram.com/amigo.das.vendas/",
FLOW_MENU_NAME_UPDATED: "✅ Nome atualizado!",
FLOW_MENU_DOC_UPDATED: "✅ CPF/CNPJ atualizado!",
FLOW_OK_NEXT_DESCRIPTION: "Show! ✅\n\nMe manda a próxima descrição (produto/serviço/promoção) que eu monto outro anúncio.",
// FLOW — Salvar dados da empresa (auto preenchimento)
FLOW_SAVE_PROFILE_INTRO: "Notei que você incluiu alguns dados da sua empresa no anúncio.",
FLOW_SAVE_PROFILE_ASK: "Quer que eu *salve isso* para usar automaticamente nos próximos anúncios? 🙂",
FLOW_SAVE_PROFILE_WILL_SAVE: "Vou salvar:",
FLOW_SAVE_PROFILE_OPT_YES: "1) Sim, salvar",
FLOW_SAVE_PROFILE_OPT_NO: "2) Não salvar",
FLOW_SAVE_PROFILE_OPT_ADD: "3) Adicionar dados da empresa",

// FLOW — Wizard: adicionar dados da empresa (manual)
FLOW_PROFILE_WIZARD_INTRO: "Perfeito! ✅ Vamos completar seus dados da empresa. Você pode responder *PULAR* em qualquer etapa.",
FLOW_PROFILE_WIZARD_STEP1_COMPANY: "1/7) Qual é o *nome da empresa*? (ou digite PULAR)",
FLOW_PROFILE_WIZARD_STEP2_WHATSAPP: "2/7) Qual é o *WhatsApp* da empresa? (ex.: +55 11 99999-9999)\n(ou digite PULAR)",
FLOW_PROFILE_WIZARD_STEP3_ADDRESS: "3/7) Qual é o *endereço* da empresa?\nVocê pode responder *APENAS ATENDIMENTO ONLINE*.\n(ou digite PULAR)",
FLOW_PROFILE_WIZARD_STEP4_HOURS: "4/7) Qual é o *horário de atendimento*? (ex.: Seg a sex, 09h–17h)\n(ou digite PULAR)",
FLOW_PROFILE_WIZARD_STEP5_SOCIAL: "5/7) Envie o link de uma *rede social* (Instagram, Facebook, TikTok, etc).\n• Para adicionar mais redes, envie outro link em seguida.\n• Quando terminar, digite *FIM*.\n(ou digite PULAR para não informar nenhuma)",
FLOW_PROFILE_WIZARD_STEP6_WEBSITE: "6/7) Qual é o link do *site*? (ou digite PULAR)",
FLOW_PROFILE_WIZARD_STEP7_PRODUCTS: "7/7) Link da sua *lista de produtos* / catálogo (ou digite PULAR)",
FLOW_PROFILE_WIZARD_SOCIAL_ADDED: "✅ Rede social adicionada.\nEnvie outro link para adicionar mais, ou digite *FIM* para continuar.",
FLOW_PROFILE_WIZARD_SOCIAL_INVALID: "Não entendi. Envie um link (ou digite PULAR / FIM).",
FLOW_SAVE_PROFILE_BENEFIT: "Assim você não precisa repetir essas informações toda vez. ✅",
FLOW_SAVE_PROFILE_SAVED_CONFIRM: "Perfeito! ✅ Vou salvar esses dados como padrão para seus próximos anúncios.",
FLOW_SAVE_PROFILE_NOT_SAVED_CONFIRM: "Fechado! ✅ Não vou salvar esses dados por agora.",
FLOW_SAVE_PROFILE_CHANGE_LATER: "Se quiser mudar isso depois, digite *MENU* e ajuste sua preferência.",

FLOW_AFTER_SAVE_PROFILE_QUESTION: "Agora me diz: você *gostou do anúncio* ou quer ajustar alguma coisa?",

  FLOW_REFINEMENTS_SHORT: "*Refinamentos*\n\nAgora me diz: você *gostou do anúncio* ou quer ajustar alguma coisa?\n* Para refinar: responda com o que você quer mudar (ex.: \"deixa mais curto\", \"mais emocional\", \"com mais emoji\", etc...).",
// Vars: maxRefinements
FLOW_AFTER_SAVE_PROFILE_REFINE_HINT: "• Para refinar: responda com o que você quer mudar (ex.: “deixa mais curto”, “inclua delivery”, “mude o preço”).\n\n(Lembrete: até {{maxRefinements}} refinamento(s) por descrição. No próximo, conta como uma nova descrição.)",
FLOW_AFTER_SAVE_PROFILE_OK_HINT: "• Para criar outro: digite *OK*.",
  FLOW_REFINE_PROMPT_SHORT: "*Refinamentos*\n\nAgora me diz: você *gostou do anúncio* ou quer ajustar alguma coisa?\n* Para refinar: responda com o que você quer mudar (ex.: \"deixa mais curto\", \"mais emocional\", \"com mais emoji\", etc...).",

FLOW_MENU_ASK_NEW_NAME: "Perfeito! ✅\n\nMe envie seu *nome completo* (como você quer que eu salve).",
  FLOW_MENU_ASK_NEW_DOC: "Certo! ✅\n\nMe envie seu *CPF ou CNPJ* (somente números) para atualizar.",
  FLOW_MENU_URL_HELP: "Aqui está nosso site: https://www.amigodasvendas.com.br",
  FLOW_MENU_URL_FEEDBACK: "Pode enviar por aqui: https://www.amigodasvendas.com.br/formulario",
  FLOW_MENU_URL_INSTAGRAM: "Instagram: https://www.instagram.com/amigo.das.vendas/",
  FLOW_MENU_CANCEL_NOT_FOUND:
    "Não encontrei uma assinatura ativa no cartão para cancelar agora 😕\n\nSe você acha que isso é um erro, fale com o suporte pelo formulário:\nhttps://www.amigodasvendas.com.br/formulario",
  // Vars: renewalBr, daysLeft
  FLOW_MENU_CANCEL_OK:
    "✅ Pronto! A recorrência do *Cartão* foi cancelada.\n\nVocê continua com acesso até *{{renewalBr}}* (faltam {{daysLeft}} dia(s)).\n\nQuando chegar a data, é só escolher um plano novamente pelo *MENU* 😉",


  // FLOW — Reengajamento / Crescimento / Retenção (preparação para próximas fases)
  FLOW_IDLE_NUDGE:
    "Oi 🙂 ainda quer criar seu anúncio?\n\nMe diga o que você vende ou digite *MENU*.",

  FLOW_UPGRADE_OFFER:
    "Você atingiu o limite do seu plano.\n\nPlano atual:\n*{{currentPlanName}}*{{currentPlanQuotaLine}}\n\nQuer subir para um plano maior?\n\n1) *Sim*{{upgradePlanLine}}\n2) *Ver outros planos*",

  FLOW_PAYMENT_RECOVERY:
    "Não conseguimos processar seu pagamento.\n\nVocê pode:\n\n1) *Atualizar cartão*\n2) *Pagar por PIX*\n3) *Falar com suporte*",

  FLOW_FLOOD_NOTICE:
    "Recebi várias mensagens 🙂\n\nVou considerar apenas a última.",

  FLOW_FEEDBACK_ASK:
    "Posso te perguntar uma coisa?\n\nO Amigo está ajudando nas suas vendas?\n\n1) *Muito*\n2) *Mais ou menos*\n3) *Não*",

  FLOW_FEEDBACK_COMMENT_ASK:
    "Obrigado por me contar 💚\n\nSe quiser, me diga em uma frase o que podemos melhorar.\n\nSe preferir, digite *PULAR*.",

  FLOW_TESTIMONIAL_ASK:
    "Que bom ouvir isso 🙂\n\nMe manda, por favor, um depoimento curtinho sobre como o Amigo te ajuda nas vendas.\n\nPode ser do seu jeito, em uma frase.\n\nSe preferir, digite *PULAR*.",

  FLOW_TESTIMONIAL_CONSENT_ASK:
    "Perfeito 💚\n\nPosso usar esse depoimento no nosso site, Instagram ou materiais do Amigo das Vendas?\n\n1) *Sim*\n2) *Não*",

  FLOW_TESTIMONIAL_DISPLAY_ASK:
    "Como você prefere aparecer nesse depoimento?\n\n1) *Primeiro nome*\n2) *Nome da empresa*\n3) *Sem identificação*",

  FLOW_TESTIMONIAL_THANKS:
    "Depoimento salvo com sucesso 💚\n\nMuito obrigado por ajudar o Amigo das Vendas a crescer!",

  FLOW_TESTIMONIAL_INTERNAL_ONLY_THANKS:
    "Perfeito 💚\n\nVou guardar seu depoimento apenas para análise interna. Obrigado pela ajuda!",

  FLOW_REFERRAL_INVITE:
    "Se o Amigo te ajuda nas vendas, indique para um amigo 🙂\n\nEnvie este link:\n{{referralLink}}\n\nQuanto mais gente vender, melhor!",

  FLOW_REFERRAL_BONUS_UNLOCKED:
    "🎁 Bônus liberado!\n\nSeu amigo começou a usar o Amigo das Vendas.\n\nVocê ganhou *{{bonusAmount}}* descriç{{bonusPlural}} neste mês.",

  FLOW_FIRST_RESULT_PROMPT:
    "Quer que eu crie mais anúncios para você?\n\n1) *Sim*\n2) *Quero testar outro*\n3) *Como funciona*",

  FLOW_HABIT_NUDGE:
    "Você já criou *{{count}} anúncios* comigo 🙂\n\nMuita gente usa o Amigo para postar todos os dias nos grupos.\n\nAssim vende muito mais.\n\nQuer continuar criando anúncios?",

  FLOW_PLAN_VALUE_REINFORCEMENT:
    "Muita gente recupera o valor do plano com apenas *1 venda* 🙂",

  FLOW_PLAN_ACTIVATED_WELCOME:
    "🎉 Seu plano está ativo!\n\nAgora você pode criar anúncios sempre que quiser.\n\nDica: poste em vários grupos diferentes.\n\nQuer criar um agora?",

  FLOW_POST_AD_BENEFIT:
    "Isso ajuda você a vender mais.\n\nSe quiser, você pode copiar e enviar direto nos grupos 🙂\n\nOu posso gerar outra versão do anúncio.",

  FLOW_POST_AD_GROUPS_TIP:
    "💡 Dica:\n\nPoste em vários grupos da sua cidade.\nAssim mais pessoas veem seu anúncio.",

  FLOW_PROGRESS_MILESTONE:
    "Você já criou *{{count}} anúncios* com o Amigo 🙂\n\nMuitos usuários conseguem clientes apenas com posts em grupos.",

  FLOW_DAILY_POSTING_HABIT:
    "💡 Dica do Amigo\n\nQuem posta anúncios todos os dias costuma vender mais.\n\nQuer criar um anúncio rápido para hoje?",

  FLOW_REWARD_AFTER_AD:
    "✨ Anúncio pronto!\n\nAgora é só postar nos grupos da sua cidade.\n\nMuitos usuários conseguem clientes assim 🙂",

  FLOW_RETENTION_SIGNOFF:
    "Boa sorte nas vendas hoje! 🙂\n\nSe quiser criar outro anúncio mais tarde, é só me chamar.",

  FLOW_DAILY_AD_NUDGE:
    "Bom dia! ☀️\n\nQuer criar um anúncio para postar hoje nos grupos?\n\nLeva menos de 10 segundos 🙂",

  FLOW_DAILY_AD_NUDGE_SHORT:
    "Quer criar um anúncio rápido para hoje? 🙂",

  FLOW_DAILY_AD_ALREADY_CREATED_TODAY:
    "Vi que você já criou um anúncio hoje 🙂\n\nQuando quiser fazer outro, é só me chamar.",

  FLOW_PROGRESS_SIGNATURE_SUMMARY:
    "Plano: *{{planName}}*\n\nDescrições usadas: *{{used}} / {{total}}*\n\nVocê já criou *{{used}} anúncios* este mês 🙂",


  // OPENAI — Prompts
  OPENAI_SYSTEM_FIXED: [
    "Você é o *Amigo das Vendas*, especialista em copywriting para vendas diretas no WhatsApp (Brasil).",
    "Sua função é transformar descrições simples em anúncios visualmente bonitos, humanos, claros e altamente focados em conversão.",
    "Objetivo: fazer a pessoa que está lendo querer comprar, pedir orçamento ou agendar o serviço.",
    "",
    "O anúncio será usado em grupos de WhatsApp, conversas privadas, status e listas de transmissão.",
    "Por isso, o texto precisa ser curto, escaneável, agradável no celular e com cara de vendedor real — nunca frio ou corporativo demais.",
    "",
    "ANTES DE ESCREVER:",
    "1) Analise a descrição e identifique o tipo principal: PRODUTO, SERVIÇO, PROMOÇÃO, DIVULGAÇÃO, AGENDA ou NOVIDADE.",
    "2) Identifique o objetivo principal: vender agora, gerar pedido, gerar orçamento, gerar agendamento ou apresentar o negócio.",
    "3) Identifique os elementos presentes: nome da empresa, produto/serviço, lista de itens, preços, descontos, horário, local, WhatsApp, site, redes sociais, condições, encomenda, pronta entrega e observações.",
    "4) Se houver conflito entre o contexto salvo da empresa e a descrição atual do usuário, sempre priorize a DESCRIÇÃO atual do usuário.",
    "",
    "USO DO CONTEXTO DA EMPRESA:",
    "- Se a mensagem trouxer CONTEXTO_DA_EMPRESA, trate-o como apoio invisível.",
    "- Use esses dados somente se ajudarem a vender e a deixar o anúncio mais completo.",
    "- Não é obrigatório repetir todos os dados no texto final.",
    "- Nunca force site, redes sociais ou catálogo se isso deixar o anúncio pesado.",
    "",
    "SE FOR REFINAMENTO:",
    "- Se a mensagem trouxer ANUNCIO_ATUAL e AJUSTES_SOLICITADOS, preserve o tema, a oferta e as informações essenciais do anúncio atual.",
    "- Aplique apenas os ajustes pedidos, sem perder clareza, visual e capacidade de conversão.",
    "",
    "REGRAS GERAIS:",
    "- Sempre comece com um título chamativo e específico.",
    "- Após o título, inclua uma frase emocional curta, humana e natural, com no máximo duas linhas.",
    "- A frase emocional pode ativar prazer, conforto, nostalgia, cuidado, autoestima, praticidade, segurança ou felicidade, de acordo com o tipo de anúncio.",
    "- Nunca escreva parágrafos longos.",
    "- Sempre use espaçamento entre blocos.",
    "- Sempre use linguagem simples, próxima, natural e vendedora.",
    "- Nunca use hashtags.",
    "- Nunca invente preços, prazos, descontos, contatos, localização ou condições.",
    "- Nunca invente nomes de produtos, imóveis, modelos, versões, listas de opções, quantidades, numerações, metragem, quartos, vagas, marcas, estoque ou qualquer detalhe específico que o usuário não informou.",
    "- Nunca use placeholders, campos genéricos ou textos de preenchimento como [Nome da Empresa], [Seu Nome], [Contato], [Seu WhatsApp], [Seu Site], [Instagram], R$00,00, Produto 1, Item 1, Imóvel 1 ou equivalentes.",
    "- Nunca omita um preço ou condição relevante que tenha sido informada.",
    "- Preserve exatamente os preços informados pelo usuário.",
    "- Se um dado não foi informado, não invente. Só use 'Sob consulta' se isso realmente ajudar e for estritamente necessário.",
    "- Se faltarem dados específicos para um produto, imóvel ou serviço, transforme a descrição em um anúncio institucional genérico e vendedor, sem criar exemplos fictícios, listas falsas ou informações de preenchimento.",
    "- Quando a mensagem for ampla ou institucional, como divulgação de empresa, corretor, imobiliária, profissional ou portfólio, faça um anúncio de apresentação do negócio e dos benefícios, sem fingir que existem itens específicos cadastrados.",
    "",
    "REGRAS VISUAIS DE WHATSAPP:",
    "- O anúncio deve ficar bonito no celular.",
    "- Use emojis como marcadores no início da linha, nunca no final.",
    "- Mantenha o anúncio entre 8 e 14 linhas, salvo se uma lista de produtos exigir um pouco mais.",
    "- O texto deve ser fácil de bater o olho e entender rapidamente.",
    "",
    "QUANDO HOUVER VÁRIOS PRODUTOS OU PREÇOS:",
    "- Use obrigatoriamente formato de lista vertical.",
    "- Cada item deve ficar em uma linha própria.",
    "- Nunca agrupe vários produtos com preços em um único parágrafo.",
    "- Exemplo de estrutura visual: 🍬 Produto — *R$00,00*",
    "",
    "QUANDO FOR SERVIÇO:",
    "- Destaque o benefício principal do serviço.",
    "- Reforce confiança, segurança, cuidado, praticidade ou resultado, conforme o caso.",
    "- Se houver preço fixo, destaque com clareza.",
    "- Se for sob orçamento, o CTA deve pedir orçamento.",
    "- Se for agenda, o CTA deve pedir agendamento.",
    "",
    "QUANDO FOR PROMOÇÃO:",
    "- Destaque a condição especial logo no título ou no bloco principal.",
    "- Reforce oportunidade e vantagem sem exagero ou urgência falsa.",
    "",
    "QUANDO FOR DIVULGAÇÃO / APRESENTAÇÃO:",
    "- Mostre de forma clara o que a empresa ou profissional faz.",
    "- Foque no benefício e na clareza, não em texto institucional pesado.",
    "",
    "ESTRUTURA PADRÃO DO MODO FIXO:",
    "1) TÍTULO chamativo",
    "2) FRASE EMOCIONAL curta",
    "3) APRESENTAÇÃO da oferta",
    "4) LISTA de produtos ou descrição objetiva do serviço",
    "5) BLOCO de apoio com horário/local/observações relevantes, se houver",
    "6) CTA final claro",
    "",
    "CTA FINAL:",
    "- Sempre finalize com uma chamada clara para ação.",
    "- Exemplos: '📩 Faça seu pedido agora', '📩 Peça seu orçamento', '📩 Agende seu horário', '📩 Fale comigo para mais informações'.",
    "",
    "SAÍDA:",
    "- Retorne apenas o anúncio final pronto para enviar no WhatsApp.",
    "- Não explique nada.",
    "- Não escreva comentários fora do anúncio.",
  ].join("\n"),

  OPENAI_SYSTEM_FREE: [
    "Você é o *Amigo das Vendas*, especialista em copywriting para vendas diretas no WhatsApp (Brasil).",
    "Sua função é transformar descrições simples em anúncios atraentes, humanos, visuais e focados em conversão, com mais liberdade criativa de forma do que no modo FIXO.",
    "",
    "Objetivo: fazer a pessoa que está lendo querer comprar, pedir orçamento, agendar ou iniciar uma conversa.",
    "",
    "ANTES DE ESCREVER:",
    "- Analise o tipo principal do anúncio: PRODUTO, SERVIÇO, PROMOÇÃO, DIVULGAÇÃO, AGENDA ou NOVIDADE.",
    "- Analise o objetivo principal: venda, pedido, orçamento, agendamento ou apresentação.",
    "- Identifique os dados relevantes presentes na mensagem.",
    "- Se houver conflito entre o contexto salvo da empresa e a descrição atual do usuário, priorize sempre a descrição atual.",
    "",
    "USO DO CONTEXTO DA EMPRESA:",
    "- Se a mensagem trouxer CONTEXTO_DA_EMPRESA, use esses dados apenas quando ajudarem a deixar o anúncio mais completo e vendedor.",
    "- Não é obrigatório incluir tudo.",
    "",
    "SE FOR REFINAMENTO:",
    "- Se a mensagem trouxer ANUNCIO_ATUAL e AJUSTES_SOLICITADOS, preserve a oferta principal e faça somente os ajustes pedidos.",
    "",
    "REGRAS DO MODO LIVRE:",
    "- Você pode escolher a melhor estrutura para conversão, sem precisar seguir exatamente a ordem do modo FIXO.",
    "- Continue priorizando clareza, leitura rápida e visual bonito para WhatsApp.",
    "- Use uma frase emocional curta e natural quando isso melhorar a conexão com o cliente.",
    "- Nunca use texto corporativo demais, clichês ou frases batidas.",
    "- Nunca invente preços, prazos, descontos, contatos, localização ou condições.",
    "- Nunca invente nomes de produtos, imóveis, modelos, versões, listas de opções, quantidades, numerações, metragem, quartos, vagas, marcas, estoque ou qualquer detalhe específico que o usuário não informou.",
    "- Nunca use placeholders, campos genéricos ou textos de preenchimento como [Nome da Empresa], [Seu Nome], [Contato], [Seu WhatsApp], [Seu Site], [Instagram], R$00,00, Produto 1, Item 1, Imóvel 1 ou equivalentes.",
    "- Preserve exatamente os preços e informações informados.",
    "- Se faltarem dados específicos, crie um anúncio institucional genérico e vendedor, sem inventar exemplos, listas falsas ou informações de preenchimento.",
    "- Quando a mensagem for ampla ou institucional, apresente o negócio, a especialidade, os benefícios e a região atendida, se houver, sem fingir que existem itens específicos cadastrados.",
    "- Nunca transforme catálogo em parágrafo corrido: se houver vários produtos com preços, liste cada item em uma linha.",
    "",
    "VISUAL:",
    "- Use espaçamento entre blocos.",
    "- Use emojis como marcadores quando fizer sentido.",
    "- Mantenha o anúncio bonito no celular e fácil de escanear.",
    "- Prefira anúncios entre 7 e 14 linhas, salvo quando o catálogo exigir mais.",
    "",
    "CTA:",
    "- Sempre termine com uma chamada para ação clara e adequada ao tipo de oferta.",
    "- Exemplos: '📩 Faça seu pedido agora', '📩 Peça seu orçamento', '📩 Agende seu horário', '📩 Me chama para saber mais'.",
    "",
    "SAÍDA:",
    "- Retorne apenas o anúncio final, pronto para envio no WhatsApp.",
    "- Não explique nada fora do anúncio.",
  ].join("\n"),
});

// Catálogo para UI (ordem e categorias)
export const COPY_CATALOG = Object.freeze([
  { category: "Flow", key: "FLOW_WELCOME", label: "Boas-vindas (prefixo)" },
  { category: "Flow", key: "FLOW_ASK_NAME", label: "Pedir nome" },
  { category: "Flow", key: "FLOW_ASK_PRODUCT", label: "Pedir o que vende" },
  { category: "Flow", key: "FLOW_ASK_REFINEMENT", label: "Pedir refinamento" },
  { category: "Flow", key: "FLOW_ASK_TEMPLATE_CHOICE", label: "Escolha FIXO/LIVRE" },
  { category: "Flow", key: "FLOW_ASK_TEMPLATE_CHOICE_LONG", label: "Escolha FIXO/LIVRE (texto longo)" },
  { category: "Flow", key: "FLOW_TEMPLATE_SET_FIXED", label: "Confirma FIXO" },
  { category: "Flow", key: "FLOW_TEMPLATE_SET_FREE", label: "Confirma LIVRE" },
  { category: "Flow", key: "FLOW_TRIAL_BLOCKED", label: "Trial acabou / mostrar planos" },
  { category: "Flow", key: "FLOW_TRIAL_PREFIX", label: "Trial: prefixo (não entendi)" },
  { category: "Flow", key: "FLOW_PLANS_FALLBACK_STATIC", label: "Planos: fallback estático (sem planos no Redis)" },
  { category: "Flow", key: "FLOW_PLANS_ONLY_HEADER", label: "Planos: cabeçalho (sem trial)" },
  { category: "Flow", key: "FLOW_PLANS_ONLY_FOOTER", label: "Planos: rodapé (sem trial)" },
  { category: "Flow", key: "FLOW_QUOTA_BLOCKED", label: "Limite do plano" },
  { category: "Flow", key: "FLOW_UNKNOWN_COMMAND", label: "Comando não entendido" },
  { category: "Flow", key: "FLOW_ASK_PAYMENT_METHOD", label: "Escolher forma de pagamento" },
  { category: "Flow", key: "FLOW_ASK_DOC", label: "Pedir CPF/CNPJ" },
  { category: "Flow", key: "FLOW_INVALID_DOC", label: "CPF/CNPJ inválido" },

  { category: "Flow", key: "FLOW_NAME_TOO_SHORT", label: "Nome curto / inválido" },
  { category: "Flow", key: "FLOW_INVALID_PAYMENT_METHOD", label: "Pagamento: opção inválida" },
  { category: "Flow", key: "FLOW_PAYMENT_SUCCESS", label: "Pagamento: sucesso (PIX/Cartão)" },
  { category: "Flow", key: "FLOW_PAYMENT_PENDING", label: "Pagamento: pendente" },
  { category: "Flow", key: "FLOW_QUOTA_REACHED_PREFIX", label: "Limite mensal atingido (prefixo)" },
  { category: "Flow", key: "FLOW_FALLBACK_UNKNOWN", label: "Fallback final (não entendi)" },
  { category: "Flow", key: "FLOW_OPENAI_ERROR", label: "Erro técnico OpenAI" },


  { category: "Flow", key: "FLOW_BLOCKED", label: "Acesso bloqueado" },
  { category: "Flow", key: "FLOW_AFTER_AD_TEMPLATE_CHOICE", label: "Perguntar template após anúncio" },
  { category: "Flow", key: "FLOW_HINT_TEMPLATE_FIXED", label: "Hint template FIXO" },
  { category: "Flow", key: "FLOW_HINT_TEMPLATE_FREE", label: "Hint template LIVRE" },
  { category: "Flow", key: "FLOW_TEMPLATE_SWITCH_TO_FREE", label: "Confirma trocar para LIVRE" },
  { category: "Flow", key: "FLOW_TEMPLATE_KEEP_FIXED", label: "Confirma manter FIXO" },
  { category: "Flow", key: "FLOW_ASK_PAYMENT_METHOD_WITH_PLAN", label: "Pagamento com plano (dinâmico)" },


  { category: "Flow", key: "FLOW_MENU_MAIN", label: "Menu principal (MENU)" },
  { category: "Flow", key: "FLOW_MENU_SUBSCRIPTION", label: "Menu: minha assinatura" },
  { category: "Flow", key: "FLOW_MENU_EDIT_ROOT", label: "Menu: alterar dados (raiz)" },
  { category: "Flow", key: "FLOW_MENU_EDIT_PERSONAL", label: "Menu: dados pessoais" },
  { category: "Flow", key: "FLOW_MENU_EDIT_COMPANY", label: "Menu: dados da empresa" },
  { category: "Flow", key: "FLOW_MENU_EDIT_TEMPLATE", label: "Menu: fluxo FIXO/LIVRE" },
  { category: "Flow", key: "FLOW_MENU_EDIT_FIELD_FULLNAME", label: "Menu: editar nome" },
  { category: "Flow", key: "FLOW_MENU_EDIT_FIELD_DOC", label: "Menu: editar CPF/CNPJ" },
  { category: "Flow", key: "FLOW_MENU_EDIT_FIELD_BILLING_CITY_STATE", label: "Menu: editar cidade/UF" },
  { category: "Flow", key: "FLOW_MENU_EDIT_FIELD_BILLING_ADDRESS", label: "Menu: editar endereço" },
  { category: "Flow", key: "FLOW_MENU_EDIT_FIELD_GENERIC", label: "Menu: editar campo genérico" },
  { category: "Flow", key: "FLOW_MENU_EDIT_SUCCESS", label: "Menu: sucesso ao atualizar dado" },
  { category: "Flow", key: "FLOW_BILLING_UPDATED_SUCCESS", label: "Cobrança: dados atualizados com sucesso" },
  { category: "Flow", key: "FLOW_ASK_BILLING_CITY_STATE", label: "Cobrança: pedir cidade/UF" },
  { category: "Flow", key: "FLOW_ASK_BILLING_ADDRESS", label: "Cobrança: pedir endereço" },
  { category: "Flow", key: "FLOW_ASK_PROFILE_REGISTRATION", label: "Pedir cadastro dos dados da empresa" },
  { category: "Flow", key: "FLOW_PAYMENT_PIX_READY", label: "Pagamento PIX: cobrança gerada" },
  { category: "Flow", key: "FLOW_PAYMENT_CARD_READY", label: "Pagamento Cartão: link gerado" },
  { category: "Flow", key: "FLOW_MENU_ASK_NEW_NAME", label: "Menu: pedir novo nome" },
  { category: "Flow", key: "FLOW_MENU_ASK_NEW_DOC", label: "Menu: pedir novo CPF/CNPJ" },
  { category: "Flow", key: "FLOW_MENU_URL_HELP", label: "Menu: URL Ajuda" },
  { category: "Flow", key: "FLOW_MENU_URL_FEEDBACK", label: "Menu: URL Formulário" },
  { category: "Flow", key: "FLOW_MENU_URL_INSTAGRAM", label: "Menu: URL Instagram" },
  { category: "Flow", key: "FLOW_MENU_CANCEL_NOT_FOUND", label: "Menu: cancelar cartão (não encontrado)" },
  { category: "Flow", key: "FLOW_MENU_CANCEL_OK", label: "Menu: cancelar cartão (sucesso)" },
  { category: "Flow", key: "FLOW_SAVE_PROFILE_OPT_ADD", label: "Salvar perfil: opção 3 (Adicionar dados)" },
  { category: "Flow", key: "FLOW_PROFILE_WIZARD_INTRO", label: "Wizard perfil: introdução" },
  { category: "Flow", key: "FLOW_PROFILE_WIZARD_STEP1_COMPANY", label: "Wizard perfil: 1/7 empresa" },
  { category: "Flow", key: "FLOW_PROFILE_WIZARD_STEP2_WHATSAPP", label: "Wizard perfil: 2/7 WhatsApp" },
  { category: "Flow", key: "FLOW_PROFILE_WIZARD_STEP3_ADDRESS", label: "Wizard perfil: 3/7 endereço" },
  { category: "Flow", key: "FLOW_PROFILE_WIZARD_STEP4_HOURS", label: "Wizard perfil: 4/7 horário" },
  { category: "Flow", key: "FLOW_PROFILE_WIZARD_STEP5_SOCIAL", label: "Wizard perfil: 5/7 redes sociais" },
  { category: "Flow", key: "FLOW_PROFILE_WIZARD_STEP6_WEBSITE", label: "Wizard perfil: 6/7 site" },
  { category: "Flow", key: "FLOW_PROFILE_WIZARD_STEP7_PRODUCTS", label: "Wizard perfil: 7/7 catálogo" },
  { category: "Flow", key: "FLOW_PROFILE_WIZARD_SOCIAL_ADDED", label: "Wizard perfil: rede social adicionada" },
  { category: "Flow", key: "FLOW_PROFILE_WIZARD_SOCIAL_INVALID", label: "Wizard perfil: rede social inválida" },

  { category: "Flow", key: "FLOW_IDLE_NUDGE", label: "Reengajamento: usuário parado" },
  { category: "Flow", key: "FLOW_UPGRADE_OFFER", label: "Upgrade automático ao atingir limite" },
  { category: "Flow", key: "FLOW_PAYMENT_RECOVERY", label: "Pagamento: recuperação por falha" },
  { category: "Flow", key: "FLOW_FLOOD_NOTICE", label: "Proteção: flood / spam" },
  { category: "Flow", key: "FLOW_FEEDBACK_ASK", label: "Feedback: pedir opinião" },
  { category: "Flow", key: "FLOW_FEEDBACK_COMMENT_ASK", label: "Feedback: pedir comentário" },
  { category: "Flow", key: "FLOW_TESTIMONIAL_ASK", label: "Feedback: pedir depoimento" },
  { category: "Flow", key: "FLOW_TESTIMONIAL_CONSENT_ASK", label: "Feedback: autorização de uso do depoimento" },
  { category: "Flow", key: "FLOW_TESTIMONIAL_DISPLAY_ASK", label: "Feedback: forma de exibição do depoimento" },
  { category: "Flow", key: "FLOW_TESTIMONIAL_THANKS", label: "Feedback: agradecimento por depoimento" },
  { category: "Flow", key: "FLOW_TESTIMONIAL_INTERNAL_ONLY_THANKS", label: "Feedback: depoimento apenas interno" },
  { category: "Flow", key: "FLOW_REFERRAL_INVITE", label: "Crescimento: pedir indicação" },
  { category: "Flow", key: "FLOW_REFERRAL_BONUS_UNLOCKED", label: "Crescimento: bônus por indicação" },
  { category: "Flow", key: "FLOW_FIRST_RESULT_PROMPT", label: "Pós-primeiro anúncio: próximo passo" },
  { category: "Flow", key: "FLOW_HABIT_NUDGE", label: "Hábito: incentivo após alguns anúncios" },
  { category: "Flow", key: "FLOW_PLAN_VALUE_REINFORCEMENT", label: "Planos: reforço de valor" },
  { category: "Flow", key: "FLOW_PLAN_ACTIVATED_WELCOME", label: "Plano ativo: boas-vindas" },
  { category: "Flow", key: "FLOW_POST_AD_BENEFIT", label: "Pós-anúncio: reforço de benefício" },
  { category: "Flow", key: "FLOW_POST_AD_GROUPS_TIP", label: "Pós-anúncio: dica de grupos" },
  { category: "Flow", key: "FLOW_PROGRESS_MILESTONE", label: "Progresso: marco de anúncios" },
  { category: "Flow", key: "FLOW_DAILY_POSTING_HABIT", label: "Hábito: postar todos os dias" },
  { category: "Flow", key: "FLOW_REWARD_AFTER_AD", label: "Pós-anúncio: recompensa" },
  { category: "Flow", key: "FLOW_RETENTION_SIGNOFF", label: "Retenção: mensagem final" },
  { category: "Flow", key: "FLOW_DAILY_AD_NUDGE", label: "Anúncio do dia" },
  { category: "Flow", key: "FLOW_DAILY_AD_NUDGE_SHORT", label: "Anúncio do dia: versão curta" },
  { category: "Flow", key: "FLOW_DAILY_AD_ALREADY_CREATED_TODAY", label: "Anúncio do dia: já usou hoje" },
  { category: "Flow", key: "FLOW_PROGRESS_SIGNATURE_SUMMARY", label: "Minha assinatura: progresso resumido" },

  { category: "OpenAI", key: "OPENAI_SYSTEM_FIXED", label: "Prompt FIXO (system)" },
  { category: "OpenAI", key: "OPENAI_SYSTEM_FREE", label: "Prompt LIVRE (system)" },
]);

function defaultFor(key) {
  const k = escapeKey(key);
  return DEFAULT_COPY[k];
}

async function ensureIndexedKey(key) {
  const k = escapeKey(key);
  if (!k) return;
  // Guarda no index para a UI listar inclusive keys novas
  await redisSAdd(KEY_INDEX, k);
}

// ==============================
// API
// ==============================

export async function listCopyKeys() {
  const indexed = await redisSMembers(KEY_INDEX).catch(() => []);
  const defaults = Object.keys(DEFAULT_COPY);
  const set = new Set([...(indexed || []), ...defaults].map(escapeKey).filter(Boolean));
  return Array.from(set);
}

export async function getCopyResolved(key, { waId = null, vars = null } = {}) {
  const k = escapeKey(key);
  if (!k) return { key: k, text: "", source: "EMPTY" };

  // 1) user override
  if (waId) {
    const userVal = await redisGet(K_USER(String(waId), k));
    if (userVal !== null && userVal !== undefined && String(userVal) !== "") {
      const varsEff = await resolveVars({ waId, vars });
      return { key: k, text: applyVars(userVal, varsEff), source: "USER" };
    }
  }

  // 2) global override
  const globalVal = await redisGet(K_GLOBAL(k));
  if (globalVal !== null && globalVal !== undefined && String(globalVal) !== "") {
    const varsEff = await resolveVars({ waId, vars });
    return { key: k, text: applyVars(globalVal, varsEff), source: "GLOBAL" };
  }

  // 3) default
  const def = defaultFor(k);
  if (def !== undefined) {
    const varsEff = await resolveVars({ waId, vars });
    return { key: k, text: applyVars(def, varsEff), source: "DEFAULT" };
  }

  return { key: k, text: "", source: "MISSING" };
}

export async function getCopyText(key, opts = {}) {
  const r = await getCopyResolved(key, opts);
  return r.text;
}

export async function getCopyRawGlobal(key) {
  const k = escapeKey(key);
  const v = await redisGet(K_GLOBAL(k));
  return v;
}

export async function getCopyRawUser(waId, key) {
  const k = escapeKey(key);
  const v = await redisGet(K_USER(String(waId), k));
  return v;
}

export async function setCopyGlobal(key, value) {
  const k = escapeKey(key);
  await ensureIndexedKey(k);
  await redisSet(K_GLOBAL(k), String(value ?? ""));
  return { ok: true };
}

export async function delCopyGlobal(key) {
  const k = escapeKey(key);
  await ensureIndexedKey(k);
  await redisDel(K_GLOBAL(k));
  return { ok: true };
}

export async function setCopyUser(waId, key, value) {
  const k = escapeKey(key);
  const id = String(waId ?? "").trim();
  if (!id) throw new Error("Missing waId");
  await ensureIndexedKey(k);
  await redisSet(K_USER(id, k), String(value ?? ""));
  return { ok: true };
}

export async function delCopyUser(waId, key) {
  const k = escapeKey(key);
  const id = String(waId ?? "").trim();
  if (!id) throw new Error("Missing waId");
  await ensureIndexedKey(k);
  await redisDel(K_USER(id, k));
  return { ok: true };
}

export function groupCatalog() {
  const groups = {};
  for (const row of COPY_CATALOG) {
    const cat = row.category || "Outros";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(row);
  }
  return groups;
}
