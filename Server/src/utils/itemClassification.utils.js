/**
 * Canonical invoice / membership line types.
 * Catalogue subcategory (Snacks, Studio, Electronics) is NOT a line type.
 */
export const LINE_TYPES = Object.freeze({
  PRODUCT: 'product',
  SERVICE: 'service',
  SPACE: 'space',
  FOOD: 'food',
});

export const MEMBERSHIP_BUCKETS = Object.freeze({
  product: 'Products',
  service: 'Services',
  space: 'Space',
  food: 'Food',
});

/** A membership plan purchase is not an eligible product, service, space, or food line. */
export function isMembershipPurchaseLine(category) {
  const lower = String(category ?? '')
    .trim()
    .toLowerCase();
  return (
    lower === 'membership' ||
    lower === 'subscription' ||
    lower === 'membership subscription'
  );
}

/** Normalize any raw category / sourceType / lineCategory to a line type. */
export function normalizeLineType(raw) {
  const lower = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!lower) return LINE_TYPES.PRODUCT;

  if (lower === 'food' || lower === 'foods') return LINE_TYPES.FOOD;
  if (lower === 'space' || lower === 'spaces') return LINE_TYPES.SPACE;
  if (lower === 'service' || lower === 'services') return LINE_TYPES.SERVICE;
  if (
    lower === 'product' ||
    lower === 'products' ||
    lower === 'general' ||
    lower === 'store'
  ) {
    return LINE_TYPES.PRODUCT;
  }

  // Catalogue subcategories (Snacks, Studio, Electronics, …) are NOT line types.
  // Default to product so they never receive Space/Services/Food membership discounts.
  return LINE_TYPES.PRODUCT;
}

export function membershipBucketForLineType(lineType) {
  const t = normalizeLineType(lineType);
  return MEMBERSHIP_BUCKETS[t] || MEMBERSHIP_BUCKETS.product;
}

/** True only when discount bucket matches the line's own category. */
export function discountAllowedForLine(lineCategory, discountBucket) {
  const lineBucket = membershipBucketForLineType(lineCategory);
  const want = String(discountBucket || '')
    .trim()
    .toLowerCase();
  return lineBucket.toLowerCase() === want;
}
