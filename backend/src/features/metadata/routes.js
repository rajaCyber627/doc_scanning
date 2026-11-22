// Metadata + taxonomy API (P09).
const express = require('express');
const service = require('./service');

const router = express.Router();
const handle = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof service.MetadataError) return res.status(err.status).json({ message: err.message, details: err.details });
    console.error(`${label}:`, err && err.message);
    res.status(500).json({ message: 'Something went wrong with the document details' });
  }
};

// Taxonomy (everyone can read; admins change)
router.get('/api/taxonomy', handle('taxonomy', async (req, res) => res.json(await service.getTaxonomy({ includeInactive: req.query.all === '1' }))));
router.get(
  '/api/taxonomy/export',
  handle('taxonomy export', async (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="hr-taxonomy.json"');
    res.json(await service.exportTaxonomy());
  })
);
router.post(
  '/api/taxonomy/import',
  handle('taxonomy import', async (req, res) => res.json(await service.importTaxonomy(req.body.userId, req.body.data, { mode: req.body.mode })))
);
router.put(
  '/api/taxonomy/document-types/:key',
  handle('taxonomy type', async (req, res) => res.json(await service.saveDocumentType(req.body.userId, { ...req.body.type, key: req.params.key })))
);

// People directory (via the partner HRDMS)
router.get('/api/people', handle('people', async (req, res) => res.json(await service.lookupPeople(req.query.q))));

// Document metadata
router.put(
  '/api/files/:id/metadata',
  handle('metadata', async (req, res) => res.json(await service.updateMetadata(req.params.id, req.body || {})))
);
router.post('/api/metadata/bulk', handle('bulk metadata', async (req, res) => res.json(await service.bulkUpdate(req.body || {}))));
router.get(
  '/api/metadata/next',
  handle('next incomplete', async (req, res) => res.json(await service.nextIncomplete(req.query.userId, req.query.after)))
);

module.exports = router;
