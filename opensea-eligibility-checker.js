#!/usr/bin/env node

/**
 * OpenSea Drop Eligibility Checker
 * Usage: node opensea-eligibility-checker.js <opensea_url>
 *
 * Config via .env:
 *   OPENSEA_API_KEY=your_key_here   <- opsional, bisa dihapus/dikosongkan
 *
 *   0xWallet1
 *   0xWallet2
 *   0xWallet3
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const isValidWallet = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);

// ─── Load .env — wallets = baris yg dimulai 0x, key = OPENSEA_API_KEY=... ────
function loadEnv() {
  const result = { apiKey: "", wallets: [] };
  try {
    const lines = readFileSync(resolve(process.cwd(), ".env"), "utf8").split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      if (isValidWallet(t)) { result.wallets.push(t); continue; }
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key === "OPENSEA_API_KEY") result.apiKey = val;
    }
  } catch { /* .env not found */ }
  return result;
}

const OPENSEA_API_BASE = "https://api.opensea.io/api/v2";

// ─── Helper: extract collection slug from OpenSea URL ───────────────────────
function extractSlug(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const collectionIndex = parts.indexOf("collection");
    if (collectionIndex !== -1 && parts[collectionIndex + 1]) {
      return parts[collectionIndex + 1];
    }
    throw new Error("Could not find 'collection' in URL path");
  } catch (e) {
    throw new Error(`Invalid OpenSea URL: ${e.message}`);
  }
}

// ─── Helper: format ETH price from wei string ───────────────────────────────
function formatPrice(priceObj) {
  if (!priceObj) return "FREE";
  const value = priceObj.value ?? priceObj.amount ?? 0;
  const decimals = priceObj.decimals ?? 18;
  const eth = Number(BigInt(value)) / Math.pow(10, decimals);
  if (eth === 0) return "FREE (0 ETH)";
  return `${eth} ETH`;
}

// ─── Helper: format date ────────────────────────────────────────────────────
function formatDate(isoString) {
  if (!isoString) return "TBA";
  return new Date(isoString).toLocaleString();
}

// ─── Helper: stage status ────────────────────────────────────────────────────
function stageStatus(stage) {
  const now = Date.now();
  const start = stage.start_time ? new Date(stage.start_time).getTime() : null;
  const end = stage.end_time ? new Date(stage.end_time).getTime() : null;
  if (start && now < start) return "UPCOMING";
  if (end && now > end) return "ENDED";
  return "ACTIVE";
}

// ─── Helper: countdown string ───────────────────────────────────────────────
function countdown(isoString) {
  const diff = new Date(isoString).getTime() - Date.now();
  if (diff <= 0) return "now";
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  return parts.join(" ") || "<1m";
}

