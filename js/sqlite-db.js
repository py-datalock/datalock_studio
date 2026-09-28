/**
 * sqlite-db.js
 * ============
 * Banco de dados SQLite NO NAVEGADOR, com sql.js (SQLite compilado para
 * WebAssembly, carregado sob demanda do jsDelivr — só quando a pessoa abre
 * o painel de banco de dados). O navegador não consegue abrir conexão com
 * PostgreSQL/MySQL (não fala TCP), mas um arquivo SQLite dá para abrir,
 * consultar, alterar e baixar de volta, tudo local: o arquivo nunca sai do
 * navegador.
 *
 * Interface espelha a do backend (engine-server.js): conectar, listar
 * tabelas, ler tabela/SQL, executar SQL, escrever (append/replace/upsert).
 * A diferença é que o banco vive em MEMÓRIA nesta aba — as alterações só
 * persistem se a pessoa baixar o .sqlite (`exportDatabase`).
 */

const SQLJS_BASE = "https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/";

let _SQL = null;
const _dbs = new Map();
let _counter = 0;

/** Só para testes: injeta uma instância já inicializada do sql.js. */
export function _useSqlJs(SQL) { _SQL = SQL; }

async function loadSqlJs() {
  if (_SQL) return _SQL;
  if (!globalThis.initSqlJs) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `${SQLJS_BASE}sql-wasm.js`;
      s.onload = resolve;
      s.onerror = () => reject(new Error(
        "Não consegui carregar o SQLite do navegador (sql.js, via jsDelivr). Verifique a conexão."
      ));
      document.head.appendChild(s);
    });
  }
  _SQL = await globalThis.initSqlJs({ locateFile: (f) => `${SQLJS_BASE}${f}` });
  return _SQL;
}

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

function getDb(id) {
  const entry = _dbs.get(id);
  if (!entry) throw new Error("Esta conexão com o banco não existe mais (foi fechada ou a página foi recarregada).");
  return entry.db;
}

/** Abre um arquivo SQLite (File) ou, sem argumento, cria um banco novo e vazio. */
export async function openDatabase(file = null) {
  const SQL = await loadSqlJs();
  let db;
  if (file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      db = new SQL.Database(bytes);
      db.exec("SELECT name FROM sqlite_master LIMIT 1"); // valida que é mesmo um SQLite
    } catch {
      throw new Error("Este arquivo não parece ser um banco SQLite válido.");
    }
  } else {
    db = new SQL.Database();
  }
  _counter += 1;
  const id = `sqlite${_counter}`;
  _dbs.set(id, { db, name: file ? file.name : "novo_banco.sqlite" });
  return { connection_id: id };
}

export function closeDatabase(id) {
  const entry = _dbs.get(id);
  if (entry) { entry.db.close(); _dbs.delete(id); }
}

export function databaseName(id) {
  const entry = _dbs.get(id);
  return entry ? entry.name : "banco.sqlite";
}

export function listTables(id) {
  const db = getDb(id);
  const res = db.exec(
    "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  return { tables: res.length ? res[0].values.map((r) => r[0]) : [] };
}

/** Lê uma tabela (pelo nome) ou o resultado de um SELECT. Devolve { columns, rows }. */
export function query(id, tableOrSql) {
  const db = getDb(id);
  const input = String(tableOrSql).trim();
  const tables = listTables(id).tables;
  const sql = tables.includes(input) ? `SELECT * FROM ${quoteIdent(input)}` : input;
  let stmt;
  try {
    stmt = db.prepare(sql);
  } catch (err) {
    throw new Error(`SQL inválido: ${err.message}`);
  }
  try {
    const columns = stmt.getColumnNames();
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return { columns, rows };
  } finally {
    stmt.free();
  }
}

/** Executa um ou vários comandos SQL; com mais de um, é tudo-ou-nada (transação). */
export function execute(id, statements) {
  const db = getDb(id);
  const list = (Array.isArray(statements) ? statements : [statements]).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) throw new Error("Nenhum comando SQL informado.");
  db.exec("BEGIN");
  try {
    for (const sql of list) db.exec(sql);
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* já revertido */ }
    throw new Error(`Falha ao executar SQL (nada foi alterado): ${err.message}`);
  }
  return { executed: list.length };
}

