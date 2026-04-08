import express from 'express';
import telegramHandler from './api/telegram.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('.')); // serve index.html and static files

// Mount the telegram API route
app.post('/api/telegram', async (req, res) => {
  // The telegram.js export expects a request and response object like Vercel
  await telegramHandler(req, res);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});