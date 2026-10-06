// Creates an administrator account. Usage:
//   npm run create-admin -- --email you@example.com --name "Your Name"
// The password is read from SAYPACK_ADMIN_PASSWORD, or prompted for.
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { openDatabase } from "@/db/database";
import { DomainError, systemCtx } from "@/domain/core";
import { createUser, hashPassword } from "@/domain/identity";
import { DB_PATH, PHOTO_ROOT } from "@/storage/paths";
import { PhotoStore } from "@/storage/photo-store";

async function main() {
  const { values } = parseArgs({
    options: { email: { type: "string" }, name: { type: "string" } },
  });
  if (!values.email || !values.name) {
    console.error('Usage: npm run create-admin -- --email you@example.com --name "Your Name"');
    process.exit(1);
  }

  let password = process.env.SAYPACK_ADMIN_PASSWORD;
  if (!password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question("Password (at least 10 characters): ");
    rl.close();
  }

  const ctx = systemCtx(openDatabase(DB_PATH), new PhotoStore(PHOTO_ROOT));
  const dbPath = DB_PATH;
  try {
    const user = createUser(ctx, null, null, {
      email: values.email,
      displayName: values.name,
      passwordHash: await hashPassword(password),
      isAdmin: true,
    });
    console.log(`Created administrator ${user.email} in ${dbPath}`);
  } catch (error) {
    if (error instanceof DomainError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  } finally {
    ctx.db.close();
  }
}

void main();
