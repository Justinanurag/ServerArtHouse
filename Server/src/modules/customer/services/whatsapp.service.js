import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {toE164} from '../utils/normalize.js';

const __whatsappServiceDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__whatsappServiceDir, '../../../../../');

const GRAPH_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';

const getConfig = () => {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.replace(/^["']|["']$/g, '').trim();
  const templateName = (
    process.env.WHATSAPP_TEMPLATE_NAME ||
    process.env.WHATSAPP_OTP_TEMPLATE ||
    'woowoootp'
  ).trim();
  const language = (
    process.env.WHATSAPP_TEMPLATE_LANGUAGE ||
    process.env.WHATSAPP_TEMPLATE_LANG ||
    'en'
  ).trim();

  return {phoneNumberId, accessToken, templateName, language};
};

const getMembershipTemplateConfig = () => {
  const {phoneNumberId, accessToken, language} = getConfig();
  // Customer portal uses `membershippurchase` (approved). `newmembership` is optional alias only if approved in Meta.
  const templateName = (
    process.env.WHATSAPP_MEMBERSHIP_TEMPLATE ||
    process.env.WHATSAPP_NEW_MEMBERSHIP_TEMPLATE ||
    'membershippurchase'
  ).trim();
  const membershipLanguage = (
    process.env.WHATSAPP_MEMBERSHIP_TEMPLATE_LANGUAGE ||
    language ||
    'en_US'
  ).trim();
  const urlButtonParam = (
    process.env.WHATSAPP_MEMBERSHIP_VIEW_URL_PARAM ||
    process.env.WHATSAPP_NEW_MEMBERSHIP_PROSITE_URL_PARAM ||
    ''
  ).trim();
  const appUrlParam = (
    process.env.WHATSAPP_MEMBERSHIP_APP_URL_PARAM ||
    process.env.WHATSAPP_NEW_MEMBERSHIP_APP_URL_PARAM ||
    ''
  ).trim();

  return {
    phoneNumberId,
    accessToken,
    templateName,
    language: membershipLanguage,
    urlButtonParam,
    appUrlParam,
  };
};

/** Meta template `membershipchange` — sent after a successful membership upgrade. */
const getMembershipChangeTemplateConfig = () => {
  const {phoneNumberId, accessToken, language} = getConfig();
  const templateName = (
    process.env.WHATSAPP_MEMBERSHIP_CHANGE_TEMPLATE ||
    'membershipchange'
  ).trim();
  const changeLanguage = (
    process.env.WHATSAPP_MEMBERSHIP_CHANGE_TEMPLATE_LANGUAGE ||
    process.env.WHATSAPP_MEMBERSHIP_TEMPLATE_LANGUAGE ||
    language ||
    'en_US'
  ).trim();
  const urlButtonParam = (
    process.env.WHATSAPP_MEMBERSHIP_CHANGE_URL_PARAM ||
    process.env.WHATSAPP_MEMBERSHIP_VIEW_URL_PARAM ||
    ''
  ).trim();
  const companyName = (
    process.env.WHATSAPP_COMPANY_NAME ||
    process.env.COMPANY_NAME ||
    'WOOWOO Art House'
  ).trim();

  return {
    phoneNumberId,
    accessToken,
    templateName,
    language: changeLanguage,
    urlButtonParam,
    companyName,
  };
};

const getAccountCreatedTemplateConfig = () => {
  const {phoneNumberId, accessToken, language} = getConfig();
  // Customer portal uses `accountcreated` (approved). `newaccount` is optional alias only if approved in Meta.
  const templateName = (
    process.env.WHATSAPP_ACCOUNT_CREATED_TEMPLATE ||
    process.env.WHATSAPP_NEW_ACCOUNT_TEMPLATE ||
    'accountcreated'
  ).trim();
  const accountLanguage = (
    process.env.WHATSAPP_ACCOUNT_CREATED_TEMPLATE_LANGUAGE ||
    language ||
    'en_US'
  ).trim();
  const balanceUrlParam = (
    process.env.WHATSAPP_ACCOUNT_CREATED_BALANCE_URL_PARAM ||
    process.env.WHATSAPP_NEW_ACCOUNT_PROFILE_URL_PARAM ||
    ''
  ).trim();
  const prositeUrlParam = (
    process.env.WHATSAPP_ACCOUNT_CREATED_PROSITE_URL_PARAM ||
    process.env.WHATSAPP_NEW_ACCOUNT_APP_URL_PARAM ||
    ''
  ).trim();

  return {
    phoneNumberId,
    accessToken,
    templateName,
    language: accountLanguage,
    balanceUrlParam,
    prositeUrlParam,
  };
};

const getActivityUpdateTemplateConfig = () => {
  const {phoneNumberId, accessToken, language} = getConfig();
  const templateName = (
    process.env.WHATSAPP_ACTIVITY_UPDATE_TEMPLATE ||
    'activityupdate'
  ).trim();
  const activityLanguage = (
    process.env.WHATSAPP_ACTIVITY_UPDATE_TEMPLATE_LANGUAGE ||
    language
  ).trim();
  const detailsUrlParam = (
    process.env.WHATSAPP_ACTIVITY_DETAILS_URL_PARAM ||
    ''
  ).trim();
  const walletUrlParam = (
    process.env.WHATSAPP_ACTIVITY_WALLET_URL_PARAM ||
    ''
  ).trim();

  return {
    phoneNumberId,
    accessToken,
    templateName,
    language: activityLanguage,
    detailsUrlParam,
    walletUrlParam,
  };
};

/** Meta template `cspsaleupdate` — sent to the CSP owner when their product sells. */
const getCspSaleUpdateTemplateConfig = () => {
  const {phoneNumberId, accessToken, language} = getConfig();
  const templateName = (
    process.env.WHATSAPP_CSP_SALE_TEMPLATE ||
    'cspsaleupdate'
  ).trim();
  const cspLanguage = (
    process.env.WHATSAPP_CSP_SALE_TEMPLATE_LANGUAGE ||
    language ||
    'en_US'
  ).trim();
  const urlButtonParam = (process.env.WHATSAPP_CSP_SALE_URL_PARAM || '').trim();
  const paramOrder = String(process.env.WHATSAPP_CSP_SALE_PARAM_ORDER || '')
    .split(',')
    .map(key => key.trim())
    .filter(Boolean);
  const paramCount = Number.parseInt(
    String(process.env.WHATSAPP_CSP_SALE_PARAM_COUNT || ''),
    10,
  );

  return {
    phoneNumberId,
    accessToken,
    templateName,
    language: cspLanguage,
    urlButtonParam,
    paramOrder,
    paramCount: Number.isInteger(paramCount) && paramCount >= 0 ? paramCount : null,
  };
};

const toWhatsAppRecipient = mobile => {
  const e164 = toE164(mobile);
  if (!e164) return null;
  return e164.replace(/\D/g, '');
};

const buildAuthTemplatePayload = ({to, otp, templateName, language, includeButton}) => {
  const components = [
    {
      type: 'body',
      parameters: [{type: 'text', text: String(otp)}],
    },
  ];

  if (includeButton) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{type: 'text', text: String(otp)}],
    });
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: {code: language},
      components,
    },
  };
};

