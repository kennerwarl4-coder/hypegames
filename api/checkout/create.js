'use strict';

const { randomUUID } = require('crypto');
const { getProductById } = require('../_lib/products');
const { createPixCharge, SigilopayError } = require('../_lib/sigilopay');

function sendError(res, status, errorCode, message, details) {
  res.status(status).json({ statusCode: status, errorCode: errorCode, message: message, details: details || null });
}

module.exports = async function handler(req, res) {
  try {
    return await handleCreate(req, res);
  } catch (err) {
    // Rede de segurança: nunca deixa a função travar sem resposta (isso vira
    // um FUNCTION_INVOCATION_FAILED opaco no cliente). Loga o erro real nos
    // logs da Vercel e devolve um JSON limpo em vez de derrubar a função.
    console.error('Erro inesperado em /api/checkout/create', err);
    return sendError(res, 500, 'INTERNAL_ERROR', 'Erro inesperado no servidor. Tente novamente em instantes.');
  }
};

async function handleCreate(req, res) {
  if (req.method !== 'POST') {
    return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST.');
  }

  const body = req.body || {};
  const produtoId = body.produtoId;
  const client = body.client || {};

  if (!produtoId) {
    return sendError(res, 400, 'GATEWAY_INVALID_ARGUMENT', 'produtoId é obrigatório.');
  }
  if (!client.name || !client.email || !client.document) {
    return sendError(res, 400, 'GATEWAY_INVALID_ARGUMENT', 'Nome, email e CPF são obrigatórios.');
  }

  // Preço nunca vem do cliente: resolvido pelo catálogo confiável do servidor
  // (api/_lib/products.json, extraído do site). Isso impede alteração do valor
  // do pedido pelo request final.
  const produto = getProductById(produtoId);
  if (!produto) {
    return sendError(res, 404, 'NOT_FOUND', 'Produto não encontrado.');
  }

  const amount = produto.precoCents / 100;
  // `identifier`: só usado para identificar esta tentativa de cobrança junto
  // à SigiloPay (campo obrigatório da API deles). Não persistimos nada — o
  // acompanhamento de status usa o `transactionId` que eles retornam.
  const identifier = randomUUID();
  const callbackUrl = process.env.SIGILOPAY_WEBHOOK_URL;

  let result;
  try {
    result = await createPixCharge({
      identifier: identifier,
      amount: amount,
      client: {
        name: client.name,
        email: client.email,
        phone: client.phone || undefined,
        document: client.document
      },
      products: [{ id: produto.id, name: produto.nome, quantity: 1, price: amount }],
      metadata: { orderId: identifier, provider: 'HyperGamesCheckout' },
      callbackUrl: callbackUrl || undefined
    });
  } catch (err) {
    if (err instanceof SigilopayError) {
      return sendError(res, err.statusCode, err.errorCode, err.message, err.details);
    }
    console.error('Erro inesperado ao criar cobrança Pix', err);
    return sendError(res, 500, 'INTERNAL_ERROR', 'Erro inesperado ao criar a cobrança.');
  }

  return res.status(201).json({
    identifier: identifier,
    transactionId: result.transactionId,
    status: result.status,
    pix: result.pix
  });
}
