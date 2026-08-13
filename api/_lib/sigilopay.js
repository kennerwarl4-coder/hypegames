'use strict';

// Cliente HTTP central para a API da SigiloPay.
// Fonte: https://app.sigilopay.com.br/docs (Autenticação, Receber Pix, Buscar transação, Erros)

const DEFAULT_BASE_URL = 'https://app.sigilopay.com.br/api/v1';
const DEFAULT_TIMEOUT_MS = 10000;

class SigilopayError extends Error {
  constructor(errorCode, message, statusCode, details, transient) {
    super(message);
    this.name = 'SigilopayError';
    this.errorCode = errorCode;
    this.statusCode = statusCode || 500;
    this.details = details || null;
    // transient=true só em timeout/falha de rede. NUNCA repita a criação de uma
    // cobrança automaticamente com base nisso — a doc avisa que um timeout pode
    // não significar falha da operação do lado da SigiloPay.
    this.transient = !!transient;
  }
}

function getBaseUrl() {
  return process.env.SIGILOPAY_BASE_URL || DEFAULT_BASE_URL;
}

function getTimeoutMs() {
  const raw = process.env.SIGILOPAY_HTTP_TIMEOUT_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

async function sigilopayRequest(method, path, body) {
  const publicKey = process.env.SIGILOPAY_PUBLIC_KEY;
  const secretKey = process.env.SIGILOPAY_SECRET_KEY;
  if (!publicKey || !secretKey) {
    throw new SigilopayError('GATEWAY_NO_CREDENTIALS', 'Credenciais da SigiloPay não configuradas no servidor.', 500);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(function () { controller.abort(); }, getTimeoutMs());

  let response;
  try {
    response = await fetch(getBaseUrl() + path, {
      method: method,
      headers: {
        'x-public-key': publicKey,
        'x-secret-key': secretKey,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new SigilopayError(
        'GATEWAY_TIMEOUT',
        'Tempo limite excedido ao chamar a SigiloPay. A operação pode não ter sido concluída do lado deles.',
        504,
        null,
        true
      );
    }
    throw new SigilopayError('GATEWAY_UNAVAILABLE', 'Falha de rede ao chamar a SigiloPay.', 502, null, true);
  } finally {
    clearTimeout(timeoutId);
  }

  let data = null;
  try {
    data = await response.json();
  } catch (e) {
    // corpo vazio ou não-JSON
  }

  if (!response.ok) {
    throw new SigilopayError(
      (data && data.errorCode) || 'GATEWAY_UNKNOWN_ERROR',
      (data && data.message) || ('SigiloPay retornou status ' + response.status),
      response.status,
      data && data.details
    );
  }

  return data;
}

// POST /gateway/pix/receive
// `payload.identifier` deve ser gerado e persistido pela aplicação ANTES desta chamada.
async function createPixCharge(payload) {
  return sigilopayRequest('POST', '/gateway/pix/receive', payload);
}

// GET /gateway/transactions?id=... ou ?clientIdentifier=...
// USO RESTRITO: conciliação manual/administrativa. A documentação alerta contra
// usar essa rota para polling frequente — o checkout público NUNCA deve chamar isto.
async function getTransaction(params) {
  const query = new URLSearchParams();
  if (params && params.transactionId) query.set('id', params.transactionId);
  if (params && params.clientIdentifier) query.set('clientIdentifier', params.clientIdentifier);
  return sigilopayRequest('GET', '/gateway/transactions?' + query.toString());
}

module.exports = { createPixCharge, getTransaction, SigilopayError };
