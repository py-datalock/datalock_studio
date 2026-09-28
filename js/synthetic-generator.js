/**
 * synthetic-generator.js
 * ======================
 * Porta em JS de `datalock/generators/synthetic.py` (`SyntheticGenerator`)
 * — mesmas listas de nomes/domínios/DDDs, mesmo algoritmo de dígito
 * verificador de CPF/CNPJ, para gerar dados falsos estruturalmente válidos
 * sem NENHUMA dependência extra (a versão Python usa o Faker se instalado,
 * para mais variedade; aqui não — mas os valores gerados são igualmente
 * válidos, só vindos de uma lista menor).
 *
 * Determinístico por seed: um PRNG simples (mulberry32) substitui o
 * `random.Random` do Python — não é o MESMO gerador (então os valores não
 * batem entre os dois lados byte-a-byte, diferente do hash/AES-SIV), mas
 * tem a mesma propriedade que importa aqui: mesma seed → mesma sequência.
 */

const _NOMES_BR = [
  "Ana","João","Maria","Pedro","Carlos","Fernanda","Lucas","Juliana","Roberto","Patrícia",
  "Paulo","Amanda","Felipe","Camila","Rafael","Letícia","Eduardo","Mariana","Bruno","Aline",
  "Gustavo","Vanessa","Rodrigo","Tatiana","Marcelo","Priscila","Daniel","Larissa","Diego","Cláudia",
  "Thiago","Sandra","Leandro","Renata","Vinicius","Fabiana","André","Michele","Henrique","Cristiane",
];
const _SOBRENOMES_BR = [
  "Silva","Santos","Oliveira","Souza","Rodrigues","Ferreira","Alves","Pereira","Lima","Gomes",
  "Costa","Ribeiro","Martins","Carvalho","Araújo","Melo","Barbosa","Rocha","Cardoso","Nascimento",
  "Correia","Dias","Teixeira","Moraes","Ramos","Nunes","Moreira","Castro","Leal","Pinto",
];
const _DOMINIOS = [
  "gmail.com","hotmail.com","yahoo.com.br","outlook.com","icloud.com",
  "empresa.com.br","trabalho.com.br","corp.com.br","uol.com.br","terra.com.br",
];
const _DDDS = ["11","12","13","14","15","16","17","18","19","21","22","24","27","28","31","32","33",
  "34","35","37","38","41","42","43","44","45","46","47","48","49","51","53","54","55",
  "61","62","63","64","65","66","67","68","69","71","73","74","75","77","79","81","82",
  "83","84","85","86","87","88","89","91","92","93","94","95","96","97","98","99"];
const _UFS = ["SP","RJ","MG","RS","BA","PR","SC","GO","PE","CE","PA","MT","ES","MS","PB","RN","AL",
  "PI","SE","RO","TO","AC","AP","RR","DF","AM","MA"];

/** PRNG determinístico simples (mulberry32) — só precisa ser "bom o
 * suficiente" pra gerar dados falsos plausíveis, não criptográfico. */
