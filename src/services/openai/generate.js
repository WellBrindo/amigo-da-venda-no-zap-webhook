import { getCopyText } from "../copy.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function assertOpenAIEnv() {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryable(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function buildQualityGuard(mode) {
  const modeLabel = mode === "FREE" ? "LIVRE" : "FIXO";

  return [
    `Validação obrigatória do modo ${modeLabel}: antes de responder, revise silenciosamente o texto final inteiro e só entregue a versão revisada.`,
    "O usuário pode escrever de forma informal, resumida, com erros de digitação, abreviações, mistura de ideias ou frases incompletas.",
    "Sua função é transformar essas informações em um anúncio claro, fluido, bem escrito, agradável de ler e adequado para divulgação.",
    "Você pode reorganizar, reescrever e elevar o nível de formalidade do texto final quando isso melhorar a qualidade do anúncio.",
    "Corrija gramática, concordância, pontuação, acentuação, clareza e fluidez somente na redação do anúncio final.",
    "Nunca entregue palavras truncadas, frases quebradas, pedaços de palavras, trechos sem sentido, restos de frase ou linhas linguisticamente mutiladas.",
    "Se uma frase estiver ruim ou estranha, reescreva naturalmente antes de responder.",
    "Preserve fielmente o conteúdo real informado pelo usuário.",
    "Preserve exatamente nomes próprios, nomes de empresas, marcas, nomes de produtos, slogans, expressões comerciais, termos em outros idiomas, regionalismos e grafias intencionais de identidade comercial.",
    "Não traduza, não normalize e não tente corrigir nomes próprios, marcas, slogans ou expressões intencionais do usuário.",
    "Nunca troque uma palavra só porque parece diferente do português padrão se ela puder ser nome comercial, marca, slogan, termo estrangeiro ou escolha estilística do usuário.",
    "Você pode deixar o anúncio final mais profissional, mais organizado e mais vendedor do que a forma bruta escrita pelo usuário, mas sem inventar fatos e sem alterar a identidade textual essencial do conteúdo informado.",
    "Retorne somente o anúncio final pronto para envio.",
  ].join("\n");
}

export async function generateAdText({
  userText,
  mode = "FIXED",
  maxTokens = 650,
  systemKey = null,
}) {
  assertOpenAIEnv();

  const clean = String(userText || "").trim();
  if (!clean) throw new Error("Missing userText");

  const resolvedMode = String(mode || "FIXED").trim().toUpperCase() === "FREE" ? "FREE" : "FIXED";
  const resolvedSystemKey = String(systemKey || "").trim().toUpperCase();

  const systemFixed = await getCopyText("OPENAI_SYSTEM_FIXED");
  const systemFree = await getCopyText("OPENAI_SYSTEM_FREE");

  const explicitSystem = resolvedSystemKey ? await getCopyText(resolvedSystemKey) : "";
  const system = explicitSystem || (resolvedMode === "FREE" ? systemFree : systemFixed);
  const qualityGuard = buildQualityGuard(resolvedMode);

  const modeGuard = resolvedMode === "FREE"
    ? "Modo LIVRE: escolha a melhor estrutura para conversão, mantendo clareza, visual bonito e fidelidade às informações do usuário."
    : "Modo FIXO: mantenha estrutura consistente, bem organizada, visualmente bonita e focada em conversão no WhatsApp.";

  const payload = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "system", content: modeGuard },
      { role: "system", content: qualityGuard },
      { role: "user", content: clean },
    ],
    max_tokens: Number(maxTokens),
    temperature: 0.45,
  };

  const url = "https://api.openai.com/v1/chat/completions";

  let lastErr = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const status = res.status;
        const msg = data?.error?.message || `HTTP ${status}`;
        const err = new Error(`OpenAI error: ${msg}`);
        err.status = status;

        if (isRetryable(status) && attempt < 3) {
          lastErr = err;
          await sleep(300 * attempt);
          continue;
        }
        throw err;
      }

      const text =
        data?.choices?.[0]?.message?.content
          ? String(data.choices[0].message.content).trim()
          : "";

      if (!text) throw new Error("OpenAI returned empty content");

      return { text, model: OPENAI_MODEL };
    } catch (e) {
      lastErr = e;
      if (attempt < 3) {
        await sleep(250 * attempt);
        continue;
      }
      throw lastErr;
    }
  }

  throw lastErr || new Error("OpenAI failed");
}
