'use strict';
const router = require('express').Router();
const { Op, fn, col, literal } = require('sequelize');
const { User, Order, Product, Review, AuditLog, sequelize } = require('../models');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

router.use(authenticate, requireAdmin);

// ── DASHBOARD STATS ──────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [
      totalOrders, paidOrders, totalRevenue,
      totalCustomers, totalProducts, lowStockProducts, pendingOrders,
    ] = await Promise.all([
      Order.count({ paranoid: false }),
      Order.count({ where: { payment_status: 'paid' } }),
      Order.sum('total', { where: { payment_status: 'paid' } }),
      User.count({ where: { role_id: 2, is_active: true } }),
      Product.count({ where: { is_active: true } }),
      Product.count({ where: { is_active: true, stock: { [Op.lte]: literal('low_stock_alert') } } }),
      Order.count({ where: { fulfillment_status: 'pending', payment_status: 'paid' } }),
    ]);

    // Revenue last 30 days
    const revenueLastMonth = await Order.sum('total', {
      where: {
        payment_status: 'paid',
        created_at: { [Op.gte]: new Date(Date.now() - 30 * 864e5) },
      },
    });

    // Top products by revenue
    const [topProducts] = await sequelize.query(`
      SELECT p.id, p.name, p.sku, p.stock,
             COALESCE(SUM(oi.line_total),0) AS revenue,
             COALESCE(SUM(oi.quantity),0)   AS units_sold
      FROM products p
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o       ON o.id = oi.order_id AND o.payment_status = 'paid'
      WHERE p.deleted_at IS NULL
      GROUP BY p.id
      ORDER BY revenue DESC
      LIMIT 5
    `);

    // Orders by status
    const [statusBreakdown] = await sequelize.query(`
      SELECT fulfillment_status, COUNT(*) AS count
      FROM orders
      WHERE deleted_at IS NULL
      GROUP BY fulfillment_status
    `);

    res.json({
      data: {
        totalOrders, paidOrders, totalRevenue: totalRevenue || 0,
        totalCustomers, totalProducts, lowStockProducts, pendingOrders,
        revenueLastMonth: revenueLastMonth || 0,
        topProducts, statusBreakdown,
      },
    });
  } catch (err) {
    console.error('[GET /admin/stats]', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ── CUSTOMERS ─────────────────────────────────────────────────────────────────
router.get('/customers', async (req, res) => {
  try {
    const customers = await User.findAll({
      where: { role_id: 2 },
      attributes: ['id','name','email','phone','provider','is_active','created_at','last_login_at'],
      paranoid: false,
      order: [['created_at','DESC']],
    });

    // Attach order count per customer
    const withOrders = await Promise.all(customers.map(async (c) => {
      const [stats] = await sequelize.query(
        `SELECT COUNT(*) AS order_count, COALESCE(SUM(total),0) AS lifetime_value
         FROM orders WHERE user_id = :uid AND payment_status = 'paid'`,
        { replacements: { uid: c.id }, type: sequelize.QueryTypes.SELECT }
      );
      return { ...c.toJSON(), ...stats };
    }));

    res.json({ data: withOrders });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load customers' });
  }
});

// ── CUSTOMER SOFT DELETE / DEACTIVATE ─────────────────────────────────────────
router.put('/customers/:id', async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, { paranoid: false });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { is_active, soft_delete, restore } = req.body;
    if (restore && user.deleted_at) { await user.restore(); }
    else if (soft_delete) { await user.destroy(); } // paranoid soft-delete
    else if (is_active !== undefined) { await user.update({ is_active }); }
    await audit({ userId: req.user.id, tableName: 'users', recordId: user.id, action: 'UPDATE', newValues: req.body, ipAddress: req.ip });
    res.json({ message: 'Customer updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: products (includes inactive/deleted) ───────────────────────────────
router.get('/products', async (req, res) => {
  const { Product, ProductImage, Category } = require('../models');
  try {
    const products = await Product.findAll({
      paranoid: false,
      include: [
        { model: ProductImage, as: 'images', order: [['sort_order','ASC']] },
        { model: Category, attributes: ['id','name'] },
      ],
      order: [['sort_order','ASC'],['id','ASC']],
    });
    res.json({ data: products });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// ── AUDIT LOGS ────────────────────────────────────────────────────────────────
router.get('/audit', async (req, res) => {
  try {
    const logs = await AuditLog.findAll({
      order: [['created_at','DESC']],
      limit: 200,
    });
    res.json({ data: logs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load audit logs' });
  }
});

module.exports = router;
