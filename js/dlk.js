/**
 * dlk.js
 * ======
 * Leitura e escrita do formato `.dlk` (SecureFile) DIRETAMENTE no navegador —
 * implementado a partir do código-fonte real de `datalock/secure_file.py`
 * (compartilhado para viabilizar isto) e VALIDADO byte-a-byte: gerei
 * arquivos `.dlk` reais com a biblioteca Python (abertos, cifrados com
 * AES-256-GCM e com ChaCha20-Poly1305, comprimidos com zstd e com lz4) e
 * conferi que este código lê todos corretamente; e testei o caminho
 * inverso — um arquivo escrito por este código é lido corretamente pela
 * biblioteca Python real.
 *
 * O que É compatível de verdade (não uma aproximação):
 *   - Todas as chaves (DEK/HEK/MAK) via HKDF-SHA256 (RFC 5869), com os
 *     mesmos labels `info=` do Python — usa a Web Crypto API nativa.
 *   - AES-256-GCM nativo (Web Crypto). ChaCha20-Poly1305 (usado pelo Python
 *     quando o benchmark de CPU dele escolhe esse cipher em vez de
 *     AES-NI) via `@noble/ciphers`, uma implementação pura em JS, auditada,
 *     amplamente usada — só para LEITURA (a prévia sempre ESCREVE com
 *     AES-256-GCM, nativo e mais simples de manter).
 *   - HMAC-SHA256 de integridade do arquivo inteiro (Web Crypto nativa).
 *   - O payload interno é Arrow IPC (não Parquet puro) — via `apache-arrow`
 *     (a implementação oficial em JS). Compressão interna zstd/lz4 via
 *     `fzstd`/`lz4js` (ambos puro JS), plugados no *codec registry* do
 *     apache-arrow.
 *
 * O que NÃO é suportado (limitações conhecidas, não um "quase funciona"):
 *   - Escrita comprimida: o apache-arrow em JS só sabe LER Arrow IPC
 *     comprimido, não escrever — a prévia sempre escreve sem compressão
 *     (arquivo um pouco maior; o software completo lê normalmente, já que
 *     "sem compressão" é uma opção válida do formato, não um caso especial).
 *   - Multi-frame (v3 cifrado e v4 aberto): leitura e escrita funcionam
 *     (o payload é um .zip sem compressão própria, com um Arrow IPC por
 *     frame e um index.json — usa `fflate`). Testado nos dois sentidos
 *     contra arquivos gerados pela biblioteca Python real. NÃO cobre o
 *     multi-frame com ACL (níveis de acesso por frame, `pack_frames_acl`).
 *   - Tipos de coluna: na escrita, tudo vira Utf8/Float64/Bool (o mesmo
 *     nível de detalhe que csv/xlsx/json já têm na prévia) — sem tipos
 *     Arrow mais específicos (datas, inteiros de tamanho fixo, etc.).
 *
 * Se algo aqui não abrir um `.dlk` específico, é preferível ver um erro
 * claro do que um dado errado silencioso — funções aqui preferem lançar
 * exceção a "adivinhar".
 */

import { inferWriteSchema } from "./dataframe.js";

// CDN — pacotes puros em JS/TS, sem passo de build. jsdelivr "+esm"
// empacota qualquer pacote do npm como um módulo ES único, mesmo pacotes
// grandes/com vários arquivos internos (caso do apache-arrow).
const ARROW_URL = "https://cdn.jsdelivr.net/npm/apache-arrow@21/+esm";
const LZ4_URL = "https://cdn.jsdelivr.net/npm/lz4js@0.2/+esm";
const FZSTD_URL = "https://cdn.jsdelivr.net/npm/fzstd@0.1/+esm";
const NOBLE_CHACHA_URL = "https://cdn.jsdelivr.net/npm/@noble/ciphers@1/chacha.js/+esm";
const FFLATE_URL = "https://cdn.jsdelivr.net/npm/fflate@0/+esm";

let _arrow = null;
let _codecsRegistered = false;
async function _loadArrow() {
  if (_arrow) return _arrow;
  _arrow = await import(ARROW_URL);
  return _arrow;
}

