# Integração Pix (SigiloPay)

## Fluxo

1. Cliente clica em COMPRAR no [index.html](index.html) → dados do produto vão pro `sessionStorage` → navega pro [checkout/index.html](checkout/index.html)`?produto=ID`.
2. Checkout mostra o produto no Resumo, cliente preenche Nome/Email/CPF/Telefone, aceita os termos e clica "Pagar com Pix".
3. Front-end chama `POST /api/checkout/create` só com `produtoId` + dados do cliente (nunca envia preço).
4. `create.js` resolve o preço pelo catálogo do servidor (`api/_lib/products.json`), gera um `identifier` (UUID), salva no KV como `CREATING`, chama a SigiloPay (`POST /gateway/pix/receive`) e salva o resultado.
5. Front-end recebe o QR Code/copia-e-cola e começa a consultar `GET /api/checkout/status?id=...` a cada 5s — **isso só lê o KV, nunca chama a SigiloPay diretamente** (a doc deles proíbe polling frequente).
6. Quando o pagamento é confirmado, a SigiloPay chama `POST /api/webhooks/sigilopay` (evento `TRANSACTION_PAID`) com o `callbackUrl` fixo configurado em `SIGILOPAY_WEBHOOK_URL`. O webhook confere se o `identifier` já existe no KV (defesa contra eventos forjados — ver Segurança), deduplica o evento e atualiza o status. O status muda pra `PAID` e o polling do front-end mostra a confirmação.

A cobrança criada **não** é pagamento confirmado — só o webhook confirma.

## Rodar localmente

```
npm install
npx vercel dev
```

(`vercel dev` precisa da CLI da Vercel logada — `npx vercel login` — e do projeto linkado — `npx vercel link` — pra conseguir puxar as env vars e o KV.)

## Configurar na Vercel

1. Criar o projeto na Vercel apontando pra esta pasta.
2. Settings → Storage → conectar um **KV Store** (Redis) ao projeto — isso injeta `KV_REST_API_URL`/`KV_REST_API_TOKEN` sozinho.
3. Settings → Environment Variables → adicionar (valores reais, nunca no Git):
   - `SIGILOPAY_PUBLIC_KEY`
   - `SIGILOPAY_SECRET_KEY`
   - `SIGILOPAY_WEBHOOK_URL` = `https://SEU-DOMINIO/api/webhooks/sigilopay`
   - `SIGILOPAY_WEBHOOK_TOKEN` — **opcional**, deixe vazio (ver Segurança abaixo).
4. Configurar esse mesmo `SIGILOPAY_WEBHOOK_URL` como callback no painel da SigiloPay, se eles pedirem cadastro manual do webhook (a doc menciona limite de 20 webhooks por integração).

## Decisões e suposições

| Decisão | Motivo |
|---|---|
| Vercel KV em vez de banco relacional | Projeto não tinha nenhuma infraestrutura de dados; KV cobre o essencial (idempotência de webhook + status pro polling) com o mínimo de setup. |
| Preço resolvido só pelo servidor, por `produtoId` | A doc pede explicitamente para não deixar o cliente alterar o valor final; sem isso, dava pra adulterar o `amount` no request. |
| `identifier` gerado com `crypto.randomUUID()` e persistido antes da chamada à SigiloPay | Segue literalmente a regra da doc. |
| Erro de timeout/rede marca o pagamento como `UNKNOWN`, não `FAILED` | A doc avisa que um timeout pode não significar que a cobrança falhou do lado deles — não decidimos por um estado definitivo sem confirmação. |
| Sem suíte de testes automatizados nesta entrega | Combinado com você: entregar o fluxo funcionando primeiro, testes ficam pra uma próxima etapa. |
| Sem endpoint de conciliação administrativa (`GET /gateway/transactions`) exposto | O cliente `getTransaction()` já existe em `api/_lib/sigilopay.js`, mas não criei rota nem UI admin pra isso ainda — fora do escopo combinado por ora. |
| Webhook não exige `SIGILOPAY_WEBHOOK_TOKEN` | O painel da SigiloPay (nesta conta) não expõe nenhum token de webhook configurável, e integrações anteriores nunca precisaram disso. A autenticidade passou a depender de o `identifier` (UUID) já existir no KV — eventos para identifiers desconhecidos são ignorados, não processados. Se a SigiloPay disponibilizar um token no futuro, é só preencher a env var que a validação volta a ser exigida. |

## Pontos a confirmar com a SigiloPay

- **Formato exato do objeto `transaction` dentro do payload do webhook.** A doc lista os campos de topo (`event`, `token`, `offerCode`, `checkoutUrl`, `client`, `transaction`, `subscription`, `orderItems`, `trackProps`), mas não os sub-campos de `transaction`. O código tenta `transaction.identifier`/`transaction.clientIdentifier` e `transaction.id`/`transaction.transactionId` — **precisa validar contra um payload real.**
- **Não existe ID único de evento documentado** para deduplicação "oficial" — a chave de dedupe usada (`evento + id + hash do corpo`) é uma aproximação nossa, documentada no código.
- Formato completo dos objetos `pix`, `order` e `client` na resposta de criação (ex.: quando `pix.base64` vem preenchido vs. só `pix.image`).
- Política de expiração do QR Code Pix (não documentada no trecho que recebi).
- Existência de ambiente sandbox/homologação separado.
- Rate limit da API (não documentado no trecho que recebi).

## Segurança

- `SIGILOPAY_SECRET_KEY` só existe no servidor (variáveis de ambiente da Vercel) — nunca é enviada ao navegador.
- `x-secret-key`, CPF completo e o corpo bruto de requests/webhooks nunca são logados nem retornados em nenhuma resposta HTTP.
- O checkout público nunca consulta a SigiloPay diretamente para status — só o webhook escreve status de pagamento.
- **Webhook sem token**: a conta não tem um token de webhook configurável na SigiloPay, então `/api/webhooks/sigilopay` não exige um. A proteção contra eventos forjados é: só atualiza pagamentos cujo `identifier` (UUID de 122 bits, gerado por `crypto.randomUUID()`) já existe no KV — criado por nós em `create.js` antes de chamar a SigiloPay. Um identifier desconhecido é ignorado. Isso não é tão forte quanto um HMAC/token dedicado (não protege contra alguém que descubra um identifier real em trânsito, por exemplo), mas cobre o risco prático de forjar pagamentos "do nada". Se a SigiloPay passar a oferecer um token de webhook, basta preencher `SIGILOPAY_WEBHOOK_TOKEN` que a validação extra volta a ser aplicada automaticamente.
