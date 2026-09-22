// noScribe integration. noScribe (https://noscribe.de) is a local, GPL-3.0
// transcription app that runs faster-whisper + pyannote diarization. When the
// user has it installed we can either hand it a recording (GUI opens with the
// file prepopulated) or drive it headless from a completed meeting recording
// with settings chosen in OpenWhispr's own UI.
//
// The installed app is a self-contained bundle:
//   - macOS: /Applications/noScribe.app/Contents/MacOS/noScribe
//   - Windows/Linux: noScribe executable somewhere on disk or PATH
// Override the search with the NO_SCRIBE_PATH env var.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const debugLogger = require("./debugLogger");
const { getSafeTempDir } = require("./safeTempDir");

const ENV_PATH_VAR = "NO_SCRIBE_PATH";
const MODEL_LIST_TIMEOUT_MS = 90000;
const TRANSCRIBE_TIMEOUT_MS = 3 * 60 * 60 * 1000; // pyannote + whisper on a long meeting is slow
const PROGRESS_POLL_MS = 1000;

const ERROR_CODES = {
  NOT_FOUND: "NO_SCRIBE_NOT_FOUND",
  AUDIO_NOT_FOUND: "NO_SCRIBE_AUDIO_NOT_FOUND",
  TRANSCRIPTION_FAILED: "NO_SCRIBE_TRANSCRIPTION_FAILED",
  TIMEOUT: "NO_SCRIBE_TIMEOUT",
  CANCELED: "NO_SCRIBE_CANCELED",
};

function noScribeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function binaryCandidates() {
  const candidates = [];
  const home = os.homedir();
  if (process.env[ENV_PATH_VAR]) {
    candidates.push({ path: process.env[ENV_PATH_VAR], source: "env" });
  }
  if (process.platform === "darwin") {
    candidates.push({
      path: "/Applications/noScribe.app/Contents/MacOS/noScribe",
      appBundle: "/Applications/noScribe.app",
      source: "applications",
    });
    candidates.push({
      path: path.join(home, "Applications", "noScribe.app", "Contents", "MacOS", "noScribe"),
      appBundle: path.join(home, "Applications", "noScribe.app"),
      source: "home-applications",
    });
  } else if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    candidates.push({
      path: path.join(local, "Programs", "noScribe", "noScribe.exe"),
      source: "localappdata",
    });
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    candidates.push({
      path: path.join(programFiles, "noScribe", "noScribe.exe"),
      source: "programfiles",
    });
    candidates.push({ path: "noScribe.exe", source: "path" });
  } else {
    candidates.push({ path: "/opt/noScribe/noScribe", source: "opt" });
    candidates.push({ path: path.join(home, ".local", "bin", "noScribe"), source: "home-bin" });
    candidates.push({ path: "noScribe", source: "path" });
  }
  return candidates;
}

// Resolve a bare name (noScribe / noScribe.exe) the way a user would type it
// in a terminal.
function resolveOnPath(name) {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(which, [name], { encoding: "utf-8" });
    if (result.status !== 0) return null;
    const hit = (result.stdout || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return hit || null;
  } catch {
    return null;
  }
}

let cachedFind = null;
let cachedResolution = null;

// Returns { executablePath, appBundle?, source } or null. Cached for the app's
// lifetime: the install location does not change mid-session.
function findNoScribe(force = false) {
  if (cachedFind !== null && !force) return cachedFind;
  cachedFind = null;
  for (const candidate of binaryCandidates()) {
    if (candidate.source === "path") {
      const resolved = resolveOnPath(candidate.path);
      if (!resolved) continue;
      cachedFind = { executablePath: resolved, source: candidate.source };
      cachedResolution = candidate;
      break;
    }
    try {
      const stat = fs.statSync(candidate.path);
      if (!stat.isFile()) continue;
      // Only skip when we can positively read it: an un-executable placeholder
      // tells us nothing useful, but a .app that exists is still the app.
      if (process.platform !== "win32" && !(stat.mode & 0o111)) continue;
      cachedFind = {
        executablePath: candidate.path,
        source: candidate.source,
        appBundle: candidate.appBundle,
      };
      cachedResolution = candidate;
      break;
    } catch {
      continue;
    }
  }
  if (!cachedFind) {
    debugLogger.info("noScribe not found", { platform: process.platform }, "noscribe");
  } else {
    debugLogger.info(
      "noScribe found",
      { executablePath: cachedFind.executablePath, source: cachedFind.source },
      "noscribe"
    );
  }
  return cachedFind;
}

function getNoScribeStatus() {
  const found = findNoScribe();
  return found
    ? { available: true, executablePath: found.executablePath, appBundle: found.appBundle || null }
    : { available: false, executablePath: null, appBundle: null };
}

