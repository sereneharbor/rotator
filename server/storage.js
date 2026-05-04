const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '../data/store.json');

const DEFAULT_STORE = {
  mirrors: [],
  config: {
    probeTimeoutMs: 3000,
    updatedAt: new Date().toISOString(),
  },
  history: [],
};

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

module.exports = { readStore, writeStore };
