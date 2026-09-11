// Pre-launch probe: writes a marker to the startup log BEFORE the extension host
// process even starts. If the log file contains this line, the F5 task ran;
// if it doesn't, VS Code never reached the preLaunchTask. This tells us whether
// the crash happens before or after the extension module is loaded.
const fs = require("fs");
const path = require("path");
const os = require("os");

const logDir =
  process.platform === "win32"
    ? path.join(process.env.APPDATA || "", "PythonLearner", "logs")
    : path.join(os.homedir(), ".python-learner", "logs");

try {
  fs.mkdirSync(logDir, { recursive: true });
} catch (e) {
  // ignore
}

const logFile = path.join(logDir, "extension-startup.log");
const now = new Date().toISOString();
fs.appendFileSync(
  logFile,
  `\n[pylearner:preLaunch] preLaunchTask completed at ${now} (cwd: ${process.cwd()})\n`
);
console.log("[pylearner] prelaunch probe written to", logFile);
