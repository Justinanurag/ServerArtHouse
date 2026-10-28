import BookingPaymentSettings from '../models/bookingPaymentSettings.model.js';
import {normalizeBookingPaymentRule} from '../utils/bookingPayment.js';

export const getBookingPaymentRule = async () => {
  const doc = await BookingPaymentSettings.findOne({key: 'default'}).lean();
  return normalizeBookingPaymentRule(doc || {});
};

export const saveBookingPaymentRule = async (input, actor) => {
  const rule = normalizeBookingPaymentRule(input || {});
  const doc = await BookingPaymentSettings.findOneAndUpdate(
    {key: 'default'},
    {
      $set: {
        ...rule,
        key: 'default',
        updatedBy: actor || null,
      },
    },
    {new: true, upsert: true, setDefaultsOnInsert: true},
  ).lean();
  return normalizeBookingPaymentRule(doc);
};
