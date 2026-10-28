import mongoose from 'mongoose';

export const EXCLUSIVE_CATEGORIES = [
  'Studio',
  'Workshop',
  'Meeting Room',
  'Gallery',
  'Outdoor',
  'Event Space',
  'Private Office',
];

export const COWORKING_CATEGORIES = [
  'Hot Desk',
  'Dedicated Desk',
  'Desk Pass',
  'Flexi Desk',
  'Meeting Pod',
  'Open Workspace',
];

export const ALL_SPACE_CATEGORIES = [
  ...EXCLUSIVE_CATEGORIES,
  ...COWORKING_CATEGORIES,
];

export const SPACE_TYPES = ['Exclusive', 'Coworking'];
export const SPACE_DAYS = ['Weekday', 'Weekend'];
export const SPACE_STATUSES = ['Available', 'Booked', 'Maintenance'];

const spaceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    spaceCode: {
      type: String,
      default: '',
      trim: true,
      uppercase: true,
    },
    category: {
      type: String,
      default: 'Studio',
      trim: true,
    },
    /** Type of space: Exclusive or Coworking */
    spaceType: {
      type: String,
      enum: SPACE_TYPES,
      default: 'Exclusive',
    },
    /** Strict entity type — always Space (never Product/Services/Food). */
    itemType: {
      type: String,
      enum: ['space'],
      default: 'space',
      index: true,
    },
    /**
     * Pricing day for this record.
     * Same space name may have one Weekday row and one Weekend row.
     */
    day: {
      type: String,
      enum: SPACE_DAYS,
      required: true,
      default: 'Weekday',
    },
    /** Price for this specific day record only */
    price: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    capacity: {
      type: Number,
      default: 1,
      min: 1,
    },
    status: {
      type: String,
      enum: SPACE_STATUSES,
      default: 'Available',
      index: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    imageUrl: {
      type: String,
      default: null,
    },
    createdBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
  },
  {timestamps: true},
);

spaceSchema.index({name: 1});
spaceSchema.index({category: 1});
spaceSchema.index({spaceType: 1});
spaceSchema.index({spaceCode: 1});
spaceSchema.index({spaceType: 1, day: 1});
spaceSchema.index({spaceType: 1, status: 1});
/** Query helper — uniqueness enforced in controller (case-insensitive name). */
spaceSchema.index({name: 1, day: 1});

export default mongoose.model('Space', spaceSchema);
