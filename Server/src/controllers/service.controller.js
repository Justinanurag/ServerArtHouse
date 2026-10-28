import Product from '../models/product.model.js';
import {
  upload,
  createProduct,
  updateProduct,
  deleteProduct,
} from './product.controller.js';

export { upload };

const isServiceDoc = (doc) =>
  doc && (doc.type === 'service' || doc.itemType === 'service');

/**
 * GET /services — list only service-typed catalogue items.
 */
export const getServices = async (req, res) => {
  try {
    const { search } = req.query;
    const typeClause = {
      $or: [{ type: 'service' }, { itemType: 'service' }],
    };

    let query = typeClause;
    if (search) {
      const searchRegex = new RegExp(String(search).trim(), 'i');
      query = {
        $and: [
          typeClause,
          {
            $or: [
              { productName: searchRegex },
              { serviceName: searchRegex },
              { itemCode: searchRegex },
              { barCode: searchRegex },
              { category: searchRegex },
            ],
          },
        ],
      };
    }

    const services = await Product.find(query).sort({ createdAt: -1 }).limit(6000);
    const list = services.map((doc) => {
      const row = doc.toObject();
      return {
        ...row,
        stockQty: 0,
        stockStatus: 'in_stock',
      };
    });

    return res.status(200).json({
      success: true,
      services: list,
      products: list, // alias for shared FE helpers
    });
  } catch (error) {
    console.error('getServices error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch services',
    });
  }
};

/**
 * POST /services — create a service (forces type=service).
 */
export const createService = async (req, res) => {
  req.forceItemType = 'service';
  req.body = {
    ...(req.body || {}),
    type: 'service',
    serviceName: req.body?.serviceName || req.body?.productName || '',
    productName: req.body?.productName || req.body?.serviceName || '',
    stockQty: 0,
    isCsp: false,
  };
  return createProduct(req, res);
};

/**
 * PATCH /services/:id — update a service only.
 */
export const updateService = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await Product.findById(id).lean();
    if (!isServiceDoc(existing)) {
      return res.status(404).json({
        success: false,
        message: 'Service not found',
      });
    }

    req.forceItemType = 'service';
    req.body = {
      ...(req.body || {}),
      type: 'service',
      serviceName: req.body?.serviceName || req.body?.productName || existing.serviceName,
      stockQty: 0,
      isCsp: false,
    };
    return updateProduct(req, res);
  } catch (error) {
    console.error('updateService error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update service',
    });
  }
};

/**
 * DELETE /services/:id — delete a service only.
 */
export const deleteService = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await Product.findById(id).lean();
    if (!isServiceDoc(existing)) {
      return res.status(404).json({
        success: false,
        message: 'Service not found',
      });
    }
    return deleteProduct(req, res);
  } catch (error) {
    console.error('deleteService error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete service',
    });
  }
};
