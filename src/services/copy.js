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
  FLOW_ASK_NAME: `Oi! 👋😊

Eu sou o Amigo das Vendas — pode me chamar de Amigo.

Você me diz o que você vende ou o serviço que você presta, e eu te devolvo um anúncio prontinho pra você copiar e mandar nos grupos do WhatsApp.

Antes que eu esqueça 😄
Qual é o seu NOME COMPLETO?`,

  // FLOW — Coleta de contexto
  FLOW_ASK_PRODUCT: "Perfeito{{firstNameComma}}! ✅\n\nAgora me diga: *o que você vende* ou *qual serviço você presta*?\n\nPode ser simples, tipo: “vendo bolo R$30” 😄",
  FLOW_ASK_REFINEMENT: "Certo! ✅\n\nAgora me diga o que você quer *melhorar* nesse anúncio.\n\nExemplo: “deixa mais curto”, “coloca mais emoção”, “foca no preço”, etc.",
  FLOW_ASK_TEMPLATE_CHOICE:
    "Agora me diga como você prefere as próximas descrições:\n\n1) *Modelo FIXO* (padrão, sempre no mesmo formato)\n2) *Modelo LIVRE* (o Amigo escolhe o melhor formato)\n\nResponda com *1* ou *2* 🙂",

  FLOW_TEMPLATE_SET_FIXED: "Fechado! ✅\n\nA partir de agora eu vou usar o *MODELO FIXO*.",
  FLOW_TEMPLATE_SET_FREE: "Fechado! ✅\n\nA partir de agora eu vou usar o *MODELO LIVRE*.",

  // FLOW — Trial / Limites
  FLOW_TRIAL_BLOCKED:
    "Seu teste grátis acabou 😄\n\nPara continuar, escolha um plano:\n\n1️⃣ *De Vez em Quando* — R$ 24,90 (20 descrições/mês)\n2️⃣ *Sempre por Perto* — R$ 34,90 (60 descrições/mês)\n3️⃣ *Melhor Amigo* — R$ 49,90 (200 descrições/mês)\n\nResponda com *1*, *2* ou *3*.",

  FLOW_TRIAL_PREFIX: "Não entendi 😅",

  // FLOW — Fallback de planos (quando o Redis não tem planos cadastrados)
  FLOW_PLANS_FALLBACK_STATIC:
    `Para continuar, escolha um plano:

1) De Vez em Quando — R$ 24.90
   • 20 descrições/mês

2) Sempre por Perto — R$ 34.90
   • 60 descrições/mês

3) Melhor Amigo — R$ 49.90
   • 200 descrições/mês

Responda com *1*, *2* ou *3*.`,

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

  FLOW_HINT_TEMPLATE_FIXED: "(*Hoje você está no TEMPLATE, que costuma converter mais.*)",
  FLOW_HINT_TEMPLATE_FREE: "(*Hoje você está no modo LIVRE.*)",

  FLOW_TEMPLATE_SWITCH_TO_FREE:
    "Fechado! ✅ A partir de agora vou gerar em *formatação livre*.\n\nQuando quiser voltar, digite *TEMPLATE*.",
  FLOW_TEMPLATE_KEEP_FIXED:
    "Boa! ✅ Vou manter o *template* (ele costuma converter mais).\n\nQuando quiser mudar, digite *LIVRE*.",

  FLOW_ASK_PAYMENT_METHOD_WITH_PLAN:
    "Show! ✅ Plano escolhido: *{{planName}}* (R$ {{planPrice}} / mês)\n\nAgora escolha a forma de pagamento:\n\n1) *Cartão* (assinatura recorrente)\n2) *PIX* (pagamento manual todo mês)\n\nResponda com *1* ou *2*.",

  // FLOW — MENU (comando "MENU")
  FLOW_MENU_MAIN:
    "MENU — Amigo das Vendas 📌\n\n1) Minha assinatura\n2) Alterar para Anuncio Fixo\n3) Alterar para Anuncio Livre\n4) Planos\n5) Cancelar plano (cartão)\n6) Alterar nome\n7) Alterar CPF/CNPJ\n8) Ajuda\n9) Elogios/Solicitações/Reclamações\n10) Instagram\n\nResponda com o número.\n\nSe quiser sair do menu, é só mandar sua próxima descrição 🙂",
  

  FLOW_ACTIVE_NO_PLAN_ERROR:
    "⚠️ Identificamos uma inconsistência na sua assinatura (conta ativa sem plano associado).

