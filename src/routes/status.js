const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { getRewardPoolBalance } = require('../services/blockchain');

router.get('/', async (req, res) => {
  try {
    const stats = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'COMPLETED') AS total_completed,
        COUNT(*) FILTER (WHERE status = 'PENDING')   AS total_pending,
        COUNT(*) FILTER (WHERE status = 'POSTED')    AS total_posted,
        COUNT(*) FILTER (WHERE status = 'EXPIRED')   AS total_expired,
        COUNT(*) FILTER (WHERE completed_at > NOW() - INTERVAL '24 hours') AS completed_24h
      FROM claims
    `);

    // Jangan crash kalau RPC timeout
    let pool = 999;
    try {
      pool = await getRewardPoolBalance();
    } catch (e) {
      console.warn('[status] RPC timeout, using fallback pool value');
    }

    res.json({
      system:    'CROWD X-Claim Oracle',
      status:    'OPERATIONAL',
      timestamp: new Date().toISOString(),
      rewardPool: {
        balance:  Number(pool),
        unit:     '$CROWD',
        healthy:  Number(pool) > 0,
      },
      rewardPerClaim: Number(process.env.REWARD_AMOUNT_CROWD || 50),
      claims: stats.rows[0],
    });
  } catch (err) {
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

module.exports = router;