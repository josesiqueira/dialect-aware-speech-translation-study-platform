// Entry point of `pnpm db:seed`. Uses DATABASE_URL. Safe to run more than once.
import { fileURLToPath } from "node:url";
import { createDatabase } from "../client";
import { seedDevelopmentData } from "./seed";

export { seedDevelopmentData } from "./seed";
export type { SeedResult } from "./seed";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const handle = createDatabase(url, { max: 1 });
  try {
    const result = await seedDevelopmentData(handle.db);
    if (result.created.length === 0) {
      console.log("Seed: nothing to do, all records already exist");
    } else {
      console.log(`Seed: created ${result.created.length} records`);
      for (const name of result.created) console.log(`  ${name}`);
    }
  } finally {
    await handle.close();
  }
}

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
