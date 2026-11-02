import mongoose from 'mongoose';

const foodOfferSchema = new mongoose.Schema(
  {
    buyFoodId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Food',
      required: true,
      unique: true,
      index: true,
    },
    freeFoodId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Food',
      required: true,
    },
    createdBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
  },
  {timestamps: true},
);

export default mongoose.model('FoodOffer', foodOfferSchema);
