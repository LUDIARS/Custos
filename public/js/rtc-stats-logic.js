/**
 * WebRTC の受信統計の要約 (純関数、vitest 対象)。spec/feature/webrtc-efficiency.md 段 0 (計測)。
 *
 * RTCPeerConnection.getStats() の値 (累計) を、前回からの差分で「実効 kbps / fps / 損失率」にする。
 * 映像の状態表示 (`video: live · 2.1 Mbps · 30fps · loss 0.2% · rtt 45ms`) に出す。
 */

/** getStats() の report (Map 互換) から映像の inbound-rtp と使用中の candidate-pair を抜き出す。 */
export function pickVideoStats(report) {
    let inbound = null;
    let pair = null;
    for (const s of report.values()) {
        if (s.type === "inbound-rtp" && (s.kind === "video" || s.mediaType === "video")) inbound = s;
        if (s.type === "candidate-pair" && (s.nominated || s.selected) && s.state === "succeeded") pair = s;
    }
    if (!inbound) return null;
    return {
        timestamp:       inbound.timestamp,
        bytesReceived:   inbound.bytesReceived ?? 0,
        framesDecoded:   inbound.framesDecoded ?? 0,
        packetsReceived: inbound.packetsReceived ?? 0,
        packetsLost:     inbound.packetsLost ?? 0,
        width:           inbound.frameWidth ?? 0,
        height:          inbound.frameHeight ?? 0,
        rttMs:           pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
    };
}

/** 2 回の pickVideoStats の差分から要約を作る。prev が無ければ null。 */
export function summarizeVideoStats(prev, cur) {
    if (!prev || !cur) return null;
    const seconds = (cur.timestamp - prev.timestamp) / 1000;
    if (!(seconds > 0)) return null;
    const received = cur.packetsReceived - prev.packetsReceived;
    const lost = Math.max(0, cur.packetsLost - prev.packetsLost);
    return {
        kbps:    Math.max(0, ((cur.bytesReceived - prev.bytesReceived) * 8) / 1000 / seconds),
        fps:     Math.max(0, (cur.framesDecoded - prev.framesDecoded) / seconds),
        lossPct: received + lost > 0 ? (lost / (received + lost)) * 100 : 0,
        rttMs:   cur.rttMs,
        width:   cur.width,
        height:  cur.height,
    };
}

/** 状態表示の文字列。 */
export function formatVideoStats(summary) {
    if (!summary) return "";
    const rate = summary.kbps >= 1000 ? `${(summary.kbps / 1000).toFixed(1)} Mbps` : `${Math.round(summary.kbps)} kbps`;
    const parts = [rate, `${Math.round(summary.fps)}fps`, `loss ${summary.lossPct.toFixed(1)}%`];
    if (summary.rttMs != null) parts.push(`rtt ${Math.round(summary.rttMs)}ms`);
    if (summary.width && summary.height) parts.push(`${summary.width}x${summary.height}`);
    return parts.join(" · ");
}
