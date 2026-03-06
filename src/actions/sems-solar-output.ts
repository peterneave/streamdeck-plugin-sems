import streamDeck, { action, KeyDownEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, DidReceiveSettingsEvent, SendToPluginEvent } from "@elgato/streamdeck";

// SEMS API constants
const BASE_TOKEN = {
    version: "v3.4.3",
    client: "android",
    language: "en"
};

const LOGIN_URL = "https://www.semsportal.com/api/v1/Common/CrossLogin";

const INTERVAL_MS: Record<string, number> = {
    "10m": 10 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "60m": 60 * 60 * 1000
};

const DEFAULT_SETTINGS = {
    account: "",
    password: "",
    powerStationId: "",
    refreshInterval: "10m",
    displayMode: "gaugeWithNumber"
};

// Types
interface SemsSettings {
    account: string;
    password: string;
    powerStationId: string;
    refreshInterval: string;
    displayMode: string;
    [key: string]: any;  // Index signature for JsonObject compatibility
}

interface SemsTelemetry {
    stationName: string;
    timestamp: string;
    currentW: number;
    currentKw: number;
    dailyKwh: number;
    totalKwh: number;
    capacityKw: number;
}

interface ActionState {
    settings: SemsSettings;
    latest: SemsTelemetry | null;
    error: string;
    timerId: NodeJS.Timeout | null;
    inFlight: boolean;
}

interface SemsApiResponse {
    hasError?: boolean;
    code?: number | string;
    msg?: string;
    api?: string;
    data?: any;
}

/**
 * SEMS Solar Monitoring action displays live solar generation data from GoodWe inverter via SEMS Portal API.
 */
@action({ UUID: "dev.neave.sems.solar.monitoring" })
export class SemsSolarOutputAction extends SingletonAction<SemsSettings> {
    private readonly states = new Map<string, ActionState>();

    /**
     * Initialize the action when it appears on the Stream Deck
     */
    override async onWillAppear(ev: WillAppearEvent<SemsSettings>): Promise<void> {
        const settings = this.mergeSettings(ev.payload.settings);

        const state: ActionState = {
            settings,
            latest: null,
            error: "",
            timerId: null,
            inFlight: false
        };

        this.states.set(ev.action.id, state);

        // Request settings to ensure we have the latest
        await ev.action.getSettings();

        // Apply refresh policy (start timer or wait for push)
        this.applyRefreshPolicy(ev.action.id, true);
    }