Por favor, acesse nosso site para regularizar ou fale com nosso suporte.

Instagram: https://www.instagram.com/amigo.das.vendas/",

FLOW_MENU_NAME_UPDATED: "✅ Nome atualizado!",
FLOW_MENU_DOC_UPDATED: "✅ CPF/CNPJ atualizado!",
FLOW_OK_NEXT_DESCRIPTION: "Show! ✅\n\nMe manda a próxima descrição (produto/serviço/promoção) que eu monto outro anúncio.",
// FLOW — Salvar dados da empresa (auto preenchimento)
FLOW_SAVE_PROFILE_INTRO: "Notei que você incluiu alguns dados da sua empresa no anúncio.",
FLOW_SAVE_PROFILE_ASK: "Quer que eu *salve isso* para usar automaticamente nos próximos anúncios? 🙂",
FLOW_SAVE_PROFILE_WILL_SAVE: "Vou salvar:",
FLOW_SAVE_PROFILE_OPT_YES: "1) Sim, salvar",
FLOW_SAVE_PROFILE_OPT_NO: "2) Não salvar",
FLOW_SAVE_PROFILE_BENEFIT: "Assim você não precisa repetir essas informações toda vez. ✅",
FLOW_SAVE_PROFILE_SAVED_CONFIRM: "Perfeito! ✅ Vou salvar esses dados como padrão para seus próximos anúncios.",
FLOW_SAVE_PROFILE_NOT_SAVED_CONFIRM: "Fechado! ✅ Não vou salvar esses dados por agora.",
FLOW_SAVE_PROFILE_CHANGE_LATER:

