/**
 * compliance-report.js
 * ====================
 * Gera um relatório de conformidade (LGPD/GDPR) simples, direto no
 * navegador, a partir do resultado da heurística de PII (pii-detect.js).
 *
 * Isto é uma versão DELIBERADAMENTE mais simples do que
 * `dd.compliance_report()` do software completo: lista as colunas com
 * indício de dado pessoal encontradas na amostra, a técnica sugerida, e
 * metadados básicos (organização, dataset, data de geração) — não inclui
 * k-anonimato, risco de reidentificação, nem o texto jurídico mais
 * detalhado que o motor real produz. HTML, JSON e PDF (o PDF via jsPDF,
 * carregado sob demanda — ver compliance-pdf.js).
 */

function _escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function buildReportData(beforeTable, afterTable, piiReport, options) {
  const manualCols = new Set(options.manual_pii_columns || []);
  const columns = afterTable.columns.map((col) => {
    let pii = piiReport[col] || null;
    if (!pii && manualCols.has(col)) {
      // Marcado manualmente pela pessoa usuária — a heurística automática
      // (regex simples) não pegou (comum em texto livre, como endereço,
      // que não segue um padrão fixo como CPF/e-mail/telefone).
      pii = { type: "unknown", risk: "high", label: "Marcado manualmente", matchRatio: 1 };
    }
    return { name: col, pii, masked: pii ? _wasColumnMasked(beforeTable, afterTable, col) : null };
  });
  const piiCount = columns.filter((c) => c.pii).length;
  return {
    generated_at: new Date().toISOString(),
    generated_by: "datalock Studio — prévia web (heurística leve, não é o motor Python real)",
    title: options.title || "Relatório de Conformidade LGPD",
    organization: options.organization || "",
    dataset_name: options.dataset_name || "dataset",
    extra_notes: options.extra_notes || "",
    total_rows: afterTable.rows.length,
    total_columns: afterTable.columns.length,
    columns_with_pii: piiCount,
    columns,
  };
}

/**
 * Compara antes/depois de verdade pra saber se uma coluna foi mascarada —
 * ao contrário de simplesmente assumir "está na lista de PII, então foi
 * mascarada" (um bug real do software completo nesse ponto, corrigido do
 * lado do servidor em app.py; aqui a prévia já nasceu calculando certo).
 */
function _wasColumnMasked(beforeTable, afterTable, col) {
  if (!beforeTable.columns.includes(col)) return null; // coluna nova, nada "antes" pra comparar
  if (!afterTable.columns.includes(col)) return true; // removida = não chega a ser exposta
  if (beforeTable.rows.length !== afterTable.rows.length) return null; // não dá pra comparar linha a linha
  for (let i = 0; i < beforeTable.rows.length; i++) {
    const a = beforeTable.rows[i][col];
    const b = afterTable.rows[i][col];
    if (String(a ?? "") !== String(b ?? "")) return true;
  }
  return false;
}

function _maskedLabel(masked) {
  if (masked === null || masked === undefined) return "—";
  return masked ? "✓" : "✗";
}

function _renderHtml(data) {
  const rows = data.columns.map((c) => `
    <tr>
      <td>${_escapeHtml(c.name)}</td>
      <td>${c.pii ? _escapeHtml(c.pii.label) : "—"}</td>
      <td>${c.pii ? _escapeHtml(c.pii.risk) : "—"}</td>
      <td>${c.pii ? Math.round((c.pii.matchRatio ?? 0) * 100) + "%" : "—"}</td>
      <td style="text-align:center; color:${c.masked ? '#28a745' : '#dc3545'}">${_maskedLabel(c.masked)}</td>
    </tr>`).join("");

  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8" />
<title>${_escapeHtml(data.title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 820px; margin: 40px auto; padding: 0 20px; color: #1a1c22; }
  h1 { font-size: 22px; } h2 { font-size: 15px; margin-top: 28px; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #ddd; font-size: 13px; }
  th { background: #f3f4f6; }
  .meta { color: #555; font-size: 13px; }
  .warn { background: #fff8e1; border: 1px solid #f0c36d; border-radius: 6px; padding: 10px 14px; font-size: 12.5px; margin-top: 24px; }
</style></head><body>
  <h1>${_escapeHtml(data.title)}</h1>
  <p class="meta">
    ${data.organization ? _escapeHtml(data.organization) + " · " : ""}Dataset: ${_escapeHtml(data.dataset_name)}<br/>
    Gerado em ${_escapeHtml(new Date(data.generated_at).toLocaleString("pt-BR"))}
  </p>
  <h2>Resumo</h2>
  <p>${data.total_rows.toLocaleString("pt-BR")} linha(s), ${data.total_columns} coluna(s),
     ${data.columns_with_pii} coluna(s) com possível dado pessoal detectado.</p>
  ${data.extra_notes ? `<h2>Notas</h2><p>${_escapeHtml(data.extra_notes)}</p>` : ""}
  <h2>Colunas</h2>
  <table>
    <thead><tr><th>Coluna</th><th>Tipo sugerido</th><th>Risco</th><th>% de correspondência</th><th>Mascarado?</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="warn">
    Este relatório foi gerado pela <strong>prévia web</strong> do datalock Studio, usando uma
    heurística leve de detecção (regex simples) — não substitui uma avaliação de conformidade
    completa. "Mascarado?" compara de verdade o valor antes/depois da receita (não é só "está na
    lista de PII"). Para o relatório completo (k-anonimato, score de risco de reidentificação,
    texto jurídico detalhado), use o software completo.
  </div>
</body></html>`;
}

/**
 * @param {{columns: string[], rows: object[]}} beforeTable  Tabela original, antes da receita.
 * @param {{columns: string[], rows: object[]}} afterTable   Resultado da receita.
 * @param {Record<string, {type, risk, label, matchRatio}>} piiReport  Detecção automática (sobre afterTable).
 * @param {{title?, organization?, dataset_name?, extra_notes?, format: "html"|"json", manual_pii_columns?: string[]}} options
 * @returns {{blob: Blob, filename: string}}
 */
export function buildComplianceReport(beforeTable, afterTable, piiReport, options) {
  const data = buildReportData(beforeTable, afterTable, piiReport, options);
  if (options.format === "pdf") {
    // PDF é gerado com jsPDF (carregado sob demanda) — ver compliance-pdf.js.
    // Devolve uma Promise; engine.complianceReport() já aguarda o resultado.
    return import("./compliance-pdf.js").then(({ buildCompliancePdf }) =>
      buildCompliancePdf(data).then((blob) => ({ blob, filename: "relatorio_lgpd.pdf" })));
  }
  if (options.format === "json") {
    return {
      blob: new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      filename: "relatorio_lgpd.json",
    };
  }
  return {
    blob: new Blob([_renderHtml(data)], { type: "text/html" }),
    filename: "relatorio_lgpd.html",
  };
}
