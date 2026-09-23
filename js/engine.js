/**
 * engine.js
 * =========
 * Fachada única usada pelo app.js. Detecta se o software completo
 * (backend Python local) está rodando em http://127.0.0.1:8722 — se
 * estiver, usa o motor real (Polars + datalock de verdade); caso
 * contrário, cai para o motor 100% client-side (prévia web).
 *
 * Suporta MÚLTIPLAS TABELAS simultâneas (abas) — cada uma identificada
 * por um `tableId` interno gerado aqui. Um único arquivo pode virar várias
 * tabelas de uma vez (XLSX com várias planilhas, .dlk multi-frame).
 */

import * as ClientEngine from "./engine-client.js";
import * as ServerEngine from "./engine-server.js";
import * as FileIO from "./file-io.js";

class DataEngine {
  constructor() {
    this.mode = "client"; // "client" | "server"
    this.info = ClientEngine.engineInfo;
    this._tables = new Map();      // tableId -> { sourceTable } (client) | { sessionId } (server)
    this._lastResults = new Map(); // tableId -> último resultado materializado (só modo client)
    this._counter = 0;
  }

  async detect() {
    const available = await ServerEngine.isServerAvailable();
    this.mode = available ? "server" : "client";
    this.info = available ? ServerEngine.engineInfo : ClientEngine.engineInfo;
    return this.mode;
  }

  _newTableId() {
    this._counter += 1;
    return `t${this._counter}`;
  }

  _entry(tableId) {
    const entry = this._tables.get(tableId);
    if (!entry) {
      throw new Error("Esta tabela não está mais disponível (foi fechada, ou a sessão expirou).");
    }
    return entry;
  }

  /**
   * Carrega um arquivo. Pode virar MAIS DE UMA tabela (XLSX com várias
   * planilhas, .dlk multi-frame) — sempre devolve uma lista.
   *
   * @param {File} file
   * @param {{key?: string}} options  `key`: chave de descriptografia, só relevante para .dlk criptografado.
   * @returns {Promise<Array<{tableId, name, columns, previewRows, totalRows}>>}
   */
  async loadFile(file, options = {}) {
    if (this.mode === "server") {
      const tables = await ServerEngine.uploadFile(file, options.key || null);
      return tables.map((t) => {
        const tableId = this._newTableId();
        this._tables.set(tableId, { sessionId: t.session_id });
        return {
          tableId, name: t.name, columns: t.columns,
          previewRows: t.preview_rows, totalRows: t.total_rows,
        };
      });
    }
    const tables = await FileIO.readFileTables(file);
    return tables.map((t) => {
      const tableId = this._newTableId();
      const sourceTable = { columns: t.columns, rows: t.rows };
      this._tables.set(tableId, { sourceTable });
      return {
        tableId, name: t.name, columns: t.columns,
        previewRows: t.rows.slice(0, 50), totalRows: t.rows.length,
      };
    });
  }

  closeTable(tableId) {
    this._tables.delete(tableId);
    this._lastResults.delete(tableId);
  }

  async run(tableId, steps, context = {}) {
    const entry = this._entry(tableId);
    if (this.mode === "server") {
      const res = await ServerEngine.runRecipe(entry.sessionId, steps, context);
      return { previewRows: res.preview_rows, totalRows: res.total_rows, columns: res.columns, trace: res.trace };
    }
    const { table, trace } = await ClientEngine.runRecipe(entry.sourceTable, steps, context);
    this._lastResults.set(tableId, table);
    return { previewRows: table.rows.slice(0, 200), totalRows: table.rows.length, columns: table.columns, trace };
  }

  async scanPii(tableId) {
    const entry = this._entry(tableId);
    if (this.mode === "server") return ServerEngine.scanForPii(entry.sessionId);
    const table = this._lastResults.get(tableId) || entry.sourceTable;
    return ClientEngine.scanForPii(table);
  }