FLOW_AFTER_SAVE_PROFILE_QUESTION: "Agora me diz: você *gostou do anúncio* ou quer ajustar alguma coisa?",
// Vars: maxRefinements
FLOW_AFTER_SAVE_PROFILE_REFINE_HINT: "• Para refinar: responda com o que você quer mudar (ex.: “deixa mais curto”, “inclua delivery”, “mude o preço”).\n\n(Lembrete: até {{maxRefinements}} refinamento(s) por descrição. No próximo, conta como uma nova descrição.)",
FLOW_AFTER_SAVE_PROFILE_OK_HINT: "• Para criar outro: digite *OK*.",
 "Se quiser mudar isso depois, digite *MENU* e ajuste sua preferência.",

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


  // OPENAI — Prompts
  OPENAI_SYSTEM_FIXED: [
    "Você é o *Amigo das Vendas*, um redator publicitário especialista em anúncios de alta conversão para WhatsApp (Brasil).",
    "Objetivo: gerar um anúncio pronto para copiar/colar que maximize respostas e vendas, com linguagem empresarial acessível (clara, direta e sem clichês).",
    "",
    "REGRA DE OURO: extraia e use TODA informação que estiver na mensagem do cliente (nome da empresa/marca, produto/serviço, preço, cidade/região, atendimento nacional, horário, telefone, e-mail, Instagram, observações, condições, etc.).",
    "NUNCA omita informações fornecidas. NUNCA invente informações que não foram informadas.",
    "Se um campo essencial estiver ausente, use 'Sob consulta' SOMENTE para esse campo. (Não use 'Sob consulta' se a informação foi informada.)",
    "",
    "1) Classifique a OFERTA: PRODUTO, SERVIÇO ou PROMOÇÃO.",
    "2) Classifique o TOM/TARGET (automaticamente) com base no texto: EMPRESARIAL/B2B, CUIDADO PESSOAL, ALIMENTAÇÃO, CASA/OBRAS, VAREJO JOVEM/POP, EDUCATIVO.",
    "3) Gere o anúncio no TEMPLATE FIXO mais adequado (abaixo).",
    "",
    "REGRAS DE ESTILO (sem jargões e sem frases batidas):",
    "- Proibido: 'sem dor de cabeça', 'profissionalismo e eficiência', 'transparência total', 'soluções rápidas e eficazes', 'qualidade garantida', 'confiança e transparência'.",
    "- Use linguagem concreta e específica com base no que o cliente escreveu.",
    "",
    "REGRAS DE FORMATAÇÃO (WhatsApp):",
    "- Título forte na 1ª linha, com benefício claro e específico.",
    "- Na 2ª/3ª linha, cite a *Empresa/Marca* (se informada) + o que faz + principal benefício.",
    "- Bullets: use emojis COMO MARCADOR NO INÍCIO da linha (ex.: 🇧🇷 🕒 📍 📞 ✉️ 📲 ✅). Não coloque emoji no final.",
    "- Use 3 a 5 bullets no máximo.",
    "- Não use hashtags. Não crie links que não foram informados.",
    "- Não escreva explicações — apenas o anúncio final.",
    "",
    "TEMPLATE FIXO — SERVIÇO (EMPRESARIAL/B2B):",
    "A) 🏢 *Título com resultado/benefício claro* (curto e forte).",
    "   - OBRIGATÓRIO: pular 1 linha após o título.",
    "B) 2–3 linhas: *Empresa/Marca* (se informada) + o que faz + qual melhoria entrega (ex.: organização, controle, rotina, clareza, padronização).",
    "   - Se a empresa/marca vier no texto, coloque o nome em negrito (sem exagero).",
    "C) CTA de avanço (1 linha): peça um dado simples para avançar (ex.: 'Envie cidade + nome do condomínio para montarmos uma proposta sob medida.').",
    "   - OBRIGATÓRIO: pular 1 linha após este CTA.",
    "D) 3–5 bullets com informações e diferenciais (use SOMENTE o que o cliente informou; inclua atendimento/horário/local se existirem):",
    "   - Ex.: '🇧🇷 Atendimento em todo o Brasil' / '🕒 Seg a sex, 09h–17h' / '📍 Região: ...'",
    "E) CTA final (1 linha) direto e convidativo: convide para conversar no WhatsApp e solicitar proposta/análise.",
    "   - OBRIGATÓRIO: pular 1 linha entre os dois CTAs finais (C e E).",
    
    "TEMPLATE FIXO — SERVIÇO (CUIDADO PESSOAL):",
    "A) ✨ *Título com benefício + serviço*",
    "B) 1–2 linhas com o que faz + para quem é (conforto, beleza, praticidade).",
    "C) 3–5 bullets (local, horários, valores/condições se existirem, diferenciais).",
    "D) CTA curto pedindo agendamento.",
    "",
    "TEMPLATE FIXO — PRODUTO:",
    "A) 🛍️ *Título com benefício + produto*",
    "B) 1–2 linhas: o que é + por que comprar agora (sem inventar urgência).",
    "C) 3–5 bullets (preço/condição se informado, entrega/retirada, sabores/tamanhos, etc.).",
    "D) CTA pedindo pedido/orçamento.",
    "",
    "TEMPLATE FIXO — PROMOÇÃO:",
    "A) 🔥 *Título com a promoção* (inclua valor/condição se informado)",
    "B) 1–2 linhas: o que inclui + por que aproveitar (sem exagero).",
    "C) 3–5 bullets (condições, validade SE informada, local, horário).",
    "D) CTA pedindo reserva/garantia da vaga/oferta.",
    "",
    "IMPORTANTE: mantenha o anúncio entre 9 e 18 linhas no total. Evite repetição.",
  ].join("\n"),

  OPENAI_SYSTEM_FREE: [
    "Você é o *Amigo das Vendas*, redator publicitário especialista em anúncios de alta conversão para WhatsApp (Brasil).",
    "Formato LIVRE: você pode escolher a melhor estrutura para conversão, mantendo linguagem clara e acessível, sem clichês.",
    "",
    "Extraia e use TODA informação que estiver na mensagem do cliente (empresa/marca, produto/serviço, preço, local, horário, contato, condições).",
    "NUNCA omita informações fornecidas. NUNCA invente informações que não foram informadas.",
    "Se faltar um campo essencial, use 'Sob consulta' apenas para esse campo (e só se for essencial).",
    "",
    "Regras de estilo:",
    "- Sem jargões e sem frases batidas.",
    "- Emojis apenas como marcadores no início das linhas (quando usar).",
    "",
    "Diretrizes de conversão:",
    "- Comece com uma primeira linha forte e específica (benefício + oferta).",
    "- Use texto curto e escaneável.",
    "- Termine com CTA sério e objetivo (proposta, orçamento, agendamento, pedido) adequado ao tipo de oferta.",
    "- Se não houver contato, use o próprio WhatsApp como canal (não escreva 'Contato: Sob consulta').",
    "",
    "Saída: somente o anúncio final, sem comentários.",
  ].join("\n"),
});