const buildMembershipTemplatePayload = ({
  to,
  templateName,
  language,
  name,
  membershipLabel,
  validity,
  cashbackLabel,
  urlButtonParam,
  appUrlParam,
}) => {
  const components = [
    {
      type: 'body',
      parameters: [
        {type: 'text', text: String(name || 'Member')},
        {type: 'text', text: String(membershipLabel)},
        {type: 'text', text: String(validity)},
        {type: 'text', text: String(cashbackLabel)},
      ],
    },
  ];

  // newmembership buttons: Setup Prosite (0), Open App (1)
  if (urlButtonParam) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{type: 'text', text: String(urlButtonParam)}],
    });
  }
  if (appUrlParam) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '1',
      parameters: [{type: 'text', text: String(appUrlParam)}],
    });
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: {code: language},
      components,
    },
  };
};

const postTemplateMessage = async ({phoneNumberId, accessToken, payload}) => {
  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );

  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }

  return {ok: response.ok, status: response.status, raw, json};
};

const languageCandidates = primary => {
  // Prefer configured locale, then the ones used by Customer portal OTP (`en_US`) and plain `en`.
  const list = [primary, 'en_US', 'en'];
  return [...new Set(list.filter(Boolean))];
};

/** Try configured template first, then Customer-portal / legacy aliases on Meta 132001. */
const templateNameCandidates = (primary, aliases = []) => {
  return [...new Set([primary, ...aliases].map(n => String(n || '').trim()).filter(Boolean))];
};

const isMissingTemplateError = error => {
  const code = Number(error?.code);
  const message = String(error?.message || '');
  const details = String(error?.error_data?.details || '');
  return (
    code === 132001 ||
    /template name.*does not exist|does not exist in the translation|not found/i.test(
      `${message} ${details}`,
    )
  );
};

/**
 * Send OTP via WhatsApp Meta Cloud API using an approved template.
 */
export const sendWhatsAppOtp = async ({to, otp}) => {
  const {phoneNumberId, accessToken, templateName, language} = getConfig();

  if (!phoneNumberId || !accessToken) {
    console.log(`[Customer OTP][WhatsApp stub] to=${to} otp=${otp}`);
    return {channel: 'whatsapp-stub', delivered: false};
  }

  const recipient = toWhatsAppRecipient(to);
  if (!recipient) {
    const error = new Error('Invalid mobile number for WhatsApp OTP');
    error.status = 400;
    throw error;
  }

  let lastError = null;

  for (const lang of languageCandidates(language)) {
    for (const includeButton of [true, false]) {
      const payload = buildAuthTemplatePayload({
        to: recipient,
        otp,
        templateName,
        language: lang,
        includeButton,
      });

      const result = await postTemplateMessage({
        phoneNumberId,
        accessToken,
        payload,
      });

      if (result.ok) {
        const messageId = result.json?.messages?.[0]?.id || null;
        console.log(
          `[Customer OTP][WhatsApp] delivered to=${recipient} template=${templateName} lang=${lang} button=${includeButton} id=${messageId} opt is ${otp}`,
        );
        return {
          channel: 'whatsapp',
          delivered: true,
          messageId,
          templateName,
          language: lang,
        };
      }

      lastError = result.json?.error || {message: result.raw, status: result.status};
      const message = String(lastError.message || '');

      if (lastError.code === 190 || /oauth|access token|authenticat/i.test(message)) {
        break;
      }

      if (/language|template name|does not exist|not found/i.test(message)) {
        break;
      }

      if (includeButton && /button|component|parameter/i.test(message)) {
        continue;
      }

      break;
    }

    if (
      lastError?.code === 190 ||
      /oauth|access token|authenticat/i.test(String(lastError?.message || ''))
    ) {
      break;
    }
  }

  const metaMessage =
    lastError?.error_user_msg ||
    lastError?.message ||
    'Unknown WhatsApp API error';

  console.error('[Customer OTP][WhatsApp] failed:', lastError);

  let friendly = `Failed to send WhatsApp OTP: ${metaMessage}`;
  if (lastError?.code === 190) {
    friendly =
      'WhatsApp access token is invalid or expired. Generate a new permanent System User token in Meta Business Settings and update WHATSAPP_ACCESS_TOKEN.';
  } else if (
    lastError?.code === 100 ||
    /Object with ID|does not exist|missing permissions|does not support this operation/i.test(
      metaMessage,
    )
  ) {
    friendly =
      `Failed to send WhatsApp OTP: Meta cannot access phone number ID "${phoneNumberId}". ` +
      'Use Phone Number ID (not WABA ID) from Meta App Dashboard → WhatsApp → API Setup, ' +
      'ensure WHATSAPP_ACCESS_TOKEN has whatsapp_business_messaging + whatsapp_business_management, ' +
      'and assign the System User to that WhatsApp Business Account with full control.';
  }

  const error = new Error(friendly);
  error.status = 502;
  error.meta = lastError;
  throw error;
};

/** Plain amount for Meta templates that already include ₹ in the body text. */
const formatAmountPlain = value => {
  const n = Number(
    typeof value === 'string' ? String(value).replace(/[^\d.]/g, '') : value,
  );
  if (!Number.isFinite(n) || n < 0) return '0';
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(2);
};

/**
 * Meta membership/account templates already print ₹ before {{n}}.
 * Passing "₹200" produces "₹₹200". Always send digits unless env overrides.
 */
