require('dotenv').config();

const express = require('express');
const path = require('path');

if (!process.env.ADMIN_PASSWORD) {
  console.error('ERROR: ADMIN_PASSWORD environment variable is required');
  process.exit(1);
}
if (!process.env.JWT_SECRET) {
  console.error('ERROR: JWT_SECRET environment variable is required');
  process.exit(1);
}

const app = express();

app.use(express.json());

// API routes
app.use('/api', require('./routes/auth'));
app.use('/api/mirrors', require('./routes/mirrors'));
app.use('/api/config', require('./routes/config'));
app.use('/api/history', require('./routes/history'));
app.use('/api/log', require('./routes/log'));
app.use('/api/probe', require('./routes/probe'));
app.use('/api/poll', require('./routes/poll'));

// Serve React SPA in production
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '../dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Start background poll scheduler after the server is listening
  require('./scheduler').start();
});
