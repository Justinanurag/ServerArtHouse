import crypto from 'crypto';
import mongoose from 'mongoose';
import Exhibition, {
  EXHIBITION_DEFAULT_EVENT,
  EXHIBITION_GENDERS,
  EXHIBITION_INTERESTS,
} from '../models/exhibition.model.js';
const PASS_CODE_RE = /WWX-[A-Z0-9]{4}-[A-Z0-9]{4}/;

const MAX_PEOPLE_PER_REQUEST = 10;
const PHONE_RE = /^[6-9]\d{9}$/;
// No 0/O/1/I/L so codes can be read aloud and typed at the gate without mistakes.
const PASS_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

const randomChars = length =>
  Array.from({length}, () => PASS_CODE_ALPHABET[crypto.randomInt(PASS_CODE_ALPHABET.length)]).join(
    '',
  );

const newPassCode = () => `WWX-${randomChars(4)}-${randomChars(4)}`;

const staffFromReq = req => ({
  m_staff_id: req.user?.m_staff_id ?? req.user?.userId ?? null,
  m_staff_name: req.user?.name ?? null,
  m_staff_email: req.user?.email ?? null,
});

/** Accepts either `[...people]` or `{people: [...]}` and returns clean people or errors. */
const parsePeople = body => {
  const people = Array.isArray(body) ? body : body?.people;
  if (!Array.isArray(people) || people.length === 0) {
    return {errors: ['At least one person is required.']};
  }
  if (people.length > MAX_PEOPLE_PER_REQUEST) {
    return {errors: [`You can register up to ${MAX_PEOPLE_PER_REQUEST} people at once.`]};
  }

  const errors = [];
  const phoneOwner = new Map();

  const cleaned = people.map((raw, index) => {
    const label = `Person ${index + 1}`;
    const fullName = String(raw?.fullName ?? '').trim().replace(/\s+/g, ' ');
    const phone = String(raw?.phone ?? '').replace(/\D/g, '');
    const age = Number(raw?.age);
    const gender = String(raw?.gender ?? '');
    const rawInterests = Array.isArray(raw?.interests)
      ? raw.interests
      : raw?.interest
        ? [raw.interest]
        : [];
    const interests = [...new Set(rawInterests.map(v => String(v)))];

    if (fullName.length < 2 || fullName.length > 60) {
      errors.push(`${label}: full name must be 2–60 characters.`);
    }
    if (!PHONE_RE.test(phone)) {
      errors.push(`${label}: enter a valid 10-digit mobile number.`);
    } else if (phoneOwner.has(phone)) {
      errors.push(`${label}: phone number is already used by Person ${phoneOwner.get(phone)}.`);
    } else {
      phoneOwner.set(phone, index + 1);
    }
    if (!Number.isInteger(age) || age < 1 || age > 110) errors.push(`${label}: enter a valid age.`);
    if (!EXHIBITION_GENDERS.includes(gender)) errors.push(`${label}: select a valid gender.`);
    if (interests.length === 0) {
      errors.push(`${label}: select at least one interest.`);
    } else if (!interests.every(v => EXHIBITION_INTERESTS.includes(v))) {
      errors.push(`${label}: select valid interests.`);
    }

    return {fullName, phone, age, gender, interests};
  });

  return errors.length ? {errors} : {people: cleaned};
};

/** Generates pass codes that are unique within the batch and not already in the database. */
const generateUniquePassCodes = async count => {
  const codes = new Set();
  for (let attempt = 0; attempt < 5 && codes.size < count; attempt++) {
    const candidates = new Set();
    while (candidates.size < count - codes.size) {
      const code = newPassCode();
      if (!codes.has(code)) candidates.add(code);
    }
    const taken = await Exhibition.find({passcode: {$in: [...candidates]}})
      .select('passcode')
      .lean();
    const takenSet = new Set(taken.map(t => t.passcode));
    candidates.forEach(code => {
      if (!takenSet.has(code)) codes.add(code);
    });
  }
  if (codes.size < count) throw new Error('Could not generate unique pass codes');
  return [...codes];
};

