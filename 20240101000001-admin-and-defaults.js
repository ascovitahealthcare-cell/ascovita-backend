'use strict';
/**
 * PRODUCT ROUTES
 * GET    /api/products               – public listing (active only)
 * GET    /api/products/:id           – single product
 * POST   /api/products               – admin create
 * PUT    /api/products/:id           – admin update
 * DELETE /api/products/:id           – admin SOFT-delete
 * PUT    /api/products/:id/restore   – admin restore
 */
const router = require('express').Router();
const { Op }  = require('sequelize');
const { Product, ProductImage, ProductVariant, Category, Review, sequelize } = require('../models');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

// Slugify helper
function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── PUBLIC: list active products ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { category, search, sort = 'sort_order', limit = 100, offset = 0 } = req.query;
    const where = { is_active: true };
    if (category) where.category_id = category;
    if (search)   where.name = { [Op.iLike]: `%${search}%` };

    const order = sort === 'price_asc'  ? [['sale_price','ASC']]
                : sort === 'price_desc' ? [['sale_price','DESC']]
                : sort === 'newest'     ? [['created_at','DESC']]
                : [['sort_order','ASC'],['id','ASC']];

    const rows = await Product.findAll({
      where,
      include: [
        { model: ProductImage, as: 'images', order: [['sort_order','ASC']] },
        { model: ProductVariant, as: 'variants', where: { is_active: true, deleted_at: null }, required: false },
        { model: Category, attributes: ['id','name','slug'] },
      ],
      order,
      limit:  parseInt(limit),
      offset: parseInt(offset),
    });

    // Attach avg rating from DB function
    const withRating = await Promise.all(rows.map(async (p) => {
      const [stats] = await sequelize.query(
        'SELECT * FROM fn_product_stats(:pid)',
        { replacements: { pid: p.id }, type: sequelize.QueryTypes.SELECT }
      );
      return { ...p.toJSON(), stats };
    }));

    res.json({ data: withRating, count: withRating.length });
  } catch (err) {
    console.error('[GET /products]', err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// ── PUBLIC: single product ───────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const where = isNaN(req.params.id)
      ? { slug: req.params.id }
      : { id: req.params.id };

    const product = await Product.findOne({
      where: { ...where, is_active: true },
      include: [
        { model: ProductImage, as: 'images', order: [['sort_order','ASC']] },
        { model: ProductVariant, as: 'variants', where: { is_active: true, deleted_at: null }, required: false },
        { model: Category, attributes: ['id','name','slug'] },
        { model: Review, where: { is_approved: true, deleted_at: null }, required: false,
          attributes: ['id','rating','title','body','reviewer_name','is_verified','created_at'],
          limit: 20, order: [['created_at','DESC']] },
      ],
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const [stats] = await sequelize.query(
      'SELECT * FROM fn_product_stats(:pid)',
      { replacements: { pid: product.id }, type: sequelize.QueryTypes.SELECT }
    );
    res.json({ data: { ...product.toJSON(), stats } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load product' });
  }
});

// ── ADMIN: create product ─────────────────────────────────────────────────────
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const body   = req.body;
    body.slug    = body.slug || slugify(body.name || '') + '-' + Date.now();
    const product = await Product.create(body);
    await audit({ userId: req.user.id, tableName: 'products', recordId: product.id, action: 'INSERT', newValues: body, ipAddress: req.ip });
    res.status(201).json({ data: product });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── ADMIN: update product ─────────────────────────────────────────────────────
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    const old = product.toJSON();
    await product.update(req.body);
    await audit({ userId: req.user.id, tableName: 'products', recordId: product.id, action: 'UPDATE', oldValues: old, newValues: req.body, ipAddress: req.ip });
    res.json({ data: product });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── ADMIN: SOFT DELETE ────────────────────────────────────────────────────────
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    await product.destroy();   // Sequelize paranoid = soft delete
    await audit({ userId: req.user.id, tableName: 'products', recordId: product.id, action: 'SOFT_DELETE', ipAddress: req.ip });
    res.json({ message: 'Product soft-deleted. Restore with PUT /restore.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: restore soft-deleted product ──────────────────────────────────────
router.put('/:id/restore', authenticate, requireAdmin, async (req, res) => {
  try {
    const product = await Product.findByPk(req.params.id, { paranoid: false });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    await product.restore();
    await audit({ userId: req.user.id, tableName: 'products', recordId: product.id, action: 'RESTORE', ipAddress: req.ip });
    res.json({ message: 'Product restored', data: product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
