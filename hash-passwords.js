// Pokreni jednom: node hash-passwords.js
// Hashira adminToken u svim clients/*.json i sprema kao adminPasswordHash

const fs      = require("fs");
const path    = require("path");
const bcrypt  = require("bcryptjs");

const clientsDir = path.join(__dirname, "clients");
const files = fs.readdirSync(clientsDir).filter(f => f.endsWith(".json"));

(async () => {
  for (const file of files) {
    const filePath = path.join(clientsDir, file);
    const client = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    if (client.adminPasswordHash) {
      console.log(`${file}: već ima hash, preskačem.`);
      continue;
    }

    if (!client.adminToken) {
      console.log(`${file}: nema adminToken, preskačem.`);
      continue;
    }

    const hash = await bcrypt.hash(client.adminToken, 12);
    client.adminPasswordHash = hash;

    fs.writeFileSync(filePath, JSON.stringify(client, null, 2), "utf-8");
    console.log(`${file}: hash dodan. ✓`);
  }

  console.log("\nGotovo. Možeš pushati izmjene.");
})();
