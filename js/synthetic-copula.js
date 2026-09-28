/**
 * synthetic-copula.js
 * ===================
 * Porta em JS de `recipe_engine.py#_synthetic_copula` (motor "Estatístico"
 * de dados sintéticos): cópula gaussiana, sem nenhuma dependência.
 *
 * Mesmo algoritmo do software completo:
 *   1. cada coluna (numérica ou categórica) vira rank -> probabilidade ->
 *      valor normal padrão (probit);
 *   2. calcula-se a correlação entre as colunas já transformadas;
 *   3. sorteiam-se n vetores normais multivariados com essa correlação
 *      (fatoração de Cholesky);
 *   4. cada valor volta à escala original pelo percentil da distribuição
 *      empírica da coluna.
 *
 * Colunas de PII são regeradas do zero (SyntheticGenerator) e nunca entram
 * no modelo. Colunas com poucos dados viram bootstrap simples.
 *
 * O gerador de números aleatórios é outro (mulberry32, não o do numpy),
 * então os valores não batem byte a byte com o software completo — o que
 * se preserva é a propriedade estatística (distribuições e correlação) e o
 * determinismo por seed.
 */

import { SyntheticGenerator, generateSyntheticTable } from "./synthetic-generator.js";

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Normal padrão: ppf (Acklam) e cdf (erfc de Numerical Recipes) ─────────

export function normPpf(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  let q, r;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 +
    t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 +
    t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

export function normCdf(x) { return 0.5 * erfc(-x / Math.SQRT2); }

// ── Álgebra linear mínima ────────────────────────────────────────────────

/** Rank médio (1..n), ignorando nulos (NaN) — igual a pandas rank(method="average"). */
function averageRanks(values) {
  const idx = [];
  for (let i = 0; i < values.length; i++) if (!Number.isNaN(values[i])) idx.push(i);
  idx.sort((i, j) => values[i] - values[j]);
  const ranks = new Array(values.length).fill(NaN);
  let k = 0;
  while (k < idx.length) {
    let m = k;
    while (m + 1 < idx.length && values[idx[m + 1]] === values[idx[k]]) m++;
    const avg = (k + m) / 2 + 1;
    for (let t = k; t <= m; t++) ranks[idx[t]] = avg;
    k = m + 1;
  }
  return ranks;
}

function pearson(x, y) {
  const n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const den = Math.sqrt(sxx * syy);
  return den > 0 ? sxy / den : 0;
}

/** Cholesky (triangular inferior) — devolve null se a matriz não for positiva definida. */
function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 1e-12) return null;
        L[i][i] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

/** Cholesky com "jitter" crescente na diagonal se a correlação for quase singular. */
function robustCholesky(corr) {
  const n = corr.length;
  let jitter = 0;
  for (let attempt = 0; attempt < 30; attempt++) {
    const A = corr.map((row, i) => row.map((v, j) => (i === j ? v + jitter : v)));
    const L = cholesky(A);
    if (L) return L;
    jitter = jitter === 0 ? 1e-8 : jitter * 4;
  }
  // último recurso: sem correlação (identidade) — vira amostragem independente por coluna
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

// ── Motor ─────────────────────────────────────────────────────────────────

const isMissing = (v) => v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));

/**
 * @param {{columns: string[], rows: object[]}} table
 * @param {Record<string, {type: string}>} piiReport  Resultado de scanTable(table).
 * @param {number} n
 * @param {number} seed
 */