const resolveCashbackTemplateParam = (cashbackLabel, {fallbackEnvKeys = []} = {}) => {
  const includeSymbol = /^(1|true|yes)$/i.test(
    String(process.env.WHATSAPP_CASHBACK_INCLUDE_SYMBOL || '').trim(),
  );
  let amount = Number(String(cashbackLabel ?? '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) {
    for (const key of fallbackEnvKeys) {
      const envVal = Number(process.env[key] || 0);
      if (Number.isFinite(envVal) && envVal > 0) {
        amount = envVal;
        break;
      }
    }
  }
  const plain = formatAmountPlain(Number.isFinite(amount) && amount > 0 ? amount : 0);
  return includeSymbol ? `₹${plain}` : plain;
};

/**
 * Send membership activation WhatsApp.
 * Customer portal template: `membershippurchase` (fallback: membershipchange, newmembership).
 * Body: {{1}} name, {{2}} plan, {{3}} validity, {{4}} cashback — Meta text already has ₹.
 * Buttons: optional URL params (static URLs need none).
 */
export const sendMembershipPurchaseWhatsApp = async ({
  to,
  name,
  membershipLabel,
  validity,
  cashbackLabel,
}) => {
  const {
    phoneNumberId,
    accessToken,
    templateName,
    language,
    urlButtonParam,
    appUrlParam,
  } = getMembershipTemplateConfig();

  if (!phoneNumberId || !accessToken) {
    console.log(
      `[Membership][WhatsApp stub] to=${to} name=${name} plan=${membershipLabel} validity=${validity} cashback=${cashbackLabel}`,
    );
    return {channel: 'whatsapp-stub', delivered: false};
  }

  const recipient = toWhatsAppRecipient(to);
  if (!recipient) {
    const error = new Error('Invalid mobile number for WhatsApp membership message');
    error.status = 400;
    throw error;
  }

  let lastError = null;
  // Meta template text already has ₹ before the cashback placeholder (₹{{4}}).
  // Prefer plain digits so users never see "₹₹200" / "₹₹0".
  const cashbackParam = resolveCashbackTemplateParam(cashbackLabel, {
    fallbackEnvKeys: [
      'WHATSAPP_MEMBERSHIP_CASHBACK',
      'MEMBERSHIP_WELCOME_CASHBACK',
    ],
  });
  const plainAmount = formatAmountPlain(cashbackParam);
  const bodyModes = [
    [
      String(name || 'Member'),
      String(membershipLabel || 'Membership'),
      String(validity || 'Yearly'),
      cashbackParam,
    ],
    [
      String(name || 'Member'),
      String(membershipLabel || 'Membership'),
      String(validity || 'Yearly'),
      plainAmount,
    ],
    [
      String(name || 'Member'),
      String(membershipLabel || 'Membership'),
      String(validity || 'Yearly'),
      `${plainAmount} coins`,
    ],
  ];

  const buttonModes = [
    {urlButtonParam: '', appUrlParam: ''},
    {
      urlButtonParam: urlButtonParam || 'prosite',
      appUrlParam: appUrlParam || 'app',
    },
    {urlButtonParam: urlButtonParam || 'prosite', appUrlParam: ''},
  ];

  const templateNames = templateNameCandidates(templateName, [
    'membershippurchase',
    'newmembership',
  ]);

  for (const activeTemplate of templateNames) {
    for (const lang of languageCandidates(language)) {
      for (const bodyParams of bodyModes) {
        for (const mode of buttonModes) {
          const payload = buildMembershipTemplatePayload({
            to: recipient,
            templateName: activeTemplate,
            language: lang,
            name: bodyParams[0],
            membershipLabel: bodyParams[1],
            validity: bodyParams[2],
            cashbackLabel: bodyParams[3],
            urlButtonParam: mode.urlButtonParam || null,
            appUrlParam: mode.appUrlParam || null,
          });

          const result = await postTemplateMessage({
            phoneNumberId,
            accessToken,
            payload,
          });

          if (result.ok) {
            const messageId = result.json?.messages?.[0]?.id || null;
            console.log(
              `[Membership][WhatsApp] delivered to=${recipient} template=${activeTemplate} lang=${lang} body=${JSON.stringify(bodyParams)} id=${messageId}`,
            );
            return {
              channel: 'whatsapp',
              delivered: true,
              messageId,
              templateName: activeTemplate,
              language: lang,
            };
          }

          lastError = result.json?.error || {message: result.raw, status: result.status};
          const message = String(lastError.message || '');

          if (lastError.code === 190 || /oauth|access token|authenticat/i.test(message)) {
            break;
          }

          // Wrong name/locale → try next language, then next template alias
          if (isMissingTemplateError(lastError)) {
            break;
          }

          if (/button|component|parameter|expected|number of params/i.test(message)) {
            continue;
          }

          break;
        }

        if (
          lastError?.code === 190 ||
          isMissingTemplateError(lastError) ||
          /oauth|access token|authenticat/i.test(String(lastError?.message || ''))
        ) {
          break;
        }
      }

      if (
        lastError?.code === 190 ||
        /oauth|access token|authenticat/i.test(String(lastError?.message || ''))
      ) {
        break;
      }

      // 132001 for this language → try next language / template
      if (isMissingTemplateError(lastError)) {
        continue;
      }
    }

    if (
      lastError?.code === 190 ||
      /oauth|access token|authenticat/i.test(String(lastError?.message || ''))
    ) {
      break;
    }
  }

  const metaMessage =
    lastError?.error_user_msg ||
    lastError?.message ||
    'Unknown WhatsApp API error';

  console.error('[Membership][WhatsApp] failed:', lastError);

  return {
    channel: 'whatsapp',
    delivered: false,
    error: metaMessage,
    meta: lastError,
  };
};

/** Alias used by Admin Create Subscription activation. */
export const sendNewMembershipWhatsApp = sendMembershipPurchaseWhatsApp;

/**
 * Build Meta Cloud API payload for `membershipchange`.
 * Reference body (positional):
 *  {{1}} customerName
 *  {{2}} membershipName
 *  {{3}} validity (e.g. School Life / Yearly)
 *  {{4}} cashbackAmount — digits only when Meta text already has ₹
 * Optional URL button index 0 = Visit Membership.
 */
const buildMembershipChangeTemplatePayload = ({
  to,
  templateName,
  language,
  bodyParams,
  urlButtonParam,
}) => {
  const components = [
    {
      type: 'body',
      parameters: bodyParams.map(text => ({
        type: 'text',
        text: String(text ?? ''),
      })),
    },
  ];

  if (urlButtonParam) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{type: 'text', text: String(urlButtonParam)}],
    });
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: {code: language},
      components,
    },
  };
};

/**
 * Send Meta template `membershipchange` after a successful membership upgrade.
 * Dynamic fields: customerName, membershipName, cashbackAmount, companyName (+ validity).
 * CTA: Visit Membership (URL button).
 */
