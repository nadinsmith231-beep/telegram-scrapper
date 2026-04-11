import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import telegramHandler from './api/telegram.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

// API route
app.post('/api/telegram', async (req, res) => {
  try {
    await telegramHandler(req, res);
  } catch (err) {
    console.error('Handler error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve index.html for all other routes (for SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
