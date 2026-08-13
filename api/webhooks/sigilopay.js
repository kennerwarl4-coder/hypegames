'use strict';

const crypto = require('crypto');
const { getPayment, savePayment, markWebhookEventOnce } = require('../_lib/kv');

// Eventos documentados em https://app.sigilopay.com.br/docs/webhooks/payment
const VALID_EVENTS = new Set([
  'TRANSACTION_CREATED',
  'TRANSACTION_PAID',
  'TRANSACTION_CANCELED',
  'TRANSACTION_REFUNDED',
  'TRANSACTION_CHARGED_BACK'
]);

const STATUS_MAP = {
  TRANSACTION_CREATED: 'PENDING',
  TRANSACTION_PAID: 'PAID',
  TRANSACTION_CANCELED: 'CANCELED',
  TRANSACTION_REFUNDED: 'REFUNDED',
  TRANSACTION_CHARGED_BACK: 'CHARGED_BACK'
};

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// PONTO A CONFIRMAR: a doc lista os campos de topo do payload (event, token,
// offerCode, checkoutUrl, client, transaction, subscription, orderItems,
// trackProps) mas não detalha os sub-campos de `transaction`. Tentamos alguns
// nomes plausíveis (id/transactionId, identifier/clientIdentifier) e tratamos
// como erro de payload se nenhum for encontrado — confirmar com a SigiloPay.
function extractIds(event) {
  const transaction = event.transaction || {};
  const identifier =
    transaction.identifier ||
    transaction.clientIdentifier ||
    (event.metadata && event.metadata.orderId) ||
    null;
  const transactionId = transaction.id || transaction.transactionId || null;
  return { identifier: identifier, transactionId: transactionId };
}

module.exports = async function handler(req, res) {
  try {
    return await handleWebhook(req, res);
  } catch (err) {
    console.error('Erro inesperado em /api/webhooks/sigilopay', err);
    // Erro não-2xx aqui é intencional: sinaliza pra SigiloPay reenviar depois
    // (ver regra "erro transitório antes da persistência -> não-2xx").
    res.status(500).json({ errorCode: 'INTERNAL_ERROR', message: 'Erro inesperado no servidor.' });
  }
};

async function handleWebhook(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  let event = req.body;
  if (typeof event === 'string') {
    try {
      event = JSON.parse(event);
    } catch (e) {
      res.status(400).json({ errorCode: 'GATEWAY_NO_BODY', message: 'JSON inválido.' });
      return;
    }
  }
  if (!event || typeof event !== 'object') {
    res.status(400).json({ errorCode: 'GATEWAY_NO_BODY', message: 'Corpo vazio ou inválido.' });
    return;
  }

  // A conta do usuário não expõe nenhum "token de webhook" configurável no
  // painel da SigiloPay (confirmado por integrações anteriores dele) — então
  // NÃO exigimos esse campo. Se um dia SIGILOPAY_WEBHOOK_TOKEN for definido
  // (por exemplo se a SigiloPay passar a fornecer um), validamos contra ele;
  // caso contrário, a autenticidade depende de o `identifier` já existir no
  // nosso KV (ver checagem abaixo) — um UUID de 122 bits gerado por nós,
  // impraticável de adivinhar.
  const expectedToken = process.env.SIGILOPAY_WEBHOOK_TOKEN;
  if (expectedToken) {
    const receivedToken = event.token;
    if (!receivedToken || !timingSafeEqualStr(receivedToken, expectedToken)) {
      res.status(401).json({ errorCode: 'GATEWAY_UNAUTHENTICATED', message: 'Token inválido.' });
      return;
    }
  }

  if (!VALID_EVENTS.has(event.event)) {
    res.status(400).json({ errorCode: 'GATEWAY_INVALID_ARGUMENT', message: 'Evento desconhecido: ' + event.event });
    return;
  }

  const ids = extractIds(event);
  const paymentKeyId = ids.identifier || ids.transactionId;
  if (!paymentKeyId) {
    res.status(400).json({ errorCode: 'GATEWAY_INVALID_ARGUMENT', message: 'Evento sem identificador de transação.' });
    return;
  }

  // Chave de dedupe: a doc não confirma um ID único de evento. Derivamos uma
  // chave estável (evento + id + hash do corpo) — ver "Pontos a confirmar".
  const bodyHash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex').slice(0, 16);
  const dedupeKey = [event.event, paymentKeyId, bodyHash].join(':');

  const isNewEvent = await markWebhookEventOnce(dedupeKey);
  if (!isNewEvent) {
    res.status(200).json({ ok: true, deduplicated: true });
    return;
  }

  const existing = await getPayment(paymentKeyId);
  if (!existing) {
    // Sem token de validação, esta é a nossa principal defesa contra eventos
    // forjados: só atualizamos pagamentos que NÓS criamos (identifier
    // conhecido no KV). Um identifier desconhecido é ignorado, não criado.
    res.status(200).json({ ok: true, ignored: true, reason: 'unknown identifier' });
    return;
  }

  // Nunca regride um pagamento já confirmado para um estado anterior
  // (exceto reembolso/chargeback, que são estados posteriores legítimos).
  if (existing.status === 'PAID' && event.event !== 'TRANSACTION_REFUNDED' && event.event !== 'TRANSACTION_CHARGED_BACK') {
    res.status(200).json({ ok: true, alreadyPaid: true });
    return;
  }

  const updated = Object.assign({}, existing, {
    status: STATUS_MAP[event.event] || existing.status,
    providerStatus: event.event,
    transactionId: ids.transactionId || existing.transactionId || null,
    updatedAt: new Date().toISOString()
  });
  if (event.event === 'TRANSACTION_PAID') {
    updated.paidAt = new Date().toISOString();
  }

  await savePayment(paymentKeyId, updated);

  res.status(200).json({ ok: true });
}