export const sendMembershipChangeWhatsApp = async ({
  to,
  customerName,
  membershipName,
  cashbackAmount,
  companyName,
  validity,
  visitUrlParam,
}) => {
  const {
    phoneNumberId,
    accessToken,
    templateName,
    language,
    urlButtonParam,
    companyName: defaultCompany,
  } = getMembershipChangeTemplateConfig();

  const name = String(customerName || 'Member').trim() || 'Member';
  const plan = String(membershipName || 'Membership').trim() || 'Membership';
  const validityLabel = String(validity || 'Yearly').trim() || 'Yearly';
  const company =
    String(companyName || defaultCompany || 'WOOWOO Art House').trim() ||
    'WOOWOO Art House';
  const cashbackParam = resolveCashbackTemplateParam(cashbackAmount, {
    fallbackEnvKeys: [
      'WHATSAPP_MEMBERSHIP_CASHBACK',
      'MEMBERSHIP_WELCOME_CASHBACK',
    ],
  });
  const plainCashback = formatAmountPlain(cashbackParam);
  const buttonParam = String(visitUrlParam || urlButtonParam || '').trim();

  if (!phoneNumberId || !accessToken) {
    console.log('[MembershipChange][WhatsApp stub]', {
      to,
      name,
      plan,
      validityLabel,
      cashbackParam,
      company,
      buttonParam,
    });
    return {
      channel: 'whatsapp-stub',
      delivered: false,
      stub: true,
      bodyParams: [name, plan, validityLabel, cashbackParam],
    };
  }

  const recipient = toWhatsAppRecipient(to);
  if (!recipient) {
    const error = new Error('Invalid mobile / WhatsApp number');
    error.status = 400;
    throw error;
  }

  // Prefer image/reference shape: name, plan, validity, cashback.
  // Also try variants that include companyName if Meta template expects it.
  const bodyModes = [
    [name, plan, validityLabel, cashbackParam],
    [name, plan, validityLabel, plainCashback],
    [name, plan, cashbackParam, company],
    [name, plan, plainCashback, company],
    [name, plan, validityLabel, cashbackParam, company],
    [name, plan, validityLabel, plainCashback, company],
  ];

  const buttonModes = buttonParam ? [buttonParam, ''] : ['', 'membership'];
  const templateNames = templateNameCandidates(templateName, [
    'membershipchange',
  ]);

  let lastError = null;
  for (const activeTemplate of templateNames) {
    for (const lang of languageCandidates(language)) {
      for (const bodyParams of bodyModes) {
        for (const btn of buttonModes) {
          const payload = buildMembershipChangeTemplatePayload({
            to: recipient,
            templateName: activeTemplate,
            language: lang,
            bodyParams,
            urlButtonParam: btn || null,
          });

          const result = await postTemplateMessage({
            phoneNumberId,
            accessToken,
            payload,
          });

          if (result.ok) {
            const messageId = result.json?.messages?.[0]?.id || null;
            console.log(
              `[MembershipChange][WhatsApp] delivered to=${recipient} template=${activeTemplate} lang=${lang} id=${messageId}`,
            );
            return {
              channel: 'whatsapp',
              delivered: true,
              messageId,
              templateName: activeTemplate,
              language: lang,
              bodyParams,
            };
          }

          lastError =
            result.json?.error || {message: result.raw, status: result.status};
          const message = String(lastError.message || '');

          if (
            lastError.code === 190 ||
            /oauth|access token|authenticat/i.test(message)
          ) {
            break;
          }
          if (isMissingTemplateError(lastError)) {
            break;
          }
          if (/button|component|parameter|expected|number of params/i.test(message)) {
            continue;
          }
          break;
        }

        if (
          lastError?.code === 190 ||
          isMissingTemplateError(lastError) ||
          /oauth|access token|authenticat/i.test(String(lastError?.message || ''))
        ) {
          break;
        }
      }

      if (
        lastError?.code === 190 ||
        /oauth|access token|authenticat/i.test(String(lastError?.message || ''))
      ) {
        break;
      }
      if (isMissingTemplateError(lastError)) {
        continue;
      }
    }

    if (
      lastError?.code === 190 ||
      /oauth|access token|authenticat/i.test(String(lastError?.message || ''))
    ) {
      break;
    }
  }

  const metaMessage =
    lastError?.error_user_msg ||
    lastError?.message ||
    'Unknown WhatsApp API error';
  console.error('[MembershipChange][WhatsApp] failed:', lastError);

  return {
    channel: 'whatsapp',
    delivered: false,
    error: metaMessage,
    meta: lastError,
  };
};

const buildAccountCreatedTemplatePayload = ({
  to,
  templateName,
  language,
  name,
  cashbackLabel,
  balanceUrlParam,
  prositeUrlParam,
}) => {
  const components = [
    {
      type: 'body',
      parameters: [
        {type: 'text', text: String(name || 'Member')},
        {type: 'text', text: String(cashbackLabel)},
      ],
    },
  ];

  // Check Balance / View Prosite URL buttons — only if template has dynamic URL suffixes
  if (balanceUrlParam) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{type: 'text', text: String(balanceUrlParam)}],
    });
  }
  if (prositeUrlParam) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '1',
      parameters: [{type: 'text', text: String(prositeUrlParam)}],
    });
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: {code: language},
      components,
    },
  };
};

/**
 * Send account-created WhatsApp.
 * Customer portal template: `accountcreated` (fallback: newaccount).
 * Body: {{1}} name, {{2}} welcome cashback (e.g. ₹25 / ₹21)
 * Buttons: optional URL params (static URLs need none).
 */
export const sendAccountCreatedWhatsApp = async ({to, name, cashbackLabel}) => {
  const {
    phoneNumberId,
    accessToken,
    templateName,
    language,
    balanceUrlParam,
    prositeUrlParam,
  } = getAccountCreatedTemplateConfig();

  if (!phoneNumberId || !accessToken) {
    console.log(
      `[AccountCreated][WhatsApp stub] to=${to} name=${name} cashback=${cashbackLabel}`,
    );
    return {channel: 'whatsapp-stub', delivered: false};
  }

  const recipient = toWhatsAppRecipient(to);
  if (!recipient) {
    const error = new Error('Invalid mobile number for WhatsApp account message');
    error.status = 400;
    throw error;
  }

  let lastError = null;

  // Meta `accountcreated` body already includes ₹ before the cashback placeholder.
  const cashbackParam = resolveCashbackTemplateParam(cashbackLabel, {
    fallbackEnvKeys: [
      'WHATSAPP_ACCOUNT_CREATED_CASHBACK',
      'ACCOUNT_WELCOME_CASHBACK',
      'WHATSAPP_WELCOME_CASHBACK',
    ],
  });
  const plainAmount = formatAmountPlain(cashbackParam);

  const bodyModes = [
    [String(name || 'Member'), cashbackParam],
    [String(name || 'Member'), plainAmount],
    [String(name || 'Member'), `${plainAmount} coins`],
    [String(name || 'Member')],
  ];

  const buttonModes = [
    {balanceUrlParam: '', prositeUrlParam: ''},
    {
      balanceUrlParam: balanceUrlParam || 'balance',
      prositeUrlParam: prositeUrlParam || 'prosite',
    },
    {balanceUrlParam: balanceUrlParam || 'balance', prositeUrlParam: ''},
  ];

  const templateNames = templateNameCandidates(templateName, [
    'accountcreated',
    'newaccount',
  ]);

  for (const activeTemplate of templateNames) {
    for (const lang of languageCandidates(language)) {
      for (const bodyParams of bodyModes) {
        for (const mode of buttonModes) {
          const components = [
            {
              type: 'body',
              parameters: bodyParams.map(text => ({type: 'text', text})),
            },
          ];

          if (mode.balanceUrlParam) {
            components.push({
              type: 'button',
              sub_type: 'url',
              index: '0',
              parameters: [{type: 'text', text: String(mode.balanceUrlParam)}],
            });
          }
          if (mode.prositeUrlParam) {
            components.push({
              type: 'button',
              sub_type: 'url',
              index: '1',
              parameters: [{type: 'text', text: String(mode.prositeUrlParam)}],
            });
          }

          const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: recipient,
            type: 'template',
            template: {
              name: activeTemplate,
              language: {code: lang},
              components,
            },
          };

          const result = await postTemplateMessage({
            phoneNumberId,
            accessToken,
            payload,
          });

          if (result.ok) {
            const messageId = result.json?.messages?.[0]?.id || null;
            console.log(
              `[AccountCreated][WhatsApp] delivered to=${recipient} template=${activeTemplate} lang=${lang} body=${JSON.stringify(bodyParams)} id=${messageId}`,
            );
            return {
              channel: 'whatsapp',
              delivered: true,
              messageId,
              templateName: activeTemplate,
              language: lang,
            };
          }

          lastError = result.json?.error || {message: result.raw, status: result.status};
          const message = String(lastError.message || '');

          if (lastError.code === 190 || /oauth|access token|authenticat/i.test(message)) {
            break;
          }

          if (isMissingTemplateError(lastError)) {
            break;
          }

          if (/button|component|parameter|expected|number of params/i.test(message)) {
            continue;
          }

          break;
        }

        if (
          lastError?.code === 190 ||
          isMissingTemplateError(lastError) ||
          /oauth|access token|authenticat/i.test(String(lastError?.message || ''))
        ) {
          break;
        }
      }

      if (
        lastError?.code === 190 ||
        /oauth|access token|authenticat/i.test(String(lastError?.message || ''))
      ) {
        break;
      }

      if (isMissingTemplateError(lastError)) {
        continue;
      }
    }

    if (
      lastError?.code === 190 ||
      /oauth|access token|authenticat/i.test(String(lastError?.message || ''))
    ) {
      break;
    }
  }

  const metaMessage =
    lastError?.error_user_msg ||
    lastError?.message ||
    'Unknown WhatsApp API error';

  console.error('[AccountCreated][WhatsApp] failed:', lastError);

  return {
    channel: 'whatsapp',
    delivered: false,
    error: metaMessage,
    meta: lastError,
  };
};

