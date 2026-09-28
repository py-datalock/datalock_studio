/**
 * risk-score.js
 * =============
 * Porta em JS de `datalock/metrics/risk_score.py` (`ReidentificationRiskScorer`):
 * o "score composto de risco de reidentificação" do software completo.
 *
 * É a MESMA fórmula, sem aproximação — aritmética determinística, sem modelo
 * estatístico:
 *   score = 0.5 * unicidade + 0.3 * inferência + 0.2 * estrutural
 *   - unicidade   = 0.6 * (grupos de QI com 1 registro / grupos) + 0.4 * (unicidade média dos QIs)
 *   - inferência  = média, entre os QIs, da frequência da categoria mais comum
 *   - estrutural  = fração de identificadores diretos NÃO mascarados
 * Os números batem com a biblioteca Python (conferido a 4 casas decimais, ver
 * o teste de comparação no repositório), inclusive o tratamento de nulos e os
 * textos das recomendações.
 *
 * Convenção de "valor ausente" (igual ao resto da prévia): null, undefined,
 * NaN e texto vazio — o equivalente ao NaN/None do pandas depois de o polars
 * ler um CSV.
 */

const isNA = (v) => v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));
const keyOf = (v) => `${typeof v}:${v}`;

/** round() do Python para n casas (correto sobre o valor binário, como toFixed). */
const round = (x, n = 4) => Number(x.toFixed(n));
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

/** repr() de uma lista de strings no formato do Python: ['a', 'b'] */
function pyRepr(list) {
  const q = (s) => (s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);
  return `[${list.map(q).join(", ")}]`;
}

function nunique(rows, col) {
  const set = new Set();
  for (const r of rows) if (!isNA(r[col])) set.add(keyOf(r[col]));
  return set.size;
}

