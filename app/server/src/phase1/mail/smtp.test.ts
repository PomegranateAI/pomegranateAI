import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { smtpConfigFromEnv, sendMagicLinkEmail, sendMail, buildMessage, encodeSubject } from './smtp.js';

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

describe('header injection guards', () => {
  const headerNames = (msg: string) =>
    msg
      .slice(0, msg.indexOf('\r\n\r\n'))
      .split('\r\n')
      .filter((l) => !/^\s/.test(l))
      .map((l) => l.slice(0, l.indexOf(':')));

  it('a CRLF in the subject is flattened to a space; no header is injected', () => {
    const msg = buildMessage({
      from: 'no-reply@pomegranate.test',
      to: 'ic@example.com',
      subject: 'Access to "Acme\r\nBcc: victim@evil.test\r\n\r\nhi"',
      body: 'body',
    });
    expect(headerNames(msg)).toEqual(['From', 'To', 'Subject', 'Date', 'MIME-Version', 'Content-Type']);
    expect(msg).not.toMatch(/^Bcc:/m);
    expect(msg).toContain('Subject: Access to "Acme Bcc: victim@evil.test hi"');
  });

  it('a CRLF recipient or sender throws in buildMessage and sendMail', async () => {
    expect(() =>
      buildMessage({ from: 'a@x.test', to: 'ic@example.com\r\nBcc: v@evil.test', subject: 's', body: 'b' }),
    ).toThrow(/line break/);
    expect(() => buildMessage({ from: 'a@x.test\n', to: 'ic@example.com', subject: 's', body: 'b' })).toThrow(
      /line break/,
    );
    await expect(
      sendMail({
        // Nothing listens here: the guard must fire before any connection.
        config: { host: '127.0.0.1', port: 1, secure: false, from: 'no-reply@pomegranate.test' },
        to: 'ic@example.com>\r\nRCPT TO:<v@evil.test',
        subject: 's',
        text: 't',
      }),
    ).rejects.toThrow(/line break/);
  });

  it('RFC 2047-encodes a non-ASCII subject, leaves ASCII and pre-encoded subjects alone', () => {
    expect(encodeSubject('Plain subject')).toBe('Plain subject');
    expect(encodeSubject('=?UTF-8?B?w6l0w6k=?= already')).toBe('=?UTF-8?B?w6l0w6k=?= already');
    const enc = encodeSubject('Accès à « Équipe » ✓');
    expect(enc).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(Buffer.from(enc.slice(10, -2), 'base64').toString('utf8')).toBe('Accès à « Équipe » ✓');
    // Long subjects fold into several encoded-words, each within 75 chars.
    const words = encodeSubject('é'.repeat(100)).split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    expect(words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('')).toBe('é'.repeat(100));
    const msg = buildMessage({ from: 'a@x.test', to: 'b@x.test', subject: 'é'.repeat(100), body: 'b' });
    expect(headerNames(msg)).toEqual(['From', 'To', 'Subject', 'Date', 'MIME-Version', 'Content-Type']);
  });
});