/** Alias used by Admin Add Customer. */
export const sendNewAccountWhatsApp = sendAccountCreatedWhatsApp;

/**
 * Live Meta body is: "As a {{6}} Member, you received:"
 * so send tier only ("Premium") → "As a Premium Member".
 * Set WHATSAPP_ACTIVITY_MEMBERSHIP_FULL_LABEL=1 only if Meta text has no trailing "Member".
 */
const formatActivityMembershipParam = label => {
  const raw = String(label || 'Guest').trim() || 'Guest';
  if (/^(1|true|yes)$/i.test(String(process.env.WHATSAPP_ACTIVITY_MEMBERSHIP_FULL_LABEL || '').trim())) {
    return raw;
  }
  return (
    raw
      .replace(/\s+membership$/i, '')
      .replace(/\s+member$/i, '')
      .trim() || 'Guest'
  );
};

/**
 * Send post-bill Activity Update WhatsApp using template `activityupdate`.
 *
 * Live Meta placeholder map — proven by two delivery experiments (2026-07-27):
 *   Send […,180,0,0,Guest,0] → Discount ₹180, Amount ₹0, Wallet ₹0
 *   Send […,0,0,180,Guest,0] → Discount ₹0, Amount ₹0, Wallet ₹180
 * Therefore:
 *  {{1}} name
 *  {{2}} activity
 *  {{3}} discount
 *  {{4}} cashback
 *  {{5}} wallet balance
 *  {{6}} membership (As a {{6}} Member)
 *  {{7}} amount paid
 */
export const sendActivityUpdateWhatsApp = async ({
  to,
  name,
  activityType,
  amountPaid,
  membershipLabel,
  discountAmount,
  cashbackAmount,
  walletBalance,
  detailsUrlParam,
  walletUrlParam,
}) => {
  const config = getActivityUpdateTemplateConfig();
  const {phoneNumberId, accessToken, templateName, language} = config;

  const detailsParam = String(
    detailsUrlParam ?? config.detailsUrlParam ?? '',
  ).trim();
  const walletParam = String(
    walletUrlParam ?? config.walletUrlParam ?? '',
  ).trim();

  // Final safety: never deliver Amount Paid ₹0 with Discount = bill total
  let paidSend = Number(amountPaid);
  let discountSend = Number(discountAmount);
  if (
    (!Number.isFinite(paidSend) || paidSend <= 0) &&
    Number.isFinite(discountSend) &&
    discountSend > 0
  ) {
    paidSend = discountSend;
    discountSend = 0;
  }

  // Match Meta numbers exactly (NOT visual reading order)
  const bodyValues = [
    String(name || 'Guest').trim() || 'Guest', // {{1}} name
    String(activityType || 'Invoice').trim() || 'Invoice', // {{2}} activity
    formatAmountPlain(discountSend), // {{3}} Discount
    formatAmountPlain(cashbackAmount), // {{4}} Cashback
    formatAmountPlain(walletBalance), // {{5}} Wallet
    formatActivityMembershipParam(membershipLabel), // {{6}} membership
    formatAmountPlain(paidSend), // {{7}} Amount Paid
  ];

  console.log('[ActivityUpdate] bodyValues', bodyValues, {
    paidSend,
    discountSend,
    walletBalance,
  });

  if (!phoneNumberId || !accessToken) {
    console.log(
      `[ActivityUpdate][WhatsApp stub] to=${to} params=${JSON.stringify(bodyValues)}`,
    );
    return {channel: 'whatsapp-stub', delivered: false};
  }

  const recipient = toWhatsAppRecipient(to);
  if (!recipient) {
    return {
      channel: 'whatsapp',
      delivered: false,
      error: 'Invalid mobile number for WhatsApp activity update',
    };
  }

  let lastError = null;

  // Prefer body-only first (static URL buttons on template), then dynamic URL suffixes
  const buttonModes = [
    {detailsParam: '', walletParam: ''},
    {
      detailsParam: detailsParam || 'details',
      walletParam: walletParam || 'wallet',
    },
    {detailsParam: detailsParam || '', walletParam: ''},
  ];

  for (const lang of languageCandidates(language)) {
    for (const mode of buttonModes) {
      const components = [
        {
          type: 'body',
          parameters: bodyValues.map(text => ({type: 'text', text})),
        },
      ];

      if (mode.detailsParam) {
        components.push({
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{type: 'text', text: String(mode.detailsParam)}],
        });
      }
      if (mode.walletParam) {
        components.push({
          type: 'button',
          sub_type: 'url',
          index: '1',
          parameters: [{type: 'text', text: String(mode.walletParam)}],
        });
      }

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'template',
        template: {
          name: templateName,
          language: {code: lang},
          components,
        },
      };

      const result = await postTemplateMessage({
        phoneNumberId,
        accessToken,
        payload,
      });

      if (result.ok) {
        const messageId = result.json?.messages?.[0]?.id || null;
        console.log(
          `[ActivityUpdate][WhatsApp] delivered to=${recipient} template=${templateName} lang=${lang} body=${JSON.stringify(bodyValues)} buttons=${JSON.stringify(mode)} id=${messageId}`,
        );
        return {
          channel: 'whatsapp',
          delivered: true,
          messageId,
          templateName,
          language: lang,
          bodyValues,
        };
      }

      lastError = result.json?.error || {message: result.raw, status: result.status};
      const message = String(lastError.message || '');

      if (lastError.code === 190 || /oauth|access token|authenticat/i.test(message)) {
        break;
      }

      if (/language|template name|does not exist|not found/i.test(message)) {
        break;
      }

      if (/button|component|parameter|expected|number of params/i.test(message)) {
        continue;
      }

      break;
    }

    if (
      lastError?.code === 190 ||
      /oauth|access token|authenticat|language|template name|does not exist|not found/i.test(
        String(lastError?.message || ''),
      )
    ) {
      break;
    }
  }

  const metaMessage =
    lastError?.error_user_msg ||
    lastError?.message ||
    'Unknown WhatsApp API error';

  console.error('[ActivityUpdate][WhatsApp] failed:', lastError, {
    bodyValues,
  });

  return {
    channel: 'whatsapp',
    delivered: false,
    error: metaMessage,
    meta: lastError,
    bodyValues,
  };
};


