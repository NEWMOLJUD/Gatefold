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
| `render` | lista de texto | Extensões de arquivo que passam pela engine de templates. Padrão: `["html"]`. Lista vazia desliga a renderização na fonte. |
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
- Credenciais são guardadas cifradas com a chave mestra (seção 9) e nunca são exibidas de volta, nem nas páginas nem na API. Para trocar, informa-se uma nova.
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

1. O sistema resolve o alias e verifica a permissão:
   - Fonte pública: segue, com ou sem login.
   - Fonte privada e leitor logado com acesso: segue.
   - Visitante sem sessão válida (sem cookie, token expirado ou sessão apagada) e fonte não pública: é redirecionado para a página de login, `/reader/?next=<endereço pedido>`, e volta a esse endereço depois de entrar (seção 9).
   - Leitor logado sem acesso à fonte: recebe uma página de "sem acesso". Nunca é mandado de volta ao login, para não ficar em círculo.
   - Alias inexistente recebe a mesma resposta que um alias privado (login para quem não está logado, "sem acesso" para quem está), para que não se descubra quais fontes existem.
2. Carrega o arquivo do bucket.
3. Carrega e combina os props (seção 5).
4. Se a extensão do arquivo estiver na lista `render` da fonte, o arquivo passa pela engine de templates; caso contrário, é entregue como está.
5. Devolve o resultado.

### O que é renderizado

O critério é configurado em cada fonte, no campo `render`:

- Só os arquivos cuja extensão está em `render` passam pela engine. Exemplo: `["html", "css", "json"]`.
- O padrão de uma fonte nova é `["html"]`.
- Arquivos binários (imagens, PDFs, fontes tipográficas, vídeos) nunca são renderizados, mesmo que a extensão seja listada.

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
| Entrar | Acessa `/admin/` e informa usuário e senha; é levado a `/admin/home`. |
| Adicionar leitor | Em `/admin/create-reader`, informa usuário e senha do leitor. |
| Editar ou remover leitor | Em `/admin/edit-reader`, altera os dados ou clica em remover. |
| Conceder ou revogar leitura | Em `/admin/edit-reader`, marca as fontes que o leitor pode ler. |
| Adicionar fonte | Em `/admin/create-source`, escolhe o provedor e informa bucket, pasta, alias, visibilidade, props e, se o provedor exigir, os dados de conexão e credenciais. |
| Editar ou remover fonte | Em `/admin/edit-source`. |
| Editar props da plataforma | Em `/admin/config`. |
| Gerenciar administradores | Em `/admin/list-admins`, `/admin/create-admin` e `/admin/edit-admin`. |
| Gerar chaves de API | Em `/admin/api-keys`. |
| Sair | Clica em "Sair", disponível em todas as páginas do administrador. |

### Leitor

| Fluxo | Como |
|---|---|
| Entrar | Acessa `/reader/` e informa usuário e senha; é levado a `/reader/home` ou, se chegou ao login tentando abrir uma fonte, de volta à página que tentava ler. |
| Abrir uma fonte sem estar logado | Acessa `/reader/view/<alias>/<arquivo>` de uma fonte privada; é levado ao login e, depois de entrar, volta à mesma página. |
| Ver fontes disponíveis | Em `/reader/home`, vê as fontes liberadas para ele e abre qualquer uma. |
| Acessar uma página | Acessa `/reader/view/<alias>/<arquivo>`; o sistema renderiza conforme a seção 6. |
| Personalizar a interface | A partir da home, abre `/reader/config` e edita o próprio JSON de props. |
| Gerar chaves de API | Em `/reader/api-keys`. |
| Sair | Clica em "Sair" na home. |

### Root

| Fluxo | Como |
|---|---|
| Criar ou remover administrador | Acessa `/root/setup`, informa a senha root no popup e executa a ação. |

## 8. Páginas

### Leitor

| URL | Descrição |
|---|---|
| `/reader/` | Login do leitor. Aceita o parâmetro `next`, com o endereço da fonte que o visitante tentava ler: depois do login ele é levado a esse endereço, ou a `/reader/home` se não houver `next` válido. Quem já está logado é levado direto ao destino. |
| `/reader/home` | Home do leitor: lista as fontes que ele pode ler, com link para cada uma, e dá acesso à edição dos props, às chaves de API e ao botão "Sair". |
| `/reader/view/<alias>/<arquivo>` | Entrega o arquivo da fonte, trocando o alias por bucket e pasta. Dispensa login em fontes públicas. Em fonte privada, quem não está logado é levado ao login e depois volta a esta página. |
| `/reader/config` | Edição do JSON de props do leitor. |
| `/reader/api-keys` | Geração e revogação das chaves de API do leitor. |
| `/reader/logout` | Encerra a sessão do leitor e leva ao login. |

