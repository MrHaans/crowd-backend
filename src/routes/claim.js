// src/routes/claim.js
// Semua endpoint /api/claim/*

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const router   = express.Router();

const db          = require('../db');
const { generateTweet, buildWebIntentUrl, extractTweetId } = require('../services/tweetGenerator');
const { verifyTweet }   = require('../services/tweetVerifier');
const { createClaimOnChain, checkEligibility, getRewardPoolBalance } = require('../services/blockchain');

// ── GET /api/claim/eligibility?wallet=0x... ──────────────────
// Cek apakah wallet bisa claim sekarang
router.get('/eligibility', async (req, res) => {
  try {
    const { wallet } = req.query;
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'INVALID_WALLET' });
    }

    const walletLower = wallet.toLowerCase();
    const COOLDOWN_HOURS = Number(process.env.COOLDOWN_HOURS || 24);

    // Cek cooldown dari database (lebih reliable dari RPC)
    const lastCompleted = await db.query(
      `SELECT completed_at FROM claims
       WHERE wallet_address = $1 AND status = 'COMPLETED'
       ORDER BY completed_at DESC LIMIT 1`,
      [walletLower]
    );

    let eligible = true;
    let cooldownRemainingSeconds = 0;

    if (lastCompleted.rows.length > 0) {
      const lastTime  = new Date(lastCompleted.rows[0].completed_at);
      const nextTime  = new Date(lastTime.getTime() + COOLDOWN_HOURS * 3600 * 1000);
      const now       = new Date();
      if (now < nextTime) {
        eligible = false;
        cooldownRemainingSeconds = Math.ceil((nextTime - now) / 1000);
      }
    }

    // Cek active claim
    const activeClaim = await db.query(
      `SELECT claim_id, status, created_at, expires_at, tweet_text, tweet_id
      FROM claims
      WHERE wallet_address = $1 AND status IN ('PENDING', 'POSTED')
      ORDER BY created_at DESC LIMIT 1`,
      [wallet.toLowerCase()]
    );

    const activeClaimRow = activeClaim.rows[0] || null;
    const activeClaimNormalized = activeClaimRow ? {
      claimId:   activeClaimRow.claim_id,   // camelCase untuk frontend
      claim_id:  activeClaimRow.claim_id,   // snake_case backup
      status:    activeClaimRow.status,
      createdAt: activeClaimRow.created_at,
      expiresAt: activeClaimRow.expires_at,
      tweetText: activeClaimRow.tweet_text,
      tweetId:   activeClaimRow.tweet_id,
    } : null;

    // Cek reward pool dari RPC — tapi jangan crash kalau timeout
    let rewardPool = 0;
    try {
      rewardPool = await getRewardPoolBalance();
    } catch (e) {
      console.warn('[eligibility] Could not fetch reward pool:', e.message);
      rewardPool = 999; // assume available
    }

    const rewardAmount = Number(process.env.REWARD_AMOUNT_CROWD || 50);

    res.json({
      eligible: eligible && activeClaim.rows.length === 0,
      cooldown: {
        active:           !eligible,
        remainingSeconds: cooldownRemainingSeconds,
        remainingHours:   Math.ceil(cooldownRemainingSeconds / 3600),
      },
      activeClaim: activeClaimNormalized,
      rewardAmount,
      rewardPoolBalance: Number(rewardPool),
      rewardPoolEmpty:   Number(rewardPool) < rewardAmount,
    });
  } catch (err) {
    console.error('[/eligibility]', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── POST /api/claim/initiate ─────────────────────────────────
// Step 1: User klik "Claim $CROWD" → generate tweet, buat claim on-chain
// Body: { wallet: "0x...", agentName: "KRONOS-X", agentFuel: 50 }
router.post('/initiate', async (req, res) => {
  try {
    const { wallet, agentName, agentFuel } = req.body;

    // Validasi input
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'INVALID_WALLET' });
    }
    if (!agentName || agentName.length > 100) {
      return res.status(400).json({ error: 'INVALID_AGENT_NAME' });
    }

    // Cek eligibility
    const eligibility = await checkEligibility(wallet);
    if (!eligibility.eligible) {
      return res.status(400).json({
        error: 'COOLDOWN_ACTIVE',
        cooldownRemainingHours: eligibility.cooldownRemainingHours,
      });
    }

    // Cek tidak ada claim aktif
    const activeClaim = await db.query(
      `SELECT id FROM claims
       WHERE wallet_address = $1 AND status IN ('PENDING','POSTED')`,
      [wallet.toLowerCase()]
    );
    if (activeClaim.rows.length > 0) {
      return res.status(409).json({ error: 'CLAIM_ALREADY_ACTIVE' });
    }

    // Generate tweet via Claude
    const { text: tweetText, contentHash } = await generateTweet(agentName, agentFuel || 50);

    // Buat claim on-chain
    const { claimId, txHash } = await createClaimOnChain(wallet, contentHash);

    // Hitung expires_at
    const expiresAt = new Date(Date.now() + (Number(process.env.CLAIM_WINDOW_HOURS || 24) * 3600 * 1000));

    // Simpan ke database
    await db.query(
      `INSERT INTO claims
         (claim_id, wallet_address, agent_name, tweet_text, content_hash,
          status, tx_create_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7)`,
      [claimId, wallet.toLowerCase(), agentName, tweetText, contentHash, txHash, expiresAt]
    );

    // Build Web Intent URL
    const webIntentUrl = buildWebIntentUrl(tweetText);

    res.json({
      claimId,
      status:       'PENDING',
      tweetText,
      webIntentUrl,
      expiresAt:    expiresAt.toISOString(),
      txHash,
      nextStep:     'Klik webIntentUrl untuk tweet di X, lalu submit URL tweet di /api/claim/submit',
    });
  } catch (err) {
    console.error('[/initiate]', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── POST /api/claim/submit ───────────────────────────────────
// Step 2: User sudah tweet → submit URL tweet untuk diverifikasi
// Body: { claimId: 5, tweetUrl: "https://x.com/user/status/1234567890" }
router.post('/submit', async (req, res) => {
  try {
    const { claimId, tweetUrl } = req.body;

    if (claimId === undefined || claimId === null || !tweetUrl) {
      return res.status(400).json({ error: 'MISSING_FIELDS', required: ['claimId', 'tweetUrl'] });
    }

    // Extract tweet ID dari URL
    const tweetId = extractTweetId(tweetUrl);
    if (!tweetId) {
      return res.status(400).json({
        error:   'INVALID_TWEET_URL',
        message: 'URL harus berformat https://x.com/username/status/1234567890',
      });
    }

    // Ambil claim dari database
    const claimResult = await db.query(
      `SELECT * FROM claims WHERE claim_id = $1`,
      [claimId]
    );
    if (claimResult.rows.length === 0) {
      return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    }

    const claim = claimResult.rows[0];

    if (claim.status !== 'PENDING') {
      return res.status(409).json({ error: 'CLAIM_NOT_PENDING', currentStatus: claim.status });
    }
    if (new Date() > new Date(claim.expires_at)) {
      return res.status(410).json({ error: 'CLAIM_EXPIRED' });
    }

    // Cek tweet ID belum dipakai di claim lain
    const dupCheck = await db.query(
      `SELECT id FROM claims WHERE tweet_id = $1 AND id != $2`,
      [tweetId, claim.id]
    );
    if (dupCheck.rows.length > 0) {
      return res.status(409).json({ error: 'TWEET_ALREADY_USED' });
    }

    // Verifikasi tweet sekarang (langsung, tidak tunggu oracle)
    let verifyResult;
    try {
      verifyResult = await verifyTweet(tweetId);
    } catch (verifyErr) {
      return res.status(502).json({ error: 'VERIFY_FAILED', message: verifyErr.message });
    }

    if (!verifyResult.valid) {
      return res.status(400).json({
        error:   'TWEET_INVALID',
        reason:  verifyResult.reason,
        message: 'Tweet tidak valid atau tidak mengandung #CROWDProtocol',
      });
    }

    // Update claim ke status POSTED — oracle akan pick up dan confirm on-chain
    await db.query(
      `UPDATE claims
       SET status    = 'POSTED',
           tweet_id  = $1,
           tweet_url = $2,
           posted_at = NOW()
       WHERE claim_id = $3`,
      [tweetId, tweetUrl, claimId]
    );

    res.json({
      claimId,
      status:  'POSTED',
      tweetId,
      message: 'Tweet verified! Oracle akan memproses reward dalam beberapa menit.',
      nextStep: `Poll GET /api/claim/${claimId} untuk update status`,
    });
  } catch (err) {
    console.error('[/submit]', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── GET /api/claim/:claimId ──────────────────────────────────
// Polling endpoint — frontend poll ini setiap 5 detik
router.get('/:claimId', async (req, res) => {
  try {
    const { claimId } = req.params;

    const result = await db.query(
      `SELECT
        claim_id, wallet_address, agent_name, status,
        tweet_id, tweet_url, tweet_text, reward_amount,
        created_at, posted_at, completed_at, expires_at,
        tx_create_hash, tx_confirm_hash
        FROM claims WHERE claim_id = $1`,
      [claimId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'CLAIM_NOT_FOUND' });
    }

    const claim = result.rows[0];

    res.json({
      claimId:       claim.claim_id,
      status:        claim.status,
      wallet:        claim.wallet_address,
      agentName:     claim.agent_name,
      tweetId:       claim.tweet_id,
      tweetUrl:      claim.tweet_url,
      tweetText:     claim.tweet_text,
      rewardAmount:  claim.reward_amount
        ? Number(claim.reward_amount) / 1e18
        : Number(process.env.REWARD_AMOUNT_CROWD || 50),
      timestamps: {
        created:   claim.created_at,
        posted:    claim.posted_at,
        completed: claim.completed_at,
        expires:   claim.expires_at,
      },
      txHashes: {
        create:  claim.tx_create_hash,
        confirm: claim.tx_confirm_hash,
      },
    });
  } catch (err) {
    console.error('[/:claimId]', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// ── GET /api/claim/history/:wallet ──────────────────────────
// Semua claim history milik wallet
router.get('/history/:wallet', async (req, res) => {
  try {
    const { wallet } = req.params;
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      return res.status(400).json({ error: 'INVALID_WALLET' });
    }

    const result = await db.query(
      `SELECT
         claim_id, agent_name, status, tweet_id,
         reward_amount, created_at, completed_at
       FROM claims
       WHERE wallet_address = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [wallet.toLowerCase()]
    );

    const stats = await db.query(
      `SELECT total_claims, total_crowd_earned, last_claim_at
       FROM wallets WHERE address = $1`,
      [wallet.toLowerCase()]
    );

    res.json({
      wallet,
      stats: stats.rows[0] || { total_claims: 0, total_crowd_earned: 0 },
      claims: result.rows,
    });
  } catch (err) {
    console.error('[/history]', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// DELETE /api/claim/reset/:wallet — TESTING ONLY, hapus sebelum production
router.delete('/reset/:wallet', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  const { wallet } = req.params;
  await db.query(
    `UPDATE claims SET status = 'EXPIRED'
     WHERE wallet_address = $1 AND status IN ('PENDING','POSTED')`,
    [wallet.toLowerCase()]
  );
  res.json({ ok: true, message: 'Active claims expired' });
});

module.exports = router;