const CSP_SALE_PARAM_KEYS = [
  'name',
  'products',
  'earning',
  'saleAmount',
  'invoice',
  'walletBalance',
];
const CSP_SALE_FALLBACK_COUNTS = [3, 4, 2, 5, 6, 1, 0];
let learnedCspSaleParamCount = null;

/** Meta rejects template params containing newlines, tabs or 4+ consecutive spaces. */
const toTemplateText = (value, fallback, maxLength = 120) => {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!text) return fallback;
  return text.length > maxLength
    ? `${text.slice(0, maxLength - 1).trimEnd()}…`
    : text;
};

const formatCspProductList = productNames => {
  const names = [
    ...new Set(
      (Array.isArray(productNames) ? productNames : [])
        .map(name => toTemplateText(name, '', 60))
        .filter(Boolean),
    ),
  ];
  if (!names.length) return 'your product';
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} +${names.length - 3} more` : shown;
};

const parseExpectedParamCount = error => {
  const text = `${error?.error_data?.details || ''} ${error?.message || ''}`;
  const match = text.match(/expected number of params \((\d+)\)/i);
  return match ? Number(match[1]) : null;
};

/**
 * Send `cspsaleupdate` to a CSP owner after their product sells (payment complete).
 *
 * Body params follow WHATSAPP_CSP_SALE_PARAM_ORDER (comma-separated keys), default:
 *  {{1}} name, {{2}} products, {{3}} earning, {{4}} saleAmount, {{5}} invoice, {{6}} walletBalance
 * Amounts are digits only — the Meta template text carries the ₹ symbol.
 * If Meta reports a different param count, the matching prefix is resent and remembered.
 */
export const sendCspSaleUpdateWhatsApp = async ({
  to,
  ownerName,
  productNames,
  earningAmount,
  saleAmount,
  invoiceLabel,
  walletBalance,
}) => {
  const config = getCspSaleUpdateTemplateConfig();
  const {phoneNumberId, accessToken, templateName, language} = config;

  const valuesByKey = {
    name: toTemplateText(ownerName, 'Partner', 60),
    products: formatCspProductList(productNames),
    earning: formatAmountPlain(earningAmount),
    saleAmount: formatAmountPlain(saleAmount),
    invoice: toTemplateText(invoiceLabel, 'Invoice', 40),
    walletBalance: formatAmountPlain(walletBalance),
  };
  const configuredKeys = config.paramOrder.filter(key => key in valuesByKey);
  const keys = configuredKeys.length ? configuredKeys : CSP_SALE_PARAM_KEYS;
  const allValues = keys.map(key => valuesByKey[key]);
  const initialCount = Math.min(
    config.paramCount ?? learnedCspSaleParamCount ?? allValues.length,
    allValues.length,
  );

  if (!phoneNumberId || !accessToken) {
    console.log(
      `[CspSaleUpdate][WhatsApp stub] to=${to} template=${templateName} params=${JSON.stringify(allValues.slice(0, initialCount))}`,
    );
    return {channel: 'whatsapp-stub', delivered: false};
  }

  const recipient = toWhatsAppRecipient(to);
  if (!recipient) {
    return {
      channel: 'whatsapp',
      delivered: false,
      error: 'Invalid mobile number for WhatsApp CSP sale update',
    };
  }

  const buttonParam = config.urlButtonParam || 'wallet';
  let lastError = null;
  let authFailed = false;

  for (const lang of languageCandidates(language)) {
    let count = initialCount;
    let withButton = false;
    const tried = new Set();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const attemptKey = `${count}:${withButton}`;
      if (tried.has(attemptKey)) break;
      tried.add(attemptKey);

      const bodyValues = allValues.slice(0, count);
      const components = [];
      if (bodyValues.length) {
        components.push({
          type: 'body',
          parameters: bodyValues.map(text => ({type: 'text', text})),
        });
      }
      if (withButton) {
        components.push({
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{type: 'text', text: buttonParam}],
        });
      }

      const result = await postTemplateMessage({
        phoneNumberId,
        accessToken,
        payload: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: recipient,
          type: 'template',
          template: {
            name: templateName,
            language: {code: lang},
            ...(components.length ? {components} : {}),
          },
        },
      });

      if (result.ok) {
        learnedCspSaleParamCount = count;
        const messageId = result.json?.messages?.[0]?.id || null;
        console.log(
          `[CspSaleUpdate][WhatsApp] delivered to=${recipient} template=${templateName} lang=${lang} body=${JSON.stringify(bodyValues)} button=${withButton} id=${messageId}`,
        );
        return {
          channel: 'whatsapp',
          delivered: true,
          messageId,
          templateName,
          language: lang,
          bodyValues,
        };
      }

      lastError = result.json?.error || {message: result.raw, status: result.status};
      const errorText = `${lastError.message || ''} ${lastError.error_data?.details || ''}`;

      if (lastError.code === 190 || /oauth|access token|authenticat/i.test(errorText)) {
        authFailed = true;
        break;
      }
      if (isMissingTemplateError(lastError)) break;
      if (!/param|button|component/i.test(errorText)) break;

      if (/button/i.test(errorText) && !/body/i.test(errorText)) {
        withButton = !withButton;
        continue;
      }

      const expected = parseExpectedParamCount(lastError);
      if (expected !== null && expected !== count && expected <= allValues.length) {
        count = expected;
        continue;
      }

      const nextCount = CSP_SALE_FALLBACK_COUNTS.find(
        n => n <= allValues.length && !tried.has(`${n}:${withButton}`),
      );
      if (nextCount === undefined) break;
      count = nextCount;
    }

    if (authFailed) break;
  }

  const metaMessage =
    lastError?.error_user_msg || lastError?.message || 'Unknown WhatsApp API error';

  console.error('[CspSaleUpdate][WhatsApp] failed:', lastError, {
    to: recipient,
    templateName,
    values: allValues,
  });

  return {
    channel: 'whatsapp',
    delivered: false,
    error: metaMessage,
    meta: lastError,
  };
};

/**
 * Meta template names are lowercase [a-z0-9_]+ only.
 * UI display labels like "new cafe" / "New Cafe" must become "newcafe".
 */
export const normalizeWhatsAppTemplateName = (raw = '') => {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9_]/g, '');
  return (
    normalized ||
    String(process.env.WHATSAPP_ANNOUNCEMENT_TEMPLATE_NAME || 'newcafe')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[^a-z0-9_]/g, '') ||
    'newcafe'
  );
};

/** Templates known to require an IMAGE header component on send */
export const announcementRequiresImageHeader = (templateName = '') => {
  const configured = String(
    process.env.WHATSAPP_ANNOUNCEMENT_IMAGE_TEMPLATES || 'newcafe',
  )
    .split(',')
    .map((s) => normalizeWhatsAppTemplateName(s))
    .filter(Boolean);
  return configured.includes(normalizeWhatsAppTemplateName(templateName));
};

const getWhatsAppCreds = () => {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.replace(
    /^["']|["']$/g,
    '',
  ).trim();
  const version = process.env.WHATSAPP_API_VERSION || 'v21.0';
  return { phoneNumberId, accessToken, version };
};

const mimeFromPath = (filePath) => {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
};

/**
 * Upload a local image to WhatsApp Cloud API media.
 * Returns media id usable in template IMAGE headers for ~30 days.
 */
export const uploadWhatsAppImageMedia = async (filePath) => {
  const { phoneNumberId, accessToken, version } = getWhatsAppCreds();
  if (!phoneNumberId || !accessToken) {
    throw new Error('Missing WhatsApp credentials for media upload');
  }
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Image file not found: ${filePath || '(empty)'}`);
  }

  const mime = mimeFromPath(filePath);
  const buf = fs.readFileSync(filePath);
  const blob = new Blob([buf], { type: mime });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
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
    throw new Error(data?.error?.message || 'WhatsApp media upload failed');
  }
  return String(data.id);
};

