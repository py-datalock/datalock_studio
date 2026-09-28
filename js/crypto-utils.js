/**
 * crypto-utils.js
 * ================
 * Reimplementação em JS do hashing determinístico do datalock
 * (datalock/maskers/hashing.py + adapters/polars_adapter.py `_hmac_value`),
 * usando a Web Crypto API nativa do navegador (SubtleCrypto).
 *
 * IMPORTANTE — compatibilidade byte-a-byte com a biblioteca Python:
 *   Token = HMAC-SHA256(salt_utf8, normalizado_utf8).hex()[:16]
 *
 *   Normalização ANTES do HMAC, por tipo de dado (espelha
 *   `_hash_expr_eager` em adapters/polars_adapter.py):
 *     - CPF / CNPJ : trim() + remove tudo que não é dígito (/\D/g)
 *     - E-mail     : trim() + minúsculas
 *     - Genérico   : trim()
 *   Depois, o valor já normalizado passa por Unicode NFC
 *   (`"José".normalize("NFC")`) — igual ao `unicodedata.normalize("NFC", s)`
 *   do Python — antes de virar bytes UTF-8.
 *
 *   Valores nulos/"vazios" (mesmo conjunto do Python:
 *   "", "nan", "none", "null", "na", "n/a", "<na>", case-insensitive)
 *   NÃO são mascarados — viram null, exatamente como no motor real.
 *
 * Dado o MESMO salt, os tokens gerados aqui são idênticos aos gerados por
 * `dd.mask(df, salt=SALT)` no Python — isso permite, por exemplo, cruzar
 * (join) uma tabela mascarada na prévia web com uma mascarada pelo
 * software real, desde que o salt usado seja o mesmo.
 *
 * O que este arquivo NÃO faz (por design — ver RECIPE_SCHEMA.md):
 *   - `strategy: "encrypt"` (AES-SIV reversível) — Web Crypto não tem
 *     AES-SIV nativo, e essa é uma das funções propositalmente restritas
 *     ao software completo (backend Python).
 */

const NULL_STRINGS = new Set(["", "nan", "none", "null", "na", "n/a", "<na>"]);

/** Remove tudo que não é dígito — espelha `str.replace_all(r"\D", "")` do Polars. */
function onlyDigits(s) {
  return s.replace(/\D/g, "");
}

/**
 * Normaliza um valor de acordo com o "tipo assumido" da coluna, replicando
 * exatamente as regras de `_hash_expr_eager` (adapters/polars_adapter.py).
 *
 * @param {*} value
 * @param {"cpf"|"cnpj"|"email"|"generic"} kind
 * @returns {string|null} valor normalizado, ou null se deve ser tratado como nulo
 */
export function normalizeForHash(value, kind = "generic") {
  if (value === null || value === undefined) return null;
  let s = String(value).trim();
  if (NULL_STRINGS.has(s.toLowerCase())) return null;

  if (kind === "cpf" || kind === "cnpj") {
    s = onlyDigits(s);
  } else if (kind === "email") {
    s = s.toLowerCase();
  }
  // "generic" → já está com trim() aplicado, sem mais nada.

  // Unicode NFC — mesmo efeito de unicodedata.normalize("NFC", s) no Python.
  return s.normalize("NFC");
}

/**
 * Converte os valores de uma coluna para o texto que o software completo usa antes de hashear/cifrar.
 * Diferença que importa: o Polars trata uma coluna com QUALQUER valor decimal como Float64 e escreve
 * os inteiros dela como "20.0" (não "20"); o JavaScript não distingue 20 de 20.0. Sem isto, o hash e a
 * criptografia de uma coluna decimal davam tokens diferentes nos dois lados. Colunas só de inteiros
 * ("20") e de texto não mudam.
 */
export function pythonStyleValues(values) {
  let hasFraction = false, allNumeric = true;
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    if (typeof v !== "number") { allNumeric = false; break; }
    if (Number.isFinite(v) && !Number.isInteger(v)) hasFraction = true;
  }
  if (!(allNumeric && hasFraction)) return values;
  return values.map((v) => (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) ? `${v}.0` : v));
}

let _hmacKeyCache = new Map(); // salt -> Promise<CryptoKey> (evita re-importar a chave a cada valor)

async function _getHmacKey(salt) {
  if (_hmacKeyCache.has(salt)) return _hmacKeyCache.get(salt);
  const keyPromise = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  _hmacKeyCache.set(salt, keyPromise);
  return keyPromise;
}

/** Limpa o cache de chaves HMAC — chame ao trocar de salt/sessão por segurança. */
export function clearHmacKeyCache() {
  _hmacKeyCache = new Map();
}

function _bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * HMAC-SHA256 de um valor escalar já normalizado — trunca para 16 hex chars,
 * exatamente como `DeterministicHasher.hash_value` / `_hmac_value` no Python.
 *
 * @param {string} salt        Salt em texto puro (mínimo 16 bytes recomendado).
 * @param {string|null} normalized  Valor já normalizado por normalizeForHash().
 * @returns {Promise<string|null>}
 */
