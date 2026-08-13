'use strict';

const { getPayment } = require('../_lib/kv');

// Lido pelo checkout via polling do PRÓPRIO servidor (barato, só lê o KV).
// Isso NUNCA chama a SigiloPay diretamente — a doc deles proíbe polling
// frequente na rota de consulta. A fonte de verdade real é o webhook.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ errorCode: 'METHOD_NOT_ALLOWED', message: 'Use GET.' });
    return;
  }

  const identifier = req.query.id;
  if (!identifier) {
    res.status(400).json({ errorCode: 'GATEWAY_INVALID_ARGUMENT', message: 'Parâmetro id é obrigatório.' });
    return;
  }

  const payment = await getPayment(String(identifier));
  if (!payment) {
    res.status(404).json({ errorCode: 'NOT_FOUND', message: 'Pagamento não encontrado.' });
    return;
  }

  // Nunca devolver dados sensíveis aqui (sem x-secret-key, sem CPF, sem payload bruto).
  res.status(200).json({
    identifier: payment.identifier,
    status: payment.status,
    transactionId: payment.transactionId || null,
    paidAt: payment.paidAt || null
  });
};
