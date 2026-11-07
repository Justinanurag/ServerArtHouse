export const offerMoney = (value) =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const activeRule = (rule) => String(rule?.status || "active").toLowerCase() !== "inactive";

export const validateOfferRules = (rules) => {
  if (!Array.isArray(rules) || rules.length === 0) {
    return "Add at least one offer rule.";
  }
  const seen = new Set();
  for (const rule of rules) {
    const minimumHours = offerMoney(rule?.minimumHours);
    const freeHours = offerMoney(rule?.freeHours);
    if (!(minimumHours > 0)) return "Minimum booking hours must be greater than zero.";
    if (!(freeHours > 0)) return "Free hours must be greater than zero.";
    if (!(freeHours < minimumHours)) {
      return "Free hours must be less than the minimum booking hours.";
    }
    const key = minimumHours.toFixed(2);
    if (seen.has(key)) return "Each minimum-hour threshold can be used only once in an offer.";
    seen.add(key);
  }
  return "";
};

export const normalizeOfferRules = (rules) =>
  rules.map((rule) => ({
    minimumHours: offerMoney(rule.minimumHours),
    freeHours: offerMoney(rule.freeHours),
    priority: Number.isFinite(Number(rule.priority)) ? Number(rule.priority) : 0,
    status: String(rule.status || "active").toLowerCase() === "inactive" ? "inactive" : "active",
  }));

/** Highest qualifying minimum duration wins. Ties use rule priority, then free hours. */
export const selectOfferRule = (rules, hours) => {
  const duration = offerMoney(hours);
  const matches = (Array.isArray(rules) ? rules : []).filter(
    (rule) => activeRule(rule) && duration + 0.0001 >= offerMoney(rule.minimumHours),
  );
  matches.sort((a, b) => {
    const threshold = offerMoney(b.minimumHours) - offerMoney(a.minimumHours);
    if (Math.abs(threshold) > 0.0001) return threshold;
    const priority = Number(b.priority || 0) - Number(a.priority || 0);
    if (priority) return priority;
    return offerMoney(b.freeHours) - offerMoney(a.freeHours);
  });
  return matches[0] || null;
};

const lineDiscount = (freeHours, line) => {
  const rate = Math.max(0, offerMoney(line?.hourlyRate));
  const qty = Math.max(1, Number(line?.qty) || 1);
  return offerMoney(freeHours * rate * qty);
};

/**
 * One offer only. Among active offers whose rules qualify, the largest
 * customer discount wins. Equal discounts use offer priority, then name.
 */
export const quoteBookingOffer = ({offers, hours, lines}) => {
  const duration = offerMoney(hours);
  const pricedLines = (Array.isArray(lines) ? lines : []).filter(
    (line) => offerMoney(line?.hourlyRate) >= 0,
  );
  const empty = {
    applied: false,
    offerId: "",
    offerName: "",
    minimumHours: 0,
    freeHours: 0,
    chargeableHours: duration,
    discount: 0,
    originalAmount: offerMoney(
      pricedLines.reduce((sum, line) => sum + lineDiscount(duration, line), 0),
    ),
    finalAmount: 0,
  };
  if (!(duration > 0) || !pricedLines.length) {
    empty.finalAmount = empty.originalAmount;
    return empty;
  }

  let best = null;
  for (const offer of offers || []) {
    if (String(offer?.status || "").toLowerCase() !== "active") continue;
    if (offer.offerType && offer.offerType !== "space_booking") continue;
    const rule = selectOfferRule(offer.rules, duration);
    if (!rule) continue;
    const freeHours = offerMoney(Math.min(duration, offerMoney(rule.freeHours)));
    const discount = offerMoney(
      pricedLines.reduce((sum, line) => sum + lineDiscount(freeHours, line), 0),
    );
    const candidate = {offer, rule, freeHours, discount};
    if (!best) {
      best = candidate;
      continue;
    }
    const betterDiscount = candidate.discount > best.discount + 0.009;
    const sameDiscount = Math.abs(candidate.discount - best.discount) <= 0.009;
    const betterPriority =
      sameDiscount && Number(candidate.offer.priority || 0) > Number(best.offer.priority || 0);
    const samePriority =
      sameDiscount && Number(candidate.offer.priority || 0) === Number(best.offer.priority || 0);
    const earlierName =
      samePriority &&
      String(candidate.offer.offerName || "").localeCompare(String(best.offer.offerName || "")) < 0;
    if (betterDiscount || betterPriority || earlierName) best = candidate;
  }

  const originalAmount = empty.originalAmount;
  if (!best) {
    empty.finalAmount = originalAmount;
    return empty;
  }
  const chargeableHours = offerMoney(Math.max(0, duration - best.freeHours));
  return {
    applied: true,
    offerId: String(best.offer._id || ""),
    offerName: best.offer.offerName || "",
    description: best.offer.description || "",
    minimumHours: offerMoney(best.rule.minimumHours),
    freeHours: best.freeHours,
    chargeableHours,
    discount: best.discount,
    originalAmount,
    finalAmount: offerMoney(Math.max(0, originalAmount - best.discount)),
  };
};
