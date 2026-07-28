export const UNITY_LOG_LIMIT = 500;

export function bridgePresentation(bridge) {
    if (bridge === "up") return { label: "bridge: up", state: "up" };
    if (bridge === "busy") return { label: "Unity busy", state: "busy" };
    return { label: "reloading / offline", state: "down" };
}

export function filterUnityLogs(entries, level) {
    if (level === "all") return entries;
    return entries.filter((entry) => entry.level.toLowerCase() === level);
}

export function appendUnityLogs(currentEntries, newEntries, limit = UNITY_LOG_LIMIT) {
    return [...currentEntries, ...newEntries].slice(-limit);
}

export function flattenHierarchy(nodes, expandedIds, depth = 0) {
    const rows = [];
    for (const node of nodes) {
        rows.push({ node, depth, expanded: expandedIds.has(node.id) });
        if (expandedIds.has(node.id) && node.children) {
            rows.push(...flattenHierarchy(node.children, expandedIds, depth + 1));
        }
    }
    return rows;
}

export function toggleHierarchyExpansion(expandedIds, nodeId) {
    const next = new Set(expandedIds);
    if (next.has(nodeId)) next.delete(nodeId);
    else next.add(nodeId);
    return next;
}
