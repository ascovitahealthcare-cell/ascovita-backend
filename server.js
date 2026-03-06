// ═══════════════════════════════════════════════════════════════════
// ASCOVITA BACKEND — server.js
// Node.js + Express + Supabase
// Routes: Google OAuth · Products · Orders · Coupons · Cashfree
//         Shiprocket · Instagram · Admin
//
// Deploy on: Render (ascovita-backend.onrender.com)
//
// ENV VARS REQUIRED (set in Render → Environment):
//   SUPABASE_URL            your supabase project URL
//   SUPABASE_SERVICE_KEY    supabase service role key (not anon key)
//   GOOGLE_CLIENT_ID        6793142938-b9sl3d3lh2svjkmcnina8fsh31nut0bu.apps.googleusercontent.com
//   GOOGLE_CLIENT_SECRET    your google oauth client secret
//   JWT_SECRET              any long random string e.g. openssl rand -hex 32
//   CASHFREE_APP_ID         your live cashfree app id
//   CASHFREE_SECRET_KEY     your live cashfree secret key
//   CASHFREE_ENV            PRODUCTION
//   SHIPROCKET_EMAIL        your shiprocket login email
//   SHIPROCKET_PASSWORD     your shiprocket login password
//   INSTAGRAM_TOKEN         your instagram long-lived token
//   RECAPTCHA_SECRET        your recaptcha v3 secret key
//   FRONTEND_URL            https://yourusername.github.io
//   SESSION_SECRET          any long random string
// ═══════════════════════════════════════════════════════════════════

'use strict';

const express    = require('express');
const cors       = require('cors');
const fetch      = require('node-fetch');
const jwt        = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Supabase client ──────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CORS ─────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || 'https://yourusername.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:5500',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) return cb(null, true);
    cb(new Error('CORS: origin not allowed → ' + origin));
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true,
}));
app.options('*', cors());
app.use(express.json({ limit: '2mb' }));

// ── JWT helpers ──────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

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
// GOOGLE OAUTH
// ═══════════════════════════════════════════════════════════════

// POST /api/auth/google
// Body: { credential } — the JWT id_token from Google frontend
// Returns: { token, user }
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Missing credential' });

    // Verify Google id_token
    const googleRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`
    );
    const googleData = await googleRes.json();

    if (googleData.error || googleData.aud !== process.env.GOOGLE_CLIENT_ID) {
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    const { sub: googleId, email, name, picture } = googleData;

    // Upsert user in Supabase
    const { data: existing } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    let user;
    if (existing) {
      // Update Google info if new
      const { data: updated } = await supabase
        .from('users')
        .update({ google_id: googleId, picture, name, updated_at: new Date() })
        .eq('email', email)
        .select()
        .single();
      user = updated || existing;
    } else {
      // Create new user
      const { data: created, error: createErr } = await supabase
        .from('users')
        .insert([{ email, name, picture, google_id: googleId, created_at: new Date() }])
        .select()
        .single();
      if (createErr) throw createErr;
      user = created;
    }

    const token = signToken({ id: user.id, email: user.email, name: user.name });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, picture: user.picture, phone: user.phone || '' } });

  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// POST /api/auth/email-login
// Body: { email, password }
app.post('/api/auth/email-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Missing fields' });

    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (!user || user.password !== Buffer.from(password).toString('base64')) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken({ id: user.id, email: user.email, name: user.name });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, picture: user.picture || '', phone: user.phone || '' } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/register
// Body: { name, email, password, phone }
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });

    const { data: existing } = await supabase.from('users').select('id').eq('email', email).single();
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const { data: user, error } = await supabase
      .from('users')
      .insert([{ name, email, phone, password: Buffer.from(password).toString('base64'), created_at: new Date() }])
      .select()
      .single();
    if (error) throw error;

    const token = signToken({ id: user.id, email: user.email, name: user.name });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, phone: user.phone || '' } });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// GET /api/auth/me — get profile for logged-in user
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const { data: user } = await supabase.from('users').select('id,name,email,phone,picture,address').eq('id', req.user.id).single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// PUT /api/auth/profile — update profile
app.put('/api/auth/profile', authMiddleware, async (req, res) => {
  try {
    const { name, phone, address } = req.body;
    const { data, error } = await supabase
      .from('users')
      .update({ name, phone, address, updated_at: new Date() })
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
// RECAPTCHA VERIFICATION
// ═══════════════════════════════════════════════════════════════

// POST /api/verify-captcha
// Body: { token }
app.post('/api/verify-captcha', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false });

    const r = await fetch(
      `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET}&response=${token}`,
      { method: 'POST' }
    );
    const data = await r.json();
    // score >= 0.5 = human, < 0.5 = likely bot
    res.json({ success: data.success, score: data.score, action: data.action });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// PRODUCTS
// ═══════════════════════════════════════════════════════════════

app.get('/api/products', async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('active', true)
    .order('sort_order', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/products', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('products').insert([req.body]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/products/:id', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('products').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  await supabase.from('products').update({ active: false }).eq('id', req.params.id);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════
// COUPONS
// ═══════════════════════════════════════════════════════════════

app.get('/api/admin/coupons', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('coupons').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/coupons/validate
// Body: { code, subtotal }
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
    if (coupon.min_order && subtotal < coupon.min_order) {
      return res.json({ valid: false, message: `Minimum order ₹${coupon.min_order} required` });
    }
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      return res.json({ valid: false, message: 'This coupon has expired' });
    }
    if (coupon.max_uses && coupon.used_count >= coupon.max_uses) {
      return res.json({ valid: false, message: 'Coupon usage limit reached' });
    }

    const discount = coupon.type === 'percent'
      ? Math.round(subtotal * coupon.value / 100)
      : Math.min(coupon.value, subtotal);

    res.json({
      valid: true,
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
      discount,
      label: coupon.label || (coupon.type === 'percent' ? `${coupon.value}% OFF` : `₹${coupon.value} OFF`),
    });
  } catch (err) {
    res.status(500).json({ valid: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════

app.get('/api/admin/orders', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/orders/my — orders for logged-in user
app.get('/api/orders/my', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/orders — save new order (called after payment success)
app.post('/api/orders', async (req, res) => {
  try {
    const order = {
      ...req.body,
      created_at: new Date(),
      // Attach user_id if JWT provided
      user_id: req.headers.authorization
        ? (verifyToken(req.headers.authorization.replace('Bearer ', ''))?.id || null)
        : null,
    };
    const { data, error } = await supabase.from('orders').insert([order]).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/orders/:id — update order status
app.put('/api/admin/orders/:id', authMiddleware, async (req, res) => {
  const { data, error } = await supabase.from('orders').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ═══════════════════════════════════════════════════════════════
// CASHFREE PAYMENTS
// ═══════════════════════════════════════════════════════════════

const CF_BASE = process.env.CASHFREE_ENV === 'PRODUCTION'
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg';

// POST /api/create-cashfree-order
app.post('/api/create-cashfree-order', async (req, res) => {
  try {
    const { amount, customer_name, customer_email, customer_phone, order_id } = req.body;

    const payload = {
      order_id:          order_id || ('ASC-' + Date.now()),
      order_amount:      amount,
      order_currency:    'INR',
      customer_details:  { customer_id: customer_email, customer_name, customer_email, customer_phone },
      order_meta:        { return_url: `${process.env.FRONTEND_URL}?order_id={order_id}` },
    };

    const r = await fetch(`${CF_BASE}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-version': '2023-08-01',
        'x-client-id':     process.env.CASHFREE_APP_ID,
        'x-client-secret': process.env.CASHFREE_SECRET_KEY,
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    if (!r.ok) throw new Error(data.message || 'Cashfree order creation failed');
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
        'x-api-version': '2023-08-01',
        'x-client-id':     process.env.CASHFREE_APP_ID,
        'x-client-secret': process.env.CASHFREE_SECRET_KEY,
      },
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// SHIPROCKET
// ═══════════════════════════════════════════════════════════════

