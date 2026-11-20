// Builds the Express app (no DB connection, no listen) so tests can use it directly.
require('./core/config');
const path = require('path');
const express = require('express');
const cors = require('cors');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Each feature exposes an Express router from features/<name>/routes.js.
const FEATURES = ['auth', 'prompts', 'upload', 'batches', 'duplicates', 'metadata', 'classification', 'splitting', 'merging', 'intake', 'documents', 'search', 'tables', 'folders', 'query'];

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cors());
  app.use(express.static(PUBLIC_DIR));

  for (const name of FEATURES) app.use(require(`./features/${name}/routes`));

  // SPA fallback — serve the built UI for any non-/api route
  app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  return app;
}

module.exports = { createApp };
