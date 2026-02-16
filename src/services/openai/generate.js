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

export async function generateAdText({
  userText,
  mode = "FIXED",
  maxTokens = 650,
}) {
  assertOpenAIEnv();

  const clean = String(userText || "").trim();
  if (!clean) throw new Error("Missing userText");

  const systemFixed = [
    "Você é um redator publicitário especialista em anúncios curtos para WhatsApp.",
    "Crie um anúncio pronto para copiar e colar.",
    "Use linguagem simples, persuasiva, emocional e direta.",
    "Formato FIXO obrigatório:",
    "1) Linha de título com emoji + texto em negrito (use *negrito* do WhatsApp)",
    "2) 2 a 3 linhas de benefício",
    "3) 3 bullets com emoji",
    "4) Bloco final com preço (se houver), local e horário como 'Sob consulta' se não informado",
    "5) CTA curto no final",
    "Não invente informações específicas. Se faltar informação, use 'Sob consulta'.",
  ].join("\n");

  const systemFree = [
    "Você é um redator publicitário especialista em anúncios curtos para WhatsApp.",
    "Crie um anúncio pronto para copiar e colar.",
    "Use linguagem simples, persuasiva, emocional e direta.",
    "Formato LIVRE: você pode escolher a melhor estrutura para conversão.",
    "Ainda assim: não invente informações específicas. Se faltar informação, use 'Sob consulta'.",
    "Evite textos longos; seja objetivo.",
  ].join("\n");

  const system = mode === "FREE" ? systemFree : systemFixed;

  const payload = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: clean },
    ],
    max_tokens: Number(maxTokens), // 🔥 CORRIGIDO AQUI
    temperature: 0.7,
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
