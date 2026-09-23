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
  const normalizedValues = values.map((v) => normalizeForHash(v, kind));
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
