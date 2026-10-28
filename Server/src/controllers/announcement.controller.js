import mongoose from 'mongoose';
import Announcement from '../models/announcement.model.js';
import Customer from '../models/customer.model.js';
import ExhibitionPass from '../models/exhibition.model.js';
import { enqueueAnnouncementRecipient } from '../queue/announcement.queue.js';
import {
  announcementRequiresImageHeader,
  normalizeWhatsAppTemplateName,
  resolveAnnouncementHeaderMedia,
} from '../modules/customer/services/whatsapp.service.js';

export const createAnnouncement = async (req, res) => {
  try {
    const {
      templateName,
      audienceType = 'All',
      selectedCustomerIds = [],
      selectedExhibitionPassIds = [],
      whatsappTemplateName,
      languageCode = 'en',
      templateParams = [],
      headerImageLink = '',
    } = req.body || {};

    if (!templateName?.trim() || !whatsappTemplateName?.trim()) {
      return res.status(400).json({
        success: false,
        message: 'templateName and whatsappTemplateName are required',
      });
    }

    // Never send display labels like "new cafe" to Meta — normalize to newcafe.
    const metaTemplate = normalizeWhatsAppTemplateName(whatsappTemplateName);
    const lang = String(languageCode || 'en').trim() || 'en';

    if (!/^[a-z0-9_]+$/.test(metaTemplate)) {
      return res.status(400).json({
        success: false,
        message:
          'Invalid WhatsApp template name. Use the exact Meta name (e.g. newcafe), lowercase with no spaces.',
      });
    }

    // Resolve IMAGE header once for the whole batch.
    // newcafe always uploads Client/src/assets/images/logo/newcafe.jpeg
    // (unless an explicit HTTPS headerImageLink is provided).
    let headerMedia;
    try {
      headerMedia = await resolveAnnouncementHeaderMedia({
        headerImageLink,
        templateName: metaTemplate,
        // Force the project asset for IMAGE templates so All/Selected both send newcafe.jpeg
        forceDefaultImage: !String(headerImageLink || '').trim(),
      });
    } catch (mediaErr) {
      return res.status(400).json({
        success: false,
        message: mediaErr?.message || 'Failed to resolve announcement header image',
      });
    }

    if (
      announcementRequiresImageHeader(metaTemplate) &&
      !headerMedia?.headerImageId &&
      !headerMedia?.headerImageLink
    ) {
      return res.status(400).json({
        success: false,
        message:
          'Failed to attach newcafe.jpeg IMAGE header. Check Client/src/assets/images/logo/newcafe.jpeg exists.',
      });
    }

    const requestedAudience = String(audienceType).toLowerCase();
    const normalizedAudience = ['selected', 'exhibition'].includes(requestedAudience)
      ? requestedAudience
      : 'all';

    const exhibitionPassIds =
      normalizedAudience === 'exhibition' && Array.isArray(selectedExhibitionPassIds)
        ? [...new Set(selectedExhibitionPassIds.map(String))].filter((id) =>
            mongoose.Types.ObjectId.isValid(id),
          )
        : [];

    let recipients = [];
    if (normalizedAudience === 'exhibition') {
      if (!exhibitionPassIds.length) {
        return res.status(400).json({
          success: false,
          message: 'Select at least one exhibition lead',
        });
      }
      const passes = await ExhibitionPass.find({
        _id: { $in: exhibitionPassIds },
        status: { $ne: 'Cancelled' },
      })
        .select('_id fullName phone')
        .lean();

      // A visitor can hold passes for several events — message each phone once.
      const byPhone = new Map();
      for (const pass of passes) {
        const phone = String(pass.phone || '').trim();
        if (phone && !byPhone.has(phone)) {
          byPhone.set(phone, {
            customerId: String(pass._id),
            name: pass.fullName,
            phone,
          });
        }
      }
      recipients = [...byPhone.values()];
    } else {
      const customers = await Customer.find(
        normalizedAudience === 'selected'
          ? { _id: { $in: selectedCustomerIds }, isDeleted: { $ne: true } }
          : { isDeleted: { $ne: true } },
      )
        .select('_id name mobile whatsappNumber')
        .lean();

      recipients = customers
        .map((c) => ({
          customerId: String(c._id),
          name: c.name,
          phone: String(c.whatsappNumber || c.mobile || '').trim(),
        }))
        .filter((r) => r.phone);
    }

    if (!recipients.length) {
      return res.status(400).json({
        success: false,
        message:
          normalizedAudience === 'exhibition'
            ? 'No active exhibition leads with phone number found!'
            : 'No customers with phone number  found!',
      });
    }

    const announcement = await Announcement.create({
      templateName: templateName.trim(),
      audienceType: normalizedAudience,
      selectedCustomerIds:
        normalizedAudience === 'selected' ? selectedCustomerIds : [],
      selectedExhibitionPassIds: exhibitionPassIds,
      whatsappMetaTemplateName: metaTemplate,
      languageCode: lang,
      templateParams,
      headerImageLink: headerMedia.headerImageLink || '',
      headerImageId: headerMedia.headerImageId || '',
      status: 'sending',
      totalRecipients: recipients.length,
      sentCount: 0,
      failedCount: 0,
      createdBNy: {
        m_staff_id: req.user?.userId ?? null,
        m_staff_name: req.user?.name ?? null,
        m_staff_email: req.user?.email ?? null,
      },
    });

    // Enqueue 1 job per recipient (Redis only — worker sends WhatsApp)
    await Promise.all(
      recipients.map((r) =>
        enqueueAnnouncementRecipient({
          announcementId: String(announcement._id),
          customerId: r.customerId,
          phone: r.phone,
          customerName: r.name,
          whatsappTemplateName: announcement.whatsappMetaTemplateName,
          languageCode: announcement.languageCode,
          templateParams: announcement.templateParams,
          headerImageLink: announcement.headerImageLink,
          headerImageId: announcement.headerImageId,
        }),
      ),
    );
    // 4) Return immediately — worker does the slow Meta calls
    return res.status(201).json({
      success: true,
      message: `Queued ${recipients.length} WhatsApp messages`,
      announcement,
    });
  } catch (error) {
    console.error('createAnnouncement error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create announcement',
    });
  }
};

/** Exhibition pass holders (non-cancelled) as an announcement audience. */
export const listExhibitionLeads = async (req, res) => {
  try {
    const leads = await ExhibitionPass.find({ status: { $ne: 'Cancelled' } })
      .select('_id fullName phone event status checkedInAt createdAt')
      .sort({ createdAt: -1 })
      .lean();
    return res.status(200).json({ success: true, leads });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load exhibition leads',
    });
  }
};

export const listAnnouncements = async (req, res) => {
  try {
    const announcements = await Announcement.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return res.status(200).json({ success: true, announcements });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to list announcements',
    });
  }
};
