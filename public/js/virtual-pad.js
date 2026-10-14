/**
 * バーチャルパッド。app の input.buttons をゲームパッドの形に並べ、押している間だけキーを押す。
 *
 * 左の方向入力はアナログスティックと十字キーを切り替えられる (選択はブラウザに保存)。
 * スティックは 8 方向に分けて、方向キーの押下 / 解放として送る。観戦中は押しても送らない
 * (見た目も CSS で無効化する)。
 */

import {
    diffPressed,
    directionKeys,
    labelToId,
    layoutPadButtons,
    normalizeStick,
    stickDirections,
} from "/js/virtual-pad-logic.js";

const MODE_KEY = "custos.padMode";
const DIRECTIONS = ["up", "down", "left", "right"];
const ARROWS = { up: "↑", down: "↓", left: "←", right: "→" };

export function createVirtualPad({ root, modeToggle, sendKey, onAction, canOperate }) {
    let config = null;
    let mode = readMode();
    /** 押しっぱなしを解放する関数。app 切り替え・観戦への切り替えで全部呼ぶ。 */
    let releasers = [];

    modeToggle.addEventListener("click", () => {
        releaseAll();
        mode = mode === "stick" ? "dpad" : "stick";
        writeMode(mode);
        render();
    });

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
        modeToggle.textContent = mode === "stick" ? "STICK" : "D-PAD";
        const buttons = config?.input?.buttons ?? [];
        if (!config || buttons.length === 0) {
            modeToggle.hidden = true;
            root.appendChild(emptyMessage(config
                ? "このアプリにはボタンが定義されていません (config/apps.json の input.buttons)。"
                : "アプリを選択するとバーチャルパッドが表示されます。"));
            return;
        }
        const slots = layoutPadButtons(buttons);
        const keys = directionKeys(slots);
        const hasDirection = DIRECTIONS.some((dir) => keys[dir]);
        modeToggle.hidden = !hasDirection;

        const pad = document.createElement("div");
        pad.className = "vk-pad";
        appendShoulders(pad, slots.shoulder);
        if (hasDirection) {
            const zone = zoneElement("vk-zone-dir");
            zone.appendChild(mode === "stick" ? stickElement(keys) : plusElement(slots));
            pad.appendChild(zone);
        }
        if (slots.menu.length) {
            const zone = zoneElement("vk-zone-menu");
            for (const b of slots.menu) zone.appendChild(buttonElement(b, b.label, { kind: "menu" }));
            pad.appendChild(zone);
        }
        if (Object.values(slots.actions).some(Boolean)) {
            const zone = zoneElement("vk-zone-actions");
            const diamond = document.createElement("div");
            diamond.className = "vk-diamond";
            for (const name of ["y", "x", "b", "a"]) {
                diamond.appendChild(buttonElement(slots.actions[name], name.toUpperCase(), { area: name, kind: `act-${name}` }));
            }
            zone.appendChild(diamond);
            pad.appendChild(zone);
        }
        if (slots.extras.length) {
            const zone = zoneElement("vk-zone-extras");
            for (const b of slots.extras) zone.appendChild(buttonElement(b, b.label, { kind: "extras" }));
            pad.appendChild(zone);
        }
        root.appendChild(pad);
    }

    function appendShoulders(pad, shoulder) {
        if (!Object.values(shoulder).some(Boolean)) return;
        const zone = zoneElement("vk-zone-shoulder");
        const left = document.createElement("div");
        left.className = "vk-shoulder-row";
        const right = document.createElement("div");
        right.className = "vk-shoulder-row";
        left.append(buttonElement(shoulder.lt, "LT"), buttonElement(shoulder.lb, "LB"));
        right.append(buttonElement(shoulder.rb, "RB"), buttonElement(shoulder.rt, "RT"));
        zone.append(left, right);
        pad.appendChild(zone);
    }

    /** 十字キー。矢印キーが無い方向は WASD で補う。 */
    function plusElement(slots) {
        const plus = document.createElement("div");
        plus.className = "vk-plus";
        for (const dir of DIRECTIONS) {
            const b = slots.dpad[dir] ?? slots.stick[dir];
            plus.appendChild(buttonElement(b, ARROWS[dir], { area: dir, kind: "dir" }));
        }
        return plus;
    }

    /** アナログスティック。傾きを 8 方向に分け、方向キーの押下 / 解放にする。 */
    function stickElement(keys) {
        const base = document.createElement("div");
        base.className = "vk-stick";
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
        base.appendChild(knob);

        let pressed = new Set();
        let pointerId = null;

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

        base.addEventListener("pointerdown", (ev) => {
            if (!canOperate() || pointerId !== null) return;
            ev.preventDefault();
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

    /**
     * 1 ボタン。b が null なら空き枠 (placeholder)。キーは押している間だけ押下、
     * action (kill など) は単発。
     */
    function buttonElement(b, fallbackLabel, opts = {}) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "vk-btn";
        if (opts.area) el.style.gridArea = opts.area;
        if (opts.kind) el.dataset.kind = opts.kind;
        if (!b) {
            el.classList.add("placeholder");
            el.textContent = fallbackLabel;
            el.disabled = true;
            return el;
        }
        el.dataset.id = labelToId(b.label);
        el.textContent = b.label || fallbackLabel;
        if (b.action) {
            el.dataset.action = b.action;
            if (b.action === "kill") el.classList.add("danger");
            el.addEventListener("click", () => {
                if (canOperate()) onAction(b.action);
            });
            return el;
        }
        if (!b.key) return el;
        const tag = document.createElement("span");
        tag.className = "vk-keytag";
        tag.textContent = b.key;
        el.appendChild(tag);

        let held = false;
        const press = (ev) => {
            ev.preventDefault();
            if (held || !canOperate()) return;
            held = true;
            el.setPointerCapture?.(ev.pointerId);
            el.classList.add("active");
            sendKey(b.key, true);
        };
        const release = () => {
            if (!held) return;
            held = false;
            el.classList.remove("active");
            sendKey(b.key, false);
        };
        el.addEventListener("pointerdown", press);
        el.addEventListener("pointerup", release);
        el.addEventListener("pointercancel", release);
        el.addEventListener("contextmenu", (ev) => ev.preventDefault());
        releasers.push(release);
        return el;
    }

    return { setApp, releaseAll };
}

function zoneElement(className) {
    const zone = document.createElement("div");
    zone.className = `vk-zone ${className}`;
    return zone;
}

function emptyMessage(text) {
    const el = document.createElement("div");
    el.className = "vk-empty";
    el.textContent = text;
    return el;
}

function readMode() {
    try {
        return localStorage.getItem(MODE_KEY) === "dpad" ? "dpad" : "stick";
    } catch {
        return "stick";   // ストレージが使えなければ既定のスティック
    }
}

function writeMode(mode) {
    try {
        localStorage.setItem(MODE_KEY, mode);
    } catch {
        /* 保存できなくても切り替え自体は効く。次回は既定に戻るだけ */
    }
}
