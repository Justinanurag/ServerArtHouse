import mongoose from 'mongoose';

const segmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {timestamps: true},
);

segmentSchema.index({name: 1});

export default mongoose.model('Segment', segmentSchema);
