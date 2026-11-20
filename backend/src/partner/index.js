const config = require('../config');
const MockPartnerAdapter = require('./MockPartnerAdapter');

const ADAPTERS = { mock: MockPartnerAdapter };

let instance = null;

// The configured PartnerAdapter (PARTNER_ADAPTER, default "mock").
function getPartner() {
  if (!instance) {
    const Impl = ADAPTERS[config.partner.adapter];
    if (!Impl) throw new Error(`Unknown PARTNER_ADAPTER "${config.partner.adapter}"`);
    instance = new Impl();
  }
  return instance;
}

module.exports = { getPartner };
