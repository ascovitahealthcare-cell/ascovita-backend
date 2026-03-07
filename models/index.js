'use strict';
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { User, Session } = require('../models');
const { Op } = require('sequelize');

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token   = header.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session   = await Session.findOne({
      where: { token_hash: tokenHash, revoked: false, expires_at: { [Op.gt]: new Date() } },
    });
    if (!session) return res.status(401).json({ error: 'Session expired or revoked' });

    const user = await User.findByPk(payload.id);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Account not found or inactive' });

    req.user    = user;
    req.session = session;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role_id !== 1) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

async function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  try {
    const token   = header.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await User.findByPk(payload.id);
    if (user && user.is_active) req.user = user;
  } catch (_) {}
  next();
}

module.exports = { authenticate, requireAdmin, optionalAuth };
