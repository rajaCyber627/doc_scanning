const express = require('express');
const router = express.Router();
const File = require('../../models/File');
const Folder = require('../../models/Folder');
const TableResult = require('../tables/TableResult.model');
const Chunk = require('../query/Chunk.model');
const { s3, BUCKET } = require('../../providers/storage/client');
const { emitAudit } = require('../../core/audit');
const { removeDocument } = require('../documents/removeDocument');

// Create an (empty) folder to upload a set into
router.post('/api/folders', async (req, res) => {
  try {
    const { userId, name } = req.body;
    if (!userId) return res.status(400).json({ message: 'userId is required' });
    const folder = await Folder.create({
      userId,
      name: (name && String(name).trim()) || `Set · ${new Date().toLocaleString()}`,
    });
    res.status(201).json(folder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Folders (sets) for a user
router.get('/api/folders', async (req, res) => {
  try {
    const { userId } = req.query;
    const folders = await Folder.find(userId ? { userId } : {}).sort({ createdAt: -1 });
    res.json(folders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Folder detail: the folder + its files + tables saved from it
router.get('/api/folders/:id', async (req, res) => {
  try {
    const folder = await Folder.findById(req.params.id);
    if (!folder) return res.status(404).json({ message: 'Folder not found' });
    const files = await File.find({ folderId: folder._id })
      .select('-rawText -tablesCsv -words')
      .sort({ createdAt: -1 });
    const tables = await TableResult.find({ folderId: folder._id }).sort({ createdAt: -1 });
    res.json({ folder, files, tables });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Delete a folder and everything under it (files + their tables + S3 objects)
router.delete('/api/folders/:id', async (req, res) => {
  try {
    const files = await File.find({ folderId: req.params.id });
    for (const file of files) {
      await removeDocument(file);
      await emitAudit({
        userId: req.query.userId || file.userId,
        action: 'document.deleted',
        documentId: file._id,
        details: { fileName: file.fileName, sha256: file.sha256 || null, viaFolder: req.params.id },
      });
    }
    const folder = await Folder.findByIdAndDelete(req.params.id);
    if (folder) {
      await emitAudit({
        userId: req.query.userId || folder.userId,
        action: 'folder.deleted',
        details: { folderId: String(folder._id), name: folder.name, files: files.length },
      });
    }
    res.json({ message: 'Folder deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;
