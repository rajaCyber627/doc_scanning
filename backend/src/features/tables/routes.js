const express = require('express');
const router = express.Router();
const File = require('../../models/File');
const TableResult = require('./TableResult.model');

// All saved tables for a user (across documents)
router.get('/api/tables', async (req, res) => {
  try {
    const { userId } = req.query;
    const tables = await TableResult.find(userId ? { userId } : {})
      .populate({ path: 'fileId', select: 'fileName' })
      .sort({ createdAt: -1 });
    res.json(tables);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Save a table from any query (single- or multi-file)
router.post('/api/tables', async (req, res) => {
  try {
    const { userId, query, data, fileIds, sourceLabel, folderId } = req.body;
    if (!userId || !query || typeof data === 'undefined')
      return res.status(400).json({ message: 'Missing fields' });
    const ids = Array.isArray(fileIds) ? fileIds : [];
    const srcFiles = ids.length
      ? (await File.find({ _id: { $in: ids } }).select('fileName')).map((f) => f.fileName)
      : [];
    const table = await TableResult.create({
      userId,
      query,
      data,
      fileIds: ids,
      folderId: folderId || null,
      sourceLabel: sourceLabel || '',
      sourceFileNames: srcFiles,
    });
    res.status(201).json(table);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Delete any saved table by id
router.delete('/api/tables/:tableId', async (req, res) => {
  try {
    await TableResult.findByIdAndDelete(req.params.tableId);
    res.json({ message: 'Table deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// A single saved table (for the full-page view)
router.get('/api/tables/:id', async (req, res) => {
  try {
    const table = await TableResult.findById(req.params.id);
    if (!table) return res.status(404).json({ message: 'Table not found' });
    res.json(table);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Rename a saved table (custom title; the original query is kept)
router.patch('/api/tables/:id', async (req, res) => {
  try {
    const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const table = await TableResult.findByIdAndUpdate(req.params.id, { title }, { new: true });
    if (!table) return res.status(404).json({ message: 'Table not found' });
    res.json(table);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Save a generated table
router.post('/api/files/:id/tables', async (req, res) => {
  try {
    const { query, data } = req.body;
    const file = await File.findById(req.params.id);
    if (!file) return res.status(404).json({ message: 'File not found' });
    const table = await TableResult.create({ fileId: file._id, userId: file.userId, query, data });
    res.status(201).json(table);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// List saved tables for a file
router.get('/api/files/:id/tables', async (req, res) => {
  try {
    const tables = await TableResult.find({ fileId: req.params.id }).sort({ createdAt: -1 });
    res.json(tables);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Delete a saved table
router.delete('/api/files/:id/tables/:tableId', async (req, res) => {
  try {
    await TableResult.findByIdAndDelete(req.params.tableId);
    res.json({ message: 'Table deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;
