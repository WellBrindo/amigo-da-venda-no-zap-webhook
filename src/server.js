import express from "express";
import { adminRouter } from "./routes/admin.js";
import { redisPing } from "./services/redis.js";

const app = express();
app.use(express.json());

// Health básico
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "amigo-das-vendas",
    version: "16.0.1-modular-redis-test"
  });
});

// Health Redis
app.get("/health-redis", async (req, res) => {
  try {
    const result = await redisPing();
    res.json({
      ok: true,
      redis: result
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

// Admin
app.use("/admin", adminRouter());

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
