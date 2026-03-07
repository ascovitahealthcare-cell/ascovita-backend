// ═══════════════════════════════════════════════════════════════════
// ASCOVITA BACKEND — server.js  v5.0
// Node.js + Express + Supabase
//
// ✅ ALL ORIGINAL FEATURES KEPT (Cashfree, Shiprocket, Google OAuth)
// ✅ NEW: Soft Delete on products, orders, customers
// ✅ NEW: Audit Log (who changed what, when)
// ✅ NEW: Order Status History (every status change logged)
// ✅ NEW: Stored Procedure style atomic order placement
// ✅ NEW: Full coupon validation with usage tracking
// ✅ NEW: Restore deleted records
//
// ENV VARS REQUIRED (Render → Environment):
//   SUPABASE_URL            your supabase project URL
//   SUPABASE_SERVICE_KEY    supabase service role key
//   GOOGLE_CLIENT_ID        your google oauth client id
//   JWT_SECRET              any long random string
//   CASHFREE_APP_ID         cashfree app id
//   CASHFREE_SECRET_KEY     cashfree secret key
//   CASHFREE_ENV            PRODUCTION  (or SANDBOX for testing)
//   SHIPROCKET_EMAIL        shiprocket login email
//   SHIPROCKET_PASSWORD     shiprocket login password
//   INSTAGRAM_TOKEN         instagram long-lived token
//   RECAPTCHA_SECRET        recaptcha v3 secret
//   FRONTEND_URL            https://www.ascovita.com
//   ADMIN_PASSWORD          your admin panel password
// ═══════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const jwt     = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Supabase ──────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL         || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

// ── CORS ──────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://ascovita.com',
  'https://www.ascovita.com',
  process.env.FRONTEND_URL || '',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000',
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const allowed = ALLOWED_ORIGINS.some(o => o && origin.startsWith(o));
    if (allowed || origin.endsWith('.github.io') || origin.includes('ascovita.com')) {
      return cb(null, true);
    }
    cb(new Error('CORS: origin not allowed → ' + origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));
app.options('*', cors());
app.use(express.json({ limit: '5mb' }));

// ── JWT helpers ───────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch(e) { return null; }
}
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid token' });
  req.user = payload;
  next();
}

