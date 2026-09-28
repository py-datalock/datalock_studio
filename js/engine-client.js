/**
 * engine-client.js
 * ================
 * Executa uma "receita" (RECIPE_SCHEMA.md) inteiramente no navegador,
 * usando dataframe.js. Esta é a engine usada na prévia web (GitHub Pages).
 *
 * Interface comum com engine-server.js (ver engine.js) — o app.js não
 * precisa saber qual das duas está rodando.
 */

import * as DF from "./dataframe.js";
import { scanTable } from "./pii-detect.js";
import * as Audit from "./audit-trail.js";
import { evaluateRisk as _evaluateRisk } from "./risk-score.js";

/**
 * Roda uma lista de steps (habilitados) sobre uma tabela inicial,
 * retornando o resultado final e um "trace" por step (linhas antes/depois,
 * erros) — útil pra UI mostrar o efeito de cada passo.
 *
 * @param {{columns: string[], rows: object[]}} sourceTable
 * @param {Array} steps
 * @param {{salt?: string}} context
 */
export async function runRecipe(sourceTable, steps, context = {}) {
  let table = { columns: [...sourceTable.columns], rows: [...sourceTable.rows] };
  const trace = [];

  for (const step of steps) {
    if (step.enabled === false) {
      trace.push({ id: step.id, type: step.type, skipped: true });
      continue;
    }
    const before = table.rows.length;
    try {
      table = await applyStep(table, step, context);
      trace.push({ id: step.id, type: step.type, rowsBefore: before, rowsAfter: table.rows.length, ok: true });
    } catch (err) {
      trace.push({ id: step.id, type: step.type, ok: false, error: err.message });
      throw Object.assign(new Error(`Erro no step "${step.type}" (${step.id}): ${err.message}`), { trace });
    }
  }
  return { table, trace };
}

async function applyStep(table, step, context) {
  switch (step.type) {
    case "select_columns": return DF.selectColumns(table, step.columns);
    case "drop_columns": return DF.dropColumns(table, step.columns);
    case "rename": return DF.renameColumns(table, step.mapping);
    case "filter": return DF.filterRows(table, step.conditions, step.logic || "and");
    case "sort": return DF.sortRows(table, step.by, step.descending);
    case "dedupe": return DF.dedupe(table, step.subset);
    case "cast": return DF.castColumn(table, step.column, step.to);
    case "fill_null": return DF.fillNull(table, step.column, step.value);
    case "derive_column": return DF.deriveColumn(table, step.new_column, step.expression);
    case "split_column": return DF.splitColumn(table, step.column, step.delimiter, step.into);
    case "merge_columns": return DF.mergeColumns(table, step.columns, step.separator, step.into);
    case "groupby": return DF.groupBy(table, step.by, step.aggregations);
    case "pivot": return DF.pivot(table, step.on, step.index, step.values, step.agg_fn);
    case "value_counts": return DF.valueCounts(table, step.column, step.normalize, step.n || 20);
    case "corr": return DF.corrMatrix(table);
    case "describe": return DF.describeTable(table);
    case "pii_scan":
      // Informativo — não transforma a tabela, só anexa o relatório no trace via exceção controlada
      return table;
    case "mask": {
      if (!context.salt && (step.strategy === "hash" || step.strategy === "encrypt")) {
        throw new Error(`Esta receita usa mask(strategy='${step.strategy}') mas nenhum salt foi informado para esta execução.`);
      }
      let masked;
      try {
        masked = await DF.maskColumns(table, {
          columns: step.columns,
          strategy: step.strategy,
          salt: context.salt,
          rowsConditions: step.rows ? step.rows.conditions : null,
          rowsLogic: step.rows ? (step.rows.logic || "and") : "and",
          piiKindByColumn: step.piiKindByColumn || {},
        });
      } catch (err) {
        for (const column of step.columns || []) Audit.record({ column, technique: step.strategy, status: "error", stepId: step.id });
        throw err;
      }
      // Trilha de auditoria (só metadados: coluna e técnica, nunca valores).
      for (const column of step.columns || []) Audit.record({ column, technique: step.strategy, stepId: step.id });
      return masked;
    }
    case "unmask": {
      // strategy="encrypt" usa AES-SIV, o MESMO formato do software
      // completo (ver crypto-utils.js) — um valor cifrado lá reverte aqui
      // normalmente, e vice-versa, desde que salt e coluna sejam os mesmos.
      if (!context.salt) {
        throw new Error("'unmask' exige o mesmo salt usado para mascarar.");
      }
      return DF.unmaskColumns(table, step.columns, context.salt);
    }
    case "export":
      // Tratado fora do runRecipe (ver app.js exportTable) — aqui é um no-op
      return table;
    case "synthetic": {
      // Modo "rápido", sem dependências — mesma estratégia usada no
      // software completo quando engine="fast" (ver
      // recipe_engine.py#_synthetic_fast): colunas de PII reconhecidas
      // ganham valores novos e válidos; as demais são reamostradas.
      if (step.engine === "copula") {
        // Cópula gaussiana — mesma abordagem do software completo
        // (recipe_engine.py#_synthetic_copula), ver synthetic-copula.js.
        const { generateCopulaTable } = await import("./synthetic-copula.js");
        return generateCopulaTable(table, scanTable(table), step.n || table.rows.length, step.seed || 42);
      }
      const { generateSyntheticTable } = await import("./synthetic-generator.js");
      const piiReport = scanTable(table);
      const n = step.n || table.rows.length;
      return generateSyntheticTable(table, piiReport, n, step.seed || 42);
    }
    default:
      throw new Error(`Tipo de step desconhecido: "${step.type}"`);
  }
}

/** dd.scan(df) simplificado — usado pelo step informativo pii_scan e pela aba "Privacidade". */
export function scanForPii(table) {
  return scanTable(table);
}

/** EDA automática — ver dataframe.js#autoEda(). */
export function autoEda(table) {
  return DF.autoEda(table);
}

/** Comparação antes/depois — versão simplificada de dd.diff() (ver dataframe.js). */
export function diffTables(before, after) {
  return DF.diffTables(before, after);
}

/** Score composto de risco de reidentificação — porta exata da biblioteca (ver risk-score.js). */
export function evaluateRisk(table, options) {
  return _evaluateRisk(table, options);
}

/** Risco do promotor / registros únicos, exatos por definição (ver dataframe.js). */
export function reidentificationStats(table, quasiIdentifiers) {
  return DF.reidentificationStats(table, quasiIdentifiers);
}

/** k-anonimato simplificado, calculado 100% no navegador (ver dataframe.js). */
export function kAnonymity(table, quasiIdentifiers) {
  return DF.kAnonymity(table, quasiIdentifiers);
}

export const engineInfo = {
  kind: "client",
  label: "Prévia (roda no seu navegador)",
  supportsEncrypt: true,   // AES-SIV, compatível de verdade com o software completo (ver crypto-utils.js)
  supportsDlk: true,       // leitura de qualquer versão; escrita v4 (aberto) e v2 (cifrado, AES-256-GCM) — ver dlk.js
  supportsDb: true,        // só SQLite (arquivo aberto em memória, via sql.js) — ver sqlite-db.js
  supportsDiff: true,
  supportsKAnonymity: true,
};