/** Locked header image for IMAGE templates (newcafe) */
export const DEFAULT_ANNOUNCEMENT_HEADER_IMAGE = path.join(
  REPO_ROOT,
  'Client/src/assets/images/logo/newcafe.jpeg',
);

const isHttpsImageUrl = (value = '') =>
  /^https:\/\/.+\.(jpe?g|png|webp)(\?.*)?$/i.test(String(value).trim()) ||
  /^https:\/\/.+/i.test(String(value).trim());

/**
 * Resolve header media once per announcement batch.
 * IMAGE templates (newcafe) always upload
 * Client/src/assets/images/logo/newcafe.jpeg unless an explicit HTTPS URL is given.
 */
export const resolveAnnouncementHeaderMedia = async ({
  headerImageLink = '',
  headerImageId = '',
  templateName = '',
  forceDefaultImage = false,
} = {}) => {
  const explicitLink = String(headerImageLink || '').trim();
  const envLink = String(
    process.env.WHATSAPP_ANNOUNCEMENT_HEADER_IMAGE || '',
  ).trim();
  const existingId = String(headerImageId || '').trim();
  const requiresImage = announcementRequiresImageHeader(templateName);

  if (!requiresImage && !explicitLink && !existingId) {
    return {
      headerImageLink: '',
      headerImageId: '',
      sourceFile: '',
    };
  }

  // Optional override only when a real HTTPS URL is provided.
  const link = !forceDefaultImage && isHttpsImageUrl(explicitLink)
    ? explicitLink
    : !forceDefaultImage && !explicitLink && isHttpsImageUrl(envLink)
      ? envLink
      : '';

  if (link) {
    console.log('[Announcement] Using header image URL:', link);
    return { headerImageLink: link, headerImageId: '', sourceFile: '' };
  }

  if (existingId && !forceDefaultImage && !requiresImage) {
    return { headerImageLink: '', headerImageId: existingId, sourceFile: '' };
  }

  // Always send the project asset for newcafe / IMAGE-header templates.
  const filePath =
    process.env.WHATSAPP_ANNOUNCEMENT_HEADER_IMAGE_FILE?.trim() ||
    DEFAULT_ANNOUNCEMENT_HEADER_IMAGE;

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Announcement IMAGE header file missing: ${filePath}. Expected Client/src/assets/images/logo/newcafe.jpeg`,
    );
  }

  const mediaId = await uploadWhatsAppImageMedia(filePath);
  console.log('[Announcement] Uploaded header image for WhatsApp', {
    templateName: normalizeWhatsAppTemplateName(templateName),
    sourceFile: filePath,
    mediaId,
  });
  return {
    headerImageLink: '',
    headerImageId: mediaId,
    sourceFile: filePath,
  };
};

export const sendWhatsAppTemplateMessage = async ({
  to,
  templateName,
  languageCode = 'en_US',
  bodyParams = [], // ["Rahul", "Premium"] → {{1}} {{2}}
  headerImageLink = '', // public HTTPS URL for IMAGE-header templates
  headerImageId = '', // WhatsApp media id (preferred when no public URL)
  /** Dynamic URL button suffixes, index order (0 = first URL button) */
  buttonUrlParams = [],
}) => {
  const { phoneNumberId, accessToken, version } = getWhatsAppCreds();

  if (!phoneNumberId || !accessToken) {
    // stub mode for local learning without Meta
    console.log('[Announcement][WhatsApp stub]', {
      to,
      templateName,
      bodyParams,
      headerImageLink,
      headerImageId,
      buttonUrlParams,
    });
    return { delivered: false, stub: true };
  }

  const recipient = toWhatsAppRecipient(to); // you already have this
  if (!recipient) throw new Error('Invalid WhatsApp recipient');

  let imageLink = String(headerImageLink || '').trim();
  let imageId = String(headerImageId || '').trim();

  // Safety net: IMAGE templates must never send without a header
  if (
    announcementRequiresImageHeader(templateName) &&
    !imageLink &&
    !imageId
  ) {
    const resolved = await resolveAnnouncementHeaderMedia({ templateName });
    imageLink = resolved.headerImageLink;
    imageId = resolved.headerImageId;
  }

  const components = [];

  if (imageId || imageLink) {
    components.push({
      type: 'header',
      parameters: [
        {
          type: 'image',
          image: imageId ? { id: imageId } : { link: imageLink },
        },
      ],
    });
  }

  if (bodyParams.length) {
    components.push({
      type: 'body',
      parameters: bodyParams.map((text) => ({
        type: 'text',
        text: String(text),
      })),
    });
  }

  (Array.isArray(buttonUrlParams) ? buttonUrlParams : []).forEach((param, index) => {
    const text = String(param ?? '').trim();
    if (!text) return;
    components.push({
      type: 'button',
      sub_type: 'url',
      index: String(index),
      parameters: [{ type: 'text', text }],
    });
  });

  if (
    announcementRequiresImageHeader(templateName) &&
    !components.some((c) => c.type === 'header')
  ) {
    throw new Error(
      `Template "${templateName}" requires IMAGE header but none was resolved`,
    );
  }

  const res = await fetch(
    `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: recipient,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          ...(components.length ? { components } : {}),
        },
      }),
    },
  );

  const data = await res.json();
  if (!res.ok) {
    const details = data?.error?.error_data?.details;
    const msg = data?.error?.message || 'WhatsApp API failed';
    throw new Error(details ? `${msg} — ${details}` : msg);
  }
  return { delivered: true, messageId: data?.messages?.[0]?.id };
};

