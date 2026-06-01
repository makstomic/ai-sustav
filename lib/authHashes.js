const bcrypt = require("bcryptjs");

const hashes = {};

async function initAuthHashes() {
  for (const [key, val] of Object.entries(process.env)) {
    if (!key.startsWith("ADMIN_PASSWORD_")) continue;
    const clientId = key.slice("ADMIN_PASSWORD_".length).toLowerCase().replace(/_/g, "-");
    hashes[clientId] = await bcrypt.hash(val, 12);
  }
}

function getHash(clientId) {
  return hashes[clientId] || null;
}

module.exports = { initAuthHashes, getHash };
