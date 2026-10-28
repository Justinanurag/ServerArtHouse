import User from '../models/auth.model.js';
import Commission from '../models/commission.model.js';
import Subscription from '../models/subscription.model.js';

function resolvePaymentMode(doc) {
  if (doc?.mode) return String(doc.mode).trim() || 'Cash';
  const pb = doc?.paymentBreakdown || {};
  const channels = [
    ['Cash', pb.cash],
    ['UPI', pb.upi],
    ['Card', pb.card],
    ['Wallet', pb.wallet],
  ];
  const hit = channels.find(([, amt]) => Number(amt) > 0);
  return hit?.[0] || '—';
}

function mapCommissionStatus(paymentStatus, subscriptionStatus) {
  const ps = String(paymentStatus || '').toLowerCase();
  if (ps === 'full') return 'Credited';
  if (ps === 'partial' || ps === 'due') return 'Pending';
  const st = String(subscriptionStatus || '').toLowerCase();
  if (st === 'active' || st === 'completed') return 'Credited';
  return 'Pending';
}

function saleAmount(doc) {
  const lines = Array.isArray(doc?.items) ? doc.items : [];
  const fromLines = lines.reduce((sum, line) => {
    const lineTotal = Number(line.lineTotal);
    if (Number.isFinite(lineTotal)) return sum + lineTotal;
    const qty = Number(line.qty) || 0;
    const price = Number(line.unitPrice) || 0;
    const discount = Number(line.discount) || 0;
    return sum + Math.max(0, qty * price - discount);
  }, 0);
  if (fromLines > 0) return fromLines;
  return Math.max(0, Number(doc?.grandTotal) || 0);
}

function normKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

/** Match Commission.membershipType (planId) to a subscription sale. */
function findCommissionRule(rulesByType, sub) {
  const keys = [sub.membershipType, sub.membershipPlanId]
    .map(normKey)
    .filter(Boolean);

  for (const key of keys) {
    if (rulesByType.has(key)) return rulesByType.get(key);
  }
  return null;
}

function calcStaffCommission(rule, amount) {
  if (!rule) {
    return {rate: 0, commissionAmount: 0, commissionType: null};
  }
  const value = Number(rule.commissionValue) || 0;
  if (rule.commissionType === 'flat') {
    return {
      rate: value,
      commissionAmount: Number(value.toFixed(2)),
      commissionType: 'flat',
    };
  }
  return {
    rate: value,
    commissionAmount: Number(((amount * value) / 100).toFixed(2)),
    commissionType: 'percentage',
  };
}

/**
 * Staff who sold subscriptions only.
 * Commission from active rules in Commission collection (GET /api/commission/get).
 */
