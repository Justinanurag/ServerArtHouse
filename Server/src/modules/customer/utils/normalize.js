export const isEmail = value =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? '').trim());

/** Accepts 10-digit Indian mobile; returns digits only or null */
export const normalizeMobile = input => {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 10 && /^[6-9]/.test(digits)) return digits;
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits.slice(2))) {
    return digits.slice(2);
  }
  if (digits.length === 13 && digits.startsWith('091')) {
    return digits.slice(3);
  }
  return null;
};

export const toE164 = (mobile, countryCode = '+91') => {
  const normalized = normalizeMobile(mobile);
  if (!normalized) return null;
  const code = String(countryCode || '+91').startsWith('+')
    ? String(countryCode)
    : `+${countryCode}`;
  return `${code}${normalized}`;
};

export const parseIdentifier = raw => {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (isEmail(value)) {
    return {type: 'email', value: value.toLowerCase()};
  }
  const mobile = normalizeMobile(value);
  if (mobile) {
    return {type: 'mobile', value: mobile};
  }
  return null;
};

export const formatMobileDisplay = mobile => {
  const digits = normalizeMobile(mobile) || String(mobile ?? '').replace(/\D/g, '');
  if (digits.length !== 10) return String(mobile ?? '');
  return `${digits.slice(0, 5)} ${digits.slice(5)}`;
};
