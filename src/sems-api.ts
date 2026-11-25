import { createHash } from "node:crypto";

/**
 * Client for the GoodWe SEMS+ API.
 *
 * GoodWe has no public documentation for this API. The flow below follows the community
 * reverse-engineering in bueste/ioBroker.goodwe-sems (lib/semsApi.js) and
 * TimSoethout/goodwe-sems-home-assistant (issue #183). Expect it to change without notice.
 *
 * 1. Login:   POST {LOGIN_HOST}/web/sems/sems-user/api/v1/auth/cross-login
 *             (password = base64(md5_hex(password))). Returns uid, token, timestamp and a
 *             region-specific gateway base URL.
 * 2. Gateway: signed calls (x-signature header) against the returned gateway for station info,
 *             the device list, and per-inverter telemetry and telecounting.
 */

// Global SEMS+ login host. Do not loop over regional hosts on failure: repeated logins with the
// same credentials against several hosts can look like credential stuffing and lock the account.
const LOGIN_HOST = "https://semsplus.goodwe.com";
const LOGIN_PATH = "/web/sems/sems-user/api/v1/auth/cross-login";

const BROWSER_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const APP_USER_AGENT = "PVMaster/2.9.5 (iPhone; iOS 17.5; Scale/3.00)";
const CLIENT = "semsPlusWeb";
const RATE_LIMIT_CODE = "GY0429";
const REQUEST_TIMEOUT_MS = 15 * 1000;

export interface SemsTelemetry {
    stationName: string;
    timestamp: string;
    currentW: number;
    currentKw: number;
    dailyKwh: number;
    totalKwh: number;
    capacityKw: number;
}

interface SemsSession {
    uid: string;
    token: string;
    timestamp: string;
    api: string;
    region: string;
}

interface SemsResponse {
    code?: number | string;
    msg?: string;
    message?: string;
    description?: string;
    errorMsg?: string;
    api?: string;
    data?: any;
}

interface SemsDevice {
    sn: string;
    deviceType: string;
}

/** Thrown for errors where re-logging in will not help (bad credentials, rate limiting). */
export class SemsFatalError extends Error {}

export class SemsClient {
    private session: SemsSession | null = null;

    constructor(private readonly account: string, private readonly password: string) {}

    /** Matches the credentials this client was created with. */
    public matches(account: string, password: string): boolean {
        return this.account === account && this.password === password;
    }

    public async getTelemetry(powerStationId: string): Promise<SemsTelemetry> {
        const stationId = encodeURIComponent(powerStationId);

        const info = (await this.gateway("POST", `/sems-plant/api/portal/stations/basic/info?stationId=${stationId}`)) || {};
        const devices = this.parseDevices(
            await this.gateway("GET", `/sems-plant/api/stations/device/all-status?stationId=${stationId}`)
        );

        let currentKw = 0;
        let dailyKwh = 0;
        let totalKwh = 0;

        for (const device of devices) {
            const query = `deviceType=${encodeURIComponent(device.deviceType)}&pwId=${stationId}`;
            const sn = encodeURIComponent(device.sn);

            const telemetry = flattenFactors(await this.gateway("GET", `/sems-plant/api/equipments/${sn}/telemetry?${query}`));
            // Telecounting (daily/total energy) currently fails with A0400 for some accounts. Current
            // power is what the plugin displays, so treat energy counters as best-effort.
            let counting: Record<string, any> = {};
            try {
                counting = flattenFactors(await this.gateway("GET", `/sems-plant/api/equipments/${sn}/telecounting?${query}`, false));
            } catch (error) {
                if (error instanceof SemsFatalError) throw error;
            }

            currentKw += toNumber(telemetry.pAc, 0);
            dailyKwh += toNumber(counting.proPvStatsToday, 0);
            totalKwh += toNumber(counting.proPvStatsTotal, 0);
        }

        return {
            stationName: String(info.name || "SEMS"),
            timestamp: new Date().toISOString(),
            currentW: currentKw * 1000,
            currentKw,
            dailyKwh,
            totalKwh,
            capacityKw: toNumber(info.pvCapacity ?? info.installedPower, 0)
        };
    }

    // Gateway

    /**
     * Signed call against the session's gateway. Re-logs in and retries once on any non-success
     * response (expired sessions are not reported with a reliable code).
     */
    private async gateway(method: "GET" | "POST", path: string, retryLogin = true): Promise<any> {
        let freshSession = false;
        if (!this.session) {
            await this.login();
            freshSession = true;
        }

        try {
            return await this.gatewayOnce(method, path);
        } catch (error) {
            if (error instanceof SemsFatalError || freshSession || !retryLogin) throw error;
            this.session = null;
            await this.login();
            return await this.gatewayOnce(method, path);
        }
    }

