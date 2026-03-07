'use strict';
/**
 * ORDER ROUTES
 * POST /api/orders                    – create order (calls sp_place_order)
 * POST /api/confirm-order             – mark order paid (triggers inventory & coupon triggers)
 * GET  /api/orders                    – user's own orders
 * GET  /api/orders/:id                – single order
 * POST /api/orders/:id/cancel         – cancel (calls sp_cancel_order)
 *
 * ADMIN:
 * GET  /api/admin/orders              – all orders
 * GET  /api/admin/orders/:id          – order detail
 * PUT  /api/admin/orders/:id          – update fulfillment / shiprocket
 */
const router  = require('express').Router();
const { Op }  = require('sequelize');
const { Order, OrderItem, OrderStatusLog, User, Product, Coupon, Address, sequelize } = require('../models');
const { authenticate, requireAdmin, optionalAuth } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

function genOrderNumber() {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2,6).toUpperCase();
  return `AVC-${ts}${rand}`;
}

// ── CREATE ORDER (stored procedure) ─────────────────────────────────────────
router.post('/', optionalAuth, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { items, formData, couponCode, shipping, discount, paymentMethod } = req.body;
    if (!items?.length) { await t.rollback(); return res.status(400).json({ error: 'Cart is empty' }); }

    const orderNumber = genOrderNumber();
    const userId      = req.user?.id || null;
    let   addressId   = null;
    let   couponId    = null;

    // Resolve coupon
    if (couponCode) {
      const cp = await Coupon.findOne({ where: { code: couponCode.toUpperCase(), is_active: true } });
      if (cp) couponId = cp.id;
    }

    // Save or reuse address for logged-in users
    if (userId && formData) {
      const addr = await Address.create({
        user_id:    userId,
        first_name: formData.firstName || formData.first_name || '',
        last_name:  formData.lastName  || formData.last_name  || '',
        line1:      formData.addr1     || formData.line1      || '',
        line2:      formData.addr2     || formData.line2      || '',
        city:       formData.city      || '',
        state:      formData.state     || '',
        postal_code: formData.pin      || formData.postal_code || '',
        phone:      formData.phone     || '',
      }, { transaction: t });
      addressId = addr.id;
    }

    // Call the stored procedure (within transaction)
    await sequelize.query(
      `CALL sp_place_order(
        :user_id, :address_id, :coupon_id, :order_number,
        :items::JSONB, :payment_method, :shipping, :discount, :coupon_code,
        NULL
      )`,
      {
        replacements: {
          user_id:        userId,
          address_id:     addressId,
          coupon_id:      couponId,
          order_number:   orderNumber,
          items:          JSON.stringify(items),
          payment_method: paymentMethod || 'online',
          shipping:       parseFloat(shipping) || 0,
          discount:       parseFloat(discount) || 0,
          coupon_code:    couponCode || null,
        },
        transaction: t,
      }
    );

    // Fetch the newly created order
    const order = await Order.findOne({
      where: { order_number: orderNumber },
      include: [{ model: OrderItem, as: 'items' }],
      transaction: t,
    });

    // Store address snapshot on order
    if (formData) {
      await order.update({
        snap_name:   `${formData.firstName || ''} ${formData.lastName || ''}`.trim(),
        snap_phone:  formData.phone  || '',
        snap_email:  formData.email  || '',
        snap_line1:  formData.addr1  || '',
        snap_line2:  formData.addr2  || '',
        snap_city:   formData.city   || '',
        snap_state:  formData.state  || '',
        snap_postal: formData.pin    || '',
      }, { transaction: t });
    }

    await t.commit();

    await audit({ userId, tableName: 'orders', recordId: order.id, action: 'INSERT', newValues: { order_number: orderNumber, total: order.total }, ipAddress: req.ip });

    res.status(201).json({ data: order, orderId: order.id, orderNumber: order.order_number });
  } catch (err) {
    await t.rollback();
    console.error('[POST /orders]', err);
    res.status(400).json({ error: err.message || 'Order creation failed' });
  }
});

