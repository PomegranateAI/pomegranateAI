import { describe, expect, it } from 'vitest';
import { parseWebhookMessages } from '../webhook.js';

const receivedShape = (keyOverrides: Record<string, unknown> = {}) => ({
  event: 'messages.received',
  timestamp: 1633456789,
  data: {
    messages: {
      key: {
        id: '3EB0X123456789',
        fromMe: false,
        remoteJid: '14155550100@s.whatsapp.net',
        senderPn: '14155550100@s.whatsapp.net',
        cleanedSenderPn: '14155550100',
        ...keyOverrides,
      },
      messageBody: 'Hello, I have a question',
      message: { conversation: 'Hello, I have a question' },
    },
  },
});

describe('parseWebhookMessages', () => {
  it('extracts phone + text from the messages.received shape', () => {
    const out = parseWebhookMessages(receivedShape());
    expect(out).toEqual([
      {
        id: '3EB0X123456789',
        phone: '14155550100',
        text: 'Hello, I have a question',
        audio: null,
        isGroup: false,
        replyTo: '+14155550100',
      },
    ]);
  });

  it('extracts from the messages.upsert array shape', () => {
    const body = {
      event: 'messages.upsert',
      data: {
        messages: [
          {
            key: { id: 'm1', fromMe: false, remoteJid: '14155550100@s.whatsapp.net' },
            messageBody: 'hi',
          },
          {
            key: { id: 'm2', fromMe: false, remoteJid: '14155550101@s.whatsapp.net' },
            messageBody: 'there',
          },
        ],
      },
    };
    const out = parseWebhookMessages(body);
    expect(out.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(out.map((m) => m.phone)).toEqual(['14155550100', '14155550101']);
    expect(out.map((m) => m.replyTo)).toEqual(['+14155550100', '+14155550101']);
  });

  it('drops messages the bot itself sent (fromMe)', () => {
    const echoed = receivedShape();
    echoed.data.messages.key.fromMe = true;
    expect(parseWebhookMessages(echoed)).toEqual([]);
  });

  it('drops non-text messages (no messageBody / conversation)', () => {
    const body = receivedShape() as {
      data: { messages: { messageBody?: string; message?: { conversation?: string } } };
    };
    body.data.messages.messageBody = undefined;
    body.data.messages.message = {};
    expect(parseWebhookMessages(body)).toEqual([]);
  });

  it('falls back to conversation when messageBody is absent', () => {
    const body = receivedShape();
    (body.data.messages as { messageBody?: string }).messageBody = undefined;
    expect(parseWebhookMessages(body)[0]?.text).toBe('Hello, I have a question');
  });

  it('preserves the media key needed to decrypt voice messages', () => {
    const body = receivedShape() as any;
    body.data.messages.messageBody = undefined;
    body.data.messages.message = {
      audioMessage: {
        url: 'https://mmg.whatsapp.net/encrypted',
        mimetype: 'audio/ogg; codecs=opus',
        mediaKey: 'base64-media-key',
        fileLength: '1234',
      },
    };

    expect(parseWebhookMessages(body)[0]?.audio).toEqual({
      url: 'https://mmg.whatsapp.net/encrypted',
      mimetype: 'audio/ogg; codecs=opus',
      mediaKey: 'base64-media-key',
      fileLength: '1234',
    });
  });

  it('a group message (messages-group.received shape) resolves the participant as phone, group JID as replyTo', () => {
    // Regression: replyTo used to be derived from `phone` (digits, formatted
    // as +<digits>) even for groups — WasenderAPI rejects that shape (422)
    // for a group id. replyTo must be the raw remoteJid, unmodified. And
    // `phone` must be the individual PARTICIPANT who sent it, not the
    // group's own JID digits — sender* fields are absent from a real group
    // payload; only participant* fields identify who actually sent it.
    const body = receivedShape({
      remoteJid: '123456-group@g.us',
      senderPn: undefined,
      cleanedSenderPn: undefined,
      participant: '14155550100@lid',
      participantPn: '14155550100@s.whatsapp.net',
      cleanedParticipantPn: '14155550100',
    });
    const out = parseWebhookMessages(body);
    expect(out[0]?.isGroup).toBe(true);
    expect(out[0]?.phone).toBe('14155550100');
    expect(out[0]?.replyTo).toBe('123456-group@g.us');
  });

  it('drops a group message with no participant info (Group Message Received event not enabled)', () => {
    // The generic messages.received/messages.upsert events carry no
    // per-sender field for a group message — only remoteJid (the group
    // itself). Falling back to that as "phone" was the original production
    // bug; the fix is to drop the message, not guess a group is a person.
    const body = receivedShape({ remoteJid: '123456-group@g.us', senderPn: undefined, cleanedSenderPn: undefined });
    expect(parseWebhookMessages(body)).toEqual([]);
  });

  it('returns [] for an unrecognized/empty body', () => {
    expect(parseWebhookMessages(null)).toEqual([]);
    expect(parseWebhookMessages({})).toEqual([]);
    expect(parseWebhookMessages({ data: {} })).toEqual([]);
    expect(parseWebhookMessages({ data: { messages: null } })).toEqual([]);
  });

  it('drops a message with no resolvable phone number', () => {
    const body = receivedShape({ remoteJid: undefined, senderPn: undefined, cleanedSenderPn: undefined });
    expect(parseWebhookMessages(body)).toEqual([]);
  });
});