const toPass = doc => ({
  _id: doc._id,
  code: doc.passcode,
  fullName: doc.fullName,
  phone: doc.phone,
  age: doc.age,
  gender: doc.gender,
  interests: doc.interests?.length ? doc.interests : doc.interest ? [doc.interest] : [],
  groupId: doc.groupId,
  position: doc.position,
  groupSize: doc.groupSize,
  status: doc.status,
  event: doc.event,
  issuedAt: doc.createdAt,
});

class DuplicatePhoneError extends Error {
  constructor(phones) {
    super(
      phones.length === 1
        ? `${phones[0]} is already registered for this exhibition.`
        : `These numbers are already registered: ${phones.join(', ')}.`,
    );
    this.phones = phones;
  }
}

const findRegisteredPhones = async (phones, event) => {
  const existing = await Exhibition.find({event, phone: {$in: phones}}).select('phone').lean();
  return [...new Set(existing.map(doc => doc.phone))];
};

const isDuplicatePhoneKeyError = error =>
  error?.code === 11000 &&
  (Boolean(error.keyPattern?.phone) || String(error.message).includes('phone_1'));

const insertPasses = async (people, extra = {}) => {
  const event = EXHIBITION_DEFAULT_EVENT;
  const phones = people.map(p => p.phone);

  const registered = await findRegisteredPhones(phones, event);
  if (registered.length) throw new DuplicatePhoneError(registered);

  const codes = await generateUniquePassCodes(people.length);
  const groupId = randomChars(8);
  const docs = people.map((person, index) => ({
    ...person,
    ...extra,
    event,
    passcode: codes[index],
    groupId,
    position: index + 1,
    groupSize: people.length,
  }));

  try {
    return await Exhibition.insertMany(docs);
  } catch (error) {
    // A concurrent request registered one of these phones after the check above:
    // remove whatever part of this group was inserted so groups stay all-or-nothing.
    await Exhibition.deleteMany({groupId});
    if (isDuplicatePhoneKeyError(error)) {
      throw new DuplicatePhoneError(await findRegisteredPhones(phones, event));
    }
    throw error;
  }
};

const sendDuplicatePhones = (res, error) =>
  res.status(409).json({success: false, message: error.message, duplicatePhones: error.phones});

/** Public: visitors register from woowooarthouse.in/exhibition (no login). */
export const registerExhibitionPasses = async (req, res) => {
  try {
    const {people, errors} = parsePeople(req.body);
    if (errors) {
      return res.status(400).json({success: false, message: errors[0], errors});
    }

    const created = await insertPasses(people);
    return res.status(201).json({
      success: true,
      message: `${created.length} pass${created.length > 1 ? 'es' : ''} generated successfully`,
      data: created.map(toPass),
    });
  } catch (error) {
    if (error instanceof DuplicatePhoneError) return sendDuplicatePhones(res, error);
    console.error('Exhibition registration failed:', error);
    return res
      .status(500)
      .json({success: false, message: 'Could not generate passes. Please try again.'});
  }
};

