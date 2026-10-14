/**
 * SETTINGS ウインドウ: auto-stream (映像がつながるまでの静止画) の転送間隔と最大解像度の上書き。
 * 値はサーバー側に保持され、全クライアントに効く (Custos 再起動で apps.json の既定に戻る)。
 */

export function createSettingsPanel({ apiFetch }) {
    const $ = (id) => document.getElementById(id);
    const form = $("settingsForm");
    const intervalEl = $("settingIntervalSec");
    const maxWidthEl = $("settingMaxWidth");
    const resetBtn = $("settingReset");
    const statusEl = $("settingStatus");
    const currentEl = $("settingsCurrent");

    form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        await save();
    });
    resetBtn.addEventListener("click", async () => {
        // null で上書きを消す → apps.json の既定値に戻る
        await put({ intervalSec: null, maxWidth: null });
        intervalEl.value = "";
        maxWidthEl.value = "";
        setStatus("Reset to defaults", "ok");
    });

    async function load() {
        try {
            const res = await apiFetch("/settings/stream");
            if (!res.ok) {
                setStatus(`HTTP ${res.status}`, "err");
                return;
            }
            const prefs = (await res.json()).prefs ?? {};
            intervalEl.value = prefs.intervalSec !== undefined ? String(prefs.intervalSec) : "";
            maxWidthEl.value = prefs.maxWidth !== undefined ? String(prefs.maxWidth) : "";
            currentEl.textContent = JSON.stringify(prefs, null, 2);
            setStatus("", "");
        } catch (err) {
            setStatus(`load error: ${err.message ?? err}`, "err");
        }
    }

    async function save() {
        const intervalRaw = intervalEl.value.trim();
        const maxWidthRaw = maxWidthEl.value.trim();
        const patch = {
            intervalSec: intervalRaw === "" ? null : Number(intervalRaw),
            maxWidth: maxWidthRaw === "" ? null : Number(maxWidthRaw),
        };
        if (Number.isNaN(patch.intervalSec) || (patch.intervalSec !== null && patch.intervalSec < 0)) {
            setStatus("intervalSec が不正", "err");
            return;
        }
        if (Number.isNaN(patch.maxWidth) || (patch.maxWidth !== null && patch.maxWidth < 0)) {
            setStatus("maxWidth が不正", "err");
            return;
        }
        await put(patch);
    }

    async function put(patch) {
        try {
            const res = await apiFetch("/settings/stream", { method: "PUT", body: JSON.stringify(patch) });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || body.ok === false) {
                setStatus(`save failed: ${body.error ?? `HTTP ${res.status}`}`, "err");
                return;
            }
            currentEl.textContent = JSON.stringify(body.prefs ?? {}, null, 2);
            setStatus("Saved — applied immediately", "ok");
        } catch (err) {
            setStatus(`save error: ${err.message ?? err}`, "err");
        }
    }

    function setStatus(message, kind) {
        statusEl.textContent = message;
        statusEl.className = "settings-status" + (kind ? " " + kind : "");
    }

    return { load };
}
