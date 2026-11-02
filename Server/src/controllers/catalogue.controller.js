import Product from '../models/product.model.js';
import Space from '../models/space.model.js';
import Food from '../models/food.model.js';
import {computeStockByProductNames, getProductStockNames} from '../utils/inventoryStock.utils.js';

const escapeRegex = (value) =>
  String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Natural sort for variant labels (10, 12X24, 12X36, …). */
const naturalCompare = (a, b) =>
  String(a ?? '').localeCompare(String(b ?? ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });

/** Parse size labels like "3 × 3", "12X12", "12 x 24" for ascending dimension order. */
const parseVariantDimensions = (label) => {
  const s = String(label ?? '').trim();
  const m = s.match(/(\d+(?:\.\d+)?)\s*[x×X*]\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
};

const compareVariantNames = (a, b) => {
  const da = parseVariantDimensions(a);
  const db = parseVariantDimensions(b);
  if (da && db) {
    if (da[0] !== db[0]) return da[0] - db[0];
    if (da[1] !== db[1]) return da[1] - db[1];
  }
  return naturalCompare(a, b);
};

const sortVariantDocs = (variants = []) =>
  [...variants].sort((a, b) =>
    compareVariantNames(String(a?.name ?? ''), String(b?.name ?? '')),
  );

const getProductGroupKey = (row) => {
  const parent = String(row?.parentProductName ?? '').trim();
  if (parent) return parent.toLowerCase();

  const name = String(row?.productName || row?.name || '').trim();
  const variant = String(row?.variantName ?? '').trim();
  if (variant && name.toLowerCase().endsWith(` - ${variant.toLowerCase()}`)) {
    return name.slice(0, -(variant.length + 3)).trim().toLowerCase();
  }
  return name.toLowerCase();
};

/** Group product variants under parent; sort variant rows naturally within each group. */
const sortCatalogueItems = (rows = []) =>
  [...rows].sort((a, b) => {
    const aIsProduct = String(a?.sourceType || '') === 'product';
    const bIsProduct = String(b?.sourceType || '') === 'product';

    if (aIsProduct && bIsProduct) {
      const groupCmp = naturalCompare(
        getProductGroupKey(a),
        getProductGroupKey(b),
      );
      if (groupCmp !== 0) return groupCmp;

      const vA = String(a?.variantName ?? '').trim();
      const vB = String(b?.variantName ?? '').trim();
      if (!vA && vB) return -1;
      if (vA && !vB) return 1;
      if (vA && vB) return compareVariantNames(vA, vB);
      return naturalCompare(a?.name, b?.name);
    }

    return naturalCompare(
      String(a?.productName || a?.name || ''),
      String(b?.productName || b?.name || ''),
    );
  });

const variantMatchesSearch = (variant, searchRegex) => {
  if (!searchRegex) return true;
  const name = String(variant?.name ?? '');
  const barcode = String(variant?.barcode ?? '');
  return searchRegex.test(name) || searchRegex.test(barcode);
};

const parentMatchesSearch = (product, searchRegex) => {
  if (!searchRegex) return true;
  return (
    searchRegex.test(String(product.productName ?? '')) ||
    searchRegex.test(String(product.serviceName ?? '')) ||
    searchRegex.test(String(product.itemCode ?? '')) ||
    searchRegex.test(String(product.barCode ?? ''))
  );
};

/**
 * Expand a product into catalogue rows.
 * Products WITH variants → only variant rows as "Parent - Variant".
 * Products WITHOUT variants → single parent row.
 * Never emit both a parent row and variant rows for the same product.
 * stockByName: Map of line name → live stock (parent and each "Parent - Variant").
 */
const expandProductCatalogueRows = (product, searchRegex, stockByName) => {
  const parentName = String(product.productName ?? '').trim();
  const rawVariants = Array.isArray(product.variants) ? product.variants : [];
  const variants = sortVariantDocs(
    rawVariants.filter((v) => String(v?.name ?? '').trim()),
  );
  const isCsp = Boolean(product.isCsp);
  const parentHit = parentMatchesSearch(product, searchRegex);
  const rows = [];

  const stockFor = (lineName) => {
    if (!stockByName) return 0;
    const exact = stockByName.get(lineName);
    if (exact != null) return Number(exact) || 0;
    const lower = stockByName.get(String(lineName).toLowerCase());
    return Number(lower) || 0;
  };

  const base = {
    sourceId: product._id,
    sourceType: 'product',
    parentProductName: parentName,
    trackStock: true,
    category: product.category || 'General',
    lineCategory: 'product',
    imageUrl: product.imageUrl || product.images?.[0] || null,
    unit: product.primaryUnit || '',
    discountType: product.discountType || 'flat',
    discountValue: Number(product.discountValue ?? 0),
    isCsp,
    cspLabel: isCsp ? 'CSP' : null,
  };

  const pushParent = () => {
    rows.push({
      ...base,
      _id: String(product._id),
      name: parentName,
      productName: parentName,
      variantName: null,
      stockQty: stockFor(parentName),
      sellingPrice: Number(product.sellingPrice ?? 0),
      purchasePrice: Number(product.purchasePrice ?? 0),
    });
  };

  const pushVariant = (variant) => {
    const variantName = String(variant?.name ?? '').trim();
    if (!variantName) return;
    const displayName = `${parentName} - ${variantName}`;
    rows.push({
      ...base,
      _id: `${String(product._id)}::${variantName}`,
      name: displayName,
      productName: displayName,
      variantName,
      stockQty: stockFor(displayName),
      sellingPrice: Number(variant.sellingPrice ?? product.sellingPrice ?? 0),
      purchasePrice: Number(variant.purchasePrice ?? product.purchasePrice ?? 0),
      barcode: String(variant.barcode ?? ''),
    });
  };

  // Named variants exist → only variant rows (never also emit empty parent)
  if (variants.length > 0) {
    if (!searchRegex || parentHit) {
      variants.forEach(pushVariant);
      return rows;
    }
    variants.filter((v) => variantMatchesSearch(v, searchRegex)).forEach(pushVariant);
    return rows;
  }

  // No named variants → single parent row
  if (!searchRegex || parentHit) pushParent();
  return rows;
};

/**
 * Collect canonical parent product names that have at least one variant row.
 */
const parentNamesWithVariants = (rows = []) => {
  const parents = new Set();
  for (const row of rows) {
    if (String(row?.sourceType || '') !== 'product') continue;
    const variantName = String(row?.variantName ?? '').trim();
    if (!variantName) continue;

    let parent = String(row.parentProductName ?? '').trim();
    if (!parent) {
      const full = String(row.productName || row.name || '').trim();
      const sep = ` - ${variantName}`;
      parent = full.endsWith(sep)
        ? full.slice(0, -sep.length).trim()
        : full;
    }
    // Also strip accidental "Parent - Variant" stored in parentProductName
    const sep = ` - ${variantName}`;
    if (parent.endsWith(sep)) {
      parent = parent.slice(0, -sep.length).trim();
    }
    if (parent) parents.add(parent.toLowerCase());
  }
  return parents;
};

/**
 * If any variant exists for a product name, hide the empty parent row.
 * Also hides same-named service/space/food tiles that collide with that parent.
 */
const dedupeParentRowsWhenVariantsExist = (rows = []) => {
  const parentsWithVariants = parentNamesWithVariants(rows);
  if (!parentsWithVariants.size) return rows;

  return rows.filter((row) => {
    const variantName = String(row?.variantName ?? '').trim();
    // Always keep real variant product rows
    if (String(row?.sourceType || '') === 'product' && variantName) {
      return true;
    }

    // Non-variant row (parent product, or service/space/food with same label)
    const displayName = String(
      row?.parentProductName || row?.productName || row?.name || '',
    )
      .trim()
      .toLowerCase();

    // If this exact name is a parent that has variants → hide empty parent / twin
    if (displayName && parentsWithVariants.has(displayName)) {
      return false;
    }
    return true;
  });
};

/**
 * If the same catalogue label exists as product and service, keep product only.
 * Prevents "Masking Tape" showing twice (PRODUCT + SERVICE) when DB has twin rows.
 */
const dedupeServiceWhenProductExists = (rows = []) => {
  const productNames = new Set(
    rows
      .filter((row) => String(row?.sourceType || '') === 'product')
      .map((row) =>
        String(row?.productName || row?.name || '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );

  if (!productNames.size) return rows;

  return rows.filter((row) => {
    if (String(row?.sourceType || '') !== 'service') return true;
    const name = String(row?.productName || row?.name || '')
      .trim()
      .toLowerCase();
    return !name || !productNames.has(name);
  });
};

const mapService = (service) => {
  const name = String(service.serviceName || service.productName || '').trim();
  return {
    _id: service._id,
    sourceId: service._id,
    sourceType: 'service',
    name,
    productName: name,
    sellingPrice: Number(service.sellingPrice ?? 0),
    purchasePrice: Number(service.purchasePrice ?? service.sellingPrice ?? 0),
    stockQty: null,
    trackStock: false,
    category: service.category || 'Services',
    lineCategory: 'service',
    imageUrl: service.imageUrl || service.images?.[0] || null,
    unit: service.primaryUnit || '',
    discountType: service.discountType || 'flat',
    discountValue: Number(service.discountValue ?? 0),
  };
};

const mapSpace = (space) => {
  const dayRaw = String(space.day || '').trim().toLowerCase();
  const day =
    dayRaw === 'weekend'
      ? 'Weekend'
      : dayRaw === 'weekday'
        ? 'Weekday'
        : null;

  // Legacy dual-price docs without day: keep both prices for POS day-of-week pick
  const legacyWeekday = Number(space.weekdayPrice ?? space.price ?? 0) || 0;
  const legacyWeekend = Number(space.weekendPrice ?? space.price ?? 0) || 0;
  const storedPrice = Number(space.price ?? 0) || 0;

  let sellingPrice = storedPrice;
  if (!day && (space.weekdayPrice != null || space.weekendPrice != null)) {
    const jsDay = new Date().getDay();
    sellingPrice = jsDay === 0 || jsDay === 6 ? legacyWeekend : legacyWeekday;
  }

  return {
    _id: space._id,
    sourceId: space._id,
    sourceType: 'space',
    name: String(space.name ?? '').trim(),
    productName: String(space.name ?? '').trim(),
    sellingPrice,
    price: storedPrice,
    day: day || undefined,
    weekdayPrice: day ? (day === 'Weekday' ? storedPrice : legacyWeekday) : legacyWeekday,
    weekendPrice: day ? (day === 'Weekend' ? storedPrice : legacyWeekend) : legacyWeekend,
    stockQty: null,
    trackStock: false,
    category: space.category || 'Space',
    lineCategory: 'space',
    imageUrl: space.imageUrl || null,
    unit: 'Hour',
    status: space.status,
    capacity: space.capacity,
    discountType: 'flat',
    discountValue: 0,
  };
};

const mapFood = (food) => ({
  _id: food._id,
  sourceId: food._id,
  sourceType: 'food',
  name: String(food.name ?? '').trim(),
  productName: String(food.name ?? '').trim(),
  sellingPrice: Number(food.price ?? 0),
  stockQty: null,
  trackStock: false,
  category: food.category || 'Food',
  lineCategory: 'food',
  imageUrl: food.imageUrl || null,
  unit: food.unit || 'Plate',
  isVeg: food.isVeg !== false,
  status: food.status || 'Active',
  discountType: 'flat',
  discountValue: 0,
});

/** Expand + dedupe + sort catalogue rows from fetched entity docs. */
const buildSortedCatalogueItems = ({
  productDocs,
  serviceDocs,
  spaceDocs,
  foodDocs,
  searchRegex,
  stockMap,
}) => {
  const products = productDocs.flatMap((product) =>
    expandProductCatalogueRows(product, searchRegex, stockMap),
  );
  const services = serviceDocs.map(mapService);
  const spaces = spaceDocs.map(mapSpace);
  const foods = foodDocs.map(mapFood);

  return sortCatalogueItems(
    dedupeServiceWhenProductExists(
      dedupeParentRowsWhenVariantsExist([
        ...products,
        ...services,
        ...spaces,
        ...foods,
      ]),
    ),
  );
};

/**
 * Unified catalogue lookup across products, services, spaces, and foods.
 * GET /catalogue/lookup?search=&limit=&page=&sourceType=
 *
 * Paginate parent products (variants expand after). Default page size 48.
 */
export const lookupCatalogueItems = async (req, res) => {
  try {
    const search = String(req.query.search ?? '').trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 48, 1), 100);
    const skip = (page - 1) * limit;
    const sourceType = String(req.query.sourceType || 'all')
      .trim()
      .toLowerCase();
    const searchRegex = search ? new RegExp(escapeRegex(search), 'i') : null;

    const textSearch = searchRegex
      ? {
          $or: [
            {productName: searchRegex},
            {serviceName: searchRegex},
            {itemCode: searchRegex},
            {barCode: searchRegex},
            {'variants.name': searchRegex},
            {'variants.barcode': searchRegex},
          ],
        }
      : null;

    const productFilter = {
      type: {$ne: 'service'},
      itemType: {$ne: 'service'},
      ...(textSearch || {}),
    };

    const serviceFilter = {
      $or: [{type: 'service'}, {itemType: 'service'}],
      ...(textSearch || {}),
    };

    const spaceFilter = searchRegex
      ? {
          $or: [
            {name: searchRegex},
            {category: searchRegex},
            {description: searchRegex},
          ],
        }
      : {};

    const foodFilter = {
      status: {$ne: 'Inactive'},
      ...(searchRegex
        ? {
            $or: [
              {name: searchRegex},
              {category: searchRegex},
              {description: searchRegex},
            ],
          }
        : {}),
    };

    const wantProducts = sourceType === 'all' || sourceType === 'product';
    const wantServices = sourceType === 'all' || sourceType === 'service';
    const wantSpaces = sourceType === 'all' || sourceType === 'space';
    const wantFoods = sourceType === 'all' || sourceType === 'food';

    // Search matches are expanded to variant rows — paginate rows, not parent products.
    const useRowPagination = Boolean(searchRegex);

    // For "all", only page products when browsing; include aux types on page 1 only.
    // When searching, merge all matching types then slice the flat sorted row list.
    const includeAuxOnThisPage =
      useRowPagination || sourceType !== 'all' || page === 1;
    const auxLimit = sourceType === 'all' ? Math.min(limit, 24) : limit;
    const auxSkip = sourceType === 'all' ? 0 : skip;

    const tasks = [];

    if (wantProducts) {
      tasks.push(
        Product.countDocuments(productFilter),
        useRowPagination
          ? Product.find(productFilter).sort({productName: 1, _id: 1}).lean()
          : Product.find(productFilter)
              .sort({createdAt: -1})
              .skip(skip)
              .limit(limit)
              .lean(),
      );
    } else {
      tasks.push(Promise.resolve(0), Promise.resolve([]));
    }

    if (wantServices && includeAuxOnThisPage) {
      tasks.push(
        Product.countDocuments(serviceFilter),
        useRowPagination
          ? Product.find(serviceFilter).sort({productName: 1, _id: 1}).lean()
          : Product.find(serviceFilter)
              .sort({createdAt: -1})
              .skip(auxSkip)
              .limit(auxLimit)
              .lean(),
      );
    } else {
      tasks.push(Promise.resolve(0), Promise.resolve([]));
    }

    if (wantSpaces && includeAuxOnThisPage) {
      tasks.push(
        Space.countDocuments(spaceFilter),
        useRowPagination
          ? Space.find(spaceFilter).sort({name: 1, _id: 1}).lean()
          : Space.find(spaceFilter)
              .sort({createdAt: -1})
              .skip(auxSkip)
              .limit(auxLimit)
              .lean(),
      );
    } else {
      tasks.push(Promise.resolve(0), Promise.resolve([]));
    }

    if (wantFoods && includeAuxOnThisPage) {
      tasks.push(
        Food.countDocuments(foodFilter),
        useRowPagination
          ? Food.find(foodFilter).sort({name: 1, _id: 1}).lean()
          : Food.find(foodFilter)
              .sort({createdAt: -1})
              .skip(auxSkip)
              .limit(auxLimit)
              .lean(),
      );
    } else {
      tasks.push(Promise.resolve(0), Promise.resolve([]));
    }

    const [
      productTotal,
      productDocs,
      serviceTotal,
      serviceDocs,
      spaceTotal,
      spaceDocs,
      foodTotal,
      foodDocs,
    ] = await Promise.all(tasks);

    const productNames = [
      ...new Set(productDocs.flatMap((p) => getProductStockNames(p))),
    ];
    const stockMap =
      productNames.length > 0
        ? await computeStockByProductNames({names: productNames})
        : new Map();

    const allItems = buildSortedCatalogueItems({
      productDocs,
      serviceDocs,
      spaceDocs,
      foodDocs,
      searchRegex,
      stockMap,
    });

    const items = useRowPagination
      ? allItems.slice(skip, skip + limit)
      : allItems;

    const productCount = items.filter((i) => i.sourceType === 'product').length;
    const serviceCount = items.filter((i) => i.sourceType === 'service').length;
    const spaceCount = items.filter((i) => i.sourceType === 'space').length;
    const foodCount = items.filter((i) => i.sourceType === 'food').length;

    // hasMore tracks the primary paginated collection for the active tab.
    let primaryTotal = productTotal;
    if (sourceType === 'service') primaryTotal = serviceTotal;
    else if (sourceType === 'space') primaryTotal = spaceTotal;
    else if (sourceType === 'food') primaryTotal = foodTotal;
    else if (sourceType === 'all') primaryTotal = productTotal;

    const hasMore = useRowPagination
      ? skip + limit < allItems.length
      : skip + limit < primaryTotal;

    return res.status(200).json({
      success: true,
      message: 'Catalogue lookup successful.',
      items,
      counts: {
        product: productCount,
        service: serviceCount,
        space: spaceCount,
        food: foodCount,
        total: items.length,
      },
      pagination: {
        page,
        limit,
        skip,
        hasMore,
        total: useRowPagination ? allItems.length : primaryTotal,
        sourceType,
      },
    });
  } catch (error) {
    console.error('lookupCatalogueItems error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to lookup catalogue items.',
    });
  }
};
