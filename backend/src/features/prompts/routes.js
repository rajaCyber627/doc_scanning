const express = require('express');
const router = express.Router();
const SavedPrompt = require('./SavedPrompt.model');

// Saved prompts (reusable, named)
router.get('/api/prompts', async (req, res) => {
  try {
    const { userId } = req.query;
    const prompts = await SavedPrompt.find(userId ? { userId } : {}).sort({ createdAt: -1 });
    res.json(prompts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});
router.post('/api/prompts', async (req, res) => {
  try {
    const { userId, title, prompt } = req.body;
    if (!userId || !title || !prompt) return res.status(400).json({ message: 'Missing fields' });
    const saved = await SavedPrompt.create({
      userId,
      title: String(title).slice(0, 120),
      prompt: String(prompt).slice(0, 2000),
    });
    res.status(201).json(saved);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});
router.delete('/api/prompts/:id', async (req, res) => {
  try {
    await SavedPrompt.findByIdAndDelete(req.params.id);
    res.json({ message: 'Prompt deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

module.exports = router;