### Administrador

| URL | Descrição |
|---|---|
| `/admin/` | Login do administrador (usuário e senha). Quem já está logado é levado a `/admin/home`. |
| `/admin/home` | Painel do administrador: atalhos para fontes, leitores, administradores, props da plataforma e chaves de API. |
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
| `/admin/logout` | Encerra a sessão do administrador e leva ao login. |

Todas as páginas do administrador exibem o botão "Sair".

### Root

| URL | Descrição |
|---|---|
| `/root/setup` | Página pública protegida pela senha root. Cria e remove administradores. |

## 9. Autenticação e segredos

### Sessão

- O login (`/admin/` e `/reader/`) devolve um **token JWT** gravado em **cookie**.
- O cookie é `HttpOnly`, `Secure` e `SameSite`, para que scripts das páginas não consigam lê-lo e outros sites não consigam usá-lo.
- Cada login cria um registro de **sessão** no banco. O token carrega o identificador dessa sessão, o do usuário, o papel (administrador ou leitor) e a validade.
- A cada requisição o sistema confere a assinatura e a validade do token e se a sessão ainda existe no banco. Sessão apagada significa token recusado, mesmo que ainda não tenha expirado.
- Remover um usuário ou trocar sua senha apaga todas as sessões dele.
- **Retorno após o login:** quando um visitante sem sessão válida tenta abrir uma fonte não pública, o sistema o redireciona para `/reader/?next=<endereço pedido>`, guardando o caminho e os parâmetros de query. Após o login, o leitor é levado a esse endereço. O `next` só é aceito se for um caminho interno começando por `/reader/view/`; endereços completos (`https://...`), caminhos com `//` ou `\` e qualquer outro valor são ignorados, e o leitor vai para `/reader/home`. Se, depois de entrar, o leitor não tiver acesso à fonte, vê a página de "sem acesso".
- **Logout:** `/reader/logout` e `/admin/logout` apagam a sessão no banco e o cookie, e levam à página de login. O token deixa de valer na hora, em qualquer lugar onde tenha sido copiado. Só aceitam envio de formulário (POST), para que um link em outro site não deslogue o usuário. As chaves de API não são afetadas.

### Armazenamento

Todos os dados do sistema ficam em banco **SQLite**. As tabelas, colunas e consultas estão detalhadas na seção 10.

| Dado | Conteúdo |
|---|---|
| Administradores | Usuário e resumo da senha. |
| Leitores | Usuário, resumo da senha e props do leitor. |
| Fontes | Campos da seção 4, com as credenciais cifradas. |
| Permissões | Quais leitores podem ler quais fontes. |
| Props da plataforma | O JSON geral do sistema. |
| Sessões | Sessões de login ativas, com usuário, papel e validade. |
| Chaves de API | Resumo da chave, dono e data de criação. |
| Tentativas da senha root | Contagem de tentativas erradas por hora, para o limite de `/root/setup`. |

Os arquivos dos sites nunca são copiados para o banco: continuam nos buckets.

### Segredos do ambiente

Três valores ficam em variáveis de ambiente, como segredos, e nunca no banco nem no código:

| Segredo | Uso |
|---|---|
| Senha root | Libera `/root/setup`. |
| Chave mestra | Protege tudo o que é sensível no banco (abaixo). |
| Chave de assinatura | Assina os tokens JWT. |

### Proteção dos dados sensíveis

| Dado | Como é guardado |
|---|---|
| Credenciais de provedores (AWS, Google Cloud etc.) | Cifradas com a chave mestra; o sistema precisa recuperá-las para ler o bucket. |
| Senhas de administradores e leitores | Resumo (*hash*) irreversível, calculado com a chave mestra; o sistema só precisa conferir a senha, nunca recuperá-la. |
| Chaves de API | Resumo (*hash*) irreversível, calculado com a chave mestra. |

## 10. Banco de dados

Todos os dados da seção 9 ficam em **um único banco SQLite**, de identificador `canone`. A escolha por um banco só privilegia a simplicidade: as tabelas se relacionam entre si, uma alteração que mexe em várias delas acontece inteira ou não acontece, e as listagens do administrador filtram e cruzam dados livremente. O preço dessa escolha está na seção 12, itens 14 e 15.

### Convenções

| Tipo de dado | Como é guardado |
|---|---|
| Identificadores (`id`) | Texto aleatório gerado pelo sistema. Nunca números sequenciais: não podem ser adivinhados e não perdem precisão. |
| Datas | Número inteiro: milissegundos desde 1º de janeiro de 1970. |
| Booleanos | Número inteiro: `1` para verdadeiro, `0` para falso. |
| JSON (props, `render`, `connection`) | Texto. O banco recusa texto que não seja JSON válido. |

### Relações

```
admins ──< sessions >── readers ──< permissions >── sources
admins ──< api_keys >── readers

