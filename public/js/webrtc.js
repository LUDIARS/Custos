/**
 * Custos frontend WebRTC client。
 *
 * Custos backend は **送信側 (sendrecv の send)** として MediaStreamTrack を
 * 用意するので、ブラウザは `addTransceiver("video", { direction: "recvonly" })`
 * で受信トランシーバを足してから offer を作って投げる。
 *
 * バックエンドが ICE 完了済の answer を返すまで待つ簡易設計 (trickle ICE
 * 未対応)。
 */

export async function connectWebRTC({ appId, videoEl, apiFetch, onLog }) {
    const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    // 受信側 transceiver。サーバーが video track を流し込む。
    pc.addTransceiver("video", { direction: "recvonly" });

    pc.ontrack = (ev) => {
        if (videoEl.srcObject !== ev.streams[0]) {
            videoEl.srcObject = ev.streams[0];
            onLog?.("video track attached");
        }
    };
    pc.onconnectionstatechange = () => {
        onLog?.(`pc state: ${pc.connectionState}`,
            pc.connectionState === "failed" || pc.connectionState === "disconnected");
    };

    // ICE gathering 完了まで待ってから offer を送る。
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceComplete(pc);

    const res = await apiFetch(`/apps/${encodeURIComponent(appId)}/rtc/offer`, {
        method: "POST",
        body: JSON.stringify({ sdp: pc.localDescription.sdp }),
    });
    const json = await res.json();
    if (!res.ok || json.ok === false) {
        try { pc.close(); } catch { /* ignore */ }
        throw new Error(json.error ?? `HTTP ${res.status}`);
    }
    await pc.setRemoteDescription({ sdp: json.sdp, type: json.type ?? "answer" });
    onLog?.(`session ${json.sessionId} established`);

    // 後で close 時に呼ぶよう PC をセッションに紐付け。
    sessions.set(json.sessionId, { pc });
    return json.sessionId;
}

const sessions = new Map();

export async function closeWebRTC({ apiFetch, sessionId }) {
    const s = sessions.get(sessionId);
    if (s) {
        try { s.pc.close(); } catch { /* ignore */ }
        sessions.delete(sessionId);
    }
    try {
        await apiFetch(`/apps/${encodeURIComponent("any")}/rtc/close`, {
            method: "POST",
            body: JSON.stringify({ sessionId }),
        });
    } catch { /* ignore */ }
}

function waitIceComplete(pc, timeoutMs = 5000) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
        const start = Date.now();
        const onChange = () => {
            if (pc.iceGatheringState === "complete") {
                cleanup(); resolve();
            }
        };
        const onTick = () => {
            if (Date.now() - start >= timeoutMs) { cleanup(); resolve(); }
            else setTimeout(onTick, 100);
        };
        function cleanup() {
            pc.removeEventListener("icegatheringstatechange", onChange);
        }
        pc.addEventListener("icegatheringstatechange", onChange);
        onTick();
    });
}
