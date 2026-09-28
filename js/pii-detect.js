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
  { type: "email", risk: "high", label: "E-mail",
    test: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()) },
  { type: "phone", risk: "high", label: "Telefone",
    test: (v) => /^(\+?55)?\s?\(?\d{2}\)?\s?\d{4,5}-?\d{4}$/.test(String(v).trim()) },
  { type: "cep", risk: "low", label: "CEP",
    test: (v) => /^\d{5}-?\d{3}$/.test(String(v).trim()) },
  { type: "date", risk: "medium", label: "Data de nascimento",
    test: (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim()) || /^\d{2}\/\d{2}\/\d{4}$/.test(String(v).trim()) },
];

// Dicas por NOME de coluna — a MESMA tabela da biblioteca (`_NAME_HEURISTICS`), na mesma ordem, com os
// tipos da prévia ("phone" = telefone; "date" = data de nascimento; "cartao" = cartão de crédito).
const NAME_HINTS = {
  cpf: ["cpf", "cadastro_pessoa", "documento", "doc_pessoa"],
  cnpj: ["cnpj", "cadastro_nacional", "doc_empresa"],
  email: ["email", "e_mail", "mail", "correio", "e-mail"],
  phone: ["telefone", "celular", "fone", "phone", "tel", "whatsapp", "contato"],
  cep: ["cep", "codigo_postal", "zipcode", "zip", "cod_postal"],
  date: ["nascimento", "birth", "dob", "dt_nasc", "data_nasc", "aniversario", "birthdate", "data_nascimento"],
  nome: ["nome", "name", "sobrenome", "first_name", "last_name", "razao_social", "cliente", "paciente",
    "usuario", "proprietario", "responsavel", "titular"],
  rg: ["rg", "registro_geral", "identidade", "doc_rg"],
  ip: ["ip", "endereco_ip", "ip_address", "host_ip"],
  cartao: ["cartao", "card", "credit_card", "pan", "numero_cartao"],
};

// Tipo, risco e rótulo quando só o NOME da coluna revela o tipo — os riscos são os da biblioteca
// (`_strategy_and_risk`). Vale para todos os tipos, não só os sem regex de valor: a biblioteca aceita a
// coluna "cpf" mesmo com valores que não batem, assumindo 50% de confiança.
const NAME_TYPE_INFO = {
  cpf: { risk: "high", label: "CPF" },
  cnpj: { risk: "high", label: "CNPJ" },
  email: { risk: "high", label: "E-mail" },
  phone: { risk: "high", label: "Telefone" },
  cep: { risk: "low", label: "CEP" },
  date: { risk: "medium", label: "Data de nascimento" },
  nome: { risk: "medium", label: "Nome" },
  rg: { risk: "high", label: "RG" },
  ip: { risk: "medium", label: "Endereço IP" },
  cartao: { risk: "high", label: "Cartão de crédito" },
};

// Colunas técnicas que nunca são PII só pelo nome (`_SAFE_*` da biblioteca).
const SAFE_TOKENS = new Set([
  "id", "pk", "fk", "key", "index", "idx", "row_num", "created", "updated", "deleted",
  "valor", "value", "price", "amount", "preco", "quantidade", "count", "total", "score", "rank",
  "version", "versao", "uuid", "guid", "token", "hash", "arquivo", "file", "filename", "filepath", "path",
  "tabela", "table", "relatorio", "report", "log", "sistema", "system", "modulo", "module", "tipo",
  "timestamp", "num", "seq", "cod", "code", "admissao", "admissão", "contratacao", "contratação",
  "cadastro", "criacao", "criação", "atualizacao", "vencimento", "expiracao", "validade", "referencia",
  "pedido", "compra", "venda", "entrega", "envio", "fatura",
]);
const SAFE_EXACT = new Set(["id", "pk", "fk", "key", "index", "idx", "row_num", "created", "updated", "deleted"]);
const SAFE_AFFIXES = [["id", "suffix"], ["id", "prefix"], ["pk", "suffix"], ["fk", "suffix"],
  ["num", "prefix"], ["seq", "prefix"], ["cod", "prefix"], ["code", "prefix"]];

const splitTokens = (name) => new Set(name.split(/[_\-\s]+/));

function isSafeTechnicalColumn(nameLower) {
  if (SAFE_EXACT.has(nameLower)) return true;
  const tokens = splitTokens(nameLower);
  for (const t of tokens) if (SAFE_TOKENS.has(t)) return true;
  return SAFE_AFFIXES.some(([affix, pos]) =>
    (pos === "prefix" && nameLower.startsWith(`${affix}_`)) || (pos === "suffix" && nameLower.endsWith(`_${affix}`)));
}

/**
 * Tipo sugerido SÓ pelo nome da coluna. Casa por PALAVRA INTEIRA (não por trecho): "tipo" não vira IP,
 * "margem" não vira RG, "hotel" não vira telefone — falsos positivos que a biblioteca tinha ao casar
 * por substring (corrigidos também no software completo, ver server/datalock_studio/library_fixes.py).
 */
export function nameHintType(columnName) {
  const nameLower = String(columnName).toLowerCase();
  if (isSafeTechnicalColumn(nameLower)) return null;
  const tokens = splitTokens(nameLower);
  for (const [type, keywords] of Object.entries(NAME_HINTS)) {
    for (const kw of keywords) {
      const kwTokens = splitTokens(kw);
      if ([...kwTokens].every((t) => tokens.has(t))) return type;
    }
  }
  return null;
}

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

  const hinted = nameHintType(columnName);
  let best = null;

  for (const pattern of PATTERNS) {
    // "Data" só é dado pessoal quando a coluna é de nascimento (como na biblioteca) — uma coluna
    // "data_pedido" não é PII, mesmo cheia de datas.
    if (pattern.type === "date" && hinted !== "date") continue;
    const matches = nonNull.filter((v) => pattern.test(v)).length;
    const matchRatio = matches / nonNull.length;
    const nameMatches = hinted === pattern.type;

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
  if (!best && hinted && NAME_TYPE_INFO[hinted]) {
    // Nenhum padrão de valor bateu, mas o nome da coluna indica o tipo: mesma decisão da biblioteca —
    // aceita com 50% de confiança assumida.
    return { type: hinted, ...NAME_TYPE_INFO[hinted], matchRatio: 0.5 };
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
