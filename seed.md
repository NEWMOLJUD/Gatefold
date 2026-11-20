## Objetivo:

Criar um sistema web low code de gerenciamento de sites somente leitura, baseado na idéia de caminhos descentralizados.

## Fontes:
As fontes serão buckets r2 configurados pelo root, que permitirá que o sistema obtenha os arquivos dos sites.

## Fontes.itens:
toda fonte terá os seguintes campos:
- name: nome  do bucket
- path:caminho inicial do bucket (pasta)
- alias: alias de substituiçao de url 
- public: valor boleano se o bucket é público ou privado


## Usuarios 
O sistema terá apenas dois tipos de usuarios, admnistradores e leitores, admnistradores tem permissão total no sistema, e leitores só tem permissão de leitura nas fontes que foram configuradas para eles.

## Usuarios.administrador.fluxos:

- adicionar um leitor
- remover um leitor 
- adicionar fontes
- remover fontes 
- dar uma permissão de leitura de uma fonte a um leitor 

## Usuarios.leitor.fluxos:
- ver aas fontes que ele tem permissão 

## Paginas:


## Paginas.reader.list-fonts:
url:
    /reader/list-fonts/
definição:
 pagina onde o leitor pode ver as fontes de leitura que foram cadastrados para ele.


## Paginas.reader.config
url:
    /reader/config 
definição:
pagina onde o usuario pode configurar o json de props dele.

## Paginas.admin
url:
    /admin/
definição:
pagina de login do admin, que exigirá um usuário e uma senha.

## Paginas.admin.config:
url:
    /admin/config 
definião:
pagina onde o admnistrador pode configurar o json de props geral de todo sistema.


## Paginas.admin.list-fonts:
url:
 /admin/list-fonts?(query params de filtragem)
definição: 
    página de listagem de fontes do sistema, dentro dessa página de listagem , os admnistradores devem poder listar as fontes ja cdastradas, baseado em vários critérios de busca, como criação, quantidade de leitores, etc ..

## Paginas.admin.edit-font
url:
     /admin/edit-font?fonteid=iu2i323202
definição: 
página onde o admnistrador pode editar a fonte, seja o bucket,pasta, alias ou as props.json especificas da fonte.


## Paginas.admin.list-readers
url:
    /admin/list-readers?&font=science-module-1&(other filtrage params here)
definilçao:
página onde o admnistrador pode listar todos os usuários do sistema, permitindo filtrar por fontes, criação, etc ..

## Paginas.admin.edit-reader?7user-id=2312212
url:
    /admin/edit-reader/
definição:
pagina onde o admnistrador pode editar, os usuarios do sistema, seu nome, senha e também quais fontes ele pode ler.

## paginas.admin.list-admins/
url:
    /admin/list-admins
definição:
pagina onde o admnistrador pode listar os admnistradores do sistema baseado em fitlragem 


## paginas.admin.edit-admin
url:
    /admin/edit-admin
definição:
    pagina onde um admnistrador pode editar os outro admnnistradores

## paginas.root.setup
url:
    /root/setup
definição:
pagina publica onde mediante senha root , será possível criar e remover usuarios roots do sistema, essa página é pública, por isso precisa exibir um popup pedindo a senha root , ela deve funcionar como uma espécie de "bios" do sistema, essa senha root deve ser determinada em variavel de ambiente.

