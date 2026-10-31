import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

// Wraps async route handlers so thrown errors reach the error middleware.
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path.join('.');
    return res.status(400).json({ error: field ? `${field}: ${first.message}` : first?.message ?? 'Invalid input' });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'A record with this value already exists' });
    if (err.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    if (err.code === 'P2003') return res.status(409).json({ error: 'This record is in use and cannot be changed' });
  }
  console.error(err);
  // Never leak internals to the client.
  return res.status(500).json({ error: 'Something went wrong' });
}
