/**
 * pii-detect.js
 * =============
 * Heurística LEVE de detecção de PII, rodando 100% no navegador, para dar
 * sugestões na UI no-code ("essa coluna parece ser CPF — quer mascarar?").
 *
 * ISTO NÃO É o PIIDetector real do datalock (que usa validação de dígito
 * verificador de CPF/CNPJ, amostragem estatística, e várias dezenas de
 * padrões). É uma aproximação por regex simples, suficiente para sugerir
 * ações na interface — sempre deixe o usuário confirmar/trocar o tipo
 * antes de mascarar. Para o relatório de conformidade "de verdade", use o
 * software completo (`dd.scan(df)` / `dd.profile(df)`).
 */

const PATTERNS = [
  { type: "cpf", risk: "high", label: "CPF",
    test: (v) => /^\d{3}\.?\d{3}\.?\d{3}-?\d{2}$/.test(String(v).trim()) },
  { type: "cnpj", risk: "high", label: "CNPJ",
    test: (v) => /^\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}$/.test(String(v).trim()) },
  { type: "email", risk: "medium", label: "E-mail",
    test: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()) },
  { type: "phone", risk: "medium", label: "Telefone",
    test: (v) => /^(\+?55)?\s?\(?\d{2}\)?\s?\d{4,5}-?\d{4}$/.test(String(v).trim()) },
  { type: "cep", risk: "low", label: "CEP",
    test: (v) => /^\d{5}-?\d{3}$/.test(String(v).trim()) },
  { type: "date", risk: "low", label: "Data",
    test: (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) || /^\d{2}\/\d{2}\/\d{4}$/.test(String(v).trim()) },
];

const NAME_HINTS = {
  cpf: ["cpf", "documento", "cic"],
  cnpj: ["cnpj"],
  email: ["email", "e-mail", "mail"],
  phone: ["telefone", "celular", "fone", "phone", "whatsapp"],
  cep: ["cep", "codigo_postal", "zip"],
  date: ["data", "nascimento", "date", "dt_"],
};

/**
 * Analisa uma amostra de valores de uma coluna e sugere o tipo de PII mais
 * provável (ou null se não parecer PII).
 *
 * @param {string} columnName
 * @param {Array} sampleValues  Até ~200 valores não-nulos já é suficiente.
 * @returns {{type: string, risk: "high"|"medium"|"low", label: string, matchRatio: number} | null}
 */
export function suggestPiiType(columnName, sampleValues) {
  const nonNull = sampleValues.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
  if (nonNull.length === 0) return null;

  const nameLower = columnName.toLowerCase();
  let best = null;

  for (const pattern of PATTERNS) {
    const matches = nonNull.filter((v) => pattern.test(v)).length;
    const matchRatio = matches / nonNull.length;
    const nameMatches = (NAME_HINTS[pattern.type] || []).some((hint) => nameLower.includes(hint));

    // Só sugere se a maioria dos valores bate com o padrão, OU o nome da
    // coluna já é um forte indício (mesmo com poucos valores batendo —
    // ex.: uma coluna "cpf" cheia de valores mascarados/nulos na amostra).
    if (matchRatio >= 0.7 || (nameMatches && matchRatio >= 0.3)) {
      const score = matchRatio + (nameMatches ? 0.5 : 0);
      if (!best || score > best.score) {
        best = { type: pattern.type, risk: pattern.risk, label: pattern.label, matchRatio, score };
      }
    }
  }
  if (!best) return null;
  const { score, ...result } = best;
  return result;
}

/**
 * Roda a heurística em todas as colunas de uma tabela — equivalente
 * simplificado de dd.scan(df). Usa até `sampleSize` linhas.
 *
 * @param {{columns: string[], rows: Array<object>}} table
 * @param {number} sampleSize
 * @returns {Record<string, ReturnType<typeof suggestPiiType>>}
 */
export function scanTable(table, sampleSize = 200) {
  const sample = table.rows.slice(0, sampleSize);
  const report = {};
  for (const col of table.columns) {
    const values = sample.map((r) => r[col]);
    const suggestion = suggestPiiType(col, values);
    if (suggestion) report[col] = suggestion;
  }
  return report;
}

/**
 * Métrica simplificada de "score de privacidade" (0–100), inspirada em
 * dd.profile() — não é o cálculo real (k-anonimato, risco de
 * reidentificação etc. exigem o motor Python), só uma referência visual.
 */
export function quickPrivacyScore(table) {
  const report = scanTable(table);
  const nPii = Object.keys(report).length;
  const nCols = table.columns.length || 1;
  const nHigh = Object.values(report).filter((r) => r.risk === "high").length;
  const exposure = Math.round((nPii / nCols) * 100);
  const penalty = nHigh * 15;
  const total = Math.max(0, Math.min(100, 100 - exposure - penalty));
  let grade = "A";
  if (total < 40) grade = "D";
  else if (total < 60) grade = "C";
  else if (total < 80) grade = "B";
  return { total, grade, nPiiColumns: nPii, nHighRisk: nHigh, report };
}
