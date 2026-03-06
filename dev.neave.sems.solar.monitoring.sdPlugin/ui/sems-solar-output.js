/* SEMS Property Inspector JavaScript */

// DOM references
const refs = {
    testConnection: document.getElementById("testConnection"),
    statusText: document.getElementById("statusText"),
    currentKw: document.getElementById("currentKw"),
    dailyKwh: document.getElementById("dailyKwh"),
    totalKwh: document.getElementById("totalKwh"),
    capacity: document.getElementById("capacity"),
    updated: document.getElementById("updated")
};

// Wait for DOM to load
window.addEventListener("load", () => {
    // Bind test connection button
    refs.testConnection.addEventListener("click", () => {
        setStatus("Testing connection...", "");
        $SD.sendToPlugin({ command: "testConnection" });
    });

    // Request initial telemetry from plugin
    $SD.sendToPlugin({ command: "requestState" });
});

// Handle messages from plugin
$SD.on("sendToPropertyInspector", (event) => {
    handlePluginMessage(event?.payload || {});
});

function handlePluginMessage(payload) {
    if (payload.type === "connectionTestResult") {
        if (payload.ok) {
            setStatus(payload.message || "Connection successful.", "ok");
        } else {
            setStatus(payload.message || "Connection failed.", "error");
        }
        return;
    }

    if (payload.type === "telemetry") {
        const data = payload.data;
        const error = payload.error;

        if (error) {
            setStatus(error, "error");
        } else if (payload.refreshInterval === "onPush") {
            setStatus("Waiting for key press.", "");
        } else {
            setStatus("Connected", "ok");
        }

        if (!data) {
            refs.currentKw.textContent = "--";
            refs.dailyKwh.textContent = "--";
            refs.totalKwh.textContent = "--";
            refs.capacity.textContent = "--";
            refs.updated.textContent = "--";
            return;
        }

        refs.currentKw.textContent = `${toFixed(data.currentKw, 2)} kW`;
        refs.dailyKwh.textContent = `${toFixed(data.dailyKwh, 2)} kWh`;
        refs.totalKwh.textContent = `${toFixed(data.totalKwh, 2)} kWh`;
        refs.capacity.textContent = data.capacityKw > 0 ? `${toFixed(data.capacityKw, 2)} kW` : "Not available";
        refs.updated.textContent = data.timestamp || "--";
    }
}

function setStatus(message, kind) {
    refs.statusText.textContent = message;
    refs.statusText.classList.remove("ok", "error");

    if (kind) {
        refs.statusText.classList.add(kind);
    }
}

function toFixed(value, digits) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : "0.00";
}
