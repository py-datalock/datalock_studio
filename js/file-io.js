/**
 * file-io.js
 * ==========
 * Leitura/escrita de arquivos tabulares no navegador. Usa as bibliotecas
 * globais carregadas via CDN no index.html: `Papa` (PapaParse, CSV) e
 * `XLSX` (SheetJS, Excel). JSON é tratado nativamente.
 *
 * Formatos de arquivo binários mais elaborados (.parquet, .dlk) exigem o
 * software completo — ver RECIPE_SCHEMA.md.
 */

function inferFormat(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  if (["csv", "tsv"].includes(ext)) return "csv";
  if (["xlsx", "xls"].includes(ext)) return "xlsx";
  if (ext === "json") return "json";
  return ext;
}

/**
 * Lê um arquivo e devolve SEMPRE uma lista de tabelas — mesmo para
 * arquivos de uma tabela só (lista com 1 item). Isso unifica o
 * tratamento de XLSX com várias planilhas (cada planilha vira uma tabela)
 * com o caso comum (CSV/JSON = 1 tabela), simplificando quem consome.
 *
 * @returns {Promise<Array<{name: string, columns: string[], rows: object[], format: string}>>}
 */
export async function readFileTables(file) {
  const format = inferFormat(file.name);
  const baseName = file.name.replace(/\.[^.]+$/, "");

  if (format === "xlsx") {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    return workbook.SheetNames.map((sheetName) => {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });
      const columns = rows.length ? Object.keys(rows[0]) : [];
      return { name: sheetName, columns, rows, format };
    });
  }

  const single = await readFile(file);
  return [{ name: baseName, columns: single.columns, rows: single.rows, format }];
}

/**
 * Lê um arquivo (File do <input type=file> ou drag&drop) e devolve
 * { columns, rows, format } — só a primeira/única tabela. Preferir
 * readFileTables() para suportar múltiplas planilhas automaticamente.
 */
export async function readFile(file) {
  const format = inferFormat(file.name);

  if (format === "csv") {
    const text = await file.text();
    const parsed = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true });
    if (parsed.errors && parsed.errors.length) {
      console.warn("Avisos ao ler CSV:", parsed.errors.slice(0, 5));
    }
    return { columns: parsed.meta.fields || [], rows: parsed.data, format };
  }

  if (format === "xlsx") {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });
    const firstSheet = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: null });
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { columns, rows, format, sheetNames: workbook.SheetNames };
  }

  if (format === "json") {
    const text = await file.text();
    const data = JSON.parse(text);
    const rows = Array.isArray(data) ? data : [data];
    const columns = rows.length ? [...new Set(rows.flatMap((r) => Object.keys(r)))] : [];
    return { columns, rows, format };
  }

  throw new Error(
    `Formato ".${format}" não suportado na prévia web. Formatos aceitos aqui: ` +
    `CSV, XLSX, JSON. Para Parquet/.dlk, use o software completo.`
  );
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Exporta a tabela para o formato pedido e dispara o download no navegador. */
export function exportTable(table, format, filenameBase = "resultado") {
  if (format === "csv") {
    const csv = Papa.unparse({ fields: table.columns, data: table.rows.map((r) => table.columns.map((c) => r[c])) });
    triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${filenameBase}.csv`);
    return;
  }
  if (format === "xlsx") {
    const ws = XLSX.utils.json_to_sheet(table.rows, { header: table.columns });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Dados");
    XLSX.writeFile(wb, `${filenameBase}.xlsx`);
    return;
  }
  if (format === "json") {
    const json = JSON.stringify(table.rows, null, 2);
    triggerDownload(new Blob([json], { type: "application/json" }), `${filenameBase}.json`);
    return;
  }
  throw new Error(
    `Exportar como ".${format}" não está disponível na prévia web. ` +
    `Formatos aceitos aqui: CSV, XLSX, JSON. Parquet/.dlk exigem o software completo.`
  );
}

export function downloadBlob(blob, filename) {
  triggerDownload(blob, filename);
}

export function downloadRecipeJson(recipe, filenameBase = "receita") {
  const json = JSON.stringify(recipe, null, 2);
  triggerDownload(new Blob([json], { type: "application/json" }), `${filenameBase}.recipe.json`);
}

export async function readRecipeJson(file) {
  const text = await file.text();
  const recipe = JSON.parse(text);
  if (!recipe.version || !Array.isArray(recipe.steps)) {
    throw new Error("Arquivo de receita inválido — esperado {version, steps: [...]}.");
  }
  return recipe;
}
