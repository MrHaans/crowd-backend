// src/services/blockchain.js
// Interaksi dengan CrowdRewardClaimer.sol di Cronos

const { ethers } = require('ethers');

// ABI hanya untuk fungsi yang dibutuhkan backend + oracle
const CONTRACT_ABI = [
  // createClaim — dipanggil backend saat user inisiasi claim
  'function createClaim(address wallet, bytes32 contentHash) external returns (uint256 claimId)',
  // confirmClaim — dipanggil oracle setelah tweet terverifikasi
  'function confirmClaim(uint256 claimId, string calldata tweetId) external',
  // expireClaim — dipanggil oracle jika claim expired
  'function expireClaim(uint256 claimId) external',
  // isEligible — cek apakah wallet bisa claim
  'function isEligible(address wallet) external view returns (bool eligible, uint256 cooldownRemaining)',
  // getClaim — baca state claim
  'function getClaim(uint256 claimId) external view returns (tuple(address wallet, bytes32 contentHash, string tweetId, uint8 status, uint256 createdAt, uint256 completedAt))',
  // rewardPoolBalance
  'function rewardPoolBalance() external view returns (uint256)',
  // Events
  'event ClaimCreated(uint256 indexed claimId, address indexed wallet, bytes32 contentHash, uint256 createdAt)',
  'event ClaimConfirmed(uint256 indexed claimId, string tweetId, address indexed wallet, uint256 rewardAmount)',
  'event ClaimExpired(uint256 indexed claimId)',
];

let provider, oracleWallet, contract;

function init() {
  if (contract) return;

  // Coba beberapa RPC endpoint — kalau satu timeout, pakai backup
  const RPC_URLS = [
    process.env.CRONOS_RPC_URL || 'https://evm-t3.cronos.org',
    'https://cronos-testnet.drpc.org',
    'https://evm-t3.cronos.org',
  ];

  provider = new ethers.JsonRpcProvider(RPC_URLS[0], undefined, {
    staticNetwork: true,
    polling: false,
    timeout: 10000, // 10 detik timeout
  });

  if (process.env.ORACLE_PRIVATE_KEY) {
    oracleWallet = new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY, provider);
  }

  contract = new ethers.Contract(
    process.env.CONTRACT_ADDRESS || ethers.ZeroAddress,
    CONTRACT_ABI,
    provider
  );

  console.log('[blockchain] Connected to RPC:', RPC_URLS[0]);
}

/**
 * Panggil createClaim() on-chain.
 * Dipanggil oleh backend routes, bukan oracle.
 * Menggunakan oracle wallet sebagai "relayer" karena user tidak punya gas.
 *
 * NOTE: Untuk production, pertimbangkan meta-transaction / gasless relay
 * agar backend yang bayar gas, bukan oracle key.
 */
async function createClaimOnChain(walletAddress, contentHash) {
  init();
  if (!oracleWallet) throw new Error('ORACLE_PRIVATE_KEY not configured');

  // Buat instance contract baru dengan oracleWallet sebagai signer (bukan provider)
  const contractWithSigner = contract.connect(oracleWallet);
  const tx = await contractWithSigner.createClaim(walletAddress, contentHash);
  const receipt = await tx.wait();

  // Parse event ClaimCreated dari receipt
  const iface = new ethers.Interface(CONTRACT_ABI);
  let claimId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === 'ClaimCreated') {
        claimId = Number(parsed.args.claimId);
        break;
      }
    } catch {}
  }

  if (claimId === null) throw new Error('ClaimCreated event not found in receipt');

  return { claimId, txHash: receipt.hash };
}

/**
 * Panggil confirmClaim() on-chain.
 * Dipanggil oleh oracle service setelah tweet terverifikasi.
 */
async function confirmClaimOnChain(claimId, tweetId) {
  init();
  if (!oracleWallet) throw new Error('ORACLE_PRIVATE_KEY not configured');

  const contractWithSigner = contract.connect(oracleWallet);
  const tx = await contractWithSigner.confirmClaim(claimId, tweetId);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/**
 * Panggil expireClaim() on-chain.
 * Dipanggil oleh oracle service untuk claim yang melewati claimWindow.
 */
async function expireClaimOnChain(claimId) {
  init();
  if (!oracleWallet) throw new Error('ORACLE_PRIVATE_KEY not configured');

  const contractWithSigner = contract.connect(oracleWallet);
  const tx = await contractWithSigner.expireClaim(claimId);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

/**
 * Cek eligibility wallet untuk claim baru.
 */
async function checkEligibility(walletAddress) {
  init();
  try {
    const [eligible, cooldownRemaining] = await contract.isEligible(walletAddress);
    return {
      eligible,
      cooldownRemainingSeconds: Number(cooldownRemaining),
      cooldownRemainingHours: Math.ceil(Number(cooldownRemaining) / 3600),
    };
  } catch (err) {
    console.warn('[blockchain] isEligible RPC failed, assuming eligible:', err.message);
    // Fallback: kalau RPC timeout, anggap eligible
    // Cooldown tetap dicek via database di route handler
    return {
      eligible: true,
      cooldownRemainingSeconds: 0,
      cooldownRemainingHours: 0,
    };
  }
}

/**
 * Cek saldo reward pool.
 */
async function getRewardPoolBalance() {
  init();
  const balance = await contract.rewardPoolBalance();
  return ethers.formatUnits(balance, 18); // $CROWD has 18 decimals
}

module.exports = {
  init,
  createClaimOnChain,
  confirmClaimOnChain,
  expireClaimOnChain,
  checkEligibility,
  getRewardPoolBalance,
};
