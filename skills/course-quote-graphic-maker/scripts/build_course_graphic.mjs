#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "force") {
      args.force = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  return args;
}

function requireArg(args, name) {
  if (!args[name]) throw new Error(`Required argument missing: --${name}`);
  return path.resolve(args[name]);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function withBreaks(value) {
  return escapeHtml(value).replaceAll("\n", "<br />");
}

function headlineHtml(text, highlight) {
  if (!highlight || !text.includes(highlight)) return withBreaks(text);
  const pieces = text.split(highlight).map(withBreaks);
  return pieces.join(`<span class="gold">${withBreaks(highlight)}</span>`);
}

function reflectionHtml(value) {
  const rows = Array.isArray(value)
    ? value
    : String(value ?? "").split("\n").filter(Boolean);

  return rows.map((row) => {
    const entry = typeof row === "string" ? { text: row } : row;
    const text = String(entry.text ?? "").trim();
    if (!text) throw new Error("Reflection rows must contain non-empty text.");
    const kind = entry.kind ?? (/[？?]$/.test(text) ? "question" : "body");
    const className = kind === "question" ? ' class="question"' : "";
    return `<span${className}>${escapeHtml(text)}</span>`;
  }).join("<br />\n");
}

function replaceTokens(template, values) {
  let html = template;
  for (const [token, value] of Object.entries(values)) {
    html = html.replaceAll(`{{${token}}}`, String(value));
  }
  const unresolved = html.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (unresolved) throw new Error(`Unresolved template token(s): ${[...new Set(unresolved)].join(", ")}`);
  return html;
}

async function loadChromium(explicitModule) {
  const home = process.env.HOME ?? "";
  const candidates = [
    explicitModule,
    process.env.PLAYWRIGHT_MODULE,
    "playwright",
    "playwright-core",
    home && path.join(home, ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs"),
  ].filter(Boolean);

  const failures = [];
  for (const candidate of candidates) {
    try {
      if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
      const specifier = path.isAbsolute(candidate) ? pathToFileURL(candidate).href : candidate;
      const module = await import(specifier);
      if (module.chromium) return module.chromium;
      failures.push(`${candidate}: chromium export missing`);
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`Could not load Playwright. Pass --playwright-module <index.mjs>.\n${failures.join("\n")}`);
}

function findChrome(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = requireArg(args, "config");
  const photoPath = requireArg(args, "photo");
  const outputPath = requireArg(args, "output");

  if (!fs.existsSync(configPath)) throw new Error(`Config not found: ${configPath}`);
  if (!fs.existsSync(photoPath)) throw new Error(`Photo not found: ${photoPath}`);
  if (path.extname(outputPath).toLowerCase() !== ".png") throw new Error("Output must use the .png extension.");
  if (fs.existsSync(outputPath) && !args.force) throw new Error(`Output already exists: ${outputPath}. Use a new version name or --force.`);

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  for (const field of ["headline", "reflection", "date"]) {
    if (config[field] === undefined || config[field] === "") throw new Error(`Config field missing: ${field}`);
  }
  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(config.date)) throw new Error("date must match YYYY.MM.DD exactly.");

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const skillDir = path.resolve(scriptDir, "..");
  const templatePath = args.template
    ? path.resolve(args.template)
    : path.join(skillDir, "assets/course-graphic-template.html");
  if (!fs.existsSync(templatePath)) throw new Error(`Template not found: ${templatePath}`);

  const photo = config.photo ?? {};
  const typography = config.typography ?? {};
  const layout = config.layout ?? {};
  const brand = String(config.brand ?? "課程精選").trim();
  if (!brand) throw new Error("brand must not be empty.");
  if (/\r|\n/.test(brand)) throw new Error("brand must stay on one line.");
  if ([...brand].length > 18) throw new Error("brand must be 18 characters or fewer.");
  const html = replaceTokens(fs.readFileSync(templatePath, "utf8"), {
    TITLE: escapeHtml(`${brand}｜${config.date}`),
    PHOTO_URL: pathToFileURL(photoPath).href,
    ALT_TEXT: escapeHtml(config.altText ?? "課程現場"),
    BRAND: escapeHtml(brand),
    HEADLINE_HTML: headlineHtml(config.headline, config.highlight),
    REFLECTION_HTML: reflectionHtml(config.reflection),
    DATE: escapeHtml(config.date),
    PHOTO_SCALE: Number(photo.scale ?? 1.0),
    PHOTO_X: photo.positionX ?? "50%",
    PHOTO_Y: photo.positionY ?? "50%",
    PHOTO_ORIGIN: photo.transformOrigin ?? "center center",
    PHOTO_BRIGHTNESS: Number(photo.brightness ?? 0.95),
    PHOTO_CONTRAST: Number(photo.contrast ?? 1.07),
    PHOTO_SATURATION: Number(photo.saturation ?? 0.88),
    OVERLAY_END: layout.overlayEnd ?? "54%",
    CONTENT_WIDTH: layout.contentWidth ?? "755px",
    HEADLINE_SIZE: typography.headlineSize ?? "68px",
    REFLECTION_SIZE: typography.reflectionSize ?? "31px",
  });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const workHtml = args["work-html"]
    ? path.resolve(args["work-html"])
    : path.join(path.dirname(outputPath), `${path.basename(outputPath, ".png")}.work.html`);
  fs.writeFileSync(workHtml, html, "utf8");

  const chromium = await loadChromium(args["playwright-module"]);
  const chromePath = findChrome(args.chrome);
  const browser = await chromium.launch({
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {}),
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 2048, height: 1152 },
      deviceScaleFactor: 1,
    });
    await page.goto(pathToFileURL(workHtml).href, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((image) => image.decode()));
    });
    await page.screenshot({ path: outputPath, type: "png", fullPage: false });
  } finally {
    await browser.close();
  }

  process.stdout.write(`${JSON.stringify({ output: outputPath, workHtml, width: 2048, height: 1152 }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
