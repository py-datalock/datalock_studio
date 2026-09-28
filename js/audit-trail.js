/**
 * audit-trail.js
 * ==============
 * Trilha de auditoria da prévia web: registra cada mascaramento (data,
 * coluna, técnica) em memória, nesta aba. Só guarda METADADOS — nunca
 * valores das células. Ao fechar/recarregar a página o registro se perde,
 * por isso existe "Salvar": baixa um .json, opcionalmente assinado com
 * HMAC-SHA256 (Web Crypto) para detectar adulteração.
 *
 * Webhook (opcional): se a pessoa informar uma URL, cada evento é enviado
 * por POST — é a ÚNICA coisa nesta página que pode sair do navegador, e só
 * se ela configurar. Como o navegador impõe CORS, o envio é "às cegas"
 * (no-cors, sem ler a resposta): serve para receptores que aceitam POST
 * simples, mas não dá para confirmar a entrega.
 */

const state = { enabled: false, entries: [], webhook: null };

export function configure(enabled, webhook = null) {
  state.enabled = !!enabled;
  state.webhook = enabled && webhook ? String(webhook).trim() : null;
  if (state.webhook && !/^https?:\/\//i.test(state.webhook)) {
    state.webhook = null;
    throw new Error("O webhook precisa começar com http:// ou https://.");
  }
  return { enabled: state.enabled };
}

export function status() {
  return { enabled: state.enabled, webhook: !!state.webhook, n_events: state.entries.length };
}

export function log() {
  return { entries: state.entries.slice() };
}

export function clear() { state.entries = []; }

/** Registra um evento (no-op se a trilha estiver desligada). Deduplica repetições imediatas. */
export function record({ column, technique, status: st = "success", stepId = null }) {
  if (!state.enabled) return;
  const now = Date.now();
  const last = state.entries[state.entries.length - 1];
  if (last && last._stepId === stepId && last.column === column && last.technique === technique
      && now - last._t < 1500) {
    return; // a mesma execução sendo refeita (ex.: prévia recalculando) — não vira evento novo
  }
  const entry = {
    timestamp: new Date(now).toISOString(),
    column, technique, status: st,
  };
  Object.defineProperty(entry, "_t", { value: now, enumerable: false });
  Object.defineProperty(entry, "_stepId", { value: stepId, enumerable: false });
  state.entries.push(entry);

  if (state.webhook) {
    try {
      fetch(state.webhook, {
        method: "POST", mode: "no-cors", keepalive: true,
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(entry),
      }).catch(() => {});
    } catch { /* webhook é best-effort */ }
  }
}

async function hmacHex(key, message) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
  return Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Monta o arquivo de auditoria. A assinatura cobre exatamente o texto
 * JSON de `payload` (chaves na ordem abaixo), então quem for verificar
 * refaz o HMAC-SHA256 sobre JSON.stringify(payload) com a mesma chave.
 */
export async function buildSignedFile(auditKey = null) {
  const payload = {
    format: "datalock-studio-audit/1",
    generated_at: new Date().toISOString(),
    source: "prévia web (navegador)",
    entries: state.entries.map((e) => ({ ...e })),
  };
  const body = JSON.stringify(payload);
  const file = {
    payload,
    signature: auditKey
      ? { algorithm: "HMAC-SHA256", over: "JSON.stringify(payload)", value: await hmacHex(auditKey, body) }
      : null,
  };
  const stamp = payload.generated_at.replace(/[:.]/g, "-");
  return {
    blob: new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }),
    filename: `auditoria_datalock_${stamp}.json`,
    signed: !!auditKey,
  };
}