// ── CONFIRM PAYMENT (triggers DB triggers for inventory + coupon) ─────────────
router.post('/confirm-order', optionalAuth, async (req, res) => {
  try {
    const { orderId, paymentId, cashfreeOrderId, method, status } = req.body;
    const order = await Order.findByPk(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const paymentStatus = status === 'SUCCESS' ? 'paid' : 'failed';
    const old = { payment_status: order.payment_status, fulfillment_status: order.fulfillment_status };

    await order.update({
      payment_status:        paymentStatus,
      cashfree_payment_id:   paymentId || null,
      cashfree_order_id:     cashfreeOrderId || order.cashfree_order_id,
      payment_method:        method || order.payment_method,
      fulfillment_status:    paymentStatus === 'paid' ? 'processing' : 'pending',
    });
    // ↑ This UPDATE fires: trg_order_decrement_inventory + trg_order_coupon_usage + trg_order_status_log

    await audit({ userId: req.user?.id, tableName: 'orders', recordId: order.id, action: 'UPDATE', oldValues: old, newValues: { payment_status: paymentStatus }, ipAddress: req.ip });

    res.json({ success: true, order: { id: order.id, order_number: order.order_number, payment_status: paymentStatus } });
  } catch (err) {
    console.error('[POST /confirm-order]', err);
    res.status(500).json({ error: 'Payment confirmation failed' });
  }
});

// ── USER: own orders ──────────────────────────────────────────────────────────
router.get('/my', authenticate, async (req, res) => {
  try {
    const orders = await Order.findAll({
      where:   { user_id: req.user.id },
      include: [{ model: OrderItem, as: 'items' }],
      order:   [['created_at','DESC']],
    });
    res.json({ data: orders });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// ── USER: single order ────────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const where = { id: req.params.id };
    if (req.user.role_id !== 1) where.user_id = req.user.id; // non-admin can only see own
    const order = await Order.findOne({
      where,
      include: [
        { model: OrderItem, as: 'items' },
        { model: OrderStatusLog, as: 'statusHistory', order: [['created_at','ASC']] },
      ],
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ data: order });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load order' });
  }
});

// ── CANCEL ORDER (stored procedure) ─────────────────────────────────────────
router.post('/:id/cancel', authenticate, async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    // Only owner or admin can cancel
    if (req.user.role_id !== 1 && order.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    await sequelize.query(
      'CALL sp_cancel_order(:order_id, :admin_id, :reason)',
      { replacements: { order_id: req.params.id, admin_id: req.user.id, reason: req.body.reason || 'User requested' } }
    );
    await audit({ userId: req.user.id, tableName: 'orders', recordId: req.params.id, action: 'UPDATE', newValues: { fulfillment_status: 'cancelled' }, ipAddress: req.ip });
    res.json({ message: 'Order cancelled and stock restored.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════
const adminRouter = require('express').Router();

adminRouter.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { status, payment, limit = 100, offset = 0 } = req.query;
    const where = {};
    if (status)  where.fulfillment_status = status;
    if (payment) where.payment_status     = payment;
    const orders = await Order.findAll({
      where,
      include: [
        { model: OrderItem, as: 'items' },
        { model: User, attributes: ['id','name','email','phone'] },
      ],
      order:  [['created_at','DESC']],
      limit:  parseInt(limit),
      offset: parseInt(offset),
      paranoid: false,  // include soft-deleted for admin view
    });
    res.json({ data: orders, count: orders.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

adminRouter.get('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id, {
      include: [
        { model: OrderItem, as: 'items' },
        { model: OrderStatusLog, as: 'statusHistory', order: [['created_at','ASC']] },
        { model: User, attributes: ['id','name','email','phone'] },
      ],
      paranoid: false,
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ data: order });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load order' });
  }
});

adminRouter.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const order = await Order.findByPk(req.params.id, { paranoid: false });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const old = { fulfillment_status: order.fulfillment_status };
    const { fulfillment, shiprocket_id } = req.body;
    await order.update({
      ...(fulfillment   && { fulfillment_status: fulfillment }),
      ...(shiprocket_id && { shiprocket_id }),
    });
    // Triggers fire automatically for status change
    await audit({ userId: req.user.id, tableName: 'orders', recordId: order.id, action: 'UPDATE', oldValues: old, newValues: req.body, ipAddress: req.ip });
    res.json({ data: order });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.use('/admin', adminRouter);
module.exports = router;
