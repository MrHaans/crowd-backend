// src/services/tweetVerifier.js
// Verifikasi tweet via X API READ ONLY (gratis, tidak butuh approval write)
// Hanya butuh Bearer Token dari developer.x.com Free tier

const db = require('../db');

const X_API_BASE = 'https://api.twitter.com/2';

/**
 * Verifikasi apakah tweet dengan ID tertentu:
 * 1. Masih ada / belum dihapus
 * 2. Mengandung hashtag yang wajib (#CROWDProtocol)
 *
 * Menggunakan cache 1 jam untuk menghindari rate limit.
 *
 * @param {string} tweetId
 * @returns {{ valid: boolean, reason?: string, tweet?: object }}
 */
async function verifyTweet(tweetId) {
  // 1. Cek cache dulu
  const cached = await db.query(
    `SELECT * FROM tweet_cache
     WHERE tweet_id = $1 AND cache_expires > NOW()`,
    [tweetId]
  );

  if (cached.rows.length > 0) {
    const c = cached.rows[0];
    if (!c.exists_on_x) {
      return { valid: false, reason: 'TWEET_NOT_FOUND (cached)' };
    }
    // Cek hashtag dari cache
    if (!c.tweet_text?.toLowerCase().includes('#crowdprotocol')) {
      return { valid: false, reason: 'MISSING_REQUIRED_HASHTAG (cached)' };
    }
    return { valid: true, tweet: c };
  }

  // 2. Call X API (read only)
  if (!process.env.X_BEARER_TOKEN) {
    // Dev mode: skip verifikasi jika token tidak ada
    console.warn('[WARN] X_BEARER_TOKEN not set — skipping real verification (dev mode)');
    return { valid: true, tweet: { tweet_id: tweetId, tweet_text: '#CROWDProtocol mock' } };
  }

  let tweetData = null;
  let existsOnX = false;

  try {
    const response = await fetch(
      `${X_API_BASE}/tweets/${tweetId}?tweet.fields=text,created_at,author_id&expansions=author_id&user.fields=username`,
      {
        headers: {
          Authorization: `Bearer ${process.env.X_BEARER_TOKEN}`,
          'User-Agent': 'CROWDProtocolOracle/1.0',
        },
      }
    );

    if (response.status === 200) {
      const body = await response.json();
      tweetData  = body.data;
      existsOnX  = true;

      // Simpan ke cache
      const author = body.includes?.users?.[0];
      await db.query(
        `INSERT INTO tweet_cache
           (tweet_id, exists_on_x, author_id, author_username, tweet_text, tweet_created, cache_expires)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '1 hour')
         ON CONFLICT (tweet_id) DO UPDATE SET
           exists_on_x    = EXCLUDED.exists_on_x,
           tweet_text     = EXCLUDED.tweet_text,
           verified_at    = NOW(),
           cache_expires  = NOW() + INTERVAL '1 hour'`,
        [
          tweetId,
          true,
          author?.id || null,
          author?.username || null,
          tweetData.text,
          tweetData.created_at,
        ]
      );
    } else if (response.status === 404) {
      // Tweet dihapus atau tidak ada
      await db.query(
        `INSERT INTO tweet_cache (tweet_id, exists_on_x, cache_expires)
         VALUES ($1, false, NOW() + INTERVAL '1 hour')
         ON CONFLICT (tweet_id) DO UPDATE SET
           exists_on_x  = false,
           verified_at  = NOW(),
           cache_expires = NOW() + INTERVAL '1 hour'`,
        [tweetId]
      );
    } else {
      throw new Error(`X API returned status ${response.status}`);
    }
  } catch (err) {
    console.error('[tweetVerifier] X API error:', err.message);
    throw new Error(`TWEET_VERIFY_FAILED: ${err.message}`);
  }

  // 3. Validasi hasil
  if (!existsOnX) {
    return { valid: false, reason: 'TWEET_NOT_FOUND' };
  }

  if (!tweetData.text?.toLowerCase().includes('#crowdprotocol')) {
    return { valid: false, reason: 'MISSING_REQUIRED_HASHTAG' };
  }

  return { valid: true, tweet: tweetData };
}

module.exports = { verifyTweet };
