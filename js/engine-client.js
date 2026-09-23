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
    case "pii_scan":
      // Informativo — não transforma a tabela, só anexa o relatório no trace via exceção controlada
      return table;
    case "mask": {
      if (!context.salt && step.strategy === "hash") {
        throw new Error("Esta receita usa mask(strategy='hash') mas nenhum salt foi informado para esta execução.");
      }
      return DF.maskColumns(table, {
        columns: step.columns,
        strategy: step.strategy,
        salt: context.salt,
        rowsConditions: step.rows ? step.rows.conditions : null,
        rowsLogic: step.rows ? (step.rows.logic || "and") : "and",
        piiKindByColumn: step.piiKindByColumn || {},
      });
    }
    case "unmask":
      throw new Error(
        "'unmask' (reversão de strategy=encrypt) só está disponível no software completo — " +
        "veja RECIPE_SCHEMA.md. Exporte esta receita e rode no backend Python."
      );
    case "export":
      // Tratado fora do runRecipe (ver app.js exportTable) — aqui é um no-op
      return table;
    default:
      throw new Error(`Tipo de step desconhecido: "${step.type}"`);
  }
}

/** dd.scan(df) simplificado — usado pelo step informativo pii_scan e pela aba "Privacidade". */
export function scanForPii(table) {
  return scanTable(table);
}

export const engineInfo = {
  kind: "client",
  label: "Prévia (roda no seu navegador)",
  supportsEncrypt: false,
  supportsDlk: false,
  supportsDb: false,
};