export async function hmacToken(salt, normalized) {
  if (normalized === null) return null;
  const key = await _getHmacKey(salt);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(normalized)
  );
  return _bufferToHex(signature).slice(0, 16);
}

/**
 * Hasheia uma coluna inteira (array de valores) com deduplicação — mesma
 * otimização do motor Python (computa HMAC só para valores únicos).
 *
 * @param {Array} values
 * @param {string} salt
 * @param {"cpf"|"cnpj"|"email"|"generic"} kind
 * @returns {Promise<Array<string|null>>}
 */
export async function hashColumn(values, salt, kind = "generic") {
  const normalizedValues = pythonStyleValues(values).map((v) => normalizeForHash(v, kind));
  const uniqueNormalized = [...new Set(normalizedValues.filter((v) => v !== null))];
  const tokenMap = new Map();
  for (const nv of uniqueNormalized) {
    tokenMap.set(nv, await hmacToken(salt, nv));
  }
  return normalizedValues.map((nv) => (nv === null ? null : tokenMap.get(nv)));
}

/**
 * Valida a força do salt com as MESMAS regras de `_validate_salt` (Python) —
 * mínimo 16 bytes, evita reaproveitar padrões óbvios. Retorna avisos (não
 * bloqueia), espelhando o comportamento de warnings.warn() do Python.
 *
 * @param {string} salt
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateSaltStrength(salt) {
  const errors = [];
  const warnings = [];
  const bytesLength = new TextEncoder().encode(salt || "").length;

  if (bytesLength < 16) {
    errors.push(
      `Salt muito curto (${bytesLength} bytes — mínimo: 16). CPFs têm ~1 bilhão de ` +
      `combinações válidas; GPUs modernas testam bilhões de hashes por segundo.`
    );
  }

  // Um salt puramente hexadecimal (o formato de generateSalt()/dd.generate_salt())
  // é, por natureza, alta entropia — mesmo que contenha por coincidência uma
  // substring como "123"/"abc" ou algo parecido com um ano, isso não indica
  // nada sobre como o salt foi escolhido (não foi "escolhido", foi sorteado).
  // As checagens de padrão abaixo existem para pegar salt ESCOLHIDO por uma
  // pessoa (tipo "minhaSenha123") — aplicá-las a hex aleatório só gera falso
  // positivo. Ex.: ~19% dos salts de generateSalt() eram sinalizados antes
  // dessa checagem existir, mesmo sendo criptograficamente excelentes.
  const isPureHex = /^[0-9a-f]+$/i.test(salt || "") && bytesLength >= 32;

  if (!isPureHex) {
    const weakPatterns = [
      "test", "teste", "exemplo", "example", "salt", "senha", "password",
      "chave", "key", "dev", "debug", "lgpd", "framework",
      "demo", "local", "staging", "homolog", "producao", "production",
    ];
    const lower = (salt || "").toLowerCase();
    if (weakPatterns.some((p) => lower.includes(p))) {
      warnings.push("Salt contém uma palavra comum/previsível — prefira gerar um salt aleatório.");
    }
    if (/(19|20)\d{2}/.test(salt || "")) {
      warnings.push("Salt contém um ano — reduz o espaço de busca de um ataque de força bruta.");
    }
  }

  const uniqueChars = new Set((salt || "").split("")).size;
  if (uniqueChars < 6) {
    warnings.push("Salt com pouca diversidade de caracteres.");
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Gera um salt aleatório forte (equivalente a dd.generate_salt()). */
export function generateSalt(nBytes = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(nBytes));
  return _bufferToHex(bytes.buffer);
}

// ─────────────────────────────────────────────────────────────────────────
// Criptografia reversível (mascaramento "encrypt") — COMPATÍVEL DE VERDADE
// com o software completo, não uma aproximação
// ─────────────────────────────────────────────────────────────────────────
//
// `strategy="encrypt"` no software completo usa AES-SIV (RFC 5297) — ver
// `datalock/maskers/reversible.py`, cujo código-fonte foi compartilhado
// para viabilizar esta implementação. A princípio, "reimplementar AES-SIV
// em JS" pareceria arriscado demais para uma prévia — mas `@noble/ciphers`
// já traz uma implementação de AES-SIV própria, auditada e amplamente
// usada, então não é uma reimplementação nossa: é usar uma biblioteca
// preparada para isso, iguzalzinho ao Python usar `cryptography`.
//
// Testado byte-a-byte contra tokens reais gerados pela biblioteca Python
// (mesma chave derivada via HKDF, mesmo AAD por coluna, mesmo AES-SIV) —
// um valor cifrado pelo software completo reverte na prévia, e vice-versa.
// Isso é diferente do que a versão anterior desta prévia fazia (um esquema
// próprio, incompatível de propósito) — aqui é o MESMO formato.

const _SIV_HKDF_INFO = "datalock-reversible-mask-v1"; // igual ao Python
const _SIV_TOKEN_PREFIX = "enc:"; // igual ao Python — marca visual, diferencia de hash

