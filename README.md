# datalock Studio, Prévia web

**Já está publicada em https://datalock-studio.tech.** Esta pasta é o
código fonte dela, caso queira publicar sua própria cópia.

Site estático, sem build step, sem dependências de servidor. Publica no
GitHub Pages em poucos passos.

## Publicar no GitHub Pages

1. Crie um repositório no GitHub (pode ser este mesmo, o `datalock-studio`,
   ou um novo só para o site).
2. Coloque o conteúdo desta pasta (`web/`) na raiz do repositório — ou,
   se preferir manter a estrutura do projeto inteiro (com `server/` junto),
   configure o Pages para publicar a partir da pasta `/web` (ver passo 4).
3. Faça commit e push:
   ```bash
   git add web/
   git commit -m "Publica prévia web do datalock Studio"
   git push
   ```
4. No GitHub: **Settings → Pages → Build and deployment → Source**:
   escolha "Deploy from a branch", selecione a branch (ex.: `main`) e a
   pasta (`/ (root)` se você colocou o conteúdo de `web/` na raiz, ou
   `/web` se manteve a estrutura completa do repositório — o GitHub Pages
   só permite `/ (root)` ou `/docs`, então se quiser publicar a partir de
   `/web` sem mover arquivos, crie um workflow do GitHub Actions simples
   (opção abaixo) ou copie/link a pasta `web/` para `docs/`).
5. Aguarde alguns minutos — o link fica em
   `https://SEU_USUARIO.github.io/SEU_REPOSITORIO/`.

### Alternativa simples: pasta `/docs`

Se preferir não mexer em Actions, o caminho mais direto é:

```bash
cp -r web docs
git add docs
git commit -m "Publica prévia via /docs"
git push
```

E no Pages, escolher a pasta `/docs` da branch principal.

## Rodar localmente (sem publicar)

Não precisa de nenhum servidor — é possível abrir `index.html` direto no
navegador com duplo clique. Alguns navegadores restringem `fetch()`/ES
modules em arquivos abertos via `file://`; se a prévia não carregar assim,
sirva a pasta com qualquer servidor estático simples:

```bash
cd web
python3 -m http.server 8080
# abra http://localhost:8080
```

## Como isso conversa com o software completo

Na prévia hospedada (GitHub Pages) a página não tenta falar com o seu computador ao abrir: isso só
acontece depois de um clique seu em "conectar ao software completo", que antes explica o pedido de
permissão do navegador ("acessar outros apps e serviços neste dispositivo"). No programa instalado
(.exe / Microsoft Store) não há clique nenhum: a própria página é servida pelo motor local e a
conexão é automática.

**Por que isso não é automático**: fazer essa checagem sozinha, a cada
carregamento de página, faz um site público conversar com um endereço de
rede local (`127.0.0.1`) sem o usuário pedir — em navegadores baseados em
Chromium isso pode disparar um aviso de permissão ("este site quer
acessar dispositivos na sua rede local"), o que pareceria (e seria)
suspeito para quem só está testando a prévia e nunca instalou o software
completo. Conectar por um clique explícito evita isso: o aviso, se
aparecer, aparece em resposta a uma ação que a própria pessoa pediu.

## O que a prévia já faz sozinha, sem o software completo

Além das transformações básicas (filtrar, ordenar, agrupar, etc.), a
prévia calcula 100% no navegador:

- Hash irreversível — byte-a-byte idêntico ao motor Python real
- **Criptografia reversível e reversão (AES-SIV)** — MESMO formato do
  software completo, testado byte-a-byte contra ele (ver `RECIPE_SCHEMA.md`)
- Leitura e escrita de **`.dlk`** (aberto e criptografado) e de **Parquet**
  — mesmo formato, só sem a compressão interna do software completo
  (arquivo um pouco maior). `.dlk` multi-frame (aberto e cifrado): leitura,
  escrita (exportar todas as abas juntas) e troca de chave, testados nos
  dois sentidos contra a biblioteca Python.
- Diff (o que mudou) e k-anonimato + **score composto de risco de reidentificação** (mesma fórmula da biblioteca, `web/js/risk-score.js`), com risco
  médio de reidentificação e registros únicos calculados de forma exata
- Relatório de conformidade em HTML, JSON e **PDF** (jsPDF, sob demanda)
- Ferramentas `.dlk` (inspecionar metadados, trocar chave) para arquivos
  de uma tabela só
- **Varrer pasta**: escolha a pasta e os arquivos são lidos localmente
  (`web/js/scan-files.js`)
- **Trilha de auditoria** em memória, com download assinado por
  HMAC-SHA256 (`web/js/audit-trail.js`)
- **Banco de dados SQLite**: abrir `.sqlite`/`.db` (ou criar um novo), ler
  tabelas/SQL como abas, enviar resultados (append/replace/upsert) e
  baixar o arquivo de volta, via sql.js (`web/js/sqlite-db.js`)
- **Dados sintéticos**: motores Rápido e Estatístico (cópula gaussiana,
  `web/js/synthetic-copula.js`)

Continuam exclusivos do software completo: bancos em rede (PostgreSQL,
MySQL...), automações de pasta/banco (precisam de um processo em segundo
plano), a medida de utilidade estatística (que nem a interface do
software completo expõe), o multi-frame com ACL (níveis de acesso por
frame) e a compressão interna do `.dlk` — ver `RECIPE_SCHEMA.md` para o
porquê de cada um.

## Dependências (via CDN, carregadas pelo `index.html`)

- [Vue 3](https://vuejs.org/) (build global, sem necessidade de bundler)
- [PapaParse](https://www.papaparse.com/) (leitura/escrita de CSV)
- [SheetJS/xlsx](https://sheetjs.com/) (leitura/escrita de Excel)

Carregadas sob demanda (só quando o recurso correspondente é usado, via
`import()` dinâmico a partir do jsdelivr — sem bundler):

- [hyparquet](https://github.com/hyparam/hyparquet) / [hyparquet-writer](https://github.com/hyparam/hyparquet-writer) (Parquet)
- [apache-arrow](https://arrow.apache.org/docs/js/) (payload interno do `.dlk`, Arrow IPC)
- [lz4js](https://github.com/Benzinga/lz4js) / [fzstd](https://github.com/101arrowz/fzstd) (compressão interna do `.dlk`/Arrow — só leitura)
- [@noble/ciphers](https://github.com/paulmillr/noble-ciphers) (AES-SIV e ChaCha20-Poly1305, para `.dlk`/criptografia reversível)
- [fflate](https://github.com/101arrowz/fflate) (abrir o `.zip` de um `.dlk` multi-frame)
- [sql.js](https://github.com/sql-js/sql.js) (SQLite em WebAssembly — painel de banco de dados)
- [jsPDF](https://github.com/parallax/jsPDF) (PDF do relatório de conformidade)

Nenhuma dessas bibliotecas envia dados para fora — tudo roda no navegador
de quem está usando a página.
