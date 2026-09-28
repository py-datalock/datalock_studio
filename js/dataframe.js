/**
 * dataframe.js
 * ============
 * Motor de tabela em memória, 100% JS, sem dependências — implementa as
 * operações que o RECIPE_SCHEMA.md define, para rodar no navegador (GitHub
 * Pages, sem backend). Representação: { columns: string[], rows: object[] }.
 *
 * Este NÃO é o Polars — é deliberadamente simples (arrays de objetos) para
 * rodar sem build step num navegador. Para volumes grandes (milhões de
 * linhas) ou operações mais pesadas, use o software completo (server/),
 * que roda Polars de verdade.
 */

import { hashColumn, encryptSivColumn, decryptSivColumn } from "./crypto-utils.js";
import { suggestPiiType } from "./pii-detect.js";

export function inferDtype(values) {
  const sample = values.filter((v) => v !== null && v !== undefined && v !== "").slice(0, 100);
  if (sample.length === 0) return "string";
  // Testa booleano ANTES de número: Number(true)===1 e Number(false)===0
  // são válidos, então o teste de número por si só classificaria uma
  // coluna 100% booleana como "number" por engano — esse teste tem que
  // vir primeiro, nunca depois.
  const allBooleans = sample.every((v) => ["true", "false", true, false].includes(
    typeof v === "string" ? v.toLowerCase() : v
  ));
  if (allBooleans) return "boolean";
  const allNumbers = sample.every((v) => v !== "" && !isNaN(Number(v)));
  if (allNumbers) return "number";
  const allDates = sample.every((v) => /^\d{4}-\d{2}-\d{2}/.test(String(v)) && !isNaN(Date.parse(v)));
  if (allDates) return "date";
  return "string";
}

/**
 * Uma coluna lida de CSV deve ficar como TEXTO (e não virar número)? Sim se algum valor tiver zero à
 * esquerda seguido de dígitos ("007", "01310100", "01234567890" — CEP, CPF sem pontuação, códigos) ou
 * for um inteiro com 16+ dígitos (cartão; acima disso o JavaScript perde precisão). Converter esses
 * valores para número apagaria os zeros e mudaria o dado (o CPF deixaria de ter 11 dígitos, e o hash
 * seria calculado sobre o valor errado).
 *
 * É a MESMA regra do software completo (`server/datalock_studio/table_io.py`) — mantê-las iguais.
 * Recebe os valores CRUS (texto), como saem do PapaParse sem `dynamicTyping`.
 */
export function needsTextColumn(rawValues) {
  for (const v of rawValues) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t === "") continue;
    if (/^[+-]?0\d+$/.test(t) || /^[+-]?\d{16,}$/.test(t)) return true;
  }
  return false;
}

/**
 * Tipo de uma coluna PARA GRAVAÇÃO (.dlk/Parquet), decidido pelo tipo real dos
 * valores em memória — nunca pelo "aspecto" do texto. Motivo: uma coluna de
 * texto como "00", "02", "98" (código, CEP, CPF sem pontuação...) PARECE número,
 * mas converter para número apagaria os zeros à esquerda e mudaria o dado.
 *   - todos os valores são `number`  -> "number"
 *   - todos os valores são `boolean` -> "boolean"
 *   - qualquer outra coisa           -> "string" (o valor é gravado como texto, sem alterar)
 * (`inferDtype`, acima, continua sendo a inferência "de análise", usada por
 * descrição/correlação/EDA, onde tratar texto numérico como número é o desejado.)
 */
export function inferWriteKind(values) {
  const sample = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (!sample.length) return "string";
  if (sample.every((v) => typeof v === "number")) return "number";
  if (sample.every((v) => typeof v === "boolean")) return "boolean";
  return "string";
}

export function inferWriteSchema(columns, rows) {
  return columns.map((name) => ({ name, dtype: inferWriteKind(rows.map((r) => r[name])) }));
}

export function inferSchema(columns, rows) {
  return columns.map((name) => ({ name, dtype: inferDtype(rows.map((r) => r[name])) }));
}

function cloneTable(table) {
  return { columns: [...table.columns], rows: table.rows.map((r) => ({ ...r })) };
}

// ---------------------------------------------------------------------------
// Seleção / colunas
// ---------------------------------------------------------------------------

export function selectColumns(table, columns) {
  const valid = columns.filter((c) => table.columns.includes(c));
  const rows = table.rows.map((r) => {
    const nr = {};
    for (const c of valid) nr[c] = r[c];
    return nr;
  });
  return { columns: valid, rows };
}