/** Tamanhos dos grupos de equivalência, descartando linhas com QUALQUER QI ausente (groupby padrão). */
function groupSizesDropNA(rows, cols) {
  const groups = new Map();
  for (const r of rows) {
    if (cols.some((c) => isNA(r[c]))) continue;
    const k = cols.map((c) => keyOf(r[c])).join("\u0001");
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  return [...groups.values()];
}

/** Frequência (0..1) da categoria mais comum, entre os valores não ausentes. */
function topFrequency(rows, col) {
  const counts = new Map();
  let total = 0;
  for (const r of rows) {
    if (isNA(r[col])) continue;
    const k = keyOf(r[col]);
    counts.set(k, (counts.get(k) || 0) + 1);
    total += 1;
  }
  if (!total) return null;
  return Math.max(...counts.values()) / total;
}

export function interpretRiskScore(score) {
  if (score < 0.20) return ["very_low", "Risco muito baixo — re-identificação improvável com meios razoáveis."];
  if (score < 0.40) return ["low", "Risco baixo — dataset adequado para uso interno e analítico."];
  if (score < 0.60) return ["moderate", "Risco moderado — ação preventiva recomendada antes de compartilhamento."];
  if (score < 0.80) return ["high", "Risco alto — re-identificação viável; remediação necessária."];
  return ["critical", "Risco crítico — re-identificação provável; dataset não deve ser compartilhado."];
}

/**
 * @param {{columns: string[], rows: object[]}} table
 * @param {{quasi_identifiers?: string[], direct_identifiers?: string[], masked_columns?: string[], anpd_k_threshold?: number}} options
 * @returns mesmas chaves de `ReidentificationRiskReport` (dataclass do Python)
 */
export function evaluateRisk(table, options = {}) {
  const quasi = options.quasi_identifiers || [];
  const direct = options.direct_identifiers || [];
  const masked = new Set(options.masked_columns || []);
  const kThreshold = options.anpd_k_threshold ?? 5;
  const { columns, rows } = table;
  const n = rows.length;

  if (n === 0) {
    return {
      risk_score: 0, risk_level: "very_low", risk_label: "Dataset vazio", n_records: 0, n_columns_analyzed: 0,
      n_quasi_identifiers: 0, n_direct_identifiers: 0, n_unmasked_direct_ids: 0, uniqueness_score: 0,
      inference_score: 0, structural_score: 0, column_profiles: [], recommendations: [], anpd_compliant: false,
      compliant_reason: "",
    };
  }

  // ── por coluna ─────────────────────────────────────────────────────────
  const profiles = columns.map((col) => {
    const uniqueness = nunique(rows, col) / Math.max(n, 1);
    const nullRatio = rows.filter((r) => isNA(r[col])).length / n;
    const isQi = quasi.includes(col), isDid = direct.includes(col), isMask = masked.has(col);
    let contrib;
    if (isDid && !isMask) contrib = 1.0 * uniqueness;
    else if (isDid && isMask) contrib = 0.1 * uniqueness;
    else if (isQi) contrib = 0.6 * uniqueness;
    else contrib = 0.2 * uniqueness;
    contrib *= 1 - nullRatio * 0.5;
    return {
      column: col, uniqueness_ratio: round(uniqueness), null_ratio: round(nullRatio),
      is_quasi_id: isQi, is_direct_id: isDid, is_masked: isMask, contribution: round(contrib),
    };
  });

  // ── 1. unicidade ───────────────────────────────────────────────────────
  let uniquenessScore;
  if (quasi.length) {
    const validQi = quasi.filter((c) => columns.includes(c));
    if (validQi.length) {
      const sizes = groupSizesDropNA(rows, validQi);
      const singularity = sizes.filter((s) => s === 1).length / Math.max(sizes.length, 1);
      const avgQiUniqueness = mean(validQi.map((c) => nunique(rows, c) / Math.max(n, 1)));
      uniquenessScore = 0.6 * singularity + 0.4 * avgQiUniqueness;
    } else {
      uniquenessScore = 0.0;
    }
  } else {
    uniquenessScore = mean(profiles.map((p) => p.uniqueness_ratio));
  }

  // ── 2. inferência ──────────────────────────────────────────────────────
  const inferenceScores = [];
  for (const col of quasi) {
    if (!columns.includes(col)) continue;
    const dominance = topFrequency(rows, col);
    if (dominance !== null) inferenceScores.push(dominance);
  }
  const inferenceScore = inferenceScores.length ? mean(inferenceScores) : 0.2;

  // ── 3. estrutural ──────────────────────────────────────────────────────
  const nDid = direct.length;
  const nMaskedDid = direct.filter((c) => masked.has(c)).length;
  const nUnmaskedDid = nDid - nMaskedDid;
  const structuralScore = nDid > 0 ? nUnmaskedDid / Math.max(nDid, 1) : 0.0;

  // ── composto ───────────────────────────────────────────────────────────
  let riskScore = 0.5 * uniquenessScore + 0.3 * inferenceScore + 0.2 * structuralScore;
  riskScore = Math.min(Math.max(riskScore, 0.0), 1.0);
  const [riskLevel, riskLabel] = interpretRiskScore(riskScore);

  // recomendações (mesmos textos e condições do Python)
  const recs = [];
  if (nUnmaskedDid > 0) {
    const unmasked = profiles.filter((p) => p.is_direct_id && !p.is_masked).map((p) => p.column);
    recs.push(`Mascarar identificadores diretos não protegidos: ${pyRepr(unmasked)}`);
  }
  if (riskLevel === "high" || riskLevel === "critical") {
    recs.push("Aumentar generalização dos quasi-identifiers (ex: faixas etárias mais amplas).");
    recs.push("Considerar supressão de registros singulares (k=1).");
  }
  if (["moderate", "high", "critical"].includes(riskLevel)) {
    recs.push("Aplicar k-anonimato ≥ 5 sobre os quasi-identifiers (ANPD 2023).");
  }
  const highUniq = profiles.filter((p) => p.uniqueness_ratio > 0.8 && !p.is_masked).map((p) => p.column);
  if (highUniq.length) recs.push(`Colunas com alta unicidade não mascaradas: ${pyRepr(highUniq.slice(0, 3))}`);
  if (riskScore > 0.3) recs.push("Considerar privacidade diferencial (ε ≤ 1.0) para releases externos.");

  // ANPD (k calculado descartando linhas com QI ausente, como no Python)
  let anpdCompliant, reason;
  const s3 = riskScore.toFixed(3);
  let decided = false;
  if (quasi.length) {
    const validQi = quasi.filter((c) => columns.includes(c));
    if (validQi.length) {
      const sizes = groupSizesDropNA(rows, validQi);
      const k = sizes.length ? Math.min(...sizes) : 0;
      if (k >= kThreshold && riskScore < 0.4) { anpdCompliant = true; reason = `k=${k} ≥ ${kThreshold} e risk_score=${s3} < 0.4`; }
      else { anpdCompliant = false; reason = `k=${k} (mín. ${kThreshold}) ou risk_score=${s3} ≥ 0.4`; }
      decided = true;
    }
  }
  if (!decided) {
    if (riskScore < 0.2) { anpdCompliant = true; reason = `risk_score=${s3} < 0.2 (sem QIs explícitos)`; }
    else { anpdCompliant = false; reason = `risk_score=${s3} ≥ 0.2 — requere análise de QIs`; }
  }

  return {
    risk_score: round(riskScore), risk_level: riskLevel, risk_label: riskLabel,
    n_records: n, n_columns_analyzed: columns.length, n_quasi_identifiers: quasi.length,
    n_direct_identifiers: nDid, n_unmasked_direct_ids: nUnmaskedDid,
    uniqueness_score: round(uniquenessScore), inference_score: round(inferenceScore),
    structural_score: round(structuralScore), column_profiles: profiles,
    recommendations: recs, anpd_compliant: anpdCompliant, compliant_reason: reason,
  };
}
