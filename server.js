const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ───────────────────────────────────────────────
const CF_APP_ID   = process.env.CASHFREE_APP_ID   || '';
const CF_SECRET   = process.env.CASHFREE_SECRET   || process.env.CASHFREE_SECRET_KEY || '';
const CF_ENV      = (process.env.CASHFREE_ENV     || 'PROD').replace(/"/g,'').toUpperCase();
const SITE_URL    = process.env.SITE_URL          || 'https://darkblue-chimpanzee-556703.hostingersite.com';

// Supabase — URL hardcoded, keys from env (with fallback to publishable key)
const SB_URL      = 'https://frwsjgrrtzhjfflcdjjs.supabase.co';
const SB_ANON     = process.env.SUPABASE_KEY     || 'sb_publishable_hcaCblRtB3GzYihyF23W7w_X4kRAiIU';
const SB_SERVICE  = process.env.SUPABASE_SERVICE || process.env.SUPABASE_SERVICE_KEY || SB_ANON;

const CF_BASE  = CF_ENV === 'PROD'
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg';
const CF_VER   = '2023-08-01';

// Supabase REST helper
function sbHeaders(useService) {
  var key = useService ? SB_SERVICE : SB_ANON;
  return {
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };
}

async function sbGet(table, query) {
  var url = SB_URL + '/rest/v1/' + table + (query ? '?' + query : '');
  var r = await axios.get(url, { headers: sbHeaders(true), timeout: 10000 });
  return r.data;
}

async function sbInsert(table, data) {
  var url = SB_URL + '/rest/v1/' + table;
  var r = await axios.post(url, data, { headers: sbHeaders(true), timeout: 10000 });
  return r.data;
}

async function sbUpdate(table, data, query) {
  var url = SB_URL + '/rest/v1/' + table + '?' + query;
  var r = await axios.patch(url, data, { headers: sbHeaders(true), timeout: 10000 });
  return r.data;
}

async function sbRpc(fn, params) {
  var url = SB_URL + '/rest/v1/rpc/' + fn;
  var r = await axios.post(url, params, { headers: sbHeaders(true), timeout: 10000 });
  return r.data;
}

console.log('=== Ascovita Backend v4.1 (Supabase) ===');
console.log('Cashfree mode :', CF_ENV);
console.log('Supabase URL  :', SB_URL);
console.log('Supabase Key  :', SB_ANON ? SB_ANON.slice(0,20)+'...' : 'NOT SET');
console.log('Service Key   :', SB_SERVICE && SB_SERVICE !== SB_ANON ? 'SET (service_role)' : 'Using anon key');
console.log('CF App ID     :', CF_APP_ID ? CF_APP_ID.slice(0,10)+'...' : 'NOT SET');

// ─── MIDDLEWARE ───────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'] }));
app.options('*', cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── HEALTH ───────────────────────────────────────────────
app.get('/', function(req, res) {
  res.json({
    status: 'ok',
    service: 'Ascovita Backend v4.1',
    cashfree: CF_ENV,
    cashfreeConfigured: !!(CF_APP_ID && CF_SECRET),
    supabase: SB_URL,
    supabaseKey: SB_ANON ? 'configured' : 'MISSING',
    serviceKey: (SB_SERVICE && SB_SERVICE !== SB_ANON) ? 'configured' : 'using_anon',
    timestamp: new Date().toISOString()
  });
});

// ─── DEBUG ────────────────────────────────────────────────
app.get('/api/debug', async function(req, res) {
  var result = { supabaseUrl: SB_URL, keySet: !!SB_ANON, serviceKeySet: SB_SERVICE !== SB_ANON };
  try {
    var r = await axios.get(SB_URL + '/rest/v1/products?limit=1', { headers: sbHeaders(false), timeout: 8000 });
    result.dbConnection = 'OK';
    result.dbStatus = r.status;
    result.productsFound = Array.isArray(r.data) ? r.data.length : 'unknown';
  } catch(e) {
    result.dbConnection = 'FAILED';
    result.dbError = e.message;
    result.dbStatus = e.response ? e.response.status : null;
    result.dbBody = e.response ? e.response.data : null;
  }
  res.json(result);
});


// ════════════════════════════════════════════════════════

// GET all products
app.get('/api/products', async function(req, res) {
  try {
    var data = await sbGet('products', 'active=eq.true&order=id.asc');
    res.json({ success: true, data: data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET single product
app.get('/api/products/:id', async function(req, res) {
  try {
    var data = await sbGet('products', 'id=eq.' + req.params.id);
    res.json({ success: true, data: data[0] || null });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST create product (admin)
app.post('/api/products', async function(req, res) {
  try {
    var data = await sbInsert('products', req.body);
    res.json({ success: true, data: data[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT update product (admin)
app.put('/api/products/:id', async function(req, res) {
  try {
    var body = Object.assign({}, req.body, { updated_at: new Date().toISOString() });
    var data = await sbUpdate('products', body, 'id=eq.' + req.params.id);
    res.json({ success: true, data: data[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════
// COUPONS
// ════════════════════════════════════════════════════════

// Validate coupon
app.post('/api/coupons/validate', async function(req, res) {
  var code    = (req.body.code || '').toUpperCase().trim();
  var amount  = parseFloat(req.body.amount) || 0;

  if (!code) return res.status(400).json({ error: 'Coupon code required' });

  try {
    var rows = await sbGet('coupons', 'code=eq.' + code + '&active=eq.true');
    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired coupon code' });
    }

    var c = rows[0];

    if (c.expires_at && new Date(c.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This coupon has expired' });
    }
    if (c.max_uses && c.used_count >= c.max_uses) {
      return res.status(400).json({ error: 'This coupon has reached its usage limit' });
    }
    if (amount < c.min_order) {
      return res.status(400).json({
        error: 'Minimum order of Rs.' + c.min_order + ' required for this coupon'
      });
    }

    var discount = 0;
    if (c.type === 'percent') discount = Math.round(amount * c.value / 100);
    else if (c.type === 'flat') discount = c.value;
    else if (c.type === 'freeship') discount = 49;

    res.json({
      success: true,
      coupon: c,
      discount: discount,
      finalAmount: Math.max(0, amount - discount)
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════
// ORDERS — CREATE (with Cashfree payment)
// ════════════════════════════════════════════════════════
app.post('/api/orders/create', async function(req, res) {
  console.log('[create-order] received:', JSON.stringify(req.body));

  var orderId       = req.body.orderId || ('AVC-' + Date.now());
  var amount        = parseFloat(req.body.amount);
  var customerName  = (req.body.customerName  || 'Customer').trim();
  var customerEmail = (req.body.customerEmail || 'customer@ascovita.com').trim();
  var customerPhone = String(req.body.customerPhone || '9999999999');
  var items         = req.body.items || [];
  var address       = req.body.address || {};
  var couponCode    = req.body.couponCode || null;
  var discount      = parseFloat(req.body.discount) || 0;
  var shipping      = parseFloat(req.body.shipping) || 0;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  // Clean phone
  var phone = customerPhone.replace(/\D/g,'');
  if (phone.startsWith('91') && phone.length === 12) phone = phone.slice(2);
  if (phone.length !== 10) phone = '9999999999';

  // 1. Save order to Supabase as Pending
  try {
    await sbInsert('orders', {
      id:             orderId,
      customer_name:  customerName,
      customer_email: customerEmail,
      customer_phone: phone,
      address_line1:  address.line1 || '',
      address_line2:  address.line2 || '',
      city:           address.city  || '',
      state:          address.state || '',
      pincode:        address.pincode || '',
      items:          JSON.stringify(items),
      subtotal:       amount + discount - shipping,
      discount:       discount,
      shipping:       shipping,
      total:          amount,
      coupon_code:    couponCode,
      payment_status: 'Pending',
      fulfillment:    'Unfulfilled'
    });
    console.log('[create-order] saved to Supabase:', orderId);
  } catch(dbErr) {
    console.error('[create-order] DB error:', dbErr.message);
    // Continue anyway - payment can proceed even if DB save fails
  }

  // 2. Update/create customer
  try {
    var existCust = await sbGet('customers', 'email=eq.' + encodeURIComponent(customerEmail));
    if (existCust && existCust.length > 0) {
      await sbUpdate('customers',
        {
          total_orders: existCust[0].total_orders + 1,
          total_spent: parseFloat(existCust[0].total_spent) + amount,
          updated_at: new Date().toISOString()
        },
        'email=eq.' + encodeURIComponent(customerEmail)
      );
    } else {
      await sbInsert('customers', {
        name:         customerName,
        email:        customerEmail,
        phone:        phone,
        city:         address.city || '',
        state:        address.state || '',
        total_orders: 1,
        total_spent:  amount
      });
    }
  } catch(custErr) {
    console.warn('[create-order] customer update error:', custErr.message);
  }

  // 3. If no Cashfree credentials, return demo mode
  if (!CF_APP_ID || !CF_SECRET) {
    return res.json({
      success: true,
      demo: true,
      orderId: orderId,
      message: 'Order saved. Add Cashfree credentials to enable real payments.'
    });
  }

  // 4. Create Cashfree payment session
  try {
    var cfPayload = {
      order_id: orderId,
      order_amount: amount.toFixed(2),
      order_currency: 'INR',
      order_note: 'Ascovita Healthcare',
      customer_details: {
        customer_id: 'cust_' + phone,
        customer_name: customerName.slice(0,50),
        customer_email: customerEmail,
        customer_phone: phone
      },
      order_meta: {
        return_url: SITE_URL + '/#order-success?orderId=' + orderId + '&status=SUCCESS',
        notify_url: 'https://ascopayment-2-0.onrender.com/api/webhook'
      }
    };

    var cfRes = await axios.post(CF_BASE + '/orders', cfPayload, {
      headers: {
        'x-client-id': CF_APP_ID,
        'x-client-secret': CF_SECRET,
        'x-api-version': CF_VER,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    var sessionId = cfRes.data.payment_session_id;
    if (!sessionId) throw new Error('No payment_session_id from Cashfree');

    // Save CF order ID to Supabase
    await sbUpdate('orders',
      { cf_order_id: cfRes.data.order_id, updated_at: new Date().toISOString() },
      'id=eq.' + orderId
    ).catch(function(){});

    res.json({
      success: true,
      orderId: orderId,
      paymentSessionId: sessionId,
      orderStatus: cfRes.data.order_status
    });

  } catch(cfErr) {
    var status  = cfErr.response ? cfErr.response.status : 500;
    var cfError = cfErr.response ? cfErr.response.data : null;
    console.error('[create-order] Cashfree error:', status, cfError || cfErr.message);

    res.status(status).json({
      error: cfError ? cfError.message : cfErr.message,
      code:  cfError ? cfError.code   : 'CF_ERROR',
      orderId: orderId
    });
  }
});

// ════════════════════════════════════════════════════════
// PAYMENT VERIFY
// ════════════════════════════════════════════════════════
app.post('/api/payment/verify', async function(req, res) {
  var orderId = req.body.orderId;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  try {
    var cfRes = await axios.get(CF_BASE + '/orders/' + orderId, {
      headers: {
        'x-client-id': CF_APP_ID,
        'x-client-secret': CF_SECRET,
        'x-api-version': CF_VER
      },
      timeout: 10000
    });

    var paid = cfRes.data.order_status === 'PAID';

    if (paid) {
      // Update order in Supabase
      await sbUpdate('orders',
        {
          payment_status: 'Paid',
          updated_at: new Date().toISOString()
        },
        'id=eq.' + orderId
      ).catch(function(){});

      // Update coupon usage if any
      try {
        var orderData = await sbGet('orders', 'id=eq.' + orderId);
        if (orderData && orderData[0] && orderData[0].coupon_code) {
          await sbRpc('increment_coupon_usage', { coupon_code: orderData[0].coupon_code }).catch(function(){});
        }
        // Deduct stock
        if (orderData && orderData[0] && orderData[0].items) {
          var items = typeof orderData[0].items === 'string'
            ? JSON.parse(orderData[0].items)
            : orderData[0].items;
          for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.id) {
              var prod = await sbGet('products', 'id=eq.' + item.id).catch(function(){ return []; });
              if (prod && prod[0]) {
                var newStock = Math.max(0, prod[0].stock - (item.qty || item.quantity || 1));
                await sbUpdate('products', { stock: newStock }, 'id=eq.' + item.id).catch(function(){});
              }
            }
          }
        }
      } catch(stockErr) {
        console.warn('[verify] stock update error:', stockErr.message);
      }
    }

    res.json({
      success: true,
      paid:        paid,
      orderId:     cfRes.data.order_id,
      orderStatus: cfRes.data.order_status,
      amount:      cfRes.data.order_amount
    });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════
// WEBHOOK (Cashfree calls this on payment events)
// ════════════════════════════════════════════════════════
app.post('/api/webhook', express.raw({ type: 'application/json' }), async function(req, res) {
  try {
    var body  = req.body.toString();
    var data  = JSON.parse(body);
    var event = data.type;
    var order = (data.data && data.data.order) ? data.data.order : {};
    var pay   = (data.data && data.data.payment) ? data.data.payment : {};

    console.log('[webhook]', event, order.order_id, pay.payment_status);

    if (event === 'PAYMENT_SUCCESS_WEBHOOK') {
      await sbUpdate('orders',
        {
          payment_status: 'Paid',
          cf_payment_id:  pay.cf_payment_id || '',
          updated_at: new Date().toISOString()
        },
        'id=eq.' + order.order_id
      ).catch(function(){});
    } else if (event === 'PAYMENT_FAILED_WEBHOOK') {
      await sbUpdate('orders',
        { payment_status: 'Failed', updated_at: new Date().toISOString() },
        'id=eq.' + order.order_id
      ).catch(function(){});
    }

    res.json({ status: 'received' });
  } catch(e) {
    console.error('[webhook] error:', e.message);
    res.status(400).json({ error: 'invalid payload' });
  }
});

// ════════════════════════════════════════════════════════
// ADMIN API — ORDERS
// ════════════════════════════════════════════════════════
app.get('/api/admin/orders', async function(req, res) {
  try {
    var query = 'order=created_at.desc&limit=100';
    if (req.query.status)      query += '&payment_status=eq.' + req.query.status;
    if (req.query.fulfillment) query += '&fulfillment=eq.' + req.query.fulfillment;
    var data = await sbGet('orders', query);
    res.json({ success: true, data: data, total: data.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/orders/:id', async function(req, res) {
  try {
    var data = await sbGet('orders', 'id=eq.' + req.params.id);
    res.json({ success: true, data: data[0] || null });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/orders/:id', async function(req, res) {
  try {
    var body = Object.assign({}, req.body, { updated_at: new Date().toISOString() });
    var data = await sbUpdate('orders', body, 'id=eq.' + req.params.id);
    res.json({ success: true, data: data[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════
// ADMIN API — CUSTOMERS
// ════════════════════════════════════════════════════════
app.get('/api/admin/customers', async function(req, res) {
  try {
    var data = await sbGet('customers', 'order=created_at.desc&limit=200');
    res.json({ success: true, data: data, total: data.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════
// ADMIN API — DASHBOARD STATS
// ════════════════════════════════════════════════════════
app.get('/api/admin/stats', async function(req, res) {
  try {
    var orders    = await sbGet('orders',    'order=created_at.desc&limit=1000');
    var customers = await sbGet('customers', 'select=id');
    var products  = await sbGet('products',  'active=eq.true&select=id,stock');

    var paidOrders  = orders.filter(function(o){ return o.payment_status === 'Paid'; });
    var revenue     = paidOrders.reduce(function(s,o){ return s + parseFloat(o.total||0); }, 0);
    var lowStock    = products.filter(function(p){ return p.stock < 20; }).length;

    // Today's orders
    var today = new Date().toISOString().split('T')[0];
    var todayOrders = orders.filter(function(o){
      return o.created_at && o.created_at.startsWith(today);
    });

    res.json({
      success: true,
      stats: {
        totalOrders:    orders.length,
        totalRevenue:   Math.round(revenue),
        totalCustomers: customers.length,
        totalProducts:  products.length,
        lowStockCount:  lowStock,
        todayOrders:    todayOrders.length,
        todayRevenue:   Math.round(todayOrders.filter(function(o){ return o.payment_status==='Paid'; }).reduce(function(s,o){ return s+parseFloat(o.total||0); },0)),
        pendingOrders:  orders.filter(function(o){ return o.fulfillment==='Unfulfilled' && o.payment_status==='Paid'; }).length
      }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════
// ADMIN API — COUPONS
// ════════════════════════════════════════════════════════
app.get('/api/admin/coupons', async function(req, res) {
  try {
    var data = await sbGet('coupons', 'order=created_at.desc');
    res.json({ success: true, data: data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/coupons', async function(req, res) {
  try {
    var data = await sbInsert('coupons', req.body);
    res.json({ success: true, data: data[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/coupons/:id', async function(req, res) {
  try {
    var data = await sbUpdate('coupons', req.body, 'id=eq.' + req.params.id);
    res.json({ success: true, data: data[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════
// ADMIN API — BLOG
// ════════════════════════════════════════════════════════
app.get('/api/admin/blog', async function(req, res) {
  try {
    var data = await sbGet('blog_posts', 'order=created_at.desc');
    res.json({ success: true, data: data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/blog', async function(req, res) {
  try {
    var post = Object.assign({}, req.body);
    if (!post.slug && post.title) {
      post.slug = post.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    }
    var data = await sbInsert('blog_posts', post);
    res.json({ success: true, data: data[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/blog/:id', async function(req, res) {
  try {
    var body = Object.assign({}, req.body, { updated_at: new Date().toISOString() });
    var data = await sbUpdate('blog_posts', body, 'id=eq.' + req.params.id);
    res.json({ success: true, data: data[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── START ────────────────────────────────────────────────
app.listen(PORT, function() {
  console.log('Ascovita Backend running on port', PORT);
});