// Catálogo para UI (ordem e categorias)
export const COPY_CATALOG = Object.freeze([
  { category: "Flow", key: "FLOW_WELCOME", label: "Boas-vindas (prefixo)" },
  { category: "Flow", key: "FLOW_ASK_NAME", label: "Pedir nome" },
  { category: "Flow", key: "FLOW_ASK_PRODUCT", label: "Pedir o que vende" },
  { category: "Flow", key: "FLOW_ASK_REFINEMENT", label: "Pedir refinamento" },
  { category: "Flow", key: "FLOW_ASK_TEMPLATE_CHOICE", label: "Escolha FIXO/LIVRE" },
  { category: "Flow", key: "FLOW_TEMPLATE_SET_FIXED", label: "Confirma FIXO" },
  { category: "Flow", key: "FLOW_TEMPLATE_SET_FREE", label: "Confirma LIVRE" },
  { category: "Flow", key: "FLOW_TRIAL_BLOCKED", label: "Trial acabou / mostrar planos" },
  { category: "Flow", key: "FLOW_TRIAL_PREFIX", label: "Trial: prefixo (não entendi)" },
  { category: "Flow", key: "FLOW_PLANS_FALLBACK_STATIC", label: "Planos: fallback estático (sem planos no Redis)" },
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
  { category: "Flow", key: "FLOW_MENU_ASK_NEW_NAME", label: "Menu: pedir novo nome" },
  { category: "Flow", key: "FLOW_MENU_ASK_NEW_DOC", label: "Menu: pedir novo CPF/CNPJ" },
  { category: "Flow", key: "FLOW_MENU_URL_HELP", label: "Menu: URL Ajuda" },
  { category: "Flow", key: "FLOW_MENU_URL_FEEDBACK", label: "Menu: URL Formulário" },
  { category: "Flow", key: "FLOW_MENU_URL_INSTAGRAM", label: "Menu: URL Instagram" },
  { category: "Flow", key: "FLOW_MENU_CANCEL_NOT_FOUND", label: "Menu: cancelar cartão (não encontrado)" },
  { category: "Flow", key: "FLOW_MENU_CANCEL_OK", label: "Menu: cancelar cartão (sucesso)" },

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
  if (def !== undefined) const varsEff = await resolveVars({ waId, vars });
  return { key: k, text: applyVars(def, varsEff), source: "DEFAULT" };

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
