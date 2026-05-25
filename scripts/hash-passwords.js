require("dotenv").config();
const fs     = require("fs");
const path   = require("path");
const bcrypt = require("bcryptjs");

const clientsDir = path.join(__dirname, "..", "clients");
const files = fs.readdirSync(clientsDir).filter(f => f.endsWith(".json"));

(async () => {
  let updated = 0;
  let skipped = 0;

  for (const file of files) {
    const clientId = file.replace(".json", "").toUpperCase();
    const envKey   = `ADMIN_PASSWORD_${clientId}`;
    const password = process.env[envKey];

    if (!password) {
      console.log(`${file}: nema ${envKey} u .env — preskačem.`);
      skipped++;
      continue;
    }

    const filePath = path.join(clientsDir, file);
    const client   = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    const hash = await bcrypt.hash(password, 12);
    client.adminPasswordHash = hash;
    delete client.adminToken;

    fs.writeFileSync(filePath, JSON.stringify(client, null, 2), "utf-8");
    console.log(`${file}: adminPasswordHash ažuriran. ✓`);
    updated++;
  }

  console.log(`\nGotovo. Ažurirano: ${updated}, preskočeno: ${skipped}`);
})();
