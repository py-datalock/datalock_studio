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
import * as Audit from "./audit-trail.js";

/** A receita tem algum passo de mascaramento ligado? (vira o flag `masking_applied` do .dlk) */
function hasMaskStep(steps) {
  return (steps || []).some((s) => s.enabled !== false && s.type === "mask");
}

class DataEngine {
  constructor() {
    this.mode = "client"; // "client" | "server"
    this.info = ClientEngine.engineInfo;
    this.serverInfo = null;
    this._tables = new Map();      // tableId -> { sourceTable } (client) | { sessionId } (server)
    this._lastResults = new Map(); // tableId -> último resultado materializado (só modo client)
    this._counter = 0;
  }

  async detect() {
    const available = await ServerEngine.isServerAvailable();
    this.mode = available ? "server" : "client";
    this.info = available ? ServerEngine.engineInfo : ClientEngine.engineInfo;
    this.serverInfo = available ? ServerEngine.getServerInfo() : null;   // { studio_version, datalock_version }
    return this.mode;
  }

  /** Preferências/rascunhos/recentes em disco — só existem com o motor local; fora dele, não faz nada. */
  get state() {
    const noop = async () => null;
    if (this.mode !== "server") {
      return { getPrefs: noop, putPrefs: noop, getDrafts: async () => ({ drafts: {}, recents: [] }), putDraft: noop, deleteDraft: noop, addRecent: noop, clearRecents: noop };
    }
    return ServerEngine.stateApi;
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

  /** A tabela foi aberta pelo motor do servidor (Python)? Decidido POR TABELA, não pelo modo global —
   *  assim uma aba aberta antes da conexão nunca é enviada ao servidor sem `session_id`. */
  _isServerEntry(entry) { return entry.kind === "server"; }

  /** Exige que a aba e o motor atual combinem (ex.: banco do servidor + aba aberta na prévia). */
  _assertSameEngine(entry, what) {
    const entryServer = entry.kind === "server";
    const modeServer = this.mode === "server";
    if (entryServer !== modeServer) {
      throw new Error(
        `${what}: esta tabela foi aberta ${entryServer ? "no software completo" : "na prévia (no navegador)"}, ` +
        `mas o motor ativo agora é ${modeServer ? "o software completo" : "a prévia"}. Reabra o arquivo para continuar.`
      );
    }
  }

  /**
   * Chama o backend com o session_id da tabela. Se o servidor devolver "sessão não encontrada"
   * (sessão descartada por inatividade, ou servidor reiniciado) e ainda tivermos o arquivo original,
   * reenvia o arquivo em silêncio e tenta de novo — a pessoa não precisa fechar e reabrir a aba.
   */
  async _server(tableId, fn) {
    const entry = this._entry(tableId);
    try {
      return await fn(entry.sessionId, entry);
    } catch (err) {
      if (/sess[aã]o .*n[aã]o encontrada/i.test(err?.message || "") && entry.file) {
        const tables = await ServerEngine.uploadFile(entry.file, entry.key || null);
        const match = tables.find((t) => t.name === entry.name) || tables[0];
        entry.sessionId = match.session_id;
        return await fn(entry.sessionId, entry);
      }
      throw err;
    }
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
        this._tables.set(tableId, { kind: "server", sessionId: t.session_id, file, key: options.key || null, name: t.name });
        return {
          tableId, name: t.name, columns: t.columns,
          previewRows: t.preview_rows, totalRows: t.total_rows,
        };
      });
    }
    const tables = await FileIO.readFileTables(file, options.key || null);
    return tables.map((t) => {
      const tableId = this._newTableId();
      const sourceTable = { columns: t.columns, rows: t.rows };
      this._tables.set(tableId, { kind: "client", sourceTable });
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
    if (this._isServerEntry(entry)) {
      const res = await this._server(tableId, (sid) => ServerEngine.runRecipe(sid, steps, context));
      return {
        previewRows: res.preview_rows, totalRows: res.total_rows, columns: res.columns,
        trace: res.trace, filteredRows: res.filtered_rows ?? res.total_rows, offset: res.offset ?? 0,
      };
    }
    const { table, trace } = await ClientEngine.runRecipe(entry.sourceTable, steps, context);
    this._lastResults.set(tableId, table);
    const PAGE = 200;
    let rows = table.rows;
    let filteredRows = rows.length;
    if (context.search) {
      const needle = context.search.toLowerCase();
      rows = rows.filter((row) => table.columns.some((c) => String(row[c] ?? "").toLowerCase().includes(needle)));
      filteredRows = rows.length;
    }
    const offset = context.offset || 0;
    const page = rows.slice(offset, offset + PAGE);
    return { previewRows: page, totalRows: table.rows.length, columns: table.columns, trace, filteredRows, offset };
  }

  async scanPii(tableId) {
    const entry = this._entry(tableId);
    if (this._isServerEntry(entry)) return this._server(tableId, (sid) => ServerEngine.scanForPii(sid));
    const table = this._lastResults.get(tableId) || entry.sourceTable;
    return ClientEngine.scanForPii(table);
  }

  /** EDA automática — um resumo por coluna (histograma/contagem), de uma vez. */
  async autoEda(tableId, steps, salt) {
    const entry = this._entry(tableId);
    if (this._isServerEntry(entry)) return this._server(tableId, (sid) => ServerEngine.autoEda(sid, steps, salt));
    const { table } = await ClientEngine.runRecipe(entry.sourceTable, steps, { salt });
    return ClientEngine.autoEda(table);
  }

  /**
   * Reverte colunas mascaradas de forma reversível — cada motor só
   * reverte o que ele mesmo cifrou: "Criptografia reversível" real
   * (AES-SIV/.dlk) no software completo, ou "Criptografia reversível
   * (nesta prévia)" (AES-GCM/Web Crypto) na prévia — os dois formatos
   * não são compatíveis entre si, de propósito (ver crypto-utils.js).
   * Cria uma aba NOVA com o resultado (não é só uma prévia): pode ser
   * exportada, receber mais passos, ou (no software completo) mandada
   * para um banco, como qualquer outra tabela.
   */
  async unmask(tableId, steps, columns, salt, name = null) {
    const entry = this._entry(tableId);
    if (this._isServerEntry(entry)) {
      const res = await this._server(tableId, (sid) => ServerEngine.unmask(sid, steps, columns, salt));
      const newTableId = this._newTableId();
      this._tables.set(newTableId, { kind: "server", sessionId: res.session_id });
      return {
        tableId: newTableId, name: res.name, columns: res.columns,
        previewRows: res.preview_rows, totalRows: res.total_rows,
      };
    }
    const { table } = await ClientEngine.runRecipe(entry.sourceTable, steps, { salt });
    const DF = await import("./dataframe.js");
    const reverted = await DF.unmaskColumns(table, columns, salt);
    const newTableId = this._newTableId();
    this._tables.set(newTableId, { kind: "client", sourceTable: reverted });
    this._lastResults.set(newTableId, reverted);
    return {
      tableId: newTableId, name: name || "resultado (revertido)", columns: reverted.columns,
      previewRows: reverted.rows.slice(0, 50), totalRows: reverted.rows.length,
    };
  }

  async exportResult(tableId, steps, context, exportOptions) {
    const entry = this._entry(tableId);
    if (this._isServerEntry(entry)) {
      const { blob, filename } = await this._server(tableId, (sid) => ServerEngine.exportResult(sid, steps, context, exportOptions));
      FileIO.downloadBlob(blob, filename);
      return;
    }
    const table = this._lastResults.get(tableId) || entry.sourceTable;
    const filenameBase = exportOptions.filenameBase || "resultado";
    if (exportOptions.format === "dlk_open" || exportOptions.format === "dlk_encrypted") {
      const Dlk = await import("./dlk.js");
      const encrypted = exportOptions.format === "dlk_encrypted";
      if (encrypted && !context.key) {
        throw new Error("Exportar como .dlk criptografado exige uma key.");
      }
      const opts = { maskingApplied: hasMaskStep(steps) };
      const bytes = encrypted
        ? await Dlk.writeDlkEncrypted(table, context.key, opts)
        : await Dlk.writeDlkOpen(table, opts);
      FileIO.downloadBlob(new Blob([bytes], { type: "application/octet-stream" }), `${filenameBase}.dlk`);
      return;
    }
    await FileIO.exportTable(table, exportOptions.format, filenameBase, { neutralizeFormulas: exportOptions.neutralizeFormulas });
  }

  /**
   * Exporta VÁRIAS abas num só .dlk (multi-frame). Cada aba tem a receita rodada de
   * novo (em vez de reaproveitar o último resultado, que pode estar desatualizado
   * para abas que não estão à vista) — aqui na prévia, ou no backend no software completo.
   *
   * @param {Array<{tableId: string, steps: object[], name: string}>} items
   * @param {{salt?: string|null, key?: string|null}} context
   * @param {{format: "dlk_open"|"dlk_encrypted", filenameBase?: string}} exportOptions
   */
  async exportDlkFrames(items, context, exportOptions) {
    if (!items.length) throw new Error("Nenhuma aba para exportar.");
    const encrypted = exportOptions.format === "dlk_encrypted";
    if (encrypted && !context.key) throw new Error("Exportar como .dlk criptografado exige uma key.");
    const kinds = new Set(items.map((i) => this._entry(i.tableId).kind));
    if (kinds.size > 1) {
      throw new Error("Não dá para exportar num só .dlk abas abertas em motores diferentes (prévia e software completo). Reabra as abas da prévia.");
    }
    if (kinds.has("server")) {
      // Software completo: o backend roda a receita de cada aba e grava com dd.store(dict, ...).
      const frames = items.map((i) => ({ session_id: this._entry(i.tableId).sessionId, steps: i.steps, name: i.name }));
      const { blob, filename } = await ServerEngine.exportResult(
        frames[0].session_id, frames[0].steps, context, exportOptions, frames
      );
      FileIO.downloadBlob(blob, filename);
      return { n_frames: frames.length };
    }
    const tables = [];
    for (const item of items) {
      const entry = this._entry(item.tableId);
      let result;
      try {
        ({ table: result } = await ClientEngine.runRecipe(entry.sourceTable, item.steps, { salt: context.salt }));
      } catch (err) {
        throw new Error(`Aba "${item.name}": ${err.message}`);
      }
      tables.push({ name: item.name, columns: result.columns, rows: result.rows });
    }
    const Dlk = await import("./dlk.js");
    const opts = { maskingApplied: items.some((i) => hasMaskStep(i.steps)) };
    const bytes = encrypted
      ? await Dlk.writeDlkEncryptedFrames(tables, context.key, opts)
      : await Dlk.writeDlkOpenFrames(tables, opts);
    FileIO.downloadBlob(new Blob([bytes], { type: "application/octet-stream" }), `${exportOptions.filenameBase || "resultado"}.dlk`);
    return { n_frames: tables.length };
  }

  // ── Banco de dados ────────────────────────────────────────────────────
  // Software completo: qualquer banco suportado (PostgreSQL, MySQL, SQLite...).
  // Prévia: só SQLite, abrindo um arquivo .sqlite/.db em memória com sql.js
  // (ver sqlite-db.js) — o navegador não fala o protocolo dos outros bancos.
  async _sqlite() { return import("./sqlite-db.js"); }

  /** Servidor: `uri` (string). Prévia: um File .sqlite/.db, ou null para criar um banco novo e vazio. */
  async dbConnect(uriOrFile) {
    if (this.mode === "server") return ServerEngine.dbConnect(uriOrFile);
    return (await this._sqlite()).openDatabase(uriOrFile || null);
  }
  async dbTables(connectionId) {
    if (this.mode === "server") return ServerEngine.dbTables(connectionId);
    return (await this._sqlite()).listTables(connectionId);
  }
  async dbQuery(connectionId, tableOrSql) {
    if (this.mode === "server") return ServerEngine.dbQuery(connectionId, tableOrSql);
    return (await this._sqlite()).query(connectionId, tableOrSql);
  }
  async dbExecute(connectionId, statements) {
    if (this.mode === "server") return ServerEngine.dbExecute(connectionId, statements);
    return (await this._sqlite()).execute(connectionId, statements);
  }
  async dbClose(connectionId) {
    if (this.mode === "server") return; // o backend gerencia as conexões
    (await this._sqlite()).closeDatabase(connectionId);
  }
  /** Só na prévia: baixa o arquivo .sqlite com o estado atual (as alterações vivem só em memória). */
  async dbExport(connectionId) {
    if (this.mode === "server") throw new Error("O download do arquivo só se aplica a bancos SQLite abertos na prévia.");
    const Sqlite = await this._sqlite();
    const name = Sqlite.databaseName(connectionId);
    const filename = /\.(sqlite3?|db)$/i.test(name) ? name : `${name}.sqlite`;
    FileIO.downloadBlob(new Blob([Sqlite.exportDatabase(connectionId)], { type: "application/vnd.sqlite3" }), filename);
    return { filename };
  }

  /** Abre uma tabela/consulta do banco como uma nova aba — igual a loadFile(), só que a origem é um banco. */
  async dbOpenAsTable(connectionId, tableOrSql, name = null) {
    if (this.mode === "server") {
      const res = await ServerEngine.dbQueryToSession(connectionId, tableOrSql, name);
      const tableId = this._newTableId();
      this._tables.set(tableId, { kind: "server", sessionId: res.session_id });
      return {
        tableId, name: res.name, columns: res.columns,
        previewRows: res.preview_rows, totalRows: res.total_rows,
      };
    }
    const Sqlite = await this._sqlite();
    const isTable = Sqlite.listTables(connectionId).tables.includes(String(tableOrSql).trim());
    const { columns, rows } = Sqlite.query(connectionId, tableOrSql);
    const tableId = this._newTableId();
    this._tables.set(tableId, { kind: "client", sourceTable: { columns, rows } });
    return {
      tableId, name: name || (isTable ? String(tableOrSql).trim() : "consulta_sql"), columns,
      previewRows: rows.slice(0, 50), totalRows: rows.length,
    };
  }

  /** Roda a receita da aba e escreve o resultado completo numa tabela do banco (destino). */
  async dbWriteTable(tableId, steps, salt, connectionId, table, mode, upsertOn = null) {
    const entry = this._entry(tableId);
    this._assertSameEngine(entry, "Enviar para o banco");
    if (this._isServerEntry(entry)) {
      return this._server(tableId, (sid) => ServerEngine.dbWrite(sid, steps, salt, connectionId, table, mode, upsertOn));
    }
    const { table: result } = await ClientEngine.runRecipe(entry.sourceTable, steps, { salt });
    return (await this._sqlite()).writeTable(connectionId, table, result, mode, upsertOn);
  }

  // ── Automações (jobs — só existem no software completo) ───────────────
  async listJobs() { this._requireServer("Automações"); return ServerEngine.listJobs(); }
  async createJob(draft) { this._requireServer("Automações"); return ServerEngine.createJob(draft); }
  async updateJob(id, draft) { this._requireServer("Automações"); return ServerEngine.updateJob(id, draft); }
  async deleteJob(id) { this._requireServer("Automações"); return ServerEngine.deleteJob(id); }
  async setJobEnabled(id, enabled) { this._requireServer("Automações"); return ServerEngine.setJobEnabled(id, enabled); }
  async runJobNow(id) { this._requireServer("Automações"); return ServerEngine.runJobNow(id); }
  async jobRuns(id) { this._requireServer("Automações"); return ServerEngine.jobRuns(id); }

  // ── Exploração de dados, relatório LGPD, ferramentas .dlk, varredura ────
  async complianceReport(tableId, steps, salt, options) {
    const entry = this._entry(tableId);
    if (this._isServerEntry(entry)) return this._server(tableId, (sid) => ServerEngine.complianceReport(sid, steps, salt, options));
    const { table } = await ClientEngine.runRecipe(entry.sourceTable, steps, { salt });
    const piiReport = ClientEngine.scanForPii(table);
    const { buildComplianceReport } = await import("./compliance-report.js");
    return await buildComplianceReport(entry.sourceTable, table, piiReport, options); // { blob, filename } — mesmo contrato do modo server
  }
  async privacyMetrics(tableId, steps, salt, options) {
    this._requireServer("Avaliação de privacidade");
    const entry = this._entry(tableId);
    this._assertSameEngine(entry, "Avaliação de privacidade");
    return this._server(tableId, (sid) => ServerEngine.privacyMetrics(sid, steps, salt, options));
  }
  async pipelineDiff(tableId, steps, salt) {
    const entry = this._entry(tableId);
    if (this._isServerEntry(entry)) return this._server(tableId, (sid) => ServerEngine.pipelineDiff(sid, steps, salt));
    const { table: after } = await ClientEngine.runRecipe(entry.sourceTable, steps, { salt });
    return ClientEngine.diffTables(entry.sourceTable, after);
  }

  /**
   * k-anonimato e score de risco de reidentificação, calculados 100% no
   * navegador quando não há software completo (dataframe.js#kAnonymity e
   * risk-score.js, ambos conferidos contra a biblioteca). Formato da resposta
   * compatível com privacyMetrics() (mesma forma que o template usa).
   */
  async kAnonymity(tableId, steps, salt, quasiIdentifiers) {
    const entry = this._entry(tableId);
    if (this._isServerEntry(entry)) {
      throw new Error("Esta avaliação rápida é só da prévia — no software completo use a avaliação de privacidade completa.");
    }
    const { table } = await ClientEngine.runRecipe(entry.sourceTable, steps, { salt });
    const raw = ClientEngine.kAnonymity(table, quasiIdentifiers);
    return {
      kanon: {
        k_anonymity: { k_value: raw.k_value },
        compliant_anpd: raw.compliant_anpd,
        n_groups: raw.n_groups,
        n_rows: raw.n_rows,
      },
      // Mesmo cálculo do software completo, chamado com os mesmos parâmetros que a interface
      // dele usa (só os quasi-identifiers) — ver risk-score.js.
      risk: ClientEngine.evaluateRisk(table, { quasi_identifiers: quasiIdentifiers }),
      prosecutor: ClientEngine.reidentificationStats(table, quasiIdentifiers),
    };
  }
  async dlkInspect(file, key) {
    if (this.mode === "server") return ServerEngine.dlkInspect(file, key);
    const Dlk = await import("./dlk.js");
    const buffer = new Uint8Array(await file.arrayBuffer());
    return Dlk.inspectDlk(buffer, key);
  }
  async dlkRekey(file, oldKey, newKey) {
    if (this.mode === "server") return ServerEngine.dlkRekey(file, oldKey, newKey);
    const Dlk = await import("./dlk.js");
    const buffer = new Uint8Array(await file.arrayBuffer());
    const { header, tables } = await Dlk.readDlk(buffer, oldKey, file.name.replace(/\.[^.]+$/, ""));
    const opts = { label: header.label, maskingApplied: header.masking_applied, metadata: header.metadata };
    let bytes;
    if (tables.length > 1) {
      bytes = newKey ? await Dlk.writeDlkEncryptedFrames(tables, newKey, opts) : await Dlk.writeDlkOpenFrames(tables, opts);
    } else {
      bytes = newKey ? await Dlk.writeDlkEncrypted(tables[0], newKey, opts) : await Dlk.writeDlkOpen(tables[0], opts);
    }
    return { blob: new Blob([bytes], { type: "application/octet-stream" }), filename: file.name };
  }

  /**
   * Varre uma pasta. No software completo recebe um caminho de disco; na
   * prévia recebe a lista de arquivos escolhida pelo <input webkitdirectory>
   * (o navegador não tem acesso a caminhos de disco).
   */
  async scanDirectory(pathOrFiles, options) {
    if (this.mode === "server") return ServerEngine.scanDirectory(pathOrFiles, options);
    const { scanFileList } = await import("./scan-files.js");
    return scanFileList(pathOrFiles, options);
  }

  // ── Trilha de auditoria ──────────────────────────────────────────────
  // Software completo: registra no backend. Prévia: em memória, nesta aba
  // (ver audit-trail.js), com "Salvar" baixando um .json assinado.
  async auditConfigure(enabled, path, webhook) {
    if (this.mode === "server") return ServerEngine.auditConfigure(enabled, path, webhook);
    return Audit.configure(enabled, webhook);
  }
  async auditStatus() {
    if (this.mode === "server") return ServerEngine.auditStatus();
    return Audit.status();
  }
  async auditLog() {
    if (this.mode === "server") return ServerEngine.auditLog();
    return Audit.log();
  }
  /** Servidor: grava em `path` (caminho de disco). Prévia: baixa o arquivo e ignora `path`. */
  async auditSave(path, auditKey) {
    if (this.mode === "server") return ServerEngine.auditSave(path, auditKey);
    const { blob, filename, signed } = await Audit.buildSignedFile(auditKey || null);
    FileIO.downloadBlob(blob, filename);
    return { saved_to: `${filename} (baixado${signed ? ", assinado com HMAC-SHA256" : ", SEM assinatura"})` };
  }

  _requireServer(action) {
    if (this.mode !== "server") {
      throw new Error(`${action} só está disponível no software completo (backend Python local).`);
    }
  }
}

export const engine = new DataEngine();
