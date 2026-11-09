// Manual probe for the SEMS+ API. Not part of the plugin bundle.
//
// Usage (from the repo root, with a .env file holding ACCOUNT, PASSWORD and STATION_ID):
//   node scripts/sems-probe.mjs          run the full login + data flow and print the responses
//   node scripts/sems-probe.mjs --hash   print the hashed password for manual_testing.http
//
// Tokens and uids are redacted in the output. Do not commit .env.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const LOGIN_HOST = "https://semsplus.goodwe.com";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const APP_UA = "PVMaster/2.9.5 (iPhone; iOS 17.5; Scale/3.00)";

const env = Object.fromEntries(
    readFileSync(".env", "utf8")
        .split(/\r?\n/)
        .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
        .map((line) => {
            const i = line.indexOf("=");
            return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
        })
);

const { ACCOUNT, PASSWORD, STATION_ID } = env;
if (!ACCOUNT || !PASSWORD || !STATION_ID) {
    console.error("Set ACCOUNT, PASSWORD and STATION_ID in .env");
    process.exit(1);
}

const hashPassword = (pwd) => Buffer.from(createHash("md5").update(pwd, "utf8").digest("hex"), "ascii").toString("base64");
const signature = (uid, token) => {
    const ts = Date.now();
    const digest = createHash("sha256").update(`${ts}@${uid}@${token}`, "utf8").digest("hex");
    return Buffer.from(`${digest}@${ts}`, "utf8").toString("base64");
};
const redact = (obj) =>
    JSON.stringify(obj, (k, v) => (["token", "uid", "refreshToken"].includes(k) && v ? "<redacted>" : v), 2);

if (process.argv.includes("--hash")) {
    console.log(`PWD_HASH=${hashPassword(PASSWORD)}`);
    process.exit(0);
}

// 1. Login
const loginRes = await fetch(`${LOGIN_HOST}/web/sems/sems-user/api/v1/auth/cross-login`, {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        "User-Agent": BROWSER_UA,
        Origin: LOGIN_HOST,
        Referer: `${LOGIN_HOST}/`,
        token: JSON.stringify({ uid: "", timestamp: 0, token: "", client: "semsPlusWeb", version: "", language: "en" }),
        "x-signature": signature("", "")
    },
    body: JSON.stringify({ account: ACCOUNT, pwd: hashPassword(PASSWORD), agreement: 1, isChinese: false, isLocal: false })
});
const login = await loginRes.json();
console.log(`### Login (HTTP ${loginRes.status})\n${redact(login)}\n`);

const data = login.data || {};
if (!data.token || !data.uid) process.exit(1);

const api = `https://${new URL(data.api ?? login.api).host}/web/sems`;
const tokenHeader = JSON.stringify({
    uid: data.uid,
    timestamp: String(data.timestamp),
    token: data.token,
    client: "semsPlusWeb",
    version: "",
    language: "en",
    api,
    region: data.region || "eu"
});

const call = async (method, path) => {
    const res = await fetch(`${api}${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/plain, */*",
            "User-Agent": APP_UA,
            token: tokenHeader,
            "x-signature": signature(data.uid, data.token)
        }
    });
    const json = await res.json().catch(() => null);
    console.log(`### ${method} ${path} (HTTP ${res.status})\n${redact(json)}\n`);
    return json?.data;
};

// 2. Station data
const id = encodeURIComponent(STATION_ID);
await call("POST", `/sems-plant/api/portal/stations/basic/info?stationId=${id}`);
const status = await call("GET", `/sems-plant/api/stations/device/all-status?stationId=${id}`);

for (const group of status?.deviceDetailList || []) {
    const type = group.deviceType || "INVERTER";
    for (const entry of group.statusDetailList || []) {
        for (const sn of Object.keys(entry.detailMap || {})) {
            const q = `deviceType=${encodeURIComponent(type)}&pwId=${id}`;
            await call("GET", `/sems-plant/api/equipments/${encodeURIComponent(sn)}/telemetry?${q}`);
            await call("GET", `/sems-plant/api/equipments/${encodeURIComponent(sn)}/telecounting?${q}`);
        }
    }
}
