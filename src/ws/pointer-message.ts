/**
 * WS `pointer` メッセージの境界検証。クライアント入力なので型だけを信用しない。
 */

import { z } from "zod";
import type { ClientMessage } from "../shared/types.js";

const pointerMessageSchema = z.object({
    type:   z.literal("pointer"),
    appId:  z.string().min(1),
    x:      z.number().finite().min(0).max(1),
    y:      z.number().finite().min(0).max(1),
    button: z.enum(["left", "right", "middle"]),
    phase:  z.enum(["down", "up", "move"]),
});

export type PointerMessage = Extract<ClientMessage, { type: "pointer" }>;

export function isPointerMessage(msg: unknown): msg is PointerMessage {
    return pointerMessageSchema.safeParse(msg).success;
}