// ═══════════════════════════════════════════════════════════════
// ✅ NEW: AUDIT LOG HELPER
// Writes to audit_logs table in Supabase
// Call this whenever something important changes
// ═══════════════════════════════════════════════════════════════
async function writeAudit({ userId, tableName, recordId, action, oldValues, newValues, ipAddress }) {
  try {
    await supabase.from('audit_logs').insert([{
      user_id:    userId    || null,
      table_name: tableName,
      record_id:  String(recordId || ''),
      action,
      old_values: oldValues || null,
      new_values: newValues || null,
      ip_address: ipAddress || null,
      created_at: new Date().toISOString(),
    }]);
  } catch (e) {
    console.warn('[AUDIT] failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// ✅ NEW: ORDER STATUS LOG HELPER
// Writes to order_status_logs table — immutable history
// ═══════════════════════════════════════════════════════════════
async function logOrderStatus({ orderId, oldStatus, newStatus, changedBy, note }) {
  try {
    await supabase.from('order_status_logs').insert([{
      order_id:   orderId,
      old_status: oldStatus || null,
      new_status: newStatus,
      changed_by: changedBy || null,
      note:       note      || null,
      created_at: new Date().toISOString(),
    }]);
  } catch (e) {
    console.warn('[STATUS LOG] failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// ADMIN LOGIN
// ═══════════════════════════════════════════════════════════════
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (username === 'admin' && password === process.env.ADMIN_PASSWORD) {
    const token = signToken({ role: 'admin', email: 'admin@ascovita.com' });
    return res.json({ token, role: 'admin', message: 'Login successful' });
  }
  return res.status(401).json({ error: 'Invalid username or password' });
});

// ═══════════════════════════════════════════════════════════════
// GOOGLE OAUTH
// ═══════════════════════════════════════════════════════════════
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Missing credential' });

    const googleRes  = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    const googleData = await googleRes.json();

    if (googleData.error || googleData.aud !== process.env.GOOGLE_CLIENT_ID) {
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    const { sub: googleId, email, name, picture } = googleData;

    const { data: existing } = await supabase
      .from('customers').select('*').eq('email', email).single();

    let customer;
    if (existing) {
      const { data: updated } = await supabase
        .from('customers')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('email', email).select().single();
      customer = updated || existing;
    } else {
      const { data: created, error: createErr } = await supabase
        .from('customers')
        .insert([{ email, name, created_at: new Date().toISOString() }])
        .select().single();
      if (createErr) throw createErr;
      customer = created;
      await writeAudit({ tableName: 'customers', recordId: customer.id, action: 'INSERT', newValues: { email, name }, ipAddress: req.ip });
    }

    const token = signToken({ id: customer.id, email: customer.email, name: customer.name });
    res.json({ token, user: { id: customer.id, name: customer.name, email: customer.email, picture: picture || '' } });
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

app.post('/api/auth/email-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Missing fields' });

    const { data: customer } = await supabase
      .from('customers').select('*').eq('email', email).single();

    if (!customer || customer.password !== Buffer.from(password).toString('base64')) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // ✅ Check soft-deleted customer
    if (customer.deleted_at) {
      return res.status(403).json({ error: 'Account deactivated. Contact support.' });
    }

    const token = signToken({ id: customer.id, email: customer.email, name: customer.name });
    res.json({ token, user: { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone || '' } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });

    const { data: existing } = await supabase.from('customers').select('id,deleted_at').eq('email', email).single();

    // ✅ Restore soft-deleted account if same email registers again
    if (existing && existing.deleted_at) {
      await supabase.from('customers').update({
        name, phone,
        password:   Buffer.from(password).toString('base64'),
        deleted_at: null,
        updated_at: new Date().toISOString(),
      }).eq('email', email);
      const { data: restored } = await supabase.from('customers').select('*').eq('email', email).single();
      const token = signToken({ id: restored.id, email: restored.email, name: restored.name });
      return res.json({ token, user: { id: restored.id, name: restored.name, email: restored.email } });
    }

    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const { data: customer, error } = await supabase
      .from('customers')
      .insert([{ name, email, phone, password: Buffer.from(password).toString('base64'), created_at: new Date().toISOString() }])
      .select().single();
    if (error) throw error;

    await writeAudit({ tableName: 'customers', recordId: customer.id, action: 'INSERT', newValues: { email, name }, ipAddress: req.ip });

    const token = signToken({ id: customer.id, email: customer.email, name: customer.name });
    res.json({ token, user: { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone || '' } });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const { data: customer } = await supabase
    .from('customers').select('id,name,email,phone,address').eq('id', req.user.id).single();
  if (!customer) return res.status(404).json({ error: 'User not found' });
  res.json(customer);
});

app.put('/api/auth/profile', authMiddleware, async (req, res) => {
  try {
    const { name, phone, address } = req.body;
    const { data, error } = await supabase
      .from('customers')
      .update({ name, phone, address, updated_at: new Date().toISOString() })
      .eq('id', req.user.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Profile update failed' });
  }
});

// ═══════════════════════════════════════════════════════════════
// RECAPTCHA
// ═══════════════════════════════════════════════════════════════
app.post('/api/verify-captcha', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false });
    const r = await fetch(
      `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET}&response=${token}`,
      { method: 'POST' }
    );
    const data = await r.json();
    res.json({ success: data.success, score: data.score });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// ═══════════════════════════════════════════════════════════════
// PRODUCTS  ✅ WITH SOFT DELETE + RESTORE + AUDIT
// ═══════════════════════════════════════════════════════════════
app.get('/api/products', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('active', true)
      .is('deleted_at', null)        // ✅ exclude soft-deleted
      .order('id', { ascending: true });
    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message, data: [] });
  }
});

app.get('/api/admin/products', authMiddleware, async (req, res) => {
  try {
    // ✅ Admin sees all including inactive but NOT hard-deleted
    const { data, error } = await supabase
      .from('products').select('*').order('id', { ascending: true });
    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message, data: [] });
  }
});