/** Admin: staff register visitors at the counter. */
export const createExhibition = async (req, res) => {
  try {
    const {people, errors} = parsePeople(req.body);
    if (errors) {
      return res.status(400).json({success: false, message: errors[0], errors});
    }

    const created = await insertPasses(people, {createdBy: staffFromReq(req)});
    return res.status(201).json({
      success: true,
      message: `${created.length} passes created successfully`,
      data: created.map(toPass),
    });
  } catch (error) {
    if (error instanceof DuplicatePhoneError) return sendDuplicatePhones(res, error);
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

/** Admin: mark a visitor present (checked in at the gate) or revert to absent. */
export const markExhibitionAttendance = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid id'});
    }
    if (typeof req.body?.present !== 'boolean') {
      return res.status(400).json({success: false, message: '`present` must be true or false.'});
    }

    const staff = staffFromReq(req);
    let exhibition;

    if (req.body.present) {
      // Only stamp the first check-in so a double click doesn't move the time.
      exhibition = await Exhibition.findOneAndUpdate(
        {_id: id, checkedInAt: null, status: {$ne: 'Cancelled'}},
        {$set: {checkedInAt: new Date(), checkedInBy: staff, updatedBy: staff}},
        {new: true},
      ).lean();

      if (!exhibition) {
        const existing = await Exhibition.findById(id).lean();
        if (!existing) {
          return res.status(404).json({success: false, message: 'Pass not found'});
        }
        if (existing.status === 'Cancelled') {
          return res
            .status(409)
            .json({success: false, message: 'Cancelled passes cannot be marked present.'});
        }
        exhibition = existing;
      }
    } else {
      exhibition = await Exhibition.findByIdAndUpdate(
        id,
        {$set: {checkedInAt: null, updatedBy: staff}, $unset: {checkedInBy: 1}},
        {new: true},
      ).lean();
      if (!exhibition) {
        return res.status(404).json({success: false, message: 'Pass not found'});
      }
    }

    return res.status(200).json({
      success: true,
      message: exhibition.checkedInAt ? 'Marked present' : 'Marked absent',
      exhibition,
    });
  } catch (error) {
    return res.status(500).json({success: false, message: error.message});
  }
};

export const getExhibitionById = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid id'});
    }
    const exhibition = await Exhibition.findById(id).lean();
    if (!exhibition) {
      return res
        .status(404)
        .json({success: false, message: 'Exhibition not found'});
    }
    res.status(200).json({success: true ,message: 'Exhibition fetched successfully', exhibition});
  } catch (error) {
    res.status(500).json({success: false, message: error.message});
  }
};

export const updateExhibition = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid id'});
    }
    const updatedExhibition = await Exhibition.findByIdAndUpdate(
      id,
      {$set: req.body},
      {new: true},
    );
    res.status(200).json({
      success: true,
      message: 'Exhibition updated successfully',
    updatedExhibition});
  } catch (error) {
    res.status(500).json({success: false, message: error.message});
  }
};

export const getExhibitions = async (req, res) => {
  try {
    const exhibitions = await Exhibition.find().sort({createdAt: -1}).lean();
    res.status(200).json({
      success: true,
      message: 'Exhibitions fetched successfully',
    exhibitions});
  } catch (error) {
    res.status(500).json({success: false, message: error.message});
  }
};

export const deleteExhibition = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid id'});
    }
    const deletedExhibition = await Exhibition.findByIdAndDelete(id);
    res.status(200).json(
      {
        message: 'Exhibition deleted successfully',
    
      deletedExhibition,
      });
  } catch (error) {
    res.status(500).json({success: false, message: error.message});
  }
};




export const checkInExhibitionPass = async (req, res) => {
  try {
    const match = String(req.body?.code ?? '').toUpperCase().match(PASS_CODE_RE);
    if (!match) {
      return res.status(400).json({success: false, message: 'This is not a valid exhibition pass.'});
    }
    const passcode = match[0];
    const staff = staffFromReq(req);

    // Atomic: only the first scan stamps the time, even if two gates scan at once.
    const updated = await Exhibition.findOneAndUpdate(
      {passcode, checkedInAt: null, status: 'Active'},
      {$set: {checkedInAt: new Date(), checkedInBy: staff, updatedBy: staff}},
      {new: true},
    ).lean();

    if (updated) {
      return res.status(200).json({
        success: true,
        result: 'checked_in',
        message: `${updated.fullName} marked present`,
        exhibition: updated,
      });
    }

    const existing = await Exhibition.findOne({passcode}).lean();
    if (!existing) {
      return res.status(404).json({success: false, message: `Pass ${passcode} not found.`});
    }
    if (existing.status !== 'Active') {
      return res
        .status(409)
        .json({success: false, message: `This pass is ${existing.status.toLowerCase()}.`});
    }
    return res.status(200).json({
      success: true,
      result: 'already_present',
      message: `${existing.fullName} is already marked present`,
      exhibition: existing,
    });
  } catch (error) {
    return res.status(500).json({success: false, message: error.message});
  }
};