function runNoScribe(args, { timeoutMs, signal = null } = {}) {
  const found = findNoScribe();
  if (!found) return Promise.reject(noScribeError(ERROR_CODES.NOT_FOUND, "noScribe is not installed"));
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout = null;
    const child = spawn(found.executablePath, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      child.kill();
      reject(noScribeError(ERROR_CODES.CANCELED, "noScribe transcription canceled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs) {
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        child.kill();
        reject(noScribeError(ERROR_CODES.TIMEOUT, "noScribe timed out"));
      }, timeoutMs);
    }
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(noScribeError(ERROR_CODES.TRANSCRIPTION_FAILED, `Failed to start noScribe: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    });
  });
}

let modelListPromise = null;
let cachedModels = null;

async function listNoScribeModels() {
  if (cachedModels) return cachedModels;
  if (!modelListPromise) {
    modelListPromise = (async () => {
      const found = findNoScribe();
      if (!found) return [];
      const models = [];
      try {
        const { code, stdout } = await runNoScribe(["--help-models"], {
          timeoutMs: MODEL_LIST_TIMEOUT_MS,
        });
        if (code === 0) {
          for (const line of stdout.split(/\r?\n/)) {
            const match = line.trim().match(/^-\s+(.+)$/);
            if (match) models.push(match[1].trim());
          }
        }
      } catch (error) {
        debugLogger.warn("Failed to list noScribe models", { error: error.message }, "noscribe");
      }
      cachedModels = models;
      return models;
    })();
  }
  return modelListPromise;
}

// Launch the noScribe GUI with the audio file prepopulated so the user can pick
// speakers / language / model themselves and start from there.
function openInNoScribe({ audioPath, model = null, speakerDetection = null }) {
  const found = findNoScribe();
  if (!found) throw noScribeError(ERROR_CODES.NOT_FOUND, "noScribe is not installed");
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw noScribeError(ERROR_CODES.AUDIO_NOT_FOUND, `Audio file not found: ${audioPath}`);
  }
  const args = [audioPath];
  if (model) args.push("--model", model);
  if (speakerDetection !== null && speakerDetection !== undefined && speakerDetection !== "") {
    args.push("--speaker-detection", String(speakerDetection));
  }
  if (process.platform === "darwin" && found.appBundle) {
    // `open` launches the bundle properly so noScribe gets its Dock/window
    // activation; --args lands in the app's argv, which main.py parses.
    const child = spawn("open", ["-a", found.appBundle, "--args", ...args], {
      stdio: "ignore",
    });
    child.on("error", (error) => {
      debugLogger.warn("Failed to launch noScribe via open", { error: error.message }, "noscribe");
    });
    child.unref();
    return found.executablePath;
  }
  const child = spawn(found.executablePath, args, { detached: true, stdio: "ignore" });
  child.on("error", (error) => {
    debugLogger.warn("Failed to launch noScribe", { error: error.message }, "noscribe");
  });
  child.unref();
  return found.executablePath;
}

// Headless transcription. Runs `noScribe --no-gui <audio> <out.txt> [options]`,
// reports progress while the transcript file is written, and returns the text.
async function transcribeWithNoScribe({
  audioPath,
  outputPath,
  language = null,
  model = null,
  speakerDetection = null,
  timestamps = null,
  disfluencies = null,
  overlapping = null,
  signal = null,
  onProgress = null,
} = {}) {
  const found = findNoScribe();
  if (!found) throw noScribeError(ERROR_CODES.NOT_FOUND, "noScribe is not installed");
  if (!audioPath || !fs.existsSync(audioPath)) {
    throw noScribeError(ERROR_CODES.AUDIO_NOT_FOUND, `Audio file not found: ${audioPath}`);
  }

  const args = ["--no-gui", audioPath, outputPath];
  if (language && language !== "auto") args.push("--language", language);
  if (model) args.push("--model", model);
  if (speakerDetection !== null && speakerDetection !== undefined && speakerDetection !== "") {
    args.push("--speaker-detection", String(speakerDetection));
  }
  if (typeof timestamps === "boolean") args.push(timestamps ? "--timestamps" : "--no-timestamps");
  if (typeof disfluencies === "boolean") {
    args.push(disfluencies ? "--disfluencies" : "--no-disfluencies");
  }
  if (typeof overlapping === "boolean") {
    args.push(overlapping ? "--overlapping" : "--no-overlapping");
  }

  let poll = null;
  if (onProgress) {
    poll = setInterval(() => {
      try {
        if (fs.existsSync(outputPath)) {
          onProgress({ stage: "writing", bytes: fs.statSync(outputPath).size });
        } else {
          onProgress({ stage: "processing", bytes: 0 });
        }
      } catch {
        // transient stat error: keep polling
      }
    }, PROGRESS_POLL_MS);
  }
  let result;
  try {
    result = await runNoScribe(args, {
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      signal,
    });
  } finally {
    if (poll) clearInterval(poll);
  }

  if (signal?.aborted) throw noScribeError(ERROR_CODES.CANCELED, "noScribe transcription canceled");

  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    debugLogger.warn(
      "noScribe headless transcription failed",
      { code: result.code, stderr: result.stderr }, 
      "noscribe"
    );
    throw noScribeError(ERROR_CODES.TRANSCRIPTION_FAILED, `noScribe failed: ${detail}`);
  }

  const transcript = readTranscriptFile(outputPath);
  if (transcript == null) {
    throw noScribeError(
      ERROR_CODES.TRANSCRIPTION_FAILED,
      "noScribe finished but produced no transcript"
    );
  }
  if (onProgress) onProgress({ stage: "done", bytes: transcript.length });
  return { transcript, outputPath };
}

function readTranscriptFile(outputPath) {
  try {
    if (!outputPath || !fs.existsSync(outputPath)) return null;
    return fs.readFileSync(outputPath, "utf-8");
  } catch {
    return null;
  }
}

// Populate the output path for a headless run. Keyed by transcriptionId so
// parallel runs for different recordings never collide.
function createNoScribeOutputPath(transcriptionId) {
  const base = getSafeTempDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(base, `noscribe-${transcriptionId}-${stamp}.txt`);
}

function removeNoScribeOutputFile(outputPath) {
  try {
    if (outputPath) fs.unlinkSync(outputPath);
  } catch {
    // best-effort cleanup
  }
}

module.exports = {
  ERROR_CODES,
  findNoScribe,
  getNoScribeStatus,
  listNoScribeModels,
  openInNoScribe,
  transcribeWithNoScribe,
  createNoScribeOutputPath,
  removeNoScribeOutputFile,
};