  /**
   * Reverte colunas strategy="encrypt" — só existe no software completo.
   * Cria uma aba NOVA com o resultado (não é só uma prévia): pode ser
   * exportada, receber mais passos, ou mandada para um banco, como
   * qualquer outra tabela.
   */
  async unmask(tableId, steps, columns, salt) {
    if (this.mode !== "server") {
      throw new Error(
        "Reverter mascaramento (unmask) só está disponível no software completo. " +
        "Rode a receita no backend Python local para usar essa função."
      );
    }
    const entry = this._entry(tableId);
    const res = await ServerEngine.unmask(entry.sessionId, steps, columns, salt);
    const newTableId = this._newTableId();
    this._tables.set(newTableId, { sessionId: res.session_id });
    return {
      tableId: newTableId, name: res.name, columns: res.columns,
      previewRows: res.preview_rows, totalRows: res.total_rows,
    };
  }

  async exportResult(tableId, steps, context, exportOptions) {
    const entry = this._entry(tableId);
    if (this.mode === "server") {
      const { blob, filename } = await ServerEngine.exportResult(entry.sessionId, steps, context, exportOptions);
      FileIO.downloadBlob(blob, filename);
      return;
    }
    const table = this._lastResults.get(tableId) || entry.sourceTable;
    if (["dlk_open", "dlk_encrypted", "parquet"].includes(exportOptions.format)) {
      throw new Error(
        `Exportar como "${exportOptions.format}" exige o software completo (backend Python real). ` +
        `Na prévia web você pode exportar CSV, XLSX ou JSON.`
      );
    }
    FileIO.exportTable(table, exportOptions.format, exportOptions.filenameBase || "resultado");
  }

  // ── Banco de dados (só existe em modo server; não é por tabela) ───────
  async dbConnect(uri) {
    this._requireServer("Conectar a um banco de dados");
    return ServerEngine.dbConnect(uri);
  }
  async dbTables(connectionId) {
    this._requireServer("Listar tabelas");
    return ServerEngine.dbTables(connectionId);
  }
  async dbQuery(connectionId, tableOrSql) {
    this._requireServer("Consultar banco de dados");
    return ServerEngine.dbQuery(connectionId, tableOrSql);
  }
  async dbExecute(connectionId, statements) {
    this._requireServer("Executar SQL no banco de dados");
    return ServerEngine.dbExecute(connectionId, statements);
  }

  /** Abre uma tabela/consulta do banco como uma nova aba — igual a loadFile(), só que a origem é um banco. */
  async dbOpenAsTable(connectionId, tableOrSql, name = null) {
    this._requireServer("Ler tabelas de um banco de dados");
    const res = await ServerEngine.dbQueryToSession(connectionId, tableOrSql, name);
    const tableId = this._newTableId();
    this._tables.set(tableId, { sessionId: res.session_id });
    return {
      tableId, name: res.name, columns: res.columns,
      previewRows: res.preview_rows, totalRows: res.total_rows,
    };
  }

  /** Roda a receita da aba e escreve o resultado completo numa tabela do banco (destino). */
  async dbWriteTable(tableId, steps, salt, connectionId, table, mode, upsertOn = null) {
    this._requireServer("Escrever num banco de dados");
    const entry = this._entry(tableId);
    return ServerEngine.dbWrite(entry.sessionId, steps, salt, connectionId, table, mode, upsertOn);
  }

  // ── Automações (jobs — só existem no software completo) ───────────────
  async listJobs() { this._requireServer("Automações"); return ServerEngine.listJobs(); }
  async createJob(draft) { this._requireServer("Automações"); return ServerEngine.createJob(draft); }
  async updateJob(id, draft) { this._requireServer("Automações"); return ServerEngine.updateJob(id, draft); }
  async deleteJob(id) { this._requireServer("Automações"); return ServerEngine.deleteJob(id); }
  async setJobEnabled(id, enabled) { this._requireServer("Automações"); return ServerEngine.setJobEnabled(id, enabled); }
  async runJobNow(id) { this._requireServer("Automações"); return ServerEngine.runJobNow(id); }
  async jobRuns(id) { this._requireServer("Automações"); return ServerEngine.jobRuns(id); }

  _requireServer(action) {
    if (this.mode !== "server") {
      throw new Error(`${action} só está disponível no software completo (backend Python local).`);
    }
  }
}

export const engine = new DataEngine();
