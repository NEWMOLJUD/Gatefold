# Canone — Especificação

## 1. Visão geral

Canone é um sistema web low code para publicar e gerenciar sites **somente leitura**.

Os arquivos dos sites ficam em buckets de armazenamento. O Cloudflare R2 é o provedor principal, por não exigir credenciais; outros provedores (AWS S3, Google Cloud Storage e similares) também podem ser conectados, mediante suas credenciais. O sistema não hospeda conteúdo próprio: ele mapeia um **alias** de URL para um bucket e uma pasta (caminhos descentralizados), controla quem pode ler cada mapeamento e renderiza os arquivos no servidor usando um conjunto de propriedades (**props**) configuráveis.

### Princípios

- **Somente leitura.** Leitores nunca alteram o conteúdo das fontes.
- **O acesso é decidido pela fonte.** O que barra um leitor é a permissão sobre a fonte, nunca a lógica dentro de um template.
- **Tudo tem API.** Toda ação disponível nas páginas existe também em `/api/admin` ou `/api/reader`, para facilitar integrações.

## 2. Conceitos

| Termo | Significado |
|---|---|
| Fonte (*source*) | Mapeamento de um alias para um bucket e uma pasta inicial, em um provedor de armazenamento. |
| Provedor (*provider*) | Serviço onde o bucket está: R2, AWS S3, Google Cloud Storage etc. |
| Alias | Nome usado na URL no lugar do bucket e da pasta. |
| Props | Objeto JSON de propriedades disponível para os templates. |
| Leitor (*reader*) | Usuário que lê as fontes liberadas para ele. |
| Administrador (*admin*) | Usuário com permissão total no sistema. |
| Root | Senha de emergência definida em variável de ambiente. Não é uma conta. |

## 3. Papéis e permissões

| Ação | Root | Administrador | Leitor | Visitante sem login |
|---|---|---|---|---|
| Criar e remover administradores em `/root/setup` | Sim | — | — | — |
| Criar, editar e remover administradores | — | Sim | — | — |
| Criar, editar e remover fontes | — | Sim | — | — |
| Criar, editar e remover leitores | — | Sim | — | — |
| Conceder e revogar leitura de uma fonte | — | Sim | — | — |
| Editar os props da plataforma e das fontes | — | Sim | — | — |
| Gerar e revogar chaves de `/api/admin` | — | Sim | — | — |
| Ler fontes privadas liberadas para si | — | — | Sim | — |
| Editar os próprios props | — | — | Sim | — |
| Gerar e revogar as próprias chaves de `/api/reader` | — | — | Sim | — |
| Ler fontes públicas | Sim | Sim | Sim | Sim |

### Root

- A senha root é um segredo definido em variável de ambiente; nunca fica no banco nem no código.
- `/root/setup` é uma página pública que pede a senha root em um popup antes de qualquer ação. Funciona como a "BIOS" do sistema: serve para criar o primeiro administrador e para recuperar o acesso caso os administradores se percam.

### Administrador

Tem permissão total, inclusive sobre outros administradores.

### Leitor

Lê apenas as fontes privadas liberadas para ele e todas as fontes públicas.

## 4. Fontes

Cada fonte tem os campos:

| Campo | Tipo | Descrição |
|---|---|---|
| `id` | texto | Identificador gerado pelo sistema. |
| `provider` | texto | Provedor de armazenamento: `r2` (padrão), `s3`, `gcs` etc. |
| `name` | texto | Nome do bucket. |
| `path` | texto | Pasta inicial dentro do bucket. |
| `alias` | texto | Nome que substitui bucket e pasta na URL. Único no sistema. |
| `public` | booleano | `true`: qualquer pessoa acessa, sem login. `false`: só leitores com permissão. |
| `props` | objeto JSON | Props específicos da fonte. |
| `connection` | objeto | Dados e credenciais exigidos pelo provedor. Vazio para `r2`. |

### Provedores

Toda fonte funciona do mesmo jeito para o leitor, qualquer que seja o provedor. O que muda é o que o administrador informa no cadastro:

| Provedor | Dados de conexão | Credenciais |
|---|---|---|
| Cloudflare R2 (`r2`) | Nenhum além do nome do bucket. | Nenhuma: o bucket é ligado diretamente ao sistema. |
| AWS S3 (`s3`) | Região. | Chave de acesso e chave secreta. |
| Google Cloud Storage (`gcs`) | Projeto. | Chave de conta de serviço. |
| Compatível com S3 (`s3-compatible`) | Endereço do serviço e região. | Chave de acesso e chave secreta. |

Regras:

- O sistema só precisa de permissão de **leitura** no bucket; as credenciais informadas devem ter apenas esse acesso.
- Credenciais são guardadas cifradas e nunca são exibidas de volta, nem nas páginas nem na API. Para trocar, informa-se uma nova.
- Ao salvar uma fonte, o sistema testa a conexão e avisa se o bucket não puder ser lido.
- Novos provedores devem poder ser acrescentados sem mudar o restante do sistema: cada um implementa a mesma operação de "ler um arquivo do bucket".

