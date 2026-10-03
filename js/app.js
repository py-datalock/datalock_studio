/**
 * app.js
 * ======
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

/**
 * Transforma qualquer coisa capturada num catch (err) numa string legível
 * pra mostrar na tela. Sem isto, `err.message || String(err)` falha
 * silenciosamente quando `err.message` já existe mas NÃO é uma string —
 * por exemplo, o formato de erro de validação 422 do FastAPI (uma lista
 * de objetos `{loc, msg, type}`), ou qualquer outro objeto passado sem
 * querer para `new Error(...)`. Nesses casos `err.message` é "verdadeiro"
 * (não cai no `||`), mas ao interpolar no template Vue vira literalmente
 * o texto "[object Object]" — confuso e sem nenhuma informação útil.
 */
function formatError(err) {
  if (err == null) return "Erro desconhecido.";
  const msg = err.message !== undefined ? err.message : err;
  if (typeof msg === "string") return msg;
  if (Array.isArray(msg)) {
    // Formato de erro de validação do FastAPI/Pydantic: [{loc, msg, type}, ...]
    const parts = msg.map((m) => {
      if (!m || typeof m !== "object") return JSON.stringify(m);
      const field = Array.isArray(m.loc) ? m.loc.filter((p) => p !== "body").join(".") : null;
      return field ? `${field}: ${m.msg}` : (m.msg || JSON.stringify(m));
    });
    return parts.join("; ") || "Erro desconhecido.";
  }
  if (typeof msg === "object") {
    try { return JSON.stringify(msg); } catch { return String(msg); }
  }
  return String(msg);
}

const { createApp, ref, reactive, computed, onMounted, watch, nextTick } = Vue;

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
  { type: "describe", icon: "info", name: "Resumo estatístico", desc: "Média, desvio padrão, mínimo, máximo e percentis de cada coluna numérica" },
  { type: "value_counts", icon: "bar-chart", name: "Contar valores", desc: "Frequência de cada valor distinto de uma coluna" },
  { type: "corr", icon: "grid", name: "Matriz de correlação", desc: "Correlação entre as colunas numéricas" },
  { type: "explode", icon: "layers", name: "Desdobrar lista em linhas", desc: "Expande uma coluna com listas em várias linhas" },
  { type: "shift_step", icon: "arrow-updown", name: "Deslocar valores", desc: "Compara com a linha anterior/seguinte (lag/lead)" },
  { type: "melt", icon: "repeat", name: "Despivotar (melt)", desc: "Transforma colunas em linhas — o inverso da tabela dinâmica" },
  { type: "find_replace", icon: "search", name: "Buscar e substituir", desc: "Troca um texto por outro em uma ou mais colunas, com opção de expressão regular." },
  { type: "synthetic", icon: "sparkles", name: "Gerar dados sintéticos", desc: "Cria uma tabela nova com valores falsos — rápido (bootstrap de linhas) ou estatístico (cópula gaussiana)." },
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
    case "describe": return { ...base };
    case "value_counts": return { ...base, column: null, normalize: false, n: 20 };
    case "corr": return { ...base, method: "pearson" };
    case "explode": return { ...base, column: null };
    case "shift_step": return { ...base, kind: "shift", periods: 1, columns: [] };
    case "melt": return { ...base, id_cols: [], value_cols: [] };
    case "find_replace": return { ...base, columns: [], find: "", replace: "", regex: false };
    case "synthetic": return { ...base, engine: "fast", n: null };
    default: return base;
  }
}

function newTab(name, { tableId, columns, previewRows, totalRows }) {
  return reactive({
    id: newTabId(), tableId, name,
    columns, previewRows, totalRows,
    steps: [], draftKey: "", restoreOffer: null, running: false, errorMessage: "", errorExpanded: false, piiReport: {},
    gridOffset: 0, gridSearch: "", filteredRows: totalRows,
    undoStack: [], redoStack: [], showChart: false,
  });
}

/**
 * Se o último passo HABILITADO da receita é algo que dá pra ver como
 * gráfico, devolve qual tipo — senão, null (esconde o botão de gráfico).
 * Escopo deliberadamente pequeno por enquanto: "Contar valores" (barras)
 * é o caso mais direto (uma categoria, uma contagem); "Matriz de
 * correlação" e "Resumo estatístico" ficam para uma próxima rodada — um
 * mapa de calor de verdade precisa de mais do que o Chart.js básico
 * oferece de graça, e não quis entregar isso pela metade.
 */
function chartableStepType(tab) {
  const enabled = tab.steps.filter((s) => s.enabled !== false);
  if (!enabled.length) return null;
  const last = enabled[enabled.length - 1];
  return last.type === "value_counts" ? "bar" : null;
}

