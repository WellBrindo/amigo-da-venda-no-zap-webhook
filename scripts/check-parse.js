// scripts/check-parse.js
// Preflight de parse para evitar SyntaxError no Render.
// Uso: node scripts/check-parse.js
// Saída: exit(0) se OK, exit(1) se algum arquivo falhar.

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

function listJsFiles(dir) {
  const out = [];
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) {
      // ignora node_modules e pastas escondidas
      if (it.name === "node_modules" || it.name.startsWith(".")) continue;
      out.push(...listJsFiles(p));
    } else if (it.isFile() && it.name.endsWith(".js")) {
      out.push(p);
    }
  }
  return out;
}

const base = path.join(process.cwd(), "src");
if (!fs.existsSync(base)) {
  console.error("Pasta src/ não encontrada. Rode a partir da raiz do projeto.");
  process.exit(1);
}

const files = listJsFiles(base);
let failed = 0;

for (const f of files) {
  try {
    execSync(`node --check "${f}"`, { stdio: "pipe" });
  } catch (err) {
    failed++;
    const msg = String(err?.stdout || err?.stderr || err?.message || err);
    console.error("\n[PARSE FAIL]", f);
    console.error(msg.trim());
  }
}

if (failed) {
  console.error(`\nTotal com erro: ${failed}`);
  process.exit(1);
}

console.log(`OK: ${files.length} arquivo(s) verificado(s).`);
process.exit(0);
