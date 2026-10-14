/**
 * バーチャルパッド。app のパッド定義 (input.pad、無ければ buttons から推測) の部品だけを並べ、
 * 押している間だけキーを押す。
 *
 * 並び (spec/feature/floating-ui-and-shared-video.md §1.3):
 *   上段: LT・LB / View・Menu など / RB・RT
 *   中段: 左スティック (無ければ十字キー) / ABXY
 *   下段: 十字キー (左スティックがあるとき) / 右スティック
 * スティックは傾きを 8 方向に分けて方向キーの押下 / 解放にし、ダブルタップで押し込み (L3 / R3)。
 * 観戦中は押しても送らない (見た目も CSS で無効化する)。
 */

import {
    diffPressed,
    isDoubleTap,
    labelToId,
    normalizeStick,
    padDefinition,
    stickDirections,
} from "/js/virtual-pad-logic.js";

const DIRECTIONS = ["up", "down", "left", "right"];
const ARROWS = { up: "↑", down: "↓", left: "←", right: "→" };
/** 押し込みキーのタップ (down → up) の間隔。 */
const TAP_MS = 60;

export function createVirtualPad({ root, sendKey, onAction, canOperate }) {
    let config = null;
    /** 押しっぱなしを解放する関数。app 切り替え・観戦への切り替えで全部呼ぶ。 */
    let releasers = [];

    function setApp(nextConfig) {
        releaseAll();
        config = nextConfig;
        render();
    }

    function releaseAll() {
        for (const release of releasers) release();
    }

    function render() {
        releasers = [];
        root.replaceChildren();
        if (!config) {
            root.appendChild(emptyMessage("アプリを選択するとバーチャルパッドが表示されます。"));
            return;
        }
        const pad = padDefinition(config.input);
        const hasAny = pad.leftStick || pad.rightStick || pad.dpad || pad.face || pad.shoulders || pad.menu.length;
        if (!hasAny) {
            root.appendChild(emptyMessage("このアプリにはパッドが定義されていません (config の input.pad か input.buttons)。"));
            return;
        }

        const grid = document.createElement("div");
        grid.className = "vk-pad";

        const top = zone("vk-zone-top");
        if (pad.shoulders) top.appendChild(shoulderGroup([["LT", pad.shoulders.lt], ["LB", pad.shoulders.lb]]));
        if (pad.menu.length) {
            const menu = document.createElement("div");
            menu.className = "vk-menu-row";
            for (const b of pad.menu) menu.appendChild(menuButton(b));
            top.appendChild(menu);
        }
        if (pad.shoulders) top.appendChild(shoulderGroup([["RB", pad.shoulders.rb], ["RT", pad.shoulders.rt]]));
        if (top.childElementCount) grid.appendChild(top);

        // 左スティックが無ければ、十字キーを中段の左に上げる。
        const midLeft = pad.leftStick ? stickElement(pad.leftStick, "L") : pad.dpad ? plusElement(pad.dpad) : null;
        const bottomLeft = pad.leftStick && pad.dpad ? plusElement(pad.dpad) : null;
        if (midLeft) grid.appendChild(placed(midLeft, "vk-mid-left"));
        if (pad.face) grid.appendChild(placed(diamondElement(pad.face), "vk-mid-right"));
        if (bottomLeft) grid.appendChild(placed(bottomLeft, "vk-bottom-left"));
        if (pad.rightStick) grid.appendChild(placed(stickElement(pad.rightStick, "R"), "vk-bottom-right"));

        root.appendChild(grid);
    }

    function shoulderGroup(entries) {
        const group = document.createElement("div");
        group.className = "vk-shoulder-row";
        for (const [label, key] of entries) {
            if (key) group.appendChild(keyButton(label, key, { kind: "shoulder" }));
        }
        return group;
    }

    function plusElement(keys) {
        const plus = document.createElement("div");
        plus.className = "vk-plus";
        for (const dir of DIRECTIONS) {
            if (keys[dir]) plus.appendChild(keyButton(ARROWS[dir], keys[dir], { area: dir, kind: "dir" }));
        }
        return plus;
    }

    function diamondElement(face) {
        const diamond = document.createElement("div");
        diamond.className = "vk-diamond";
        for (const name of ["y", "x", "b", "a"]) {
            if (face[name]) diamond.appendChild(keyButton(name.toUpperCase(), face[name], { area: name, kind: `act-${name}` }));
        }
        return diamond;
    }

    function menuButton(b) {
        if (b.action) {
            const el = document.createElement("button");
            el.type = "button";
            el.className = "vk-btn";
            el.dataset.kind = "menu";
            el.dataset.id = labelToId(b.label);
            el.textContent = b.label;
            if (b.action === "kill") el.classList.add("danger");
            el.addEventListener("click", () => {
                if (canOperate()) onAction(b.action);
            });
            return el;
        }
        return keyButton(b.label, b.key, { kind: "menu" });
    }

    /** 押している間だけ key を押すボタン。 */
    function keyButton(label, key, opts = {}) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "vk-btn";
        if (opts.area) el.style.gridArea = opts.area;
        if (opts.kind) el.dataset.kind = opts.kind;
        el.textContent = label;
        const tag = document.createElement("span");
        tag.className = "vk-keytag";
        tag.textContent = key;
        el.appendChild(tag);

        let held = false;
        const press = (ev) => {
            ev.preventDefault();
            if (held || !canOperate()) return;
            held = true;
            el.setPointerCapture?.(ev.pointerId);
            el.classList.add("active");
            sendKey(key, true);
        };
        const release = () => {
            if (!held) return;
            held = false;
            el.classList.remove("active");
            sendKey(key, false);
        };
        el.addEventListener("pointerdown", press);
        el.addEventListener("pointerup", release);
        el.addEventListener("pointercancel", release);
        el.addEventListener("contextmenu", (ev) => ev.preventDefault());
        releasers.push(release);
        return el;
    }

    /** アナログスティック。傾きを 8 方向に分け、方向キーの押下 / 解放にする。ダブルタップで press。 */
    function stickElement(keys, name) {
        const base = document.createElement("div");
        base.className = "vk-stick";
        base.dataset.stick = name;
        const labels = {};
        for (const dir of DIRECTIONS) {
            if (!keys[dir]) continue;
            const label = document.createElement("span");
            label.className = `vk-stick-dir ${dir}`;
            label.textContent = keys[dir];
            labels[dir] = label;
            base.appendChild(label);
        }
        const knob = document.createElement("div");
        knob.className = "vk-stick-knob";
        knob.textContent = keys.press ? `${name}3` : "";
        base.appendChild(knob);

        let pressed = new Set();
        let pointerId = null;
        let lastTapAt = null;

        const setPressed = (next) => {
            const { press, release } = diffPressed(pressed, next);
            for (const dir of release) sendKey(keys[dir], false);
            for (const dir of press) sendKey(keys[dir], true);
            pressed = next;
            for (const [dir, label] of Object.entries(labels)) label.classList.toggle("on", next.has(dir));
        };
        const update = (ev) => {
            const rect = base.getBoundingClientRect();
            const radius = rect.width / 2;
            const { dx, dy } = normalizeStick(
                ev.clientX - (rect.left + radius),
                ev.clientY - (rect.top + rect.height / 2),
                radius,
            );
            knob.style.transform = `translate(${dx * radius * 0.6}px, ${dy * radius * 0.6}px)`;
            setPressed(new Set([...stickDirections(dx, dy)].filter((dir) => keys[dir])));
        };
        const end = () => {
            if (pointerId === null) return;
            pointerId = null;
            base.classList.remove("active");
            knob.style.transform = "";
            setPressed(new Set());
        };
        const tapPress = () => {
            sendKey(keys.press, true);
            window.setTimeout(() => sendKey(keys.press, false), TAP_MS);
            base.classList.add("pressed");
            window.setTimeout(() => base.classList.remove("pressed"), 150);
        };

        base.addEventListener("pointerdown", (ev) => {
            if (!canOperate() || pointerId !== null) return;
            ev.preventDefault();
            const now = performance.now();
            if (keys.press && isDoubleTap(lastTapAt, now)) {
                lastTapAt = null;
                tapPress();
            } else {
                lastTapAt = now;
            }
            pointerId = ev.pointerId;
            base.setPointerCapture?.(ev.pointerId);
            base.classList.add("active");
            update(ev);
        });
        base.addEventListener("pointermove", (ev) => {
            if (ev.pointerId === pointerId) update(ev);
        });
        base.addEventListener("pointerup", (ev) => { if (ev.pointerId === pointerId) end(); });
        base.addEventListener("pointercancel", (ev) => { if (ev.pointerId === pointerId) end(); });
        releasers.push(end);
        return base;
    }

    return { setApp, releaseAll };
}

function zone(className) {
    const el = document.createElement("div");
    el.className = `vk-zone ${className}`;
    return el;
}

function placed(child, className) {
    const el = zone(className);
    el.appendChild(child);
    return el;
}

function emptyMessage(text) {
    const el = document.createElement("div");
    el.className = "vk-empty";
    el.textContent = text;
    return el;
}
