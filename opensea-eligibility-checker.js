#!/usr/bin/env node

/**
 * OpenSea Drop Eligibility Checker
 * Usage: npm start
 *
 * .env format:
 *   OPENSEA_API_KEY=your_key_here  <- opsional
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
  const result = { apiKey: "", privateKeys: [] };
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
      else if (key === "PK_FIRST" || key.startsWith("PK_")) result.privateKeys.push({ label: key, key: val });
    }
  } catch { /* .env not found */ }
  return result;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────
function prompt(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

// ─── Extract slug dari URL ────────────────────────────────────────────────────
function extractSlug(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("collection");
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
    throw new Error("Tidak ketemu 'collection' di URL");
  } catch (e) { throw new Error(`URL tidak valid: ${e.message}`); }
}

// ─── Derive address dari private key ─────────────────────────────────────────
async function getAddress(privateKey) {
  const { ethers } = await import("ethers");
  return new ethers.Wallet(privateKey).address;
}

// ─── Step 1: Minta nonce ──────────────────────────────────────────────────────
async function getNonce(walletAddress) {
  const res = await fetch("https://opensea.io/__api/auth/siwe/nonce", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://opensea.io",
      "Referer": "https://opensea.io/",
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({ address: walletAddress }),
  });
  if (!res.ok) throw new Error(`Nonce error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Ambil cookies dari response
  const cookies = res.headers.getSetCookie?.() ?? [];
  return { nonce: data.nonce, cookies };
}

// ─── Step 2: Build + Sign SIWE message ───────────────────────────────────────
async function signSIWE(privateKey, walletAddress, nonce, collectionUrl) {
  const { ethers } = await import("ethers");
  const wallet = new ethers.Wallet(privateKey);
  const issuedAt = new Date().toISOString();

  const message = {
    domain: "opensea.io",
    address: walletAddress,
    statement: "Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).",
    uri: collectionUrl,
    version: "1",
    chainId: "1",
    nonce,
    issuedAt,
    accountType: "Ethereum",
  };

  // Format SIWE message string
  const siweStr = [
    `${message.domain} wants you to sign in with your Ethereum account:`,
    message.address,
    ``,
    message.statement,
    ``,
    `URI: ${message.uri}`,
    `Version: ${message.version}`,
    `Chain ID: ${message.chainId}`,
    `Nonce: ${message.nonce}`,
    `Issued At: ${message.issuedAt}`,
  ].join("\n");

  const signature = await wallet.signMessage(siweStr);
  return { message, signature };
}

// ─── Step 3: Verify dan dapat JWT ────────────────────────────────────────────
async function verifyAndGetJWT(message, signature, nonceCookies) {
  const cookieHeader = nonceCookies.join("; ");
  const res = await fetch("https://opensea.io/__api/auth/siwe/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": "https://opensea.io",
      "Referer": "https://opensea.io/",
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ...(cookieHeader ? { "Cookie": cookieHeader } : {}),
    },
    body: JSON.stringify({
      message,
      signature,
      chainArch: "EVM",
      connectorId: "io.metamask",
    }),
  });
  if (!res.ok) throw new Error(`Verify error ${res.status}: ${await res.text()}`);

  // Ambil access_token dari Set-Cookie
  const setCookies = res.headers.getSetCookie?.() ?? [];
  let jwt = null;
  for (const c of setCookies) {
    const match = c.match(/access_token=([^;]+)/);
    if (match) { jwt = match[1]; break; }
  }
  return jwt;
}

// ─── Step 4: GraphQL DropEligibilityQuery ────────────────────────────────────
async function queryEligibility(walletAddress, collectionSlug, jwt, apiKey) {
  const headers = {
    "Content-Type": "application/json",
    "Origin": "https://opensea.io",
    "Referer": "https://opensea.io/",
    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "X-App-Id": "opensea-web",
    "X-Build-Id": "mainnet",
  };
  if (apiKey) headers["X-API-KEY"] = apiKey;
  if (jwt) headers["Cookie"] = `access_token=${jwt}`;

  const body = {
    operationName: "DropEligibilityQuery",
    variables: {
      address: walletAddress,
      collectionSlug,
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: "d893f026d731e8f14986921fa4229098e018289f6cc7683f8ee2dd83749dd95d",
      },
    },
  };

  const res = await fetch("https://api.opensea.io/graphql/", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GraphQL error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Fetch drop info (REST) ───────────────────────────────────────────────────
async function fetchDrop(slug, apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-KEY"] = apiKey;
  const res = await fetch(`https://api.opensea.io/api/v2/drops/${slug}`, { headers });
  if (!res.ok) throw new Error(`Drop API ${res.status}: ${await res.text()}`);
  return res.json();
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

// ─── Parse eligibility dari GraphQL response ─────────────────────────────────
function parseEligibility(gqlData, restStages) {
  const gqlStages = gqlData?.data?.dropBySlug?.stages ?? [];
  return gqlStages.map((gs, i) => {
    const restStage = restStages[i] ?? {};
    // Nama dari REST API (lebih deskriptif), fallback ke stageType
    const stageName = restStage.name ?? gs.stageType ?? `Stage ${i + 1}`;
    const isEligible = gs.isEligible;
    const icon = isEligible === true ? "[+]" : isEligible === false ? "[-]" : "[?]";
    const reason = isEligible === true ? "Eligible" : isEligible === false ? "Not eligible" : "Unknown (auth gagal?)";
    return { stageName, icon, reason, isEligible };
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const env = loadEnv();
  const LINE = "═".repeat(62);

  if (env.privateKeys.length === 0) {
    console.error("[!] Tidak ada private key di .env");
    console.error("    Format: PK_FIRST=0x... atau PK_1=0x...");
    process.exit(1);
  }

  const inputUrl = await prompt("\n[?] Masukkan OpenSea collection URL: ");
  if (!inputUrl) { console.error("[!] URL kosong"); process.exit(1); }

  let slug;
  try { slug = extractSlug(inputUrl); }
  catch (e) { console.error(`[!] ${e.message}`); process.exit(1); }

  const cleanUrl = inputUrl.replace(/\/(overview|drop|mint)\/?$/, "");

  console.log(`\n[@] Fetching drop: ${slug} ...`);
  let drop;
  try { drop = await fetchDrop(slug, env.apiKey); }
  catch (e) { console.error(`[!] ${e.message}`); process.exit(1); }

  const restStages = drop.stages ?? [];
  const remaining = (drop.total_supply ?? 0) - (drop.total_minted ?? 0);

  // ── Info drop ──
  console.log(`\n${LINE}`);
  console.log(`[+] ${drop.name ?? slug}`);
  console.log(`[@] Chain  : ${drop.chain ?? "ethereum"}`);
  console.log(`[@] Supply : ${drop.total_supply ?? "?"} total | ${drop.total_minted ?? 0} minted | ${remaining} remaining`);
  console.log(LINE);

  // ── Mint schedule ──
  if (restStages.length === 0) {
    console.log("[!] Tidak ada mint stage.");
  } else {
    console.log(`\n[+] MINT SCHEDULE (${restStages.length} phase)\n`);
    restStages.forEach((s) => {
      const status = stageStatus(s);
      const icon = status === "ACTIVE" ? "[LIVE]" : status === "UPCOMING" ? "[SOON]" : "[END] ";
      const startStr = s.start_time
        ? `${formatDate(s.start_time)}${status === "UPCOMING" ? ` (in ${countdown(s.start_time)})` : ""}`
        : "TBA";
      console.log(`  ${icon} ${s.name ?? "Unknown"}`);
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
    try { walletAddress = await getAddress(privKey); }
    catch { console.log(`\n[!] ${label}: Gagal derive address, install ethers: npm install ethers`); continue; }

    console.log(`\n[@] ${label} | ${walletAddress}`);

    let jwt = null;
    try {
      process.stdout.write(`    [~] Auth SIWE ...`);
      const { nonce, cookies } = await getNonce(walletAddress);
      const { message, signature } = await signSIWE(privKey, walletAddress, nonce, cleanUrl);
      jwt = await verifyAndGetJWT(message, signature, cookies);
      process.stdout.write(`\r    [+] Auth OK${jwt ? "" : " (no JWT)"}\n`);
    } catch (e) {
      process.stdout.write(`\r    [!] Auth gagal: ${e.message}\n`);
    }

    try {
      const gqlData = await queryEligibility(walletAddress, slug, jwt, env.apiKey);
      const results = parseEligibility(gqlData, restStages);

      if (results.length === 0) {
        console.log(`    [?] Tidak ada data eligibility`);
      } else {
        results.forEach((r) => console.log(`    ${r.icon} ${r.stageName}: ${r.reason}`));
      }
    } catch (e) {
      console.log(`    [!] Query gagal: ${e.message}`);
    }
  }

  console.log(`\n[@] ${cleanUrl}`);
  console.log(`${LINE}\n`);
}

main().catch((e) => {
  console.error("[!] Fatal:", e.message);
  process.exit(1);
});
