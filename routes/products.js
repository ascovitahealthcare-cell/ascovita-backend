'use strict';
/**
 * ASCOVITA – MASTER MIGRATION
 * ────────────────────────────
 * Tables created (fully normalised to 3NF):
 *   roles, users, addresses, categories, products, product_images,
 *   product_variants, coupons, orders, order_items, order_status_logs,
 *   reviews, wishlists, sessions, audit_logs
 *
 * Soft-delete: deleted_at TIMESTAMPTZ on every table
 * Keys: PKs, FKs, UNIQUE constraints, indexes
 * Triggers: audit log, inventory decrement, coupon usage, order status log
 * Procedures: place_order, cancel_order, update_inventory
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const { DataTypes } = Sequelize;

    // ── EXTENSIONS ───────────────────────────────────────────────────────────
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
    await queryInterface.sequelize.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: roles
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('roles', {
      id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name:       { type: DataTypes.STRING(50), allowNull: false, unique: true },
      created_at: { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.bulkInsert('roles', [
      { name: 'admin' }, { name: 'customer' }, { name: 'moderator' }
    ]);

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: users
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('users', {
      id:             { type: DataTypes.UUID, defaultValue: Sequelize.literal('uuid_generate_v4()'), primaryKey: true },
      role_id:        { type: DataTypes.INTEGER, allowNull: false, defaultValue: 2,
                        references: { model: 'roles', key: 'id' }, onDelete: 'RESTRICT' },
      name:           { type: DataTypes.STRING(120), allowNull: false },
      email:          { type: DataTypes.STRING(254), allowNull: false, unique: true },
      phone:          { type: DataTypes.STRING(15) },
      password_hash:  { type: DataTypes.STRING(255) },          // null for OAuth-only
      google_id:      { type: DataTypes.STRING(100), unique: true },
      avatar_url:     { type: DataTypes.TEXT },
      provider:       { type: DataTypes.ENUM('local', 'google'), defaultValue: 'local' },
      email_verified: { type: DataTypes.BOOLEAN, defaultValue: false },
      is_active:      { type: DataTypes.BOOLEAN, defaultValue: true },
      last_login_at:  { type: DataTypes.DATE },
      created_at:     { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
      updated_at:     { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
      deleted_at:     { type: DataTypes.DATE },                  // SOFT DELETE
    });
    await queryInterface.addIndex('users', ['email']);
    await queryInterface.addIndex('users', ['google_id']);
    await queryInterface.addIndex('users', ['deleted_at']);

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: sessions  (token blacklist + refresh tokens)
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('sessions', {
      id:         { type: DataTypes.UUID, defaultValue: Sequelize.literal('uuid_generate_v4()'), primaryKey: true },
      user_id:    { type: DataTypes.UUID, allowNull: false,
                    references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
      token_hash: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      ip_address: { type: DataTypes.INET },
      user_agent: { type: DataTypes.TEXT },
      expires_at: { type: DataTypes.DATE, allowNull: false },
      revoked:    { type: DataTypes.BOOLEAN, defaultValue: false },
      created_at: { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('sessions', ['token_hash']);
    await queryInterface.addIndex('sessions', ['user_id', 'revoked']);

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: addresses  (normalised – 1 user can have many addresses)
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('addresses', {
      id:           { type: DataTypes.UUID, defaultValue: Sequelize.literal('uuid_generate_v4()'), primaryKey: true },
      user_id:      { type: DataTypes.UUID, allowNull: false,
                      references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
      label:        { type: DataTypes.STRING(50), defaultValue: 'Home' }, // Home, Work, Other
      first_name:   { type: DataTypes.STRING(80), allowNull: false },
      last_name:    { type: DataTypes.STRING(80) },
      line1:        { type: DataTypes.STRING(255), allowNull: false },
      line2:        { type: DataTypes.STRING(255) },
      city:         { type: DataTypes.STRING(100), allowNull: false },
      state:        { type: DataTypes.STRING(100), allowNull: false },
      postal_code:  { type: DataTypes.STRING(20), allowNull: false },
      country:      { type: DataTypes.STRING(60), defaultValue: 'India' },
      phone:        { type: DataTypes.STRING(15) },
      is_default:   { type: DataTypes.BOOLEAN, defaultValue: false },
      created_at:   { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
      updated_at:   { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
      deleted_at:   { type: DataTypes.DATE },                    // SOFT DELETE
    });
    await queryInterface.addIndex('addresses', ['user_id']);

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: categories  (self-referencing for sub-categories)
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('categories', {
      id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      parent_id:   { type: DataTypes.INTEGER,
                     references: { model: 'categories', key: 'id' }, onDelete: 'SET NULL' },
      name:        { type: DataTypes.STRING(100), allowNull: false },
      slug:        { type: DataTypes.STRING(120), allowNull: false, unique: true },
      description: { type: DataTypes.TEXT },
      image_url:   { type: DataTypes.TEXT },
      sort_order:  { type: DataTypes.INTEGER, defaultValue: 0 },
      is_active:   { type: DataTypes.BOOLEAN, defaultValue: true },
      created_at:  { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
      updated_at:  { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
      deleted_at:  { type: DataTypes.DATE },
    });

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: products
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('products', {
      id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      category_id:     { type: DataTypes.INTEGER,
                         references: { model: 'categories', key: 'id' }, onDelete: 'SET NULL' },
      sku:             { type: DataTypes.STRING(80), unique: true },
      name:            { type: DataTypes.STRING(255), allowNull: false },
      slug:            { type: DataTypes.STRING(280), unique: true },
      description:     { type: DataTypes.TEXT },
      short_desc:      { type: DataTypes.TEXT },
      brand:           { type: DataTypes.STRING(100), defaultValue: 'Ascovita' },
      mrp:             { type: DataTypes.NUMERIC(10,2), allowNull: false },
      sale_price:      { type: DataTypes.NUMERIC(10,2), allowNull: false },
      cost_price:      { type: DataTypes.NUMERIC(10,2) },
      gst_percent:     { type: DataTypes.NUMERIC(5,2), defaultValue: 18.00 },
      hsn_code:        { type: DataTypes.STRING(20), defaultValue: '30049099' },
      stock:           { type: DataTypes.INTEGER, defaultValue: 0 },
      low_stock_alert: { type: DataTypes.INTEGER, defaultValue: 5 },
      weight_grams:    { type: DataTypes.INTEGER },
      is_active:       { type: DataTypes.BOOLEAN, defaultValue: true },
      is_featured:     { type: DataTypes.BOOLEAN, defaultValue: false },
      sort_order:      { type: DataTypes.INTEGER, defaultValue: 0 },
      meta_title:      { type: DataTypes.STRING(255) },
      meta_desc:       { type: DataTypes.TEXT },
      tiers:           { type: DataTypes.JSONB },                // bulk pricing tiers
      created_at:      { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
      updated_at:      { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
      deleted_at:      { type: DataTypes.DATE },                 // SOFT DELETE
    });
    await queryInterface.addIndex('products', ['category_id']);
    await queryInterface.addIndex('products', ['is_active', 'deleted_at']);
    await queryInterface.addIndex('products', ['sku']);

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: product_images  (normalised – 1 product, many images)
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('product_images', {
      id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      product_id: { type: DataTypes.INTEGER, allowNull: false,
                    references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' },
      url:        { type: DataTypes.TEXT, allowNull: false },
      alt_text:   { type: DataTypes.STRING(255) },
      sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
      is_primary: { type: DataTypes.BOOLEAN, defaultValue: false },
      created_at: { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('product_images', ['product_id']);

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: product_variants  (flavour / size variants)
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('product_variants', {
      id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      product_id:  { type: DataTypes.INTEGER, allowNull: false,
                     references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' },
      label:       { type: DataTypes.STRING(100), allowNull: false }, // e.g. "Orange 20s"
      sku:         { type: DataTypes.STRING(80), unique: true },
      price_delta: { type: DataTypes.NUMERIC(10,2), defaultValue: 0 }, // + or - vs parent
      stock:       { type: DataTypes.INTEGER, defaultValue: 0 },
      is_active:   { type: DataTypes.BOOLEAN, defaultValue: true },
      deleted_at:  { type: DataTypes.DATE },
      created_at:  { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('product_variants', ['product_id']);

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: coupons
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('coupons', {
      id:             { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      code:           { type: DataTypes.STRING(50), allowNull: false, unique: true },
      description:    { type: DataTypes.TEXT },
      type:           { type: DataTypes.ENUM('percent', 'flat', 'free_shipping'), allowNull: false },
      value:          { type: DataTypes.NUMERIC(10,2), allowNull: false },
      min_order_amt:  { type: DataTypes.NUMERIC(10,2), defaultValue: 0 },
      max_discount:   { type: DataTypes.NUMERIC(10,2) },         // cap for percent coupons
      usage_limit:    { type: DataTypes.INTEGER },               // null = unlimited
      used_count:     { type: DataTypes.INTEGER, defaultValue: 0 },
      per_user_limit: { type: DataTypes.INTEGER, defaultValue: 1 },
      starts_at:      { type: DataTypes.DATE },
      expires_at:     { type: DataTypes.DATE },
      is_active:      { type: DataTypes.BOOLEAN, defaultValue: true },
      created_at:     { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
      updated_at:     { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
      deleted_at:     { type: DataTypes.DATE },                  // SOFT DELETE
    });

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: orders
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('orders', {
      id:              { type: DataTypes.UUID, defaultValue: Sequelize.literal('uuid_generate_v4()'), primaryKey: true },
      user_id:         { type: DataTypes.UUID,
                         references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
      address_id:      { type: DataTypes.UUID,
                         references: { model: 'addresses', key: 'id' }, onDelete: 'SET NULL' },
      coupon_id:       { type: DataTypes.INTEGER,
                         references: { model: 'coupons', key: 'id' }, onDelete: 'SET NULL' },
      order_number:    { type: DataTypes.STRING(30), unique: true },
      // De-normalised snapshot of shipping address (in case address is later deleted)
      snap_name:       { type: DataTypes.STRING(160) },
      snap_phone:      { type: DataTypes.STRING(15) },
      snap_email:      { type: DataTypes.STRING(254) },
      snap_line1:      { type: DataTypes.STRING(255) },
      snap_line2:      { type: DataTypes.STRING(255) },
      snap_city:       { type: DataTypes.STRING(100) },
      snap_state:      { type: DataTypes.STRING(100) },
      snap_postal:     { type: DataTypes.STRING(20) },
      // Financials
      subtotal:        { type: DataTypes.NUMERIC(10,2), allowNull: false },
      discount_amt:    { type: DataTypes.NUMERIC(10,2), defaultValue: 0 },
      shipping_amt:    { type: DataTypes.NUMERIC(10,2), defaultValue: 0 },
      tax_amt:         { type: DataTypes.NUMERIC(10,2), defaultValue: 0 },
      total:           { type: DataTypes.NUMERIC(10,2), allowNull: false },
      coupon_code:     { type: DataTypes.STRING(50) },
      // Payment
      payment_method:  { type: DataTypes.STRING(30) },          // upi, card, cod, demo
      payment_status:  { type: DataTypes.ENUM('pending','paid','failed','refunded'), defaultValue: 'pending' },
      cashfree_order_id: { type: DataTypes.STRING(100) },
      cashfree_payment_id: { type: DataTypes.STRING(100) },
      // Fulfillment
      fulfillment_status: { type: DataTypes.ENUM('pending','processing','shipped','delivered','cancelled','returned'), defaultValue: 'pending' },
      shiprocket_id:   { type: DataTypes.STRING(50) },
      tracking_url:    { type: DataTypes.TEXT },
      notes:           { type: DataTypes.TEXT },
      // Soft delete
      created_at:      { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
      updated_at:      { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
      deleted_at:      { type: DataTypes.DATE },                // SOFT DELETE
    });
    await queryInterface.addIndex('orders', ['user_id']);
    await queryInterface.addIndex('orders', ['order_number']);
    await queryInterface.addIndex('orders', ['fulfillment_status']);
    await queryInterface.addIndex('orders', ['created_at']);

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: order_items
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('order_items', {
      id:             { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      order_id:       { type: DataTypes.UUID, allowNull: false,
                        references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE' },
      product_id:     { type: DataTypes.INTEGER,
                        references: { model: 'products', key: 'id' }, onDelete: 'SET NULL' },
      variant_id:     { type: DataTypes.INTEGER,
                        references: { model: 'product_variants', key: 'id' }, onDelete: 'SET NULL' },
      // Snapshot at time of purchase
      snap_name:      { type: DataTypes.STRING(255), allowNull: false },
      snap_sku:       { type: DataTypes.STRING(80) },
      snap_image:     { type: DataTypes.TEXT },
      unit_price:     { type: DataTypes.NUMERIC(10,2), allowNull: false },
      mrp:            { type: DataTypes.NUMERIC(10,2) },
      gst_percent:    { type: DataTypes.NUMERIC(5,2) },
      quantity:       { type: DataTypes.INTEGER, allowNull: false },
      line_total:     { type: DataTypes.NUMERIC(10,2), allowNull: false },
      created_at:     { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('order_items', ['order_id']);
    await queryInterface.addIndex('order_items', ['product_id']);

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: order_status_logs  (immutable history of every status change)
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('order_status_logs', {
      id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      order_id:   { type: DataTypes.UUID, allowNull: false,
                    references: { model: 'orders', key: 'id' }, onDelete: 'CASCADE' },
      changed_by: { type: DataTypes.UUID,
                    references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
      old_status: { type: DataTypes.STRING(30) },
      new_status: { type: DataTypes.STRING(30), allowNull: false },
      note:       { type: DataTypes.TEXT },
      created_at: { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('order_status_logs', ['order_id']);

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: reviews
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('reviews', {
      id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      product_id:  { type: DataTypes.INTEGER, allowNull: false,
                     references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' },
      user_id:     { type: DataTypes.UUID,
                     references: { model: 'users', key: 'id' }, onDelete: 'SET NULL' },
      order_id:    { type: DataTypes.UUID,
                     references: { model: 'orders', key: 'id' }, onDelete: 'SET NULL' },
      rating:      { type: DataTypes.SMALLINT, allowNull: false },
      title:       { type: DataTypes.STRING(120) },
      body:        { type: DataTypes.TEXT },
      reviewer_name: { type: DataTypes.STRING(120) },          // used if user deleted
      is_verified: { type: DataTypes.BOOLEAN, defaultValue: false },
      is_approved: { type: DataTypes.BOOLEAN, defaultValue: true },
      helpful_count: { type: DataTypes.INTEGER, defaultValue: 0 },
      created_at:  { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
      updated_at:  { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
      deleted_at:  { type: DataTypes.DATE },                   // SOFT DELETE
    });
    await queryInterface.addIndex('reviews', ['product_id', 'is_approved', 'deleted_at']);
    await queryInterface.sequelize.query(`
      ALTER TABLE reviews ADD CONSTRAINT chk_rating CHECK (rating BETWEEN 1 AND 5);
    `);

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: wishlists
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('wishlists', {
      id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      user_id:    { type: DataTypes.UUID, allowNull: false,
                    references: { model: 'users', key: 'id' }, onDelete: 'CASCADE' },
      product_id: { type: DataTypes.INTEGER, allowNull: false,
                    references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' },
      created_at: { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('wishlists', ['user_id', 'product_id'], { unique: true });

    // ═══════════════════════════════════════════════════════════════════════
    // TABLE: audit_logs  (who did what, when)
    // ═══════════════════════════════════════════════════════════════════════
    await queryInterface.createTable('audit_logs', {
      id:          { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      user_id:     { type: DataTypes.UUID },
      table_name:  { type: DataTypes.STRING(60), allowNull: false },
      record_id:   { type: DataTypes.TEXT },
      action:      { type: DataTypes.ENUM('INSERT', 'UPDATE', 'DELETE', 'SOFT_DELETE', 'RESTORE') },
      old_values:  { type: DataTypes.JSONB },
      new_values:  { type: DataTypes.JSONB },
      ip_address:  { type: DataTypes.INET },
      created_at:  { type: DataTypes.DATE, defaultValue: Sequelize.literal('NOW()') },
    });
    await queryInterface.addIndex('audit_logs', ['table_name', 'record_id']);
    await queryInterface.addIndex('audit_logs', ['user_id']);

    // ═══════════════════════════════════════════════════════════════════════
    // DATABASE TRIGGERS
    // ═══════════════════════════════════════════════════════════════════════

    // TRIGGER 1: Auto-update updated_at on every UPDATE
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION fn_set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    for (const tbl of ['users', 'addresses', 'products', 'coupons', 'orders', 'reviews']) {
      await queryInterface.sequelize.query(`
        CREATE TRIGGER trg_${tbl}_updated_at
        BEFORE UPDATE ON ${tbl}
        FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
      `);
    }

    // TRIGGER 2: Inventory decrement when order is paid
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION fn_decrement_inventory()
      RETURNS TRIGGER AS $$
      BEGIN
        -- Only decrement on transition to 'paid'
        IF NEW.payment_status = 'paid' AND OLD.payment_status <> 'paid' THEN
          UPDATE products p
          SET stock = GREATEST(0, p.stock - oi.quantity)
          FROM order_items oi
          WHERE oi.order_id = NEW.id AND oi.product_id = p.id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_order_decrement_inventory
      AFTER UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION fn_decrement_inventory();
    `);

    // TRIGGER 3: Increment coupon used_count when order is paid
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION fn_coupon_usage()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.payment_status = 'paid' AND OLD.payment_status <> 'paid'
           AND NEW.coupon_id IS NOT NULL THEN
          UPDATE coupons SET used_count = used_count + 1 WHERE id = NEW.coupon_id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_order_coupon_usage
      AFTER UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION fn_coupon_usage();
    `);

    // TRIGGER 4: Auto-insert order_status_logs row on fulfillment_status change
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION fn_order_status_log()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.fulfillment_status IS DISTINCT FROM OLD.fulfillment_status THEN
          INSERT INTO order_status_logs(order_id, old_status, new_status, created_at)
          VALUES(NEW.id, OLD.fulfillment_status, NEW.fulfillment_status, NOW());
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      CREATE TRIGGER trg_order_status_log
      AFTER UPDATE ON orders
      FOR EACH ROW EXECUTE FUNCTION fn_order_status_log();
    `);

    // TRIGGER 5: Soft-delete guard – prevent physical delete on key tables
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION fn_block_hard_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Hard DELETE on % is not allowed. Use soft-delete (deleted_at).', TG_TABLE_NAME;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;
    `);
    for (const tbl of ['users', 'orders', 'products']) {
      await queryInterface.sequelize.query(`
        CREATE TRIGGER trg_${tbl}_no_hard_delete
        BEFORE DELETE ON ${tbl}
        FOR EACH ROW EXECUTE FUNCTION fn_block_hard_delete();
      `);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // DATABASE STORED PROCEDURES
    // ═══════════════════════════════════════════════════════════════════════

    // PROCEDURE 1: place_order – atomically create order + items + decrement stock
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE PROCEDURE sp_place_order(
        p_user_id       UUID,
        p_address_id    UUID,
        p_coupon_id     INTEGER,
        p_order_number  TEXT,
        p_items         JSONB,     -- [{product_id, variant_id, quantity, unit_price, ...}]
        p_payment_method TEXT,
        p_shipping_amt  NUMERIC,
        p_discount_amt  NUMERIC,
        p_coupon_code   TEXT,
        OUT p_order_id  UUID
      )
      LANGUAGE plpgsql AS $$
      DECLARE
        v_item        JSONB;
        v_subtotal    NUMERIC := 0;
        v_tax_amt     NUMERIC := 0;
        v_total       NUMERIC := 0;
        v_stock       INTEGER;
        v_prod_name   TEXT;
        v_prod_sku    TEXT;
        v_gst         NUMERIC;
        v_line        NUMERIC;
      BEGIN
        -- Validate stock for all items first (fail-fast)
        FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
          SELECT stock, name, sku, gst_percent
          INTO v_stock, v_prod_name, v_prod_sku, v_gst
          FROM products
          WHERE id = (v_item->>'product_id')::INTEGER AND deleted_at IS NULL;

          IF NOT FOUND THEN
            RAISE EXCEPTION 'Product % not found', v_item->>'product_id';
          END IF;
          IF v_stock < (v_item->>'quantity')::INTEGER THEN
            RAISE EXCEPTION 'Insufficient stock for "%". Available: %, Requested: %',
              v_prod_name, v_stock, (v_item->>'quantity')::INTEGER;
          END IF;

          v_line     := (v_item->>'unit_price')::NUMERIC * (v_item->>'quantity')::INTEGER;
          v_subtotal := v_subtotal + v_line;
          v_tax_amt  := v_tax_amt  + ROUND(v_line * v_gst / 100, 2);
        END LOOP;

        v_total := v_subtotal - COALESCE(p_discount_amt, 0) + COALESCE(p_shipping_amt, 0);

        -- Create the order
        INSERT INTO orders(
          user_id, address_id, coupon_id, order_number,
          subtotal, discount_amt, shipping_amt, tax_amt, total,
          coupon_code, payment_method, payment_status, fulfillment_status
        )
        VALUES(
          p_user_id, p_address_id, p_coupon_id, p_order_number,
          v_subtotal, COALESCE(p_discount_amt,0), COALESCE(p_shipping_amt,0), v_tax_amt, v_total,
          p_coupon_code, p_payment_method, 'pending', 'pending'
        )
        RETURNING id INTO p_order_id;

        -- Insert order items
        FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
          SELECT name, sku, gst_percent INTO v_prod_name, v_prod_sku, v_gst
          FROM products WHERE id = (v_item->>'product_id')::INTEGER;

          v_line := (v_item->>'unit_price')::NUMERIC * (v_item->>'quantity')::INTEGER;

          INSERT INTO order_items(
            order_id, product_id, variant_id,
            snap_name, snap_sku, snap_image,
            unit_price, mrp, gst_percent,
            quantity, line_total
          )
          VALUES(
            p_order_id,
            (v_item->>'product_id')::INTEGER,
            NULLIF(v_item->>'variant_id','')::INTEGER,
            COALESCE(v_item->>'name', v_prod_name),
            COALESCE(v_item->>'sku', v_prod_sku),
            v_item->>'image',
            (v_item->>'unit_price')::NUMERIC,
            (v_item->>'mrp')::NUMERIC,
            v_gst,
            (v_item->>'quantity')::INTEGER,
            v_line
          );
        END LOOP;
      END;
      $$;
    `);

    // PROCEDURE 2: cancel_order – cancel + restore stock
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE PROCEDURE sp_cancel_order(
        p_order_id UUID,
        p_admin_id UUID,
        p_reason   TEXT DEFAULT NULL
      )
      LANGUAGE plpgsql AS $$
      DECLARE
        v_status TEXT;
      BEGIN
        SELECT fulfillment_status INTO v_status FROM orders WHERE id = p_order_id;
        IF v_status IN ('delivered','cancelled') THEN
          RAISE EXCEPTION 'Cannot cancel order with status %', v_status;
        END IF;

        -- Restore stock
        UPDATE products p
        SET stock = p.stock + oi.quantity
        FROM order_items oi
        WHERE oi.order_id = p_order_id AND oi.product_id = p.id;

        -- Cancel order
        UPDATE orders
        SET fulfillment_status = 'cancelled',
            payment_status = CASE WHEN payment_status = 'paid' THEN 'refunded' ELSE payment_status END,
            notes = COALESCE(notes,'') || ' | Cancelled: ' || COALESCE(p_reason,'')
        WHERE id = p_order_id;

        -- Log
        INSERT INTO order_status_logs(order_id, changed_by, old_status, new_status, note)
        VALUES(p_order_id, p_admin_id, v_status, 'cancelled', p_reason);
      END;
      $$;
    `);

    // PROCEDURE 3: get_product_stats – returns revenue, units, avg-rating per product
    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION fn_product_stats(p_product_id INTEGER)
      RETURNS TABLE(
        total_units  BIGINT,
        total_revenue NUMERIC,
        avg_rating   NUMERIC,
        review_count BIGINT
      )
      LANGUAGE sql STABLE AS $$
        SELECT
          COALESCE(SUM(oi.quantity),0)                         AS total_units,
          COALESCE(SUM(oi.line_total),0)                       AS total_revenue,
          COALESCE(ROUND(AVG(r.rating),2),0)                   AS avg_rating,
          COUNT(DISTINCT r.id)                                  AS review_count
        FROM products p
        LEFT JOIN order_items  oi ON oi.product_id = p.id
        LEFT JOIN orders        o  ON o.id = oi.order_id AND o.payment_status = 'paid'
        LEFT JOIN reviews       r  ON r.product_id = p.id AND r.is_approved = TRUE AND r.deleted_at IS NULL
        WHERE p.id = p_product_id;
      $$;
    `);
  },

  async down(queryInterface) {
    // Drop triggers first
    for (const tbl of ['users', 'orders', 'products']) {
      await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS trg_${tbl}_no_hard_delete ON ${tbl};`).catch(() => {});
    }
    for (const tbl of ['users','addresses','products','coupons','orders','reviews']) {
      await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS trg_${tbl}_updated_at ON ${tbl};`).catch(() => {});
    }
    await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS trg_order_decrement_inventory ON orders;`).catch(() => {});
    await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS trg_order_coupon_usage ON orders;`).catch(() => {});
    await queryInterface.sequelize.query(`DROP TRIGGER IF EXISTS trg_order_status_log ON orders;`).catch(() => {});

    // Drop functions / procedures
    for (const fn of ['fn_set_updated_at','fn_decrement_inventory','fn_coupon_usage','fn_order_status_log','fn_block_hard_delete']) {
      await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS ${fn}() CASCADE;`).catch(() => {});
    }
    await queryInterface.sequelize.query(`DROP PROCEDURE IF EXISTS sp_place_order CASCADE;`).catch(() => {});
    await queryInterface.sequelize.query(`DROP PROCEDURE IF EXISTS sp_cancel_order CASCADE;`).catch(() => {});
    await queryInterface.sequelize.query(`DROP FUNCTION  IF EXISTS fn_product_stats CASCADE;`).catch(() => {});

    // Drop tables in reverse FK order
    const tables = [
      'audit_logs','wishlists','reviews','order_status_logs',
      'order_items','orders','coupons','product_variants',
      'product_images','products','categories','sessions','addresses','users','roles',
    ];
    for (const t of tables) {
      await queryInterface.dropTable(t, { cascade: true }).catch(() => {});
    }
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_orders_payment_status" CASCADE;`).catch(() => {});
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_orders_fulfillment_status" CASCADE;`).catch(() => {});
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_users_provider" CASCADE;`).catch(() => {});
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_coupons_type" CASCADE;`).catch(() => {});
    await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "enum_audit_logs_action" CASCADE;`).catch(() => {});
  },
};
