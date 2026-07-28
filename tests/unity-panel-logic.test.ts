import { describe, expect, it } from "vitest";
import {
    appendUnityLogs,
    bridgePresentation,
    filterUnityLogs,
    flattenHierarchy,
    toggleHierarchyExpansion,
} from "../public/js/unity-panel-logic.js";

describe("unity panel logic", () => {
    const entries = [
        { level: "Log", message: "hello" },
        { level: "Error", message: "bad" },
        { level: "Warn", message: "careful" },
    ];

    it("filters logs by level", () => {
        expect(filterUnityLogs(entries, "all")).toHaveLength(3);
        expect(filterUnityLogs(entries, "error")).toEqual([entries[1]]);
    });

    it("keeps only the newest log entries", () => {
        expect(appendUnityLogs(entries, [{ level: "Log", message: "latest" }], 2))
            .toEqual([entries[2], { level: "Log", message: "latest" }]);
    });

    it("maps bridge states to calm user-facing labels", () => {
        expect(bridgePresentation("up").label).toBe("bridge: up");
        expect(bridgePresentation("down").label).toBe("reloading / offline");
        expect(bridgePresentation("busy").label).toBe("Unity busy");
    });

    it("flattens only expanded hierarchy children and toggles expansion", () => {
        const nodes = [{ id: "scene", name: "Scene", children: [{ id: "camera", name: "Camera" }] }];
        const expanded = toggleHierarchyExpansion(new Set(), "scene");
        expect(flattenHierarchy(nodes, expanded).map((row) => row.node.id)).toEqual(["scene", "camera"]);
        expect(toggleHierarchyExpansion(expanded, "scene").has("scene")).toBe(false);
    });
});