    /**
     * Settings changed - update and refresh if needed
     */
    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SemsSettings>): Promise<void> {
        const state = this.getState(ev.action.id);
        if (!state) return;

        state.settings = this.mergeSettings(ev.payload.settings);

        // Reapply refresh policy
        this.applyRefreshPolicy(ev.action.id, true);
    }

    /**
     * Key pressed - if "On Push" mode, refresh now
     */
    override async onKeyDown(ev: KeyDownEvent<SemsSettings>): Promise<void> {
        const state = this.getState(ev.action.id);
        if (!state) return;

        if (state.settings.refreshInterval === "onPush") {
            await this.refreshContext(ev.action.id, "keypress");
        }
    }

    /**
     * Clean up timers when action is removed
     */
    override async onWillDisappear(ev: WillDisappearEvent<SemsSettings>): Promise<void> {
        const state = this.getState(ev.action.id);
        if (!state) return;

        if (state.timerId) {
            clearInterval(state.timerId);
        }

        this.states.delete(ev.action.id);
    }

    /**
     * Handle messages from Property Inspector
     */
    override async onSendToPlugin(ev: SendToPluginEvent<{ command?: string }, SemsSettings>): Promise<void> {
        if (ev.payload.command === "requestState") {
            await this.pushTelemetryToPropertyInspector(ev.action.id);
            return;
        }

        if (ev.payload.command === "testConnection") {
            const state = this.getState(ev.action.id);
            if (!state) return;

            const result = await this.fetchSemsData(state.settings);

            if (result.ok) {
                await this.sendToPI(ev.action.id, {
                    type: "connectionTestResult",
                    ok: true,
                    message: "Connection successful."
                });
            } else {
                await this.sendToPI(ev.action.id, {
                    type: "connectionTestResult",
                    ok: false,
                    message: result.error
                });
            }
            return;
        }

        if (ev.payload.command === "refreshNow") {
            await this.refreshContext(ev.action.id, "pi");
        }
    }

    // Private helper methods

    private getState(id: string): ActionState | undefined {
        return this.states.get(id);
    }

    private mergeSettings(settings: Partial<SemsSettings>): SemsSettings {
        return {
            ...DEFAULT_SETTINGS,
            ...settings
        };
    }

    private applyRefreshPolicy(id: string, runImmediate: boolean): void {
        const state = this.getState(id);
        if (!state) return;

        const refreshInterval = state.settings.refreshInterval || "10m";

        if (state.timerId) {
            clearInterval(state.timerId);
            state.timerId = null;
        }

        if (refreshInterval === "onPush") {
            if (runImmediate) {
                this.renderWaitingForPush(id);
                this.pushTelemetryToPropertyInspector(id);
            }
            return;
        }

        const ms = INTERVAL_MS[refreshInterval] || INTERVAL_MS["10m"];
        state.timerId = setInterval(() => {
            this.refreshContext(id, "timer");
        }, ms);

        if (runImmediate || !state.latest) {
            this.refreshContext(id, "initial");
        }
    }

    private async refreshContext(id: string, source: string): Promise<void> {
        const state = this.getState(id);
        if (!state) return;

        if (state.inFlight) {
            return;
        }

        if (!this.hasRequiredSettings(state.settings)) {
            state.latest = null;
            state.error = "Missing account, password, or station ID.";
            await this.renderMissingConfiguration(id);
            await this.pushTelemetryToPropertyInspector(id);
            return;
        }

        state.inFlight = true;

        try {
            const result = await this.fetchSemsData(state.settings);

            if (!result.ok) {
                state.latest = null;
                state.error = result.error || "Unknown error";
                await this.renderError(id, result.error || "Unknown error");
                await this.pushTelemetryToPropertyInspector(id);
                const action = streamDeck.actions.getActionById(id);
                await action?.showAlert();
                return;
            }

            if (result.data) {
                state.latest = result.data;
                state.error = "";
                await this.renderSuccess(id, state.settings, result.data);
                await this.pushTelemetryToPropertyInspector(id);
            };
        } catch (error) {
            state.latest = null;
            state.error = `Unexpected error: ${this.stringifyError(error)}`;
            await this.renderError(id, state.error);
            await this.pushTelemetryToPropertyInspector(id);
            const action = streamDeck.actions.getActionById(id);
            await action?.showAlert();
        } finally {
            state.inFlight = false;
        }
    }

    private hasRequiredSettings(settings: SemsSettings): boolean {
        return Boolean(settings.account && settings.password && settings.powerStationId);
    }

    private async fetchSemsData(settings: SemsSettings): Promise<{ ok: boolean; data?: SemsTelemetry; error?: string }> {
        try {
            // Step 1: Login
            const loginResponse = await fetch(LOGIN_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Token: JSON.stringify(BASE_TOKEN)
                },
                body: JSON.stringify({
                    account: settings.account,
                    pwd: settings.password
                })
            });

            const loginJson = await loginResponse.json() as SemsApiResponse;
            if (!loginResponse.ok) {
                return { ok: false, error: `Login failed with HTTP ${loginResponse.status}.` };
            }

            if (loginJson.hasError || (loginJson.code !== 0 && loginJson.code !== "0")) {
                return { ok: false, error: loginJson.msg || "SEMS login failed." };
            }

            const apiBase = loginJson.api;
            const loginData = loginJson.data || {};

            if (!apiBase || !loginData.uid || !loginData.token || !loginData.timestamp) {
                return { ok: false, error: "SEMS login response missing API token details." };
            }

            // Step 2: Get station data
            const monitorUrl = `${String(apiBase).replace(/\/$/, "")}/v3/PowerStation/GetMonitorDetailByPowerstationId`;
            const tokenHeader = JSON.stringify({
                ...BASE_TOKEN,
                timestamp: String(loginData.timestamp),
                uid: loginData.uid,
                token: loginData.token
            });

            const monitorResponse = await fetch(monitorUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Token: tokenHeader
                },
                body: JSON.stringify({
                    powerStationId: settings.powerStationId
                })
            });

            const monitorJson = await monitorResponse.json() as SemsApiResponse;
            if (!monitorResponse.ok) {
                return { ok: false, error: `Monitor request failed with HTTP ${monitorResponse.status}.` };
            }

            if (monitorJson.hasError || (monitorJson.code !== 0 && monitorJson.code !== "0")) {
                return { ok: false, error: monitorJson.msg || "SEMS monitor request failed." };
            }

            const normalized = this.normalizeSemsPayload(monitorJson.data);
            return { ok: true, data: normalized };
        } catch (error) {
            return {
                ok: false,
                error: `Failed to contact SEMS: ${this.stringifyError(error)}`
            };
        }
    }

    private normalizeSemsPayload(data: any): SemsTelemetry {
        const kpi = data?.kpi || {};
        const info = data?.info || {};

        const currentW = this.toNumber(kpi.pac, 0);
        const currentKw = currentW / 1000;
        const dailyKwh = this.toNumber(kpi.power, 0);
        const totalKwh = this.toNumber(kpi.total_power, 0);

        // Calculate total capacity from inverters, falling back to info.capacity
        const inverters = Array.isArray(data?.inverter) ? data.inverter : [];
        const totalCapacityKw = inverters.reduce((sum: number, inv: any) => sum + this.toNumber(inv.capacity, 0), 0);
        const capacityKw = totalCapacityKw > 0 ? totalCapacityKw : this.toNumber(info.capacity, 0);

        return {
            stationName: String(info.stationname || "SEMS"),
            timestamp: String(info.time || ""),
            currentW,
            currentKw,
            dailyKwh,
            totalKwh,
            capacityKw
        };
    }

    // Rendering methods

    private async renderWaitingForPush(id: string): Promise<void> {
        const action = streamDeck.actions.getActionById(id);
        if (!action) return;

        const svg = this.buildGaugeSvg({
            percent: 0,
            mode: "gaugeOnly",
            valueText: "Push",
            subtitleText: "Press key"
        });

        await action.setImage(svg);
        await action.setTitle("");
    }

    private async renderMissingConfiguration(id: string): Promise<void> {
        const action = streamDeck.actions.getActionById(id);
        if (!action) return;

        const svg = this.buildGaugeSvg({
            percent: 0,
            mode: "gaugeWithNumber",
            valueText: "--",
            subtitleText: "Setup"
        });

        await action.setImage(svg);
        await action.setTitle("Config\nRequired");
    }

    private async renderError(id: string, message: string): Promise<void> {
        const action = streamDeck.actions.getActionById(id);
        if (!action) return;

        const svg = this.buildGaugeSvg({
            percent: 0,
            mode: "gaugeWithNumber",
            valueText: "ERR",
            subtitleText: "Check PI",
            error: true
        });

        await action.setImage(svg);
        await action.setTitle("SEMS\nError");

        streamDeck.logger.info(`Render error for ${id}: ${message}`);
    }

    private async renderSuccess(id: string, settings: SemsSettings, telemetry: SemsTelemetry): Promise<void> {
        const action = streamDeck.actions.getActionById(id);
        if (!action) return;

        const mode = settings.displayMode || "gaugeWithNumber";
        const capacity = telemetry.capacityKw > 0 ? telemetry.capacityKw : 1;
        const percent = this.clamp01(telemetry.currentKw / capacity);
        const kwText = `${telemetry.currentKw.toFixed(2)} kW`;

        if (mode === "numberOnly") {
            await action.setImage(this.transparentImageSvgDataUrl());
            await action.setTitle(`${kwText}\n${(percent * 100).toFixed(0)}%`);
            return;
        }

        const svg = this.buildGaugeSvg({
            percent,
            mode,
            valueText: `${telemetry.currentKw.toFixed(2)} kW`,
            subtitleText: `${(percent * 100).toFixed(0)}% of ${capacity.toFixed(2)} kW`
        });

        await action.setImage(svg);
        await action.setTitle("");
    }

    private buildGaugeSvg(options: {
        percent: number;
        mode: string;
        valueText: string;
        subtitleText: string;
        error?: boolean;
    }): string {
        const percent = this.clamp01(options.percent || 0);
        const mode = options.mode || "gaugeWithNumber";
        const valueText = options.valueText || "--";
        const subtitleText = options.subtitleText || "";
        const isError = Boolean(options.error);

        const size = 144;
        const cx = 72;
        const cy = 96;
        const radius = 52;
        const stroke = 18;

        const segA = this.arcPathClockwise(cx, cy, radius, 270, 330);
        const segB = this.arcPathClockwise(cx, cy, radius, 330, 30);
        const segC = this.arcPathClockwise(cx, cy, radius, 30, 90);

        const endAngle = 270 + (180 * percent);
        const progress = this.arcPathClockwise(cx, cy, radius, 270, endAngle);

        const markerPos = this.polarToCartesian(cx, cy, radius, endAngle);
        const markerX = markerPos.x;
        const markerY = markerPos.y;

        const textBlock = mode === "gaugeOnly"
            ? ""
            : `<text x="72" y="118" text-anchor="middle" font-family="Segoe UI" font-size="20" font-weight="700" fill="#f3f7ff">${this.escapeXml(valueText)}</text>
       <text x="72" y="134" text-anchor="middle" font-family="Segoe UI" font-size="16" fill="#c6d2eb">${this.escapeXml(subtitleText)}</text>`;

        const progressColor = isError ? "#ff4f4f" : "#f8f8f8";

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
    <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#000000" />
                <stop offset="100%" stop-color="#000000" />
      </linearGradient>
    </defs>
        <rect x="0" y="0" width="${size}" height="${size}" fill="url(#bg)" rx="18" />

        <path d="${segA}" stroke="#ef4444" stroke-width="${stroke}" fill="none" stroke-linecap="round" />
        <path d="${segB}" stroke="#eab308" stroke-width="${stroke}" fill="none" stroke-linecap="round" />
        <path d="${segC}" stroke="#22c55e" stroke-width="${stroke}" fill="none" stroke-linecap="round" />

        <path d="${progress}" stroke="${progressColor}" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.9" />
        <circle cx="${markerX.toFixed(2)}" cy="${markerY.toFixed(2)}" r="6" fill="${progressColor}" />

    ${textBlock}
  </svg>`;

        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }

    private arcPathClockwise(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
        const normalizedStart = this.normalizeAngle(startDeg);
        const normalizedEnd = this.normalizeAngle(endDeg);
        const start = this.polarToCartesian(cx, cy, r, normalizedStart);
        const end = this.polarToCartesian(cx, cy, r, normalizedEnd);
        const clockwiseDelta = (normalizedEnd - normalizedStart + 360) % 360;
        const largeArc = clockwiseDelta > 180 ? 1 : 0;

        return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
    }

    private polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): { x: number; y: number } {
        const radians = ((angleDeg - 90) * Math.PI) / 180;
        return {
            x: cx + r * Math.cos(radians),
            y: cy + r * Math.sin(radians)
        };
    }

    private transparentImageSvgDataUrl(): string {
        const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='144' height='144'></svg>";
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    }

    private async pushTelemetryToPropertyInspector(id: string): Promise<void> {
        const state = this.getState(id);
        if (!state) return;

        await this.sendToPI(id, {
            type: "telemetry",
            data: state.latest,
            error: state.error,
            refreshInterval: state.settings.refreshInterval || "10m"
        });
    }

    private async sendToPI(id: string, payload: any): Promise<void> {
        const action = streamDeck.actions.getActionById(id);
        if (!action) {
            streamDeck.logger.warn(`Cannot send to property inspector: action ${id} not found`);
            return;
        }

        try {
            await action.sendToPropertyInspector(payload);
        } catch (error) {
            streamDeck.logger.error(`Failed to send to property inspector: ${this.stringifyError(error)}`);
        }
    }

    // Utility methods

    private toNumber(value: any, fallback: number): number {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    private clamp01(value: number): number {
        if (value < 0) return 0;
        if (value > 1) return 1;
        return value;
    }

    private normalizeAngle(angleDeg: number): number {
        const normalized = angleDeg % 360;
        return normalized < 0 ? normalized + 360 : normalized;
    }

    private escapeXml(value: string): string {
        return String(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&apos;");
    }

    private stringifyError(error: unknown): string {
        if (!error) return "Unknown error";
        if (typeof error === "string") return error;
        if (error instanceof Error) return error.message;
        return JSON.stringify(error);
    }
}
