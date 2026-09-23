/**
 * engine-server.js
 * ================
 * Fala com o backend Python local (server/datalock_studio) via HTTP —
 * usado quando o software completo está rodando (localhost). Mesma
 * interface pública de engine-client.js, para o app.js poder trocar de
 * motor sem mudar a UI (ver engine.js).
 *
 * O backend é quem chama `import datalock as dd` de verdade — aqui é só
 * um cliente HTTP fino.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:8722";

// Quando o próprio backend serve este front-end (StaticFiles em app.py —
// o caso de `datalock-studio` aberto direto, sem GitHub Pages), a origem
// da página JÁ É a instância certa a usar — inclusive se essa instância
// não estiver na porta padrão (ex.: uma segunda instância, na 8723,
// aberta porque a 8722 já estava ocupada). Sem isso, uma segunda
// instância tentaria sempre falar com a 8722 (a primeira), nunca consigo
// mesma. Só cai no DEFAULT_BASE_URL fixo quando a página está hospedada
// em outro domínio (ex.: a prévia no GitHub Pages) e não faz ideia de
// qual porta local usar — nesse caso, 8722 é o palpite (a porta padrão).
function _detectDefaultBaseUrl() {
  try {
    const { protocol, hostname, port } = window.location;
    const isLocal = hostname === "127.0.0.1" || hostname === "localhost";
    if (isLocal && port) {
      return `${protocol}//${hostname}:${port}`;
    }
  } catch {
    /* ambiente sem window.location (improvável) — usa o padrão */
  }
  return DEFAULT_BASE_URL;
}

let baseUrl = _detectDefaultBaseUrl();

export function setServerBaseUrl(url) {
  baseUrl = url;
}

export async function isServerAvailable(timeoutMs = 800) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `Erro do servidor (${res.status})`);
  }
  return res.json();
}

/**
 * Envia um arquivo para o backend, que o lê com dd.read() de verdade e
 * devolve SEMPRE uma lista de tabelas (mesmo arquivos de uma tabela só —
 * lista com 1 item). XLSX com várias planilhas e .dlk multi-frame viram
 * uma tabela por planilha/frame automaticamente.
 *
 * @param {File} file
 * @param {string|null} key  Chave de descriptografia, para .dlk criptografado.
 */
export async function uploadFile(file, key = null) {
  const form = new FormData();
  form.append("file", file);
  if (key) form.append("key", key);
  const res = await fetch(`${baseUrl}/files/upload`, { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || "Falha ao enviar arquivo ao software local.");
  }
  const data = await res.json();
  return data.tables; // [{ session_id, name, columns, preview_rows, total_rows }, ...]
}

/**
 * Roda a receita inteira no backend (dd.mask/dd.frame/etc. reais) e devolve
 * uma prévia paginada do resultado + trace por step.
 */
export async function runRecipe(sessionId, steps, context = {}) {
  return postJson("/pipeline/run", { session_id: sessionId, steps, salt: context.salt || null });
}

/** dd.scan(df)/dd.profile(df) reais. */
export async function scanForPii(sessionId) {
  return postJson("/pii/scan", { session_id: sessionId });
}

/**
 * Reverte colunas strategy="encrypt" — só existe no backend real.
 * `steps` é a receita atual (deve incluir o step de mask que gerou os
 * tokens) — o backend roda a receita e SÓ DEPOIS reverte, porque o token
 * cifrado só existe após o mask ser aplicado, não no arquivo original.
 */
export async function unmask(sessionId, steps, columns, salt) {
  return postJson("/mask/unmask", { session_id: sessionId, steps, columns, salt });
}

/**
 * Exporta o resultado da receita para um arquivo — inclui formatos
 * exclusivos do software completo (.dlk single/multi, criptografado ou não).
 */
export async function exportResult(sessionId, steps, context, exportOptions) {
  const res = await fetch(`${baseUrl}/pipeline/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId, steps, salt: context.salt || null,
      key: context.key || null, export: exportOptions,
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `Falha ao exportar (${res.status})`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  return { blob, filename: match ? match[1] : "resultado" };
}

// ── Banco de dados (só backend) ──────────────────────────────────────────

export async function dbConnect(uri) {
  return postJson("/db/connect", { uri });
}

export async function dbTables(connectionId) {
  return postJson("/db/tables", { connection_id: connectionId });
}

export async function dbQuery(connectionId, tableOrSql) {
  return postJson("/db/query", { connection_id: connectionId, table_or_sql: tableOrSql });
}

export async function dbExecute(connectionId, statements) {
  // statements: string[] — se mais de um, roda como transação (tudo ou nada)
  return postJson("/db/execute", { connection_id: connectionId, statements });
}

/** Lê uma tabela ou um SELECT do banco e abre como uma nova sessão/aba. */
export async function dbQueryToSession(connectionId, tableOrSql, name = null) {
  return postJson("/db/query-to-session", { connection_id: connectionId, table_or_sql: tableOrSql, name });
}

/** Roda a receita e escreve o resultado completo numa tabela do banco (destino). */
export async function dbWrite(sessionId, steps, salt, connectionId, table, mode, upsertOn = null) {
  return postJson("/db/write", {
    session_id: sessionId, steps, salt, connection_id: connectionId,
    table, mode, upsert_on: upsertOn,
  });
}

// ── Automações (jobs — só backend) ────────────────────────────────────────

export async function listJobs() {
  const res = await fetch(`${baseUrl}/jobs`);
  if (!res.ok) throw new Error("Falha ao listar automações.");
  return (await res.json()).jobs;
}

export async function createJob(jobDraft) {
  return postJson("/jobs", jobDraft);
}

export async function updateJob(jobId, jobDraft) {
  const res = await fetch(`${baseUrl}/jobs/${jobId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(jobDraft),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || "Falha ao salvar a automação.");
  }
  return res.json();
}

export async function deleteJob(jobId) {
  const res = await fetch(`${baseUrl}/jobs/${jobId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Falha ao remover a automação.");
  return res.json();
}

export async function setJobEnabled(jobId, enabled) {
  const res = await fetch(`${baseUrl}/jobs/${jobId}/${enabled ? "enable" : "disable"}`, { method: "POST" });
  if (!res.ok) throw new Error("Falha ao atualizar a automação.");
  return res.json();
}

export async function runJobNow(jobId) {
  const res = await fetch(`${baseUrl}/jobs/${jobId}/run-now`, { method: "POST" });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || "Falha ao rodar a automação.");
  }
  return res.json();
}

export async function jobRuns(jobId) {
  const res = await fetch(`${baseUrl}/jobs/${jobId}/runs`);
  if (!res.ok) throw new Error("Falha ao buscar o histórico.");
  return (await res.json()).runs;
}

export const engineInfo = {
  kind: "server",
  label: "Software completo (motor Python real)",
  supportsEncrypt: true,
  supportsDlk: true,
  supportsDb: true,
};