platform       (uma linha só)
root_attempts  (independente)
```

`──<` significa "um para muitos": um leitor tem várias sessões, várias chaves de API e várias permissões; uma fonte tem várias permissões. Cada sessão e cada chave de API pertence a exatamente um dono, administrador **ou** leitor.

### Tabelas

A lista abaixo, nesta ordem, é o histórico inicial do esquema. Depois de publicada, nenhuma linha dela é editada nem removida: toda mudança no esquema entra como uma nova instrução no fim da lista.

#### `admins` — administradores

```sql
CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
)
```

#### `readers` — leitores

```sql
CREATE TABLE readers (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  props TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(props)),
  created_at INTEGER NOT NULL
)
```

```sql
CREATE INDEX readers_created_at ON readers (created_at)
```

O nome de usuário é único entre os leitores e, separadamente, único entre os administradores: os dois logins são independentes.

#### `sources` — fontes

```sql
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'r2',
  name TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  alias TEXT NOT NULL UNIQUE,
  public INTEGER NOT NULL DEFAULT 0 CHECK (public IN (0, 1)),
  props TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(props)),
  render TEXT NOT NULL DEFAULT '["html"]' CHECK (json_valid(render)),
  connection TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(connection)),
  credentials TEXT,
  created_at INTEGER NOT NULL
)
```

```sql
CREATE INDEX sources_created_at ON sources (created_at)
```

O campo `connection` da seção 4 ocupa duas colunas, para que o segredo nunca fique misturado com dado legível:

| Coluna | Conteúdo |
|---|---|
| `connection` | JSON com os dados não secretos do provedor: região, projeto, endereço do serviço. |
| `credentials` | As credenciais do provedor, cifradas com a chave mestra. Vazio (`NULL`) em fontes `r2`. Nunca sai do servidor. |

Uma fonte nova nasce privada (`public = 0`): tornar pública é sempre uma decisão explícita.

#### `permissions` — quem lê o quê

```sql
CREATE TABLE permissions (
  reader_id TEXT NOT NULL REFERENCES readers (id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (reader_id, source_id)
)
```

```sql
CREATE INDEX permissions_source ON permissions (source_id)
```

Uma linha significa "este leitor pode ler esta fonte"; revogar é apagar a linha. Remover um leitor ou uma fonte apaga junto as permissões correspondentes. O índice por fonte serve para contar e filtrar os leitores de cada fonte nas listagens.

#### `platform` — props da plataforma

```sql
CREATE TABLE platform (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  props TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(props)),
  updated_at INTEGER NOT NULL
)
```

Tem sempre uma única linha (`id = 1`); o banco recusa uma segunda. Se a linha ainda não existir, os props da plataforma valem `{}`.

#### `sessions` — sessões de login

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT REFERENCES admins (id) ON DELETE CASCADE,
  reader_id TEXT REFERENCES readers (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK ((admin_id IS NULL) <> (reader_id IS NULL))
)
```

```sql
CREATE INDEX sessions_admin ON sessions (admin_id)
```

```sql
CREATE INDEX sessions_reader ON sessions (reader_id)
```

```sql
CREATE INDEX sessions_expires_at ON sessions (expires_at)
```

Exatamente uma das colunas `admin_id` e `reader_id` é preenchida, e é ela que define o papel da sessão. Remover o usuário apaga as sessões dele.

#### `api_keys` — chaves de API

```sql
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  admin_id TEXT REFERENCES admins (id) ON DELETE CASCADE,
  reader_id TEXT REFERENCES readers (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  CHECK ((admin_id IS NULL) <> (reader_id IS NULL))
)
```

```sql
CREATE INDEX api_keys_admin ON api_keys (admin_id)
```

```sql
CREATE INDEX api_keys_reader ON api_keys (reader_id)
```

