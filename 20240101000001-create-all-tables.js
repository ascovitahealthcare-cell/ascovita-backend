'use strict';
const { AuditLog } = require('../models');

/**
 * Write an audit log entry (fire-and-forget – never throws)
 */
async function audit({ userId, tableName, recordId, action, oldValues, newValues, ipAddress }) {
  try {
    await AuditLog.create({
      user_id:    userId   || null,
      table_name: tableName,
      record_id:  String(recordId || ''),
      action,
      old_values: oldValues || null,
      new_values: newValues || null,
      ip_address: ipAddress || null,
    });
  } catch (err) {
    console.error('[AUDIT] failed to write:', err.message);
  }
}

module.exports = { audit };
