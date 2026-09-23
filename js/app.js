/**
 * app.js
 * ======
 * datalock Studio — Copyright © 2026 [SEU NOME/EMPRESA]. Todos os
 * direitos reservados. Software proprietário — ver LICENSE na raiz
 * deste repositório.
 *
 * Aplicação Vue 3 (sem build step — Vue global via CDN) que liga a UI
 * definida em index.html ao motor de dados (engine.js).
 *
 * Estado por ABA (uma por tabela carregada): colunas, prévia, passos,
 * erro e relatório de PII ficam dentro de cada objeto de `tabs`. Estado
 * global (não por aba): salt, chave, e os modais.
 */

import { engine } from "./engine.js";
import * as FileIO from "./file-io.js";
import { generateSalt as genSalt, validateSaltStrength } from "./crypto-utils.js";
import { icon as iconFn } from "./icons.js";

const { createApp, ref, reactive, computed, onMounted } = Vue;

let uid = 1;
const newId = () => `s${uid++}`;
let tabUid = 1;
const newTabId = () => `tab${tabUid++}`;

const STEP_TYPES = [
  { type: "select_columns", icon: "columns", name: "Selecionar colunas", desc: "Mantém só as colunas escolhidas" },
  { type: "drop_columns", icon: "columns-x", name: "Remover colunas", desc: "Descarta as colunas escolhidas" },
  { type: "rename", icon: "edit", name: "Renomear colunas", desc: "Muda o nome de uma ou mais colunas" },
  { type: "filter", icon: "filter", name: "Filtrar linhas", desc: "Mantém só linhas que atendem a uma condição" },
  { type: "sort", icon: "arrow-updown", name: "Ordenar", desc: "Ordena as linhas por uma coluna" },
  { type: "dedupe", icon: "layers", name: "Remover duplicadas", desc: "Remove linhas repetidas" },
  { type: "cast", icon: "repeat", name: "Converter tipo", desc: "Muda o tipo de dado de uma coluna" },
  { type: "fill_null", icon: "droplet", name: "Preencher vazios", desc: "Substitui valores vazios por um valor fixo" },
  { type: "derive_column", icon: "plus-circle", name: "Criar coluna calculada", desc: "Cria uma coluna nova a partir de outras" },
  { type: "split_column", icon: "scissors", name: "Dividir coluna", desc: "Separa uma coluna em várias, por um delimitador" },
  { type: "merge_columns", icon: "link", name: "Unir colunas", desc: "Junta várias colunas em uma só" },
  { type: "groupby", icon: "bar-chart", name: "Agrupar e agregar", desc: "Agrupa linhas e calcula somas/médias/contagens" },
  { type: "pivot", icon: "grid", name: "Tabela dinâmica (pivot)", desc: "Transforma valores de uma coluna em novas colunas" },
  { type: "mask", icon: "shield", name: "Mascarar / anonimizar", desc: "Aplica uma técnica de anonimização a uma coluna" },
];

function defaultStepFor(type) {
  const base = { id: newId(), type, enabled: true };
  switch (type) {
    case "select_columns": return { ...base, columns: [] };
    case "drop_columns": return { ...base, columns: [] };
    case "rename": return { ...base, mapping: {} };
    case "filter": return { ...base, logic: "and", conditions: [] };
    case "sort": return { ...base, by: null, descending: false };
    case "dedupe": return { ...base, subset: [] };
    case "cast": return { ...base, column: null, to: "string" };
    case "fill_null": return { ...base, column: null, value: "" };
    case "derive_column": return { ...base, new_column: "", expression: { kind: "arithmetic", leftIsColumn: true, left: null, op: "+", rightIsColumn: false, right: 0 } };
    case "split_column": return { ...base, column: null, delimiter: ",", into: [] };
    case "merge_columns": return { ...base, columns: [], separator: " ", into: "" };
    case "groupby": return { ...base, by: [], aggregations: [] };
    case "pivot": return { ...base, index: null, on: null, values: null, agg_fn: "sum" };
    case "mask": return { ...base, columns: [], strategy: "hash", rows: null, piiKindByColumn: {} };
    default: return base;
  }
}

function newTab(name, { tableId, columns, previewRows, totalRows }) {
  return reactive({
    id: newTabId(), tableId, name,
    columns, previewRows, totalRows,
    steps: [], running: false, errorMessage: "", piiReport: {},
  });
}