    private async gatewayOnce(method: "GET" | "POST", path: string): Promise<any> {
        const session = this.session!;
        const token = JSON.stringify({
            uid: session.uid,
            timestamp: session.timestamp,
            token: session.token,
            client: CLIENT,
            version: "",
            language: "en",
            api: session.api,
            region: session.region
        });

        const json = await this.request(`${session.api}${path}`, {
            method,
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/plain, */*",
                "User-Agent": APP_USER_AGENT,
                token,
                "x-signature": signature(session.uid, session.token)
            }
        });

        return json.data;
    }

    // Login

    private async login(): Promise<void> {
        const token = JSON.stringify({ uid: "", timestamp: 0, token: "", client: CLIENT, version: "", language: "en" });

        let json: SemsResponse;
        try {
            json = await this.request(`${LOGIN_HOST}${LOGIN_PATH}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json, text/plain, */*",
                    "User-Agent": BROWSER_USER_AGENT,
                    Origin: LOGIN_HOST,
                    Referer: `${LOGIN_HOST}/`,
                    token,
                    "x-signature": signature("", "")
                },
                body: JSON.stringify({
                    account: this.account,
                    pwd: hashPassword(this.password),
                    agreement: 1,
                    isChinese: false,
                    isLocal: false
                })
            });
        } catch (error) {
            if (error instanceof SemsFatalError) throw error;
            // A rejected login is not worth retrying: it would just repeat the same credentials.
            throw new SemsFatalError(`SEMS login failed: ${errorMessage(error)}`);
        }

        const data = json.data || {};
        const api = normaliseGatewayBase(data.api ?? json.api);

        if (!data.uid || !data.token || !api) {
            throw new SemsFatalError("SEMS login response missing session details.");
        }

        this.session = {
            uid: String(data.uid),
            token: String(data.token),
            timestamp: String(data.timestamp ?? Date.now()),
            api,
            region: String(data.region || "eu")
        };
    }

    // HTTP

    private async request(url: string, init: RequestInit): Promise<SemsResponse> {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

        if (response.status === 429) {
            throw new SemsFatalError("Rate limited by SEMS. Try again in 5 minutes.");
        }

        let json: SemsResponse;
        try {
            json = (await response.json()) as SemsResponse;
        } catch {
            throw new Error(`SEMS returned HTTP ${response.status} with an invalid body.`);
        }

        if (String(json.code) === RATE_LIMIT_CODE) {
            throw new SemsFatalError("Rate limited by SEMS. Try again in 5 minutes.");
        }

        if (!response.ok) {
            throw new Error(responseMessage(json) || `SEMS returned HTTP ${response.status}.`);
        }

        if (!isSuccess(json)) {
            throw new Error(responseMessage(json) || `SEMS returned code ${json.code}.`);
        }

        return json;
    }

    // Parsing

    /** Walks deviceDetailList[].statusDetailList[].detailMap, where each detailMap key is a device SN. */
    private parseDevices(data: any): SemsDevice[] {
        const devices: SemsDevice[] = [];
        const groups = Array.isArray(data?.deviceDetailList) ? data.deviceDetailList : [];

        for (const group of groups) {
            const deviceType = String(group?.deviceType || "INVERTER");
            const statuses = Array.isArray(group?.statusDetailList) ? group.statusDetailList : [];
            for (const status of statuses) {
                for (const sn of Object.keys(status?.detailMap || {})) {
                    devices.push({ sn, deviceType });
                }
            }
        }

        // Only inverters report PV power. Fall back to everything if no group is labelled as one.
        const inverters = devices.filter((d) => d.deviceType.toUpperCase().includes("INVERTER"));
        return inverters.length > 0 ? inverters : devices;
    }
}

// Helpers

/** SEMS+ expects base64(md5_hex(password)). */
function hashPassword(password: string): string {
    const md5Hex = createHash("md5").update(password, "utf8").digest("hex");
    return Buffer.from(md5Hex, "ascii").toString("base64");
}

/** x-signature = base64(sha256_hex(`${ts}@${uid}@${token}`) + "@" + ts), with ts in epoch ms. */
function signature(uid: string, token: string): string {
    const ts = Date.now();
    const digest = createHash("sha256").update(`${ts}@${uid}@${token}`, "utf8").digest("hex");
    return Buffer.from(`${digest}@${ts}`, "utf8").toString("base64");
}

/** Error bodies use `description`/`errorMsg` (e.g. code 100005), while older ones use `msg`/`message`. */
function responseMessage(json: SemsResponse): string | undefined {
    return json.description || json.errorMsg || json.msg || json.message;
}

function isSuccess(json: SemsResponse): boolean {
    const code = json.code;
    if (code === 0 || code === "0" || code === "00000") return true;
    const msg = String(json.msg || "").toLowerCase();
    return msg === "success" || msg === "successful";
}

/**
 * Accept only https gateways under semsportal.com or goodwe.com, so credentials-derived tokens are
 * never sent elsewhere. Returns `https://<host>/web/sems`.
 */
function normaliseGatewayBase(api: unknown): string | null {
    if (!api) return null;
    try {
        const url = new URL(String(api));
        const host = url.hostname.toLowerCase();
        const trusted = ["semsportal.com", "goodwe.com"].some((d) => host === d || host.endsWith(`.${d}`));
        if (url.protocol !== "https:" || !trusted) return null;
        return `https://${url.host}/web/sems`;
    } catch {
        return null;
    }
}

/**
 * Telemetry and telecounting return groups of `factors`, each `{ code, data }`. Collect every
 * code/data pair regardless of nesting depth.
 */
function flattenFactors(data: any): Record<string, any> {
    const result: Record<string, any> = {};
    const visit = (node: any): void => {
        if (Array.isArray(node)) {
            node.forEach(visit);
            return;
        }
        if (!node || typeof node !== "object") return;
        if (typeof node.code === "string" && "data" in node && (node.data === null || typeof node.data !== "object")) {
            result[node.code] = node.data;
            return;
        }
        Object.values(node).forEach(visit);
    };
    visit(data);
    return result;
}

function toNumber(value: any, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}
