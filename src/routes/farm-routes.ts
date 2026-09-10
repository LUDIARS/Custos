/** HTTP boundary for user leases and trusted host inventory reports. */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { HonoRequest } from "hono";
import { ZodError, type ZodType } from "zod";
import { cernereAuthMiddleware } from "../auth/middleware.js";
import { childLogger } from "../shared/logger.js";
import { FarmError } from "../farm/error.js";
import { acquireSchema, hostReportSchema, releaseSchema, renewSchema } from "../farm/schema.js";
import type { FarmRuntime } from "../farm/runtime.js";

const log = childLogger("device-farm");

export function createFarmRoutes({ pool, hostAuth }: FarmRuntime): Hono {
    const app = new Hono();
    app.use("*", bodyLimit({ maxSize: 256 * 1024 }));
    app.onError((error, c) => {
        if (error instanceof HTTPException) return error.getResponse();
        if (error instanceof FarmError) return c.json({ error: error.code }, error.status);
        // Disk paths, bearer tokens and request bodies are not part of diagnostics.
        log.error({ errorType: error.name }, "device farm operation failed");
        return c.json({ error: "farm_storage_unavailable" }, 503);
    });

    app.post("/hosts/:hostId/report", async (c) => {
        const hostId = c.req.param("hostId");
        if (!hostAuth.verify(hostId, c.req.header("authorization") ?? "")) return c.json({ error: "unauthorized_host" }, 401);
        const input = await parseBody(c.req, hostReportSchema);
        return c.json({ devices: pool.report(hostId, input) });
    });

    app.use("/devices", cernereAuthMiddleware());
    app.use("/devices/*", cernereAuthMiddleware());
    app.get("/devices", (c) => c.json({ devices: pool.list() }));
    app.post("/devices/:deviceId/lease", async (c) => {
        const input = await parseBody(c.req, acquireSchema);
        return c.json(pool.acquire(c.req.param("deviceId"), c.get("user").id, input.ttlSec), 201);
    });
    app.post("/devices/:deviceId/lease/renew", async (c) => {
        const input = await parseBody(c.req, renewSchema);
        return c.json(pool.renew(c.req.param("deviceId"), c.get("user").id, input.leaseId, input.ttlSec));
    });
    app.post("/devices/:deviceId/lease/release", async (c) => {
        const input = await parseBody(c.req, releaseSchema);
        return c.json(pool.release(c.req.param("deviceId"), c.get("user").id, input.leaseId));
    });
    return app;
}

async function parseBody<T>(request: HonoRequest, schema: ZodType<T>): Promise<T> {
    try {
        return schema.parse(await request.json());
    } catch (error) {
        if (error instanceof ZodError || error instanceof SyntaxError) throw new FarmError("invalid_body", 400);
        throw error;
    }
}