Só o resumo da chave é guardado. Uma chamada à API calcula o resumo da chave recebida e procura por ele em `key_hash`. Remover o dono apaga as chaves dele.

#### `root_attempts` — tentativas da senha root

```sql
CREATE TABLE root_attempts (
  hour INTEGER PRIMARY KEY,
  attempts INTEGER NOT NULL
)
```

Uma linha por hora, com o total de tentativas erradas da senha root naquela hora. Passado o limite, `/root/setup` recusa novas tentativas até a hora seguinte.

### Consultas por requisição

Regra geral: **cada requisição vai ao banco uma única vez.** Cada ida é uma viagem de rede, e todas as consultas de todos os usuários passam pela mesma fila; por isso as leituras de uma requisição são agrupadas em um só envio, em vez de feitas uma depois da outra.

| Situação | O que a ida única ao banco traz |
|---|---|
| `/reader/view/...` com cookie | A sessão (se ainda existe e não venceu) com os props do leitor; a fonte do alias, já com a resposta "este leitor tem permissão?"; e os props da plataforma. |
| `/reader/view/...` sem cookie | A fonte do alias e os props da plataforma. |
| Chamada à API com chave | O mesmo que com cookie, localizando o dono por `key_hash` em vez da sessão. |
| Login | O usuário pelo `username`. Conferida a senha, uma segunda ida grava a sessão. |
| Logout | Apaga a linha da sessão. |
| Remover usuário | Apaga o usuário; sessões, chaves e permissões dele saem junto, na mesma operação. |
| Trocar senha | Grava o novo resumo e apaga as sessões do usuário, na mesma operação. |
| Listagens do administrador | Sempre paginadas, com filtros apenas sobre colunas que têm índice. |

Operações que mexem em mais de uma tabela são enviadas juntas e valem por inteiro ou não valem: nunca sobra um usuário removido com sessão ainda ativa.

### Limpeza

Uma tarefa agendada apaga periodicamente as sessões vencidas e as linhas antigas de `root_attempts`. Sessão vencida já é recusada mesmo antes de ser apagada, porque toda consulta confere `expires_at`.

## 11. API

Tudo o que as páginas fazem está disponível em duas famílias de rotas:

| Prefixo | Público | Autenticação |
|---|---|---|
| `/api/admin/*` | Administradores | Cookie de sessão de administrador ou chave de API de administrador. |
| `/api/reader/*` | Leitores | Cookie de sessão de leitor ou chave de API do leitor. |

Uma chamada à API sem autenticação válida recebe um erro de não autenticado (401). A API nunca redireciona para a página de login: o redirecionamento existe só nas páginas.

Regras das chaves:

- Uma chave de leitor tem exatamente as mesmas permissões de fonte do leitor que a gerou.
- Uma chave de administrador tem permissão total.
- Toda chave pode ser revogada por quem a gerou; chaves de leitor também podem ser revogadas por um administrador.
- A chave é exibida uma única vez, no momento da geração.

## 12. Pontos de atenção

Decisões já tomadas que trazem riscos a tratar na implementação:

