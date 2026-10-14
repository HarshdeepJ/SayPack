// Sets a new password for an existing user and signs them out everywhere. Usage:
//   npm run reset-password -- --email mover@example.com
// The password is read from SAYPACK_NEW_PASSWORD, or prompted for. Safe while the app runs.
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { openDatabase } from "@/db/database";
import { DomainError, systemCtx } from "@/domain/core";
import { hashPassword, resetPassword } from "@/domain/identity";
import { DB_PATH, PHOTO_ROOT } from "@/storage/paths";
import { PhotoStore } from "@/storage/photo-store";

async function main() {
  const { values } = parseArgs({ options: { email: { type: "string" } } });
  if (!values.email) {
    console.error("Usage: npm run reset-password -- --email mover@example.com");
    process.exit(1);
  }

  let password = process.env.SAYPACK_NEW_PASSWORD;
  if (!password) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question("New password (at least 10 characters): ");
    rl.close();
  }

  const ctx = systemCtx(openDatabase(DB_PATH), new PhotoStore(PHOTO_ROOT));
  try {
    const user = resetPassword(ctx, { email: values.email, passwordHash: await hashPassword(password) });
    console.log(`Reset the password for ${user.email} in ${DB_PATH}; their sessions were ended.`);
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
