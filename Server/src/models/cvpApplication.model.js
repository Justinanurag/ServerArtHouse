import mongoose from 'mongoose';

const SLOTS = ['Morning', 'Afternoon', 'Evening', 'Night', 'Anytime'];

const cvpApplicationSchema = new mongoose.Schema(
  {
    fullName: {type: String, required: true, trim: true, maxlength: 120},
    phone: {type: String, default: '', trim: true, maxlength: 10},
    profession: {type: String, required: true, trim: true, maxlength: 80},
    photoUrl: {type: String, required: true, trim: true},
    availability: {
      type: [{type: String, enum: SLOTS}],
      required: true,
      validate: {
        validator: value => Array.isArray(value) && value.length > 0,
        message: 'Select at least one available time.',
      },
    },
    volunteeredBefore: {type: Boolean, default: false},
    events: {type: String, default: '', trim: true, maxlength: 200},
    volunteerType: {
      type: String,
      enum: ['Paid', 'Unpaid', 'Both', ''],
      default: '',
    },
  },
  {timestamps: true},
);

cvpApplicationSchema.index({createdAt: -1});
cvpApplicationSchema.index({fullName: 1, profession: 1});

export default mongoose.model('CvpApplication', cvpApplicationSchema);
