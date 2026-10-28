# Solicitação de Ambulância

Servidor web com acessos individuais MLP e MASTER e cliente Android.
Este pacote contém os fontes para publicação; não inclui cadastros, pedidos,
senhas, conexão de banco ou chave de assinatura.

Siga [PUBLICAR.txt](PUBLICAR.txt) para configurar Neon Free, Render Free e o
primeiro MASTER. O servidor publicado começa sem pedidos antigos.

O workflow **Android APK de teste**, na aba Actions, compila o projeto em
`android-app/`. Cada execução usa uma assinatura temporária para testes.
A instalação em aparelho e a publicação online precisam ser verificadas
depois da configuração das contas e da execução do workflow.

Requer Node.js 22 ou 24 no servidor. Instale dependências com
`npm install --omit=dev --no-audit --no-fund`.
Configure as variáveis privadas no provedor e inicie com `npm start`.
Não use armazenamento JSON em um servidor com disco temporário.