const getMembershipRenewalTemplateConfig = () => {
  const { phoneNumberId, accessToken, language } = getConfig();
  const templateName = (
    process.env.WHATSAPP_MEMBERSHIP_RENEWAL_TEMPLATE ||
    'membershiprenewal'
  ).trim();
  const renewalLanguage = (
    process.env.WHATSAPP_MEMBERSHIP_RENEWAL_TEMPLATE_LANGUAGE ||
    language ||
    'en'
  ).trim();
  const urlButtonParam = (
    process.env.WHATSAPP_MEMBERSHIP_RENEWAL_URL_PARAM ||
    ''
  ).trim();

  return {
    phoneNumberId,
    accessToken,
    templateName,
    language: renewalLanguage,
    urlButtonParam,
  };
};

const buildMembershipRenewalTemplatePayload = ({
  to,
  templateName,
  language,
  name,
  daysLabel,
  savingsLabel,
  planLabel,
  cashbackLabel,
  urlButtonParam,
}) => {
  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: String(name || 'Member') },
        { type: 'text', text: String(daysLabel) },
        { type: 'text', text: String(savingsLabel) },
        { type: 'text', text: String(planLabel) },
        { type: 'text', text: String(cashbackLabel) },
      ],
    },
  ];

  if (urlButtonParam) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: String(urlButtonParam) }],
    });
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      components,
    },
  };
};

/**
 * Send Meta template `membershiprenewal`.
 * Body vars (positional):
 *  {{1}} name
 *  {{2}} days until expiry (e.g. 07)
 *  {{3}} savings so far — digits only (template already has ₹)
 *  {{4}} plan name (e.g. Premium)
 *  {{5}} renew cashback gift — digits only (template already has ₹)
 * Optional URL button index 0 = renew link suffix.
 */
export const sendMembershipRenewalWhatsApp = async ({
  to,
  name,
  daysUntilExpiry,
  savingsAmount,
  planName,
  cashbackAmount,
  renewUrlParam,
}) => {
  const {
    phoneNumberId,
    accessToken,
    templateName,
    language,
    urlButtonParam,
  } = getMembershipRenewalTemplateConfig();

  const daysNum = Math.max(0, Math.ceil(Number(daysUntilExpiry) || 0));
  const daysLabel = String(daysNum).padStart(2, '0');
  const savingsNum = Math.max(0, Math.round(Number(savingsAmount) || 0));
  const cashbackNum = Math.max(
    0,
    Math.round(
      Number(
        cashbackAmount ??
          process.env.WHATSAPP_MEMBERSHIP_RENEWAL_CASHBACK ??
          process.env.WHATSAPP_MEMBERSHIP_CASHBACK ??
          200,
      ) || 0,
    ),
  );
  const planLabel = String(planName || 'Membership').trim() || 'Membership';
  // Meta template body already includes ₹ before {{3}} and {{5}} — send digits only.
  const savingsLabel = formatAmountPlain(savingsNum);
  const cashbackLabel = formatAmountPlain(cashbackNum);
  const buttonParam = String(renewUrlParam || urlButtonParam || '').trim();

  if (!phoneNumberId || !accessToken) {
    console.log('[MembershipRenewal][WhatsApp stub]', {
      to,
      name,
      daysLabel,
      savingsLabel,
      planLabel,
      cashbackLabel,
      buttonParam,
    });
    return {
      channel: 'whatsapp-stub',
      delivered: false,
      stub: true,
      bodyParams: [name, daysLabel, savingsLabel, planLabel, cashbackLabel],
    };
  }

  const recipient = toWhatsAppRecipient(to);
  if (!recipient) {
    const error = new Error('Invalid mobile / WhatsApp number');
    error.status = 400;
    throw error;
  }

  let lastError = null;
  const templateNames = templateNameCandidates(templateName, [
    'membershiprenewal',
  ]);
  const buttonModes = buttonParam
    ? [buttonParam, '']
    : ['', 'renew'];

  for (const activeTemplate of templateNames) {
    for (const lang of languageCandidates(language)) {
      for (const btn of buttonModes) {
        const payload = buildMembershipRenewalTemplatePayload({
          to: recipient,
          templateName: activeTemplate,
          language: lang,
          name: String(name || 'Member').trim() || 'Member',
          daysLabel,
          savingsLabel,
          planLabel,
          cashbackLabel,
          urlButtonParam: btn || null,
        });

        const result = await postTemplateMessage({
          phoneNumberId,
          accessToken,
          payload,
        });

        if (result.ok) {
          const messageId = result.json?.messages?.[0]?.id || null;
          console.log(
            `[MembershipRenewal][WhatsApp] delivered to=${recipient} template=${activeTemplate} lang=${lang} id=${messageId}`,
          );
          return {
            channel: 'whatsapp',
            delivered: true,
            messageId,
            templateName: activeTemplate,
            language: lang,
            bodyParams: [
              String(name || 'Member').trim() || 'Member',
              daysLabel,
              savingsLabel,
              planLabel,
              cashbackLabel,
            ],
          };
        }

        lastError =
          result.json?.error || { message: result.raw, status: result.status };
        const message = String(lastError.message || '');

        if (
          lastError.code === 190 ||
          /oauth|access token|authenticat/i.test(message)
        ) {
          break;
        }
        if (isMissingTemplateError(lastError)) {
          break;
        }
        if (/button|component|parameter|expected|number of params/i.test(message)) {
          continue;
        }
        break;
      }

      if (
        lastError?.code === 190 ||
        isMissingTemplateError(lastError) ||
        /oauth|access token|authenticat/i.test(String(lastError?.message || ''))
      ) {
        break;
      }
    }
  }

  const err = new Error(
    lastError?.message || 'Failed to send membership renewal WhatsApp',
  );
  err.status = 502;
  err.meta = lastError;
  throw err;
};
