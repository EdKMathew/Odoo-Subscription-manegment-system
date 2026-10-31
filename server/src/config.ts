import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret,
  clientUrl: process.env.CLIENT_URL ?? 'http://localhost:5173',
  isProd: process.env.NODE_ENV === 'production',
  companyName: process.env.COMPANY_NAME ?? 'SubFlow Pvt Ltd',
  companyState: process.env.COMPANY_STATE ?? 'Kerala',
  resetTokenMinutes: 30,
  quoteAcceptDays: 30,
};
