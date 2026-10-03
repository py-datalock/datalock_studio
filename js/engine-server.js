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

// Na primeira conexão logo depois do processo subir, é comum a primeira
// requisição real (não o /health, que já teve sucesso) falhar e uma
// tentativa manual logo em seguida dar certo — no Windows, o motivo mais
// comum é o firewall mostrar (ou processar, mesmo sem mostrar) o aviso de
// "permitir este programa na rede" na primeira conexão de um processo
// recém-iniciado; antivírus/proxy de rede também podem interceptar só a
// primeira tentativa. Isso costuma se manifestar como a resposta não
// sendo JSON válido (uma página de bloqueio, ou a conexão sendo cortada
// no meio) — diferente de um erro "de verdade" do nosso próprio backend,
// que sempre devolve `{"detail": "..."}`. Uma tentativa extra automática,
// com um pequeno atraso, resolve o mesmo jeito que "tentar de novo"
// resolve manualmente, sem a pessoa precisar perceber e clicar de novo.
/** Token da sessão: o programa instalado o injeta na própria página (<meta name="dl-token">).
 *  Na prévia hospedada o valor continua sendo o texto "__DL_TOKEN__" → não há token (e não é exigido). */
function _token() {
  try {
    const v = document.querySelector('meta[name="dl-token"]')?.content || "";
    return v && !v.startsWith("__") ? v : "";
  } catch { return ""; }
}
function _withAuth(init = {}) {
  const t = _token();
  return t ? { ...init, headers: { ...(init.headers || {}), "X-DL-Token": t } } : init;
}