export const getCommissionList = async (req, res) => {
  try {
    const {fromDate, toDate} = req.query;

    const dateMatch = {};
    if (fromDate || toDate) {
      dateMatch.invoiceDate = {};
      if (fromDate) dateMatch.invoiceDate.$gte = new Date(fromDate);
      if (toDate) {
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);
        dateMatch.invoiceDate.$lte = end;
      }
    }

    // 1) Active commission rules (same source as GET /api/commission/get)
    const rules = await Commission.find({isActive: {$ne: false}}).lean();
    const rulesByType = new Map();
    for (const rule of rules) {
      const key = normKey(rule.membershipType);
      if (!key) continue;
      rulesByType.set(key, rule);
    }

    // 2) Subscription sales only
    const subscriptions = await Subscription.find({
      ...dateMatch,
      status: {$in: ['active', 'completed']},
    })
      .sort({invoiceDate: -1, createdAt: -1})
      .select(
        'subscriptionCode invoiceDate createdAt customerName customerPhone membershipType membershipPlanId grandTotal items salesPersonName status mode paymentStatus paymentBreakdown createdBy',
      )
      .lean();

    if (!subscriptions.length) {
      return res.status(200).json({success: true, count: 0, data: []});
    }

    // 3) Resolve staff from salesPersonName (PIN name) + createdBy
    const sellerNames = [
      ...new Set(
        subscriptions
          .map(s => String(s.salesPersonName || '').trim())
          .filter(Boolean),
      ),
    ];

    const createdByIds = [
      ...new Set(
        subscriptions
          .map(s => String(s.createdBy?.m_staff_id || '').trim())
          .filter(Boolean),
      ),
    ];

    const orFilters = [];
    if (sellerNames.length) {
      orFilters.push({
        fullName: {
          $in: sellerNames.map(
            n =>
              new RegExp(
                `^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
                'i',
              ),
          ),
        },
      });
    }
    if (createdByIds.length) {
      orFilters.push({m_staff_id: {$in: createdByIds}});
      const objectIds = createdByIds.filter(id => /^[a-f\d]{24}$/i.test(id));
      if (objectIds.length) {
        orFilters.push({_id: {$in: objectIds}});
      }
    }

    const staffUsers = orFilters.length
      ? await User.find({$or: orFilters})
          .populate('roleId', 'name')
          .select('fullName phoneNumber email roleId m_staff_id')
          .lean()
      : [];

    const staffByName = new Map(
      staffUsers.map(u => [normKey(u.fullName), u]),
    );
    const staffByStaffId = new Map(
      staffUsers.map(u => [String(u.m_staff_id || ''), u]),
    );
    const staffByOid = new Map(staffUsers.map(u => [String(u._id), u]));

    const resolveStaff = sub => {
      const byName = staffByName.get(normKey(sub.salesPersonName));
      if (byName) return byName;
      const cid = String(sub.createdBy?.m_staff_id || '').trim();
      if (cid && staffByStaffId.get(cid)) return staffByStaffId.get(cid);
      if (cid && staffByOid.get(cid)) return staffByOid.get(cid);
      return null;
    };

    const grouped = new Map();

    for (const sub of subscriptions) {
      const user = resolveStaff(sub);
      if (!user) continue;

      const sid = String(user._id);
      if (!grouped.has(sid)) {
        grouped.set(sid, {user, invoices: []});
      }

      const amount = saleAmount(sub);
      if (amount <= 0) continue;

      const rule = findCommissionRule(rulesByType, sub);
      // Only count sales that match a /get commission rule for that membership
      if (!rule) continue;

      const {rate, commissionAmount, commissionType} = calcStaffCommission(
        rule,
        amount,
      );

      const planLabel =
        sub.membershipType ||
        sub.membershipPlanId ||
        sub.items?.[0]?.productName ||
        'Membership';

      grouped.get(sid).invoices.push({
        id: String(sub._id),
        invoiceCode: sub.subscriptionCode,
        rawDate: sub.invoiceDate || sub.createdAt || null,
        date: sub.invoiceDate
          ? new Date(sub.invoiceDate).toLocaleString('en-IN', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            })
          : '',
        customerName: sub.customerName || '',
        customerPhone: sub.customerPhone || '',
        category: planLabel,
        membershipType: normKey(sub.membershipType || sub.membershipPlanId),
        invoiceAmount: Number(amount.toFixed(2)),
        commissionRate: rate,
        commissionType: commissionType || rule.commissionType,
        commissionAmount,
        paymentMode: resolvePaymentMode(sub),
        status: mapCommissionStatus(sub.paymentStatus, sub.status),
      });
    }

    const data = [...grouped.values()]
      .map(({user, invoices: invs}) => {
        if (!invs.length) return null;
        // Sort newest commission gained first
        invs.sort((a, b) => {
          const timeA = a.rawDate ? new Date(a.rawDate).getTime() : 0;
          const timeB = b.rawDate ? new Date(b.rawDate).getTime() : 0;
          return timeB - timeA;
        });
        const totalSales = invs.reduce((s, i) => s + i.invoiceAmount, 0);
        const commission = invs.reduce((s, i) => s + i.commissionAmount, 0);
        const rateSample = invs[0]?.commissionRate ?? 0;

        return {
          id: String(user._id),
          staffName: user.fullName,
          role: user.roleId?.name || 'Staff',
          phone: user.phoneNumber || '',
          email: user.email || '',
          totalOrders: invs.length,
          totalSales: Number(totalSales.toFixed(2)),
          rate: rateSample,
          commission: Number(commission.toFixed(2)),
          invoices: invs,
        };
      })
      .filter(Boolean);

    data.sort((a, b) => b.commission - a.commission);

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error('getCommissionList error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch staff commission',
    });
  }
};

export const postCommission = async (req, res) => {
  try {
    const {membershipType, commissionType, commissionValue} = req.body;
    if (
      membershipType == null ||
      membershipType === '' ||
      !commissionType ||
      commissionValue === undefined ||
      commissionValue === null ||
      commissionValue === ''
    ) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required',
      });
    }
    if (!['flat', 'percentage'].includes(commissionType)) {
      return res.status(400).json({
        success: false,
        message: 'commissionType must be either flat or percentage',
      });
    }
    if (commissionType === 'percentage' && Number(commissionValue) > 100) {
      return res.status(400).json({
        success: false,
        message: 'Percentage commission cannot be greater than 100',
      });
    }
    const commission = await Commission.create({
      membershipType: String(membershipType).trim().toLowerCase(),
      commissionType,
      commissionValue: Number(commissionValue),
    });
    return res.status(200).json({
      success: true,
      message: 'Commission created successfully',
      commission,
    });
  } catch (error) {
    console.error('postCommission error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create commission',
    });
  }
};

export const getCommission = async (req, res) => {
  try {
    const commission = await Commission.find().sort({createdAt: -1}).lean();
    return res.status(200).json({
      success: true,
      message: 'Commission fetched successfully',
      commission,
    });
  } catch (error) {
    console.error('getCommission error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch commission',
    });
  }
};

export const deleteCommission = async (req, res) => {
  try {
    const commission = await Commission.findByIdAndDelete(req.body.id);
    return res.status(200).json({
      success: true,
      message: 'Commission deleted successfully',
      commission,
    });
  } catch (error) {
    console.error('deleteCommission error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete commission',
    });
  }
};

export const updateCommission = async (req, res) => {
  try {
    const {membershipType, commissionType, commissionValue} = req.body;

    if (
      membershipType == null ||
      membershipType === '' ||
      !commissionType ||
      commissionValue === undefined ||
      commissionValue === null ||
      commissionValue === ''
    ) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required',
      });
    }
    if (!['flat', 'percentage'].includes(commissionType)) {
      return res.status(400).json({
        success: false,
        message: 'commissionType must be either flat or percentage',
      });
    }
    if (commissionType === 'percentage' && Number(commissionValue) > 100) {
      return res.status(400).json({
        success: false,
        message: 'Percentage commission cannot be greater than 100',
      });
    }

    const commission = await Commission.findByIdAndUpdate(
      req.body.id,
      {
        ...req.body,
        membershipType: String(membershipType).trim().toLowerCase(),
        commissionValue: Number(commissionValue),
      },
      {new: true},
    );
    return res.status(200).json({
      success: true,
      message: 'Commission updated successfully',
      commission,
    });
  } catch (error) {
    console.error('updateCommission error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update commission',
    });
  }
};
