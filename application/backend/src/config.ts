import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  etherpadApiUrl: string;
  etherpadPublicUrl: string;
  etherpadApiKey: string;
  internalKey: string;
  localDevelopment: boolean;
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a valid port');
  }

  const etherpadApiUrl = process.env.ETHERPAD_API_URL;
  const etherpadPublicUrl = process.env.ETHERPAD_PUBLIC_URL;
  const keyFile = process.env.ETHERPAD_API_KEY_FILE;
  if (!etherpadApiUrl || !etherpadPublicUrl || !keyFile) {
    throw new Error('Etherpad configuration is incomplete');
  }
  const urls: Array<[string, string]> = [
    ['ETHERPAD_API_URL', etherpadApiUrl],
    ['ETHERPAD_PUBLIC_URL', etherpadPublicUrl],
  ];
  for (const [name, value] of urls) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`${name} must use HTTP(S)`);
    }
  }

  const etherpadApiKey = readFileSync(resolve(keyFile), 'utf8').trim();
  if (!etherpadApiKey) throw new Error('Etherpad API key is empty');
  const internalFile = process.env.INTERNAL_KEY_FILE;
  const databaseUrl = process.env.DATABASE_URL;
  if (!internalFile || !databaseUrl) throw new Error('Internal key and database URL are required');
  const internalKey = readFileSync(resolve(internalFile), 'utf8').trim();
  if (!internalKey) throw new Error('Internal key is empty');
  return {
    port,
    host: process.env.HOST ?? '127.0.0.1',
    databaseUrl,
    etherpadApiUrl,
    etherpadPublicUrl,
    etherpadApiKey,
    internalKey,
    localDevelopment: process.env.APP_ENV === 'local',
  };
}
