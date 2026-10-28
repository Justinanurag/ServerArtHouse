import AdditionalService from '../models/additionalService.model.js';


//1. GET - List all active services
export const DEFAULT_ADDITIONAL_SERVICES = [
  {
    title: 'Locker',
    amount: 500,
    unit: 'per month',
    priceLabel: '₹500 / month',
    icon: 'Lock',
    spaceType: 'coworking',
    key: 'locker',
  },
  {
    title: 'Printing',
    amount: 50,
    unit: 'per 100 pages',
    priceLabel: '₹50 / 100 pages',
    icon: 'Printer',
    spaceType: 'coworking',
    key: 'printing',
  },
  {
    title: 'Meeting Room',
    amount: 500,
    unit: 'per hour',
    priceLabel: '₹500 / hour',
    icon: 'Users',
    spaceType: 'coworking',
    key: 'meetingRoom',
  },
  {
    title: 'Storage',
    amount: 1000,
    unit: 'per month',
    priceLabel: '₹1,000 / month',
    icon: 'Archive',
    spaceType: 'coworking',
    key: 'storage',
  },
  {
    title: 'Parking',
    amount: 500,
    unit: 'per month',
    priceLabel: '₹500 / month',
    icon: 'Car',
    spaceType: 'coworking',
    key: 'parking',
  },
  {
    title: 'Marketing Support',
    amount: 500,
    unit: 'per booking',
    priceLabel: '₹500 / booking',
    icon: 'Megaphone',
    spaceType: 'exclusive',
    key: 'marketingSupport',
  },
  {
    title: 'Projector',
    amount: 800,
    unit: 'per booking',
    priceLabel: '₹800 / booking',
    icon: 'Projector',
    spaceType: 'exclusive',
    key: 'projector',
  },
  {
    title: 'Speaker / Sound System',
    amount: 600,
    unit: 'per booking',
    priceLabel: '₹600 / booking',
    icon: 'Volume2',
    spaceType: 'exclusive',
    key: 'speakerSound',
  },
  {
    title: 'Media Shoot',
    amount: 1500,
    unit: 'per booking',
    priceLabel: '₹1,500 / booking',
    icon: 'Camera',
    spaceType: 'exclusive',
    key: 'mediaShoot',
  },
  {
    title: 'Event Coordinator',
    amount: 1000,
    unit: 'per booking',
    priceLabel: '₹1,000 / booking',
    icon: 'UserRound',
    spaceType: 'exclusive',
    key: 'eventCoordinator',
  },
];

/**
 * GET /additional-services — list all additional services
 */
export const getAdditionalServices = async (req, res) => {
  try {
    let services = await AdditionalService.find({ isActive: { $ne: false } }).sort({
      createdAt: 1,
    });

    if (!services || services.length === 0) {
      // Seed default additional services
      try {
        await AdditionalService.insertMany(DEFAULT_ADDITIONAL_SERVICES);
        services = await AdditionalService.find({ isActive: { $ne: false } }).sort({
          createdAt: 1,
        });
      } catch (seedErr) {
        console.warn('Could not seed defaults, returning memory list:', seedErr?.message);
        return res.status(200).json({
          success: true,
          services: DEFAULT_ADDITIONAL_SERVICES,
        });
      }
    }

    return res.status(200).json({
      success: true,
      services,
    });
  } catch (error) {
    console.error('getAdditionalServices error:', error);
    // Return fallback memory defaults so client never breaks
    return res.status(200).json({
      success: true,
      services: DEFAULT_ADDITIONAL_SERVICES,
    });
  }
};

/**
 * POST /additional-services — create an additional service
 */
export const createAdditionalService = async (req, res) => {
  try {
    const { title, name, amount, price, unit, priceLabel, icon, spaceType, key } =
      req.body;

    const itemTitle = (title || name || '').trim();
    if (!itemTitle) {
      return res.status(400).json({
        success: false,
        message: 'Title is required',
      });
    }

    const numAmount = Number(amount ?? price ?? 0);
    const itemUnit = (unit || 'per month').trim();
    const formattedPriceLabel =
      priceLabel || `₹${numAmount.toLocaleString('en-IN')} / ${itemUnit}`;
    const itemKey =
      key ||
      itemTitle.toLowerCase().replace(/[^a-z0-9]/g, '') +
        '_' +
        Date.now().toString().slice(-4);

    const doc = await AdditionalService.create({
      title: itemTitle,
      amount: numAmount,
      unit: itemUnit,
      priceLabel: formattedPriceLabel,
      icon: icon || 'Car',
      spaceType: spaceType || 'all',
      key: itemKey,
      isActive: true,
    });

    return res.status(201).json({
      success: true,
      message: 'Additional service created successfully',
      service: doc,
    });
  } catch (error) {
    console.error('createAdditionalService error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to create additional service',
    });
  }
};

/**
 * PUT/PATCH /additional-services/:id — update an additional service
 */
export const updateAdditionalService = async (req, res) => {
  try {
    const { id } = req.params;
    const { title, name, amount, price, unit, priceLabel, icon, spaceType, key } =
      req.body;

    const updateData = {};
    if (title || name) updateData.title = (title || name).trim();
    if (amount !== undefined || price !== undefined) {
      updateData.amount = Number(amount ?? price ?? 0);
    }
    if (unit) updateData.unit = unit.trim();
    if (icon) updateData.icon = icon.trim();
    if (spaceType) updateData.spaceType = spaceType;
    if (key) updateData.key = key;

    const currentAmount =
      updateData.amount !== undefined ? updateData.amount : undefined;
    const currentUnit = updateData.unit || undefined;

    if (priceLabel) {
      updateData.priceLabel = priceLabel;
    } else if (currentAmount !== undefined || currentUnit !== undefined) {
      const existing = await AdditionalService.findById(id).lean();
      const finalAmount = currentAmount ?? existing?.amount ?? 0;
      const finalUnit = currentUnit || existing?.unit || 'per month';
      updateData.priceLabel = `₹${finalAmount.toLocaleString('en-IN')} / ${finalUnit}`;
    }

    const updated = await AdditionalService.findByIdAndUpdate(id, updateData, {
      new: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: 'Additional service not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Additional service updated successfully',
      service: updated,
    });
  } catch (error) {
    console.error('updateAdditionalService error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to update additional service',
    });
  }
};

/**
 * DELETE /additional-services/:id — delete an additional service
 */
export const deleteAdditionalService = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await AdditionalService.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Additional service not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Additional service deleted successfully',
    });
  } catch (error) {
    console.error('deleteAdditionalService error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to delete additional service',
    });
  }
};
