const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const WORK = __dirname;
const VIDEOS = path.join(WORK, "captured");
fs.mkdirSync(VIDEOS, { recursive: true });
const manifest = [];

async function captureHtmlScene(name, file, durationMs) {
  const dir = path.join(VIDEOS, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir, size: { width: 1920, height: 1080 } },
  });
  const contextStart = Date.now();
  const page = await context.newPage();
  await page.goto("file://" + file.replace(/\\/g, "/"));
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
  const readyAt = Date.now();
  await page.waitForTimeout(durationMs + 500);
  await page.close();
  await context.close();
  await browser.close();
  const f = fs.readdirSync(dir).find((x) => x.endsWith(".webm"));
  const offsetSec = Math.max(0, (readyAt - contextStart) / 1000);
  manifest.push({ name, file: path.join(dir, f), offsetSec, durationSec: durationMs / 1000 });
  console.log(name, "-> offset", offsetSec.toFixed(3), "dur", durationMs / 1000);
}

async function captureLogin(durationMs) {
  const name = "login";
  const dir = path.join(VIDEOS, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir, size: { width: 1920, height: 1080 } },
  });
  const contextStart = Date.now();
  const page = await context.newPage();

  const logoSvg = fs.readFileSync(path.join(WORK, "scenes", "logo.svg"), "utf8");
  await page.route("**/website/logo**", (route) =>
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: logoSvg })
  );
  await page.route("**/tenant/login**", () => {});

  await page.goto("http://localhost:98/login");
  await page.waitForSelector('input[placeholder="username"]', { timeout: 15000 });
  await page.waitForTimeout(400);
  const readyAt = Date.now();

  await page.click('input[placeholder="username"]');
  await page.type('input[placeholder="username"]', "j.alvarez", { delay: 85 });
  await page.waitForTimeout(150);
  await page.click('input[placeholder="Enter password"]');
  await page.type('input[placeholder="Enter password"]', "••••••••••", { delay: 70 });
  await page.waitForTimeout(250);

  const loginBtn = page.locator('button[type="submit"]');
  await loginBtn.hover();
  await page.waitForTimeout(200);
  await loginBtn.click();
  await page.waitForTimeout(500);

  await page.close();
  await context.close();
  await browser.close();
  const f = fs.readdirSync(dir).find((x) => x.endsWith(".webm"));
  const offsetSec = Math.max(0, (readyAt - contextStart) / 1000);
  manifest.push({ name, file: path.join(dir, f), offsetSec, durationSec: durationMs / 1000 });
  console.log(name, "-> offset", offsetSec.toFixed(3), "dur", durationMs / 1000);
}

(async () => {
  await captureHtmlScene("hook", path.join(WORK, "scenes", "hook.html"), 2500);
  await captureLogin(3500);
  await captureHtmlScene("dashboard", path.join(WORK, "scenes", "dashboard.html"), 4000);
  await captureHtmlScene("alerts", path.join(WORK, "scenes", "alerts.html"), 3500);
  await captureHtmlScene("portal", path.join(WORK, "scenes", "portal.html"), 4000);
  await captureHtmlScene("outro", path.join(WORK, "scenes", "outro.html"), 3000);
  fs.writeFileSync(path.join(WORK, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log("all captured");
})();
