// ═══════════════════════════════════════════════════════════════════
// ASCOVITA BACKEND — server.js  v4.0  (FIXED)
// Node.js + Express + Supabase
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
//   FRONTEND_URL            https://yourusername.github.io
//   ADMIN_PASSWORD          your admin panel password (default: ascovita2024)
// ═══════════════════════════════════════════════════════════════════

'use strict';

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const jwt     = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Supabase ─────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL    || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

// ── CORS ──────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || '',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000',
];

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, Postman, curl)
    if (!origin) return cb(null, true);
    // Allow if origin starts with any allowed origin
    const allowed = ALLOWED_ORIGINS.some(o => o && origin.startsWith(o));
    // Also allow github.io pages
    if (allowed || origin.endsWith('.github.io') || origin.includes('github.io')) {
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
const JWT_SECRET = process.env.JWT_SECRET || 'ascovita-secret-change-me';

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

// ── Simple admin password check (for admin panel JWT) ─────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ascovita2024';

// POST /api/admin/login  — used by admin panel
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (username === 'admin' && password === ADMIN_PASSWORD) {
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

    const googleRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`
    );
    const googleData = await googleRes.json();

    if (googleData.error || googleData.aud !== process.env.GOOGLE_CLIENT_ID) {
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    const { sub: googleId, email, name, picture } = googleData;

    // Upsert into customers table (we use customers, not a separate users table)
    const { data: existing } = await supabase
      .from('customers')
      .select('*')
      .eq('email', email)
      .single();

    let customer;
    if (existing) {
      const { data: updated } = await supabase
        .from('customers')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('email', email)
        .select()
        .single();
      customer = updated || existing;
    } else {
      const { data: created, error: createErr } = await supabase
        .from('customers')
        .insert([{ email, name, created_at: new Date().toISOString() }])
        .select()
        .single();
      if (createErr) throw createErr;
      customer = created;
    }

    const token = signToken({ id: customer.id, email: customer.email, name: customer.name });
    res.json({
      token,
      user: { id: customer.id, name: customer.name, email: customer.email, picture: picture || '' }
    });

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
      .from('customers')
      .select('*')
      .eq('email', email)
      .single();

    // Store hashed as base64 (simple, not bcrypt — upgrade later if needed)
    if (!customer || customer.password !== Buffer.from(password).toString('base64')) {
      return res.status(401).json({ error: 'Invalid email or password' });
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

    const { data: existing } = await supabase.from('customers').select('id').eq('email', email).single();
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const { data: customer, error } = await supabase
      .from('customers')
      .insert([{
        name, email, phone,
        password: Buffer.from(password).toString('base64'),
        created_at: new Date().toISOString()
      }])
      .select()
      .single();
    if (error) throw error;

    const token = signToken({ id: customer.id, email: customer.email, name: customer.name });
    res.json({ token, user: { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone || '' } });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const { data: customer } = await supabase
    .from('customers')
    .select('id,name,email,phone,address')
    .eq('id', req.user.id)
    .single();
  if (!customer) return res.status(404).json({ error: 'User not found' });
  res.json(customer);
});

app.put('/api/auth/profile', authMiddleware, async (req, res) => {
  try {
    const { name, phone, address } = req.body;
    const { data, error } = await supabase
      .from('customers')
      .update({ name, phone, address, updated_at: new Date().toISOString() })
      .eq('id', req.user.id)
      .select()
      .single();
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
// PRODUCTS  (FIX: always return { data: [...] } wrapper)
// ═══════════════════════════════════════════════════════════════

// GET /api/products — public (no auth needed for storefront)
app.get('/api/products', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('active', true)
      .order('id', { ascending: true });   // FIX: removed sort_order (doesn't exist in schema)
    if (error) throw error;
    res.json({ data: data || [] });         // FIX: always wrap in { data: [] }
  } catch (err) {
    console.error('Products error:', err);
    res.status(500).json({ error: err.message, data: [] });
  }
});

// GET /api/admin/products — all products including inactive
app.get('/api/admin/products', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('id', { ascending: true });
    if (error) throw error;
    res.json({ data: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message, data: [] });
  }
});

// POST /api/products — add product (admin only)
app.post('/api/products', authMiddleware, async (req, res) => {
  try {
    const body = { ...req.body, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    // Remove sort_order if passed (not in schema)
    delete body.sort_order;
    const { data, error } = await supabase.from('products').insert([body]).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/products/:id — update product
app.put('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const body = { ...req.body, updated_at: new Date().toISOString() };
    delete body.sort_order;
    const { data, error } = await supabase
      .from('products')
      .update(body)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/products/:id — soft delete
app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  await supabase.from('products').update({ active: false }).eq('id', req.params.id);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// COUPONS
// ═══════════════════════════════════════════════════════════════

// GET /api/admin/coupons — all coupons
app.get('/api/admin/coupons', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('coupons').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// POST /api/admin/coupons — create coupon  (FIX: was missing)
app.post('/api/admin/coupons', authMiddleware, async (req, res) => {
  try {
    const body = { ...req.body, created_at: new Date().toISOString() };
    const { data, error } = await supabase.from('coupons').insert([body]).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/coupons/:id — update coupon  (FIX: was missing)
app.put('/api/admin/coupons/:id', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('coupons')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/coupons/:id
app.delete('/api/admin/coupons/:id', authMiddleware, async (req, res) => {
  await supabase.from('coupons').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// POST /api/coupons/validate — public endpoint
app.post('/api/coupons/validate', async (req, res) => {
  try {
    const { code, subtotal = 0 } = req.body;
    if (!code) return res.status(400).json({ valid: false, message: 'No code provided' });

    const { data: coupon } = await supabase
      .from('coupons')
      .select('*')
      .ilike('code', code)
      .single();

    if (!coupon) return res.json({ valid: false, message: 'Invalid coupon code' });
    if (!coupon.active) return res.json({ valid: false, message: 'This coupon is no longer active' });
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
      valid: true,
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
      discount,
      label: coupon.type === 'percent' ? `${coupon.value}% OFF` : `₹${coupon.value} OFF`,
    });
  } catch (err) {
    res.status(500).json({ valid: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════

// GET /api/admin/orders
app.get('/api/admin/orders', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// GET /api/admin/orders/:id — single order
app.get('/api/admin/orders/:id', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('orders').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Order not found' });
  res.json({ data });
});

// GET /api/orders/my — customer's own orders
app.get('/api/orders/my', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('customer_email', req.user.email)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// POST /api/orders — create order (public, called after payment)
app.post('/api/orders', async (req, res) => {
  try {
    const order = {
      ...req.body,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from('orders').insert([order]).select().single();
    if (error) throw error;

    // Upsert customer record
    if (order.customer_email) {
      const { data: existing } = await supabase
        .from('customers')
        .select('id,total_orders,total_spent')
        .eq('email', order.customer_email)
        .single();

      const orderTotal = parseFloat(order.total || 0);
      if (existing) {
        await supabase.from('customers').update({
          total_orders: (existing.total_orders || 0) + 1,
          total_spent: parseFloat(existing.total_spent || 0) + orderTotal,
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id);
      } else {
        await supabase.from('customers').insert([{
          name: order.customer_name || '',
          email: order.customer_email,
          phone: order.customer_phone || '',
          city: order.city || '',
          state: order.state || '',
          pincode: order.pincode || '',
          address: order.address_line1 || '',
          total_orders: 1,
          total_spent: orderTotal,
          created_at: new Date().toISOString(),
        }]);
      }
    }

    res.json(data);
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/orders/:id — update status / tracking
app.put('/api/admin/orders/:id', authMiddleware, async (req, res) => {
  try {
    const body = { ...req.body, updated_at: new Date().toISOString() };
    const { data, error } = await supabase
      .from('orders')
      .update(body)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN STATS  (FIX: this route was completely missing)
// ═══════════════════════════════════════════════════════════════

app.get('/api/admin/stats', authMiddleware, async (req, res) => {
  try {
    const [ordersRes, prodsRes, custsRes] = await Promise.all([
      supabase.from('orders').select('*').order('created_at', { ascending: false }),
      supabase.from('products').select('id,name,stock,active').eq('active', true),
      supabase.from('customers').select('id'),
    ]);

    const orders   = ordersRes.data  || [];
    const products = prodsRes.data   || [];
    const customers= custsRes.data   || [];

    const todayStr = new Date().toISOString().split('T')[0];
    const paid     = orders.filter(o => o.payment_status === 'Paid');
    const todayPaid= paid.filter(o => (o.created_at || '').startsWith(todayStr));

    const totalRevenue  = paid.reduce((s, o) => s + parseFloat(o.total || 0), 0);
    const todayRevenue  = todayPaid.reduce((s, o) => s + parseFloat(o.total || 0), 0);
    const pendingOrders = orders.filter(o => !o.fulfillment || o.fulfillment === 'Pending' || o.fulfillment === 'Unfulfilled').length;
    const lowStockCount = products.filter(p => p.stock < 20).length;

    res.json({
      stats: {
        totalRevenue,
        totalOrders:    orders.length,
        totalCustomers: customers.length,
        totalProducts:  products.length,
        pendingOrders,
        todayOrders:    orders.filter(o => (o.created_at || '').startsWith(todayStr)).length,
        todayRevenue,
        lowStockCount,
      }
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: err.message, stats: {} });
  }
});

// ═══════════════════════════════════════════════════════════════
// CUSTOMERS  (FIX: /api/admin/customers was missing)
// ═══════════════════════════════════════════════════════════════

app.get('/api/admin/customers', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: data || [] });
});

// ═══════════════════════════════════════════════════════════════
// CASHFREE PAYMENTS
// ═══════════════════════════════════════════════════════════════

const CF_BASE = process.env.CASHFREE_ENV === 'PRODUCTION'
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg';

app.post('/api/create-cashfree-order', async (req, res) => {
  try {
    const body = req.body || {};

    // Support ALL field name formats the frontend might send
    const amount         = body.amount
                        || body.order_amount
                        || body.order_amount_value
                        || (body.customer_details && body.total)
                        || null;

    const customer_email = body.customer_email
                        || (body.customer_details && body.customer_details.customer_email)
                        || body.email
                        || null;

    const customer_name  = body.customer_name
                        || (body.customer_details && body.customer_details.customer_name)
                        || body.name
                        || 'Customer';

    const customer_phone = body.customer_phone
                        || (body.customer_details && body.customer_details.customer_phone)
                        || body.phone
                        || '9999999999';

    const order_id = body.order_id || ('ASC-' + Date.now());

    // Log for debugging
    console.log('Cashfree order request:', { amount, customer_email, customer_name, order_id, raw_keys: Object.keys(body) });

    if (!amount) {
      return res.status(400).json({ error: 'Missing amount. Received fields: ' + Object.keys(body).join(', ') });
    }
    if (!customer_email) {
      return res.status(400).json({ error: 'Missing customer_email. Received fields: ' + Object.keys(body).join(', ') });
    }
    const payload = {
      order_id:         order_id,
      order_amount:     parseFloat(amount),
      order_currency:   'INR',
      customer_details: {
        customer_id:    customer_email.replace(/[^a-zA-Z0-9_-]/g, '_'),
        customer_name:  customer_name || 'Customer',
        customer_email: customer_email,
        customer_phone: String(customer_phone).replace(/^\+/, ''),
      },
      order_meta: {
        return_url: `${process.env.FRONTEND_URL || ''}?order_id=${order_id}`,
        notify_url: `https://ascovita-backend.onrender.com/api/cashfree-webhook`,
      },
    };

    const r = await fetch(`${CF_BASE}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-version':   '2023-08-01',
        'x-client-id':     process.env.CASHFREE_APP_ID     || '',
        'x-client-secret': process.env.CASHFREE_SECRET_KEY || '',
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error('Cashfree order error:', data);
      throw new Error(data.message || JSON.stringify(data));
    }
    res.json(data);
  } catch (err) {
    console.error('Cashfree error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/verify-order/:orderId
app.get('/api/verify-order/:orderId', async (req, res) => {
  try {
    const r = await fetch(`${CF_BASE}/orders/${req.params.orderId}`, {
      headers: {
        'x-api-version':   '2023-08-01',
        'x-client-id':     process.env.CASHFREE_APP_ID     || '',
        'x-client-secret': process.env.CASHFREE_SECRET_KEY || '',
      },
    });
    const data = await r.json();
    // If payment is paid, also update the order in supabase
    if (data.order_status === 'PAID') {
      await supabase.from('orders')
        .update({ payment_status: 'Paid', cf_payment_id: data.cf_order_id, updated_at: new Date().toISOString() })
        .eq('id', req.params.orderId);
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cashfree-webhook — Cashfree payment webhook
app.post('/api/cashfree-webhook', async (req, res) => {
  try {
    const event = req.body;
    console.log('Cashfree webhook:', JSON.stringify(event));
    if (event?.data?.order?.order_status === 'PAID') {
      const orderId = event.data.order.order_id;
      await supabase.from('orders').update({
        payment_status: 'Paid',
        cf_payment_id:  event.data.payment?.cf_payment_id || '',
        updated_at:     new Date().toISOString(),
      }).eq('id', orderId);
    }
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// SHIPROCKET  (FIX: auto-retry on 401 token expiry)
// ═══════════════════════════════════════════════════════════════

let shiprocketToken       = null;
let shiprocketTokenExpiry = 0;

async function getShiprocketToken(forceRefresh = false) {
  if (!forceRefresh && shiprocketToken && Date.now() < shiprocketTokenExpiry) {
    return shiprocketToken;
  }
  const r = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email:    process.env.SHIPROCKET_EMAIL    || '',
      password: process.env.SHIPROCKET_PASSWORD || '',
    }),
  });
  const data = await r.json();
  if (!data.token) throw new Error('Shiprocket login failed: ' + JSON.stringify(data));
  shiprocketToken       = data.token;
  shiprocketTokenExpiry = Date.now() + (9 * 60 * 60 * 1000); // 9 hours
  return shiprocketToken;
}

async function shiprocketRequest(url, options = {}) {
  const token = await getShiprocketToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  // Auto-refresh if token expired
  if (res.status === 401) {
    const freshToken = await getShiprocketToken(true);
    const retry = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${freshToken}`,
        ...(options.headers || {}),
      },
    });
    return retry.json();
  }
  return res.json();
}

