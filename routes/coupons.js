'use strict';
const { Sequelize, DataTypes } = require('sequelize');
const config = require('../config/database');

const env  = process.env.NODE_ENV || 'development';
const conf = config[env];

let sequelize;
if (conf.url) {
  sequelize = new Sequelize(conf.url, conf);
} else {
  sequelize = new Sequelize(conf.database, conf.username, conf.password, conf);
}

// ── Model definitions ──────────────────────────────────────────────────────
const Role = sequelize.define('Role', {
  id:   { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING(50), allowNull: false, unique: true },
}, { tableName: 'roles', timestamps: false });

const User = sequelize.define('User', {
  id:             { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  role_id:        { type: DataTypes.INTEGER, defaultValue: 2 },
  name:           { type: DataTypes.STRING(120), allowNull: false },
  email:          { type: DataTypes.STRING(254), allowNull: false, unique: true },
  phone:          { type: DataTypes.STRING(15) },
  password_hash:  { type: DataTypes.STRING(255) },
  google_id:      { type: DataTypes.STRING(100) },
  avatar_url:     { type: DataTypes.TEXT },
  provider:       { type: DataTypes.ENUM('local','google'), defaultValue: 'local' },
  email_verified: { type: DataTypes.BOOLEAN, defaultValue: false },
  is_active:      { type: DataTypes.BOOLEAN, defaultValue: true },
  last_login_at:  { type: DataTypes.DATE },
  deleted_at:     { type: DataTypes.DATE },
}, {
  tableName: 'users',
  paranoid:  true,     // Sequelize soft-delete (uses deleted_at)
  underscored: true,
});

const Session = sequelize.define('Session', {
  id:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  user_id:    { type: DataTypes.UUID, allowNull: false },
  token_hash: { type: DataTypes.STRING(255), allowNull: false },
  ip_address: { type: DataTypes.STRING(45) },
  user_agent: { type: DataTypes.TEXT },
  expires_at: { type: DataTypes.DATE, allowNull: false },
  revoked:    { type: DataTypes.BOOLEAN, defaultValue: false },
}, { tableName: 'sessions', timestamps: true, updatedAt: false, underscored: true });

const Address = sequelize.define('Address', {
  id:          { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  user_id:     { type: DataTypes.UUID, allowNull: false },
  label:       { type: DataTypes.STRING(50), defaultValue: 'Home' },
  first_name:  { type: DataTypes.STRING(80), allowNull: false },
  last_name:   { type: DataTypes.STRING(80) },
  line1:       { type: DataTypes.STRING(255), allowNull: false },
  line2:       { type: DataTypes.STRING(255) },
  city:        { type: DataTypes.STRING(100), allowNull: false },
  state:       { type: DataTypes.STRING(100), allowNull: false },
  postal_code: { type: DataTypes.STRING(20), allowNull: false },
  country:     { type: DataTypes.STRING(60), defaultValue: 'India' },
  phone:       { type: DataTypes.STRING(15) },
  is_default:  { type: DataTypes.BOOLEAN, defaultValue: false },
  deleted_at:  { type: DataTypes.DATE },
}, { tableName: 'addresses', paranoid: true, underscored: true });

const Category = sequelize.define('Category', {
  id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  parent_id:   { type: DataTypes.INTEGER },
  name:        { type: DataTypes.STRING(100), allowNull: false },
  slug:        { type: DataTypes.STRING(120), allowNull: false, unique: true },
  description: { type: DataTypes.TEXT },
  image_url:   { type: DataTypes.TEXT },
  sort_order:  { type: DataTypes.INTEGER, defaultValue: 0 },
  is_active:   { type: DataTypes.BOOLEAN, defaultValue: true },
  deleted_at:  { type: DataTypes.DATE },
}, { tableName: 'categories', paranoid: true, underscored: true });

const Product = sequelize.define('Product', {
  id:              { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  category_id:     { type: DataTypes.INTEGER },
  sku:             { type: DataTypes.STRING(80), unique: true },
  name:            { type: DataTypes.STRING(255), allowNull: false },
  slug:            { type: DataTypes.STRING(280), unique: true },
  description:     { type: DataTypes.TEXT },
  short_desc:      { type: DataTypes.TEXT },
  brand:           { type: DataTypes.STRING(100), defaultValue: 'Ascovita' },
  mrp:             { type: DataTypes.DECIMAL(10,2), allowNull: false },
  sale_price:      { type: DataTypes.DECIMAL(10,2), allowNull: false },
  cost_price:      { type: DataTypes.DECIMAL(10,2) },
  gst_percent:     { type: DataTypes.DECIMAL(5,2), defaultValue: 18.00 },
  hsn_code:        { type: DataTypes.STRING(20), defaultValue: '30049099' },
  stock:           { type: DataTypes.INTEGER, defaultValue: 0 },
  low_stock_alert: { type: DataTypes.INTEGER, defaultValue: 5 },
  weight_grams:    { type: DataTypes.INTEGER },
  is_active:       { type: DataTypes.BOOLEAN, defaultValue: true },
  is_featured:     { type: DataTypes.BOOLEAN, defaultValue: false },
  sort_order:      { type: DataTypes.INTEGER, defaultValue: 0 },
  meta_title:      { type: DataTypes.STRING(255) },
  meta_desc:       { type: DataTypes.TEXT },
  tiers:           { type: DataTypes.JSONB },
  deleted_at:      { type: DataTypes.DATE },
}, { tableName: 'products', paranoid: true, underscored: true });

const ProductImage = sequelize.define('ProductImage', {
  id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  product_id: { type: DataTypes.INTEGER, allowNull: false },
  url:        { type: DataTypes.TEXT, allowNull: false },
  alt_text:   { type: DataTypes.STRING(255) },
  sort_order: { type: DataTypes.INTEGER, defaultValue: 0 },
  is_primary: { type: DataTypes.BOOLEAN, defaultValue: false },
}, { tableName: 'product_images', timestamps: true, updatedAt: false, underscored: true });

const ProductVariant = sequelize.define('ProductVariant', {
  id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  product_id:  { type: DataTypes.INTEGER, allowNull: false },
  label:       { type: DataTypes.STRING(100), allowNull: false },
  sku:         { type: DataTypes.STRING(80), unique: true },
  price_delta: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
  stock:       { type: DataTypes.INTEGER, defaultValue: 0 },
  is_active:   { type: DataTypes.BOOLEAN, defaultValue: true },
  deleted_at:  { type: DataTypes.DATE },
}, { tableName: 'product_variants', paranoid: true, timestamps: true, updatedAt: false, underscored: true });

const Coupon = sequelize.define('Coupon', {
  id:             { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  code:           { type: DataTypes.STRING(50), allowNull: false, unique: true },
  description:    { type: DataTypes.TEXT },
  type:           { type: DataTypes.ENUM('percent','flat','free_shipping'), allowNull: false },
  value:          { type: DataTypes.DECIMAL(10,2), allowNull: false },
  min_order_amt:  { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
  max_discount:   { type: DataTypes.DECIMAL(10,2) },
  usage_limit:    { type: DataTypes.INTEGER },
  used_count:     { type: DataTypes.INTEGER, defaultValue: 0 },
  per_user_limit: { type: DataTypes.INTEGER, defaultValue: 1 },
  starts_at:      { type: DataTypes.DATE },
  expires_at:     { type: DataTypes.DATE },
  is_active:      { type: DataTypes.BOOLEAN, defaultValue: true },
  deleted_at:     { type: DataTypes.DATE },
}, { tableName: 'coupons', paranoid: true, underscored: true });

const Order = sequelize.define('Order', {
  id:               { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  user_id:          { type: DataTypes.UUID },
  address_id:       { type: DataTypes.UUID },
  coupon_id:        { type: DataTypes.INTEGER },
  order_number:     { type: DataTypes.STRING(30), unique: true },
  snap_name:        DataTypes.STRING(160),
  snap_phone:       DataTypes.STRING(15),
  snap_email:       DataTypes.STRING(254),
  snap_line1:       DataTypes.STRING(255),
  snap_line2:       DataTypes.STRING(255),
  snap_city:        DataTypes.STRING(100),
  snap_state:       DataTypes.STRING(100),
  snap_postal:      DataTypes.STRING(20),
  subtotal:         { type: DataTypes.DECIMAL(10,2), allowNull: false },
  discount_amt:     { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
  shipping_amt:     { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
  tax_amt:          { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
  total:            { type: DataTypes.DECIMAL(10,2), allowNull: false },
  coupon_code:      DataTypes.STRING(50),
  payment_method:   DataTypes.STRING(30),
  payment_status:   { type: DataTypes.ENUM('pending','paid','failed','refunded'), defaultValue: 'pending' },
  cashfree_order_id: DataTypes.STRING(100),
  cashfree_payment_id: DataTypes.STRING(100),
  fulfillment_status: { type: DataTypes.ENUM('pending','processing','shipped','delivered','cancelled','returned'), defaultValue: 'pending' },
  shiprocket_id:    DataTypes.STRING(50),
  tracking_url:     DataTypes.TEXT,
  notes:            DataTypes.TEXT,
  deleted_at:       { type: DataTypes.DATE },
}, { tableName: 'orders', paranoid: true, underscored: true });

const OrderItem = sequelize.define('OrderItem', {
  id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  order_id:    { type: DataTypes.UUID, allowNull: false },
  product_id:  DataTypes.INTEGER,
  variant_id:  DataTypes.INTEGER,
  snap_name:   { type: DataTypes.STRING(255), allowNull: false },
  snap_sku:    DataTypes.STRING(80),
  snap_image:  DataTypes.TEXT,
  unit_price:  { type: DataTypes.DECIMAL(10,2), allowNull: false },
  mrp:         DataTypes.DECIMAL(10,2),
  gst_percent: DataTypes.DECIMAL(5,2),
  quantity:    { type: DataTypes.INTEGER, allowNull: false },
  line_total:  { type: DataTypes.DECIMAL(10,2), allowNull: false },
}, { tableName: 'order_items', timestamps: true, updatedAt: false, underscored: true });

const OrderStatusLog = sequelize.define('OrderStatusLog', {
  id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  order_id:   { type: DataTypes.UUID, allowNull: false },
  changed_by: DataTypes.UUID,
  old_status: DataTypes.STRING(30),
  new_status: { type: DataTypes.STRING(30), allowNull: false },
  note:       DataTypes.TEXT,
}, { tableName: 'order_status_logs', timestamps: true, updatedAt: false, underscored: true });

const Review = sequelize.define('Review', {
  id:            { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  product_id:    { type: DataTypes.INTEGER, allowNull: false },
  user_id:       DataTypes.UUID,
  order_id:      DataTypes.UUID,
  rating:        { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 5 } },
  title:         DataTypes.STRING(120),
  body:          DataTypes.TEXT,
  reviewer_name: DataTypes.STRING(120),
  is_verified:   { type: DataTypes.BOOLEAN, defaultValue: false },
  is_approved:   { type: DataTypes.BOOLEAN, defaultValue: true },
  helpful_count: { type: DataTypes.INTEGER, defaultValue: 0 },
  deleted_at:    DataTypes.DATE,
}, { tableName: 'reviews', paranoid: true, underscored: true });

const Wishlist = sequelize.define('Wishlist', {
  id:         { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  user_id:    { type: DataTypes.UUID, allowNull: false },
  product_id: { type: DataTypes.INTEGER, allowNull: false },
}, { tableName: 'wishlists', timestamps: true, updatedAt: false, underscored: true });

const AuditLog = sequelize.define('AuditLog', {
  id:         { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  user_id:    DataTypes.UUID,
  table_name: { type: DataTypes.STRING(60), allowNull: false },
  record_id:  DataTypes.TEXT,
  action:     DataTypes.ENUM('INSERT','UPDATE','DELETE','SOFT_DELETE','RESTORE'),
  old_values: DataTypes.JSONB,
  new_values: DataTypes.JSONB,
  ip_address: DataTypes.STRING(45),
}, { tableName: 'audit_logs', timestamps: true, updatedAt: false, underscored: true });

// ── Associations ─────────────────────────────────────────────────────────────
User.belongsTo(Role,    { foreignKey: 'role_id' });
Role.hasMany(User,      { foreignKey: 'role_id' });
User.hasMany(Address,   { foreignKey: 'user_id' });
Address.belongsTo(User, { foreignKey: 'user_id' });
User.hasMany(Order,     { foreignKey: 'user_id' });
Order.belongsTo(User,   { foreignKey: 'user_id' });
User.hasMany(Session,   { foreignKey: 'user_id' });
User.hasMany(Review,    { foreignKey: 'user_id' });
User.hasMany(Wishlist,  { foreignKey: 'user_id' });

Category.belongsTo(Category,    { as: 'parent', foreignKey: 'parent_id' });
Category.hasMany(Category,      { as: 'children', foreignKey: 'parent_id' });
Category.hasMany(Product,       { foreignKey: 'category_id' });
Product.belongsTo(Category,     { foreignKey: 'category_id' });
Product.hasMany(ProductImage,   { foreignKey: 'product_id', as: 'images' });
Product.hasMany(ProductVariant, { foreignKey: 'product_id', as: 'variants' });
Product.hasMany(Review,         { foreignKey: 'product_id' });
Product.hasMany(Wishlist,       { foreignKey: 'product_id' });
ProductImage.belongsTo(Product, { foreignKey: 'product_id' });

Order.hasMany(OrderItem,      { foreignKey: 'order_id', as: 'items' });
Order.hasMany(OrderStatusLog, { foreignKey: 'order_id', as: 'statusHistory' });
Order.belongsTo(Coupon,       { foreignKey: 'coupon_id' });
Order.belongsTo(Address,      { foreignKey: 'address_id' });
OrderItem.belongsTo(Order,    { foreignKey: 'order_id' });
OrderItem.belongsTo(Product,  { foreignKey: 'product_id' });

module.exports = {
  sequelize,
  Role, User, Session, Address, Category,
  Product, ProductImage, ProductVariant,
  Coupon, Order, OrderItem, OrderStatusLog,
  Review, Wishlist, AuditLog,
};
