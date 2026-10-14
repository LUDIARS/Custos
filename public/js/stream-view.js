/**
 * VIEW の映像。app を選んだ時点で WebRTC につなぎ、切れたらつなぎ直す。
 *
 * - 映像源 (capture / inAppBridge) のある app は選択と同時に接続する (手動の開始ボタンは無い)
 * - 切断・失敗したら間隔を空けてつなぎ直す (2 秒から倍々、最大 30 秒)。app が起動し直したら即時
 * - 映像が届くまでは、サーバーの auto-stream (静止画) を代わりに映す
 * - 📷 は今の画面の PNG を 1 枚保存する (映像はそのまま)
 */

import { connectWebRTC, closeWebRTC } from "/js/webrtc.js";

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

export function createStreamView({ elements, apiFetch, log }) {
    const { video, image, placeholder, placeholderTitle, placeholderHint, status, audioToggle } = elements;
    let app = null;
    let sessionId = null;
    /** 接続の世代。古い接続から遅れて届いた状態変化を無視するために使う。 */
    let generation = 0;
    let retryTimer = null;
    let retryDelay = RETRY_BASE_MS;
    let live = false;

    video.addEventListener("playing", () => {
        if (sessionId) showVideo();
    });
    // ブラウザは音の自動再生を止めるので、消音で始めてボタン (ユーザ操作) で音を出す。
    audioToggle.addEventListener("click", () => {
        video.muted = !video.muted;
        if (!video.muted) video.play().catch(() => { /* 再生は playing で拾う。止められても映像は出ている */ });
        renderAudioToggle();
    });

    function renderAudioToggle() {
        audioToggle.hidden = !app?.hasAudio;
        audioToggle.textContent = video.muted ? "🔇" : "🔊";
        audioToggle.title = video.muted ? "音を出す" : "消音にする";
    }

    async function setApp(config) {
        stop();
        app = config;
        video.muted = true;
        renderAudioToggle();
        if (!config) {
            showPlaceholder("No app selected", "上のセレクタからアプリを選ぶと映像につながります。");
            return;
        }
        if (!config.hasVideo) {
            showPlaceholder("No video source", "この app には capture / inAppBridge の設定がありません (config/apps.json)。");
            return;
        }
        showPlaceholder("Connecting…", "WebRTC で映像につないでいます。");
        await connect();
    }

    async function connect() {
        const gen = ++generation;
        clearRetry();
        setStatus("connecting", "video: connecting");
        try {
            const id = await connectWebRTC({
                appId: app.id,
                videoEl: video,
                apiFetch,
                onLog: (text, isError) => log(`[video] ${text}`, isError),
                onState: (state) => onState(gen, state),
                withAudio: app.hasAudio === true,
            });
            if (gen !== generation) {
                // 接続中に app が切り替わった。つながった方を捨てる。
                closeWebRTC({ apiFetch, sessionId: id }).catch(() => { /* 後始末なので best-effort */ });
                return;
            }
            sessionId = id;
        } catch (err) {
            if (gen !== generation) return;
            log(`[video] connect failed: ${err.message ?? err}`, true);
            scheduleRetry();
        }
    }

    function onState(gen, state) {
        if (gen !== generation) return;
        if (state === "connected") {
            retryDelay = RETRY_BASE_MS;
            setStatus("live", "video: live");
            return;
        }
        if (state === "failed" || state === "disconnected" || state === "closed") {
            generation++;   // この接続の残りの状態変化 (close 時の "closed" など) は無視する
            dropSession();
            scheduleRetry();
        }
    }

    function scheduleRetry() {
        clearRetry();
        if (!app?.hasVideo) return;
        const delay = retryDelay;
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
        setStatus("retry", `video: retry in ${Math.round(delay / 1000)}s`);
        const appAtSchedule = app;
        retryTimer = window.setTimeout(() => {
            retryTimer = null;
            if (app === appAtSchedule) connect();
        }, delay);
    }

    function clearRetry() {
        if (retryTimer !== null) window.clearTimeout(retryTimer);
        retryTimer = null;
    }

    function dropSession() {
        live = false;
        video.classList.remove("active");
        if (sessionId) {
            closeWebRTC({ apiFetch, sessionId }).catch(() => { /* 既に切れている。後始末なので best-effort */ });
        }
        sessionId = null;
    }

    function stop() {
        generation++;
        clearRetry();
        dropSession();
        retryDelay = RETRY_BASE_MS;
        video.srcObject = null;
        image.classList.remove("active");
        setStatus("idle", "video: idle");
    }

    /** app が起動し直したなど、映像源が戻った見込みがあるときは待たずにつなぐ。 */
    function retryNow() {
        if (!app?.hasVideo || live || sessionId) return;
        retryDelay = RETRY_BASE_MS;
        connect();
    }

    /** サーバーの auto-stream 静止画。映像がまだ届いていない間だけ映す。 */
    function showFrame(msg) {
        if (live || !app || msg.appId !== app.id) return;
        image.src = `data:${msg.mime};base64,${msg.png_b64}`;
        image.classList.add("active");
        placeholder.style.display = "none";
    }

    function showVideo() {
        live = true;
        video.classList.add("active");
        image.classList.remove("active");
        placeholder.style.display = "none";
    }

    function showPlaceholder(title, hint) {
        placeholderTitle.textContent = title;
        placeholderHint.textContent = hint;
        placeholder.style.display = "";
    }

    function setStatus(state, text) {
        status.dataset.state = state;
        status.textContent = text;
    }

    /** 映像上の座標計算に使う、いま見えている要素。 */
    function getMedia() {
        if (video.classList.contains("active")) return video;
        if (image.classList.contains("active")) return image;
        return null;
    }

    /** 今の画面を PNG で保存する。 */
    async function snapshot() {
        if (!app) {
            log("[snapshot] アプリ未選択", true);
            return;
        }
        const res = await apiFetch(`/apps/${encodeURIComponent(app.id)}/screenshot`, { method: "POST" });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            log(`[snapshot] HTTP ${res.status} ${body.error ?? ""}`, true);
            return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `custos-${app.id}-${Date.now()}.png`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
        log(`[snapshot] ${(blob.size / 1024).toFixed(1)} KB`);
    }

    return { setApp, retryNow, showFrame, getMedia, snapshot };
}
