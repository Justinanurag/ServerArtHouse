import mongoose from "mongoose";

const offerRuleSchema = new mongoose.Schema(
  {
    minimumHours: {type: Number, required: true, min: 0},
    freeHours: {type: Number, required: true, min: 0},
    priority: {type: Number, default: 0},
    status: {type: String, enum: ["active", "inactive"], default: "active"},
  },
  {_id: false},
);

const spaceOfferSchema = new mongoose.Schema(
  {
    offerName: {type: String, required: true, trim: true},
    description: {type: String, default: "", trim: true},
    offerType: {type: String, enum: ["space_booking"], default: "space_booking"},
    priority: {type: Number, default: 0},
    rules: {type: [offerRuleSchema], default: []},
    status: {type: String, enum: ["active", "inactive"], default: "active", index: true},
  },
  {timestamps: true},
);

spaceOfferSchema.index({status: 1, offerType: 1, createdAt: -1});
spaceOfferSchema.index({offerName: 1});

export default mongoose.model("SpaceOffer", spaceOfferSchema);