// ── Escrita de uma tabela do Studio no banco ─────────────────────────────

function toSqlValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function inferSqlType(rows, col) {
  let sawInt = false, sawReal = false, sawText = false;
  for (const r of rows) {
    const v = r[col];
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "number" || typeof v === "boolean") {
      if (typeof v === "number" && !Number.isInteger(v)) sawReal = true; else sawInt = true;
    } else sawText = true;
  }
  if (sawText) return "TEXT";
  if (sawReal) return "REAL";
  if (sawInt) return "INTEGER";
  return "TEXT";
}

/**
 * @param {string} id
 * @param {string} table
 * @param {{columns: string[], rows: object[]}} data
 * @param {"append"|"replace"|"upsert"} mode
 * @param {string[]|null} upsertOn
 */
export function writeTable(id, table, data, mode = "append", upsertOn = null) {
  const db = getDb(id);
  const { columns, rows } = data;
  if (!columns.length) throw new Error("A tabela não tem colunas para enviar.");
  if (!["append", "replace", "upsert"].includes(mode)) throw new Error(`Modo desconhecido: '${mode}'.`);
  if (mode === "upsert") {
    if (!upsertOn || !upsertOn.length) throw new Error("Upsert exige ao menos uma coluna-chave.");
    const missing = upsertOn.filter((c) => !columns.includes(c));
    if (missing.length) throw new Error(`Coluna-chave inexistente na tabela: ${missing.join(", ")}.`);
  }

  const T = quoteIdent(table);
  const exists = listTables(id).tables.includes(table);
  const createSql = `CREATE TABLE ${T} (${columns.map((c) => `${quoteIdent(c)} ${inferSqlType(rows, c)}`).join(", ")})`;

  db.exec("BEGIN");
  try {
    if (mode === "replace" && exists) db.exec(`DROP TABLE ${T}`);
    if (mode === "replace" || !exists) {
      db.exec(createSql);
    } else {
      // append/upsert numa tabela que já existe: as colunas enviadas precisam existir nela
      const info = db.exec(`PRAGMA table_info(${T})`);
      const existing = new Set(info.length ? info[0].values.map((r) => r[1]) : []);
      const unknown = columns.filter((c) => !existing.has(c));
      if (unknown.length) {
        throw new Error(`A tabela "${table}" não tem a(s) coluna(s): ${unknown.join(", ")}.`);
      }
    }

    const colList = columns.map(quoteIdent).join(", ");
    const insert = db.prepare(`INSERT INTO ${T} (${colList}) VALUES (${columns.map(() => "?").join(", ")})`);
    let update = null;
    const nonKey = columns.filter((c) => !(upsertOn || []).includes(c));
    if (mode === "upsert" && nonKey.length) {
      update = db.prepare(
        `UPDATE ${T} SET ${nonKey.map((c) => `${quoteIdent(c)} = ?`).join(", ")} ` +
        `WHERE ${upsertOn.map((c) => `${quoteIdent(c)} IS ?`).join(" AND ")}`
      );
    }
    let inserted = 0, updated = 0;
    try {
      for (const row of rows) {
        if (mode === "upsert") {
          if (update) {
            update.run([...nonKey.map((c) => toSqlValue(row[c])), ...upsertOn.map((c) => toSqlValue(row[c]))]);
            if (db.getRowsModified() > 0) { updated += 1; continue; }
          } else {
            // só colunas-chave: "atualizar" não muda nada; insere apenas se ainda não existe
            const exist = db.exec(
              `SELECT 1 FROM ${T} WHERE ${upsertOn.map((c) => `${quoteIdent(c)} IS ?`).join(" AND ")} LIMIT 1`,
              upsertOn.map((c) => toSqlValue(row[c]))
            );
            if (exist.length) { updated += 1; continue; }
          }
        }
        insert.run(columns.map((c) => toSqlValue(row[c])));
        inserted += 1;
      }
    } finally {
      insert.free();
      if (update) update.free();
    }
    db.exec("COMMIT");
    return { table, rows: rows.length, inserted, updated };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* já revertido */ }
    throw err;
  }
}

/** Bytes do arquivo .sqlite com o estado atual (inclui todas as alterações feitas nesta aba). */
export function exportDatabase(id) {
  return getDb(id).export();
}
