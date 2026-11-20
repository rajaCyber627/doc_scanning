// Document splitting API (P11).
const express = require('express');
const { UserFacingError } = require('../../core/errors');
const service = require('./service');
const separators = require('./separators');
const metadata = require('../metadata/service');

const router = express.Router();
const handle = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof service.SplitError) return res.status(err.status).json({ message: err.message });
    if (err instanceof UserFacingError) return res.status(409).json({ message: err.message, code: err.code });
    console.error(`${label}:`, err && err.message);
    res.status(500).json({ message: 'Something went wrong while splitting' });
  }
};

router.get('/api/files/:id/lineage', handle('lineage', async (req, res) => res.json(await service.lineage(req.params.id, req.query.userId))));
router.get('/api/files/:id/pages', handle('pages', async (req, res) => res.json(await service.getPages(req.params.id, req.query.userId))));
// the PDF the page view draws its thumbnails from (same-origin, for pdf.js)
router.get(
  '/api/files/:id/pages.pdf',
  handle('pages pdf', async (req, res) => {
    const pdf = await service.pagesPdf(req.params.id, req.query.userId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(pdf);
  })
);
router.post('/api/files/:id/split/suggest', handle('suggest split', async (req, res) => res.json(await service.suggest(req.params.id, (req.body || {}).userId))));
router.post('/api/files/:id/split/keep', handle('keep whole', async (req, res) => res.json(await service.keepWhole(req.params.id, (req.body || {}).userId))));
router.post('/api/files/:id/split', handle('split', async (req, res) => res.json(await service.split(req.params.id, req.body || {}))));

// Printable separator sheet; ?documentType=&employeeId=&copies=
router.get(
  '/api/separator-sheet.pdf',
  handle('separator sheet', async (req, res) => {
    const { documentType = '', employeeId = '' } = req.query;
    let documentTypeName = '';
    if (documentType) {
      const t = (await metadata.getTaxonomy()).documentTypes.find((x) => x.key === documentType);
      if (!t) return res.status(400).json({ message: 'Unknown document type' });
      documentTypeName = t.name;
    }
    if (employeeId && !/^[\w-]{1,40}$/.test(employeeId)) return res.status(400).json({ message: 'Employee ID may only contain letters, digits and dashes' });
    const pdf = await separators.sheetPdf({ documentType, documentTypeName, employeeId, copies: Math.min(100, Number(req.query.copies) || 1) });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="separator-sheet.pdf"');
    res.end(pdf);
  })
);

router.get('/api/settings/splitting', handle('split settings', async (req, res) => res.json(await service.getSettings())));
router.put(
  '/api/settings/splitting',
  handle('save split settings', async (req, res) => res.json(await service.saveSettings(req.body.userId, req.body.settings || {})))
);

module.exports = router;
