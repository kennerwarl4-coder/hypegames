'use strict';

const products = require('./products.json');

const byId = new Map(products.map(function (p) { return [String(p.id), p]; }));

function getProductById(id) {
  return byId.get(String(id)) || null;
}

module.exports = { getProductById, products: products };
