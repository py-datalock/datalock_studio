<div align="center">

# datalock Studio — Prévia web

**Anonimização e manipulação de dados sem escrever código.**

🔗 **[Abrir a prévia](#)** &nbsp;·&nbsp; ⬇️ **[Baixar o software completo (.exe)](#)** *(veja a raiz deste repositório)*

</div>

---

## O que é

O **datalock Studio** é uma interface visual para tratar planilhas e
bases de dados — filtrar, limpar, cruzar, anonimizar — sem abrir um
notebook e sem escrever Python. Pense num "Power Query" ou numa versão
simplificada do Excel, desenhado especificamente para quem lida com
dados sensíveis no dia a dia: analistas, DBAs, times de privacidade e
compliance.

Você importa um arquivo, monta uma sequência de passos clicando em menus
(filtrar linhas, mascarar uma coluna de CPF, agrupar por estado, exportar
como planilha), e vê o resultado atualizar ao vivo, linha por linha.

Este repositório contém a **prévia web** — a versão que roda 100% no seu
navegador, sem instalar nada. Para as funções mais sensíveis (reversão de
mascaramento, criptografia de arquivo, banco de dados, automações), use o
**software completo**, disponível para download logo abaixo.

## Esta prévia × o software completo

|  | 🌐 Esta prévia (web) | 💻 Software completo (.exe) |
|---|:---:|:---:|
| Onde roda | No seu navegador | Na sua máquina, como um programa |
| Instalação | Nenhuma | Baixar e abrir o `.exe` |
| Importar CSV / XLSX / JSON | ✅ | ✅ |
| Filtrar, ordenar, agrupar, pivot, colunas calculadas | ✅ | ✅ |
| Detectar dados pessoais (CPF, e-mail, telefone...) | ✅ (heurística) | ✅ (detector completo) |
| Anonimizar (hash, redação, truncagem...) | ✅ | ✅ |
| **Anonimização reversível** (criptografia + reverter depois) | ❌ | ✅ |
| Importar/exportar **Parquet** e o formato **`.dlk`** (com ou sem criptografia) | ❌ | ✅ |
| **Banco de dados** (ler e escrever tabelas) | ❌ | ✅ |
| **Automações** (pasta/banco → receita → pasta/banco, sozinho) | ❌ | ✅ |
| Sai algum dado da sua máquina? | Não — tudo no navegador | Não — tudo local |

A prévia web **detecta sozinha** quando o software completo está aberto
na sua máquina (`http://127.0.0.1:8722`) e passa a usar o motor real por
trás — sem precisar trocar de link.

## Como baixar o software completo

O instalador (`datalock-studio.exe`) está disponível na **raiz deste
repositório** — baixe o arquivo, salve onde quiser, e dê duplo clique
para abrir. Não precisa instalar Python nem nenhuma outra dependência.

> O `.exe` roda 100% localmente na sua máquina — nenhum dado é enviado
> para nenhum servidor externo, nem mesmo durante o uso das automações
> ou da conexão com bancos de dados (a menos que você mesmo configure uma
> conexão remota).

## Publicando esta prévia (para quem for clonar/fazer fork)

Site estático, sem build step:

1. Faça fork ou clone este repositório.
2. No GitHub: **Settings → Pages → Build and deployment → Source** →
   "Deploy from a branch" → escolha a branch (`main`) e a pasta
   `/ (root)`.
3. Aguarde alguns minutos — o link fica em
   `https://SEU_USUARIO.github.io/SEU_REPOSITORIO/`.

Também dá para rodar localmente, sem publicar nada:

```bash
python3 -m http.server 8080
# abra http://localhost:8080
```

(Não abra o `index.html` com duplo clique — alguns recursos usados aqui
são bloqueados pelo navegador em arquivos abertos direto do disco.)

## Dependências (via CDN, carregadas pelo `index.html`)

- [Vue 3](https://vuejs.org/) (build global, sem bundler)
- [PapaParse](https://www.papaparse.com/) (leitura/escrita de CSV)
- [SheetJS/xlsx](https://sheetjs.com/) (leitura/escrita de Excel)

Nenhuma delas envia dados para fora — tudo roda no navegador de quem usa
a página.

## Licença

Este software é **proprietário** — ver [`LICENSE`](./LICENSE). O
código desta prévia web é publicado para poder ser executado
diretamente no seu navegador (é como qualquer página web funciona), o
que não constitui autorização para copiar, redistribuir ou reutilizar o
código fora do uso pretendido da própria prévia.

O datalock Studio consome a biblioteca **`datalock`**, disponibilizada
separadamente pelo mesmo autor sob licença **AGPLv3** (código aberto) —
ver o repositório próprio da biblioteca para seus termos, que são
independentes da licença deste software.
