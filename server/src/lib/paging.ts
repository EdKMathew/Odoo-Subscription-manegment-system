import type { Request } from 'express';
import { z } from 'zod';

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function paging(req: Request) {
  const { page, pageSize } = pageSchema.parse(req.query);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export const pageResult = <T>(data: T[], total: number, page: number, pageSize: number) => ({
  data,
  total,
  page,
  pageSize,
  pages: Math.max(1, Math.ceil(total / pageSize)),
});

export const idParam = (req: Request, name = 'id') => z.coerce.number().int().positive().parse(req.params[name]);

export const optionalString = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : undefined);