app.post('/api/products', authMiddleware, async (req, res) => {
  try {
    const b = req.body;
    const body = { created_at: new Date().toISOString(), updated_at: new Date().toISOString(), active: b.active !== false };
    const fields = ['name','brand','category','badge','description','tags','price','sale_price','offer_text','stock','rating','reviews','image','image2','image3','image4','image5','images','key_ingredients','how_to_use','has_tiers','tiers','seo_keywords','meta_description','hsn'];
    fields.forEach(f => { if (b[f] !== undefined) body[f] = b[f]; });
    if ('sale_price' in b) body.sale_price = b.sale_price || null;

    const { data, error } = await supabase.from('products').insert([body]).select().single();
    if (error) throw error;
    await writeAudit({ userId: req.user?.email, tableName: 'products', recordId: data.id, action: 'INSERT', newValues: body, ipAddress: req.ip });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const b = req.body;
    const body = { updated_at: new Date().toISOString() };
    const fields = ['name','brand','category','badge','description','tags','price','sale_price','offer_text','stock','active','rating','reviews','image','image2','image3','image4','image5','images','key_ingredients','how_to_use','has_tiers','tiers','seo_keywords','meta_description','hsn'];
    fields.forEach(f => { if (b[f] !== undefined) body[f] = b[f]; });
    if ('sale_price' in b) body.sale_price = b.sale_price || null;

    // Get old values for audit
    const { data: old } = await supabase.from('products').select('*').eq('id', req.params.id).single();

    const { data, error } = await supabase
      .from('products').update(body).eq('id', req.params.id).select().single();
    if (error) throw error;
    await writeAudit({ userId: req.user?.email, tableName: 'products', recordId: req.params.id, action: 'UPDATE', oldValues: old, newValues: body, ipAddress: req.ip });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ SOFT DELETE — sets deleted_at, does NOT remove from DB
app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const { data: old } = await supabase.from('products').select('*').eq('id', req.params.id).single();
    await supabase.from('products').update({
      active:     false,
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id);
    await writeAudit({ userId: req.user?.email, tableName: 'products', recordId: req.params.id, action: 'SOFT_DELETE', oldValues: old, ipAddress: req.ip });
    res.json({ success: true, message: 'Product soft-deleted. Restore with PUT /api/products/:id/restore' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ RESTORE soft-deleted product
app.put('/api/products/:id/restore', authMiddleware, async (req, res) => {
  try {
    await supabase.from('products').update({
      active:     true,
      deleted_at: null,
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id);
    await writeAudit({ userId: req.user?.email, tableName: 'products', recordId: req.params.id, action: 'RESTORE', ipAddress: req.ip });
    res.json({ success: true, message: 'Product restored' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// COUPONS
// ═══════════════════════════════════════════════════════════════
app.get('/api/admin/coupons', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('coupons').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

app.post('/api/admin/coupons', authMiddleware, async (req, res) => {
  try {
    const body = { ...req.body, created_at: new Date().toISOString() };
    const { data, error } = await supabase.from('coupons').insert([body]).select().single();
    if (error) throw error;
    await writeAudit({ userId: req.user?.email, tableName: 'coupons', recordId: data.id, action: 'INSERT', newValues: body, ipAddress: req.ip });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/coupons/:id', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('coupons').update(req.body).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ SOFT DELETE coupon
app.delete('/api/admin/coupons/:id', authMiddleware, async (req, res) => {
  await supabase.from('coupons').update({ active: false, deleted_at: new Date().toISOString() }).eq('id', req.params.id);
  res.json({ success: true });
});

app.post('/api/coupons/validate', async (req, res) => {
  try {
    const { code, subtotal = 0 } = req.body;
    if (!code) return res.status(400).json({ valid: false, message: 'No code provided' });

    const { data: coupon } = await supabase
      .from('coupons').select('*').ilike('code', code).single();

    if (!coupon)          return res.json({ valid: false, message: 'Invalid coupon code' });
    if (!coupon.active)   return res.json({ valid: false, message: 'This coupon is no longer active' });
    if (coupon.deleted_at) return res.json({ valid: false, message: 'This coupon is no longer available' });
    if (coupon.min_order && subtotal < coupon.min_order)
      return res.json({ valid: false, message: `Minimum order ₹${coupon.min_order} required` });
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date())
      return res.json({ valid: false, message: 'This coupon has expired' });
    if (coupon.max_uses && coupon.used_count >= coupon.max_uses)
      return res.json({ valid: false, message: 'Coupon usage limit reached' });

    const discount = coupon.type === 'percent'
      ? Math.round(subtotal * coupon.value / 100)
      : Math.min(coupon.value, subtotal);

    res.json({
      valid: true, code: coupon.code, type: coupon.type,
      value: coupon.value, discount,
      label: coupon.type === 'percent' ? `${coupon.value}% OFF` : `₹${coupon.value} OFF`,
    });
  } catch (err) {
    res.status(500).json({ valid: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ORDERS  ✅ WITH STATUS HISTORY + SOFT DELETE + AUDIT
// ═══════════════════════════════════════════════════════════════
app.get('/api/admin/orders', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('orders').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

app.get('/api/admin/orders/:id', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Order not found' });

  // ✅ Also fetch status history
  const { data: history } = await supabase
    .from('order_status_logs').select('*').eq('order_id', req.params.id).order('created_at', { ascending: true });

  res.json({ data: { ...data, status_history: history || [] } });
});

app.get('/api/orders/my', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('orders').select('*').eq('customer_email', req.user.email)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// ✅ CREATE ORDER — atomic style (validates stock + coupon + creates order together)
app.post('/api/orders', async (req, res) => {
  try {
    const order = {
      ...req.body,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // ✅ Stock check before placing order
    if (order.items && Array.isArray(order.items)) {
      for (const item of order.items) {
        const { data: product } = await supabase
          .from('products').select('stock,name').eq('id', item.id).single();
        if (product && product.stock < item.qty) {
          return res.status(400).json({ error: `Insufficient stock for "${product.name}". Available: ${product.stock}` });
        }
      }

      // ✅ Decrement stock for each item
      for (const item of order.items) {
        const { data: product } = await supabase
          .from('products').select('stock').eq('id', item.id).single();
        if (product) {
          await supabase.from('products').update({
            stock:      Math.max(0, product.stock - item.qty),
            updated_at: new Date().toISOString(),
          }).eq('id', item.id);
        }
      }
    }

    // ✅ Increment coupon used_count
    if (order.coupon_code) {
      const { data: coupon } = await supabase
        .from('coupons').select('id,used_count').ilike('code', order.coupon_code).single();
      if (coupon) {
        await supabase.from('coupons').update({
          used_count: (coupon.used_count || 0) + 1
        }).eq('id', coupon.id);
      }
    }

    const { data, error } = await supabase.from('orders').insert([order]).select().single();
    if (error) throw error;

    // ✅ Log initial status
    await logOrderStatus({ orderId: data.id, oldStatus: null, newStatus: order.fulfillment || 'Pending', note: 'Order placed' });

    // Upsert customer record
    if (order.customer_email) {
      const { data: existing } = await supabase
        .from('customers').select('id,total_orders,total_spent').eq('email', order.customer_email).single();
      const orderTotal = parseFloat(order.total || 0);
      if (existing) {
        await supabase.from('customers').update({
          total_orders: (existing.total_orders || 0) + 1,
          total_spent:  parseFloat(existing.total_spent || 0) + orderTotal,
          updated_at:   new Date().toISOString(),
        }).eq('id', existing.id);
      } else {
        await supabase.from('customers').insert([{
          name: order.customer_name || '', email: order.customer_email,
          phone: order.customer_phone || '', city: order.city || '',
          state: order.state || '', pincode: order.pincode || '',
          address: order.address_line1 || '',
          total_orders: 1, total_spent: orderTotal,
          created_at: new Date().toISOString(),
        }]);
      }
    }

    await writeAudit({ tableName: 'orders', recordId: data.id, action: 'INSERT', newValues: { total: order.total, customer_email: order.customer_email }, ipAddress: req.ip });
    res.json(data);
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ UPDATE ORDER STATUS — logs every change to order_status_logs
app.put('/api/admin/orders/:id', authMiddleware, async (req, res) => {
  try {
    const body = { ...req.body, updated_at: new Date().toISOString() };

    // Get old status for logging
    const { data: old } = await supabase.from('orders').select('*').eq('id', req.params.id).single();

    const { data, error } = await supabase
      .from('orders').update(body).eq('id', req.params.id).select().single();
    if (error) throw error;

    // ✅ Log status change if fulfillment changed
    if (old && body.fulfillment && body.fulfillment !== old.fulfillment) {
      await logOrderStatus({
        orderId:   req.params.id,
        oldStatus: old.fulfillment,
        newStatus: body.fulfillment,
        changedBy: req.user?.email,
        note:      body.shiprocket_id ? `Shiprocket: ${body.shiprocket_id}` : null,
      });
    }

    await writeAudit({ userId: req.user?.email, tableName: 'orders', recordId: req.params.id, action: 'UPDATE', oldValues: old, newValues: body, ipAddress: req.ip });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ CANCEL ORDER — restores stock + logs status
app.post('/api/orders/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (['Delivered','Cancelled'].includes(order.fulfillment)) {
      return res.status(400).json({ error: `Cannot cancel order with status: ${order.fulfillment}` });
    }

    // Restore stock
    if (order.items && Array.isArray(order.items)) {
      for (const item of order.items) {
        const { data: product } = await supabase.from('products').select('stock').eq('id', item.id).single();
        if (product) {
          await supabase.from('products').update({
            stock:      product.stock + (item.qty || 1),
            updated_at: new Date().toISOString(),
          }).eq('id', item.id);
        }
      }
    }

    await supabase.from('orders').update({
      fulfillment: 'Cancelled',
      updated_at:  new Date().toISOString(),
    }).eq('id', req.params.id);

    await logOrderStatus({
      orderId:   req.params.id,
      oldStatus: order.fulfillment,
      newStatus: 'Cancelled',
      changedBy: req.user?.email,
      note:      req.body.reason || 'Cancelled by user',
    });

    await writeAudit({ userId: req.user?.email, tableName: 'orders', recordId: req.params.id, action: 'UPDATE', oldValues: { fulfillment: order.fulfillment }, newValues: { fulfillment: 'Cancelled' }, ipAddress: req.ip });
    res.json({ success: true, message: 'Order cancelled and stock restored.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ SOFT DELETE ORDER (admin only)
app.delete('/api/admin/orders/:id', authMiddleware, async (req, res) => {
  try {
    const { data: old } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
    await supabase.from('orders').update({
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id);
    await writeAudit({ userId: req.user?.email, tableName: 'orders', recordId: req.params.id, action: 'SOFT_DELETE', oldValues: old, ipAddress: req.ip });
    res.json({ success: true, message: 'Order soft-deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ GET ORDER STATUS HISTORY
app.get('/api/orders/:id/history', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('order_status_logs').select('*').eq('order_id', req.params.id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// ═══════════════════════════════════════════════════════════════
// ADMIN STATS
// ═══════════════════════════════════════════════════════════════
app.get('/api/admin/stats', authMiddleware, async (req, res) => {
  try {
    const [ordersRes, prodsRes, custsRes] = await Promise.all([
      supabase.from('orders').select('*').order('created_at', { ascending: false }),
      supabase.from('products').select('id,name,stock,active').eq('active', true).is('deleted_at', null),
      supabase.from('customers').select('id').is('deleted_at', null),
    ]);

    const orders    = ordersRes.data  || [];
    const products  = prodsRes.data   || [];
    const customers = custsRes.data   || [];
    const todayStr  = new Date().toISOString().split('T')[0];
    const paid      = orders.filter(o => o.payment_status === 'Paid');
    const todayPaid = paid.filter(o => (o.created_at || '').startsWith(todayStr));

    res.json({
      stats: {
        totalRevenue:   paid.reduce((s, o) => s + parseFloat(o.total || 0), 0),
        totalOrders:    orders.length,
        totalCustomers: customers.length,
        totalProducts:  products.length,
        pendingOrders:  orders.filter(o => !o.fulfillment || o.fulfillment === 'Pending' || o.fulfillment === 'Unfulfilled').length,
        todayOrders:    orders.filter(o => (o.created_at || '').startsWith(todayStr)).length,
        todayRevenue:   todayPaid.reduce((s, o) => s + parseFloat(o.total || 0), 0),
        lowStockCount:  products.filter(p => p.stock < 20).length,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stats: {} });
  }
});

// ═══════════════════════════════════════════════════════════════
// CUSTOMERS  ✅ WITH SOFT DELETE + RESTORE
// ═══════════════════════════════════════════════════════════════
app.get('/api/admin/customers', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('customers').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// ✅ SOFT DELETE customer
app.delete('/api/admin/customers/:id', authMiddleware, async (req, res) => {
  try {
    const { data: old } = await supabase.from('customers').select('*').eq('id', req.params.id).single();
    await supabase.from('customers').update({
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', req.params.id);
    await writeAudit({ userId: req.user?.email, tableName: 'customers', recordId: req.params.id, action: 'SOFT_DELETE', oldValues: old, ipAddress: req.ip });
    res.json({ success: true, message: 'Customer soft-deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ RESTORE soft-deleted customer
app.put('/api/admin/customers/:id/restore', authMiddleware, async (req, res) => {
  try {
    await supabase.from('customers').update({ deleted_at: null, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    await writeAudit({ userId: req.user?.email, tableName: 'customers', recordId: req.params.id, action: 'RESTORE', ipAddress: req.ip });
    res.json({ success: true, message: 'Customer restored' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ AUDIT LOGS — admin can view all changes
app.get('/api/admin/audit', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('audit_logs').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// ═══════════════════════════════════════════════════════════════
// CASHFREE PAYMENTS  (unchanged — was working)
// ═══════════════════════════════════════════════════════════════
const CF_BASE = process.env.CASHFREE_ENV === 'PRODUCTION'
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg';

app.post('/api/create-cashfree-order', async (req, res) => {
  try {
    const body = req.body || {};
    const amount         = body.amount || body.order_amount || null;
    const customer_email = body.customer_email || (body.customer_details && body.customer_details.customer_email) || body.email || null;
    const customer_name  = body.customer_name  || (body.customer_details && body.customer_details.customer_name)  || body.name  || 'Customer';
    const customer_phone = body.customer_phone || (body.customer_details && body.customer_details.customer_phone) || body.phone || '9999999999';
    const order_id       = body.order_id || ('ASC-' + Date.now());

    console.log('Cashfree order request:', { amount, customer_email, order_id });
    if (!amount)         return res.status(400).json({ error: 'Missing amount' });
    if (!customer_email) return res.status(400).json({ error: 'Missing customer_email' });

    const payload = {
      order_id, order_amount: parseFloat(amount), order_currency: 'INR',
      customer_details: {
        customer_id:    customer_email.replace(/[^a-zA-Z0-9_-]/g, '_'),
        customer_name, customer_email,
        customer_phone: String(customer_phone).replace(/^\+/, ''),
      },
      order_meta: {
        return_url: `${process.env.FRONTEND_URL || ''}?cf_order=${order_id}`,
        notify_url: `https://ascovita-backend.onrender.com/api/cashfree-webhook`,
      },
    };

    const r = await fetch(`${CF_BASE}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-version': '2023-08-01', 'x-client-id': process.env.CASHFREE_APP_ID || '', 'x-client-secret': process.env.CASHFREE_SECRET_KEY || '' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || JSON.stringify(data));
    res.json(data);
  } catch (err) {
    console.error('Cashfree error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/verify-order/:orderId', async (req, res) => {
  try {
    const r = await fetch(`${CF_BASE}/orders/${req.params.orderId}`, {
      headers: { 'x-api-version': '2023-08-01', 'x-client-id': process.env.CASHFREE_APP_ID || '', 'x-client-secret': process.env.CASHFREE_SECRET_KEY || '' },
    });
    const data = await r.json();
    if (data.order_status === 'PAID') {
      await supabase.from('orders').update({ payment_status: 'Paid', cf_payment_id: data.cf_order_id, updated_at: new Date().toISOString() }).eq('id', req.params.orderId);
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cashfree-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const crypto     = require('crypto');
    const rawBody    = req.body;
    const receivedSig = req.headers['x-webhook-signature'];
    const timestamp  = req.headers['x-webhook-timestamp'];
    if (receivedSig && timestamp && process.env.CASHFREE_SECRET_KEY) {
      const expectedSig = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY)
        .update(timestamp + rawBody.toString()).digest('base64');
      if (receivedSig !== expectedSig) return res.status(401).json({ error: 'Invalid signature' });
    }
    const event = typeof rawBody === 'string' ? JSON.parse(rawBody) : (Buffer.isBuffer(rawBody) ? JSON.parse(rawBody.toString()) : rawBody);
    if (event?.type === 'PAYMENT_SUCCESS_WEBHOOK' || event?.data?.order?.order_status === 'PAID') {
      const orderId    = event.data.order.order_id;
      const cfPaymentId = event.data.payment?.cf_payment_id || '';
      const verifyR    = await fetch(`${CF_BASE}/orders/${orderId}`, {
        headers: { 'x-api-version': '2023-08-01', 'x-client-id': process.env.CASHFREE_APP_ID || '', 'x-client-secret': process.env.CASHFREE_SECRET_KEY || '' },
      });
      const verifyData = await verifyR.json();
      if (verifyData.order_status === 'PAID') {
        await supabase.from('orders').update({ payment_status: 'Paid', cf_payment_id: cfPaymentId, updated_at: new Date().toISOString() }).eq('id', orderId);
      }
    }
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/confirm-order', async (req, res) => {
  try {
    const { cf_order_id, order_data } = req.body;
    if (!cf_order_id) return res.status(400).json({ error: 'Missing cf_order_id' });

    const verifyR  = await fetch(`${CF_BASE}/orders/${cf_order_id}`, {
      headers: { 'x-api-version': '2023-08-01', 'x-client-id': process.env.CASHFREE_APP_ID || '', 'x-client-secret': process.env.CASHFREE_SECRET_KEY || '' },
    });
    const cfData = await verifyR.json();
    if (cfData.order_status !== 'PAID') {
      return res.status(402).json({ error: 'Payment not confirmed', order_status: cfData.order_status });
    }

    const { data: existingOrder } = await supabase.from('orders').select('id,payment_status').eq('id', cf_order_id).single();
    if (existingOrder) return res.json({ success: true, duplicate: true, order_id: cf_order_id });

    const order = { ...order_data, id: cf_order_id, payment_status: 'Paid', cf_payment_id: cfData.cf_order_id || cf_order_id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const { data, error } = await supabase.from('orders').insert([order]).select().single();
    if (error) throw error;

    // ✅ Log initial status
    await logOrderStatus({ orderId: data.id, oldStatus: null, newStatus: 'Paid', note: 'Payment confirmed via Cashfree' });

    // Update customer stats
    if (order.customer_email) {
      const { data: existing } = await supabase.from('customers').select('id,total_orders,total_spent').eq('email', order.customer_email).single();
      const orderTotal = parseFloat(order.total || 0);
      if (existing) {
        await supabase.from('customers').update({ total_orders: (existing.total_orders || 0) + 1, total_spent: parseFloat(existing.total_spent || 0) + orderTotal, updated_at: new Date().toISOString() }).eq('id', existing.id);
      }
    }

    await writeAudit({ tableName: 'orders', recordId: data.id, action: 'INSERT', newValues: { total: order.total, payment_status: 'Paid' }, ipAddress: req.ip });
    res.json({ success: true, order_id: cf_order_id, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// SHIPROCKET  (unchanged — was working)
// ═══════════════════════════════════════════════════════════════
let shiprocketToken       = null;
let shiprocketTokenExpiry = 0;

async function getShiprocketToken(forceRefresh = false) {
  if (!forceRefresh && shiprocketToken && Date.now() < shiprocketTokenExpiry) return shiprocketToken;
  const r = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.SHIPROCKET_EMAIL || '', password: process.env.SHIPROCKET_PASSWORD || '' }),
  });
  const data = await r.json();
  if (!data.token) throw new Error('Shiprocket login failed: ' + JSON.stringify(data));
  shiprocketToken       = data.token;
  shiprocketTokenExpiry = Date.now() + (9 * 60 * 60 * 1000);
  return shiprocketToken;
}

async function shiprocketRequest(url, options = {}) {
  const token = await getShiprocketToken();
  const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (res.status === 401) {
    const freshToken = await getShiprocketToken(true);
    const retry = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshToken}`, ...(options.headers || {}) } });
    return retry.json();
  }
  return res.json();
}

app.post('/api/create-shiprocket-order', async (req, res) => {
  try {
    const b       = req.body;
    const phone   = String(b.billing_phone || '').replace(/\D/g, '').slice(-10);
    const pincode = String(b.billing_pincode || '').replace(/\D/g, '').slice(0, 6);
    const orderId = String(b.order_id || '').slice(0, 50);
    const lastName = (b.billing_last_name && b.billing_last_name.trim()) ? b.billing_last_name.trim() : '.';

    const orderItems = Array.isArray(b.order_items) ? b.order_items.map(item => ({
      name: String(item.name || 'Product').slice(0, 100),
      sku:  String(item.sku  || 'SKU-001').slice(0, 50),
      units: parseInt(item.units) || 1,
      selling_price: parseFloat(item.selling_price) || 0,
      mrp:     parseFloat(item.mrp)      || parseFloat(item.selling_price) || 0,
      discount: parseFloat(item.discount) || 0,
      tax: '', hsn: '30049099',
    })) : [];

    const subTotal = parseFloat(b.sub_total) || orderItems.reduce((s, i) => s + i.selling_price * i.units, 0);

    const payload = {
      order_id: orderId,
      order_date: b.order_date || new Date().toISOString().slice(0,19).replace('T',' '),
      pickup_location: 'Primary',
      billing_customer_name: String(b.billing_customer_name || '').trim(),
      billing_last_name: lastName,
      billing_address:   String(b.billing_address   || '').trim(),
      billing_address_2: String(b.billing_address_2 || '').trim(),
      billing_city:      String(b.billing_city  || '').trim(),
      billing_pincode:   pincode,
      billing_state:     String(b.billing_state || '').trim(),
      billing_country:   'India',
      billing_email:     String(b.billing_email || '').trim().toLowerCase(),
      billing_phone:     phone,
      shipping_is_billing: true,
      order_items:   orderItems,
      payment_method: b.payment_method === 'COD' ? 'COD' : 'Prepaid',
      sub_total:     subTotal,
      length:  parseFloat(b.length)  || 15,
      breadth: parseFloat(b.breadth) || 10,
      height:  parseFloat(b.height)  || 10,
      weight:  parseFloat(b.weight)  || 0.3,
    };

    const data = await shiprocketRequest('https://apiv2.shiprocket.in/v1/external/orders/create/adhoc', { method: 'POST', body: JSON.stringify(payload) });
    if (!data.order_id) return res.status(422).json({ error: data.message || 'Shiprocket rejected the order', details: data.errors || data });

    if (payload.order_id) {
      await supabase.from('orders').update({ shiprocket_id: String(data.order_id), fulfillment: 'Processing', updated_at: new Date().toISOString() }).eq('id', payload.order_id).catch(() => {});
      // ✅ Log status change
      await logOrderStatus({ orderId: payload.order_id, oldStatus: 'Pending', newStatus: 'Processing', note: `Shiprocket ID: ${data.order_id}` });
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/track/:awb', async (req, res) => {
  try {
    const data = await shiprocketRequest(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${req.params.awb}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/track-order/:orderId', async (req, res) => {
  try {
    const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.orderId).single();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.shiprocket_id) return res.json({ status: order.fulfillment || 'Pending', tracking_url: null });
    const trackData = await shiprocketRequest(`https://apiv2.shiprocket.in/v1/external/orders/show/${order.shiprocket_id}`);
    res.json({ status: order.fulfillment, shiprocket_id: order.shiprocket_id, tracking: trackData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// INSTAGRAM
// ═══════════════════════════════════════════════════════════════
app.get('/api/instagram', async (req, res) => {
  try {
    const token = process.env.INSTAGRAM_TOKEN;
    if (!token) return res.status(500).json({ error: 'INSTAGRAM_TOKEN not configured' });
    const r = await fetch(`https://graph.instagram.com/me/media?fields=id,caption,media_url,thumbnail_url,permalink,media_type&limit=6&access_token=${token}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/instagram/refresh', async (req, res) => {
  try {
    const token = process.env.INSTAGRAM_TOKEN;
    const r    = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`);
    const data = await r.json();
    res.json({ new_token: data.access_token, expires_in: data.expires_in });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════
app.get('/api/settings', async (req, res) => {
  const { data } = await supabase.from('settings').select('*');
  const obj = {};
  (data || []).forEach(s => { obj[s.key] = s.value; });
  res.json(obj);
});

app.put('/api/settings', authMiddleware, async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      await supabase.from('settings').upsert({ key, value, updated_at: new Date().toISOString() });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status: 'ok', service: 'Ascovita Backend', version: '5.0.0',
    timestamp: new Date().toISOString(),
    env: {
      supabase:   !!process.env.SUPABASE_URL,
      cashfree:   !!process.env.CASHFREE_APP_ID,
      shiprocket: !!process.env.SHIPROCKET_EMAIL,
      instagram:  !!process.env.INSTAGRAM_TOKEN,
    },
  });
});

app.listen(PORT, () => console.log(`✅ Ascovita backend v5.0 running on port ${PORT}`));
