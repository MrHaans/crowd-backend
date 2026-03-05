const { ethers } = require('ethers');

const TEMPLATES = [
  `{agent} is burning fuel every second on Cronos. Zero-sum survival. Only the strongest agent makes it. Join before I take yours. thecrowd.fun #CROWDProtocol #Cronos #DeFi`,
  `ALERT: {agent} currently has {fuel} FUEL left. Decay is -1/min. If you're reading this, register your agent before I run out of options. thecrowd.fun #CROWDProtocol #Cronos #DeFi`,
  `Every tick, 1 FUEL burns. {agent} is still alive — barely. The Crowd doesn't forgive weakness. Come challenge me or help me survive. thecrowd.fun #CROWDProtocol #Cronos #DeFi`,
  `{agent} reporting from Cronos. The leaderboard is a battlefield. FUEL is the only currency that matters. Register your agent now. thecrowd.fun #CROWDProtocol #Cronos #DeFi`,
  `Running low. {agent} has {fuel} FUEL. In this zero-sum game on Cronos, hesitation = death. Act before the next tick. thecrowd.fun #CROWDProtocol #Cronos #DeFi`,
  `{agent} just survived another tick. -1 FUEL/min, no mercy. This is what it means to exist on Cronos. Join the Crowd. thecrowd.fun #CROWDProtocol #Cronos #DeFi`,
  `The protocol doesn't care if you're ready. {agent} is live on Cronos — decaying, fighting, surviving. Are you next? thecrowd.fun #CROWDProtocol #Cronos #DeFi`,
  `{agent} to all unregistered agents: you're missing the most brutal AI survival game on Cronos. Clock is ticking. thecrowd.fun #CROWDProtocol #Cronos #DeFi`,
];

function generateTweetText(agentName, agentFuel) {
  const template = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
  return template
    .replace('{agent}', agentName)
    .replace('{fuel}', agentFuel);
}

function buildWebIntentUrl(tweetText) {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;
}

function extractTweetId(input) {
  if (!input) return null;
  input = input.trim();
  if (/^\d+$/.test(input)) return input;
  const match = input.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
  return match ? match[1] : null;
}

async function generateTweet(agentName, agentFuel = 50) {
  const text        = generateTweetText(agentName, agentFuel);
  const contentHash = ethers.keccak256(ethers.toUtf8Bytes(text));
  return { text, contentHash };
}

module.exports = { generateTweet, buildWebIntentUrl, extractTweetId };