/** Registra os decodificadores zstd/lz4 no apache-arrow (só precisa 1x). */
async function _ensureCodecs(arrow) {
  if (_codecsRegistered) return;
  const [lz4mod, fzstdMod] = await Promise.all([import(LZ4_URL), import(FZSTD_URL)]);
  const lz4js = lz4mod.default || lz4mod;
  const fzstd = fzstdMod.default || fzstdMod;
  // Sempre copia pra um Uint8Array "limpo" (offset 0, buffer próprio): o
  // carregador de tipos de tamanho variável do apache-arrow (large_utf8,
  // usado por padrão para colunas de texto vindas do pandas) exige que o
  // buffer devolvido esteja alinhado a 8 bytes a partir do seu PRÓPRIO
  // início — nem lz4js nem fzstd garantem isso.
  arrow.compressionRegistry.set(arrow.CompressionType.LZ4_FRAME, {
    decode: (b) => new Uint8Array(lz4js.decompress(b)),
  });
  arrow.compressionRegistry.set(arrow.CompressionType.ZSTD, {
    decode: (b) => new Uint8Array(fzstd.decompress(b)),
  });
  _codecsRegistered = true;
}

let _noble = null;
async function _loadNobleChacha() {
  if (!_noble) _noble = await import(NOBLE_CHACHA_URL);
  return _noble;
}

let _fflate = null;
async function _loadFflate() {
  if (!_fflate) _fflate = await import(FFLATE_URL);
  return _fflate;
}

// ── Constantes do formato (espelham secure_file.py exatamente) ────────────
const MAGIC = new TextEncoder().encode("DLOCK"); // 5 bytes
const NONCE_LEN = 12;
const AUTH_TAG_LEN = 16;
const SALT_KDF_LEN = 32;
const FILE_HMAC_LEN = 32;
const CIPHER_BYTE_TO_STR = { 1: "AES256GCM", 2: "ChaCha20Poly1305" };
const CIPHER_STR_TO_BYTE = { AES256GCM: 1, ChaCha20Poly1305: 2 };
const NO_KEY_HMAC_KEY = new TextEncoder().encode("datalock-no-key-integrity-v1");
const MULTI_FRAME_INDEX = "index.json";

function _bufEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function _u32be(n) {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}
function _readU32BE(buf, offset) {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}
function _concat(...arrs) {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// ── Primitivos criptográficos (mesmos labels/algoritmos do Python) ───────
async function _hkdf(masterKeyBytes, salt, infoStr) {
  const info = new TextEncoder().encode(infoStr);
  const baseKey = await crypto.subtle.importKey("raw", masterKeyBytes, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, baseKey, 256);
  return new Uint8Array(bits);
}
const _deriveDek = (mk, salt) => _hkdf(mk, salt, "datalock-dek-v1");
const _deriveHek = (mk, salt) => _hkdf(mk, salt, "datalock-hek-v1");
const _deriveMak = (mk, salt) => _hkdf(mk, salt, "datalock-mak-v1");

async function _aesGcmDecrypt(keyBytes, nonce, ciphertextWithTag) {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertextWithTag));
}
async function _aesGcmEncrypt(keyBytes, nonce, plaintext) {
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext));
}
async function _decryptAny(cipherStr, keyBytes, nonce, ciphertextWithTag) {
  if (cipherStr === "AES256GCM") return _aesGcmDecrypt(keyBytes, nonce, ciphertextWithTag);
  if (cipherStr === "ChaCha20Poly1305") {
    const { chacha20poly1305 } = await _loadNobleChacha();
    return chacha20poly1305(keyBytes, nonce).decrypt(ciphertextWithTag);
  }
  throw new Error(`Cipher desconhecido no arquivo .dlk: ${cipherStr}`);
}
async function _hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

