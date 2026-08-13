# Integração Pix (SigiloPay)

## Fluxo

1. Cliente clica em COMPRAR no [index.html](index.html) → dados do produto vão pro `sessionStorage` → navega pro [checkout/index.html](checkout/index.html)`?produto=ID`.
2. Checkout mostra o produto no Resumo, cliente preenche Nome/Email/CPF/Telefone e clica "Pagar com Pix".
3. Front-end chama `POST /api/checkout/create` só com `produtoId` + dados do cliente (nunca envia preço).
4. `create.js` resolve o preço pelo catálogo do servidor (`api/_lib/products.json`) e chama a SigiloPay (`POST /gateway/pix/receive`), devolvendo o QR Code/copia-e-cola e o `transactionId`.
5. Front-end mostra o Pix e começa a consultar `GET /api/checkout/status?transactionId=...` a cada 5s, por até 5 minutos (60 tentativas). Essa rota é um proxy simples: chama a SigiloPay (`GET /gateway/transactions?id=...`) do lado do servidor, com a chave secreta, e devolve só o status pro navegador.
6. Quando o status vira `COMPLETED`, o front-end mostra a confirmação.

**Sem banco de dados, sem KV, sem webhook.** Decisão consciente: o projeto não tinha nenhuma infraestrutura de dados, e a doc da SigiloPay não deixa claro o mecanismo de autenticação de webhook nesta conta — então em vez de guardar estado em algum lugar, o status é sempre perguntado direto pra SigiloPay quando o front-end precisa saber. Isso é mais simples de rodar (zero infra pra provisionar), ao custo de: a doc da SigiloPay recomenda não fazer polling frequente nessa rota — mitigamos isso com intervalo de 5s e um teto de 60 tentativas (a consulta só acontece enquanto a tela de pagamento está aberta, não em background).

## Rodar localmente

```
npx vercel dev
```

(`vercel dev` precisa da CLI da Vercel logada — `npx vercel login` — e do projeto linkado — `npx vercel link` — pra conseguir puxar as env vars.)

## Configurar na Vercel

Settings → Environment Variables → adicionar (valores reais, nunca no Git):
```
SIGILOPAY_PUBLIC_KEY=aristocrata-black_5279gtl81z7x32x4
SIGILOPAY_SECRET_KEY=<sua chave privada>
```

Não precisa de banco de dados, KV, nem `SIGILOPAY_WEBHOOK_URL` (deixe em branco ou fora) pra esse fluxo funcionar.

## Decisões e suposições

| Decisão | Motivo |
|---|---|
| Sem banco de dados / KV | O projeto não tinha nenhuma infraestrutura de dados, e o usuário já integrou a SigiloPay antes sem precisar disso. Consultar o status direto na SigiloPay quando o front-end pergunta resolve o problema sem precisar guardar estado em lugar nenhum. |
| Status consultado por polling do front-end (a cada 5s, até 60 tentativas) em vez de webhook | Sem persistência, um webhook não teria onde escrever o resultado. O polling é limitado (só enquanto a tela está aberta, com teto de tentativas) para não virar polling indefinido. |
| Preço resolvido só pelo servidor, por `produtoId` | Impede alteração do valor do pedido pelo request final — o preço nunca vem do cliente. |
| Toda chamada à SigiloPay acontece no servidor (`api/_lib/sigilopay.js`) | `x-secret-key` nunca é exposta ao navegador. |
| Sem suíte de testes automatizados nesta entrega | Combinado com o usuário: entregar o fluxo funcionando primeiro. |

## Pontos a confirmar com a SigiloPay

- Formato completo dos objetos `pix`, `order` e `client` na resposta de criação (ex.: quando `pix.base64` vem preenchido vs. só `pix.image`).
- Vocabulário de status é **diferente** entre a criação (`OK, FAILED, PENDING, REJECTED, CANCELED`) e a consulta (`PENDING, COMPLETED, FAILED, REFUNDED, CHARGED_BACK`) — `status.js` trata isso, mas vale confirmar se há mais valores possíveis.
- Política de expiração do QR Code Pix.
- Rate limit real da rota `GET /gateway/transactions` (a doc só recomenda não usar pra polling frequente, sem número).

## Segurança

- `SIGILOPAY_SECRET_KEY` só existe no servidor (variáveis de ambiente da Vercel) — nunca é enviada ao navegador.
- `x-secret-key`, CPF completo e respostas brutas da SigiloPay nunca são logados nem devolvidos em nenhuma resposta HTTP pro navegador.
- O front-end nunca fala com a SigiloPay diretamente — só com `/api/checkout/create` e `/api/checkout/status`, que atuam como proxy autenticado.