### Resolução de caminho

```
/reader/view/<alias>/<arquivo>   →   bucket <name>, objeto <path>/<arquivo>
```

Exemplo: com `alias = rotas-plataforma`, `name = sites` e `path = plataforma/v1`, a URL `/reader/view/rotas-plataforma/index.html` entrega o objeto `plataforma/v1/index.html` do bucket `sites`.

## 5. Props

Existem três níveis de props, cada um um objeto JSON:

1. **Plataforma** — editado pelo administrador em `/admin/config`. Vale para todo o sistema.
2. **Fonte** — editado pelo administrador em `/admin/edit-source`. Vale para uma fonte.
3. **Leitor** — editado pelo próprio leitor em `/reader/config`. Vale para ele.

### Merge

Os três objetos são combinados nesta ordem, e o nível mais específico vence:

```
plataforma  <  fonte  <  leitor
```

O leitor pode sobrescrever **qualquer chave**. Por isso, props servem para personalizar a interface e nunca para controlar acesso.

Em fontes públicas acessadas sem login não há props de leitor: o merge usa apenas plataforma e fonte.

### Exemplo

Props da plataforma:

```json
{
  "site": "site.mateusmoutinho.com.br",
  "age": 28
}
```

Props do leitor:

```json
{
  "age": 30
}
```

Resultado do merge:

```json
{
  "site": "site.mateusmoutinho.com.br",
  "age": 30
}
```

## 6. Renderização

A renderização acontece no servidor, a cada requisição a `/reader/view/<alias>/<arquivo>`:

1. O sistema resolve o alias e verifica a permissão (fonte pública, ou leitor com acesso).
2. Carrega o arquivo do bucket.
3. Carrega e combina os props (seção 5).
4. Se o arquivo for de texto, passa pela engine de templates; caso contrário, é entregue como está.
5. Devolve o resultado.

### O que é renderizado

- **Arquivos de texto** (HTML, CSS, JS, JSON, SVG, TXT e similares): passam pela engine.
- **Arquivos binários** (imagens, PDFs, fontes tipográficas, vídeos): entregues sem alteração.

### Engine de templates

Sintaxe no estilo Liquid/Mustache, interpretada sem gerar código em tempo de execução (exigência do Cloudflare Workers):

```html
<h1>{{ props.site }}</h1>

{% if props.age >= 18 %}
  <p>Conteúdo adulto liberado.</p>
{% else %}
  <p>Conteúdo restrito.</p>
{% endif %}

<p>Página: {{ query.page }}</p>
<p>Idioma: {{ headers.accept-language }}</p>
```

Variáveis disponíveis no template:

| Variável | Conteúdo |
|---|---|
| `props` | Resultado do merge dos props. |
| `query` | Parâmetros de query da URL. |
| `headers` | Cabeçalhos da requisição. |

Requisitos da engine:

- Variáveis, `if`/`else` e laços.
- Valores escapados por padrão ao serem impressos em HTML.
- Um bloco "cru" (por exemplo `{% raw %}...{% endraw %}`) para trechos que não devem ser interpretados.
- Nenhuma execução de código arbitrário.

## 7. Fluxos

### Administrador

| Fluxo | Como |
|---|---|
| Entrar | Acessa `/admin/` e informa usuário e senha. |
| Adicionar leitor | Em `/admin/create-reader`, informa usuário e senha do leitor. |
| Editar ou remover leitor | Em `/admin/edit-reader`, altera os dados ou clica em remover. |
| Conceder ou revogar leitura | Em `/admin/edit-reader`, marca as fontes que o leitor pode ler. |
| Adicionar fonte | Em `/admin/create-source`, escolhe o provedor e informa bucket, pasta, alias, visibilidade, props e, se o provedor exigir, os dados de conexão e credenciais. |
| Editar ou remover fonte | Em `/admin/edit-source`. |
| Editar props da plataforma | Em `/admin/config`. |
| Gerenciar administradores | Em `/admin/list-admins`, `/admin/create-admin` e `/admin/edit-admin`. |
| Gerar chaves de API | Em `/admin/api-keys`. |

### Leitor

| Fluxo | Como |
|---|---|
| Entrar | Acessa `/reader/` e informa usuário e senha. |
| Ver fontes disponíveis | Acessa `/reader/list-sources`. |
| Acessar uma página | Acessa `/reader/view/<alias>/<arquivo>`; o sistema renderiza conforme a seção 6. |
| Personalizar a interface | Em `/reader/config`, edita o próprio JSON de props. |
| Gerar chaves de API | Em `/reader/api-keys`. |

### Root

| Fluxo | Como |
|---|---|
| Criar ou remover administrador | Acessa `/root/setup`, informa a senha root no popup e executa a ação. |

## 8. Páginas

### Leitor