async function _fetchWithRetry(input, init, { retries = 1, delayMs = 700 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(input, _withAuth(init));
    } catch (err) {
      lastErr = err; // erro de rede de verdade (ex.: conexão recusada) — tenta de novo
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw lastErr;
}

/** Lê o corpo de erro; se não for JSON válido, é sinal de algo "no meio do
 * caminho" (firewall, antivírus, proxy) em vez de um erro do nosso próprio
 * backend — o chamador decide se vale tentar de novo com base nisso. */
async function _readErrorDetail(res) {
  try {
    const data = await res.json();
    return { detail: data.detail || null, wasJson: true };
  } catch {
    return { detail: null, wasJson: false };
  }
}

/**
 * Formata o campo "detail" de um erro do FastAPI numa string legível —
 * NUNCA passa o valor cru pra `new Error(...)`. Isso importa porque o
 * `Error()` do JS converte o argumento pra string na hora da construção
 * (não depois, quando alguém lê `.message`): se "detail" for a lista de
 * erros de validação que o FastAPI devolve num 422
 * (`[{loc, msg, type}, ...]`), `new Error(essaLista)` vira literalmente
 * o texto "[object Object]" — a informação já se perde ali, não dá pra
 * recuperar tratando `.message` depois. Formatar ANTES resolve de vez.
 */
function _formatDetail(rawDetail, fallback) {
  if (!rawDetail) return fallback;
  if (typeof rawDetail === "string") return rawDetail;
  if (Array.isArray(rawDetail)) {
    // Formato de erro de validação do FastAPI/Pydantic: [{loc, msg, type}, ...]
    // Inclui o NOME DO CAMPO (loc) na mensagem — sem isso, um erro como
    // "Field required" sozinho não diz qual campo, dificultando muito
    // diagnosticar (é só o texto genérico que o Pydantic usa pra qualquer
    // campo obrigatório ausente, não algo específico desta aplicação).
    const parts = rawDetail.map((d) => {
      if (!d || typeof d !== "object") return JSON.stringify(d);
      const field = Array.isArray(d.loc) ? d.loc.filter((p) => p !== "body").join(".") : null;
      return field ? `${field}: ${d.msg}` : (d.msg || JSON.stringify(d));
    });
    return parts.join("; ") || fallback;
  }
  try { return JSON.stringify(rawDetail); } catch { return fallback; }
}

const _NETWORK_HICCUP_HINT =
  " (A resposta não veio do motor local. Se acabou de abrir o programa, aguarde alguns segundos e tente de novo; " +
  "se persistir, feche e abra o programa e veja o log em ~/.datalock_studio/desktop.log.)";

/** Versões informadas pelo /health (studio_version, datalock_version) — null se ainda não conectou. */
let _serverInfo = null;
export function getServerInfo() { return _serverInfo; }

export function setServerBaseUrl(url) {
  baseUrl = url;
}

export async function isServerAvailable(timeoutMs = 2500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    // Sem retry aqui de propósito: pra quem só usa a prévia (backend nem
    // está rodando), isso é o caminho mais comum — repetir só atrasaria a
    // resposta "não está rodando" sem ganhar nada. O retry automático (ver
    // _fetchWithRetry) é pra depois de já saber que o backend existe.
    const res = await fetch(`${baseUrl}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) { try { _serverInfo = await res.json(); } catch { _serverInfo = null; } }
    return res.ok;
  } catch {
    return false;
  }
}

async function postJson(path, body) {
  const res = await _fetchWithRetry(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const { detail, wasJson } = await _readErrorDetail(res);
    throw new Error(_formatDetail(detail, `Erro do servidor (${res.status})${wasJson ? "" : _NETWORK_HICCUP_HINT}`));
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
  const res = await _fetchWithRetry(`${baseUrl}/files/upload`, { method: "POST", body: form });
  if (!res.ok) {
    const { detail, wasJson } = await _readErrorDetail(res);
    throw new Error(_formatDetail(detail, `Falha ao enviar arquivo ao software local.${wasJson ? "" : _NETWORK_HICCUP_HINT}`));
  }
  const data = await res.json();
  return data.tables; // [{ session_id, name, columns, preview_rows, total_rows }, ...]
}

/**
 * Roda a receita inteira no backend (dd.mask/dd.frame/etc. reais) e devolve
 * uma prévia paginada do resultado + trace por step.
 */
export async function runRecipe(sessionId, steps, context = {}) {
  return postJson("/pipeline/run", {
    session_id: sessionId, steps, salt: context.salt || null,
    offset: context.offset || 0, search: context.search || null,
  });
}

/** dd.scan(df)/dd.profile(df) reais. */
export async function scanForPii(sessionId) {
  return postJson("/pii/scan", { session_id: sessionId });
}

/** EDA automática — um resumo (histograma/contagem) por coluna, de uma vez. */
export async function autoEda(sessionId, steps, salt) {
  return postJson("/eda/auto", { session_id: sessionId, steps, salt });
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
export async function exportResult(sessionId, steps, context, exportOptions, frames = null) {
  const res = await _fetchWithRetry(`${baseUrl}/pipeline/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId, steps, salt: context.salt || null,
      key: context.key || null, export: exportOptions,
      // várias abas num .dlk só: [{session_id, steps, name}] — ver /pipeline/export
      frames,
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(_formatDetail(detail.detail, `Falha ao exportar (${res.status})`));
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
  const res = await _fetchWithRetry(`${baseUrl}/jobs`);
  if (!res.ok) throw new Error("Falha ao listar automações.");
  return (await res.json()).jobs;
}

export async function createJob(jobDraft) {
  return postJson("/jobs", jobDraft);
}

export async function updateJob(jobId, jobDraft) {
  const res = await _fetchWithRetry(`${baseUrl}/jobs/${jobId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(jobDraft),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(_formatDetail(detail.detail, "Falha ao salvar a automação."));
  }
  return res.json();
}

export async function deleteJob(jobId) {
  const res = await _fetchWithRetry(`${baseUrl}/jobs/${jobId}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Falha ao remover a automação.");
  return res.json();
}

export async function setJobEnabled(jobId, enabled) {
  const res = await _fetchWithRetry(`${baseUrl}/jobs/${jobId}/${enabled ? "enable" : "disable"}`, { method: "POST" });
  if (!res.ok) throw new Error("Falha ao atualizar a automação.");
  return res.json();
}

export async function runJobNow(jobId) {
  const res = await _fetchWithRetry(`${baseUrl}/jobs/${jobId}/run-now`, { method: "POST" });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(_formatDetail(detail.detail, "Falha ao rodar a automação."));
  }
  return res.json();
}

export async function jobRuns(jobId) {
  const res = await _fetchWithRetry(`${baseUrl}/jobs/${jobId}/runs`);
  if (!res.ok) throw new Error("Falha ao buscar o histórico.");
  return (await res.json()).runs;
}

// ── Exploração de dados, relatório LGPD, ferramentas .dlk, varredura ──────

export async function complianceReport(sessionId, steps, salt, options) {
  const res = await _fetchWithRetry(`${baseUrl}/pii/compliance-report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, steps, salt, ...options }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(_formatDetail(detail.detail, "Falha ao gerar o relatório."));
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  return { blob, filename: match ? match[1] : "relatorio_lgpd" };
}

export async function privacyMetrics(sessionId, steps, salt, options) {
  return postJson("/pii/privacy-metrics", { session_id: sessionId, steps, salt, ...options });
}

export async function pipelineDiff(sessionId, steps, salt) {
  return postJson("/pipeline/diff", { session_id: sessionId, steps, salt });
}

export async function dlkInspect(file, key) {
  const form = new FormData();
  form.append("file", file);
  if (key) form.append("key", key);
  const res = await _fetchWithRetry(`${baseUrl}/dlk/inspect`, { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(_formatDetail(detail.detail, "Falha ao inspecionar o arquivo."));
  }
  return res.json();
}

export async function dlkRekey(file, oldKey, newKey) {
  const form = new FormData();
  form.append("file", file);
  form.append("old_key", oldKey);
  form.append("new_key", newKey);
  const res = await _fetchWithRetry(`${baseUrl}/dlk/rekey`, { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(_formatDetail(detail.detail, "Falha ao trocar a chave."));
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  return { blob, filename: match ? match[1] : "rekeyed.dlk" };
}

export async function scanDirectory(path, options) {
  return postJson("/scan-directory", { path, ...options });
}

// ── Trilha de auditoria ─────────────────────────────────────────────────

export async function auditConfigure(enabled, path, webhook) {
  return postJson("/audit/configure", { enabled, path: path || null, webhook: webhook || null });
}

export async function auditStatus() {
  const res = await _fetchWithRetry(`${baseUrl}/audit/status`);
  if (!res.ok) throw new Error("Falha ao consultar o status da auditoria.");
  return res.json();
}

export async function auditLog() {
  const res = await _fetchWithRetry(`${baseUrl}/audit/log`);
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(_formatDetail(detail.detail, "Falha ao buscar a trilha de auditoria."));
  }
  return res.json();
}

export async function auditSave(path, auditKey) {
  return postJson("/audit/save", { path, audit_key: auditKey || null });
}

export const engineInfo = {
  kind: "server",
  label: "Software completo (motor Python real)",
  supportsEncrypt: true,
  supportsDlk: true,
  supportsDb: true,
  supportsDiff: true,
  supportsKAnonymity: true,
};


// ── Estado em disco: preferências, rascunhos de receita e arquivos recentes ──
// (ver server/datalock_studio/state.py — vive no disco, não depende de porta nem de navegador)
async function _json(path, method, body) {
  const res = await _fetchWithRetry(`${baseUrl}${path}`, {
    method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Estado local indisponível (${res.status})`);
  return res.json();
}
export const stateApi = {
  getPrefs: () => _json("/state/prefs", "GET"),
  putPrefs: (prefs) => _json("/state/prefs", "PUT", { prefs }),
  getDrafts: () => _json("/state/drafts", "GET"),
  putDraft: (name, steps) => _json("/state/drafts", "PUT", { name, steps }),
  deleteDraft: (name) => _json("/state/drafts/delete", "POST", { name }),
  addRecent: (name, rows) => _json("/state/recents", "POST", { name, rows }),
  clearRecents: () => _json("/state/recents/clear", "POST", {}),
};
