import mongoose from 'mongoose';

/**
 * Short-lived mutex documents that serialize booking writes per physical space.
 * `_id` is the lock key; uniqueness of `_id` makes acquisition atomic.
 */
const spaceBookingLockSchema = new mongoose.Schema(
  {
    _id: {type: String, required: true},
    token: {type: String, required: true},
    expiresAt: {type: Date, required: true},
  },
  {versionKey: false},
);

// TTL cleanup only; the reaper runs ~every 60s, so acquisition also
// takes over locks whose expiresAt has passed.
spaceBookingLockSchema.index({expiresAt: 1}, {expireAfterSeconds: 0});

export default mongoose.model('SpaceBookingLock', spaceBookingLockSchema);
