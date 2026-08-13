'use strict';

const { getTransaction, SigilopayError } = require('../_lib/sigilopay');

// Consulta o status de um Pix direto na SigiloPay (com a chave secreta, do
// lado do servidor). O front-end chama isso a cada poucos segundos enquanto
// a tela de pagamento está aberta, com um número máximo de tentativas (ver
// checkout/index.html) — não é polling indefinido.
module.exports = async function handler(req, res) {
  try {
    return await handleStatus(req, res);
  } catch (err) {
    console.error('Erro inesperado em /api/checkout/status', err);
    res.status(500).json({ errorCode: 'INTERNAL_ERROR', message: 'Erro inesperado no servidor.' });
  }
};

async function handleStatus(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ errorCode: 'METHOD_NOT_ALLOWED', message: 'Use GET.' });
    return;
  }

  const transactionId = req.query.transactionId;
  if (!transactionId) {
    res.status(400).json({ errorCode: 'GATEWAY_INVALID_ARGUMENT', message: 'Parâmetro transactionId é obrigatório.' });
    return;
  }

  let data;
  try {
    data = await getTransaction({ transactionId: String(transactionId) });
  } catch (err) {
    if (err instanceof SigilopayError) {
      res.status(err.statusCode).json({ errorCode: err.errorCode, message: err.message });
      return;
    }
    throw err;
  }

  // Nunca devolver dados sensíveis aqui (sem x-secret-key, sem CPF, sem payload bruto).
  res.status(200).json({
    transactionId: data.id || transactionId,
    status: data.status || 'PENDING',
    paidAt: data.payedAt || null
  });
}
