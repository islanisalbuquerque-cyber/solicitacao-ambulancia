Solicitação de Ambulância — aplicativo Android

Requisitos
Android 8.0 (API 26) ou posterior, Android System WebView ativo e conexão com
a internet. O aplicativo usa exclusivamente APIs nativas do Android e Java.
Não exige AndroidX, Capacitor ou bibliotecas externas em tempo de execução.

Primeiro acesso
1. Instale o APK assinado disponibilizado para teste interno.
2. Abra o aplicativo e informe a origem HTTPS do sistema publicado.
   Use somente HTTPS, domínio e porta opcional. Não inclua caminhos,
   parâmetros, fragmentos ou credenciais no endereço.
3. Entre com o acesso individual cadastrado no sistema.

Nenhum servidor remoto vem definido. O aplicativo precisa do backend e do
site publicados em uma mesma origem HTTPS, com certificado válido. O APK
não hospeda o servidor nem cria contas. O custo de hospedagem depende do
serviço escolhido; esta camada Android não exige um serviço pago próprio.

Configurações
A barra superior mostra o servidor usado. Toque em Servidor para alterar
o endereço ou consultar a versão. Ao confirmar a troca de origem, cookies,
cache e armazenamento web anteriores são limpos e será necessário entrar
novamente. Alterações de orientação restauram o histórico do WebView.

Segurança e dados
- A única preferência salva pelo código nativo é a origem HTTPS.
- E-mail e senha são informados diretamente na página do sistema; o código
  nativo não os captura nem os grava em preferências.
- Cookies da própria origem mantêm a sessão conforme as regras do servidor.
  Cookies de terceiros, acesso a arquivos/conteúdo, conteúdo misto e pontes
  JavaScript/nativo estão desativados.
- Navegações ficam limitadas à origem configurada. Links mailto abrem um
  aplicativo de e-mail por ação explícita; outros endereços são bloqueados.
- Erros de certificado HTTPS sempre cancelam a conexão.
- O manifesto solicita somente INTERNET e desativa backups do aplicativo.
- Para encerrar a sessão, use Sair dentro do sistema.

Limites desta versão
As telas e permissões de MLP/MASTER são fornecidas pelo sistema web. Não há
modo offline, notificações push, upload nativo nem download de arquivos pelo
aplicativo; para baixar arquivos, use a versão web. Mudanças de orientação
ou restauração de processo podem recarregar a página; formulários ainda não
enviados podem precisar ser preenchidos novamente.

Projeto
Pacote: br.com.centralambulancia.app
Versão inicial: 1.0.0 (1)
Android mínimo: API 26
Android alvo: API 36
O build portátil, a assinatura e as instruções de distribuição são mantidos
nos arquivos de build fornecidos junto deste projeto. Não publique chaves
de assinatura ou credenciais de servidor com os fontes.

Build portátil no Windows
Use build.ps1 com -SdkDirectory, -JavaDirectory, -SigningDirectory,
-BuildDirectory e -OutputFile. A configuração espera Android SDK Platform
36, Build Tools 36 e um JDK compatível, conforme as instruções do script.
Mantenha SigningDirectory fora desta pasta pública e do ZIP de fontes.
O script preserva uma chave RSA de 3072 bits em PKCS12 e protege a senha
com DPAPI no Windows. Guarde uma cópia segura da chave e das informações
necessárias à assinatura: futuras atualizações precisam da mesma chave.
Um build em nuvem com chave temporária serve para testes; não substitui
a preservação da chave definitiva de distribuição.

Estado de validação
Os fontes e recursos foram preparados, com verificações locais de estrutura.
A compilação do APK está pendente do fluxo de build em nuvem. O SDK Manager
local foi bloqueado por política do Windows; essa restrição não foi contornada.
Ainda é necessário compilar, verificar a assinatura e testar em aparelho.
