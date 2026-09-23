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

import { hashColumn } from "./crypto-utils.js";

export function inferDtype(values) {
  const sample = values.filter((v) => v !== null && v !== undefined && v !== "").slice(0, 100);
  if (sample.length === 0) return "string";
  const allNumbers = sample.every((v) => v !== "" && !isNaN(Number(v)));
  if (allNumbers) return "number";
  const allBooleans = sample.every((v) => ["true", "false", true, false].includes(
    typeof v === "string" ? v.toLowerCase() : v
  ));
  if (allBooleans) return "boolean";
  const allDates = sample.every((v) => /^\d{4}-\d{2}-\d{2}/.test(String(v)) && !isNaN(Date.parse(v)));
  if (allDates) return "date";
  return "string";
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

function applySimpleStrategy(value, strategy) {
  if (isNullLike(value)) return null;
  const s = String(value);
  switch (strategy) {
    case "redact": return "REDACTED";
    case "suppress": return null;
    case "truncate": return s.slice(0, 3) + "*".repeat(Math.max(0, s.length - 3));
    case "mask_phone_ddd": {
      const digits = s.replace(/\D/g, "");
      if (digits.length < 4) return "*".repeat(digits.length);
      return digits.slice(0, 2) + "*".repeat(digits.length - 2);
    }
    case "generalize_date": {
      const m = s.match(/^(\d{4})/);
      return m ? `${m[1]}-**-**` : s;
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
      const kind = piiKindByColumn[col] || "generic";
      const colValues = rows.map((r) => r[col]);
      const hashed = await hashColumn(colValues, salt, kind);
      rows.forEach((r, i) => { if (rowMask[i]) r[col] = hashed[i]; });
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

export const Ops = {
  selectColumns, dropColumns, renameColumns, filterRows, sortRows, dedupe,
  castColumn, fillNull, deriveColumn, splitColumn, mergeColumns, groupBy, pivot,
  maskColumns, cloneTable, inferSchema,
};