export function dropColumns(table, columns) {
  const keep = table.columns.filter((c) => !columns.includes(c));
  return selectColumns(table, keep);
}

export function renameColumns(table, mapping) {
  const columns = table.columns.map((c) => mapping[c] || c);
  const rows = table.rows.map((r) => {
    const nr = {};
    for (const c of table.columns) nr[mapping[c] || c] = r[c];
    return nr;
  });
  return { columns, rows };
}

// ---------------------------------------------------------------------------
// Filtro
// ---------------------------------------------------------------------------

function evalCondition(row, cond) {
  const v = row[cond.column];
  const target = cond.value;
  switch (cond.op) {
    case "==": return String(v) === String(target);
    case "!=": return String(v) !== String(target);
    case ">": return Number(v) > Number(target);
    case ">=": return Number(v) >= Number(target);
    case "<": return Number(v) < Number(target);
    case "<=": return Number(v) <= Number(target);
    case "contains": return String(v ?? "").toLowerCase().includes(String(target).toLowerCase());
    case "starts_with": return String(v ?? "").toLowerCase().startsWith(String(target).toLowerCase());
    case "ends_with": return String(v ?? "").toLowerCase().endsWith(String(target).toLowerCase());
    case "is_null": return v === null || v === undefined || v === "";
    case "not_null": return !(v === null || v === undefined || v === "");
    case "in": return Array.isArray(target) && target.map(String).includes(String(v));
    default: return true;
  }
}

/** Retorna um array de booleanos (mesmo comprimento de table.rows) — usado por filter e por mask(rows=). */
export function evalRowMask(table, conditions, logic = "and") {
  return table.rows.map((row) => {
    const results = conditions.map((c) => evalCondition(row, c));
    return logic === "or" ? results.some(Boolean) : results.every(Boolean);
  });
}

export function filterRows(table, conditions, logic = "and") {
  const mask = evalRowMask(table, conditions, logic);
  return { columns: [...table.columns], rows: table.rows.filter((_, i) => mask[i]) };
}

// ---------------------------------------------------------------------------
// Ordenação / dedupe
// ---------------------------------------------------------------------------

export function sortRows(table, by, descending = false) {
  const cols = Array.isArray(by) ? by : [by];
  const descs = Array.isArray(descending) ? descending : cols.map(() => descending);
  const rows = [...table.rows].sort((a, b) => {
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const av = a[c], bv = b[c];
      let cmp;
      if (av === bv) cmp = 0;
      else if (av === null || av === undefined) cmp = 1;
      else if (bv === null || bv === undefined) cmp = -1;
      else if (!isNaN(Number(av)) && !isNaN(Number(bv))) cmp = Number(av) - Number(bv);
      else cmp = String(av).localeCompare(String(bv));
      if (cmp !== 0) return descs[i] ? -cmp : cmp;
    }
    return 0;
  });
  return { columns: [...table.columns], rows };
}