1. **Renderizar JS e CSS.** Se uma fonte incluir `js` ou `css` em `render`, arquivos que já contenham `{{` ou `{%` (por exemplo, código de Vue ou Handlebars) serão interpretados e podem quebrar. O bloco "cru" resolve. A tela de edição da fonte deve avisar sobre isso.
2. **Cabeçalhos expostos ao template.** `headers` inclui cookies e credenciais da requisição. Um template de uma fonte poderia imprimi-los na página. Como a sessão fica em cookie, isso exporia o token de login: `cookie` e `authorization` devem ser ocultados antes de entregar os cabeçalhos à engine.
3. **Props livres do leitor.** Como o leitor sobrescreve qualquer chave, nenhum template deve usar props para esconder conteúdo sensível. O escape por padrão na engine evita que um valor de props injete HTML ou script.
4. **Administradores com poder total entre si.** Decisão tomada: um administrador pode tudo, inclusive remover todos os outros. Se isso acontecer, `/root/setup` recupera o acesso.
5. **Fontes públicas.** Qualquer arquivo dentro da pasta de uma fonte pública fica aberto à internet. A tela de edição deve deixar isso evidente ao marcar `public`.
6. **`/root/setup` é pública.** Precisa de limite de tentativas para a senha root.
7. **Credenciais de provedores externos.** Diferente do R2, fontes em AWS, Google Cloud e similares obrigam o sistema a guardar chaves de terceiros. Se o banco vazar, essas chaves vazam junto, por isso ficam cifradas com a chave mestra, mantida fora do banco. Qualquer administrador passa a poder cadastrar e trocar essas chaves, então elas devem ser sempre somente leitura e restritas ao bucket.
8. **Perda ou troca da chave mestra.** Se a chave mestra for perdida ou alterada, todas as credenciais de provedores ficam ilegíveis e todas as senhas e chaves de API deixam de valer. É preciso guardar uma cópia segura dela e prever um procedimento de troca.
9. **Uma consulta ao banco por requisição.** Conferir a sessão no banco é o que permite cancelar um token na hora (logout, remoção, troca de senha), ao custo de uma leitura no banco a cada arquivo servido de fonte privada. Sessões expiradas precisam de limpeza periódica.
10. **Ações por cookie.** Como o navegador envia o cookie sozinho, as rotas que alteram dados precisam de proteção contra requisições forjadas por outros sites (`SameSite` e verificação de origem).
11. **Custo e velocidade fora do R2.** Ler de outro provedor a cada requisição é mais lento e gera cobrança de tráfego de saída nesse provedor. O cache de arquivos (seção 13) passa a ser mais importante nessas fontes.
12. **Endereço de retorno do login.** O parâmetro `next` vem na URL e pode ser escrito por qualquer pessoa. Sem validação, um link como `/reader/?next=https://site-falso` usaria a tela de login verdadeira para levar o leitor a um site de phishing. Por isso só caminhos internos em `/reader/view/` são aceitos (seção 9).
13. **Descoberta de aliases.** Se um alias inexistente e um alias privado tivessem respostas diferentes, qualquer visitante descobriria quais fontes privadas existem só testando nomes. As duas situações devem ter a mesma resposta (seção 6).
14. **Fila única no banco.** O banco atende uma consulta por vez, e todas as leituras de todos os sites passam por ele. A capacidade total fica na ordem de centenas de arquivos por segundo, somando todas as fontes; uma página com 30 arquivos são 30 consultas. Acima disso as requisições passam a falhar, não apenas a ficar lentas. É suficiente para começar, mas não para picos grandes de acesso (seção 13).
15. **Consulta lenta trava tudo.** Enquanto uma consulta pesada roda, nenhuma outra é atendida, inclusive a leitura dos sites. Por isso as listagens são sempre paginadas e filtram apenas por colunas com índice (seção 10).
16. **Remoção em cascata.** O esquema conta com o banco para apagar sessões, chaves e permissões quando o dono é removido. Um teste deve confirmar que isso está ativo no ambiente de publicação; se não estiver, as remoções devem apagar esses dados explicitamente, na mesma operação. Sem isso, um leitor removido continuaria com sessão válida.
17. **Limite de tentativas da senha root é global.** A contagem não separa por visitante, porque um atacante troca de endereço com facilidade. Isso protege a senha, mas permite que alguém bloqueie `/root/setup` por até uma hora só errando de propósito.

## 13. Em aberto

Itens que o texto original não define:

- **Como ligar buckets R2 pelo nome.** O projeto hoje oferece um único armazenamento de arquivos, sem escolha de bucket, e no Cloudflare a ligação direta a um bucket é fixada na publicação, não cadastrada em tela. Caminhos possíveis: (a) todas as fontes R2 serem pastas dentro desse armazenamento único; (b) tratar cada bucket R2 como serviço compatível com S3, com credenciais; (c) alterar o modelo do projeto para aceitar vários buckets.
- Quais provedores entram na primeira versão além do R2. Os externos são alcançáveis pelas chamadas HTTP que o projeto já permite.
- Se buckets R2 de outra conta Cloudflare devem ser aceitos (nesse caso exigem credenciais, como um serviço compatível com S3).
- Validade da sessão e como o leitor troca a própria senha.
- O que entregar quando a URL termina em pasta (sugestão: `index.html`) e quando o arquivo não existe.
- Limite de tamanho do JSON de props e dos arquivos renderizados.
- Cache dos arquivos lidos do bucket.
- Lista completa dos filtros de cada página de listagem. Cada filtro novo precisa de um índice no banco (seção 10).
- Quantas tentativas erradas da senha root são aceitas por hora.
- O que fazer se a fila única do banco não bastar (seção 12, item 14). Caminhos possíveis: guardar em memória, por poucos segundos, a fonte e os props (nunca a sessão nem a permissão, que precisam valer na hora); ou repartir as leituras em vários bancos, mantendo um banco central para o painel do administrador.
