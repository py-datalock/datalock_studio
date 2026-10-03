# datalock Studio — versão web

Interface no-code para limpar, transformar e anonimizar dados (compatível com a LGPD), sem escrever código.
Esta pasta é o site: **https://datalock-studio.tech**

O datalock Studio existe em duas versões que compartilham a mesma interface:

| | Prévia web (este site) | Software completo (Windows) |
|---|---|---|
| Onde roda | No seu navegador | No seu computador (Microsoft Store ou `.exe`) |
| Instalação | Nenhuma | Sim |
| Motor de dados | JavaScript (prévia) | Biblioteca `datalock` em Python |
| Seus dados | Não saem do navegador | Não saem do computador |
| Funciona offline | Parcialmente | Sim |
| Arquivos grandes | Limitado pela memória do navegador | Muito mais folga |

A prévia serve para conhecer e para tarefas leves. Para uso sério, prefira o software completo.

## O que dá para fazer

- Abrir CSV, XLSX, JSON, Parquet e `.dlk` (vários arquivos de uma vez; planilhas e tabelas viram abas).
- Montar uma **receita** de passos: filtrar, ordenar, renomear, selecionar colunas, remover duplicados, preencher
  nulos, criar colunas derivadas, dividir e juntar colunas, agrupar, entre outros.
- **Detectar dados pessoais** (CPF, e-mail, telefone etc.) e **mascarar** com hash, redação, truncamento, supressão
  ou cifra reversível.
- Gerar **EDA automática**, **relatório de conformidade LGPD** (HTML, JSON e PDF) e comparar "o que mudou".
- Salvar e reabrir receitas (`.json`) para repetir o mesmo tratamento em outros arquivos.
- Exportar para CSV, Excel, JSON, Parquet e `.dlk` (com ou sem criptografia AES-256-GCM).
- Dados sintéticos, avaliação rápida de k-anonimato e trilha de auditoria.

Só no **software completo**: avaliação de privacidade completa, conexão com bancos de dados, varredura de pastas,
automações agendadas e arquivos grandes.

## Privacidade

- Na prévia, os arquivos são lidos **no seu navegador** e não são enviados a nenhum servidor nosso.
- O site não usa cookies de rastreamento nem ferramentas de análise.
- Fontes e as principais bibliotecas (Vue, PapaParse, SheetJS, Chart.js) são servidas pelo próprio site.
- Algumas funções carregam bibliotecas do jsDelivr **só quando você as usa**: Parquet, `.dlk`, SQLite no navegador e
  PDF. Detalhes em [`privacy.html`](privacy.html).
- O **salt** e as **chaves** que você digita ficam só na memória da aba e somem ao fechá-la.
- Fechar a aba descarta o trabalho. Salve a receita antes (o site avisa se houver passos não salvos).

## Conectar ao software completo (opcional)

Se você tem o datalock Studio instalado, pode usar o motor completo a partir desta página:

1. Abra o programa instalado.
2. No site, clique no selo do topo ("Prévia no navegador — conectar ao software completo").
3. Leia a explicação e clique em **Continuar**. O navegador vai perguntar se esta página pode "acessar outros apps
   e serviços neste dispositivo". Isso é esperado: é só a conexão com o programa na sua própria máquina
   (`127.0.0.1`). Nenhum dado sai do computador por causa dessa permissão.
4. Libere esta página no programa, criando o arquivo `~/.datalock_studio/allowed_origins.txt`
   (no Windows, `C:\Users\SEU_USUARIO\.datalock_studio\allowed_origins.txt`) com a linha:

```
   https://datalock-studio.tech
```

   Reinicie o programa depois de criar o arquivo.

A página **não tenta** falar com o seu computador ao abrir: isso só acontece depois do seu clique. Se preferir não
conectar, a prévia continua funcionando normalmente.

## Baixar o software completo

- **Microsoft Store (recomendado):** instalação assinada e atualizações automáticas.
- **Instalador direto (`.exe`):** disponível na página de [Releases](../../releases/latest) do repositório. Por não
  ser assinado, o Windows SmartScreen pode exibir um aviso na primeira execução.

## Atalhos de teclado

| Atalho | Ação |
|---|---|
| `Ctrl O` | Abrir arquivo |
| `Ctrl S` | Salvar a receita |
| `Ctrl Z` / `Ctrl Y` | Desfazer / refazer |
| `Ctrl F` | Buscar na tabela |
| `Ctrl /` | Lista de atalhos |
| `Esc` | Fechar o painel aberto |

## Rodar localmente

A página é estática (sem build). Qualquer servidor de arquivos serve:

```bash
cd web
python -m http.server 8000
# abra http://localhost:8000
```

Não abra o `index.html` com duplo clique (`file://`): os módulos JavaScript exigem `http://`.

## Estrutura

```
web/
├── index.html          interface (Vue 3, sem build step)
├── privacy.html        política de privacidade
├── css/
│   ├── boot.css        estilo de inicialização (esconde o conteúdo cru e estiliza o carregamento)
│   └── style.css       tema claro/escuro, densidade, cores
├── js/
│   ├── app.js          estado e lógica da interface
│   ├── engine.js       escolhe o motor por tabela (prévia JS ou software completo)
│   ├── engine-client.js / engine-server.js
│   ├── file-io.js, dlk.js, pii-detect.js, risk-score.js, ...
│   ├── a11y.js         foco, Esc e papéis ARIA nos diálogos
│   └── boot.js         aviso se o carregamento demorar
├── vendor/             Vue, PapaParse, SheetJS, Chart.js (sem CDN)
├── fonts/              IBM Plex Sans e Mono
├── DESIGN.md           decisões de design
├── CNAME               domínio do site (não apagar)
└── robots.txt, sitemap.xml, llms.txt
```

## Publicação (GitHub Pages)

1. Publique o conteúdo desta pasta na raiz do repositório do site, **incluindo `vendor/` e `fonts/`**. Sem eles,
   a página quebra.
2. Mantenha o arquivo `CNAME`. Sem ele, o Pages derruba o domínio personalizado.
3. Não versione binários grandes (`.exe`) aqui: o GitHub recusa arquivos acima de 100 MB. Use os Releases.
4. Depois de publicar, abra o site com `Ctrl+F5` para ignorar o cache.

## Limites conhecidos da prévia

- Arquivos muito grandes podem esgotar a memória do navegador.
- Mascaramentos aleatórios (`mock_numeric`, `mock_category`) variam a cada execução na prévia e são determinísticos
  no software completo.
- Parquet gerado no navegador não é comprimido (o software completo usa zstd).
- Algumas funções carregam bibliotecas externas sob demanda e, por isso, exigem internet.

## Segurança

Veja o arquivo `SECURITY.md` (referente a versão completa)

## Licença

Veja o arquivo `LICENSE` (referente a versão completa)