// src/oracle.js
// ============================================================
//  CROWD Oracle Service
//  Berjalan sebagai proses terpisah: node src/oracle.js
//  Setiap 2 menit: cek claim POSTED → verify tweet → confirm on-chain
// ============================================================
require('dotenv').config();
const cron = require('node-cron');

const db               = require('./db');
const { verifyTweet }  = require('./services/tweetVerifier');
const { confirmClaimOnChain, expireClaimOnChain } = require('./services/blockchain');

const POLL_INTERVAL  = process.env.ORACLE_POLL_INTERVAL || '*/2 * * * *'; // setiap 2 menit
const BATCH_SIZE     = 10;   // proses max 10 claim per cycle

console.log('[Oracle] Starting CROWD X-Claim Oracle Service...');
console.log('[Oracle] Poll interval:', POLL_INTERVAL);

// ── LOG HELPER ───────────────────────────────────────────────
async function logAction(claimId, action, result, details = {}) {
  try {
    await db.query(
      `INSERT INTO oracle_logs (claim_id, action, result, details)
       VALUES ($1, $2, $3, $4)`,
      [claimId, action, result, JSON.stringify(details)]
    );
  } catch (err) {
    console.error('[Oracle] Failed to write log:', err.message);
  }
}

// ── MAIN TICK ────────────────────────────────────────────────
async function oracleTick() {
  const tickStart = Date.now();
  console.log(`\n[Oracle] ── Tick ${new Date().toISOString()} ──`);

  try {
    // 1. Ambil claim POSTED (sudah ada tweet URL, belum di-confirm on-chain)
    const { rows: postedClaims } = await db.query(
      `SELECT *
       FROM claims
       WHERE status = 'POSTED'
         AND tweet_id IS NOT NULL
       ORDER BY posted_at ASC
       LIMIT $1`,
      [BATCH_SIZE]
    );

    // 2. Ambil claim PENDING yang sudah expired (timeout tanpa submit URL)
    const { rows: expiredClaims } = await db.query(
      `SELECT *
       FROM claims
       WHERE status = 'PENDING'
         AND expires_at < NOW()
       ORDER BY created_at ASC
       LIMIT $1`,
      [BATCH_SIZE]
    );

    console.log(`[Oracle] Found: ${postedClaims.length} POSTED, ${expiredClaims.length} to EXPIRE`);

    // ── PROSES POSTED CLAIMS ──────────────────────────────────
    for (const claim of postedClaims) {
      console.log(`[Oracle] Processing claim #${claim.claim_id} (tweet: ${claim.tweet_id})`);

      try {
        // Verify tweet masih ada di X
        const verify = await verifyTweet(claim.tweet_id);

        if (verify.valid) {
          // Tweet valid → confirm on-chain → kirim $CROWD
          console.log(`[Oracle] Tweet ${claim.tweet_id} valid → confirming on-chain...`);

          const { txHash } = await confirmClaimOnChain(claim.claim_id, claim.tweet_id);

          await db.query(
            `UPDATE claims
             SET status          = 'COMPLETED',
                 verified_at     = NOW(),
                 completed_at    = NOW(),
                 tx_confirm_hash = $1
             WHERE claim_id = $2`,
            [txHash, claim.claim_id]
          );

          await logAction(claim.claim_id, 'CONFIRM', 'SUCCESS', { txHash, tweetId: claim.tweet_id });
          console.log(`[Oracle] ✓ Claim #${claim.claim_id} COMPLETED. TX: ${txHash}`);

        } else {
          // Tweet tidak valid (dihapus / hashtag hilang)
          // Jika sudah dalam claimWindow, expire. Jika masih ada waktu, biarkan dan cek lagi.
          const claimAge = Date.now() - new Date(claim.created_at).getTime();
          const windowMs = Number(process.env.CLAIM_WINDOW_HOURS || 24) * 3600 * 1000;

          if (claimAge > windowMs) {
            // Sudah expired — expire on-chain
            await expireClaimOnChain(claim.claim_id);
            await db.query(
              `UPDATE claims SET status = 'EXPIRED' WHERE claim_id = $1`,
              [claim.claim_id]
            );
            await logAction(claim.claim_id, 'EXPIRE', 'TWEET_INVALID', { reason: verify.reason });
            console.log(`[Oracle] ✗ Claim #${claim.claim_id} EXPIRED (tweet invalid: ${verify.reason})`);
          } else {
            // Masih ada waktu — revert ke PENDING agar user bisa submit ulang
            await db.query(
              `UPDATE claims
               SET status   = 'PENDING',
                   tweet_id  = NULL,
                   tweet_url = NULL,
                   posted_at = NULL
               WHERE claim_id = $1`,
              [claim.claim_id]
            );
            await logAction(claim.claim_id, 'CHECK_TWEET', 'FAILED', { reason: verify.reason });
            console.log(`[Oracle] ↺ Claim #${claim.claim_id} reverted to PENDING (${verify.reason})`);
          }
        }
      } catch (err) {
        await logAction(claim.claim_id, 'CHECK_TWEET', 'ERROR', { error: err.message });
        console.error(`[Oracle] Error processing claim #${claim.claim_id}:`, err.message);
        // Lanjut ke claim berikutnya, jangan crash oracle
      }

      // Jeda 500ms antar claim untuk hindari rate limit RPC
      await new Promise(r => setTimeout(r, 500));
    }

    // ── EXPIRE PENDING CLAIMS YANG TIMEOUT ───────────────────
    for (const claim of expiredClaims) {
      console.log(`[Oracle] Expiring timed-out claim #${claim.claim_id}...`);
      try {
        await expireClaimOnChain(claim.claim_id);
        await db.query(
          `UPDATE claims SET status = 'EXPIRED' WHERE claim_id = $1`,
          [claim.claim_id]
        );
        await logAction(claim.claim_id, 'EXPIRE', 'TIMEOUT', {});
        console.log(`[Oracle] ✓ Claim #${claim.claim_id} expired (no tweet submitted)`);
      } catch (err) {
        console.error(`[Oracle] Failed to expire claim #${claim.claim_id}:`, err.message);
      }
    }

    const elapsed = Date.now() - tickStart;
    console.log(`[Oracle] Tick complete in ${elapsed}ms`);

  } catch (err) {
    console.error('[Oracle] Fatal tick error:', err.message);
    // Oracle tetap jalan — error per-tick tidak crash process
  }
}

// ── SCHEDULE ─────────────────────────────────────────────────
cron.schedule(POLL_INTERVAL, oracleTick);

// Jalankan sekali saat start
oracleTick();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Oracle] SIGTERM received, shutting down...');
  process.exit(0);
});
