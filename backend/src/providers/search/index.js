// The search provider in use (SEARCH_PROVIDER = mongo | atlas).
const config = require('../../core/config');

const PROVIDERS = {
  mongo: () => require('./mongo'),
  atlas: () => require('./atlas'),
};

function getSearchProvider() {
  const load = PROVIDERS[config.search.provider];
  if (!load) throw new Error(`Unknown SEARCH_PROVIDER "${config.search.provider}"`);
  return load();
}

module.exports = { getSearchProvider };
