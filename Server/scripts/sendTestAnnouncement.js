/**
 * Manual WhatsApp announcement test.
 *
 * Usage:
 *   node scripts/sendTestAnnouncement.js 6200950087 newcafe
 *   node scripts/sendTestAnnouncement.js 6200950087 newcafe https://cdn.example.com/invite.jpg
 *
 * For IMAGE-header templates (newcafe):
 * - language must be `en`
 * - body params must be empty
 * - header image is required (public HTTPS link OR auto-upload of local store jpg)
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../src/.env') });

const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.replace(
  /^["']|["']$/g,
  '',
).trim();
const version = process.env.WHATSAPP_API_VERSION || 'v21.0';

const toDigits = String(process.argv[2] || '6200950087').replace(/\D/g, '');
const to = toDigits.length === 10 ? `91${toDigits}` : toDigits;
const templateName =
  process.argv[3] || process.env.WHATSAPP_ANNOUNCEMENT_TEMPLATE_NAME || 'newcafe';
const imageLinkArg =
  process.argv[4] || process.env.WHATSAPP_ANNOUNCEMENT_HEADER_IMAGE || '';

async function uploadLocalImage(filePath) {
  const buf = fs.readFileSync(filePath);
  const blob = new Blob([buf], { type: 'image/jpeg' });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'image/jpeg');
  form.append('file', blob, path.basename(filePath));

  const res = await fetch(
    `https://graph.facebook.com/${version}/${phoneNumberId}/media`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    },
  );
  const data = await res.json();
  if (!res.ok || !data?.id) {
    throw new Error(data?.error?.message || 'Media upload failed');
  }
  return data.id;
}

async function main() {
  if (!phoneNumberId || !accessToken) {
    throw new Error('Missing WhatsApp env credentials');
  }

  let headerParam;
  if (imageLinkArg) {
    headerParam = { type: 'image', image: { link: imageLinkArg } };
  } else {
    const candidates = [
      path.join(__dirname, '../../Client/src/assets/images/logo/newcafe.jpeg'),
    ];
    const filePath = candidates.find((p) => fs.existsSync(p));
    if (!filePath) {
      throw new Error(
        'Pass a public HTTPS image URL as 4th arg (required for IMAGE header)',
      );
    }
    console.log('Uploading local image:', filePath);
    const mediaId = await uploadLocalImage(filePath);
    headerParam = { type: 'image', image: { id: mediaId } };
  }

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'en' },
      components: [{ type: 'header', parameters: [headerParam] }],
    },
  };

  const res = await fetch(
    `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );
  const data = await res.json();
  console.log(JSON.stringify({ httpStatus: res.status, ok: res.ok, data }, null, 2));
  process.exit(res.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
