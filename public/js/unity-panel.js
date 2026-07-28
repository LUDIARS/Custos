import {
    appendUnityLogs,
    bridgePresentation,
    filterUnityLogs,
    flattenHierarchy,
    toggleHierarchyExpansion,
} from "/js/unity-panel-logic.js";

const POLL_INTERVAL_MS = 2_000;

export function createUnityPanel({ apiFetch, getAppId }) {
    const elements = {
        unavailable: document.getElementById("unityUnavailable"),
        content: document.getElementById("unityContent"),
        bridge: document.getElementById("unityBridge"),
        version: document.getElementById("unityVersion"),
        mode: document.getElementById("unityMode"),
        scene: document.getElementById("unityScene"),
        hierarchy: document.getElementById("unityHierarchy"),
        truncated: document.getElementById("unityHierarchyTruncated"),
        console: document.getElementById("unityConsole"),
        errors: document.getElementById("unityErrorCount"),
        warnings: document.getElementById("unityWarningCount"),
        status: document.getElementById("unityActionStatus"),
        filters: [...document.querySelectorAll("[data-unity-log-filter]")],
        actions: [...document.querySelectorAll("[data-unity-action]")],
    };
    const state = {
        appId: null,
        hasBridge: false,
        nextSeq: 0,
        logs: [],
        filter: "all",
        hierarchy: [],
        loadedNodeIds: new Set(),
        expandedIds: new Set(),
        selectedId: null,
        pollTimer: null,
    };

    elements.filters.forEach((button) => {
        button.addEventListener("click", () => {
            state.filter = button.dataset.unityLogFilter;
            elements.filters.forEach((candidate) => {
                candidate.classList.toggle("active", candidate === button);
            });
            renderConsole();
        });
    });
    elements.actions.forEach((button) => {
        button.addEventListener("click", () => runAction(button));
    });
    elements.hierarchy.addEventListener("click", onHierarchyClick);
    elements.console.addEventListener("click", onConsoleClick);

    function setApp(config) {
        state.appId = getAppId();
        // /api/apps は redact() を通した config を返すので inAppBridge そのものは来ない。
        // backend が出す派生フラグを見る (hasBuild / hasTest と同じ流儀)。
        state.hasBridge = config?.hasUnityBridge === true;
        state.nextSeq = 0;
        state.logs = [];
        state.hierarchy = [];
        state.loadedNodeIds = new Set();
        state.expandedIds = new Set();
        state.selectedId = null;
        renderAvailability();
        renderConsole();
        renderHierarchy();
        if (state.hasBridge && state.appId) refresh();
    }

    function setActive(active) {
        if (active && !state.pollTimer) {
            state.pollTimer = window.setInterval(refresh, POLL_INTERVAL_MS);
            refresh();
        }
        if (!active && state.pollTimer) {
            window.clearInterval(state.pollTimer);
            state.pollTimer = null;
        }
    }

    async function refresh() {
        if (!state.hasBridge || !state.appId) return;
        await Promise.all([loadStatus(), loadLogs(), loadCompileStatus(), loadHierarchy()]);
    }

    async function fetchUnity(path, options) {
        const appId = encodeURIComponent(state.appId);
        const response = await apiFetch(`/unity/${appId}/${path}`, options);
        const body = await response.json().catch(() => ({}));
        return { response, body };
    }

    async function loadStatus() {
        try {
            const { response, body } = await fetchUnity("status");
            renderBridge(body.bridge, response.ok);
            if (!response.ok) return;
            const data = body.data ?? {};
            elements.version.textContent = data.unityVersion ? `Unity ${data.unityVersion}` : "Unity";
            elements.mode.textContent = data.isCompiling ? "Compiling" : data.isPlaying ? "Playing" : "Edit mode";
            elements.scene.textContent = data.activeScene || "No active scene";
        } catch {
            renderBridge("down", false);
        }
    }

    async function loadLogs() {
        try {
            const { response, body } = await fetchUnity(`log?since=${state.nextSeq}&limit=200`);
            renderBridge(body.bridge, response.ok);
            if (!response.ok) return;
            const data = body.data ?? {};
            state.logs = appendUnityLogs(state.logs, data.entries ?? []);
            state.nextSeq = data.nextSeq ?? state.nextSeq;
            renderConsole();
        } catch {
            // Domain reload is reported by the status surface; leave the console intact.
        }
    }

    async function loadCompileStatus() {
        try {
            const { response, body } = await fetchUnity("compile-status");
            renderBridge(body.bridge, response.ok);
            if (!response.ok) return;
            const data = body.data ?? {};
            elements.errors.textContent = `Error ${data.errorCount ?? 0}`;
            elements.warnings.textContent = `Warn ${data.warningCount ?? 0}`;
        } catch {
            // A temporary bridge loss should not clear the last useful counters.
        }
    }

    async function loadHierarchy(root) {
        try {
            const suffix = root ? `&root=${encodeURIComponent(root)}` : "";
            const { response, body } = await fetchUnity(`hierarchy?depth=1${suffix}`);
            renderBridge(body.bridge, response.ok);
            if (!response.ok) return;
            const data = body.data ?? {};
            if (root) {
                replaceNodeChildren(state.hierarchy, root, data.nodes ?? []);
                state.loadedNodeIds.add(root);
            }
            else state.hierarchy = data.nodes ?? [];
            elements.truncated.hidden = !data.truncated;
            renderHierarchy();
        } catch {
            // Keep the last hierarchy while Unity reloads.
        }
    }

    function replaceNodeChildren(nodes, nodeId, children) {
        for (const node of nodes) {
            if (node.id === nodeId) {
                node.children = children;
                return true;
            }
            if (node.children && replaceNodeChildren(node.children, nodeId, children)) return true;
        }
        return false;
    }

    async function onHierarchyClick(event) {
        const row = event.target.closest("[data-unity-node]");
        if (!row) return;
        const nodeId = row.dataset.unityNode;
        const node = findNode(state.hierarchy, nodeId);
        if (!node) return;
        state.selectedId = nodeId;
        const wasExpanded = state.expandedIds.has(nodeId);
        if (node.childCount > 0) {
            state.expandedIds = toggleHierarchyExpansion(state.expandedIds, nodeId);
            if (!wasExpanded && !state.loadedNodeIds.has(nodeId)) await loadHierarchy(nodeId);
        }
        renderHierarchy();
    }

    function findNode(nodes, nodeId) {
        for (const node of nodes) {
            if (node.id === nodeId) return node;
            if (node.children) {
                const found = findNode(node.children, nodeId);
                if (found) return found;
            }
        }
        return null;
    }

    function renderAvailability() {
        const available = state.hasBridge && state.appId;
        elements.unavailable.hidden = available;
        elements.content.hidden = !available;
    }

    function renderBridge(bridge, isOk) {
        const presentation = bridgePresentation(bridge);
        elements.bridge.textContent = isOk ? presentation.label : "reloading / offline";
        elements.bridge.dataset.state = isOk ? presentation.state : "down";
    }

    function renderHierarchy() {
        elements.hierarchy.replaceChildren();
        const rows = flattenHierarchy(state.hierarchy, state.expandedIds);
        if (rows.length === 0) {
            elements.hierarchy.textContent = "Hierarchy is unavailable until Unity responds.";
            return;
        }
        for (const { node, depth, expanded } of rows) {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "unity-hierarchy-row";
            row.dataset.unityNode = node.id;
            row.style.paddingInlineStart = `${8 + depth * 16}px`;
            row.classList.toggle("selected", node.id === state.selectedId);
            const disclosure = node.childCount > 0 ? (expanded ? "▾" : "▸") : "·";
            row.textContent = `${disclosure} ${node.name}`;
            row.title = (node.components ?? []).join(", ") || "No components";
            elements.hierarchy.appendChild(row);
        }
    }

    function renderConsole() {
        elements.console.replaceChildren();
        const entries = filterUnityLogs(state.logs, state.filter);
        for (const entry of entries) {
            const line = document.createElement("div");
            line.className = `unity-console-line ${entry.level.toLowerCase()}`;
            line.textContent = `[${entry.level}] ${entry.message}`;
            const source = extractSourceLocation(`${entry.message}\n${entry.stackTrace ?? ""}`);
            if (source) {
                line.classList.add("copyable");
                line.dataset.copyPath = source;
                line.title = `Copy ${source}`;
            }
            elements.console.appendChild(line);
        }
    }

    function extractSourceLocation(text) {
        return text.match(/[\w./\\-]+\.cs:\d+(?::\d+)?/)?.[0] ?? null;
    }

    async function onConsoleClick(event) {
        const line = event.target.closest("[data-copy-path]");
        if (!line) return;
        await navigator.clipboard?.writeText(line.dataset.copyPath);
        setActionStatus("Path copied");
    }

    async function runAction(button) {
        if (!state.hasBridge || !state.appId) return;
        const action = button.dataset.unityAction;
        let body;
        if (action === "publish-capture") {
            const caption = window.prompt("Caption for this capture", "");
            if (caption === null) return;
            body = JSON.stringify({ caption, source: "webui" });
        }
        button.disabled = true;
        setActionStatus(`${button.textContent.trim()} requested…`);
        try {
            const { response, body: result } = await fetchUnity(action, {
                method: "POST",
                body,
            });
            renderBridge(result.bridge, response.ok);
            setActionStatus(response.ok ? "Request accepted" : `Request failed (HTTP ${response.status})`);
        } catch {
            setActionStatus("Request interrupted while Unity reloads");
        } finally {
            button.disabled = false;
        }
    }

    function setActionStatus(message) {
        elements.status.textContent = message;
    }

    return { setApp, setActive };
}