let shiprocketToken = null;
let shiprocketTokenExpiry = 0;

async function getShiprocketToken() {
  if (shiprocketToken && Date.now() < shiprocketTokenExpiry) return shiprocketToken;
  const r = await fetch('https://apiv2.shiprocket.in/v1/external/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.SHIPROCKET_EMAIL, password: process.env.SHIPROCKET_PASSWORD }),
  });
  const data = await r.json();
  shiprocketToken = data.token;
  shiprocketTokenExpiry = Date.now() + (9 * 60 * 60 * 1000); // 9 hours
  return shiprocketToken;
}

// POST /api/create-shiprocket-order
app.post('/api/create-shiprocket-order', async (req, res) => {
  try {
    const srToken = await getShiprocketToken();
    const r = await fetch('https://apiv2.shiprocket.in/v1/external/orders/create/adhoc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${srToken}` },
      body: JSON.stringify(req.body),
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/track/:awb
app.get('/api/track/:awb', async (req, res) => {
  try {
    const srToken = await getShiprocketToken();
    const r = await fetch(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${req.params.awb}`, {
      headers: { Authorization: `Bearer ${srToken}` },
    });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// INSTAGRAM
// ═══════════════════════════════════════════════════════════════

// GET /api/instagram — latest 5 posts
app.get('/api/instagram', async (req, res) => {
  try {
    const token = process.env.INSTAGRAM_TOKEN;
    if (!token) return res.status(500).json({ error: 'INSTAGRAM_TOKEN not set in env vars' });

    const r = await fetch(
      `https://graph.instagram.com/me/media?fields=id,caption,media_url,thumbnail_url,permalink,media_type,like_count,comments_count&limit=5&access_token=${token}`
    );
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/instagram/refresh — refresh the 60-day token
app.get('/api/instagram/refresh', async (req, res) => {
  try {
    const token = process.env.INSTAGRAM_TOKEN;
    const r = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${token}`
    );
    const data = await r.json();
    // Update INSTAGRAM_TOKEN in Render env vars manually with data.access_token
    res.json({ new_token: data.access_token, expires_in: data.expires_in });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Ascovita Backend',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
    routes: [
      'POST /api/auth/google',
      'POST /api/auth/email-login',
      'POST /api/auth/register',
      'GET  /api/auth/me',
      'PUT  /api/auth/profile',
      'POST /api/verify-captcha',
      'GET  /api/products',
      'POST /api/coupons/validate',
      'POST /api/orders',
      'GET  /api/orders/my',
      'POST /api/create-cashfree-order',
      'GET  /api/verify-order/:id',
      'POST /api/create-shiprocket-order',
      'GET  /api/track/:awb',
      'GET  /api/instagram',
    ]
  });
});

app.listen(PORT, () => console.log(`✅ Ascovita backend running on port ${PORT}`));
