/**
 * Electron wrapper — Custos の backend (API+WS) と frontend (静的) を
 * 子プロセスで起こして、BrowserWindow を frontend port に向ける。
 *
 * 通常は `npm run start` から呼ばれる:
 *   1. backend port (既定 7676) と frontend port (既定 4649) を決める
 *   2. `node dist/main.js` (または開発時は `tsx src/main.ts`) を spawn
 *   3. backend /api/health が応答したら BrowserWindow を frontend に向ける
 *
 * Electron はロジックを持たず単に「ローカル UI を開きやすくする」役割。
 * リモートで使うなら Electron 抜きで `npm run serve` だけでよい。
 */

const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const { spawn } = require("child_process");
const http = require("http");

const BACKEND_PORT  = Number(process.env.CUSTOS_PORT          || 7676);
const FRONTEND_PORT = Number(process.env.CUSTOS_FRONTEND_PORT || 4649);
const DEV  = process.env.NODE_ENV !== "production" && process.env.CUSTOS_DEV !== "0";

let serverProc = null;
let mainWindow = null;

function startServer() {
    const root = path.resolve(__dirname, "..");
    const cmd  = DEV ? "npx" : "node";
    const args = DEV ? ["tsx", "src/main.ts"] : ["dist/main.js"];
    serverProc = spawn(cmd, args, {
        cwd: root,
        env: {
            ...process.env,
            CUSTOS_PORT:          String(BACKEND_PORT),
            CUSTOS_FRONTEND_PORT: String(FRONTEND_PORT),
        },
        stdio: ["ignore", "inherit", "inherit"],
        shell: process.platform === "win32",
    });
    serverProc.on("exit", (code, signal) => {
        console.log(`[custos-electron] server exited (code=${code} signal=${signal})`);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.executeJavaScript("alert('Custos server exited — closing window.')").catch(() => {});
            mainWindow.close();
        }
    });
}

function waitForBackend(timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tryOnce = () => {
            const req = http.get({ host: "127.0.0.1", port: BACKEND_PORT, path: "/api/health", timeout: 500 }, (res) => {
                res.resume();
                if (res.statusCode === 200) resolve();
                else retry();
            });
            req.on("error", retry);
        };
        const retry = () => {
            if (Date.now() > deadline) reject(new Error("custos backend did not become ready in time"));
            else setTimeout(tryOnce, 250);
        };
        tryOnce();
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width:  1280,
        height: 880,
        backgroundColor: "#0f131c",
        title: "Custos — Remote Test Runner",
        webPreferences: {
            contextIsolation: true,
            sandbox: true,
        },
    });
    mainWindow.loadURL(`http://localhost:${FRONTEND_PORT}/`);
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: "deny" };
    });
    mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
    startServer();
    try {
        await waitForBackend();
    } catch (err) {
        console.error("[custos-electron]", err);
    }
    createWindow();
});

app.on("window-all-closed", () => {
    if (serverProc) {
        try { serverProc.kill("SIGTERM"); } catch (_) { /* ignore */ }
    }
    if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
    if (serverProc) {
        try { serverProc.kill("SIGTERM"); } catch (_) { /* ignore */ }
        serverProc = null;
    }
});
