# datalock Studio — Prévia web

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

Ao carregar, a página tenta um `fetch("http://127.0.0.1:8722/health")`. Se
o [software completo](../server/README.md) estiver rodando na mesma
máquina, a prévia detecta automaticamente e passa a usar o motor real —
sem precisar mudar nada na URL nem reconfigurar. Isso funciona mesmo com
a prévia publicada no GitHub Pages (um domínio diferente) chamando o
`localhost` de quem está com a página aberta, porque a chamada é feita
pelo navegador de quem está usando, não por um servidor terceiro.

## Dependências (via CDN, carregadas pelo `index.html`)

- [Vue 3](https://vuejs.org/) (build global, sem necessidade de bundler)
- [PapaParse](https://www.papaparse.com/) (leitura/escrita de CSV)
- [SheetJS/xlsx](https://sheetjs.com/) (leitura/escrita de Excel)

Nenhuma dessas bibliotecas envia dados para fora — tudo roda no navegador
de quem está usando a página.
