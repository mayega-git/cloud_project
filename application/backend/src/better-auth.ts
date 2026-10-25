import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {betterAuth} from 'better-auth';
import {emailOTP} from 'better-auth/plugins';
import {sendEmail} from './email.js';

const secretFile = process.env.BETTER_AUTH_SECRET_FILE;
if (!secretFile) throw new Error('BETTER_AUTH_SECRET_FILE is required');
const secret = readFileSync(resolve(secretFile), 'utf8').trim();
if (secret.length < 32) throw new Error('Better Auth secret is too short');

export const authPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c search_path=auth',
});

export const auth = betterAuth({
  database: authPool,
  secret,
  baseURL: process.env.AUTH_BASE_URL ?? 'http://127.0.0.1:3000',
  plugins: [emailOTP({
    expiresIn: 300,
    allowedAttempts: 5,
    async sendVerificationOTP({email, otp}) {
      await sendEmail({to: email, subject: 'Verification code', text: `Your code is: ${otp}`});
    },
  })],
});
