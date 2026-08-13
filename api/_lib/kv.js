'use strict';

const { kv } = require('@vercel/kv');

const THIRTY_DAYS = 60 * 60 * 24 * 30;

function paymentKey(identifier) {
  return 'payment:' + identifier;
}

function webhookDedupeKey(eventKey) {
  return 'webhook-seen:' + eventKey;
}

async function getPayment(identifier) {
  return kv.get(paymentKey(identifier));
}

async function savePayment(identifier, data) {
  return kv.set(paymentKey(identifier), data, { ex: THIRTY_DAYS });
}

// Marca um evento de webhook como processado de forma atômica (SET NX).
// Retorna true se este é o primeiro processamento (deve seguir); false se já
// tinha sido visto antes (deve responder 2xx sem reprocessar).
async function markWebhookEventOnce(eventKey) {
  const result = await kv.set(webhookDedupeKey(eventKey), '1', { nx: true, ex: THIRTY_DAYS });
  return result === 'OK' || result === true;
}

module.exports = { getPayment, savePayment, markWebhookEventOnce };
