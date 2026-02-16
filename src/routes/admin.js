import { Router } from "express";

export function adminRouter() {
  const router = Router();

  router.get("/", (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin - Amigo das Vendas</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; margin:24px;}
    .card{max-width:720px; padding:16px 18px; border:1px solid #e5e7eb; border-radius:12px;}
    a{display:inline-block; margin:6px 10px 0 0; text-decoration:none; padding:10px 12px; border:1px solid #e5e7eb; border-radius:10px;}
    a:hover{background:#f3f4f6;}
    .muted{color:#6b7280; font-size:14px;}
  </style>
</head>
<body>
  <div class="card">
    <h2>📊 Admin (V16 Modular)</h2>
    <div class="muted">Isso é só um teste do módulo de rotas. Ainda não migramos o dashboard completo.</div>
    <div style="margin-top:12px;">
      <a href="/health">✅ Health</a>
    </div>
  </div>
</body>
</html>`);
  });

  return router;
}