function _mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SyntheticGenerator {
  constructor(seed = 42) {
    this._rand = _mulberry32(seed);
  }
  _randInt(min, max) { return Math.floor(this._rand() * (max - min + 1)) + min; }
  _choice(arr) { return arr[this._randInt(0, arr.length - 1)]; }

  cpf() {
    let d;
    do { d = Array.from({ length: 9 }, () => this._randInt(0, 9)); }
    while (new Set(d).size === 1); // rejeita sequências tipo 111111111
    const s1 = d.reduce((acc, v, i) => acc + (10 - i) * v, 0);
    const r1 = s1 % 11;
    const d1 = r1 < 2 ? 0 : 11 - r1;
    const d2list = [...d, d1];
    const s2 = d2list.reduce((acc, v, i) => acc + (11 - i) * v, 0);
    const r2 = s2 % 11;
    const d2 = r2 < 2 ? 0 : 11 - r2;
    const n = [...d, d1, d2];
    return `${n[0]}${n[1]}${n[2]}.${n[3]}${n[4]}${n[5]}.${n[6]}${n[7]}${n[8]}-${n[9]}${n[10]}`;
  }

  cnpj() {
    const n = [...Array.from({ length: 8 }, () => this._randInt(0, 9)), 0, 0, 0, 1];
    const p1 = [5,4,3,2,9,8,7,6,5,4,3,2];
    const s1 = p1.reduce((acc, p, i) => acc + p * n[i], 0);
    const d1 = (s1 % 11) < 2 ? 0 : 11 - (s1 % 11);
    const n2 = [...n, d1];
    const p2 = [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const s2 = p2.reduce((acc, p, i) => acc + p * n2[i], 0);
    const d2 = (s2 % 11) < 2 ? 0 : 11 - (s2 % 11);
    const x = [...n, d1, d2];
    return `${x[0]}${x[1]}.${x[2]}${x[3]}${x[4]}.${x[5]}${x[6]}${x[7]}/${x[8]}${x[9]}${x[10]}${x[11]}-${x[12]}${x[13]}`;
  }

  email() {
    const nome = this._choice(_NOMES_BR).toLowerCase();
    const sobrenome = this._choice(_SOBRENOMES_BR).toLowerCase();
    const dominio = this._choice(_DOMINIOS);
    const sep = this._choice([".", "_", ""]);
    return `${nome}${sep}${sobrenome}@${dominio}`;
  }

  nome() { return `${this._choice(_NOMES_BR)} ${this._choice(_SOBRENOMES_BR)}`; }

  telefone() {
    const ddd = this._choice(_DDDS);
    const num = this._randInt(90000000, 99999999).toString();
    return `(${ddd}) ${num.slice(0, 5)}-${num.slice(5)}`;
  }

  cep() {
    const n = this._randInt(1000000, 99999999).toString().padStart(8, "0");
    return `${n.slice(0, 5)}-${n.slice(5)}`;
  }

  dataNascimento() {
    const year = this._randInt(1940, 2005);
    const month = this._randInt(1, 12);
    const day = this._randInt(1, 28);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  rg() {
    const n = this._randInt(10000000, 99999999).toString();
    return `${n.slice(0, 2)}.${n.slice(2, 5)}.${n.slice(5, 8)}-${this._randInt(0, 9)}`;
  }

  uf() { return this._choice(_UFS); }

  /** Gera pelo tipo de PII (mesmos nomes usados por pii-detect.js/dataframe.js). */
  generate(piiType) {
    const dispatch = {
      cpf: () => this.cpf(), cnpj: () => this.cnpj(), email: () => this.email(),
      nome: () => this.nome(), name: () => this.nome(),
      telefone: () => this.telefone(), phone: () => this.telefone(),
      cep: () => this.cep(), postal_code: () => this.cep(),
      data_nascimento: () => this.dataNascimento(), nascimento: () => this.dataNascimento(), date: () => this.dataNascimento(),
      rg: () => this.rg(), uf: () => this.uf(), state: () => this.uf(),
    };
    const key = String(piiType).toLowerCase().replace(/[ -]/g, "_");
    return dispatch[key] ? dispatch[key]() : "[SYNTHETIC]";
  }
}

/**
 * Gera uma tabela sintética SEM nenhuma dependência — mesma estratégia do
 * software completo (ver `recipe_engine.py#_synthetic_fast`): sorteia
 * LINHAS INTEIRAS com reposição (preserva correlação entre colunas, ex.:
 * idade acompanhando salário, muito melhor que sortear cada coluna
 * independentemente), regenera colunas de PII do zero (nunca reaproveita
 * do bootstrap — isso devolveria nomes/CPFs reais), e adiciona um ruído
 * leve (5% do desvio padrão) nas colunas numéricas restantes.
 *
 * @param {{columns: string[], rows: object[]}} table
 * @param {Record<string, {type}>} piiReport  Resultado de scanForPii(table).
 * @param {number} n
 * @param {number} seed
 */
export function generateSyntheticTable(table, piiReport, n, seed = 42) {
  const gen = new SyntheticGenerator(seed);
  const randRow = _mulberry32(seed);
  const randNoise = _mulberry32(seed ^ 0x9e3779b9); // stream separado, não correlacionado com o bootstrap
  const nameHints = ["nome", "name"];

  const sourceRows = table.rows;
  const bootIdx = Array.from({ length: n }, () => Math.floor(randRow() * sourceRows.length));
  const rows = bootIdx.map((i) => ({ ...sourceRows[i] }));

  const piiCols = new Set();
  for (const col of table.columns) {
    const report = piiReport[col];
    const looksLikeName = !report && nameHints.some((h) => col.toLowerCase().includes(h));
    const piiType = report ? report.type : (looksLikeName ? "nome" : null);
    if (piiType) {
      piiCols.add(col);
      for (const row of rows) row[col] = gen.generate(piiType);
    }
  }

  // Normal padrão via Box-Muller — só para o ruído das colunas numéricas.
  function randNormal() {
    const u1 = Math.max(randNoise(), 1e-12), u2 = randNoise();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  for (const col of table.columns) {
    if (piiCols.has(col)) continue;
    const values = sourceRows.map((r) => r[col]).filter((v) => typeof v === "number" && Number.isFinite(v));
    if (values.length < 2) continue; // não é numérico (ou não tem dado suficiente) — deixa como veio do bootstrap
    const mean = values.reduce((a, v) => a + v, 0) / values.length;
    const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);
    if (!std) continue;
    const isInt = values.every((v) => Number.isInteger(v));
    for (const row of rows) {
      if (typeof row[col] !== "number") continue;
      const noised = row[col] + randNormal() * std * 0.05;
      row[col] = isInt ? Math.round(noised) : noised;
    }
  }

  return { columns: [...table.columns], rows };
}
