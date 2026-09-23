# Sistema de design — datalock Studio

Este documento registra as decisões de design desta reavaliação — não é
obrigatório para rodar o software, é referência para manter consistência
em telas futuras.

## Diagnóstico da versão anterior

A primeira versão usava o "kit SaaS genérico": azul padrão do Tailwind
(`#2563eb`), cartões brancos com sombra cinza suave, emoji cru como
ícone, um tema só (claro), tipografia do sistema sem nenhuma intenção.
Funcional, mas lê como protótipo — não como ferramenta profissional.

## Referência de categoria

O produto é uma ferramenta técnica de manipulação e anonimização de
dados, para analistas, DBAs e profissionais de privacidade — não um
site de marketing. A referência certa é **Linear, Raycast, GitHub,
DBeaver/TablePlus, 1Password**: densas, precisas, confiáveis, com dark
mode de primeira classe. Não a referência de landing page de SaaS.

## Paleta

Base neutra em grafite (não preto/branco puros), um único acento de cor
usado com moderação (ações primárias, estados ativos, foco), e cores
semânticas discretas (não "doces"/neon).

| Token | Claro | Escuro | Uso |
|---|---|---|---|
| `--bg` | `#F5F6F8` | `#0C0E12` | Fundo da página |
| `--surface` | `#FFFFFF` | `#14171D` | Cartões, barras, modais |
| `--surface-sunken` | `#F0F1F4` | `#0F1115` | Áreas "rebaixadas" (linhas hover, blocos aninhados) |
| `--border` | `#E1E4E9` | `#262B34` | Divisórias |
| `--text` / `--text-muted` / `--text-faint` | grafite em 3 níveis | idem, invertido | Hierarquia de texto |
| `--accent` | `#4F46E5` | `#7C79F5` | Ações primárias, foco, ícones de destaque |
| `--success` / `--danger` / `--warn` / `--info` | tons desaturados | idem, ajustados para contraste em fundo escuro | Estados semânticos, badges de risco de PII |

O acento (`#4F46E5`/`#7C79F5`, um índigo-violeta) foi escolhido por ser
distinto tanto do azul genérico de frameworks (`#2563eb`, usado por
metade dos dashboards SaaS) quanto do terracota (`#D97757`) que costuma
aparecer em designs "gerados" — evita as duas armadilhas mais comuns.

## Temas disponíveis

Três modos, alternáveis pelo botão de sol/lua na barra superior:

1. **Automático** (padrão) — segue a preferência do sistema operacional
   (`prefers-color-scheme`).
2. **Claro** — forçado, independente do sistema.
3. **Escuro** — forçado, independente do sistema.

A escolha é salva no navegador (`localStorage`) e persiste entre sessões.

## Tipografia

**IBM Plex Sans** (interface) + **IBM Plex Mono** (dados e valores) — a
mesma família em dois cortes, escolhida pelo caráter técnico/"engenharia
de dados" que carrega, mais deliberada que a onipresente Inter.

O monoespaçado é usado especificamente em: valores de células da grade,
o campo de Salt/chave, a descrição de cada passo aplicado (que mostra
nomes de colunas/valores), e a primeira coluna da tabela de detecção de
PII — em qualquer lugar em que colunas alinhadas ou valores "crus"
aparecem, como em qualquer ferramenta de banco de dados.

## Ícones

Conjunto de ícones em SVG inline, estilo linha (`stroke`, sem `fill`),
substituindo os emojis da primeira versão — ver `web/js/icons.js`. A
consistência entre ícones (mesmo peso de traço, mesmo viewBox) é o que dá
a sensação de "kit desenhado" — mais importante que o realismo de cada
ícone individualmente.

## Padrões de interação escolhidos deliberadamente

- **Command palette** (busca + lista) para escolher o tipo de passo a
  adicionar, no lugar de uma grade de cartões coloridos — é o padrão de
  toda ferramenta profissional moderna (Cmd+K do Linear/Raycast/Notion) e
  fica melhor com uma lista longa (14+ tipos de passo) do que uma grade.
- **Drawer lateral** (painel deslizando da direita) para editar um passo,
  no lugar de um modal centralizado — modais centralizados fazem sentido
  para confirmações curtas; um formulário mais longo (o editor de um
  passo) se comporta melhor ancorado, como em Airtable/Notion/Retool.
- Modais centralizados continuam sendo usados só onde fazem sentido:
  confirmações curtas, painéis informativos (PII, Sobre, pedir chave).

## O que não mudou de propósito

A densidade de informação, a estrutura de três painéis (barra de
ferramentas / grade / passos aplicados) e a lista de tipos de passo
continuam as mesmas — o problema reportado era estético, não estrutural.
