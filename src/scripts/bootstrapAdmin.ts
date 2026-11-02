import "dotenv/config";

import { bootstrapAdmins } from "../auth/bootstrap-admins.js";
import { closeDb } from "../db/client.js";

// The API also runs this on every start while the bootstrap variables are set; the script
// remains for running it by hand.
async function main() {
  const { created, existing } = await bootstrapAdmins(process.env.BOOTSTRAP_ADMIN_EMAIL, process.env.BOOTSTRAP_ADMIN_PASSWORD);
  for (const email of existing) console.info(`Admin ${email} already exists; no changes were made.`);
  for (const email of created) console.info(`Created owner account for ${email}.`);
  if (created.length) console.info("Remove the bootstrap password from the environment now.");
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Admin bootstrap failed.");
    process.exitCode = 1;
  })
  .finally(async () => closeDb());
