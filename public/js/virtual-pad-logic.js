/**
 * バーチャルパッドの純関数 (DOM に触らない。vitest 対象)。
 *
 * - app の input.buttons をゲームパッドの位置 (十字・スティック・ABXY・肩・メニュー) に振り分ける
 * - アナログスティックの傾きを 8 方向の押下キーに変換する
 * - 押下状態の差分から、押す / 離すキーを出す
 */

/** スティックをこれ以上倒したら入力とみなす (半径に対する割合)。 */
export const STICK_DEADZONE = 0.3;

/**
 * input.buttons をパッドの位置に振り分ける。同じ位置に複数あれば最初の 1 つを採り、
 * 残りは extras に回す。
 * @param {Array<{label?:string, key?:string, action?:string}>} buttons
 */
export function layoutPadButtons(buttons) {
    const slots = {
        dpad:     { up: null, down: null, left: null, right: null },
        stick:    { up: null, down: null, left: null, right: null },
        actions:  { a: null, b: null, x: null, y: null },
        shoulder: { lb: null, rb: null, lt: null, rt: null },
        menu:     [],
        extras:   [],
    };
    for (const button of buttons) {
        const slot = classifyButton(button);
        if (slot.zone === "menu" || slot.zone === "extras") {
            slots[slot.zone].push(button);
            continue;
        }
        if (slots[slot.zone][slot.slot] === null) slots[slot.zone][slot.slot] = button;
        else slots.extras.push(button);
    }
    return slots;
}

/**
 * `b.label` / `b.key` から表示位置を推定する。`key` を優先して見るので、
 * 矢印キー (十字) と WASD (スティック) を取り違えない。
 * @param {{label?:string, key?:string, action?:string}} b
 * @returns {{zone:"dpad"|"stick"|"actions"|"shoulder", slot:string} | {zone:"menu"|"extras"}}
 */
export function classifyButton(b) {
    if (b.action) return { zone: "extras" };
    const key = (b.key ?? "").trim();
    const label = (b.label ?? "").trim();

    const dpad = { Up: "up", Down: "down", Left: "left", Right: "right" };
    if (dpad[key]) return { zone: "dpad", slot: dpad[key] };
    const stick = { W: "up", S: "down", A: "left", D: "right" };
    if (stick[key]) return { zone: "stick", slot: stick[key] };

    if (/^(lb|l1)$/i.test(label)) return { zone: "shoulder", slot: "lb" };
    if (/^(rb|r1)$/i.test(label)) return { zone: "shoulder", slot: "rb" };
    if (/^(lt|l2)$/i.test(label)) return { zone: "shoulder", slot: "lt" };
    if (/^(rt|r2)$/i.test(label)) return { zone: "shoulder", slot: "rt" };

    if (key === "Escape" || /^(pause|menu|start|select|back)$/i.test(label)) return { zone: "menu" };

    if (label === "A" || /^jump$/i.test(label) || key === "Space") return { zone: "actions", slot: "a" };
    if (label === "B" || /^attack$/i.test(label))                  return { zone: "actions", slot: "b" };
    if (label === "X" || /^(special|dodge)$/i.test(label))         return { zone: "actions", slot: "x" };
    if (label === "Y" || /^(skill|use)$/i.test(label))             return { zone: "actions", slot: "y" };
    return { zone: "extras" };
}

/** label → button id (src/ws/handler.ts の labelToId と一致させる)。 */
export function labelToId(label) {
    return label.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

/**
 * スティックの方向入力に使うキー。スティック位置 (WASD) を優先し、無い方向は十字 (矢印) で補う。
 * @param {ReturnType<typeof layoutPadButtons>} slots
 * @returns {{up:string|null, down:string|null, left:string|null, right:string|null}}
 */
export function directionKeys(slots) {
    const pick = (dir) => slots.stick[dir]?.key ?? slots.dpad[dir]?.key ?? null;
    return { up: pick("up"), down: pick("down"), left: pick("left"), right: pick("right") };
}

/**
 * スティックの傾き (中心からのずれを半径で割った値) を、押している方向に変換する。
 * 8 方向: 斜めは 2 方向を同時に押す。デッドゾーン内は何も押さない。
 * @param {number} dx 右が正。-1..1
 * @param {number} dy 下が正。-1..1
 * @returns {Set<"up"|"down"|"left"|"right">}
 */
export function stickDirections(dx, dy, deadzone = STICK_DEADZONE) {
    const directions = new Set();
    if (Math.hypot(dx, dy) < deadzone) return directions;
    // 22.5° ずつずらした 8 分割。軸から ±67.5° 以内ならその軸の方向を押す。
    const angle = Math.atan2(-dy, dx);   // 上が正
    const near = (target) => Math.abs(normalizeAngle(angle - target)) < (Math.PI * 3) / 8;
    if (near(Math.PI / 2))  directions.add("up");
    if (near(-Math.PI / 2)) directions.add("down");
    if (near(0))            directions.add("right");
    if (near(Math.PI))      directions.add("left");
    return directions;
}

/**
 * 押下状態の差分。前に押していて今は押していないものを release、その逆を press。
 * @template T
 * @param {Set<T>} previous
 * @param {Set<T>} next
 * @returns {{press:T[], release:T[]}}
 */
export function diffPressed(previous, next) {
    return {
        press:   [...next].filter((value) => !previous.has(value)),
        release: [...previous].filter((value) => !next.has(value)),
    };
}

/** スティックの中心からのずれを、半径で割って -1..1 に収める。 */
export function normalizeStick(offsetX, offsetY, radius) {
    if (!(radius > 0)) return { dx: 0, dy: 0 };
    const length = Math.hypot(offsetX, offsetY);
    const scale = length > radius ? radius / length : 1;
    return { dx: (offsetX * scale) / radius, dy: (offsetY * scale) / radius };
}

function normalizeAngle(angle) {
    let a = angle;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
}