// ── Conversão Arrow <-> {columns, rows} (nosso formato interno) ──────────
function _fromArrowValue(v) {
  if (typeof v !== "bigint") return v;
  return (v >= Number.MIN_SAFE_INTEGER && v <= Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
}

async function _ipcBytesToTableObj(bytes) {
  const arrow = await _loadArrow();
  await _ensureCodecs(arrow);
  const marker = new TextDecoder("latin1").decode(bytes.slice(0, 5));
  const ipcBytes = marker === "IPC1\x00" ? bytes.slice(5) : bytes;
  const arrowTable = arrow.tableFromIPC(ipcBytes);
  const columns = arrowTable.schema.fields.map((f) => f.name);
  const rows = arrowTable.toArray().map((r) => {
    const obj = r.toJSON ? r.toJSON() : r;
    const out = {};
    for (const c of columns) out[c] = _fromArrowValue(obj[c]);
    return out;
  });
  return { columns, rows };
}

/** {columns, rows} -> bytes Arrow IPC (stream), com marcador "IPC1\0". Sem
 * compressão de propósito (ver docstring do arquivo). */
async function _tableObjToIpcBytes({ columns, rows }) {
  const arrow = await _loadArrow();
  // Tipo pelo valor REAL (ver inferWriteKind): texto que parece número ("00", "02") continua texto.
  const schema = inferWriteSchema(columns, rows);
  const vectors = {};
  for (const { name, dtype } of schema) {
    const values = rows.map((r) => r[name] ?? null);
    if (dtype === "number") {
      vectors[name] = arrow.vectorFromArray(values.map((v) => (v === null || v === "" ? null : Number(v))), new arrow.Float64());
    } else if (dtype === "boolean") {
      vectors[name] = arrow.vectorFromArray(values.map((v) => (v === null || v === "" ? null : Boolean(v))), new arrow.Bool());
    } else {
      // texto (e datas, como ISO string) — grava o valor como veio, sem converter.
      vectors[name] = arrow.vectorFromArray(values.map((v) => (v === null || v === undefined ? null : String(v))), new arrow.Utf8());
    }
  }
  const arrowTable = new arrow.Table(vectors);
  const ipcBytes = arrow.tableToIPC(arrowTable, "stream");
  return _concat(new TextEncoder().encode("IPC1\x00"), ipcBytes);
}

// ── Multi-frame: payload = ZIP (sem compressão) de Arrow IPC + index.json ─
async function _unzipFrames(payload) {
  const { unzipSync } = await _loadFflate();
  const files = unzipSync(payload);
  if (!files[MULTI_FRAME_INDEX]) throw new Error("Multi-frame inválido: index.json ausente no arquivo.");
  const index = JSON.parse(new TextDecoder().decode(files[MULTI_FRAME_INDEX]));
  const tables = [];
  for (const entry of index) {
    if (!files[entry.filename]) throw new Error(`Multi-frame inválido: falta o frame "${entry.name}".`);
    const table = await _ipcBytesToTableObj(files[entry.filename]);
    tables.push({ name: entry.name, ...table });
  }
  return tables;
}

/** Empacota várias tabelas num ZIP sem compressão (mesma estrutura de `_frames_to_zip_bytes`). */
async function _tablesToZipBytes(tables) {
  if (!tables.length) throw new Error("É preciso ao menos uma tabela.");
  const { zipSync } = await _loadFflate();
  const files = {};
  const index = [];
  const used = new Set();
  for (const t of tables) {
    // O nome do frame precisa ser único (é a chave no software completo) e virar um
    // nome de arquivo dentro do zip, então "/" e nomes repetidos são normalizados.
    let base = String(t.name || "tabela").trim().replace(/[\\/]/g, "_") || "tabela";
    let name = base, n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    used.add(name);
    const bytes = await _tableObjToIpcBytes(t);
    const filename = `${name}.parquet`; // o software completo usa esse nome, embora o conteúdo seja Arrow IPC
    files[filename] = [bytes, { level: 0 }];
    index.push({
      name, filename, size_bytes: bytes.length, rows: t.rows.length, cols: t.columns.length,
      schema: Object.fromEntries(inferWriteSchema(t.columns, t.rows).map((c) => [c.name, c.dtype])),
    });
  }
  files[MULTI_FRAME_INDEX] = [new TextEncoder().encode(JSON.stringify(index)), { level: 0 }];
  return { zip: zipSync(files), index };
}

// ── Leitura ────────────────────────────────────────────────────────────
/**
 * Lê um arquivo `.dlk` (qualquer versão: v1 legado, v2, v3 multi-frame, v4
 * aberto). Devolve sempre uma LISTA de tabelas (mesmo para arquivos de uma
 * tabela só), no mesmo formato usado pelo resto da prévia — consistente com
 * `file-io.js#readFileTables()`.
 *
 * @param {ArrayBuffer|Uint8Array} fileBytes
 * @param {string|null} keyStr  Necessário para v1/v2/v3; null para v4 aberto.
 * @returns {Promise<{header: object, tables: Array<{name, columns, rows}>}>}
 */
export async function readDlk(fileBytes, keyStr, baseName = "dados") {
  const bytes = fileBytes instanceof Uint8Array ? fileBytes : new Uint8Array(fileBytes);
  if (bytes.length < 6 || !_bufEq(bytes.slice(0, 5), MAGIC)) {
    throw new Error("Este arquivo não parece ser um .dlk válido (assinatura DLOCK ausente).");
  }
  const version = bytes[5];

  if (version === 0x04) {
    let offset = 6;
    const headerLen = _readU32BE(bytes, offset); offset += 4;
    const header = JSON.parse(new TextDecoder().decode(bytes.slice(offset, offset + headerLen)));
    offset += headerLen;
    const fileHmac = bytes.slice(bytes.length - FILE_HMAC_LEN);
    const bodyForHmac = bytes.slice(0, bytes.length - FILE_HMAC_LEN);
    const payload = bytes.slice(offset, bytes.length - FILE_HMAC_LEN);

    const hmacKey = keyStr ? new TextEncoder().encode(keyStr) : NO_KEY_HMAC_KEY;
    const expected = await _hmacSha256(hmacKey, bodyForHmac);
    if (!_bufEq(expected, fileHmac)) {
      throw new Error(
        keyStr
          ? "Falha de integridade (HMAC inválido) — a key informada pode estar errada, ou o arquivo foi alterado."
          : "Falha de integridade (HMAC inválido) — o arquivo foi alterado após ser criado."
      );
    }
    if (header.content_type === "multi_dataframe") {
      return { header, tables: await _unzipFrames(payload) };
    }
    const table = await _ipcBytesToTableObj(payload);
    return { header, tables: [{ name: baseName, ...table }] };
  }

  if (version === 0x01) {
    if (!keyStr) throw new Error("Este arquivo .dlk é cifrado (v1) — informe a key para abri-lo.");
    const masterKeyBytes = new TextEncoder().encode(keyStr);
    let offset = 6;
    const headerLen = _readU32BE(bytes, offset); offset += 4;
    const header = JSON.parse(new TextDecoder().decode(bytes.slice(offset, offset + headerLen)));
    offset += headerLen;
    const saltKdf = bytes.slice(offset, offset + SALT_KDF_LEN); offset += SALT_KDF_LEN;
    const nonce = bytes.slice(offset, offset + NONCE_LEN); offset += NONCE_LEN;
    const fileHmac = bytes.slice(bytes.length - FILE_HMAC_LEN);
    const bodyForHmac = bytes.slice(0, bytes.length - FILE_HMAC_LEN);
    const expected = await _hmacSha256(masterKeyBytes, bodyForHmac);
    if (!_bufEq(expected, fileHmac)) {
      throw new Error("Falha de integridade (HMAC inválido) — a key informada pode estar errada, ou o arquivo foi alterado.");
    }
    const ciphertextWithTag = bytes.slice(offset, bytes.length - FILE_HMAC_LEN);
    const dek = await _deriveDek(masterKeyBytes, saltKdf);
    const payload = await _aesGcmDecrypt(dek, nonce, ciphertextWithTag);
    const table = await _ipcBytesToTableObj(payload);
    return { header, tables: [{ name: baseName, ...table }] };
  }

  if (version === 0x02 || version === 0x03) {
    if (!keyStr) throw new Error("Este arquivo .dlk é cifrado — informe a key para abri-lo.");
    const masterKeyBytes = new TextEncoder().encode(keyStr);
    let offset = 6;
    const cipherByte = bytes[offset]; offset += 1;
    const cipherStr = CIPHER_BYTE_TO_STR[cipherByte];
    if (!cipherStr) throw new Error(`Cipher desconhecido no arquivo (byte 0x${cipherByte.toString(16)}).`);
    const saltKdf = bytes.slice(offset, offset + SALT_KDF_LEN); offset += SALT_KDF_LEN;
    const nonceHeader = bytes.slice(offset, offset + NONCE_LEN); offset += NONCE_LEN;
    const headerCtLen = _readU32BE(bytes, offset); offset += 4;
    const headerCtWithTag = bytes.slice(offset, offset + headerCtLen); offset += headerCtLen;

    const hek = await _deriveHek(masterKeyBytes, saltKdf);
    let headerPlain;
    try {
      headerPlain = await _decryptAny(cipherStr, hek, nonceHeader, headerCtWithTag);
    } catch {
      // Com a key errada a decifragem do cabeçalho falha antes mesmo da checagem de integridade —
      // o erro cru do WebCrypto ("invalid tag") não diz nada a quem usa, então traduz.
      throw new Error("Falha de integridade (HMAC inválido) — a key informada pode estar errada, ou o arquivo foi alterado.");
    }
    const header = JSON.parse(new TextDecoder().decode(headerPlain));

    const noncePayload = bytes.slice(offset, offset + NONCE_LEN); offset += NONCE_LEN;
    const fileHmac = bytes.slice(bytes.length - FILE_HMAC_LEN);
    const bodyForHmac = bytes.slice(0, bytes.length - FILE_HMAC_LEN);
    const payloadCtWithTag = bytes.slice(offset, bytes.length - FILE_HMAC_LEN);

    const mak = await _deriveMak(masterKeyBytes, saltKdf);
    const expected = await _hmacSha256(mak, bodyForHmac);
    if (!_bufEq(expected, fileHmac)) {
      throw new Error("Falha de integridade (HMAC inválido) — a key informada pode estar errada, ou o arquivo foi alterado.");
    }

    const dek = await _deriveDek(masterKeyBytes, saltKdf);
    const payloadPlain = await _decryptAny(cipherStr, dek, noncePayload, payloadCtWithTag);

    if (header.content_type === "multi_dataframe") {
      return { header, tables: await _unzipFrames(payloadPlain) };
    }

    const table = await _ipcBytesToTableObj(payloadPlain);
    return { header, tables: [{ name: baseName, ...table }] };
  }

  throw new Error(`Versão de .dlk não reconhecida (byte 0x${version.toString(16)}) — arquivo corrompido ou formato mais novo que esta prévia conhece.`);
}

// ── Escrita ────────────────────────────────────────────────────────────
const CREATED_BY = "datalock-studio-web";

/** Empacota `payload` num .dlk v4 aberto (sem criptografia) com o header dado. */
async function _packOpen(payload, header) {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const body = _concat(MAGIC, new Uint8Array([0x04]), _u32be(headerBytes.length), headerBytes, payload);
  const hmac = await _hmacSha256(NO_KEY_HMAC_KEY, body);
  return _concat(body, hmac);
}

/** Empacota `payload` num .dlk cifrado (v2 = uma tabela, v3 = multi-frame), sempre AES-256-GCM
 * (nativo, sem dependência extra) — o software completo lê normalmente, já que o cipher usado é
 * negociado por arquivo (byte CIPHER no cabeçalho), não fixo. */
async function _packEncrypted(payload, header, keyStr, versionByte) {
  if (!keyStr) throw new Error("Escrever um .dlk cifrado precisa de uma key.");
  const masterKeyBytes = new TextEncoder().encode(keyStr);

  const saltKdf = crypto.getRandomValues(new Uint8Array(SALT_KDF_LEN));
  const dek = await _deriveDek(masterKeyBytes, saltKdf);
  const hek = await _deriveHek(masterKeyBytes, saltKdf);
  const mak = await _deriveMak(masterKeyBytes, saltKdf);

  const noncePayload = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const payloadCtWithTag = await _aesGcmEncrypt(dek, noncePayload, payload);

  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const nonceHeader = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
  const headerCtWithTag = await _aesGcmEncrypt(hek, nonceHeader, headerBytes);

  const body = _concat(
    MAGIC, new Uint8Array([versionByte, CIPHER_STR_TO_BYTE.AES256GCM]),
    saltKdf, nonceHeader, _u32be(headerCtWithTag.length), headerCtWithTag,
    noncePayload, payloadCtWithTag
  );
  const hmac = await _hmacSha256(mak, body);
  return _concat(body, hmac);
}

/** Escreve um `.dlk` aberto (v4, sem criptografia) — só para dados já
 * anonimizados/sem PII, como o próprio formato exige. */
export async function writeDlkOpen(table, options = {}) {
  const payload = await _tableObjToIpcBytes(table);
  const header = {
    format: "lgs", version: "4.0", format_version: "4.0", content_type: "raw_dataframe",
    encrypted: false, label: options.label || "",
    created_at: new Date().toISOString(), created_by: CREATED_BY,
    shape: [table.rows.length, table.columns.length], masking_applied: !!options.maskingApplied,
  };
  return _packOpen(payload, header);
}

/** Escreve um `.dlk` cifrado de uma tabela (v2). */
export async function writeDlkEncrypted(table, keyStr, options = {}) {
  if (!keyStr) throw new Error("writeDlkEncrypted precisa de uma key.");
  const payload = await _tableObjToIpcBytes(table);
  const header = {
    format: "lgs", version: "2.0", format_version: "3.0", content_type: "raw_dataframe",
    label: options.label || "", created_at: new Date().toISOString(),
    created_by: CREATED_BY, shape: [table.rows.length, table.columns.length],
    schema: Object.fromEntries(inferWriteSchema(table.columns, table.rows).map((s) => [s.name, s.dtype])),
    columns: table.columns, masking_applied: !!options.maskingApplied,
    compression: "none", kdf: "HKDF-SHA256-v2", encryption: "AES256GCM",
    integrity: "HMAC-SHA256+MAK", metadata: options.metadata || {}, expires_at: options.expiresAt || null,
  };
  return _packEncrypted(payload, header, keyStr, 0x02);
}

/**
 * Escreve VÁRIAS tabelas num só `.dlk` aberto (v4 multi-frame) — equivalente a
 * `SecureFile.pack_open_frames`. Só para dados já anonimizados/sem PII.
 * @param {Array<{name: string, columns: string[], rows: object[]}>} tables
 */
export async function writeDlkOpenFrames(tables, options = {}) {
  const { zip, index } = await _tablesToZipBytes(tables);
  const header = {
    format: "lgs", version: "4.0", format_version: "4.0", content_type: "multi_dataframe",
    encrypted: false, label: options.label || "", created_at: new Date().toISOString(),
    created_by: CREATED_BY, n_frames: index.length, frame_names: index.map((e) => e.name),
    frame_index: index, masking_applied: !!options.maskingApplied,
    compression: "none", kdf: "none", encryption: "none",
    integrity: "HMAC-SHA256 (public key — tamper detection only)",
    plaintext_size_bytes: zip.length, metadata: options.metadata || {},
  };
  return _packOpen(zip, header);
}

/**
 * Escreve VÁRIAS tabelas num só `.dlk` cifrado (v3 multi-frame) — equivalente a
 * `SecureFile.pack_frames`.
 */
export async function writeDlkEncryptedFrames(tables, keyStr, options = {}) {
  if (!keyStr) throw new Error("writeDlkEncryptedFrames precisa de uma key.");
  const { zip, index } = await _tablesToZipBytes(tables);
  const header = {
    format: "lgs", version: "3.0", format_version: "3.0", content_type: "multi_dataframe",
    label: options.label || "", created_at: new Date().toISOString(), created_by: CREATED_BY,
    n_frames: index.length, frame_names: index.map((e) => e.name), frame_index: index,
    masking_applied: !!options.maskingApplied,
    compression: "none", kdf: "HKDF-SHA256-v2", encryption: "AES256GCM", integrity: "HMAC-SHA256",
    plaintext_size_bytes: zip.length, metadata: options.metadata || {}, expires_at: options.expiresAt || null,
  };
  return _packEncrypted(zip, header, keyStr, 0x03);
}

/** Lê só os metadados (header) de um `.dlk`, sem decifrar o payload — mais
 * rápido, e não precisa da key para arquivos v2/v3 SE só o header em si já
 * responder o que se quer saber (aqui, por simplicidade, ainda pede a key
 * para v2/v3, já que o header vem cifrado nesses formatos). */
export async function inspectDlk(fileBytes, keyStr) {
  const { header } = await readDlk(fileBytes, keyStr, "");
  return header;
}