let _sivKeyCache = new Map(); // salt -> Promise<Uint8Array> (64 bytes)

async function _deriveSivKey(salt) {
  if (_sivKeyCache.has(salt)) return _sivKeyCache.get(salt);
  const keyPromise = (async () => {
    const ikm = new TextEncoder().encode(salt);
    const info = new TextEncoder().encode(_SIV_HKDF_INFO);
    const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    // salt="" (vazio) de propósito — o Python usa HKDF(salt=None, ...), que
    // por definição do RFC 5869 equivale a um salt vazio/zerado; testado e
    // confirmado que produz a MESMA chave que o Python deriva.
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info }, baseKey, 64 * 8
    );
    return new Uint8Array(bits);
  })();
  _sivKeyCache.set(salt, keyPromise);
  return keyPromise;
}

/** Limpa o cache de chaves AES-SIV — chame ao trocar de salt/sessão por segurança. */
export function clearSivKeyCache() {
  _sivKeyCache = new Map();
}

let _aessivFn = null;
async function _loadAesSiv() {
  if (!_aessivFn) {
    // AES-SIV (RFC 5297, `aessiv`) só existe a partir da 2.x do @noble/ciphers — na 1.x o aes.js exporta
    // apenas `siv`/`gcmsiv`, e `aessiv` vinha `undefined` ("aessiv is not a function"), quebrando a
    // criptografia reversível. Por isso este import é @2 e o do ChaCha (dlk.js) segue @1.
    const mod = await import("https://cdn.jsdelivr.net/npm/@noble/ciphers@2.4.0/aes.js/+esm");
    _aessivFn = mod.aessiv;
  }
  return _aessivFn;
}

function _b64urlEncode(bytes) {
  let binary = "";
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_"); // sem strip de '=' — igual ao Python
}
function _b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const _SIV_NULL_STRINGS = new Set(["", "nan", "none", "null", "na", "n/a", "<na>"]);
function _isSivNull(value) {
  if (value === null || value === undefined) return true;
  return _SIV_NULL_STRINGS.has(String(value).trim().toLowerCase());
}

/**
 * Cifra um valor com AES-SIV — mesmo formato do software completo
 * (`dd.mask(strategy="encrypt")`). Determinístico: mesmo valor + mesmo
 * salt + mesmo AAD (coluna) → sempre o mesmo token, preservando joins.
 * @param {string} salt
 * @param {*} plainValue
 * @param {string|null} associatedData  Normalmente o nome da coluna — usa
 *   o MESMO valor ao cifrar e ao reverter, senão a autenticação falha.
 */
export async function encryptSivValue(salt, plainValue, associatedData = null) {
  if (_isSivNull(plainValue)) return null;
  const key = await _deriveSivKey(salt);
  const aessiv = await _loadAesSiv();
  const normalized = String(plainValue).trim().normalize("NFC");
  const plaintext = new TextEncoder().encode(normalized);
  const aad = associatedData ? [new TextEncoder().encode(associatedData)] : [];
  const ct = aessiv(key, ...aad).encrypt(plaintext);
  return _SIV_TOKEN_PREFIX + _b64urlEncode(ct);
}

/** Reverte um valor gerado por encryptSivValue() (ou pelo software completo,
 * com o mesmo salt e associatedData). */
export async function decryptSivValue(salt, token, associatedData = null) {
  if (token === null || token === undefined || token === "") return null;
  const s = String(token).trim();
  if (_SIV_NULL_STRINGS.has(s.toLowerCase())) return null;
  if (!s.startsWith(_SIV_TOKEN_PREFIX)) {
    throw new Error(
      `Este valor não tem o prefixo esperado ("${_SIV_TOKEN_PREFIX}") — não parece ter sido ` +
      `cifrado com "Criptografia reversível" (é, por exemplo, um hash HMAC, que é irreversível por design)."`
    );
  }
  const raw = _b64urlDecode(s.slice(_SIV_TOKEN_PREFIX.length));
  const key = await _deriveSivKey(salt);
  const aessiv = await _loadAesSiv();
  const aad = associatedData ? [new TextEncoder().encode(associatedData)] : [];
  try {
    const pt = aessiv(key, ...aad).decrypt(raw);
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error(
      "Não foi possível reverter — o salt está errado, a coluna não é a mesma usada para " +
      "mascarar, ou o valor foi corrompido/adulterado."
    );
  }
}

/** Cifra uma coluna inteira. `columnName` vira o AAD (igual ao software completo). */
export async function encryptSivColumn(values, salt, columnName) {
  const out = [];
  for (const v of pythonStyleValues(values)) out.push(await encryptSivValue(salt, v, columnName));
  return out;
}

/** Reverte uma coluna inteira cifrada por encryptSivColumn(). */
export async function decryptSivColumn(values, salt, columnName) {
  const out = [];
  for (const v of values) out.push(await decryptSivValue(salt, v, columnName));
  return out;
}
