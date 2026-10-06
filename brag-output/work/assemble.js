const { execSync } = require("child_process");
const path = require("path");

const FF = "C:\\Users\\roles\\Documents\\dev\\ffmpeg.exe";
const WORK = __dirname;

function dur(name) {
  let out;
  try {
    out = execSync(`"${FF}" -i "${path.join(WORK, "trimmed", name + ".mp4")}"`, { stdio: ["ignore", "pipe", "pipe"] }).toString();
  } catch (e) {
    out = (e.stdout ? e.stdout.toString() : "") + (e.stderr ? e.stderr.toString() : "");
  }
  const m = out.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (!m) throw new Error("no duration for " + name + " -- got: " + out.slice(0, 400));
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
}

const names = ["hook", "login", "dashboard", "alerts", "portal", "outro"];
const durs = names.map(dur);
console.log("durations", Object.fromEntries(names.map((n, i) => [n, durs[i]])));

const T = 0.3;
let running = durs[0];
const offsets = [];
for (let i = 1; i < durs.length; i++) {
  const off = running - T;
  offsets.push(off);
  running = running + durs[i] - T;
}
const finalLen = running;
console.log("offsets", offsets, "final", finalLen);

const transitions = ["fadeblack", "fadewhite", "fadewhite", "fadewhite", "fadeblack"];

const inputs = names.map((n) => `-i trimmed/${n}.mp4`).join(" ") + " -i audio/brag-audio.wav";

let filter = "";
let prevLabel = "0:v";
for (let i = 1; i < names.length; i++) {
  const outLabel = i === names.length - 1 ? "vout" : `v${i}`;
  filter += `[${prevLabel}][${i}:v]xfade=transition=${transitions[i - 1]}:duration=${T}:offset=${offsets[i - 1].toFixed(3)}[${outLabel}]; `;
  prevLabel = outLabel;
}
filter += `[vout]format=yuv420p[vfinal]`;

const cmd = `"${FF}" -y ${inputs} -filter_complex "${filter}" -map "[vfinal]" -map ${names.length}:a -c:v libx264 -preset veryfast -crf 18 -r 30 -c:a aac -b:a 192k -shortest brag-raw.mp4 -loglevel warning -stats`;
console.log(cmd);
execSync(cmd, { cwd: WORK, stdio: "inherit" });
console.log("assembled brag-raw.mp4, target length", finalLen.toFixed(2));