| URL | Descrição |
|---|---|
| `/reader/` | Login do leitor. |
| `/reader/view/<alias>/<arquivo>` | Entrega o arquivo da fonte, trocando o alias por bucket e pasta. Dispensa login em fontes públicas. |
| `/reader/list-sources` | Lista as fontes que o leitor pode ler. |
| `/reader/config` | Edição do JSON de props do leitor. |
| `/reader/api-keys` | Geração e revogação das chaves de API do leitor. |

### Administrador

| URL | Descrição |
|---|---|
| `/admin/` | Login do administrador (usuário e senha). |
| `/admin/config` | Edição do JSON de props da plataforma. |
| `/admin/list-sources?<filtros>` | Lista as fontes, com busca por data de criação, quantidade de leitores e outros critérios. |
| `/admin/create-source` | Cadastro de fonte. |
| `/admin/edit-source?source-id=<id>` | Edição de provedor, conexão, bucket, pasta, alias, visibilidade e props da fonte; remoção da fonte. |
| `/admin/list-readers?source=<alias>&<filtros>` | Lista os leitores, com filtro por fonte, data de criação e outros critérios. |
| `/admin/create-reader` | Cadastro de leitor. |
| `/admin/edit-reader?reader-id=<id>` | Edição de nome, senha e fontes liberadas; remoção do leitor. |
| `/admin/list-admins?<filtros>` | Lista os administradores, com filtros. |
| `/admin/create-admin` | Cadastro de administrador. |
| `/admin/edit-admin?admin-id=<id>` | Edição e remoção de administrador. |
| `/admin/api-keys` | Geração e revogação das chaves de API de administrador. |

### Root

| URL | Descrição |
|---|---|
| `/root/setup` | Página pública protegida pela senha root. Cria e remove administradores. |

## 9. API

Tudo o que as páginas fazem está disponível em duas famílias de rotas:

| Prefixo | Público | Autenticação |
|---|---|---|
| `/api/admin/*` | Administradores | Sessão de administrador ou chave de API de administrador. |
| `/api/reader/*` | Leitores | Sessão de leitor ou chave de API do leitor. |

Regras das chaves:

- Uma chave de leitor tem exatamente as mesmas permissões de fonte do leitor que a gerou.
- Uma chave de administrador tem permissão total.
- Toda chave pode ser revogada por quem a gerou; chaves de leitor também podem ser revogadas por um administrador.
- A chave é exibida uma única vez, no momento da geração.

## 10. Pontos de atenção

Decisões já tomadas que trazem riscos a tratar na implementação:

1. **Renderizar todo arquivo de texto.** Arquivos JS e CSS que já contenham `{{` ou `{%` (por exemplo, código de Vue, Handlebars ou certos objetos em JS) serão interpretados e podem quebrar. O bloco "cru" resolve, mas exige que o autor do site saiba disso. Vale considerar uma opção por fonte para desligar a renderização em JS/CSS.
2. **Cabeçalhos expostos ao template.** `headers` inclui cookies e credenciais da requisição. Um template de uma fonte poderia imprimi-los na página. Recomenda-se ocultar `cookie` e `authorization` antes de entregar os cabeçalhos à engine.
3. **Props livres do leitor.** Como o leitor sobrescreve qualquer chave, nenhum template deve usar props para esconder conteúdo sensível. O escape por padrão na engine evita que um valor de props injete HTML ou script.
4. **Administradores com poder total entre si.** Um administrador pode remover todos os outros. Recomenda-se impedir a remoção do último administrador; em último caso, `/root/setup` recupera o acesso.
5. **Fontes públicas.** Qualquer arquivo dentro da pasta de uma fonte pública fica aberto à internet. A tela de edição deve deixar isso evidente ao marcar `public`.
6. **`/root/setup` é pública.** Precisa de limite de tentativas para a senha root.
7. **Credenciais de provedores externos.** Diferente do R2, fontes em AWS, Google Cloud e similares obrigam o sistema a guardar chaves de terceiros. Se o banco vazar, essas chaves vazam junto, a menos que estejam cifradas com uma chave mestra mantida fora do banco (como segredo do ambiente). Qualquer administrador passa a poder cadastrar e trocar essas chaves, então elas devem ser sempre somente leitura e restritas ao bucket.
8. **Custo e velocidade fora do R2.** Ler de outro provedor a cada requisição é mais lento e gera cobrança de tráfego de saída nesse provedor. O cache de arquivos (seção 11) passa a ser mais importante nessas fontes.

## 11. Em aberto

Itens que o texto original não define:

- Onde ficam guardados usuários, fontes, permissões e props.
- Quais provedores entram na primeira versão além do R2, e se o modelo atual do projeto já permite chamar serviços externos de armazenamento.
- Se buckets R2 de outra conta Cloudflare devem ser aceitos (nesse caso exigem credenciais, como um serviço compatível com S3).
- Duração da sessão de login e como o leitor troca a própria senha.
- O que entregar quando a URL termina em pasta (sugestão: `index.html`) e quando o arquivo não existe.
- Limite de tamanho do JSON de props e dos arquivos renderizados.
- Cache dos arquivos lidos do bucket.
- Lista completa dos filtros de cada página de listagem.