export function dedupe(table, subset = null) {
  const keys = subset && subset.length ? subset : table.columns;
  const seen = new Set();
  const rows = table.rows.filter((r) => {
    const key = JSON.stringify(keys.map((k) => r[k]));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { columns: [...table.columns], rows };
}

// ---------------------------------------------------------------------------
// Tipos / nulos
// ---------------------------------------------------------------------------

export function castColumn(table, column, to) {
  const rows = table.rows.map((r) => {
    const nr = { ...r };
    const v = r[column];
    if (v === null || v === undefined || v === "") { nr[column] = null; return nr; }
    if (to === "integer") nr[column] = parseInt(v, 10);
    else if (to === "float") nr[column] = parseFloat(v);
    else if (to === "boolean") nr[column] = ["true", "1", true, 1].includes(
      typeof v === "string" ? v.toLowerCase() : v
    );
    else if (to === "date") nr[column] = new Date(v).toISOString().slice(0, 10);
    else nr[column] = String(v);
    return nr;
  });
  return { columns: [...table.columns], rows };
}

export function fillNull(table, column, value) {
  const rows = table.rows.map((r) => {
    const nr = { ...r };
    if (nr[column] === null || nr[column] === undefined || nr[column] === "") nr[column] = value;
    return nr;
  });
  return { columns: [...table.columns], rows };
}

// ---------------------------------------------------------------------------
// Colunas derivadas / split / merge
// ---------------------------------------------------------------------------

export function deriveColumn(table, newColumn, expression) {
  const rows = table.rows.map((r) => {
    const nr = { ...r };
    if (expression.kind === "arithmetic") {
      const left = expression.leftIsColumn ? Number(r[expression.left]) : Number(expression.left);
      const right = expression.rightIsColumn ? Number(r[expression.right]) : Number(expression.right);
      const ops = { "+": (a, b) => a + b, "-": (a, b) => a - b, "*": (a, b) => a * b, "/": (a, b) => a / b };
      nr[newColumn] = ops[expression.op](left, right);
    } else if (expression.kind === "text") {
      const src = String(r[expression.column] ?? "");
      const ops = {
        upper: (s) => s.toUpperCase(),
        lower: (s) => s.toLowerCase(),
        trim: (s) => s.trim(),
      };
      nr[newColumn] = ops[expression.textOp] ? ops[expression.textOp](src) : src;
    }
    return nr;
  });
  const columns = table.columns.includes(newColumn) ? [...table.columns] : [...table.columns, newColumn];
  return { columns, rows };
}

export function splitColumn(table, column, delimiter, into) {
  const rows = table.rows.map((r) => {
    const nr = { ...r };
    const parts = String(r[column] ?? "").split(delimiter);
    into.forEach((name, i) => { nr[name] = parts[i] ?? null; });
    return nr;
  });
  const columns = [...table.columns, ...into.filter((c) => !table.columns.includes(c))];
  return { columns, rows };
}

export function mergeColumns(table, columns, separator, into) {
  const rows = table.rows.map((r) => {
    const nr = { ...r };
    nr[into] = columns.map((c) => r[c] ?? "").join(separator);
    return nr;
  });
  const newCols = table.columns.includes(into) ? [...table.columns] : [...table.columns, into];
  return { columns: newCols, rows };
}

// ---------------------------------------------------------------------------
// Agrupamento / pivot
// ---------------------------------------------------------------------------

const AGG_FNS = {
  count: (vals) => vals.length,
  sum: (vals) => vals.reduce((a, b) => a + Number(b || 0), 0),
  mean: (vals) => (vals.length ? vals.reduce((a, b) => a + Number(b || 0), 0) / vals.length : null),
  min: (vals) => (vals.length ? Math.min(...vals.map(Number)) : null),
  max: (vals) => (vals.length ? Math.max(...vals.map(Number)) : null),
  median: (vals) => {
    const s = [...vals].map(Number).sort((a, b) => a - b);
    if (!s.length) return null;
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  },
  nunique: (vals) => new Set(vals).size,
};

/**
 * Frequência de cada valor distinto de uma coluna — equivalente a
 * `dd.value_counts()`. Mesmo formato de saída do software completo:
 * duas colunas, [coluna, "frequência"] ou [coluna, "proporção"].
 */
export function valueCounts(table, column, normalize = false, n = 20) {
  const counts = new Map();
  for (const row of table.rows) {
    const v = row[column];
    const key = v === null || v === undefined || v === "" ? "(nulo)" : String(v);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const total = table.rows.length || 1;
  const valueLabel = normalize ? "proporção" : "frequência";
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const rows = entries.map(([val, count]) => ({
    [column]: val, [valueLabel]: normalize ? count / total : count,
  }));
  return { columns: [column, valueLabel], rows };
}

/**
 * Matriz de correlação de Pearson entre as colunas numéricas —
 * equivalente simplificado a `dd.corr()` (só Pearson; o software completo
 * também tem Spearman/Kendall, exige rank transform, deixado de fora
 * aqui por simplicidade).
 */
export function corrMatrix(table) {
  const numCols = table.columns.filter((c) => inferDtype(table.rows.map((r) => r[c])) === "number");

  function pearson(colA, colB) {
    const pairs = table.rows
      .map((r) => [Number(r[colA]), Number(r[colB])])
      .filter(([a, b]) => !isNaN(a) && !isNaN(b));
    const n = pairs.length;
    if (n < 2) return null;
    const ma = pairs.reduce((s, [a]) => s + a, 0) / n;
    const mb = pairs.reduce((s, [, b]) => s + b, 0) / n;
    let cov = 0, va = 0, vb = 0;
    for (const [a, b] of pairs) { cov += (a - ma) * (b - mb); va += (a - ma) ** 2; vb += (b - mb) ** 2; }
    if (va === 0 || vb === 0) return null;
    return cov / Math.sqrt(va * vb);
  }

  const rows = numCols.map((colA) => {
    const row = { coluna: colA };
    for (const colB of numCols) {
      row[colB] = colA === colB ? 1 : pearson(colA, colB);
    }
    return row;
  });
  return { columns: ["coluna", ...numCols], rows };
}

/**
 * Estatísticas descritivas por coluna numérica — equivalente simplificado
 * a `dd.describe()`. Uma linha por coluna (formato "transposto", igual ao
 * software completo), com contagem/média/desvio padrão/mínimo/mediana/máximo.
 */
export function describeTable(table) {
  const numCols = table.columns.filter((c) => inferDtype(table.rows.map((r) => r[c])) === "number");
  const rows = numCols.map((col) => {
    const values = table.rows.map((r) => Number(r[col])).filter((v) => !isNaN(v)).sort((a, b) => a - b);
    const n = values.length;
    if (n === 0) return { coluna: col, count: 0, media: null, desvio_padrao: null, min: null, mediana: null, max: null };
    const mean = values.reduce((s, v) => s + v, 0) / n;
    const variance = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;
    const median = n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2;
    return {
      coluna: col, count: n, media: mean, desvio_padrao: Math.sqrt(variance),
      min: values[0], mediana: median, max: values[n - 1],
    };
  });
  return { columns: ["coluna", "count", "media", "desvio_padrao", "min", "mediana", "max"], rows };
}

export function groupBy(table, by, aggregations) {
  const groups = new Map();
  for (const row of table.rows) {
    const key = JSON.stringify(by.map((c) => row[c]));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const resultRows = [];
  for (const [key, groupRows] of groups) {
    const keyVals = JSON.parse(key);
    const nr = {};
    by.forEach((c, i) => { nr[c] = keyVals[i]; });
    for (const agg of aggregations) {
      const vals = groupRows.map((r) => r[agg.column]).filter((v) => v !== null && v !== undefined);
      const fn = AGG_FNS[agg.fn] || AGG_FNS.count;
      nr[agg.as || `${agg.fn}_${agg.column}`] = fn(vals);
    }
    resultRows.push(nr);
  }
  const columns = [...by, ...aggregations.map((a) => a.as || `${a.fn}_${a.column}`)];
  return { columns, rows: resultRows };
}

export function pivot(table, onCol, indexCol, valuesCol, aggFn = "sum") {
  const indexVals = [...new Set(table.rows.map((r) => r[indexCol]))];
  const onVals = [...new Set(table.rows.map((r) => r[onCol]))];
  const fn = AGG_FNS[aggFn] || AGG_FNS.sum;
  const rows = indexVals.map((iv) => {
    const nr = { [indexCol]: iv };
    for (const ov of onVals) {
      const matching = table.rows.filter((r) => r[indexCol] === iv && r[onCol] === ov);
      nr[String(ov)] = fn(matching.map((r) => r[valuesCol]).filter((v) => v !== null && v !== undefined));
    }
    return nr;
  });
  return { columns: [indexCol, ...onVals.map(String)], rows };
}

// ---------------------------------------------------------------------------
// Mascaramento (não-reversível — ver crypto-utils.js e RECIPE_SCHEMA.md)
// ---------------------------------------------------------------------------

const NULL_LIKE = new Set(["", "nan", "none", "null", "na", "n/a", "<na>"]);
function isNullLike(v) {
  return v === null || v === undefined || NULL_LIKE.has(String(v).trim().toLowerCase());
}

/** Tipo de normalização do hash ("cpf" | "cnpj" | "email" | "generic") a partir dos valores da coluna. */
function autoHashKind(col, values) {
  const sug = suggestPiiType(col, values.slice(0, 500));
  return sug && ["cpf", "cnpj", "email"].includes(sug.type) ? sug.type : "generic";
}

/** Ausente, como o `is_null()` do Polars depois de ler um CSV (vazio vira nulo). */
function isMissing(v) {
  return v === null || v === undefined || v === "";
}

/**
 * Estratégias simples, PORTADAS de `datalock/adapters/polars_adapter.py` (`_build_expr`) — o caminho
 * que o software completo realmente usa. Conferidas contra a biblioteca (ver o teste de paridade).
 *   redact          -> "REDACTED" (nulo continua nulo)
 *   suppress        -> nulo
 *   truncate        -> tira o que não é dígito; com 5+ dígitos vira "12345-XXX", senão fica como está
 *   mask_phone_ddd  -> "(DD) XXXXX-XXXX" ("XXXXX-XXXX" se tiver menos de 8 dígitos)
 *   generalize_date -> década ("1990-1999") ou "DATA_REDACTED"
 */
function applySimpleStrategy(value, strategy) {
  if (isMissing(value)) return null;
  const s = value instanceof Date ? value.toISOString() : String(value);
  switch (strategy) {
    case "redact": return "REDACTED";
    case "suppress": return null;
    case "truncate": {
      const digits = s.replace(/\D/g, "");
      return digits.length >= 5 ? `${digits.slice(0, 5)}-XXX` : s;
    }
    case "mask_phone_ddd": {
      const digits = s.replace(/\D/g, "");
      return digits.length < 8 ? "XXXXX-XXXX" : `(${digits.slice(0, 2)}) XXXXX-XXXX`;
    }
    case "generalize_date": {
      let year;
      if (value instanceof Date) year = value.getUTCFullYear();
      else {
        const m = s.trim().match(/\b(19|20)\d{2}\b/);
        if (!m) return "DATA_REDACTED";
        year = parseInt(m[0], 10);
      }
      const decade = Math.floor(year / 10) * 10;
      return `${decade}-${decade + 9}`;
    }
    default: return s;
  }
}

/**
 * Aplica uma estratégia de mascaramento a uma ou mais colunas, opcionalmente
 * restrita a um subconjunto de linhas (rowsConditions/rowsLogic) — espelha
 * dd.mask(df, salt=, columns=, strategy=, rows=).
 *
 * `piiKindByColumn`: {coluna: "cpf"|"cnpj"|"email"|"generic"} — só é usado
 * quando strategy === "hash", para aplicar a normalização certa antes do HMAC.
 */
export async function maskColumns(table, {
  columns, strategy, salt, rowsConditions = null, rowsLogic = "and", piiKindByColumn = {},
}) {
  const rowMask = rowsConditions ? evalRowMask(table, rowsConditions, rowsLogic) : table.rows.map(() => true);
  const rows = table.rows.map((r) => ({ ...r }));

  for (const col of columns) {
    if (strategy === "hash") {
      const colValues = rows.map((r) => r[col]);
      // O software completo normaliza antes do hash conforme o tipo detectado da coluna (CPF/CNPJ: só
      // dígitos; e-mail: minúsculas). Sem isso "123.456.789-09" e "12345678909" viravam tokens
      // diferentes aqui, mas o mesmo token lá. Se a interface não informou o tipo, detecta agora.
      const kind = piiKindByColumn[col] || autoHashKind(col, colValues);
      const hashed = await hashColumn(colValues, salt, kind);
      rows.forEach((r, i) => { if (rowMask[i]) r[col] = hashed[i]; });
    } else if (strategy === "encrypt") {
      // AES-SIV — MESMO formato do software completo (dd.mask(strategy="encrypt")),
      // não uma aproximação — ver crypto-utils.js. O nome da coluna é o AAD,
      // igual ao Python: precisa ser a mesma coluna na hora de reverter.
      if (!salt) throw new Error("strategy='encrypt' exige um salt.");
      const colValues = rows.map((r) => r[col]);
      const encrypted = await encryptSivColumn(colValues, salt, col);
      rows.forEach((r, i) => { if (rowMask[i]) r[col] = encrypted[i]; });
    } else if (strategy === "passthrough") {
      // no-op — mantém o valor original
    } else if (strategy === "mock_numeric") {
      // Aproximação simples: valor aleatório dentro da faixa observada — não é
      // estatisticamente equivalente ao mocker real do Python. Ver RECIPE_SCHEMA.md.
      const nums = rows.map((r) => Number(r[col])).filter((n) => !isNaN(n));
      const min = Math.min(...nums), max = Math.max(...nums);
      rows.forEach((r, i) => {
        if (rowMask[i] && !isNullLike(r[col])) r[col] = Math.round((min + Math.random() * (max - min)) * 100) / 100;
      });
    } else if (strategy === "mock_category") {
      const cats = [...new Set(rows.map((r) => r[col]).filter((v) => !isNullLike(v)))];
      rows.forEach((r, i) => {
        if (rowMask[i] && !isNullLike(r[col])) r[col] = cats[Math.floor(Math.random() * cats.length)];
      });
    } else {
      rows.forEach((r, i) => { if (rowMask[i]) r[col] = applySimpleStrategy(r[col], strategy); });
    }
  }
  return { columns: [...table.columns], rows };
}

/**
 * Reverte colunas cifradas com strategy="encrypt" (AES-SIV, MESMO formato
 * do software completo — ver crypto-utils.js) — precisa do mesmo salt E
 * do mesmo nome de coluna (usado como AAD) usados para mascarar. Um valor
 * cifrado pelo software completo reverte aqui normalmente, e vice-versa.
 */
export async function unmaskColumns(table, columns, salt) {
  if (!salt) throw new Error("Reverter exige o mesmo salt usado para mascarar.");
  const rows = table.rows.map((r) => ({ ...r }));
  for (const col of columns) {
    const colValues = rows.map((r) => r[col]);
    const decrypted = await decryptSivColumn(colValues, salt, col);
    rows.forEach((r, i) => { r[col] = decrypted[i]; });
  }
  return { columns: [...table.columns], rows };
}

/**
 * Compara duas tabelas (antes/depois de uma receita) — versão simplificada
 * de `dd.diff()` para rodar 100% no navegador. Reporta quais colunas
 * mudaram de valor, quais ficaram iguais, e um resumo em texto.
 */
export function diffTables(before, after) {
  const beforeCols = before.columns;
  const afterCols = after.columns;
  const common = beforeCols.filter((c) => afterCols.includes(c));
  const removed = beforeCols.filter((c) => !afterCols.includes(c));
  const added = afterCols.filter((c) => !beforeCols.includes(c));
  const sameRowCount = before.rows.length === after.rows.length;

  const structuralNotes = [];
  if (removed.length) structuralNotes.push(`${removed.length} coluna(s) removida(s): ${removed.join(", ")}`);
  if (added.length) structuralNotes.push(`${added.length} coluna(s) adicionada(s): ${added.join(", ")}`);

  if (!sameRowCount) {
    // Linhas mudaram de quantidade (filtro, dedupe, etc.) — não dá pra
    // comparar valor a valor nem nas colunas em comum; reporta só a
    // estrutura que mudou, em vez de marcar tudo como "alterado" às cegas.
    const rowNote = `Número de linhas mudou: ${before.rows.length} → ${after.rows.length}.`;
    return {
      summary: [rowNote, ...structuralNotes].join(" · "),
      columns_changed: [], columns_unchanged: common, structural_only: true,
    };
  }

  const columnsChanged = [...removed, ...added];
  const columnsUnchanged = [];
  for (const col of common) {
    let changed = false;
    for (let i = 0; i < before.rows.length; i++) {
      const a = before.rows[i][col];
      const b = after.rows[i][col];
      if (String(a ?? "") !== String(b ?? "")) { changed = true; break; }
    }
    (changed ? columnsChanged : columnsUnchanged).push(col);
  }

  const summaryParts = [`${columnsChanged.length} de ${beforeCols.length + added.length} coluna(s) mudaram · ${before.rows.length} linha(s) (contagem não mudou)`, ...structuralNotes];
  return { summary: summaryParts.join(" · "), columns_changed: columnsChanged, columns_unchanged: columnsUnchanged };
}

/** Valor de um quasi-identificador para agrupar: ausente (null/undefined/NaN/vazio) vira um grupo próprio
 * ("∅"), como o `groupby(dropna=False)` do software completo. */
function _qiValue(v) {
  if (v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v))) return "∅";
  return `${typeof v}:${v}`;
}

/**
 * k-anonimato — agrupa pelas colunas quasi-identificadoras e devolve k = tamanho do MENOR
 * grupo (k baixo = mais fácil reidentificar alguém cruzando essas colunas com outra fonte).
 * Mesma definição do `KAnonymityAnalyzer` do software completo (conferido contra a biblioteca:
 * `groupby(dropna=False)`, k = menor grupo, conforme ANPD com k ≥ 5).
 *
 * O score composto de risco (que usa este mesmo agrupamento) está em risk-score.js.
 */
export function kAnonymity(table, quasiIdentifiers) {
  const groups = new Map();
  for (const row of table.rows) {
    const key = quasiIdentifiers.map((c) => _qiValue(row[c])).join("\u0001");
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  let k = table.rows.length ? Infinity : 0;
  for (const size of groups.values()) k = Math.min(k, size);
  if (!Number.isFinite(k)) k = 0;
  return {
    k_value: k,
    n_groups: groups.size,
    n_rows: table.rows.length,
    compliant_anpd: k >= 5, // referência comum (ANPD/boas práticas): k ≥ 5
  };
}

/**
 * Estatísticas de reidentificação EXATAS por definição, a partir do mesmo
 * agrupamento do k-anonimato (não é o "score" composto do software
 * completo — aquele combina mais sinais; aqui só o que se calcula sem
 * ambiguidade):
 *   - risco do promotor de um registro = 1 / tamanho do seu grupo (probabilidade
 *     de um atacante que SABE que a pessoa está na base acertar quem é);
 *   - risco médio = média disso sobre todos os registros (= grupos / linhas);
 *   - risco máximo = 1 / k;
 *   - registros únicos = os que estão sozinhos no grupo (risco 100%).
 */
export function reidentificationStats(table, quasiIdentifiers) {
  const groups = new Map();
  for (const row of table.rows) {
    const key = quasiIdentifiers.map((c) => _qiValue(row[c])).join("\u0001");
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  const n = table.rows.length;
  let unique = 0, belowK5 = 0, minSize = Infinity;
  for (const size of groups.values()) {
    if (size === 1) unique += 1;
    if (size < 5) belowK5 += size;
    minSize = Math.min(minSize, size);
  }
  return {
    avg_risk: n ? groups.size / n : 0,
    max_risk: n && Number.isFinite(minSize) ? 1 / minSize : 0,
    n_unique_records: unique,
    pct_unique_records: n ? unique / n : 0,
    n_records_below_k5: belowK5,
    n_rows: n,
  };
}

/**
 * EDA automática — um resumo (histograma ou contagem de valores) por
 * coluna, de uma vez, sem precisar adicionar um passo pra cada. Mesmo
 * formato de saída do software completo (`/eda/auto`).
 */
export function autoEda(table, { maxCategoricalCardinality = 30, maxColumns = 40 } = {}) {
  const columns = table.columns.slice(0, maxColumns).map((col) => {
    const allValues = table.rows.map((r) => r[col]);
    const nonNull = allValues.filter((v) => v !== null && v !== undefined && v !== "");
    const uniqueValues = new Set(nonNull.map((v) => String(v)));
    const nUnique = uniqueValues.size;
    const entry = { name: col, count: allValues.length, nulls: allValues.length - nonNull.length, unique: nUnique };

    const dtype = inferDtype(allValues);
    if (dtype === "number" && nonNull.length >= 2 && nUnique >= 2) {
      const values = nonNull.map(Number).filter((v) => !isNaN(v));
      const mean = values.reduce((a, v) => a + v, 0) / values.length;
      const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
      entry.kind = "numeric";
      entry.stats = { mean, std: Math.sqrt(variance), min: Math.min(...values), max: Math.max(...values) };

      const nBins = Math.max(5, Math.min(20, Math.ceil(Math.log2(values.length) + 1))); // Sturges
      const min = entry.stats.min, max = entry.stats.max;
      const width = (max - min) / nBins || 1;
      const counts = new Array(nBins).fill(0);
      for (const v of values) {
        const idx = Math.min(nBins - 1, Math.max(0, Math.floor((v - min) / width)));
        counts[idx]++;
      }
      entry.histogram = {
        labels: counts.map((_, i) => `${(min + i * width).toPrecision(3)}–${(min + (i + 1) * width).toPrecision(3)}`),
        counts,
      };
    } else if (nUnique >= 1 && nUnique <= maxCategoricalCardinality && nUnique <= Math.max(3, nonNull.length * 0.5)) {
      entry.kind = "categorical";
      const counts = new Map();
      for (const v of nonNull) { const key = String(v); counts.set(key, (counts.get(key) || 0) + 1); }
      const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
      entry.value_counts = { labels: entries.map((e) => e[0]), counts: entries.map((e) => e[1]) };
    } else {
      entry.kind = "other";
    }
    return entry;
  });
  return { columns, total_rows: table.rows.length };
}

export const Ops = {
  selectColumns, dropColumns, renameColumns, filterRows, sortRows, dedupe,
  castColumn, fillNull, deriveColumn, splitColumn, mergeColumns, groupBy, pivot,
  maskColumns, unmaskColumns, diffTables, kAnonymity, cloneTable, inferSchema, needsTextColumn,
  valueCounts, corrMatrix, describeTable,
};
