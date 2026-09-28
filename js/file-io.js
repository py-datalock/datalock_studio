/**
 * file-io.js
 * ==========
 * Leitura/escrita de arquivos tabulares no navegador. Usa as bibliotecas
 * globais carregadas via CDN no index.html: `Papa` (PapaParse, CSV) e
 * `XLSX` (SheetJS, Excel). JSON é tratado nativamente. Parquet usa
 * `hyparquet`/`hyparquet-writer` (puro JS, sem dependências — ver
 * carregamento sob demanda logo abaixo).
 *
 * `.dlk` continua exclusivo do software completo — não por escolha de
 * segurança (como `strategy: "encrypt"`), mas porque o formato binário
 * exato (cabeçalho, layout de frame, e a construção AES-SIV usada) só
 * existe dentro do pacote Python `datalock`, que não está neste
 * repositório (é uma dependência externa/privada) — sem o código-fonte
 * ou uma especificação do formato, reimplementar isso na prévia seria
 * adivinhação, não uma reimplementação de verdade. Ver RECIPE_SCHEMA.md.
 */

import { inferWriteSchema, needsTextColumn } from "./dataframe.js";

// Carregadas sob demanda (dynamic import), só quando um arquivo .parquet
// é realmente aberto/exportado — evita baixar essas libs pra quem nunca
// usa Parquet. jsdelivr serve pacotes npm como ES module estático, sem
// precisar de bundler.
const HYPARQUET_URL = "https://cdn.jsdelivr.net/npm/hyparquet@1/src/hyparquet.min.js";
const HYPARQUET_WRITER_URL = "https://cdn.jsdelivr.net/npm/hyparquet-writer@0/src/hyparquet-writer.min.js";

let _hyparquet = null;
async function _loadHyparquet() {
  if (!_hyparquet) _hyparquet = await import(HYPARQUET_URL);
  return _hyparquet;
}
let _hyparquetWriter = null;
async function _loadHyparquetWriter() {
  if (!_hyparquetWriter) _hyparquetWriter = await import(HYPARQUET_WRITER_URL);
  return _hyparquetWriter;
}

/** BigInt (comum em colunas INT64 do Parquet) não serializa em JSON nem
 * funciona direto nas nossas operações — converte pra Number quando cabe
 * com segurança, senão pra string (mantém o valor visível, sem quebrar). */
function _fromParquetValue(v) {
  if (typeof v !== "bigint") return v;
  return (v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
}

function inferFormat(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  if (["csv", "tsv", "txt"].includes(ext)) return "csv"; // .txt delimitado (o PapaParse detecta o separador)
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
export async function readFileTables(file, key = null) {
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

  if (format === "dlk") {
    const { readDlk } = await import("./dlk.js");
    const buffer = new Uint8Array(await file.arrayBuffer());
    // Mensagem com "chave (key)" de propósito — é o gatilho que a UI
    // (app.js#loadFile) já usa para abrir o modal pedindo a chave e tentar
    // de novo, igual ao fluxo que já existia para o software completo.
    if (buffer.length > 5 && buffer[5] !== 0x04 && !key) {
      throw new Error("Este arquivo .dlk é cifrado — informe a chave (key) para abri-lo.");
    }
    const { tables } = await readDlk(buffer, key, baseName);
    return tables.map((t) => ({ name: t.name, columns: t.columns, rows: t.rows, format }));
  }

  const single = await readFile(file);
  return [{ name: baseName, columns: single.columns, rows: single.rows, format }];
}
/**
 * Lê um arquivo (File do <input type=file> ou drag&drop) e devolve
 * { columns, rows, format } — só a primeira/única tabela. Preferir
 * readFileTables() para suportar múltiplas planilhas automaticamente.
 */
/**
 * Lê um arquivo de texto delimitado decidindo o encoding: UTF-8 estrito (com ou sem BOM) e, se o
 * arquivo não for UTF-8 válido, Windows-1252 — o que o Excel em português grava em "CSV". Sem isso,
 * `file.text()` assume UTF-8 e troca todo acento por "�" ("João" vira "Jo�o"). Mesma ideia do
 * software completo, que tenta UTF-8 e cai para Latin-1.
 */
export async function readDelimitedText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export async function readFile(file) {
  const format = inferFormat(file.name);

  if (format === "csv") {
    const text = await readDelimitedText(file);
    // Duas passadas: a primeira (tudo texto) só decide quais colunas NÃO podem virar número —
    // CEP/CPF/códigos com zeros à esquerda (ver needsTextColumn) — a segunda tipa as demais.
    const rawPass = Papa.parse(text, { header: true, dynamicTyping: false, skipEmptyLines: true });
    const rawFields = rawPass.meta.fields || [];
    const keepText = new Set(rawFields.filter((f) => needsTextColumn(rawPass.data.map((r) => r[f]))));
    const parsed = Papa.parse(text, {
      header: true, skipEmptyLines: true,
      dynamicTyping: keepText.size ? (field) => !keepText.has(field) : true,
    });
    if (keepText.size) {
      // vazio vira nulo nas colunas de texto, como no software completo (o Papa já faz isso nas numéricas)
      for (const row of parsed.data) for (const f of keepText) if (row[f] === "") row[f] = null;
    }
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

  if (format === "parquet") {
    const { parquetReadObjects } = await _loadHyparquet();
    const buffer = await file.arrayBuffer();
    let rawRows;
    try {
      rawRows = await parquetReadObjects({ file: buffer });
    } catch (err) {
      throw new Error(
        `Não consegui ler este .parquet na prévia (${err.message}). Compressões incomuns ` +
        `(zstd/lz4/brotli/gzip) às vezes exigem um pacote extra que a prévia ainda não carrega — ` +
        `tente converter para CSV/XLSX, ou use o software completo, que lê qualquer .parquet.`
      );
    }
    const rows = rawRows.map((r) => {
      const out = {};
      for (const k of Object.keys(r)) out[k] = _fromParquetValue(r[k]);
      return out;
    });
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { columns, rows, format };
  }

  throw new Error(
    `Formato ".${format}" não suportado na prévia web. Formatos aceitos aqui: ` +
    `CSV/TSV/TXT, XLSX, JSON, Parquet e .dlk.`
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
export async function exportTable(table, format, filenameBase = "resultado") {
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
  if (format === "parquet") {
    const { parquetWriteBuffer } = await _loadHyparquetWriter();
    // Tipo pelo valor REAL (ver inferWriteKind): texto que parece número ("00", "02") continua texto.
    const schema = inferWriteSchema(table.columns, table.rows);
    const columnData = schema.map(({ name, dtype }) => {
      const data = table.rows.map((r) => (r[name] === undefined ? null : r[name]));
      if (dtype === "number") return { name, data: data.map((v) => (v === null || v === "" ? null : Number(v))), type: "DOUBLE" };
      if (dtype === "boolean") return { name, data: data.map((v) => (v === null || v === "" ? null : Boolean(v))), type: "BOOLEAN" };
      // texto (e datas, como texto) — grava o valor como veio, sem converter
      return { name, data: data.map((v) => (v === null ? null : String(v))), type: "STRING" };
    });
    const buffer = parquetWriteBuffer({ columnData });
    triggerDownload(new Blob([buffer], { type: "application/octet-stream" }), `${filenameBase}.parquet`);
    return;
  }
  throw new Error(
    `Exportar como ".${format}" não está disponível na prévia web. ` +
    `Formatos aceitos aqui: CSV, XLSX, JSON, Parquet. .dlk exige o software completo.`
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
