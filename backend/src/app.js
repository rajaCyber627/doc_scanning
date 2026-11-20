// Builds the Express app (no DB connection, no listen) so tests can use it directly.
require('./config');
const path = require('path');
const express = require('express');
const cors = require('cors');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cors());
  app.use(express.static(PUBLIC_DIR));

  app.use(require('./routes/auth'));
  app.use(require('./routes/prompts'));
  app.use(require('./routes/files'));
  app.use(require('./routes/search'));
  app.use(require('./routes/tables'));
  app.use(require('./routes/folders'));
  app.use(require('./routes/query'));

  // SPA fallback — serve the built UI for any non-/api route
  app.get(/^\/(?!api).*/, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  return app;
}

module.exports = { createApp };
