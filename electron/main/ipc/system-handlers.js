const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  Notification,
  shell,
} = require("electron");
const { exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const mime = require("mime-types");
const si = require("systeminformation");
const screenshot = require("screenshot-desktop");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");
const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");

const { createPaths, resolveSystemPath } = require("../shared/paths");

function registerSystemHandlers() {
  const paths = createPaths(app);
  const activeExecCommands = new Map();
  const killProcessTree = async (child) => {
    if (!child || !child.pid) return false;

    if (process.platform === "win32") {
      await new Promise((resolve) => {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/T", "/F"],
          { windowsHide: true },
        );
        killer.once("close", resolve);
        killer.once("error", () => resolve());
      });
      return true;
    }

    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (_error) {
      try {
        child.kill("SIGKILL");
      } catch (_innerError) {
        return false;
      }
    }

    return true;
  };

  ipcMain.handle("get-openrouter-models", async () => {
    try {
      const p = paths.getOpenRouterKeyPath();
      let apiKey = process.env.OPENROUTER_API_KEY;

      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        if (data.apiKey) apiKey = data.apiKey;
      }

      if (!apiKey) return { error: "OpenRouter Key missing" };

      const response = await axios.get("https://openrouter.ai/api/v1/models", {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://imakshay.in",
          "X-Title": "Akki Ai",
        },
      });

      return response.data;
    } catch (error) {
      console.error("[Electron] Error fetching models:", error.message);
      return { error: error.message };
    }
  });

  ipcMain.handle(
    "system-fs-op",
    async (_event, { operation, path: targetPath, content, dest }) => {
      try {
        let resolvedPath = targetPath;

        function resolveDataDirPath(inputPath) {
          return resolveSystemPath(inputPath, app);
        }

        resolvedPath = resolveDataDirPath(targetPath);
        console.log(`[FS-OP] Resolved path: ${targetPath} -> ${resolvedPath}`);

        let resolvedDest = dest ? resolveDataDirPath(dest) : dest;

        switch (operation) {
          case "read-dir":
            if (
              !fs.existsSync(resolvedPath) ||
              !fs.statSync(resolvedPath).isDirectory()
            )
              return [];
            return fs.readdirSync(resolvedPath);
          case "create-dir":
            if (!fs.existsSync(resolvedPath))
              fs.mkdirSync(resolvedPath, { recursive: true });
            return true;
          case "write-file": {
            const dir = path.dirname(resolvedPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(resolvedPath, content || "");
            return true;
          }
          case "read-file":
            return fs.readFileSync(resolvedPath, "utf8");
          case "delete":
            fs.rmSync(resolvedPath, { recursive: true, force: true });
            return true;
          case "exists":
            return fs.existsSync(resolvedPath);
          case "rename":
            fs.renameSync(resolvedPath, resolvedDest);
            return true;
          case "copy-file":
            fs.copyFileSync(resolvedPath, resolvedDest);
            return true;
          default:
            return null;
        }
      } catch (error) {
        throw error;
      }
    },
  );

  ipcMain.handle("system-open", async (_event, { target }) => {
    const open = (await import("open")).default;
    const resolvedTarget =
      typeof target === "string" ? resolveSystemPath(target, app) : target;
    await open(resolvedTarget);
    return true;
  });

  ipcMain.handle(
    "system-exec-command",
    async (_event, { commandId, command, workingDir, timeout }) =>
      new Promise((resolve) => {
        const resolvedWorkingDir = workingDir
          ? resolveSystemPath(workingDir, app)
          : undefined;
        const effectiveTimeout = Math.max(
          5000,
          Math.min(timeout || 30000, 300000),
        );
        const options = {
          maxBuffer: 10 * 1024 * 1024,
          timeout: effectiveTimeout,
          cwd: resolvedWorkingDir || os.homedir(),
          env: { ...process.env, PATH: process.env.PATH },
          windowsHide: true,
        };
        const resolvedCommandId =
          commandId ||
          `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let settled = false;

        let finalCommand = typeof command === "string" ? command.trim() : "";

        // Fix Windows cmd.exe quirk where start "quoted_path" is interpreted as a CMD window title
        if (process.platform === "win32" && finalCommand) {
          // 1. Direct path check for explorer / open commands:
          const explorerMatch = finalCommand.match(
            /^(?:explorer|explorer\.exe)\s+("([^"]+)"|'([^']+)'|([^\s]+))$/i,
          );
          if (explorerMatch) {
            const rawTarget =
              explorerMatch[2] || explorerMatch[3] || explorerMatch[4];
            const targetPath = rawTarget
              ? resolveSystemPath(rawTarget, app)
              : rawTarget;
            if (targetPath && fs.existsSync(targetPath)) {
              shell.openPath(targetPath).catch(() => {});
              return resolve({
                success: true,
                commandId: resolvedCommandId,
                stdout: `Opened: ${targetPath}`,
                stderr: "",
                error: undefined,
                cancelled: false,
                exitCode: 0,
              });
            }
          }

          // 2. Start command handling (e.g. start "C:\folder" or start "C:\file.txt"):
          const startQuotedMatch = finalCommand.match(
            /^start\s+("([^"]+)"|'([^']+)')(?:\s+(.*))?$/i,
          );
          if (startQuotedMatch) {
            const rawTarget = startQuotedMatch[2] || startQuotedMatch[3];
            const targetPath = rawTarget
              ? resolveSystemPath(rawTarget, app)
              : rawTarget;
            const extraArgs = startQuotedMatch[4]
              ? ` ${startQuotedMatch[4]}`
              : "";

            // If targetPath exists on disk, use Electron's native shell.openPath for a clean, zero-cmd experience
            if (targetPath && fs.existsSync(targetPath)) {
              shell.openPath(targetPath).catch(() => {});
              return resolve({
                success: true,
                commandId: resolvedCommandId,
                stdout: `Opened: ${targetPath}`,
                stderr: "",
                error: undefined,
                cancelled: false,
                exitCode: 0,
              });
            }

            // If targetPath is not yet created or has flags, ensure empty title "" so cmd.exe never treats it as title
            finalCommand = `start "" "${targetPath}"${extraArgs}`;
          }
        }

        const child = exec(finalCommand, options, (error, stdout, stderr) => {
          if (settled) return;
          settled = true;
          activeExecCommands.delete(resolvedCommandId);
          const cancelled = Boolean(child.__akkiCancelled);
          resolve({
            success: !error && !cancelled,
            commandId: resolvedCommandId,
            stdout: stdout ? stdout.toString().substring(0, 100000) : "",
            stderr: stderr ? stderr.toString().substring(0, 50000) : "",
            error: cancelled ? "Command cancelled by user." : error?.message,
            cancelled,
            exitCode: error?.code || 0,
          });
        });
        child.__akkiCancelled = false;
        activeExecCommands.set(resolvedCommandId, child);
      }),
  );

  ipcMain.handle("system-cancel-command", async (_event, { commandId }) => {
    const child = activeExecCommands.get(commandId);
    if (!child) {
      return { success: false, commandId, alreadyFinished: true };
    }

    child.__akkiCancelled = true;
    await killProcessTree(child);
    return { success: true, commandId };
  });

  ipcMain.handle("web-search", async (_event, { query }) => {
    try {
      const qLower = query.toLowerCase();
      const isNews =
        qLower.includes("news") ||
        qLower.includes("update") ||
        qLower.includes("latest");
      const isIndianMarket = ![
        "us market",
        "nasdaq",
        "dow",
        "s&p",
        "global",
      ].some((kw) => qLower.includes(kw));
      const financeKeywords = [
        "stock",
        "price",
        "share",
        "market",
        "nifty",
        "sensex",
        "nasdaq",
        "dow",
        "top gainers",
        "top losers",
        "most active",
        "trending stock",
        "live chart",
      ];

      const fetchWithUA = async (url) => {
        const r = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        return r;
      };

      // 1. Finance Predefined Screeners
      if (
        financeKeywords.some((kw) => qLower.includes(kw)) &&
        !isNews &&
        (qLower.includes("top") ||
          qLower.includes("best") ||
          qLower.includes("most active") ||
          qLower.includes("trending") ||
          qLower.includes("gainers") ||
          qLower.includes("losers"))
      ) {
        let listType = "most_actives";
        if (isIndianMarket) {
          listType = "most_actives_in";
          if (qLower.includes("gainers")) listType = "day_gainers_in";
          if (qLower.includes("losers")) listType = "day_losers_in";
        } else {
          if (qLower.includes("gainers")) listType = "day_gainers";
          if (qLower.includes("losers")) listType = "day_losers";
          if (qLower.includes("trending")) listType = "trending_tickers";
        }
        try {
          const screenRes = await (
            await fetchWithUA(
              "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=" +
                listType +
                "&count=15",
            )
          ).json();
          const quotes = screenRes.finance?.result?.[0]?.quotes || [];
          if (quotes.length > 0) {
            let financeContext =
              "List: " +
              listType.toUpperCase().replace("_IN", " INDIA") +
              " (Yahoo Finance)\n";
            quotes.forEach((q) => {
              financeContext +=
                "- " +
                (q.shortName || q.longName) +
                " (" +
                q.symbol +
                "): Price " +
                q.currency +
                " " +
                q.regularMarketPrice +
                ", Change: " +
                q.regularMarketChangePercent +
                "%, Vol: " +
                q.regularMarketVolume +
                "\n";
            });
            return { success: true, content: financeContext, sources: [] };
          }
        } catch (e) {
          console.error("Screener failed", e);
        }
      }

      // 2. Google News RSS
      if (isNews) {
        try {
          const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
          const rssRes = await fetchWithUA(rssUrl);
          const xml = await rssRes.text();
          const regex =
            /<item>\s*<title>([\s\S]*?)<\/title>\s*<link>([\s\S]*?)<\/link>/g;
          let match;
          let count = 0;
          let financeContext = `[Live Google News for: ${query}]\n`;
          while ((match = regex.exec(xml)) !== null && count < 6) {
            const title = match[1].replace(/<[^>]+>/g, "").trim();
            const link = match[2].trim();
            financeContext += `- ${title}\n  Link: ${link}\n\n`;
            count++;
          }
          if (count > 0)
            return { success: true, content: financeContext, sources: [] };
        } catch (e) {
          console.error("Google News RSS failed", e);
        }
      }

      // 3. Yahoo Finance Specific Quote Search (v8/finance/chart - v7 is deprecated)
      if (financeKeywords.some((kw) => qLower.includes(kw))) {
        try {
          // Extract short ticker/company name for accurate search (long sentences return 0 results)
          const shortQuery = query
            .replace(
              /\b(live|price|today|current|stock|share|news|latest|details|report|open|high|low|close|chart|analysis)\b/gi,
              ""
            )
            .trim()
            .split(/\s+/)
            .slice(0, 3)
            .join(" ");
          const searchUrl =
            "https://query2.finance.yahoo.com/v1/finance/search?q=" +
            encodeURIComponent(shortQuery || query);
          const searchData = await (await fetchWithUA(searchUrl)).json();
          if (searchData.quotes && searchData.quotes.length > 0) {
            const bestMatch = searchData.quotes[0];
            const symbol = bestMatch.symbol;
            // Use v8/finance/chart which is the current reliable endpoint
            const chartUrl =
              "https://query1.finance.yahoo.com/v8/finance/chart/" + symbol;
            const chartData = await (await fetchWithUA(chartUrl)).json();
            const meta = chartData.chart?.result?.[0]?.meta;

            let financeContext = "";
            if (meta) {
              financeContext += `Quote: ${meta.longName || meta.shortName || symbol} (${meta.symbol})\n`;
              financeContext += `Price: ${meta.currency} ${meta.regularMarketPrice}\n`;
              const prevClose = meta.chartPreviousClose || meta.previousClose;
              if (prevClose && meta.regularMarketPrice) {
                const change = (meta.regularMarketPrice - prevClose).toFixed(2);
                const changePct = (
                  ((meta.regularMarketPrice - prevClose) / prevClose) *
                  100
                ).toFixed(2);
                financeContext += `Change: ${change} (${changePct}%)\n`;
              }
              if (meta.regularMarketDayLow && meta.regularMarketDayHigh) {
                financeContext += `Day Range: ${meta.regularMarketDayLow} - ${meta.regularMarketDayHigh}\n`;
              }
              if (meta.fiftyTwoWeekLow && meta.fiftyTwoWeekHigh) {
                financeContext += `52 Week Range: ${meta.fiftyTwoWeekLow} - ${meta.fiftyTwoWeekHigh}\n`;
              }
            }
            if (searchData.news && searchData.news.length > 0) {
              financeContext += "\n[Related News for " + symbol + "]\n";
              searchData.news.forEach((n) => {
                financeContext += `- ${n.title}\n  Link: ${n.link}\n\n`;
              });
            }
            if (financeContext)
              return { success: true, content: financeContext, sources: [] };
          }
        } catch (e) {
          console.error("Yahoo Search Failed", e);
        }
      }

      // 4. Fallback to DuckDuckGo HTML Scraper for General Web Search
      // We bypass GoogleGenAI because of quota and API key issues
      try {
        const ddgUrl =
          "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
        const ddgRes = await fetchWithUA(ddgUrl);
        const html = await ddgRes.text();

        const resultRegex =
          /<a class="result__snippet[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
        let match;
        let resultsText = `[Web Search Results for: ${query}]\n`;
        let count = 0;
        const sources = [];

        while ((match = resultRegex.exec(html)) !== null && count < 5) {
          const url = match[1];
          let snippet = match[2].replace(/<[^>]+>/g, "").trim();

          // Decode HTML entities
          snippet = snippet
            .replace(/&quot;/g, '"')
            .replace(/&#x27;/g, "'")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">");

          resultsText += `- ${snippet}\n  URL: ${url}\n\n`;
          sources.push({ url, title: snippet.substring(0, 30) + "..." });
          count++;
        }

        if (count > 0) {
          return { success: true, content: resultsText, sources: sources };
        }
      } catch (e) {
        console.error("DDG search failed", e);
      }

      return {
        error:
          "Web search failed or no results found. Please try a different query.",
      };
    } catch (error) {
      console.error("[Web Search] Fatal Error:", error);
      return { error: `Web search failed: ${error.message}` };
    }
  });

  // ─── T-02: Jina AI Helper ─────────────────────────────────────────────────
  // Fetches a Jina URL with optional API key and a strict 10-second timeout.
  // Automatically includes X-With-Generated-Alt for image extraction.
  async function fetchJina(url, jinaKey, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      Accept: "text/plain",
      "X-With-Generated-Alt": "true",
    };
    if (jinaKey) headers["Authorization"] = `Bearer ${jinaKey}`;
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  // ─── T-03: jina-deep-search ───────────────────────────────────────────────
  // 🟢 Phase 5: 100% Free Deep Search Pipeline (No Paid API Key required)
  ipcMain.handle("jina-deep-search", async (_event, query) => {
    try {
      console.log("[Jina] Executing 100% Free Deep Search Pipeline for:", query);
      const ddgUrl = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
      const ddgRes = await fetch(ddgUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      const html = await ddgRes.text();

      const resultRegex = /<a class="result__snippet[^>]*href="([^"]+)"/g;
      let match;
      const urls = [];
      while ((match = resultRegex.exec(html)) !== null && urls.length < 2) {
          let targetUrl = match[1];
          if (targetUrl.startsWith('//duckduckgo.com/l/?uddg=')) {
              targetUrl = decodeURIComponent(targetUrl.split('uddg=')[1].split('&')[0]);
          }
          if (targetUrl && !targetUrl.includes('duckduckgo')) urls.push(targetUrl);
      }

      if (urls.length === 0) {
          return { success: false, error: "No URLs found for deep search" };
      }

      let finalMarkdown = `### Deep Search Results for: ${query}\n\n`;
      for (const url of urls) {
         try {
             const r = await fetch(`https://r.jina.ai/${url}`, { headers: { "Accept": "text/plain", "X-Return-Format": "markdown" } });
             const md = await r.text();
             if (md && md.length > 100) {
                 finalMarkdown += `#### Source: ${url}\n\n${md}\n\n---\n\n`;
             }
         } catch(e) {}
      }

      if (finalMarkdown.length > 100) {
          return { success: true, data: finalMarkdown };
      }
      return { success: false, error: "Failed to read content" };
    } catch (err) {
      console.log("[Jina] Free Deep Search failed:", err.message);
      return { success: false, error: err.message };
    }
  });

  // ─── T-04: jina-read-url ──────────────────────────────────────────────────
  // Uses r.jina.ai to read any URL and return clean Markdown content.
  // Works without a Jina API key (anonymous 20 RPM), key raises to 500 RPM.
  ipcMain.handle("jina-read-url", async (_event, targetUrl) => {
    try {
      // Read Jina API key directly from secret_key.json
      let jinaKey = null;
      try {
        const keyFile = path.join(app.getPath("userData"), "secret_key.json");
        if (fs.existsSync(keyFile)) {
          const stored = JSON.parse(fs.readFileSync(keyFile, "utf8"));
          jinaKey = stored?.jinaKey || null;
        }
      } catch (_) {
        // Key read failed silently
      }

      const url = `https://r.jina.ai/${targetUrl}`;
      const result = await fetchJina(url, jinaKey, 10000);
      if (!result || result.length < 50) {
        return { success: false, error: "empty_response" };
      }
      return { success: true, data: result };
    } catch (err) {
      console.log("[Jina] Read URL failed or timed out:", err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(
    "search-files-content",
    async (_event, { query, searchPath, fileTypes }) => {
      try {
        const MAX_RESULTS = 50;
        const MAX_DEPTH = 5;
        const MAX_FILE_SIZE = 5 * 1024 * 1024;
        const results = [];
        const basePath = searchPath
          ? resolveSystemPath(searchPath, app)
          : path.join(app.getPath("documents"), "Akki Data");

        if (!fs.existsSync(basePath)) {
          return { success: false, error: `Path does not exist: ${basePath}` };
        }

        const defaultExts = [
          ".txt",
          ".md",
          ".json",
          ".js",
          ".ts",
          ".tsx",
          ".jsx",
          ".css",
          ".html",
          ".py",
          ".java",
          ".cpp",
          ".c",
          ".h",
          ".xml",
          ".yaml",
          ".yml",
          ".csv",
          ".log",
          ".ini",
          ".cfg",
          ".env",
          ".sh",
          ".bat",
          ".ps1",
        ];
        const searchExts = fileTypes
          ? fileTypes
              .split(",")
              .map((ext) =>
                ext.trim().startsWith(".") ? ext.trim() : `.${ext.trim()}`,
              )
          : defaultExts;

        const searchRegex = new RegExp(query, "gi");

        function searchDir(dirPath, depth) {
          if (depth > MAX_DEPTH || results.length >= MAX_RESULTS) return;

          let entries;
          try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
          } catch (_error) {
            return;
          }

          for (const entry of entries) {
            if (results.length >= MAX_RESULTS) break;
            const fullPath = path.join(dirPath, entry.name);
            if (
              entry.name.startsWith(".") ||
              entry.name === "node_modules" ||
              entry.name === "__pycache__"
            )
              continue;

            if (entry.isDirectory()) {
              searchDir(fullPath, depth + 1);
            } else if (entry.isFile()) {
              const ext = path.extname(entry.name).toLowerCase();
              if (!searchExts.includes(ext)) continue;

              try {
                const stats = fs.statSync(fullPath);
                if (stats.size > MAX_FILE_SIZE) continue;

                const content = fs.readFileSync(fullPath, "utf8");
                const lines = content.split("\n");
                const matches = [];

                for (let i = 0; i < lines.length; i += 1) {
                  if (searchRegex.test(lines[i])) {
                    matches.push({
                      line: i + 1,
                      content: lines[i].trim().substring(0, 200),
                    });
                    if (matches.length >= 5) break;
                  }
                  searchRegex.lastIndex = 0;
                }

                if (matches.length > 0) {
                  results.push({
                    file: fullPath,
                    fileName: entry.name,
                    matchCount: matches.length,
                    matches,
                  });
                }
              } catch (_error) {
                continue;
              }
            }
          }
        }

        searchDir(basePath, 0);
        return {
          success: true,
          query,
          searchPath: basePath,
          totalMatches: results.length,
          results,
        };
      } catch (error) {
        return { error: `File search failed: ${error.message}` };
      }
    },
  );

  ipcMain.handle("save-image", async (_event, { base64Data }) => {
    try {
      const filePath = path.join(
        app.getPath("downloads"),
        `akki_ai_${Date.now()}.png`,
      );
      const buffer = Buffer.from(
        base64Data.replace(/^data:image\/\w+;base64,/, ""),
        "base64",
      );
      fs.writeFileSync(filePath, buffer);
      return filePath;
    } catch (error) {
      throw error;
    }
  });

  ipcMain.handle("read-file-content", async (_event, { path: filePath }) => {
    try {
      console.log(`[File-Reader] Reading file: ${filePath}`);
      if (!fs.existsSync(filePath)) {
        console.error(`[File-Reader] File not found: ${filePath}`);
        return { error: "File not found" };
      }

      const mimeType = mime.lookup(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const buffer = fs.readFileSync(filePath);
      console.log(
        `[File-Reader] Detected Mime: ${mimeType}, Ext: ${ext}, Size: ${buffer.length} bytes`,
      );

      if (mimeType === "application/pdf" || ext === ".pdf") {
        console.log("[File-Reader] Parsing PDF...");
        const data = await PDFParse(buffer);
        console.log(
          `[File-Reader] PDF Parsed. Content length: ${data.text?.length || 0}`,
        );
        return { content: data.text };
      }
      if (
        mimeType ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        ext === ".docx"
      ) {
        console.log("[File-Reader] Parsing Docx...");
        const result = await mammoth.extractRawText({ buffer });
        console.log(
          `[File-Reader] Docx Parsed. Content length: ${result.value?.length || 0}`,
        );
        return { content: result.value };
      }
      if (
        mimeType.startsWith("text/") ||
        mimeType === "application/json" ||
        mimeType === "application/javascript" ||
        [".txt", ".md", ".json", ".js", ".ts", ".tsx", ".css"].includes(ext)
      ) {
        console.log("[File-Reader] Reading as Text...");
        return { content: buffer.toString("utf8") };
      }

      console.warn(`[File-Reader] Unsupported file type: ${mimeType}`);
      return {
        content: `[Binary/Image File: ${path.basename(filePath)}]. The content of this file is visual or binary.`,
      };
    } catch (error) {
      console.error("[File-Reader] CRITICAL ERROR:", error);
      return { error: error.message };
    }
  });

  ipcMain.handle("pick-and-read-files", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Multimodal Files",
          extensions: [
            "jpg",
            "png",
            "jpeg",
            "webp",
            "pdf",
            "doc",
            "docx",
            "txt",
            "mp3",
            "wav",
            "mpeg",
          ],
        },
      ],
    });

    if (canceled) return [];

    const results = [];
    for (const filePath of filePaths) {
      const stats = fs.statSync(filePath);
      if (stats.size > 50 * 1024 * 1024) continue;

      const buffer = fs.readFileSync(filePath);
      const mimeType = mime.lookup(filePath) || "application/octet-stream";
      results.push({
        name: path.basename(filePath),
        data: buffer.toString("base64"),
        mimeType,
        path: filePath,
      });
    }
    return results;
  });

  ipcMain.handle("clipboard-read", async () => {
    try {
      return {
        text: clipboard.readText(),
        html: clipboard.readHTML(),
        image: clipboard.readImage().isEmpty()
          ? null
          : clipboard.readImage().toDataURL(),
      };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle("clipboard-write", async (_event, { text, html, image }) => {
    try {
      if (text) clipboard.writeText(text);
      if (html) clipboard.writeHTML(html);
      if (image) {
        const img = nativeImage.createFromDataURL(image);
        clipboard.writeImage(img);
      }
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  // Legacy uncompressed screenshot (Deprecated/Removed)
  // Use 'desktop-screenshot' from desktop-manager instead for AI-optimized capture.

  ipcMain.handle("get-screen-sources", async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
      });
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        thumbnail: source.thumbnail.toDataURL(),
      }));
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle("send-notification", async (_event, { title, body, icon }) => {
    try {
      const notification = new Notification({
        title: title || "Akki Ai",
        body: body || "",
        icon: icon || undefined,
      });
      notification.show();
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle(
    "http-fetch",
    async (_event, { url, method, headers, body }) => {
      try {
        const response = await axios({
          url,
          method: method || "GET",
          headers: headers || {},
          data: body || undefined,
          timeout: 30000,
        });
        return {
          success: true,
          status: response.status,
          data: response.data,
          headers: response.headers,
        };
      } catch (error) {
        return {
          error: error.message,
          status: error.response?.status,
          data: error.response?.data,
        };
      }
    },
  );

  ipcMain.handle("get-detailed-system-info", async () => {
    try {
      const [cpu, mem, graphics, osInfo, network, battery] = await Promise.all([
        si.cpu(),
        si.mem(),
        si.graphics(),
        si.osInfo(),
        si.networkInterfaces(),
        si.battery(),
      ]);
      return { cpu, mem, graphics, os: osInfo, network, battery };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle("window-control", async (_event, { action }) => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return { error: "No focused window" };

      switch (action) {
        case "minimize":
          win.minimize();
          break;
        case "maximize":
          if (win.isMaximized()) win.unmaximize();
          else win.maximize();
          break;
        case "close":
          win.close();
          break;
        case "fullscreen":
          win.setFullScreen(!win.isFullScreen());
          break;
        default:
          break;
      }
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle("get-processes", async () => {
    try {
      const processes = await si.processes();
      return processes.list
        .sort((a, b) => b.cpu - a.cpu)
        .slice(0, 20)
        .map((proc) => ({
          name: proc.name,
          pid: proc.pid,
          cpu: proc.cpu,
          mem: proc.mem,
        }));
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle("kill-process", async (_event, { pid }) => {
    try {
      process.kill(pid);
      return { success: true };
    } catch (error) {
      return { error: error.message };
    }
  });

  // NOTE: 'send-whatsapp-keyboard' handler moved to whatsapp-handlers.js (centralized)
}

module.exports = { registerSystemHandlers };