export function generateCopulaTable(table, piiReport, n, seed = 42) {
  const rows = table.rows;
  if (rows.length < 5 || n <= 0) {
    // poucos dados para estimar correlação — cai no bootstrap (mesmo que o Python)
    return generateSyntheticTable(table, piiReport, n, seed);
  }

  const gen = new SyntheticGenerator(seed);
  const rand = mulberry32(seed);
  const randNormal = () => {
    const u1 = Math.max(rand(), 1e-12), u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  const nameHints = ["nome", "name"];
  const piiCols = {};
  const modelCols = [];
  const kind = {};
  for (const col of table.columns) {
    const report = piiReport[col];
    const looksLikeName = !report && nameHints.some((h) => col.toLowerCase().includes(h));
    const piiType = report ? report.type : (looksLikeName ? "nome" : null);
    if (piiType) { piiCols[col] = piiType; continue; }

    const nonNull = rows.map((r) => r[col]).filter((v) => !isMissing(v));
    if (nonNull.length < 5) continue;
    const allNumeric = nonNull.every((v) => typeof v === "number" && Number.isFinite(v));
    if (allNumeric) { kind[col] = "numeric"; modelCols.push(col); }
    else if (new Set(nonNull.map(String)).size >= 2) { kind[col] = "categorical"; modelCols.push(col); }
  }

  if (!modelCols.length) return generateSyntheticTable(table, piiReport, n, seed);

  const nRows = rows.length;
  const normalData = []; // por coluna
  const empirical = {};
  const freqOrder = {};
  const isInt = {};

  for (const col of modelCols) {
    let values;
    if (kind[col] === "numeric") {
      values = rows.map((r) => (isMissing(r[col]) ? NaN : Number(r[col])));
      isInt[col] = values.every((v) => Number.isNaN(v) || Number.isInteger(v));
    } else {
      const freq = new Map();
      const original = new Map();
      for (const r of rows) {
        if (isMissing(r[col])) continue;
        const key = String(r[col]);
        freq.set(key, (freq.get(key) || 0) + 1);
        if (!original.has(key)) original.set(key, r[col]);
      }
      const ordered = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
      freqOrder[col] = ordered.map((k) => original.get(k));
      const pos = new Map(ordered.map((k, i) => [k, i]));
      values = rows.map((r) => (isMissing(r[col]) ? NaN : pos.get(String(r[col]))));
    }
    const finite = values.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
    empirical[col] = finite.length ? finite : [0];
    const ranks = averageRanks(values);
    const nValid = finite.length || 1;
    normalData.push(ranks.map((rk) => {
      const u = Number.isNaN(rk) ? 0.5 : (rk - 0.5) / nValid;
      return normPpf(Math.min(Math.max(u, 1e-6), 1 - 1e-6));
    }));
  }

  const d = modelCols.length;
  const corr = Array.from({ length: d }, () => new Array(d).fill(0));
  for (let i = 0; i < d; i++) {
    corr[i][i] = 1;
    for (let j = i + 1; j < d; j++) {
      const c = pearson(normalData[i], normalData[j]);
      corr[i][j] = corr[j][i] = Number.isFinite(c) ? c : 0;
    }
  }
  const L = robustCholesky(corr);

  const outRows = Array.from({ length: n }, () => ({}));
  const z = new Array(d);
  for (let r = 0; r < n; r++) {
    for (let j = 0; j < d; j++) z[j] = randNormal();
    for (let j = 0; j < d; j++) {
      let x = 0;
      for (let k = 0; k <= j; k++) x += L[j][k] * z[k];
      const col = modelCols[j];
      const emp = empirical[col];
      const idx = Math.min(Math.max(Math.floor(normCdf(x) * emp.length), 0), emp.length - 1);
      const v = emp[idx];
      if (kind[col] === "numeric") {
        outRows[r][col] = isInt[col] ? Math.round(v) : v;
      } else {
        const inv = freqOrder[col];
        outRows[r][col] = inv[Math.min(Math.round(v), inv.length - 1)];
      }
    }
  }

  for (const [col, piiType] of Object.entries(piiCols)) {
    for (const row of outRows) row[col] = gen.generate(piiType);
  }

  // Colunas que ficaram de fora do modelo (poucos dados): bootstrap simples.
  const remaining = table.columns.filter((c) => !(c in piiCols) && !modelCols.includes(c));
  if (remaining.length) {
    const idxs = Array.from({ length: n }, () => Math.floor(rand() * nRows));
    for (const col of remaining) {
      outRows.forEach((row, r) => { row[col] = rows[idxs[r]][col]; });
    }
  }

  const ordered = outRows.map((row) => {
    const o = {};
    for (const col of table.columns) o[col] = row[col];
    return o;
  });
  return { columns: [...table.columns], rows: ordered };
}
