# Segurança — datalock Studio

## Modelo de ameaças (o que o Studio protege e o que não protege)

O Studio roda **na sua máquina** e processa dados que podem ser sensíveis. Nada é enviado a servidores nossos.

| Ameaça | Proteção |
|---|---|
| Outro site aberto no navegador chamando a API local ("localhost drive-by") | CORS restrito + checagem do header `Origin` em toda requisição |
| DNS rebinding (um domínio que passa a apontar para 127.0.0.1) | O header `Host` precisa ser de loopback; qualquer outro é recusado (HTTP 400) |
| Outro processo ou outro usuário da máquina chamando a API | Token aleatório por execução (`X-DL-Token`), injetado só na página servida pelo próprio programa |
| Script injetado na interface | CSP restritiva: só `'self'`, sem origem externa (a única exceção é o `unsafe-eval` exigido pelo Vue); nenhum `innerHTML`/`eval` no código; todo `v-html` é ícone embutido |
| Relatório HTML com nome de coluna malicioso (CSV não confiável) | Escape no relatório do navegador **e** CSP que proíbe scripts no HTML gerado (também o da biblioteca) |
| Injeção de fórmulas ao abrir CSV/XLSX exportado no Excel | Células de texto começando com `=`, `+`, `-`, `@` ganham `'` (desligável na exportação; números e telefones não mudam) |
| Cópias de dados sensíveis esquecidas em `%TEMP%` | Exportações, relatórios e rekey são apagados depois do download |
| Nome de arquivo malicioso na exportação (`../../x`) | `safe_filename_component()` |
| Receita `.json` de terceiros com regex lenta | Limite de 3 s por passo de regex |
| Upload gigante enchendo o disco | Limite de 4 GB (variável `DATALOCK_STUDIO_MAX_UPLOAD_MB`) |
| Erro interno vazando uma página de erro crua | Handler global: resposta JSON genérica, traceback só no log local |

**O que NÃO é protegido:** um programa malicioso rodando com a **sua** conta já pode ler seus arquivos direto, e
portanto também pode ler `~/.datalock_studio` e o token em memória. O Studio não tenta se defender disso.
Também não há criptografia do `secrets.env` (salts de automações): proteja a pasta do seu usuário.

## Dados que ficam no disco (`~/.datalock_studio`)
`desktop.log` (diagnóstico, sem conteúdo de tabelas), `state.json` (preferências, receitas-rascunho e nomes de arquivos
recentes — uma receita pode conter valores que você digitou num filtro), `jobs/` (automações) e, se você criar,
`secrets.env` e `allowed_origins.txt`.

## Dependências de terceiros
Vue, PapaParse, SheetJS, Chart.js e as fontes IBM Plex ficam empacotados em `web/vendor` e `web/fonts` (sem CDN no
programa instalado). A **prévia hospedada** ainda carrega, sob demanda, bibliotecas do jsDelivr para Parquet, `.dlk`,
SQLite e PDF — ver `web/privacy.html`.

## Reportar uma vulnerabilidade
Escreva para **leoborgesprofissional@gmail.com** com passos para reproduzir. Por favor, não abra uma issue pública antes
de uma correção estar disponível.
