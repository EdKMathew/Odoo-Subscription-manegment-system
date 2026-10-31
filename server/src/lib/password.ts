import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { z } from 'zod';

// More than 8 characters, with upper case, lower case and a special character.
export const passwordSchema = z
  .string()
  .min(9, 'Password must be more than 8 characters')
  .max(128, 'Password is too long')
  .regex(/[A-Z]/, 'Password needs an uppercase letter')
  .regex(/[a-z]/, 'Password needs a lowercase letter')
  .regex(/[^A-Za-z0-9]/, 'Password needs a special character');

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

// Random tokens are sent to the user; only their SHA-256 hash is stored.
export function createToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashToken(token) };
}

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
