import express from "express";
import { adminRouter } from "./routes/admin.js";

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "amigo-das-vendas",
    version: "16.0.0-modular-base"
  });
});

app.use("/admin", adminRouter());

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
