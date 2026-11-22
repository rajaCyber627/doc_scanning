// Emails: the message (headers + body) is the document's text; every real attachment
// becomes its own child document. Inline images referenced from the HTML body
// (signatures, logos) are not treated as attachments.
const { simpleParser } = require('mailparser');
const MsgReaderModule = require('@kenjiuno/msgreader');
const { UserFacingError } = require('../../../core/errors');

const MsgReader = MsgReaderModule.default || MsgReaderModule;

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// "Name <address>" without the quotes mailparser adds.
const addressList = (field) =>
  []
    .concat(field || [])
    .flatMap((f) => f.value || [])
    .map((v) => (v.name ? `${v.name} <${v.address}>` : v.address))
    .filter(Boolean)
    .join(', ');

function headerBlock(h) {
  return [
    h.subject && `Subject: ${h.subject}`,
    h.from && `From: ${h.from}`,
    h.to && `To: ${h.to}`,
    h.cc && `Cc: ${h.cc}`,
    h.date && `Date: ${h.date}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function parseEml(buffer) {
  let mail;
  try {
    mail = await simpleParser(buffer, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  } catch {
    throw new UserFacingError('DAMAGED_FILE', 'This email file could not be read.');
  }
  const body = (mail.text && mail.text.trim()) || htmlToText(mail.html);
  const children = [];
  const skipped = [];
  (mail.attachments || []).forEach((a, i) => {
    if (a.related || (a.contentDisposition === 'inline' && a.cid && /^image\//.test(a.contentType))) return; // inline image
    children.push({ fileName: a.filename || `attachment-${i + 1}`, buffer: a.content, contentType: a.contentType });
  });
  const headers = {
    subject: mail.subject,
    from: addressList(mail.from),
    to: addressList(mail.to),
    cc: addressList(mail.cc),
    date: mail.date ? mail.date.toISOString() : '',
    messageId: mail.messageId || '',
  };
  const auth = mail.headers && mail.headers.get('authentication-results');
  return { text: `${headerBlock(headers)}\n\n${body}`.trim(), children, skipped, email: headers, authResults: [].concat(auth || []).join(' ') };
}

async function parseMsg(buffer) {
  let reader;
  let data;
  try {
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    reader = new MsgReader(ab);
    data = reader.getFileData();
  } catch {
    throw new UserFacingError('DAMAGED_FILE', 'This Outlook message could not be read.');
  }
  if (!data || data.error) throw new UserFacingError('DAMAGED_FILE', 'This Outlook message could not be read.');
  // Outlook stores addresses in several properties (Exchange-style or SMTP); prefer SMTP.
  const recipients = (data.recipients || [])
    .map((r) => {
      const addr = r.smtpAddress || (r.email && r.email.includes('@') ? r.email : '');
      return addr ? `${r.name || ''} <${addr}>`.trim() : r.name;
    })
    .filter(Boolean);
  const senderAddr = data.senderSmtpAddress || (data.senderEmail && data.senderEmail.includes('@') ? data.senderEmail : '') || data.creatorSMTPAddress;
  const headers = {
    subject: data.subject,
    from: senderAddr ? `${data.senderName || ''} <${senderAddr}>`.trim() : data.senderName,
    to: recipients.join(', '),
    date: data.messageDeliveryTime || data.clientSubmitTime || '',
    messageId: data.internetMessageId || data.messageId || '',
  };
  const body = (data.body && String(data.body).trim()) || htmlToText(data.bodyHtml);
  const children = [];
  const skipped = [];
  for (const [i, att] of (data.attachments || []).entries()) {
    const name = att.fileName || att.fileNameShort || att.name || `attachment-${i + 1}`;
    if (att.attachmentHidden) continue; // inline image
    if (att.innerMsgContent) {
      skipped.push({ name: name || 'embedded message', reason: 'Embedded Outlook items are not imported; save them as files first' });
      continue;
    }
    try {
      const a = reader.getAttachment(att);
      if (a && a.content) children.push({ fileName: a.fileName || name, buffer: Buffer.from(a.content) });
    } catch {
      skipped.push({ name, reason: 'This attachment could not be read' });
    }
  }
  return { text: `${headerBlock(headers)}\n\n${body}`.trim(), children, skipped, email: headers };
}

module.exports = { parseEml, parseMsg, htmlToText };
