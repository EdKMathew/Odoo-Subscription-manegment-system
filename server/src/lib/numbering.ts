import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

// Atomic counter: concurrent callers always get distinct numbers.
export async function nextNumber(tx: Tx, key: 'SUB' | 'INV', pad = 6): Promise<string> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "Counter" ("key", "value") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "value" = "Counter"."value" + 1
    RETURNING "value"`;
  return `${key}-${String(rows[0].value).padStart(pad, '0')}`;
}
