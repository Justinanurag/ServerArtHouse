import mongoose from "mongoose";

const commissionSchema = new mongoose.Schema(
  {
    membershipType: {
      type: String,
      required: true,
      trim: true,
      // Example: "Gold", "Silver", "Platinum"
    },

    commissionType: {
      type: String,
      enum: ["flat", "percentage"],
      required: true,
    },

    commissionValue: {
      type: Number,
      required: true,
      min: 0,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

const Commission = mongoose.model("Commission", commissionSchema);

export default Commission;