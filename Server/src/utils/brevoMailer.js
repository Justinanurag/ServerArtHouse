import nodemailer from 'nodemailer';

const formatCurrency = value =>
  Number(value || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const formatDate = value => {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-IN');
};

const buildSubscriptionEmailHtml = ({customerName, subscriptionCode, subscription}) => {
  const items = Array.isArray(subscription?.items) ? subscription.items : [];
  const rows = items
    .map(
      item => `
        <tr>
          <td style="padding:8px;border:1px solid #e2e8f0;">${String(item?.productName ?? '')}</td>
          <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;">${Number(item?.qty ?? 0)}</td>
          <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;">Rs ${formatCurrency(item?.unitPrice)}</td>
          <td style="padding:8px;border:1px solid #e2e8f0;text-align:right;">Rs ${formatCurrency(item?.lineTotal)}</td>
        </tr>`,
    )
    .join('');

  return `
    <div style="font-family:Arial,sans-serif;color:#1f2937;line-height:1.5;">
      <h2 style="margin:0 0 12px;">Subscription Created Successfully</h2>
      <p style="margin:0 0 12px;">Hello ${customerName || 'Customer'},</p>
      <p style="margin:0 0 16px;">Your subscription has been created in our system.</p>
      <div style="padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:16px;">
        <p style="margin:0 0 6px;"><strong>Subscription No:</strong> ${subscriptionCode}</p>
        <p style="margin:0 0 6px;"><strong>Start Date:</strong> ${formatDate(subscription?.startDate)}</p>
        <p style="margin:0;"><strong>End Date:</strong> ${formatDate(subscription?.endDate)}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <thead>
          <tr>
            <th style="padding:8px;border:1px solid #e2e8f0;text-align:left;background:#f8fafc;">Item</th>
            <th style="padding:8px;border:1px solid #e2e8f0;text-align:right;background:#f8fafc;">Qty</th>
            <th style="padding:8px;border:1px solid #e2e8f0;text-align:right;background:#f8fafc;">Rate</th>
            <th style="padding:8px;border:1px solid #e2e8f0;text-align:right;background:#f8fafc;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="4" style="padding:8px;border:1px solid #e2e8f0;">No items</td></tr>'}
        </tbody>
      </table>
      <p style="margin:0 0 4px;"><strong>Grand Total:</strong> Rs ${formatCurrency(subscription?.grandTotal)}</p>
      <p style="margin:0;">Thank you for choosing us.</p>
    </div>
  `;
};

export const sendSubscriptionCreatedEmail = async ({
  toEmail,
  customerName,
  subscriptionCode,
  subscription,
}) => {
  const senderEmail = String(
    process.env.SENDER_EMAIL ?? process.env.BREVO_SENDER_EMAIL ?? '',
  ).trim();
  const senderName = String(
    process.env.SENDER_NAME ?? process.env.BREVO_SENDER_NAME ?? 'WOOERP',
  ).trim();
  const smtpHost = String(process.env.SMTP_HOST ?? 'smtp-relay.brevo.com').trim();
  const smtpPort = Number(process.env.SMTP_PORT ?? 587);
  const smtpUser = String(process.env.SMTP_USER ?? '').trim();
  const smtpPass = String(process.env.SMTP_PASS ?? '').trim();

  if (!smtpHost || !smtpPort || !smtpUser || !smtpPass || !senderEmail || !toEmail) {
    return {
      sent: false,
      skipped: true,
      reason: 'Missing SMTP credentials, sender email, or receiver email.',
    };
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });

  await transporter.sendMail({
    from: `"${senderName}" <${senderEmail}>`,
    to: toEmail,
    subject: `Subscription Created - ${subscriptionCode}`,
    html: buildSubscriptionEmailHtml({
      customerName,
      subscriptionCode,
      subscription,
    }),
  });

  return {sent: true};
};
