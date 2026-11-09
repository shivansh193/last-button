"""Kaggle kernel: cut segments, build the Hyperframes composition, lint/check/render,
bake a poster frame, and make a 20-frame preview sheet. CPU, internet on.
Outputs in /kaggle/working/out: video.mp4, preview.jpg, poster.png, logs/."""
import glob, json, os, shutil, subprocess

HF = "hyperframes@0.9.26"
W = "/kaggle/working"
OUT = f"{W}/out"
LOGS = f"{OUT}/logs"
TMP = "/kaggle/tmp"
os.makedirs(LOGS, exist_ok=True)
os.makedirs(TMP, exist_ok=True)


def sh(cmd, log=None, check=True):
    print("$", cmd, flush=True)
    if log:
        with open(f"{LOGS}/{log}", "w") as f:
            r = subprocess.run(cmd, shell=True, executable="/bin/bash", stdout=f, stderr=subprocess.STDOUT)
        print(open(f"{LOGS}/{log}").read()[-3000:], flush=True)
    else:
        r = subprocess.run(cmd, shell=True, executable="/bin/bash")
    if check and r.returncode:
        raise SystemExit(f"failed ({r.returncode}): {cmd}")
    return r.returncode


DATA = os.path.dirname(glob.glob("/kaggle/input/**/marks.json", recursive=True)[0])
print("data:", DATA, os.listdir(DATA), flush=True)

# --- tools: Node 22, ffmpeg, Chrome libraries ---
NODE = f"{TMP}/node"
if not os.path.exists(f"{NODE}/bin/node"):
    sh(f"curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz | tar -xJ -C {TMP} && mv {TMP}/node-v22.11.0-linux-x64 {NODE}")
os.environ["PATH"] = f"{NODE}/bin:" + os.environ["PATH"]
sh("node -v && npm -v")
sh("apt-get update -qq", check=False)
if sh("which ffmpeg", check=False):
    sh("apt-get install -y -qq ffmpeg")
libs = ["libnss3", "libatk1.0-0", "libatk-bridge2.0-0", "libcups2", "libdrm2", "libxkbcommon0", "libxcomposite1", "libxdamage1",
        "libxfixes3", "libxrandr2", "libgbm1", "libasound2", "libpango-1.0-0", "libcairo2", "libatspi2.0-0", "libgtk-3-0", "fonts-liberation"]
for lib in libs:
    if sh(f"apt-get install -y -qq {lib} >/dev/null 2>&1", check=False):
        sh(f"apt-get install -y -qq {lib}t64 >/dev/null 2>&1", check=False)

# --- project ---
PROJ = f"{TMP}/proj"
shutil.rmtree(PROJ, ignore_errors=True)
os.makedirs(PROJ)
TAKES = f"{TMP}/takes"
shutil.rmtree(TAKES, ignore_errors=True)
shutil.copytree(DATA, TAKES)
# The dataset is flat: rebuild the takes/<chapter>/ layout build.py expects.
for f in os.listdir(TAKES):
    if f.endswith(".webm"):
        ch = f.split("-")[0].split(".")[0]
        os.makedirs(f"{TAKES}/{ch}", exist_ok=True)
        shutil.move(f"{TAKES}/{f}", f"{TAKES}/{ch}/{f}")
sh(f"python {TAKES}/build.py {TAKES} {PROJ}", log="build.log")
A = f"{PROJ}/assets"
for f in ["geist-sans/Geist-Regular.woff2", "geist-sans/Geist-Medium.woff2", "geist-sans/Geist-SemiBold.woff2", "geist-mono/GeistMono-Regular.woff2"]:
    sh(f"curl -fsSL -o {A}/{os.path.basename(f)} https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/{f}")
sh(f"curl -fsSL -o {A}/gsap.min.js https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js")
json.dump({"paths": {"blocks": "compositions", "components": "compositions/components", "assets": "assets"}, "media": {"autoProxy": True}},
          open(f"{PROJ}/hyperframes.json", "w"), indent=1)
json.dump({"id": "last-button-demo", "name": "last-button-demo"}, open(f"{PROJ}/meta.json", "w"))
json.dump({"name": "last-button-demo", "private": True, "type": "module"}, open(f"{PROJ}/package.json", "w"))
shutil.copy(f"{PROJ}/plan.json", f"{OUT}/plan.json")

os.chdir(PROJ)
os.environ["HYPERFRAMES_SKIP_SKILLS"] = "1"
os.environ["CI"] = "1"
sh(f"npx --yes {HF} browser ensure", log="browser.log")
sh(f"npx --yes {HF} lint . --verbose", log="lint.log", check=False)
sh(f"npx --yes {HF} check .", log="check.log", check=False)
sh(f"npx --yes {HF} render . --quality high -o {TMP}/raw.mp4", log="render.log")

# --- poster frame (the verified table) baked into frame 0, then a preview sheet ---
plan = json.load(open(f"{PROJ}/plan.json"))
poster_t = next(s["start"] for s in plan["segments"] if s["id"] == "c4f") + 2.0
sh(f"ffmpeg -v error -y -ss {poster_t} -i {TMP}/raw.mp4 -frames:v 1 {OUT}/poster.png")
sh(f"ffmpeg -v error -y -i {TMP}/raw.mp4 -i {OUT}/poster.png -filter_complex \"[0:v][1:v]overlay=0:0:enable='eq(n,0)'\" "
   f"-c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -c:a copy -movflags +faststart {OUT}/video.mp4", log="poster.log")
dur = float(subprocess.check_output(f"ffprobe -v error -show_entries format=duration -of csv=p=0 {OUT}/video.mp4", shell=True))
sh(f"ffmpeg -v error -y -i {OUT}/video.mp4 -vf \"fps=20/{dur},scale=480:-1,tile=4x5\" -frames:v 1 {OUT}/preview.jpg")
print("DURATION", dur, flush=True)
