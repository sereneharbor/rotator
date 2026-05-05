const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '../data/store.json');

// Default regex patterns (stored as strings, flags applied at probe time).
// Operators can edit these via the admin panel.
const DEFAULT_BLOCK_PATTERNS = [
  'доступ.*ограничен',
  'ограничен.*доступ',
  'сайт.*заблокирован',
  'ресурс.*заблокирован',
  'заблокирован.*роскомнадзор',
  'по\\s+решению\\s+суда',
  'по\\s+решению.*органа',
  'eais\\.rkn\\.gov\\.ru',
  'rkn\\.gov\\.ru',
  'roskomnadzor',
  'access.*denied.*legal',
  'legally.*unavailable',
  'blocked.*court.*order',
  'unavailable.*your.*region',
];

const DEFAULT_STORE = {
  mirrors: [],
  config: {
    probeTimeoutMs: 3000,
    alertWebhookUrl: null,
    alertThreshold: 3,
    blockPatterns: DEFAULT_BLOCK_PATTERNS,
    updatedAt: new Date().toISOString(),
  },
  history: [],
  redirectLog: [],
};

module.exports.DEFAULT_BLOCK_PATTERNS = DEFAULT_BLOCK_PATTERNS;

function readStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    return { ...DEFAULT_STORE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STORE };
  }
}

function writeStore(data) {
  const tmpPath = STORE_PATH + '.tmp.' + Date.now();
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpPath, STORE_PATH);
}

module.exports.readStore = readStore;
module.exports.writeStore = writeStore;
