import nodemailer from 'nodemailer';

type Message = {to: string; subject: string; text: string};
const localMailbox: Message[] = [];
const localFailures = new Set<string>();

export async function sendEmail(message: Message): Promise<void> {
  if (process.env.APP_ENV === 'local') {
    if (message.to.endsWith('@fail.test') && !localFailures.has(message.to)) {
      localFailures.add(message.to);
      throw new Error('Injected local mail failure');
    }
    localMailbox.push(message);
    return;
  }
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  if (!host || !from) throw new Error('SMTP_HOST and SMTP_FROM are required');
  const port = Number(process.env.SMTP_PORT ?? '587');
  const transport = nodemailer.createTransport({
    host, port, secure: port === 465,
    auth: process.env.SMTP_USER && process.env.SMTP_PASSWORD
      ? {user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD} : undefined,
  });
  await transport.sendMail({from, ...message});
}

export function localMessages(email: string): Message[] {
  return localMailbox.filter((item) => item.to === email);
}
