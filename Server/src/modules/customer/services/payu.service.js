import crypto from 'crypto';

export const getPayuConfig = () => {
  const key = String(process.env.PAYU_MERCHANT_KEY || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  const salt = String(process.env.PAYU_MERCHANT_SALT || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  const mode = String(process.env.PAYU_MODE || 'TEST').toUpperCase() === 'LIVE' ? 'LIVE' : 'TEST';

  if (!key || !salt) {
    const error = new Error(
      `PayU is not configured. Set PAYU_MERCHANT_KEY and PAYU_MERCHANT_SALT (Salt-32bit / Salt v1 from PayU Dashboard → ${mode === 'LIVE' ? 'Live' : 'Test'} Mode → API Keys).`,
    );
    error.status = 500;
    throw error;
  }

  // Classic PayU Salt v1 is typically ~16–64 alphanumerics, not an RSA private key blob.
  if (salt.length > 80 || salt.startsWith('MIIE') || salt.includes('PRIVATE KEY')) {
    const error = new Error(
      'PAYU_MERCHANT_SALT looks invalid. Use Salt-32bit (Salt v1) from PayU Dashboard — not an RSA private key.',
    );
    error.status = 500;
    throw error;
  }

  return {
    key,
    salt,
    mode,
    paymentUrl:
      mode === 'LIVE'
        ? 'https://secure.payu.in/_payment'
        : 'https://test.payu.in/_payment',
    verifyUrl:
      mode === 'LIVE'
        ? 'https://info.payu.in/merchant/postservice.php?form=2'
        : 'https://test.payu.in/merchant/postservice.php?form=2',
  };
};

export const formatPayuAmount = amount => {
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return '0.00';
  return n.toFixed(2);
};

/**
 * Request hash:
 * sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)
 */
export const generatePaymentHash = ({
  key,
  salt,
  txnid,
  amount,
  productinfo,
  firstname,
  email,
  udf1 = '',
  udf2 = '',
  udf3 = '',
  udf4 = '',
  udf5 = '',
}) => {
  const hashString = [
    key,
    txnid,
    amount,
    productinfo,
    firstname,
    email,
    udf1,
    udf2,
    udf3,
    udf4,
    udf5,
    '',
    '',
    '',
    '',
    '',
    salt,
  ].join('|');

  return crypto.createHash('sha512').update(hashString).digest('hex');
};

/**
 * Reverse hash from PayU response:
 * sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
 */
export const generateReverseHash = ({
  salt,
  key,
  status,
  txnid,
  amount,
  productinfo,
  firstname,
  email,
  udf1 = '',
  udf2 = '',
  udf3 = '',
  udf4 = '',
  udf5 = '',
}) => {
  const hashString = [
    salt,
    status,
    '',
    '',
    '',
    '',
    '',
    udf5,
    udf4,
    udf3,
    udf2,
    udf1,
    email,
    firstname,
    productinfo,
    amount,
    txnid,
    key,
  ].join('|');

  return crypto.createHash('sha512').update(hashString).digest('hex');
};

export const verifyReverseHash = (body, salt, key) => {
  const received = String(body.hash || '').toLowerCase();
  if (!received) return false;
  const expected = generateReverseHash({
    salt,
    key,
    status: body.status || '',
    txnid: body.txnid || '',
    amount: body.amount || '',
    productinfo: body.productinfo || '',
    firstname: body.firstname || '',
    email: body.email || '',
    udf1: body.udf1 || '',
    udf2: body.udf2 || '',
    udf3: body.udf3 || '',
    udf4: body.udf4 || '',
    udf5: body.udf5 || '',
  }).toLowerCase();
  return received === expected;
};

export const generateVerifyApiHash = ({key, salt, command, var1}) => {
  const hashString = `${key}|${command}|${var1}|${salt}`;
  return crypto.createHash('sha512').update(hashString).digest('hex');
};

/**
 * Optional reconciliation with PayU verify_payment API.
 */
export const verifyPaymentWithPayu = async txnid => {
  const {key, salt, verifyUrl} = getPayuConfig();
  const command = 'verify_payment';
  const hash = generateVerifyApiHash({key, salt, command, var1: txnid});

  const body = new URLSearchParams({
    key,
    command,
    var1: txnid,
    hash,
  });

  const response = await fetch(verifyUrl, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body,
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return {status: 0, msg: text, raw: text};
  }
};

export const createTxnId = () => {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  // PayU txnid max length ~25
  return (`WW${stamp}${rand}`).slice(0, 25);
};
