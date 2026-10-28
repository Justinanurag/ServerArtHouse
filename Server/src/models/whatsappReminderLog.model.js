import mongoose from 'mongoose';

/**
 * Audit log for Meta WhatsApp template sends (e.g. membershiprenewal).
 */
const whatsappReminderLogSchema = new mongoose.Schema(
  {
    subscriptionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Subscription',
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
      index: true,
    },
    customerName: {type: String, default: '', trim: true},
    phone: {type: String, required: true, trim: true, index: true},
    templateName: {
      type: String,
      required: true,
      trim: true,
      default: 'membershiprenewal',
    },
    languageCode: {type: String, default: 'en', trim: true},
    bodyParams: {type: [String], default: []},
    status: {
      type: String,
      enum: ['success', 'failed'],
      required: true,
      index: true,
    },
    messageId: {type: String, default: null},
    errorMessage: {type: String, default: ''},
    sentBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
  },
  {timestamps: true},
);

whatsappReminderLogSchema.index({subscriptionId: 1, createdAt: -1});

const WhatsAppReminderLog = mongoose.model(
  'WhatsAppReminderLog',
  whatsappReminderLogSchema,
);

export default WhatsAppReminderLog;
