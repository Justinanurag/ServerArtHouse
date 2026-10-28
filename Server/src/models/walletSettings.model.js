import mongoose from 'mongoose';

/**
 * Global wallet instructions (singleton).
 * minimumBalance must remain in the wallet after any debit / purchase payment.
 */
const walletSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: 'default',
      unique: true,
      trim: true,
    },
    minimumBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    updatedBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
  },
  {timestamps: true},
);

const WalletSettings = mongoose.model('WalletSettings', walletSettingsSchema);
export default WalletSettings;
