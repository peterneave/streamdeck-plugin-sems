# Copilot Instructions

## Project Overview

This is a **Stream Deck plugin** that displays live solar generation data from a **GoodWe inverter** via the [SEMS Portal](https://www.semsportal.com) REST API. The plugin lets users see real-time PV output, daily/total generation, and earnings on their Elgato Stream Deck.

## SEMS Portal API

Authentication is a two-step process:

1. **Login** — `POST https://www.semsportal.com/api/v1/Common/CrossLogin`
   - Header: `Token: {"version":"v3.4.3","client":"android","language":"en"}`
   - Body: `{"account": "<email>", "pwd": "<password>"}`
   - Returns: `uid`, `token`, `timestamp`, and a region-specific `api` base URL (e.g. `https://au.semsportal.com/api/`)

2. **Get station data** — `POST <api>/v3/PowerStation/GetMonitorDetailByPowerstationId`
   - Header: `Token: {"version":"v3.4.3","client":"android","language":"en","timestamp":"<ts>","uid":"<uid>","token":"<token>"}`
   - Body: `{"powerStationId": "<id>"}`

### Key response fields (`data`)

| Path                      | Description                                  |
| ------------------------- | -------------------------------------------- |
| `kpi.pac`                 | Current AC output power (W)                  |
| `kpi.power`               | Energy generated today (kWh)                 |
| `kpi.total_power`         | Lifetime energy generated (kWh)              |
| `kpi.day_income`          | Earnings today (currency in `kpi.currency`)  |
| `kpi.total_income`        | Lifetime earnings                            |
| `inverter[].capacity`     | Per-inverter capacity (W)                    |
| `inverter[].out_pac`      | Per-inverter AC output (W)                   |
| `inverter[].eday`         | Per-inverter daily generation (kWh)          |
| `inverter[].etotal`       | Per-inverter lifetime generation (kWh)       |
| `inverter[].tempperature` | Inverter temperature (°C) — note typo in API |
| `inverter[].status`       | `1` = Normal, other values = fault/offline   |
| `hjgx.co2`                | CO₂ offset (tonnes)                          |

The `api` base URL returned at login is **region-specific** (e.g. `au.semsportal.com` for Australia) — always use the URL from the login response, not a hardcoded one.

The output of the solar system is contained by the capacity of the inverter(s). If you have a 5kW system with a 3kW inverter, the maximum output will be ~3kW, even if the solar panels could produce more. To get the true potential output, you can sum the `capacity` of all inverters.

## Secrets & Credentials

User credentials (`account`, `pwd`, `powerStationId`) should be stored in the Stream Deck plugin's settings/preferences, not hardcoded.

## References

Create the plugin with instructions from https://github.com/elgatosf/streamdeck and https://docs.elgato.com/streamdeck/sdk/introduction/getting-started/

## Requirements

The current solar generation data should be displayed on the Stream Deck key. The plugin should refresh data at a reasonable interval (e.g. every 5 minutes) and handle API errors gracefully (e.g. show an error icon or message if data cannot be retrieved).