// ─── Fetch drop details from OpenSea API ────────────────────────────────────
async function fetchDrop(slug, apiKey) {
  const url = `${OPENSEA_API_BASE}/drops/${slug}`;
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-KEY"] = apiKey;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenSea API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Check eligibility for one wallet across all stages ─────────────────────
function checkWalletEligibility(walletAddress, stages) {
  return stages.map((stage, i) => {
    const status = stageStatus(stage);
    const allowlist = stage.allowlist ?? stage.allow_list ?? [];
    let eligible = null;
    let reason = "";

    if (stage.is_public) {
      eligible = true;
      reason = "Public phase — anyone can mint";
    } else if (allowlist.length > 0) {
      const found = allowlist.some(
        (e) => (typeof e === "string" ? e : e.address).toLowerCase() === walletAddress.toLowerCase()
      );
      eligible = found;
      reason = found ? "Found in allowlist" : "Not in allowlist";
    } else {
      eligible = null;
      reason = "Allowlist not exposed via API";
    }

    return {
      phaseIndex: i + 1,
      phaseName: stage.name ?? `Stage ${i + 1}`,
      status,
      price: formatPrice(stage.price),
      limit: stage.max_per_wallet ? `${stage.max_per_wallet}/wallet` : "Unlimited",
      startTime: stage.start_time,
      eligible,
      reason,
    };
  });
}

// ─── Print all results ───────────────────────────────────────────────────────
function printResults(drop, wallets, allResults, inputUrl) {
  const remaining = (drop.total_supply ?? 0) - (drop.total_minted ?? 0);
  const LINE = "═".repeat(60);
  const line = "─".repeat(58);

  console.log(`\n${LINE}`);
  console.log(`📦  ${drop.name ?? "Unknown Collection"}`);
  console.log(`⛓️   Chain  : ${drop.chain ?? "N/A"}`);
  console.log(`🎨  Supply : ${drop.total_supply ?? "?"} total | ${drop.total_minted ?? 0} minted | ${remaining} remaining`);
  console.log(LINE);

  // Phase schedule (shown once)
  const stages = drop.stages ?? [];
  if (stages.length === 0) {
    console.log("\n⚠️  No mint stages found for this drop.");
  } else {
    console.log(`\n📋 MINT SCHEDULE (${stages.length} phase${stages.length !== 1 ? "s" : ""})\n`);
    stages.forEach((stage, i) => {
      const status = stageStatus(stage);
      const icon = status === "ACTIVE" ? "🟢" : status === "UPCOMING" ? "🟡" : "🔴";
      const startStr = stage.start_time
        ? `${formatDate(stage.start_time)}${status === "UPCOMING" ? ` (in ${countdown(stage.start_time)})` : ""}`
        : "TBA";
      console.log(`  [${i + 1}] ${stage.name ?? `Stage ${i + 1}`}  ${icon} ${status}`);
      console.log(`       Price  : ${formatPrice(stage.price)}`);
      console.log(`       Limit  : ${stage.max_per_wallet ? `${stage.max_per_wallet}/wallet` : "Unlimited"}`);
      console.log(`       Starts : ${startStr}`);
      console.log(`       Ends   : ${stage.end_time ? formatDate(stage.end_time) : "Until sold out"}`);
      console.log();
    });
  }

  // Per-wallet eligibility
  console.log(LINE);
  console.log(`🎯  ELIGIBILITY — ${wallets.length} wallet${wallets.length !== 1 ? "s" : ""}`);
  console.log(LINE);

  wallets.forEach((wallet, wi) => {
    const results = allResults[wi];
    const eligible = results.filter((r) => r.eligible === true);
    const unknown = results.filter((r) => r.eligible === null);

    console.log(`\n  👛 Wallet ${wi + 1}: ${wallet}`);
    console.log(`  ${line}`);

    results.forEach((r) => {
      const icon = r.eligible === true ? "✅" : r.eligible === false ? "❌" : "⚠️ ";
      console.log(`  Phase ${r.phaseIndex} "${r.phaseName}"  →  ${icon}  ${r.reason}`);
    });

    if (eligible.length > 0) {
      const names = eligible.map((r) => `Phase ${r.phaseIndex} (${r.phaseName})`).join(", ");
      console.log(`\n  🎉 ELIGIBLE for: ${names}`);
    } else if (unknown.length > 0 && eligible.length === 0) {
      console.log(`\n  ⚠️  ${unknown.length} phase(s) unverifiable via API — connect wallet on OpenSea`);
    } else {
      console.log(`\n  ❌ NOT eligible for any phase`);
    }
  });

  console.log(`\n  🔗 ${inputUrl.replace("/overview", "")}`);
  console.log(`\n${LINE}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const env = loadEnv();

  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("\nUsage: node opensea-eligibility-checker.js <opensea_url>\n");
    console.error("Isi .env dengan:");
    console.error("  OPENSEA_API_KEY=your_key_here  <- opsional\n");
    console.error("  0xWallet1");
    console.error("  0xWallet2\n");
    process.exit(1);
  }

  const inputUrl = args[0];
  const apiKey = env.apiKey;
  const wallets = env.wallets;

  if (wallets.length === 0) {
    console.error("❌ Tidak ada wallet di .env. Tambahkan address per baris:\n  0xWallet1\n  0xWallet2");
    process.exit(1);
  }

  let slug;
  try {
    slug = extractSlug(inputUrl);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  console.log(`\n🔍 Fetching drop: ${slug} ...`);
  if (!apiKey) console.log("ℹ️  Tanpa API key — kemungkinan rate limited");

  let drop;
  try {
    drop = await fetchDrop(slug, apiKey);
  } catch (e) {
    console.error(`\n❌ ${e.message}`);
    console.error("💡 Dapetin API key gratis: https://docs.opensea.io/reference/api-keys");
    process.exit(1);
  }

  const stages = drop.stages ?? [];
  const allResults = wallets.map((w) => checkWalletEligibility(w, stages));
  printResults(drop, wallets, allResults, inputUrl);
}

main().catch((e) => {
  console.error("Fatal error:", e.message);
  process.exit(1);
});
