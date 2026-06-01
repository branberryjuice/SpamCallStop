'use strict';

/**
 * /api/scan — honest phone-number exposure check.
 *
 * POST { phone: "..." }  ->  200 { ok, phone, coverage, brokers, verifiedFindings, ... }
 *                            400 { ok:false, error:'invalid_phone' }
 */

const express = require('express');
const router = express.Router();
const { scan } = require('../lib/scan');

router.post('/scan', express.json(), async (req, res) => {
  try {
    const phone = (req.body && req.body.phone) || '';
    const result = await scan(phone);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    console.error('scan error:', err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

module.exports = router;