createApp({
  setup() {
    const engineMode = ref("client");
    const tabs = reactive([]);
    const activeTabId = ref(null);
    const activeTab = computed(() => tabs.find((t) => t.id === activeTabId.value) || null);

    // ── Tema (claro/escuro) ──────────────────────────────────────────────
    const theme = ref(localStorage.getItem("dl_theme") || "auto");
    function applyTheme() {
      if (theme.value === "auto") document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", theme.value);
    }
    function toggleTheme() {
      const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const currentlyDark = theme.value === "dark" || (theme.value === "auto" && systemPrefersDark);
      theme.value = currentlyDark ? "light" : "dark";
      localStorage.setItem("dl_theme", theme.value);
      applyTheme();
    }
    const isDarkNow = computed(() => {
      if (theme.value === "dark") return true;
      if (theme.value === "light") return false;
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    });
    applyTheme();

    function icon(name, opts) { return iconFn(name, opts); }

    const salt = ref("");
    const saltVisible = ref(false);
    const dlkKey = ref("");
    const dlkKeyVisible = ref(false);

    const showStepPicker = ref(false);
    const stepSearchQuery = ref("");
    const filteredStepTypes = computed(() => {
      const q = stepSearchQuery.value.trim().toLowerCase();
      if (!q) return STEP_TYPES;
      return STEP_TYPES.filter(
        (t) => t.name.toLowerCase().includes(q) || t.desc.toLowerCase().includes(q)
      );
    });
    const draftStep = ref(null);
    const editingIndex = ref(null);
    const showPiiPanel = ref(false);
    const showUnmaskPanel = ref(false);
    const unmaskColumns = ref([]);
    const unmaskError = ref("");
    const showExportPanel = ref(false);
    const showAbout = ref(false);
    const exportFormat = ref("csv");
    const exportFilename = ref("resultado");

    // ── Banco de dados ───────────────────────────────────────────────────
    const showDbPanel = ref(false);
    const dbUri = ref("");
    const dbUriVisible = ref(false);
    const dbConnectionId = ref(null);
    const dbConnecting = ref(false);
    const dbConnectError = ref("");
    const dbTablesList = ref([]);
    const dbSqlQuery = ref("");
    const dbReadError = ref("");
    const dbWriteTableName = ref("");
    const dbWriteMode = ref("append");
    const dbUpsertColumns = ref([]);
    const dbWriteError = ref("");
    const dbWriteSuccess = ref("");

    function openDbPanel() {
      dbConnectError.value = ""; dbReadError.value = ""; dbWriteError.value = ""; dbWriteSuccess.value = "";
      showDbPanel.value = true;
    }

    async function connectDb() {
      dbConnectError.value = "";
      dbConnecting.value = true;
      try {
        const res = await engine.dbConnect(dbUri.value);
        dbConnectionId.value = res.connection_id;
        const tablesRes = await engine.dbTables(dbConnectionId.value);
        dbTablesList.value = tablesRes.tables || [];
      } catch (err) {
        dbConnectError.value = err.message || String(err);
      } finally {
        dbConnecting.value = false;
      }
    }

    function disconnectDb() {
      dbConnectionId.value = null;
      dbTablesList.value = [];
      dbUri.value = "";
    }

    async function openDbTableAsTab(tableName) {
      dbReadError.value = "";
      try {
        const res = await engine.dbOpenAsTable(dbConnectionId.value, tableName);
        addTabFromResult(res);
        showDbPanel.value = false;
      } catch (err) {
        dbReadError.value = err.message || String(err);
      }
    }

    async function runDbSqlAsTab() {
      dbReadError.value = "";
      if (!dbSqlQuery.value.trim()) { dbReadError.value = "Escreva uma consulta SQL."; return; }
      try {
        const res = await engine.dbOpenAsTable(dbConnectionId.value, dbSqlQuery.value, "consulta_sql");
        addTabFromResult(res);
        showDbPanel.value = false;
      } catch (err) {
        dbReadError.value = err.message || String(err);
      }
    }

    async function sendActiveTabToDb() {
      dbWriteError.value = ""; dbWriteSuccess.value = "";
      const tab = activeTab.value;
      if (!tab) return;
      if (!dbWriteTableName.value.trim()) { dbWriteError.value = "Informe o nome da tabela de destino."; return; }
      if (dbWriteMode.value === "upsert" && !dbUpsertColumns.value.length) {
        dbWriteError.value = "Escolha ao menos uma coluna-chave para o upsert.";
        return;
      }
      try {
        const info = await engine.dbWriteTable(
          tab.tableId, JSON.parse(JSON.stringify(tab.steps)), salt.value || null,
          dbConnectionId.value, dbWriteTableName.value.trim(), dbWriteMode.value,
          dbWriteMode.value === "upsert" ? dbUpsertColumns.value : null
        );
        dbWriteSuccess.value = `Enviado para "${info.table}" (${info.rows ?? "?"} linhas).`;
      } catch (err) {
        dbWriteError.value = err.message || String(err);
      }
    }

    // ── Automações (jobs) ────────────────────────────────────────────────
    const showJobsPanel = ref(false);
    const jobsList = ref([]);
    const jobsLoading = ref(false);
    const jobsListError = ref("");
    const jobFormOpen = ref(false);
    const editingJobId = ref(null);
    const jobDraft = ref(null);
    const jobStepsJsonText = ref("[]");
    const jobFormError = ref("");
    const jobUpsertOnText = computed({
      get: () => (jobDraft.value?.destination.upsert_on || []).join(", "),
      set: (v) => { jobDraft.value.destination.upsert_on = v.split(",").map((s) => s.trim()).filter(Boolean); },
    });
    const jobRunsFor = ref(null);
    const jobRunsList = ref([]);

    function newJobDraft() {
      return {
        name: "", enabled: true,
        source: { kind: "folder", path: "", pattern: "*.csv", after: "leave", move_to: "", db_uri_secret: "", table_or_sql: "" },
        destination: { kind: "folder", path: "", format: "csv", filename_template: "{source_name}_{timestamp}", db_uri_secret: "", table: "", mode: "append", upsert_on: [] },
        trigger: { kind: "manual", interval_seconds: 300 },
        secrets: { salt: "", key: "" },
      };
    }

    async function refreshJobs() {
      jobsLoading.value = true;
      jobsListError.value = "";
      try {
        jobsList.value = await engine.listJobs();
      } catch (err) {
        jobsListError.value = err.message || String(err);
      } finally {
        jobsLoading.value = false;
      }
    }

    async function openJobsPanel() {
      showJobsPanel.value = true;
      await refreshJobs();
    }

    function startNewJob() {
      jobDraft.value = newJobDraft();
      jobStepsJsonText.value = "[]";
      editingJobId.value = null;
      jobFormError.value = "";
      jobFormOpen.value = true;
    }

    function editJob(job) {
      jobDraft.value = {
        name: job.name, enabled: job.enabled,
        source: { ...job.source }, destination: { ...job.destination },
        trigger: { ...job.trigger }, secrets: { salt: job.secrets?.salt || "", key: job.secrets?.key || "" },
      };
      jobStepsJsonText.value = JSON.stringify(job.steps || [], null, 2);
      editingJobId.value = job.id;
      jobFormError.value = "";
      jobFormOpen.value = true;
    }

    function useActiveTabStepsInJob() {
      if (!activeTab.value) return;
      jobStepsJsonText.value = JSON.stringify(activeTab.value.steps, null, 2);
    }

    function cancelJobForm() { jobFormOpen.value = false; jobDraft.value = null; }

    async function saveJob() {
      jobFormError.value = "";
      let steps;
      try {
        steps = JSON.parse(jobStepsJsonText.value || "[]");
        if (!Array.isArray(steps)) throw new Error("precisa ser uma lista de passos");
      } catch (err) {
        jobFormError.value = `Passos (JSON) inválido: ${err.message}`;
        return;
      }
      if (!jobDraft.value.name.trim()) { jobFormError.value = "Dê um nome para a automação."; return; }

      const secrets = {};
      if (jobDraft.value.secrets.salt) secrets.salt = jobDraft.value.secrets.salt;
      if (jobDraft.value.secrets.key) secrets.key = jobDraft.value.secrets.key;

      const payload = {
        name: jobDraft.value.name, enabled: jobDraft.value.enabled,
        source: jobDraft.value.source, steps, destination: jobDraft.value.destination,
        trigger: jobDraft.value.trigger, secrets,
      };
      try {
        if (editingJobId.value) await engine.updateJob(editingJobId.value, payload);
        else await engine.createJob(payload);
        jobFormOpen.value = false;
        jobDraft.value = null;
        await refreshJobs();
      } catch (err) {
        jobFormError.value = err.message || String(err);
      }
    }

    async function deleteJobConfirm(job) {
      if (!confirm(`Remover a automação "${job.name}"? Isso não desfaz execuções já feitas.`)) return;
      await engine.deleteJob(job.id);
      await refreshJobs();
    }

    async function toggleJobEnabled(job) {
      await engine.setJobEnabled(job.id, !job.enabled);
      await refreshJobs();
    }

    async function runJobNowClick(job) {
      jobsListError.value = "";
      try {
        await engine.runJobNow(job.id);
        await refreshJobs();
        await viewJobRuns(job);
      } catch (err) {
        jobsListError.value = `Falha ao rodar "${job.name}": ${err.message}`;
      }
    }

    async function viewJobRuns(job) {
      jobRunsFor.value = job.id;
      jobRunsList.value = await engine.jobRuns(job.id);
    }

    function closeJobRuns() { jobRunsFor.value = null; jobRunsList.value = []; }

    function formatTimestamp(unixSeconds) {
      if (!unixSeconds) return "—";
      return new Date(unixSeconds * 1000).toLocaleString("pt-BR");
    }

    // ── Fluxo de "arquivo pede chave": tentamos abrir; se o backend disser
    // que está criptografado, guardamos o arquivo e pedimos a chave.
    const pendingEncryptedFile = ref(null);
    const showKeyPrompt = ref(false);
    const keyPromptValue = ref("");
    const keyPromptVisible = ref(false);
    const keyPromptError = ref("");

    let dragIndex = null;

    onMounted(async () => {
      engineMode.value = await engine.detect();
    });

    // ── Carregar arquivo ────────────────────────────────────────────────
    function addTabFromResult(res) {
      const tab = newTab(res.name, res);
      tabs.push(tab);
      activeTabId.value = tab.id;
      refreshPiiReport(tab);
      return tab;
    }

    async function loadFile(file, opts = {}) {
      try {
        const results = await engine.loadFile(file, opts);
        for (const res of results) addTabFromResult(res);
        pendingEncryptedFile.value = null;
        showKeyPrompt.value = false;
        keyPromptValue.value = "";
        keyPromptError.value = "";
      } catch (err) {
        const msg = err.message || String(err);
        if (/chave \(key\)/i.test(msg) || /criptografad/i.test(msg)) {
          pendingEncryptedFile.value = file;
          showKeyPrompt.value = true;
          keyPromptError.value = "";
          return;
        }
        // Sem aba ativa ainda (primeiro arquivo) → mostra no prompt de chave
        // ou num alerta simples, já que não há onde renderizar na grade.
        if (!tabs.length) {
          keyPromptError.value = "";
          alert(`Não foi possível abrir o arquivo: ${msg}`);
        } else {
          activeTab.value.errorMessage = msg;
        }
      }
    }
    function onFilePicked(e) { if (e.target.files[0]) loadFile(e.target.files[0]); }
    function onDrop(e) { if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); }
    const isDraggingOver = ref(false);

    async function confirmKeyPrompt() {
      keyPromptError.value = "";
      try {
        await loadFile(pendingEncryptedFile.value, { key: keyPromptValue.value });
      } catch (err) {
        keyPromptError.value = err.message || String(err);
      }
    }
    function cancelKeyPrompt() {
      showKeyPrompt.value = false;
      pendingEncryptedFile.value = null;
      keyPromptValue.value = "";
    }

    function reset() {
      tabs.splice(0, tabs.length);
      activeTabId.value = null;
    }

    function closeTab(tabId) {
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return;
      engine.closeTable(tabs[idx].tableId);
      tabs.splice(idx, 1);
      if (activeTabId.value === tabId) {
        activeTabId.value = tabs.length ? tabs[Math.max(0, idx - 1)].id : null;
      }
    }
    function selectTab(tabId) { activeTabId.value = tabId; }

    // ── Rodar pipeline (na aba ativa) ───────────────────────────────────
    async function runPipeline() {
      const tab = activeTab.value;
      if (!tab) return;
      tab.running = true;
      tab.errorMessage = "";
      try {
        const res = await engine.run(tab.tableId, JSON.parse(JSON.stringify(tab.steps)), { salt: salt.value || null });
        tab.columns = res.columns;
        tab.previewRows = res.previewRows;
        tab.totalRows = res.totalRows;
        await refreshPiiReport(tab);
      } catch (err) {
        tab.errorMessage = err.message || String(err);
      } finally {
        tab.running = false;
      }
    }

    async function refreshPiiReport(tab) {
      try {
        const report = await engine.scanPii(tab.tableId);
        const flat = report.report || report;
        Object.keys(tab.piiReport).forEach((k) => delete tab.piiReport[k]);
        Object.assign(tab.piiReport, flat);
      } catch { /* painel de PII é auxiliar — falha aqui não deve travar a tela */ }
    }

    // ── Gestão de passos (sempre na aba ativa) ──────────────────────────
    function openStepPicker() { stepSearchQuery.value = ""; showStepPicker.value = true; }
    function startNewStep(type) {
      showStepPicker.value = false;
      draftStep.value = defaultStepFor(type);
      editingIndex.value = null;
    }
    function editStep(idx) {
      draftStep.value = JSON.parse(JSON.stringify(activeTab.value.steps[idx]));
      editingIndex.value = idx;
    }
    function cancelStepEdit() { draftStep.value = null; editingIndex.value = null; }

    async function confirmStep() {
      const tab = activeTab.value;
      if (editingIndex.value === null) tab.steps.push(draftStep.value);
      else tab.steps.splice(editingIndex.value, 1, draftStep.value);
      draftStep.value = null;
      editingIndex.value = null;
      await runPipeline();
    }

    async function removeStep(idx) { activeTab.value.steps.splice(idx, 1); await runPipeline(); }
    async function toggleStep(idx) {
      const step = activeTab.value.steps[idx];
      step.enabled = step.enabled === false ? true : false;
      await runPipeline();
    }

    function dragStart(idx) { dragIndex = idx; }
    async function dropOn(idx) {
      if (dragIndex === null || dragIndex === idx) return;
      const steps = activeTab.value.steps;
      const [moved] = steps.splice(dragIndex, 1);
      steps.splice(idx, 0, moved);
      dragIndex = null;
      await runPipeline();
    }

    function toggleRowsCondition(e) {
      draftStep.value.rows = e.target.checked ? { logic: "and", conditions: [] } : null;
    }

    // ── Rótulos legíveis dos passos ─────────────────────────────────────
    function stepTypeMeta(type) { return STEP_TYPES.find((t) => t.type === type) || { icon: "•", name: type }; }
    function stepLabel(step) { return stepTypeMeta(step.type).name; }
    function stepDescription(step) {
      switch (step.type) {
        case "select_columns": return step.columns.join(", ") || "(nenhuma coluna escolhida)";
        case "drop_columns": return step.columns.join(", ") || "(nenhuma coluna escolhida)";
        case "rename": return Object.entries(step.mapping).filter(([, v]) => v).map(([k, v]) => `${k} → ${v}`).join(", ") || "(sem alterações)";
        case "filter": return step.conditions.map((c) => `${c.column} ${c.op} ${c.value ?? ""}`).join(` ${step.logic === "or" ? "OU" : "E"} `) || "(sem condições)";
        case "sort": return `${step.by || "?"} ${step.descending ? "↓ decrescente" : "↑ crescente"}`;
        case "dedupe": return step.subset.length ? `por ${step.subset.join(", ")}` : "considerando todas as colunas";
        case "cast": return `${step.column || "?"} → ${step.to}`;
        case "fill_null": return `${step.column || "?"} = "${step.value}"`;
        case "derive_column": return step.new_column || "(sem nome)";
        case "split_column": return `${step.column || "?"} por "${step.delimiter}" → ${step.into.join(", ")}`;
        case "merge_columns": return `${step.columns.join(" + ")} → ${step.into}`;
        case "groupby": return `${step.by.join(", ")} · ${step.aggregations.length} agregação(ões)`;
        case "pivot": return `${step.index || "?"} × ${step.on || "?"}`;
        case "mask": return `${step.columns.join(", ") || "(nenhuma)"} — ${step.strategy}${step.rows ? " (algumas linhas)" : ""}`;
        default: return "";
      }
    }

    function formatCell(v) {
      if (v === null || v === undefined) return "";
      if (typeof v === "number") return v.toLocaleString("pt-BR");
      return String(v);
    }

    // ── Salt ─────────────────────────────────────────────────────────────
    function generateSalt() {
      salt.value = genSalt();
      const check = validateSaltStrength(salt.value);
      if (!check.ok && activeTab.value) activeTab.value.errorMessage = check.errors.join(" ");
    }

    // ── Receita (salvar/abrir) — sempre na aba ativa ────────────────────
    function saveRecipe() {
      const tab = activeTab.value;
      const recipe = { version: 1, source: { type: "file", format: "unknown" }, steps: JSON.parse(JSON.stringify(tab.steps)) };
      FileIO.downloadRecipeJson(recipe, tab.name || "receita");
    }
    async function onRecipePicked(e) {
      const file = e.target.files[0];
      e.target.value = ""; // permite reabrir o mesmo arquivo depois sem precisar trocar de arquivo
      if (!file) return;
      const tab = activeTab.value;
      if (!tab) {
        alert("Abra ou importe um arquivo de dados antes de carregar uma receita.");
        return;
      }
      try {
        const recipe = await FileIO.readRecipeJson(file);
        tab.steps.splice(0, tab.steps.length, ...recipe.steps.map((s) => ({ ...s, id: s.id || newId() })));
        await runPipeline();
      } catch (err) {
        tab.errorMessage = err.message;
      }
    }

    // ── Reverter mascaramento (unmask) ──────────────────────────────────
    function openUnmaskPanel() {
      unmaskColumns.value = [];
      unmaskError.value = "";
      showUnmaskPanel.value = true;
    }
    async function doUnmask() {
      unmaskError.value = "";
      if (!salt.value) { unmaskError.value = "Informe o salt na barra de ferramentas."; return; }
      if (!unmaskColumns.value.length) { unmaskError.value = "Escolha ao menos uma coluna."; return; }
      try {
        const tab = activeTab.value;
        const res = await engine.unmask(tab.tableId, JSON.parse(JSON.stringify(tab.steps)), unmaskColumns.value, salt.value);
        addTabFromResult(res);
        showUnmaskPanel.value = false;
      } catch (err) {
        unmaskError.value = err.message;
      }
    }

    // ── Exportar ─────────────────────────────────────────────────────────
    async function doExport() {
      const tab = activeTab.value;
      try {
        await engine.exportResult(
          tab.tableId,
          JSON.parse(JSON.stringify(tab.steps)),
          { salt: salt.value || null, key: dlkKey.value || null },
          { format: exportFormat.value, filenameBase: exportFilename.value }
        );
        showExportPanel.value = false;
      } catch (err) {
        tab.errorMessage = err.message;
      }
    }

    return {
      engineMode, tabs, activeTabId, activeTab,
      theme, toggleTheme, isDarkNow, icon,
      salt, saltVisible, dlkKey, dlkKeyVisible,
      showStepPicker, stepSearchQuery, filteredStepTypes, draftStep, showPiiPanel,
      showUnmaskPanel, unmaskColumns, unmaskError,
      showExportPanel, showAbout, exportFormat, exportFilename,
      showDbPanel, dbUri, dbUriVisible, dbConnectionId, dbConnecting, dbConnectError,
      dbTablesList, dbSqlQuery, dbReadError, dbWriteTableName, dbWriteMode,
      dbUpsertColumns, dbWriteError, dbWriteSuccess,
      openDbPanel, connectDb, disconnectDb, openDbTableAsTab, runDbSqlAsTab, sendActiveTabToDb,
      showJobsPanel, jobsList, jobsLoading, jobsListError, jobFormOpen, editingJobId, jobDraft,
      jobStepsJsonText, jobFormError, jobUpsertOnText, jobRunsFor, jobRunsList,
      openJobsPanel, startNewJob, editJob, useActiveTabStepsInJob, cancelJobForm, saveJob,
      deleteJobConfirm, toggleJobEnabled, runJobNowClick, viewJobRuns, closeJobRuns, formatTimestamp,
      pendingEncryptedFile, showKeyPrompt, keyPromptValue, keyPromptVisible, keyPromptError,
      onFilePicked, onDrop, isDraggingOver, reset, closeTab, selectTab,
      openStepPicker, startNewStep, editStep, cancelStepEdit,
      confirmStep, removeStep, toggleStep, dragStart, dropOn, toggleRowsCondition,
      stepTypeMeta, stepLabel, stepDescription, formatCell, generateSalt, saveRecipe,
      onRecipePicked, doExport, openUnmaskPanel, doUnmask,
      confirmKeyPrompt, cancelKeyPrompt,
    };
  },
}).mount("#app");
