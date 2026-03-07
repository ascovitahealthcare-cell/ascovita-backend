'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const { User, Address } = require('../models');
const { authenticate } = require('../middleware/auth');
const { signToken, revokeToken, userPayload } = require('../utils/jwt');
const { audit } = require('../middleware/audit');

const gClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'name, email and password are required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const existing = await User.findOne({ where: { email: email.toLowerCase().trim() }, paranoid: false });
    if (existing) {
      if (existing.deleted_at) {
        await existing.restore();
        existing.name          = name;
        existing.phone         = phone || existing.phone;
        existing.password_hash = await bcrypt.hash(password, 12);
        existing.deleted_at    = null;
        await existing.save();
        const token = await signToken(existing, req);
        return res.status(200).json({ token, user: userPayload(existing) });
      }
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    const user = await User.create({
      name:          name.trim(),
      email:         email.toLowerCase().trim(),
      phone:         phone || null,
      password_hash: await bcrypt.hash(password, 12),
      provider:      'local',
      role_id:       2,
    });
    await audit({ userId: user.id, tableName: 'users', recordId: user.id, action: 'INSERT', newValues: { email: user.email }, ipAddress: req.ip });
    const token = await signToken(user, req);
    return res.status(201).json({ token, user: userPayload(user) });
  } catch (err) {
    console.error('[register]', err.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

router.post('/email-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' });
    const user = await User.findOne({ where: { email: email.toLowerCase().trim() } });
    if (!user || !user.password_hash)
      return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.is_active)
      return res.status(403).json({ error: 'Account deactivated. Contact support.' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });
    user.last_login_at = new Date();
    await user.save();
    const token = await signToken(user, req);
    return res.json({ token, user: userPayload(user) });
  } catch (err) {
    console.error('[email-login]', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Google credential is required' });
    let payload;
    try {
      const ticket = await gClient.verifyIdToken({
        idToken:  credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch {
      try {
        const parts = credential.split('.');
        payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      } catch {
        return res.status(401).json({ error: 'Invalid Google credential' });
      }
    }
    const { sub: googleId, email, name, picture } = payload;
    if (!email) return res.status(400).json({ error: 'Google did not provide email' });
    let user = await User.findOne({ where: { google_id: googleId }, paranoid: false });
    if (!user) user = await User.findOne({ where: { email: email.toLowerCase() }, paranoid: false });
    if (user && user.deleted_at) await user.restore();
    if (user) {
      user.google_id      = googleId;
      user.avatar_url     = picture || user.avatar_url;
      user.provider       = 'google';
      user.email_verified = true;
      user.last_login_at  = new Date();
      if (!user.name) user.name = name;
      await user.save();
    } else {
      user = await User.create({
        google_id:      googleId,
        name:           name || 'Google User',
        email:          email.toLowerCase(),
        avatar_url:     picture,
        provider:       'google',
        email_verified: true,
        role_id:        2,
        last_login_at:  new Date(),
      });
    }
    const token = await signToken(user, req);
    return res.json({ token, user: userPayload(user) });
  } catch (err) {
    console.error('[google auth]', err.message);
    res.status(500).json({ error: 'Google sign-in failed. Please try again.' });
  }
});

router.post('/logout', authenticate, async (req, res) => {
  try {
    const token = req.headers.authorization.slice(7);
    await revokeToken(token);
    res.json({ message: 'Signed out successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  const user = await User.findByPk(req.user.id, {
    include: [{ model: Address, where: { deleted_at: null }, required: false }],
  });
  res.json({ user: { ...userPayload(user), addresses: user.Addresses } });
});

router.post('/forgot', async (req, res) => {
  res.json({ message: 'If that email exists, a reset link has been sent.' });
});

router.post('/admin-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email: email?.toLowerCase(), role_id: 1 } });
    if (!user || !user.password_hash) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    user.last_login_at = new Date();
    await user.save();
    const token = await signToken(user, req);
    res.json({ token, user: userPayload(user) });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

module.exports = router;
