import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/errors';

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  customerId: number | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export const AUTH_COOKIE = 'token';
const TOKEN_TTL_SECONDS = 8 * 60 * 60;

export function issueSession(res: Response, userId: number) {
  const token = jwt.sign({ sub: String(userId) }, config.jwtSecret, {
    expiresIn: TOKEN_TTL_SECONDS,
    algorithm: 'HS256',
  });
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.isProd,
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: '/',
  });
}

export function clearSession(res: Response) {
  res.clearCookie(AUTH_COOKIE, { httpOnly: true, sameSite: 'strict', secure: config.isProd, path: '/' });
}

// Verifies the session cookie and reloads the user so role changes and
// deactivation take effect immediately.
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[AUTH_COOKIE];
    if (!token) throw new HttpError(401, 'Please log in');
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    } catch {
      throw new HttpError(401, 'Your session has expired, please log in again');
    }
    const user = await prisma.user.findUnique({
      where: { id: Number(payload.sub) },
      select: { id: true, email: true, name: true, role: true, customerId: true, active: true, passwordChangedAt: true },
    });
    if (!user || !user.active) throw new HttpError(401, 'Please log in');
    // Sessions issued before the last password change are no longer valid.
    if ((payload.iat ?? 0) * 1000 < user.passwordChangedAt.getTime() - 1000) {
      throw new HttpError(401, 'Your password was changed, please log in again');
    }
    req.user = { id: user.id, email: user.email, name: user.name, role: user.role, customerId: user.customerId };
    next();
  } catch (err) {
    next(err);
  }
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'Please log in'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, 'You do not have permission to do this'));
    next();
  };

export const staffOnly = requireRole('ADMIN', 'STAFF');
export const adminOnly = requireRole('ADMIN');

// For customers, returns their customer id so queries can be scoped to their own data.
export function customerScope(req: Request): number | undefined {
  if (req.user?.role !== 'CUSTOMER') return undefined;
  if (!req.user.customerId) throw new HttpError(403, 'No customer profile linked to this account');
  return req.user.customerId;
}
