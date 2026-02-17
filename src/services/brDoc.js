// src/services/brDoc.js
/**
 * Validação de CPF / CNPJ (dígitos verificadores).
 * - Entrada: string (pode ter pontuação)
 * - Saída: { ok, type, digits, last4 }
 *
 * Importante:
 * - NUNCA logar o documento.
 */

function onlyDigits(s) {
  return String(s ?? "").replace(/\D/g, "");
}

function allSameDigits(digits) {
  return /^(\d)\1+$/.test(digits);
}

// -------- CPF --------
function cpfIsValid(cpfDigits) {
  const cpf = onlyDigits(cpfDigits);
  if (cpf.length !== 11) return false;
  if (allSameDigits(cpf)) return false;

  const nums = cpf.split("").map((c) => Number(c));

  // dv1
  let sum1 = 0;
  for (let i = 0; i < 9; i++) sum1 += nums[i] * (10 - i);
  let dv1 = (sum1 * 10) % 11;
  if (dv1 === 10) dv1 = 0;
  if (dv1 !== nums[9]) return false;

  // dv2
  let sum2 = 0;
  for (let i = 0; i < 10; i++) sum2 += nums[i] * (11 - i);
  let dv2 = (sum2 * 10) % 11;
  if (dv2 === 10) dv2 = 0;
  if (dv2 !== nums[10]) return false;

  return true;
}

// -------- CNPJ --------
function cnpjIsValid(cnpjDigits) {
  const cnpj = onlyDigits(cnpjDigits);
  if (cnpj.length !== 14) return false;
  if (allSameDigits(cnpj)) return false;

  const nums = cnpj.split("").map((c) => Number(c));

  const calcDV = (base, weights) => {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) sum += base[i] * weights[i];
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };

  const base12 = nums.slice(0, 12);
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const dv1 = calcDV(base12, w1);
  if (dv1 !== nums[12]) return false;

  const base13 = nums.slice(0, 13);
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const dv2 = calcDV(base13, w2);
  if (dv2 !== nums[13]) return false;

  return true;
}

export function validateDoc(input) {
  const digits = onlyDigits(input);

  if (digits.length === 11) {
    const ok = cpfIsValid(digits);
    return {
      ok,
      type: ok ? "CPF" : "",
      digits: ok ? digits : "",
      last4: ok ? digits.slice(-4) : "",
    };
  }

  if (digits.length === 14) {
    const ok = cnpjIsValid(digits);
    return {
      ok,
      type: ok ? "CNPJ" : "",
      digits: ok ? digits : "",
      last4: ok ? digits.slice(-4) : "",
    };
  }

  return { ok: false, type: "", digits: "", last4: "" };
}
