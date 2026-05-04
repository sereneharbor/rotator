const express = require('express');
const requireAuth = require('../middleware/auth');
const { readStore } = require('../storage');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const store = readStore();
  res.json(store.history);
});

module.exports = router;
