import { STAMPS, OVERLAY_MS } from "/js/audience-content.js";

/** Owns only temporary, pointer-transparent display nodes and their expiry timers. */
export function createAudienceOverlay(messages, stamps) {
    const timers = new Map();
    let lane = 0;

    function remove(node) {
        clearTimeout(timers.get(node));
        timers.delete(node);
        node.remove();
    }

    function show(event) {
        const isStamp = event.kind === "stamp";
        const container = isStamp ? stamps : messages;
        const limit = isStamp ? 12 : 3;
        while (container.children.length >= limit) remove(container.firstElementChild);
        const node = document.createElement("div");
        node.className = isStamp ? "audience-float" : "audience-message";
        if (isStamp) {
            node.textContent = STAMPS[event.stamp]?.emoji ?? "";
            node.style.left = `${15 + (lane++ % 5) * 16}%`;
        } else {
            node.textContent = `${event.sender}: ${event.text}`;
        }
        container.appendChild(node);
        timers.set(node, setTimeout(() => remove(node), OVERLAY_MS));
    }

    function clear() {
        for (const node of [...timers.keys()]) remove(node);
    }

    return { show, clear };
}
