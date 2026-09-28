/**
 * scan-files.js
 * =============
 * Varredura de pasta inteira NO NAVEGADOR — equivalente à do software
 * completo (`dd.scan_directory`), mas em vez de um caminho de disco usa a
 * lista de arquivos de um <input type="file" webkitdirectory> (ou de
 * arrastar uma pasta). Nada é enviado a lugar nenhum: cada arquivo é lido
 * localmente e só o resultado (colunas suspeitas por arquivo) fica na tela.
 *
 * Mesmo formato de resposta do backend:
 *   { n_files_scanned, elapsed_s, files: { caminho: { max_risk, pii_columns } } }
 * mais `skipped` (arquivos ignorados e o motivo), que o backend não tem.
 */

import { readFileTables } from "./file-io.js";
import { scanTable } from "./pii-detect.js";

const SUPPORTED = new Set(["csv", "tsv", "xlsx", "xls", "json", "parquet", "dlk"]);
const RISK_ORDER = { none: 0, low: 1, medium: 2, high: 3 };

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/**
 * @param {File[]|FileList} fileList
 * @param {{recursive?: boolean, min_risk?: string|null, max_files?: number|null, sample_size?: number}} options
 */
export async function scanFileList(fileList, options = {}) {
  const { recursive = true, min_risk = null, max_files = null, sample_size = 500 } = options;
  const t0 = performance.now();
  let files = Array.from(fileList);

  if (!recursive) {
    // webkitRelativePath = "pasta/arquivo.csv" (2 segmentos) para o nível de cima
    files = files.filter((f) => (f.webkitRelativePath || f.name).split("/").length <= 2);
  }
  files = files.filter((f) => SUPPORTED.has(extOf(f.name)));
  if (max_files) files = files.slice(0, max_files);

  const result = {};
  const skipped = {};
  let scanned = 0;
  const minLevel = min_risk ? RISK_ORDER[min_risk] ?? 0 : 0;

  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    let tables;
    try {
      tables = await readFileTables(file, null);
    } catch (err) {
      skipped[path] = /chave|key/i.test(err.message) ? "arquivo .dlk cifrado (precisa de chave)" : err.message;
      continue;
    }
    scanned += 1;
    const piiColumns = {};
    let maxLevel = 0;
    for (const t of tables) {
      const report = scanTable({ columns: t.columns, rows: t.rows }, sample_size);
      for (const [col, info] of Object.entries(report)) {
        const key = tables.length > 1 ? `${t.name}.${col}` : col;
        piiColumns[key] = info;
        maxLevel = Math.max(maxLevel, RISK_ORDER[info.risk] ?? 1);
      }
    }
    if (maxLevel >= minLevel) {
      const maxRisk = Object.keys(RISK_ORDER).find((k) => RISK_ORDER[k] === maxLevel);
      result[path] = { max_risk: maxRisk, pii_columns: piiColumns };
    }
  }

  return {
    n_files_scanned: scanned,
    elapsed_s: (performance.now() - t0) / 1000,
    files: result,
    skipped,
  };
}