let _chartInstance = null;
async function renderTabChart(tab, canvasEl) {
  if (!canvasEl) return;
  // Chart.js vem empacotado em vendor/ (build UMD, já com todos os componentes) — funciona offline.
  const Chart = window.Chart;
  if (!Chart) throw new Error("A biblioteca de gráficos não carregou. Recarregue a página (Ctrl+F5).");
  if (_chartInstance) { _chartInstance.destroy(); _chartInstance = null; }

  const kind = chartableStepType(tab);
  if (kind !== "bar") return;
  const [labelCol, valueCol] = tab.columns; // value_counts sempre devolve [categoria, frequência|proporção]
  const labels = tab.previewRows.map((r) => String(r[labelCol]));
  const values = tab.previewRows.map((r) => Number(r[valueCol]));

  _chartInstance = new Chart(canvasEl, {
    type: "bar",
    data: { labels, datasets: [{ label: valueCol, data: values, backgroundColor: "#7c6cf0" }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } },
    },
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
      syncPrefs();
    }
    const isDarkNow = computed(() => {
      if (theme.value === "dark") return true;
      if (theme.value === "light") return false;
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    });
    applyTheme();

    // ── Personalização (cor de acento, densidade, layout) ────────────────
    const ACCENT_OPTIONS = [
      { id: "indigo", label: "Índigo", hex: "#4F46E5" },
      { id: "blue", label: "Azul", hex: "#2563EB" },
      { id: "teal", label: "Teal", hex: "#0D9488" },
      { id: "green", label: "Verde", hex: "#15803D" },
      { id: "rose", label: "Rosa", hex: "#DB2777" },
      { id: "violet", label: "Violeta", hex: "#7C3AED" },
    ];
    const accentColor = ref(localStorage.getItem("dl_accent") || "indigo");
    const density = ref(localStorage.getItem("dl_density") || "comfortable");
    const stepsPosition = ref(localStorage.getItem("dl_steps_position") || "right");
    const showSettingsPanel = ref(false);

    function applyCustomization() {
      document.documentElement.setAttribute("data-accent", accentColor.value);
      if (density.value === "compact") document.documentElement.setAttribute("data-density", "compact");
      else document.documentElement.removeAttribute("data-density");
      document.documentElement.setAttribute("data-steps-position", stepsPosition.value);
    }
    function setAccentColor(id) { accentColor.value = id; localStorage.setItem("dl_accent", id); applyCustomization(); syncPrefs(); }
    function setDensity(v) { density.value = v; localStorage.setItem("dl_density", v); applyCustomization(); syncPrefs(); }
    function setStepsPosition(v) { stepsPosition.value = v; localStorage.setItem("dl_steps_position", v); applyCustomization(); syncPrefs(); }
    applyCustomization();

    // ── Onboarding (primeira abertura) ────────────────────────────────────
    const ONBOARDING_SLIDES = [
      {
        icon: "sparkles",
        title: "Bem-vindo ao datalock Studio",
        text: "Uma interface de apontar e clicar para limpar, transformar e anonimizar dados — sem precisar escrever código.",
      },
      {
        icon: "upload",
        title: "1. Importe um arquivo",
        text: "Arraste um CSV, XLSX ou JSON para a tela inicial. Cada planilha ou tabela vira uma aba própria, que você pode trabalhar independentemente.",
      },
      {
        icon: "plus-circle",
        title: "2. Monte uma receita",
        text: "Clique em \"Adicionar\" e escolha um passo: filtrar, ordenar, agrupar, mascarar uma coluna... A prévia à esquerda atualiza sozinha a cada passo.",
      },
      {
        icon: "shield",
        title: "3. Detecte e anonimize",
        text: "O ícone de busca aponta colunas que parecem CPF, e-mail ou telefone. Marque a coluna, escolha um método de mascaramento, e pronto.",
      },
      {
        icon: "download",
        title: "4. Exporte o resultado",
        text: "Quando terminar, exporte como CSV, Excel ou JSON. Salve a receita para reaplicar depois em outro arquivo parecido — sem refazer os passos.",
      },
    ];
    const showOnboarding = ref(false);
    const onboardingStep = ref(0);
    function startOnboarding() { onboardingStep.value = 0; showOnboarding.value = true; }
    function nextOnboarding() {
      if (onboardingStep.value < ONBOARDING_SLIDES.length - 1) onboardingStep.value += 1;
      else finishOnboarding();
    }
    function prevOnboarding() { if (onboardingStep.value > 0) onboardingStep.value -= 1; }
    function finishOnboarding() {
      showOnboarding.value = false;
      localStorage.setItem("dl_onboarding_seen", "1");
      syncPrefs();
    }
    if (!localStorage.getItem("dl_onboarding_seen")) {
      showOnboarding.value = true;
    }

    // ── Guia de ajuda ──────────────────────────────────────────────────────
    const showHelpGuide = ref(false);

    function icon(name, opts) { return iconFn(name, opts); }

    const salt = ref("");
    const saltVisible = ref(false);
    const dlkKey = ref("");
    const dlkKeyVisible = ref(false);
    const saltStrength = computed(() => {
      if (!salt.value) return null;
      const check = validateSaltStrength(salt.value);
      if (!check.ok) return { level: "weak", label: "fraco", detail: check.errors[0] };
      if (check.warnings.length) return { level: "medium", label: "razoável", detail: check.warnings[0] };
      return { level: "strong", label: "forte", detail: "Salt com boa entropia." };
    });
    const dlkKeyStrength = computed(() => {
      if (!dlkKey.value) return null;
      const check = validateSaltStrength(dlkKey.value);
      if (!check.ok) return { level: "weak", label: "fraca", detail: check.errors[0] };
      if (check.warnings.length) return { level: "medium", label: "razoável", detail: check.warnings[0] };
      return { level: "strong", label: "forte", detail: "Chave com boa entropia." };
    });

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
    const showEdaPanel = ref(false);
    const edaLoading = ref(false);
    const edaError = ref("");
    const edaResult = ref(null);
    const complianceOrg = ref("");
    const complianceDataset = ref("");
    const complianceFormat = ref("html");
    const complianceError = ref("");
    // Colunas que a pessoa marcou manualmente como PII pra entrar no
    // relatório mesmo que a detecção automática (regex simples) não
    // tenha reconhecido — comum em texto livre, como endereço, que não
    // segue um padrão fixo como CPF/e-mail/telefone.
    const complianceManualPiiColumns = ref([]);
    const privacyQuasiIds = ref([]);
    const privacyMetricsResult = ref(null);
    const privacyMetricsError = ref("");
    const showDiffPanel = ref(false);
    const diffResult = ref(null);
    const diffError = ref("");

    async function generateComplianceReport() {
      complianceError.value = "";
      const tab = activeTab.value;
      try {
        const { blob, filename } = await engine.complianceReport(
          tab.tableId, JSON.parse(JSON.stringify(tab.steps)), salt.value || null,
          { title: "Relatório de Conformidade LGPD", organization: complianceOrg.value,
            dataset_name: complianceDataset.value || tab.name, format: complianceFormat.value,
            manual_pii_columns: complianceManualPiiColumns.value }
        );
        FileIO.downloadBlob(blob, filename);
      } catch (err) {
        complianceError.value = formatError(err);
      }
    }

    async function runPrivacyMetrics() {
      privacyMetricsError.value = ""; privacyMetricsResult.value = null;
      if (!privacyQuasiIds.value.length) { privacyMetricsError.value = "Marque ao menos uma coluna quasi-identificadora."; return; }
      const tab = activeTab.value;
      try {
        const res = engineMode.value === "server"
          ? await engine.privacyMetrics(
              tab.tableId, JSON.parse(JSON.stringify(tab.steps)), salt.value || null,
              { quasi_identifiers: privacyQuasiIds.value }
            )
          : await engine.kAnonymity(
              tab.tableId, JSON.parse(JSON.stringify(tab.steps)), salt.value || null,
              privacyQuasiIds.value
            );
        privacyMetricsResult.value = res;
      } catch (err) {
        privacyMetricsError.value = formatError(err);
      }
    }

    async function openDiffPanel() {
      diffError.value = ""; diffResult.value = null;
      showDiffPanel.value = true;
      const tab = activeTab.value;
      try {
        diffResult.value = await engine.pipelineDiff(tab.tableId, JSON.parse(JSON.stringify(tab.steps)), salt.value || null);
      } catch (err) {
        diffError.value = formatError(err);
      }
    }

    // ── Ferramentas .dlk (inspecionar / trocar chave) ───────────────────
    const showDlkToolsPanel = ref(false);
    const dlkInspectFile = ref(null);
    const dlkInspectKey = ref("");
    const dlkInspectKeyVisible = ref(false);
    const dlkInspectResult = ref(null);
    const dlkInspectError = ref("");
    const dlkRekeyFile = ref(null);
    const dlkRekeyOldKey = ref("");
    const dlkRekeyNewKey = ref("");
    const dlkRekeyError = ref("");
    const dlkRekeySuccess = ref("");

    function openDlkToolsPanel() {
      dlkInspectFile.value = null; dlkInspectResult.value = null; dlkInspectError.value = "";
      dlkRekeyFile.value = null; dlkRekeyError.value = ""; dlkRekeySuccess.value = "";
      showDlkToolsPanel.value = true;
    }
    function onDlkInspectFilePicked(e) { dlkInspectFile.value = e.target.files[0] || null; }
    function onDlkRekeyFilePicked(e) { dlkRekeyFile.value = e.target.files[0] || null; }

    async function doDlkInspect() {
      dlkInspectError.value = ""; dlkInspectResult.value = null;
      try {
        dlkInspectResult.value = await engine.dlkInspect(dlkInspectFile.value, dlkInspectKey.value || null);
      } catch (err) {
        dlkInspectError.value = formatError(err);
      }
    }
    async function doDlkRekey() {
      dlkRekeyError.value = ""; dlkRekeySuccess.value = "";
      if (!dlkRekeyOldKey.value || !dlkRekeyNewKey.value) { dlkRekeyError.value = "Informe a chave atual e a nova."; return; }
      try {
        const { blob, filename } = await engine.dlkRekey(dlkRekeyFile.value, dlkRekeyOldKey.value, dlkRekeyNewKey.value);
        FileIO.downloadBlob(blob, filename);
        dlkRekeySuccess.value = "Chave trocada — o arquivo com a chave nova foi baixado.";
      } catch (err) {
        dlkRekeyError.value = formatError(err);
      }
    }

    // ── Varrer pasta inteira ─────────────────────────────────────────────
    const showScanDirPanel = ref(false);
    const scanDirPath = ref("");
    const scanDirFiles = ref(null);   // prévia web: arquivos escolhidos no seletor de pasta
    const scanDirFolderName = ref("");
    const scanDirRecursive = ref(true);
    const scanDirMinRisk = ref(null);
    const scanDirResult = ref(null);
    const scanDirError = ref("");

    function openScanDirPanel() {
      scanDirResult.value = null; scanDirError.value = "";
      showScanDirPanel.value = true;
    }
    function onScanDirPicked(ev) {
      const files = Array.from(ev.target.files || []);
      scanDirFiles.value = files.length ? files : null;
      const first = files[0];
      scanDirFolderName.value = first && first.webkitRelativePath
        ? `${first.webkitRelativePath.split("/")[0]} (${files.length} arquivo(s))` : "";
    }
    async function doScanDirectory() {
      scanDirError.value = ""; scanDirResult.value = null;
      const isServer = engineMode.value === "server";
      if (isServer && !scanDirPath.value.trim()) { scanDirError.value = "Informe o caminho da pasta."; return; }
      if (!isServer && !scanDirFiles.value) { scanDirError.value = "Escolha uma pasta primeiro."; return; }
      try {
        scanDirResult.value = await engine.scanDirectory(isServer ? scanDirPath.value.trim() : scanDirFiles.value, {
          recursive: scanDirRecursive.value, min_risk: scanDirMinRisk.value,
        });
      } catch (err) {
        scanDirError.value = formatError(err);
      }
    }

    // ── Trilha de auditoria ──────────────────────────────────────────────
    const showAuditPanel = ref(false);
    const auditEnabled = ref(false);
    const auditPath = ref("");
    const auditWebhook = ref("");
    const auditConfigError = ref("");
    const auditLogEntries = ref([]);
    const auditLogError = ref("");
    const auditSavePath = ref("");
    const auditSaveKey = ref("");
    const auditSaveSuccess = ref("");

    async function openAuditPanel() {
      auditConfigError.value = ""; auditSaveSuccess.value = "";
      try {
        const status = await engine.auditStatus();
        auditEnabled.value = status.enabled;
        if (status.enabled) await refreshAuditLog();
      } catch { /* painel ainda abre normalmente mesmo se isso falhar */ }
      showAuditPanel.value = true;
    }
    async function applyAuditConfig() {
      auditConfigError.value = "";
      try {
        await engine.auditConfigure(auditEnabled.value, auditPath.value || null, auditWebhook.value || null);
        if (auditEnabled.value) await refreshAuditLog();
      } catch (err) {
        auditConfigError.value = formatError(err);
      }
    }
    async function refreshAuditLog() {
      auditLogError.value = "";
      try {
        const log = await engine.auditLog();
        auditLogEntries.value = log.entries || [];
      } catch (err) {
        auditLogError.value = formatError(err);
      }
    }
    async function doAuditSave() {
      auditSaveSuccess.value = "";
      if (engineMode.value === "server" && !auditSavePath.value.trim()) { auditConfigError.value = "Informe o caminho do arquivo."; return; }
      try {
        const res = await engine.auditSave(auditSavePath.value.trim(), auditSaveKey.value || null);
        auditSaveSuccess.value = `Salvo em ${res.saved_to}`;
      } catch (err) {
        auditConfigError.value = formatError(err);
      }
    }

    const showUnmaskPanel = ref(false);
    const unmaskColumns = ref([]);
    const unmaskError = ref("");
    const showExportPanel = ref(false);
    const showAbout = ref(false);
    const exportFormat = ref("csv");
    const exportFilename = ref("");
    const exportAllTabs = ref(false);   // juntar todas as abas num só .dlk (multi-frame)
    const canExportAllTabs = computed(() => tabs.length > 1 && exportFormat.value.startsWith("dlk_"));

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
    const dbBrowserName = ref("");   // prévia: nome do arquivo SQLite aberto

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
        dbConnectError.value = formatError(err);
      } finally {
        dbConnecting.value = false;
      }
    }

    // Prévia web: abre um arquivo SQLite (ou cria um banco novo) em memória, no navegador.
    async function connectSqliteFile(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = "";
      if (!file) return;
      await connectSqlite(file);
    }
    async function connectSqlite(file) {
      dbConnectError.value = "";
      dbConnecting.value = true;
      try {
        const res = await engine.dbConnect(file);
        dbConnectionId.value = res.connection_id;
        dbBrowserName.value = file ? file.name : "novo_banco.sqlite";
        const tablesRes = await engine.dbTables(dbConnectionId.value);
        dbTablesList.value = tablesRes.tables || [];
      } catch (err) {
        dbConnectError.value = formatError(err);
      } finally {
        dbConnecting.value = false;
      }
    }
    async function downloadSqlite() {
      dbReadError.value = "";
      try { await engine.dbExport(dbConnectionId.value); }
      catch (err) { dbReadError.value = formatError(err); }
    }

    async function disconnectDb() {
      const id = dbConnectionId.value;
      dbConnectionId.value = null;
      dbTablesList.value = [];
      dbUri.value = "";
      dbBrowserName.value = "";
      if (id) { try { await engine.dbClose(id); } catch { /* fechar é best-effort */ } }
    }

    async function openDbTableAsTab(tableName) {
      dbReadError.value = "";
      try {
        const res = await engine.dbOpenAsTable(dbConnectionId.value, tableName);
        addTabFromResult(res);
        showDbPanel.value = false;
      } catch (err) {
        dbReadError.value = formatError(err);
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
        dbReadError.value = formatError(err);
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
        if (engineMode.value !== "server") {
          const tablesRes = await engine.dbTables(dbConnectionId.value);
          dbTablesList.value = tablesRes.tables || [];
        }
      } catch (err) {
        dbWriteError.value = formatError(err);
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
        jobsListError.value = formatError(err);
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
        jobFormError.value = formatError(err);
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

    // ── Conexão com o software completo ──────────────────────────────────
    // Dois cenários, tratados de forma diferente de propósito:
    //
    // 1) Página servida PELO PRÓPRIO backend (o .exe, a Microsoft Store, ou o
    //    comando `datalock-studio`): a origem é a mesma do servidor — não existe
    //    permissão de "rede local" a pedir e a conexão é só detectar o motor.
    //    Acontece SOZINHA, e a tela de carregamento fica até o motor estar pronto —
    //    por isso nenhum arquivo pode ser aberto "cedo demais" no motor errado.
    //
    // 2) Prévia hospedada (GitHub Pages): SEMPRE um clique da pessoa, precedido de uma explicação.
    //    O pedido de permissão do navegador ("acessar outros apps e serviços neste dispositivo")
    //    assusta quando aparece sozinho; por isso nada é tentado ao abrir a página.
    const SERVED_BY_BACKEND = (() => {
      try {
        const { protocol, hostname, port } = window.location;
        return /^https?:$/.test(protocol) && (hostname === "127.0.0.1" || hostname === "localhost") && !!port;
      } catch { return false; }
    })();

    const servedByBackend = SERVED_BY_BACKEND;
    const engineBooting = ref(SERVED_BY_BACKEND);   // true enquanto o motor local ainda está subindo
    const connectingToServer = ref(false);
    const serverConnectError = ref("");
    const serverConnectNote = ref("");

    function setBootText(msg) {
      const el = document.getElementById("dl-boot-splash-text");
      if (el) el.textContent = msg;
    }


    // ── Preferências e rascunhos em DISCO (só no programa instalado) ─────────
    // O localStorage é por origem (inclui a porta): se a 8722 estava ocupada e o programa abriu na 8723,
    // tema/cor/tutorial pareciam sumir. No programa instalado o estado também vive em
    // ~/.datalock_studio/state.json (ver state.py). Na prévia hospedada nada disso é usado.
    const PERSIST_TO_DISK = SERVED_BY_BACKEND;
    const PREF_KEYS = ["dl_theme", "dl_accent", "dl_density", "dl_steps_position", "dl_onboarding_seen"];
    let _prefsTimer = null;

    function syncPrefs() {
      if (!PERSIST_TO_DISK || engineMode.value !== "server") return;
      clearTimeout(_prefsTimer);
      _prefsTimer = setTimeout(() => {
        const prefs = {};
        for (const k of PREF_KEYS) { const v = localStorage.getItem(k); if (v !== null) prefs[k] = v; }
        engine.state.putPrefs(prefs).catch(() => {});
      }, 400);
    }

    /** Disco manda; se o disco ainda está vazio, sobe o que já existia no navegador. */
    async function hydratePrefs() {
      try {
        const res = await engine.state.getPrefs();
        const disk = (res && res.prefs) || {};
        if (Object.keys(disk).length) {
          for (const k of PREF_KEYS) if (disk[k] !== undefined) localStorage.setItem(k, disk[k]);
          theme.value = localStorage.getItem("dl_theme") || "auto";
          accentColor.value = localStorage.getItem("dl_accent") || "indigo";
          density.value = localStorage.getItem("dl_density") || "comfortable";
          stepsPosition.value = localStorage.getItem("dl_steps_position") || "right";
          applyTheme(); applyCustomization();
          if (localStorage.getItem("dl_onboarding_seen")) showOnboarding.value = false;
        } else {
          syncPrefs();
        }
      } catch { /* sem disco: segue só com o localStorage */ }
    }

    // Rascunho automático da receita, por arquivo
    const draftsByKey = reactive({});       // chave do arquivo -> { steps, saved_at }
    const recentFiles = ref([]);            // [{ name, opened_at, rows }]
    const _savedDraftJson = new Map();      // chave -> último JSON gravado (evita regravar igual)
    let _draftTimer = null;

    async function hydrateDrafts() {
      try {
        const res = await engine.state.getDrafts();
        for (const k of Object.keys(draftsByKey)) delete draftsByKey[k];
        Object.assign(draftsByKey, (res && res.drafts) || {});
        recentFiles.value = (res && res.recents) || [];
      } catch { /* ignora */ }
    }

    function scheduleDraftSave() {
      if (!PERSIST_TO_DISK || engineMode.value !== "server") return;
      clearTimeout(_draftTimer);
      _draftTimer = setTimeout(() => {
        for (const tab of tabs) {
          if (!tab.draftKey) continue;
          if (tab.restoreOffer) {
            if (!tab.steps.length) continue;   // oferta pendente e nada editado: não sobrescreve o rascunho antigo
            tab.restoreOffer = null;           // a pessoa começou uma receita nova: a oferta antiga some
          }
          const json = JSON.stringify(tab.steps);
          if (_savedDraftJson.get(tab.draftKey) === json) continue;
          _savedDraftJson.set(tab.draftKey, json);
          engine.state.putDraft(tab.draftKey, JSON.parse(json)).catch(() => {});
        }
      }, 900);
    }

    /** Só passos com `type` texto e conhecido; o resto é descartado em vez de quebrar a interface. */
    function sanitizeSteps(steps) {
      if (!Array.isArray(steps)) return [];
      return steps.filter((st) => st && typeof st === "object" && typeof st.type === "string" && st.type.length < 64);
    }
    function offerDraftRestore(tab) {
      const d = draftsByKey[tab.draftKey];
      const steps = d ? sanitizeSteps(d.steps) : [];
      if (steps.length) tab.restoreOffer = { steps, savedAt: d.saved_at };
    }
    async function restoreDraft(tab) {
      const offer = tab.restoreOffer;
      if (!offer) return;
      tab.restoreOffer = null;
      activeTabId.value = tab.id;
      tab.steps.splice(0, tab.steps.length, ...offer.steps.map((st) => ({ ...st, id: st.id || newId() })));
      await runPipeline();
      toast("Receita restaurada.");
    }
    function dismissDraft(tab) {
      tab.restoreOffer = null;
      _savedDraftJson.delete(tab.draftKey);
      engine.state.deleteDraft(tab.draftKey).catch(() => {});
      delete draftsByKey[tab.draftKey];
    }
    async function clearRecentFiles() {
      recentFiles.value = [];
      engine.state.clearRecents().catch(() => {});
    }
    function formatDraftDate(unixSeconds) {
      return unixSeconds ? new Date(unixSeconds * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "";
    }
    watch(() => tabs.map((t) => `${t.draftKey}\u0000${JSON.stringify(t.steps)}`), scheduleDraftSave);


    // ── Avisos (toasts), atalhos, barra de status ────────────────────────────
    const toasts = reactive([]);
    let _toastId = 0;
    function dismissToast(id) { const i = toasts.findIndex((t) => t.id === id); if (i !== -1) toasts.splice(i, 1); }
    /** Confirma uma ação com um aviso curto que some sozinho (erros ficam mais tempo). */
    function toast(message, kind = "ok", ms = kind === "error" ? 7000 : 3200) {
      const id = ++_toastId;
      toasts.push({ id, message, kind });
      if (toasts.length > 4) toasts.shift();
      setTimeout(() => dismissToast(id), ms);
    }
    const showShortcuts = ref(false);
    const shortcutList = [
      { keys: "Ctrl O", label: "Abrir arquivo" },
      { keys: "Ctrl S", label: "Salvar a receita (passos aplicados)" },
      { keys: "Ctrl Z", label: "Desfazer o último passo" },
      { keys: "Ctrl Y", label: "Refazer" },
      { keys: "Ctrl F", label: "Buscar na tabela" },
      { keys: "Esc", label: "Fechar o painel aberto" },
      { keys: "Ctrl /", label: "Mostrar esta lista" },
    ];
    const exportNeutralize = ref(true);   // proteger contra fórmulas no Excel (CSV/XLSX) — ver export_safety.py

    function openDataFolder() {
      const api = window.pywebview && window.pywebview.api;
      if (api && api.open_data_folder) api.open_data_folder().then((ok) => { if (!ok) toast("Não foi possível abrir a pasta.", "error"); });
      else toast("Disponível só no programa instalado. A pasta é ~/.datalock_studio", "error");
    }

    // Na prévia hospedada nada é salvo em disco: avisa antes de fechar a aba com receitas em andamento.
    window.addEventListener("beforeunload", (e) => {
      if (!SERVED_BY_BACKEND && tabs.some((t) => t.steps.length)) { e.preventDefault(); e.returnValue = ""; }
    });

    const serverInfo = ref(null);   // { studio_version, datalock_version } do /health
    const showConnectInfo = ref(false);

    /** Clique no badge: na prévia hospedada explica o pedido de permissão ANTES de disparar a conexão. */
    function requestConnect() {
      if (engineMode.value === "server" || connectingToServer.value) return;
      if (SERVED_BY_BACKEND) { connectToLocalSoftware(); return; }
      showConnectInfo.value = true;
    }
    function confirmConnect() {
      showConnectInfo.value = false;
      connectToLocalSoftware();
    }

    async function connectToLocalSoftware() {
      if (engineMode.value === "server" || connectingToServer.value) return;
      connectingToServer.value = true;
      serverConnectError.value = "";
      serverConnectNote.value = "";
      try {
        const mode = await engine.detect();
        engineMode.value = mode;
        serverInfo.value = engine.serverInfo;
        if (mode === "server") {
          if (tabs.length) {
            serverConnectNote.value = "Conectado. As tabelas já abertas continuam na prévia — abra o arquivo de novo para usar o motor completo.";
          }
        } else {
          serverConnectError.value = SERVED_BY_BACKEND
            ? "O motor local não respondeu. Feche e abra o programa de novo; se persistir, veja o arquivo de log em ~/.datalock_studio/desktop.log."
            : "Não encontrei o software completo em http://127.0.0.1:8722. Confirme que o datalock Studio está aberto nesta máquina.";
        }
      } catch (err) {
        serverConnectError.value = `Falha ao tentar conectar: ${err.message}`;
      } finally {
        connectingToServer.value = false;
      }
    }

    /** Espera o backend subir (primeira abertura do .exe: extração, antivírus, import de polars/scipy). */
    async function waitForLocalEngine(maxSeconds = 45) {
      const t0 = Date.now();
      let attempt = 0;
      while ((Date.now() - t0) / 1000 < maxSeconds) {
        const mode = await engine.detect();
        if (mode === "server") { engineMode.value = "server"; serverInfo.value = engine.serverInfo; return true; }
        attempt += 1;
        if (attempt === 4) setBootText("Iniciando o motor de dados… a primeira abertura pode levar alguns segundos.");
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    }

    onMounted(async () => {
      if (SERVED_BY_BACKEND) {
        const ok = await waitForLocalEngine();
        if (ok) await Promise.all([hydratePrefs(), hydrateDrafts()]);
        engineBooting.value = false;
        if (!ok) serverConnectError.value =
          "O motor local não respondeu. Feche e abra o programa de novo; se persistir, veja ~/.datalock_studio/desktop.log.";
      }
      // Prévia hospedada: NENHUMA chamada de rede para o computador da pessoa ao abrir a página.
      // O navegador só pergunta sobre "acessar outros apps e serviços neste dispositivo" depois de um clique
      // explícito em "conectar" — e antes do clique a gente explica o que vai aparecer (ver confirmConnect).
      document.getElementById("dl-boot-splash")?.remove();
    });

    // ── Atalhos de teclado ───────────────────────────────────────────────
    function isTypingInField(e) {
      const tag = (e.target.tagName || "").toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;
    }
    function handleGlobalKeydown(e) {
      const ctrl = e.ctrlKey || e.metaKey; // metaKey cobre Cmd no Mac
      if (ctrl && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault(); undoStep(); return;
      }
      if (ctrl && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault(); redoStep(); return;
      }
      if (ctrl && e.key === "/") { e.preventDefault(); showShortcuts.value = !showShortcuts.value; return; }
      if (ctrl && e.key.toLowerCase() === "o") {
        e.preventDefault(); openFilePicker(); return;
      }
      if (ctrl && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activeTab.value) saveRecipe();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "f") {
        if (!activeTab.value) return;
        e.preventDefault();
        const el = document.getElementById("grid-search-input");
        if (el) { el.focus(); el.select(); }
        return;
      }
      if (e.key === "Escape") {
        // Fecha o que estiver aberto no momento, na ordem que faz mais sentido
        if (draftStep.value) { cancelStepEdit(); return; }
        if (showStepPicker.value) { showStepPicker.value = false; return; }
      }
    }
    window.addEventListener("keydown", handleGlobalKeydown);

    // ── Carregar arquivo ────────────────────────────────────────────────
    // Mensagens de erro podem ser longas (ex.: instrução de instalação de
    // uma dependência opcional) — em vez de cortar com "...", deixa
    // clicar pra expandir e copiar o texto inteiro.
    async function copyErrorMessage(tab) {
      try {
        await navigator.clipboard.writeText(tab.errorMessage);
      } catch {
        // Sem permissão de clipboard (ex.: contexto não seguro) — a
        // pessoa ainda consegue selecionar o texto manualmente no balão
        // expandido, então isso não é uma falha crítica.
      }
    }

    function addTabFromResult(res) {
      const tab = newTab(res.name, res);
      tabs.push(tab);
      activeTabId.value = tab.id;
      refreshPiiReport(tab);
      return tab;
    }

    const isLoadingFile = ref(false);
    const loadingFileName = ref("");
    const loadError = ref("");          // erro de abertura mostrado na própria tela inicial (sem alert())

    async function loadFile(file, opts = {}) {
      loadError.value = "";
      isLoadingFile.value = true;
      loadingFileName.value = file.name;
      try {
        const results = await engine.loadFile(file, opts);
        for (const res of results) {
          const tab = addTabFromResult(res);
          tab.draftKey = results.length > 1 ? `${file.name}::${res.name}` : file.name;
          offerDraftRestore(tab);
          if (PERSIST_TO_DISK && engineMode.value === "server") engine.state.addRecent(file.name, res.totalRows).catch(() => {});
        }
        if (PERSIST_TO_DISK && engineMode.value === "server") hydrateDrafts().then(() => {});
        pendingEncryptedFile.value = null;
        showKeyPrompt.value = false;
        keyPromptValue.value = "";
        keyPromptError.value = "";
        return true;
      } catch (err) {
        const msg = formatError(err);
        if (/chave \(key\)/i.test(msg) || /criptografad/i.test(msg)) {
          pendingEncryptedFile.value = file;
          showKeyPrompt.value = true;
          // Se já foi tentada uma chave, a mensagem é de chave errada — mostra no prompt em vez de reabri-lo "mudo".
          keyPromptError.value = opts.key ? "Não foi possível abrir com essa chave. Confira e tente de novo." : "";
          return false;
        }
        if (!tabs.length) {
          loadError.value = `Não foi possível abrir "${file.name}": ${msg}`;
        } else {
          activeTab.value.errorMessage = `Não foi possível abrir "${file.name}": ${msg}`;
        }
        return false;
      } finally {
        isLoadingFile.value = false;
        loadingFileName.value = "";
      }
    }

    /** Abre vários arquivos de uma vez (um por vez, em sequência — cada um vira uma ou mais abas). */
    async function loadFiles(fileList) {
      const files = Array.from(fileList || []);
      for (const f of files) await loadFile(f);
    }
    function onFilePicked(e) {
      const files = Array.from(e.target.files || []);
      e.target.value = "";   // permite escolher o MESMO arquivo de novo depois de fechar a aba
      loadFiles(files);
    }
    function onDrop(e) { if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files); }

    function openFilePicker() {
      const el = tabs.length ? document.querySelector('input[type="file"][accept*=".csv"]:not([data-scan])') : null;
      (el || document.querySelector('input[type="file"][accept*=".csv"]'))?.click();
    }
    const isDraggingOver = ref(false);

    async function confirmKeyPrompt() {
      keyPromptError.value = "";
      try {
        await loadFile(pendingEncryptedFile.value, { key: keyPromptValue.value });
      } catch (err) {
        keyPromptError.value = formatError(err);
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
        const res = await engine.run(tab.tableId, JSON.parse(JSON.stringify(tab.steps)),
          { salt: salt.value || null, offset: tab.gridOffset, search: tab.gridSearch || null });
        tab.columns = res.columns;
        tab.previewRows = res.previewRows;
        tab.totalRows = res.totalRows;
        tab.filteredRows = res.filteredRows ?? res.totalRows;
        await refreshPiiReport(tab);
      } catch (err) {
        tab.errorMessage = formatError(err);
      } finally {
        tab.running = false;
      }
    }

    const GRID_PAGE_SIZE = 200;
    let gridSearchTimer = null;
    function gridSearchChanged() {
      const tab = activeTab.value;
      if (!tab) return;
      clearTimeout(gridSearchTimer);
      gridSearchTimer = setTimeout(() => {
        tab.gridOffset = 0; // toda busca nova volta pra primeira página
        runPipeline();
      }, 300);
    }
    function gridNextPage() {
      const tab = activeTab.value;
      if (!tab || tab.gridOffset + GRID_PAGE_SIZE >= tab.filteredRows) return;
      tab.gridOffset += GRID_PAGE_SIZE;
      runPipeline();
    }
    function gridPrevPage() {
      const tab = activeTab.value;
      if (!tab || tab.gridOffset <= 0) return;
      tab.gridOffset = Math.max(0, tab.gridOffset - GRID_PAGE_SIZE);
      runPipeline();
    }

let _edaChartInstances = [];
async function renderEdaCharts(edaResult) {
  for (const c of _edaChartInstances) c.destroy();
  _edaChartInstances = [];
  if (!edaResult) return;
  const { default: Chart } = await import("https://cdn.jsdelivr.net/npm/chart.js@4/auto/+esm");

  edaResult.columns.forEach((col, idx) => {
    if (col.kind === "other") return;
    const canvasEl = document.getElementById(`eda-chart-${idx}`);
    if (!canvasEl) return;
    const source = col.kind === "numeric" ? col.histogram : col.value_counts;
    const color = col.kind === "numeric" ? "#4dabf7" : "#7c6cf0";
    const chart = new Chart(canvasEl, {
      type: "bar",
      data: { labels: source.labels, datasets: [{ data: source.counts, backgroundColor: color }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true },
          x: { ticks: { maxRotation: col.kind === "numeric" ? 45 : 60, autoSkip: true, font: { size: 9 } } },
        },
      },
    });
    _edaChartInstances.push(chart);
  });
}

async function openEdaPanel() {
  const tab = activeTab.value;
  if (!tab) return;
  showEdaPanel.value = true;
  edaError.value = "";
  edaResult.value = null;
  edaLoading.value = true;
  try {
    const result = await engine.autoEda(tab.tableId, JSON.parse(JSON.stringify(tab.steps)), salt.value || null);
    edaResult.value = result;
    await nextTick(); // espera os <canvas> existirem no DOM antes de desenhar
    await renderEdaCharts(result);
  } catch (err) {
    edaError.value = formatError(err);
  } finally {
    edaLoading.value = false;
  }
}
function closeEdaPanel() {
  showEdaPanel.value = false;
  for (const c of _edaChartInstances) c.destroy();
  _edaChartInstances = [];
}

async function toggleChart() {
      const tab = activeTab.value;
      if (!tab) return;
      tab.showChart = !tab.showChart;
      if (tab.showChart) {
        await nextTick(); // espera o <canvas> existir no DOM antes de desenhar
        await renderTabChart(tab, document.getElementById("chart-canvas"));
      }
    }
    // Reflow do gráfico sempre que os dados da aba ativa mudarem (rodou de
    // novo a receita, trocou de aba) enquanto o modo gráfico está ligado —
    // sem isto, o gráfico ficaria "parado" mostrando o resultado antigo.
    watch(
      () => activeTab.value && [activeTab.value.id, activeTab.value.previewRows, activeTab.value.showChart],
      async () => {
        const tab = activeTab.value;
        if (!tab || !tab.showChart) return;
        await nextTick();
        await renderTabChart(tab, document.getElementById("chart-canvas"));
      },
      { deep: false }
    );

    async function refreshPiiReport(tab) {
      try {
        const report = await engine.scanPii(tab.tableId);
        const flat = report.report || report;
        Object.keys(tab.piiReport).forEach((k) => delete tab.piiReport[k]);
        Object.assign(tab.piiReport, flat);
      } catch { /* painel de PII é auxiliar — falha aqui não deve travar a tela */ }
    }

    // ── Gestão de passos (sempre na aba ativa) ──────────────────────────
    function pushUndoSnapshot(tab) {
      tab.undoStack.push(JSON.parse(JSON.stringify(tab.steps)));
      if (tab.undoStack.length > 50) tab.undoStack.shift(); // limite razoável de memória
      tab.redoStack.length = 0; // qualquer ação nova invalida o "refazer" pendente
    }
    function undoStep() {
      const tab = activeTab.value;
      if (!tab || !tab.undoStack.length) return;
      tab.redoStack.push(JSON.parse(JSON.stringify(tab.steps)));
      const prev = tab.undoStack.pop();
      tab.steps.splice(0, tab.steps.length, ...prev);
      runPipeline();
    }
    function redoStep() {
      const tab = activeTab.value;
      if (!tab || !tab.redoStack.length) return;
      tab.undoStack.push(JSON.parse(JSON.stringify(tab.steps)));
      const next = tab.redoStack.pop();
      tab.steps.splice(0, tab.steps.length, ...next);
      runPipeline();
    }

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
      pushUndoSnapshot(tab);
      if (editingIndex.value === null) tab.steps.push(draftStep.value);
      else tab.steps.splice(editingIndex.value, 1, draftStep.value);
      draftStep.value = null;
      editingIndex.value = null;
      await runPipeline();
    }

    async function removeStep(idx) {
      const tab = activeTab.value;
      pushUndoSnapshot(tab);
      tab.steps.splice(idx, 1);
      await runPipeline();
    }
    async function toggleStep(idx) {
      const tab = activeTab.value;
      pushUndoSnapshot(tab);
      const step = tab.steps[idx];
      step.enabled = step.enabled === false ? true : false;
      await runPipeline();
    }

    function dragStart(idx) { dragIndex = idx; }
    async function dropOn(idx) {
      if (dragIndex === null || dragIndex === idx) return;
      const tab = activeTab.value;
      pushUndoSnapshot(tab);
      const steps = tab.steps;
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
    /** Nunca derruba a tela: um passo malformado (receita importada, rascunho antigo) mostra um aviso no lugar. */
    function stepDescription(step) {
      try { return stepDescriptionUnsafe(step); }
      catch { return "(passo incompleto — edite ou remova)"; }
    }
    function stepDescriptionUnsafe(step) {
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
        case "describe": return "estatísticas de todas as colunas numéricas";
        case "value_counts": return `${step.column || "?"}${step.normalize ? " (proporção)" : ""}`;
        case "corr": return `método: ${step.method}`;
        case "explode": return step.column || "?";
        case "shift_step": return `${step.kind} ${step.periods}`;
        case "melt": return `${(step.id_cols||[]).join(", ") || "?"} → ${(step.value_cols||[]).join(", ") || "?"}`;
        case "find_replace": return `"${step.find || '?'}" → "${step.replace || ''}"${step.regex ? " (regex)" : ""}`;
        case "synthetic": return `${step.n || "mesmo total"} linha(s) · rápido`;
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
      toast("Receita salva.");
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
        const res = await engine.unmask(tab.tableId, JSON.parse(JSON.stringify(tab.steps)), unmaskColumns.value, salt.value, `${tab.name} (revertido)`);
        addTabFromResult(res);
        showUnmaskPanel.value = false;
      } catch (err) {
        unmaskError.value = err.message;
      }
    }

    // ── Exportar ─────────────────────────────────────────────────────────
    function openExportPanel() {
      // Pré-preenche com o nome da própria tabela (não um genérico
      // "resultado" sempre igual) + sufixo "_datalock", pra ficar claro
      // que passou pelo processamento e pra não se perder entre vários
      // arquivos exportados com o mesmo nome de origem.
      const tab = activeTab.value;
      const base = (tab && tab.name ? tab.name : "resultado").replace(/[\\/:*?"<>|]/g, "").trim() || "resultado";
      exportFilename.value = `${base}_datalock`;
      exportAllTabs.value = false;
      showExportPanel.value = true;
    }
    async function doExport() {
      const tab = activeTab.value;
      try {
        if (exportAllTabs.value && canExportAllTabs.value) {
          await engine.exportDlkFrames(
            tabs.map((t) => ({ tableId: t.tableId, steps: JSON.parse(JSON.stringify(t.steps)), name: t.name })),
            { salt: salt.value || null, key: dlkKey.value || null },
            { format: exportFormat.value, filenameBase: exportFilename.value, neutralizeFormulas: exportNeutralize.value }
          );
        } else {
          await engine.exportResult(
            tab.tableId,
            JSON.parse(JSON.stringify(tab.steps)),
            { salt: salt.value || null, key: dlkKey.value || null },
            { format: exportFormat.value, filenameBase: exportFilename.value, neutralizeFormulas: exportNeutralize.value }
          );
        }
        showExportPanel.value = false;
        toast("Arquivo exportado.");
      } catch (err) {
        tab.errorMessage = formatError(err);
      }
    }

    return {
      toasts, dismissToast, showShortcuts, shortcutList, exportNeutralize, openDataFolder,
      recentFiles, clearRecentFiles, restoreDraft, dismissDraft, formatDraftDate, serverInfo,
      engineMode, engineBooting, servedByBackend, connectingToServer, serverConnectError, serverConnectNote, connectToLocalSoftware, requestConnect, confirmConnect, showConnectInfo,
      tabs, activeTabId, activeTab,
      theme, toggleTheme, isDarkNow, icon,
      accentColorOptions: ACCENT_OPTIONS, accentColor, density, stepsPosition, showSettingsPanel,
      setAccentColor, setDensity, setStepsPosition,
      showOnboarding, onboardingStep, onboardingSlides: ONBOARDING_SLIDES,
      nextOnboarding, prevOnboarding, finishOnboarding, startOnboarding,
      showHelpGuide,
      salt, saltVisible, saltStrength, dlkKey, dlkKeyVisible, dlkKeyStrength,
      showStepPicker, stepSearchQuery, filteredStepTypes, draftStep, showPiiPanel,
      showEdaPanel, edaLoading, edaError, edaResult, openEdaPanel, closeEdaPanel,
      showUnmaskPanel, unmaskColumns, unmaskError,
      showExportPanel, showAbout, exportFormat, exportFilename, exportAllTabs, canExportAllTabs, openExportPanel,
      showDbPanel, dbUri, dbUriVisible, dbConnectionId, dbConnecting, dbConnectError,
      dbTablesList, dbSqlQuery, dbReadError, dbWriteTableName, dbWriteMode,
      dbUpsertColumns, dbWriteError, dbWriteSuccess,
      openDbPanel, connectDb, connectSqliteFile, connectSqlite, downloadSqlite, dbBrowserName, disconnectDb, openDbTableAsTab, runDbSqlAsTab, sendActiveTabToDb,
      showJobsPanel, jobsList, jobsLoading, jobsListError, jobFormOpen, editingJobId, jobDraft,
      jobStepsJsonText, jobFormError, jobUpsertOnText, jobRunsFor, jobRunsList,
      openJobsPanel, startNewJob, editJob, useActiveTabStepsInJob, cancelJobForm, saveJob,
      deleteJobConfirm, toggleJobEnabled, runJobNowClick, viewJobRuns, closeJobRuns, formatTimestamp,
      complianceOrg, complianceDataset, complianceFormat, complianceError, generateComplianceReport,
      complianceManualPiiColumns,
      privacyQuasiIds, privacyMetricsResult, privacyMetricsError, runPrivacyMetrics,
      showDiffPanel, diffResult, diffError, openDiffPanel,
      showDlkToolsPanel, dlkInspectFile, dlkInspectKey, dlkInspectKeyVisible, dlkInspectResult, dlkInspectError,
      dlkRekeyFile, dlkRekeyOldKey, dlkRekeyNewKey, dlkRekeyError, dlkRekeySuccess,
      openDlkToolsPanel, onDlkInspectFilePicked, onDlkRekeyFilePicked, doDlkInspect, doDlkRekey,
      showScanDirPanel, scanDirPath, scanDirFiles, scanDirFolderName, onScanDirPicked, scanDirRecursive, scanDirMinRisk, scanDirResult, scanDirError,
      openScanDirPanel, doScanDirectory,
      showAuditPanel, auditEnabled, auditPath, auditWebhook, auditConfigError,
      auditLogEntries, auditLogError, auditSavePath, auditSaveKey, auditSaveSuccess,
      openAuditPanel, applyAuditConfig, refreshAuditLog, doAuditSave,
      pendingEncryptedFile, showKeyPrompt, keyPromptValue, keyPromptVisible, keyPromptError,
      onFilePicked, onDrop, isDraggingOver, isLoadingFile, loadingFileName, loadError, openFilePicker, reset, closeTab, selectTab,
      GRID_PAGE_SIZE, gridSearchChanged, gridNextPage, gridPrevPage,
      chartableStepType, toggleChart,
      undoStep, redoStep,
      openStepPicker, startNewStep, editStep, cancelStepEdit,
      confirmStep, removeStep, toggleStep, dragStart, dropOn, toggleRowsCondition,
      stepTypeMeta, stepLabel, stepDescription, formatCell, generateSalt, saveRecipe,
      onRecipePicked, doExport, openUnmaskPanel, doUnmask, copyErrorMessage,
      confirmKeyPrompt, cancelKeyPrompt,
    };
  },
}).mount("#app");
