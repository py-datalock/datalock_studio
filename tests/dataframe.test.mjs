// Testes sem dependências:  node --test web/tests/     (Node 20+)
// Os valores esperados de mascaramento vêm da biblioteca datalock real (caminho Polars).
import test from "node:test";
import assert from "node:assert/strict";
import { needsTextColumn, maskColumns, inferWriteKind } from "../js/dataframe.js";
import { nameHintType, suggestPiiType } from "../js/pii-detect.js";
import { evaluateRisk } from "../js/risk-score.js";

const SALT = "salt-de-teste-longo-1234567890";
const mask = async (col, strategy, values) => {
  const t = { columns: [col], rows: values.map((v) => ({ [col]: v })) };
  return (await maskColumns(t, { columns: [col], strategy, salt: SALT })).rows.map((r) => r[col]);
};

test("zeros à esquerda: coluna vira texto", () => {
  assert.equal(needsTextColumn(["01310100", "02020202"]), true);
  assert.equal(needsTextColumn(["007", "12"]), true);
  assert.equal(needsTextColumn(["4111111111111111"]), true);
  assert.equal(needsTextColumn(["10", "0.5", "-3", "0", ""]), false);
});

test("gravação: texto que parece número continua texto", () => {
  assert.equal(inferWriteKind(["00", "02", "98"]), "string");
  assert.equal(inferWriteKind([1, 2.5, null]), "number");
  assert.equal(inferWriteKind([true, false]), "boolean");
});

test("estratégias simples idênticas à biblioteca", async () => {
  assert.deepEqual(await mask("c", "truncate", ["012.345.678-90", "José Ção", "123"]), ["01234-XXX", "José Ção", "123"]);
  assert.deepEqual(await mask("t", "mask_phone_ddd", ["(11) 91234-5678", "12345"]), ["(11) XXXXX-XXXX", "XXXXX-XXXX"]);
  assert.deepEqual(await mask("d", "generalize_date", ["1990-05-17", "17/05/1985", "abc", null]), ["1990-1999", "1980-1989", "DATA_REDACTED", null]);
  assert.deepEqual(await mask("n", "redact", ["a", null]), ["REDACTED", null]);
});

test("hash: CPF/e-mail normalizados como na biblioteca; decimais como '20.0'", async () => {
  const [a, b] = await mask("cpf", "hash", ["123.456.789-09", "12345678909"]);
  assert.equal(a, b);
  const [e1, e2] = await mask("email", "hash", ["Ana@Teste.com ", "ana@teste.com"]);
  assert.equal(e1, e2);
  const dec = await mask("valor", "hash", [20, 10.5]);
  const [asText] = await mask("valor", "hash", ["20.0"]);
  assert.equal(dec[0], asText);
});

test("detecção de PII por palavra inteira", () => {
  for (const n of ["tipo", "margem", "hotel", "company", "organizacao", "id_cliente", "data_pedido"]) {
    assert.equal(nameHintType(n), null, n);
  }
  assert.equal(nameHintType("nome_cliente"), "nome");
  assert.equal(nameHintType("dt_nasc"), "date");
  assert.equal(suggestPiiType("nome", ["Ana", "Bia"]).type, "nome");
  assert.equal(suggestPiiType("tipo", ["a", "b"]), null);
});

test("score de risco: caso simples conferido com a biblioteca", () => {
  const rows = ["M", "M", "F", "F", "F"].map((sexo) => ({ sexo }));
  const r = evaluateRisk({ columns: ["sexo"], rows }, { quasi_identifiers: ["sexo"] });
  // valores obtidos rodando ReidentificationRiskScorer da biblioteca sobre estes mesmos dados
  assert.equal(r.risk_score, 0.26);
  assert.equal(r.risk_level, "low");
  assert.equal(r.anpd_compliant, false);
  assert.equal(r.compliant_reason, "k=2 (mín. 5) ou risk_score=0.260 ≥ 0.4");
});
