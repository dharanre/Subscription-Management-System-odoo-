import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  createdAt: string;
}

export interface Mailer {
  send(mail: Omit<Mail, 'createdAt'>): Promise<void>;
}

/**
 * Local stand-in for a mail provider: every message is written to disk and can be read on the
 * dev mailbox page. No cloud service is involved, and nothing is actually delivered.
 */
export class DevMailbox implements Mailer {
  constructor(private readonly dir: string) {}

  async send(mail: Omit<Mail, 'createdAt'>): Promise<void> {
    const full: Mail = { ...mail, createdAt: new Date().toISOString() };
    await fs.promises.mkdir(this.dir, { recursive: true });
    const name = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`;
    await fs.promises.writeFile(path.join(this.dir, name), JSON.stringify(full, null, 2), 'utf8');
    console.log(`[dev-mailbox] "${mail.subject}" saved for ${mail.to}`);
  }

  async list(limit = 50): Promise<Mail[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const newest = names.filter((n) => n.endsWith('.json')).sort().reverse().slice(0, limit);
    const mails: Mail[] = [];
    for (const n of newest) {
      mails.push(JSON.parse(await fs.promises.readFile(path.join(this.dir, n), 'utf8')) as Mail);
    }
    return mails;
  }

  async clear(): Promise<void> {
    await fs.promises.rm(this.dir, { recursive: true, force: true });
  }
}

/** Test double that keeps messages in memory. */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Omit<Mail, 'createdAt'>): Promise<void> {
    this.sent.push({ ...mail, createdAt: new Date().toISOString() });
  }
}
