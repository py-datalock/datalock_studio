/**
 * compliance-pdf.js
 * =================
 * PDF do relatório de conformidade, gerado NO NAVEGADOR com jsPDF
 * (carregado sob demanda do jsDelivr, só quando a pessoa pede PDF — igual
 * às outras bibliotecas pesadas da prévia). Mesmos dados do HTML/JSON
 * (ver compliance-report.js); só muda o formato de saída.
 *
 * jsPDF usa as fontes padrão do PDF (Latin-1), que cobrem o português;
 * caracteres fora disso (ex.: um nome de coluna em outro alfabeto) viram "?".
 */

const JSPDF_URL = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";

async function loadJsPdf() {
  if (globalThis.jspdf && globalThis.jspdf.jsPDF) return globalThis.jspdf.jsPDF;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = JSPDF_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error(
      "Não consegui carregar o gerador de PDF (jsPDF, via jsDelivr). Verifique a conexão, " +
      "ou use HTML/JSON — o HTML também pode ser impresso como PDF pelo navegador."
    ));
    document.head.appendChild(s);
  });
  return globalThis.jspdf.jsPDF;
}

// Troca pontuação tipográfica comum (fora do Latin-1) por equivalentes simples,
// e só então substitui o que sobrar por "?".
const latin1 = (s) => String(s ?? "")
  .replace(/[\u2013\u2014]/g, "-").replace(/[\u2018\u2019]/g, "'")
  .replace(/[\u201c\u201d]/g, '"').replace(/\u2026/g, "...")
  .replace(/[^\u0000-\u00ff]/g, "?");

/** @param {ReturnType<import("./compliance-report.js").buildReportData>} data */
export async function buildCompliancePdf(data) {
  const JsPDF = await loadJsPdf();
  const doc = new JsPDF({ unit: "mm", format: "a4" });
  const M = 15, W = 210 - 2 * M, PAGE_BOTTOM = 297 - 18;
  let y = M;

  const ensure = (h) => { if (y + h > PAGE_BOTTOM) { doc.addPage(); y = M; } };
  const para = (text, size = 10, gap = 1.5, color = 30, style = "normal") => {
    doc.setFont("helvetica", style); doc.setFontSize(size); doc.setTextColor(color);
    const lines = doc.splitTextToSize(latin1(text), W);
    const lh = size * 0.42;
    for (const line of lines) { ensure(lh); doc.text(line, M, y + lh * 0.8); y += lh; }
    y += gap;
  };

  para(data.title, 18, 3, 20, "bold");
  const meta = `${data.organization ? data.organization + " · " : ""}Dataset: ${data.dataset_name}`;
  para(meta, 10, 0.5, 90);
  para(`Gerado em ${new Date(data.generated_at).toLocaleString("pt-BR")}`, 10, 5, 90);

  para("Resumo", 13, 1.5, 20, "bold");
  para(`${data.total_rows.toLocaleString("pt-BR")} linha(s), ${data.total_columns} coluna(s), ` +
       `${data.columns_with_pii} coluna(s) com possível dado pessoal detectado.`, 10, 4);
  if (data.extra_notes) { para("Notas", 13, 1.5, 20, "bold"); para(data.extra_notes, 10, 4); }

  para("Colunas", 13, 2, 20, "bold");
  const cols = [
    { h: "Coluna", w: 52 }, { h: "Tipo sugerido", w: 48 }, { h: "Risco", w: 20 },
    { h: "Correspondência", w: 32 }, { h: "Mascarado?", w: 28 },
  ];
  const drawRow = (cells, header = false) => {
    doc.setFont("helvetica", header ? "bold" : "normal"); doc.setFontSize(9); doc.setTextColor(30);
    const wrapped = cells.map((c, i) => doc.splitTextToSize(latin1(c), cols[i].w - 3));
    const lines = Math.max(...wrapped.map((w) => w.length));
    const h = lines * 4 + 2.5;
    ensure(h);
    if (header) { doc.setFillColor(238, 240, 244); doc.rect(M, y, W, h, "F"); }
    let x = M;
    wrapped.forEach((w, i) => { doc.text(w, x + 1.5, y + 4.2); x += cols[i].w; });
    doc.setDrawColor(210); doc.line(M, y + h, M + W, y + h);
    y += h;
  };
  drawRow(cols.map((c) => c.h), true);
  for (const c of data.columns) {
    drawRow([
      c.name,
      c.pii ? c.pii.label : "—",
      c.pii ? c.pii.risk : "—",
      c.pii ? Math.round((c.pii.matchRatio ?? 0) * 100) + "%" : "—",
      c.masked === null || c.masked === undefined ? "—" : (c.masked ? "sim" : "não"),
    ]);
  }

  y += 6;
  para("Este relatório foi gerado pela prévia web do datalock Studio, usando uma heurística leve de " +
       "detecção (regex simples) — não substitui uma avaliação de conformidade completa. " +
       "\"Mascarado?\" compara de verdade o valor antes/depois da receita. Para o relatório completo " +
       "(k-anonimato, risco de reidentificação, texto jurídico detalhado), use o software completo.",
       9, 0, 90);

  return doc.output("blob");
}
