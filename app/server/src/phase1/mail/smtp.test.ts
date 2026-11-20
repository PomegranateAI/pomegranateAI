import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { smtpConfigFromEnv, sendMagicLinkEmail } from './smtp.js';

describe('smtpConfigFromEnv', () => {
  it('returns null when SMTP_URL is unset (dev fallback)', () => {
    expect(smtpConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(smtpConfigFromEnv({ SMTP_URL: '  ' } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it('parses smtp:// with default port 587 and STARTTLS posture', () => {
    const cfg = smtpConfigFromEnv({
      SMTP_URL: 'smtp://user:pass@mail.example.com',
      MAIL_FROM: 'no-reply@example.com',
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({
      host: 'mail.example.com',
      port: 587,
      secure: false,
      user: 'user',
      pass: 'pass',
      from: 'no-reply@example.com',
    });
  });

  it('parses smtps:// with default port 465 (implicit TLS)', () => {
    const cfg = smtpConfigFromEnv({
      SMTP_URL: 'smtps://u:p@smtp.host.io',
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ port: 465, secure: true, host: 'smtp.host.io' });
  });

  it('defaults from to the user when MAIL_FROM is unset', () => {
    const cfg = smtpConfigFromEnv({
      SMTP_URL: 'smtp://sender@host:2525',
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg?.from).toBe('sender');
    expect(cfg?.port).toBe(2525);
  });
});

/**
 * Spin up a one-shot in-process SMTP server that speaks just enough of the
 * protocol to drive our client through the full conversation, capturing the
 * delivered message. Plaintext, no AUTH (the client only authenticates when a
 * username is present in the URL — here we omit it).
 */
function fakeSmtpServer(): Promise<{ port: number; received: Promise<string>; close: () => void }> {
  return new Promise((resolve) => {
    let resolveReceived: (s: string) => void;
    const received = new Promise<string>((r) => (resolveReceived = r));
    let dataMode = false;
    let body = '';

    const server = net.createServer((sock) => {
      sock.setEncoding('utf8');
      sock.write('220 fake-smtp ready\r\n');
      let buf = '';
      sock.on('data', (chunk: string) => {
        if (dataMode) {
          body += chunk;
          if (body.includes('\r\n.\r\n')) {
            dataMode = false;
            sock.write('250 OK queued\r\n');
            resolveReceived(body.slice(0, body.indexOf('\r\n.\r\n')));
          }
          return;
        }
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const upper = line.toUpperCase();
          if (upper.startsWith('EHLO')) sock.write('250 fake-smtp\r\n');
          else if (upper.startsWith('MAIL FROM')) sock.write('250 OK\r\n');
          else if (upper.startsWith('RCPT TO')) sock.write('250 OK\r\n');
          else if (upper.startsWith('DATA')) {
            sock.write('354 end with .\r\n');
            dataMode = true;
          } else if (upper.startsWith('QUIT')) {
            sock.write('221 bye\r\n');
            sock.end();
          } else sock.write('250 OK\r\n');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ port: addr.port, received, close: () => server.close() });
    });
  });
}

describe('sendMagicLinkEmail (in-process SMTP round-trip)', () => {
  it('delivers the code to the server over a full SMTP conversation', async () => {
    const srv = await fakeSmtpServer();
    try {
      await sendMagicLinkEmail({
        config: {
          host: '127.0.0.1',
          port: srv.port,
          secure: false,
          from: 'no-reply@pomegranate.test',
        },
        to: 'ic@example.com',
        code: 'CODE-12345',
        origin: 'https://app.pomegranate.test',
      });
      const msg = await srv.received;
      expect(msg).toContain('To: ic@example.com');
      expect(msg).toContain('Subject: Your Pomegranate sign-in link');
      expect(msg).toContain('CODE-12345');
      expect(msg).toContain('https://app.pomegranate.test/?code=CODE-12345');
    } finally {
      srv.close();
    }
  });

  it('rejects when the server refuses the recipient', async () => {
    // A server that 550s the RCPT.
    const server = net.createServer((sock) => {
      sock.setEncoding('utf8');
      sock.write('220 ready\r\n');
      let buf = '';
      sock.on('data', (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, idx).toUpperCase();
          buf = buf.slice(idx + 2);
          if (line.startsWith('EHLO')) sock.write('250 ok\r\n');
          else if (line.startsWith('MAIL FROM')) sock.write('250 ok\r\n');
          else if (line.startsWith('RCPT TO')) sock.write('550 no such user\r\n');
          else sock.write('250 ok\r\n');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      await expect(
        sendMagicLinkEmail({
          config: { host: '127.0.0.1', port, secure: false, from: 'x@y.z' },
          to: 'nobody@example.com',
          code: 'X',
        }),
      ).rejects.toThrow(/RCPT TO rejected/);
    } finally {
      server.close();
    }
  });
});
