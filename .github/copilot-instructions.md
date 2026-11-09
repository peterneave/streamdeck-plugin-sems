# Copilot Instructions

## Project Overview

This is a **Stream Deck plugin** that displays live solar generation data from a **GoodWe inverter** via the [SEMS+](https://semsplus.goodwe.com) API. The plugin lets users see real-time PV output, daily/total generation, and earnings on their Elgato Stream Deck.

## SEMS+ API

GoodWe migrated from SEMS Portal to SEMS+ in 2026 and retired the legacy `v3/PowerStation/GetMonitorDetailByPowerstationId` endpoint. The SEMS+ API is undocumented; this flow follows community reverse-engineering (`bueste/ioBroker.goodwe-sems` `lib/semsApi.js`, `TimSoethout/goodwe-sems-home-assistant` issue #183). All API code lives in `src/sems-api.ts`.

1. **Login** — `POST https://semsplus.goodwe.com/web/sems/sems-user/api/v1/auth/cross-login`
   - Headers: browser `User-Agent`, `Origin`/`Referer` of the login host, `token: {"uid":"","timestamp":0,"token":"","client":"semsPlusWeb","version":"","language":"en"}`, `x-signature`
   - Body: `{"account": "<email>", "pwd": base64(md5_hex(password)), "agreement": 1, "isChinese": false, "isLocal": false}`
   - Success: `code` is `"00000"` (or `0`). Returns `data.uid`, `data.token`, `data.timestamp`, `data.region` and a region-specific gateway `data.api` (e.g. `https://eu-gateway.semsportal.com/web/sems`)
   - Do not retry the login against multiple regional hosts; it can look like credential stuffing and lock the account.

2. **Gateway calls** — against the gateway from login, with headers `User-Agent: PVMaster/2.9.5 (iPhone; iOS 17.5; Scale/3.00)`, `token: {uid, timestamp, token, client:"semsPlusWeb", version:"", language:"en", api, region}` and `x-signature = base64(sha256_hex("<ts>@<uid>@<token>") + "@<ts>")` (ts = epoch ms, fresh per call)
   - `POST /sems-plant/api/portal/stations/basic/info?stationId=<id>`: `name`, `pvCapacity` (kW, falls back to `installedPower`)
   - `GET /sems-plant/api/stations/device/all-status?stationId=<id>`: `deviceDetailList[].deviceType` and `statusDetailList[].detailMap` (keys are device serial numbers)
   - `GET /sems-plant/api/equipments/<sn>/telemetry?deviceType=<type>&pwId=<id>`: factors `{code, data}`; `pAc` is current AC power in **kW**
   - `GET /sems-plant/api/equipments/<sn>/telecounting?deviceType=<type>&pwId=<id>`: `proPvStatsToday` and `proPvStatsTotal` (kWh)

The session is cached and reused across refreshes; on a non-success gateway response the client logs in again once and retries. `GY0429` means rate limited.

Use `node scripts/sems-probe.mjs` (reads `ACCOUNT`, `PASSWORD`, `STATION_ID` from `.env`) to inspect live responses.

## Secrets & Credentials

User credentials (`account`, `pwd`, `powerStationId`) should be stored in the Stream Deck plugin's settings/preferences, not hardcoded.

## References

Create the plugin with instructions from https://github.com/elgatosf/streamdeck and https://docs.elgato.com/streamdeck/sdk/introduction/getting-started/

## Requirements

The current solar generation data should be displayed on the Stream Deck key. The plugin should refresh data at a reasonable interval (e.g. every 5 minutes) and handle API errors gracefully (e.g. show an error icon or message if data cannot be retrieved).