// POST /api/create-shiprocket-order
app.post('/api/create-shiprocket-order', async (req, res) => {
  try {
    const data = await shiprocketRequest(
      'https://apiv2.shiprocket.in/v1/external/orders/create/adhoc',
      { method: 'POST', body: JSON.stringify(req.body) }
    );
    // Save shiprocket order id back to our order
    if (data.order_id && req.body.order_id) {
      await supabase.from('orders').update({
        shiprocket_id: String(data.order_id),
        fulfillment:   'Processing',
        updated_at:    new Date().toISOString(),
      }).eq('id', req.body.order_id);
    }
    res.json(data);
  } catch (err) {
    console.error('Shiprocket error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/track/:awb
app.get('/api/track/:awb', async (req, res) => {
  try {
    const data = await shiprocketRequest(
      `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${req.params.awb}`
    );
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/track-order/:orderId — track by our order id
app.get('/api/track-order/:orderId', async (req, res) => {
  try {
    const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.orderId).single();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (!order.shiprocket_id) {
      return res.json({ status: order.fulfillment || 'Pending', tracking_url: null });
    }

    const trackData = await shiprocketRequest(
      `https://apiv2.shiprocket.in/v1/external/orders/show/${order.shiprocket_id}`
    );
    res.json({
      status:       order.fulfillment,
      shiprocket_id: order.shiprocket_id,
      tracking:     trackData,
    });
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
    const r = await fetch(
      `https://graph.instagram.com/me/media?fields=id,caption,media_url,thumbnail_url,permalink,media_type&limit=6&access_token=${token}`
    );
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
    const r = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`
    );
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
    status:    'ok',
    service:   'Ascovita Backend',
    version:   '4.0.0',
    timestamp: new Date().toISOString(),
    env: {
      supabase:  !!process.env.SUPABASE_URL,
      cashfree:  !!process.env.CASHFREE_APP_ID,
      shiprocket:!!process.env.SHIPROCKET_EMAIL,
      instagram: !!process.env.INSTAGRAM_TOKEN,
    },
    routes: [
      'POST /api/admin/login',
      'GET  /api/admin/stats',
      'GET  /api/admin/orders',
      'PUT  /api/admin/orders/:id',
      'GET  /api/admin/products',
      'GET  /api/admin/customers',
      'GET  /api/admin/coupons',
      'POST /api/admin/coupons',
      'PUT  /api/admin/coupons/:id',
      'GET  /api/products',
      'POST /api/products',
      'PUT  /api/products/:id',
      'POST /api/orders',
      'GET  /api/orders/my',
      'POST /api/coupons/validate',
      'POST /api/create-cashfree-order',
      'GET  /api/verify-order/:id',
      'POST /api/create-shiprocket-order',
      'GET  /api/track/:awb',
      'GET  /api/track-order/:orderId',
      'GET  /api/instagram',
      'GET  /api/settings',
      'PUT  /api/settings',
      'POST /api/auth/google',
      'POST /api/auth/email-login',
      'POST /api/auth/register',
    ]
  });
});

app.listen(PORT, () => console.log(`✅ Ascovita backend v4.0 running on port ${PORT}`));
  });
});

app.listen(PORT, () => console.log(`✅ Ascovita backend v4.0 running on port ${PORT}`));
