import express from "express";

const app = express();
app.use(express.json());

// Health check (para você testar no navegador)
app.get("/", (_req, res) => {
  res.status(200).send("OK - Amigo da Venda no Zap webhook rodando");
});

/**
 * Webhook de verificação (Meta chama via GET)
 * Você vai configurar VERIFY_TOKEN no Render.
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * Webhook de eventos (mensagens e status)
 * Por enquanto só confirma recebimento.
 */
app.post("/webhook", (req, res) => {
  // Log básico (depois a gente melhora)
  console.log("Evento recebido:", JSON.stringify(req.body));
  return res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
