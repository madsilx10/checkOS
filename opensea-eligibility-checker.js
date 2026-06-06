#!/usr/bin/env node

/**
 * OpenSea Drop Eligibility Checker
 * Usage: npm start
 *
 * .env format:
 *   OPENSEA_API_KEY=your_key_here     <- opsional
 *   CHAIN=ethereum                    <- default: ethereum
 *   RPC_ethereum=https://eth.llamarpc.com
 *   RPC_base=https://base.llamarpc.com
 *
 *   PK_FIRST=0xprivkey...
 *   PK_1=0xprivkey...
 *   PK_2=0xprivkey...
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { createInterface } from "readline";

// ─── Load .env ────────────────────────────────────────────────────────────────
function loadEnv() {
  const result = { apiKey: "", chain: "ethereum", rpcs: {}, privateKeys: [] };
  try {
    const lines = readFileSync(resolve(process.cwd(), ".env"), "utf8").split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key === "OPENSEA_API_KEY") result.apiKey = val;
      else if (key === "CHAIN") result.chain = val.toLowerCase();
      else if (key.startsWith("RPC_")) result.rpcs[key.slice(4).toLowerCase()] = val;
      else if (key === "PK_FIRST" || key.startsWith("PK_")) result.privateKeys.push({ label: key, key: val });
    }
  } catch { /* .env not found */ }
  return result;
}

// ─── Prompt input ─────────────────────────────────────────────────────────────
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans.trim()); }));
}

// ─── Derive wallet address dari private key ───────────────────────────────────
async function getAddress(privateKey) {
  const { ethers } = await import("ethers");
  const wallet = new ethers.Wallet(privateKey);
  return wallet.address;
}

// ─── Cek eligibility wallet terhadap semua stage ─────────────────────────────
function checkEligibility(walletAddress, stages) {
  return stages.map((s) => {
    const stageName = s.name ?? "Unknown Phase";
    const allowlist = s.allowlist ?? s.allow_list ?? [];
    if (s.is_public) return { stageName, icon: "[+]", reason: "Public phase" };
    if (allowlist.length > 0) {
      const found = allowlist.some(
        (e) => (typeof e === "string" ? e : e.address).toLowerCase() === walletAddress.toLowerCase()
      );
      return { stageName, icon: found ? "[+]" : "[-]", reason: found ? "Eligible" : "Not eligible" };
    }
    return { stageName, icon: "[?]", reason: "Allowlist tidak di-expose API" };
  });
}

// ─── Fetch drop info ──────────────────────────────────────────────────────────
async function fetchDrop(slug, apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-KEY"] = apiKey;
  const res = await fetch(`https://api.opensea.io/api/v2/drops/${slug}`, { headers });
  if (!res.ok) throw new Error(`OpenSea API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Extract slug dari URL ────────────────────────────────────────────────────
function extractSlug(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("collection");
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
    throw new Error("Tidak ketemu 'collection' di URL");
  } catch (e) {
    throw new Error(`URL tidak valid: ${e.message}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatPrice(p) {
  if (!p) return "FREE";
  const eth = Number(BigInt(p.value ?? p.amount ?? 0)) / Math.pow(10, p.decimals ?? 18);
  return eth === 0 ? "FREE" : `${eth} ETH`;
}
function formatDate(iso) {
  if (!iso) return "TBA";
  return new Date(iso).toLocaleString("id-ID");
}
function stageStatus(s) {
  const now = Date.now();
  const start = s.start_time ? new Date(s.start_time).getTime() : null;
  const end = s.end_time ? new Date(s.end_time).getTime() : null;
  if (start && now < start) return "UPCOMING";
  if (end && now > end) return "ENDED";
  return "ACTIVE";
}
function countdown(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "now";
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(" ") || "<1m";
}
function shortAddr(a) { return `${a.slice(0, 6)}...${a.slice(-4)}`; }

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const env = loadEnv();
  const LINE = "═".repeat(62);

  if (env.privateKeys.length === 0) {
    console.error("[@] Tidak ada private key di .env");
    console.error("    Format: PK_FIRST=0x... atau PK_1=0x...");
    process.exit(1);
  }

  // Input URL interaktif
  const inputUrl = await prompt("\n[?] Masukkan OpenSea collection URL: ");
  if (!inputUrl) { console.error("[!] URL tidak boleh kosong"); process.exit(1); }

  let slug;
  try { slug = extractSlug(inputUrl); }
  catch (e) { console.error(`[!] ${e.message}`); process.exit(1); }

  console.log(`\n[@] Fetching drop: ${slug} ...`);

  let drop;
  try { drop = await fetchDrop(slug, env.apiKey); }
  catch (e) { console.error(`[!] ${e.message}`); process.exit(1); }

  const stages = drop.stages ?? [];
  const remaining = (drop.total_supply ?? 0) - (drop.total_minted ?? 0);

  // ── Info drop ──
  console.log(`\n${LINE}`);
  console.log(`[+] ${drop.name ?? slug}`);
  console.log(`[@] Chain  : ${drop.chain ?? env.chain}`);
  console.log(`[@] Supply : ${drop.total_supply ?? "?"} total | ${drop.total_minted ?? 0} minted | ${remaining} remaining`);
  console.log(LINE);

  // ── Mint schedule ──
  if (stages.length === 0) {
    console.log("[!] Tidak ada mint stage ditemukan.");
  } else {
    console.log(`\n[+] MINT SCHEDULE (${stages.length} phase)\n`);
    stages.forEach((s, i) => {
      const status = stageStatus(s);
      const icon = status === "ACTIVE" ? "[LIVE]" : status === "UPCOMING" ? "[SOON]" : "[END] ";
      const startStr = s.start_time
        ? `${formatDate(s.start_time)}${status === "UPCOMING" ? ` (in ${countdown(s.start_time)})` : ""}`
        : "TBA";
      console.log(`  ${icon} ${s.name ?? `Phase ${i + 1}`}`);
      console.log(`         Price  : ${formatPrice(s.price)}`);
      console.log(`         Limit  : ${s.max_per_wallet ? `${s.max_per_wallet}/wallet` : "Unlimited"}`);
      console.log(`         Starts : ${startStr}`);
      console.log(`         Ends   : ${s.end_time ? formatDate(s.end_time) : "Until sold out"}`);
      console.log();
    });
  }

  // ── Cek tiap wallet ──
  console.log(LINE);
  console.log(`[+] CEK ELIGIBILITY — ${env.privateKeys.length} wallet`);
  console.log(LINE);

  for (const { label, key: privKey } of env.privateKeys) {
    let walletAddress;
    try {
      walletAddress = await getAddress(privKey);
    } catch (e) {
      console.log(`\n[!] ${label}: Gagal derive address — install ethers dulu: npm install ethers`);
      continue;
    }

    console.log(`\n[@] ${label} | ${walletAddress}`);

    const results = checkEligibility(walletAddress, stages);
    results.forEach((r) => console.log(`    ${r.icon} ${r.stageName}: ${r.reason}`));
  }

  console.log(`\n[@] ${inputUrl.replace("/overview", "")}`);
  console.log(`${LINE}\n`);
}

main().catch((e) => {
  console.error("[!] Fatal:", e.message);
  process.exit(1);
});
