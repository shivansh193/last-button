"""Kaggle kernel: Kokoro voiceover + original synthesized music bed + mix + subtitles.
Inputs: the render kernel's output (video.mp4) and narration.json from the assets dataset.
Outputs in /kaggle/working/out: last-button-demo.mp4 (voice), last-button-demo-music.mp4, last-button-demo.srt, voice_fit.json."""
import glob, json, math, os, re, subprocess, wave

W = "/kaggle/working"
OUT = f"{W}/out"
TMP = "/kaggle/tmp"
os.makedirs(OUT, exist_ok=True)
os.makedirs(f"{TMP}/vo", exist_ok=True)


def sh(cmd, check=True):
    print("$", cmd, flush=True)
    r = subprocess.run(cmd, shell=True, executable="/bin/bash")
    if check and r.returncode:
        raise SystemExit(f"failed: {cmd}")


VIDEO = glob.glob("/kaggle/input/**/video.mp4", recursive=True)[0]
LINES = json.load(open(glob.glob("/kaggle/input/**/narration.json", recursive=True)[0]))
print("video", VIDEO, "lines", len(LINES), flush=True)
dur_v = float(subprocess.check_output(f"ffprobe -v error -show_entries format=duration -of csv=p=0 {VIDEO}", shell=True))

# ---- TTS: Kokoro needs Python < 3.13 ----
sh("apt-get update -qq && apt-get install -y -qq espeak-ng >/dev/null", check=False)
sh("pip install -q uv")
sh(f"uv venv -p 3.12 {TMP}/tts")
sh(f'uv pip install --python {TMP}/tts/bin/python "kokoro>=0.9.4" soundfile "numpy<2.3" '
   "https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl")
open(f"{TMP}/tts.py", "w").write(f'''
import json, numpy as np, soundfile as sf
from kokoro import KPipeline
p = KPipeline(lang_code="a")
for l in json.load(open("{TMP}/lines.json")):
    audio = [a for _, _, a in p(l["spoken"], voice="af_heart", speed=1.0)]
    sf.write(f"{TMP}/vo/{{l['id']}}.wav", np.concatenate(audio), 24000)
    print("tts", l["id"], flush=True)
''')
json.dump(LINES, open(f"{TMP}/lines.json", "w"))
sh(f"{TMP}/tts/bin/python {TMP}/tts.py")


def wav_dur(p):
    with wave.open(p) as w:
        return w.getnframes() / w.getframerate()


# ---- fit each line into its room (atempo up to 1.18x) ----
fit = []
for l in LINES:
    src = f"{TMP}/vo/{l['id']}.wav"
    length = wav_dur(src)
    room = l["end"] - l["start"] - 0.25
    tempo = 1.0
    if length > room:
        tempo = min(1.18, length / room)
    dst = f"{TMP}/vo/{l['id']}_fit.wav"
    sh(f"ffmpeg -v error -y -i {src} -af atempo={tempo:.4f} -ar 48000 -ac 2 {dst}")
    final = wav_dur(dst)
    fit.append({"id": l["id"], "start": l["start"], "length": round(length, 2), "room": round(room, 2), "tempo": round(tempo, 3),
                "final": round(final, 2), "fits": final <= room + 0.05})
json.dump(fit, open(f"{OUT}/voice_fit.json", "w"), indent=1)
for f in fit:
    print(f, flush=True)

# ---- original music bed: soft pad chords + plucked arpeggio, synthesized here (no third-party audio) ----
import numpy as np
SR = 48000
BPM = 84
beat = 60 / BPM
chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]  # Am F C G
hz = lambda n: 440 * 2 ** ((n - 69) / 12)
bar = 4 * beat
loop_len = bar * len(chords)
n = int(SR * loop_len)
t = np.arange(n) / SR
pad = np.zeros(n)
for i, ch in enumerate(chords):
    a, b = int(i * bar * SR), int((i + 1) * bar * SR)
    tt = t[a:b] - t[a]
    env = np.minimum(1, tt / 0.6) * np.minimum(1, (bar - tt) / 0.6)
    for note in ch:
        f = hz(note)
        pad[a:b] += env * (np.sin(2 * np.pi * f * tt) + 0.35 * np.sin(2 * np.pi * 2 * f * tt + 0.3)) / 3
pluck = np.zeros(n)
for i, ch in enumerate(chords):
    for k in range(8):
        start = i * bar + k * beat / 2
        note = ch[k % 3] + 12
        a = int(start * SR)
        L = int(0.9 * SR)
        tt = np.arange(min(L, n - a)) / SR
        pluck[a:a + len(tt)] += np.exp(-tt * 5.5) * np.sin(2 * np.pi * hz(note) * tt) * 0.35
music = 0.6 * pad + pluck
# light stereo delay for warmth
d = int(0.18 * SR)
left = music + 0.25 * np.roll(music, d)
right = music + 0.25 * np.roll(music, d * 2)
st = np.stack([left, right], 1)
st = st / np.max(np.abs(st)) * 0.8
import soundfile as sf  # available in the base image? fall back to wave
try:
    sf.write(f"{TMP}/music_loop.wav", st, SR)
except Exception:
    with wave.open(f"{TMP}/music_loop.wav", "w") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((st * 32767).astype("<i2").tobytes())

# ---- voice track: every line placed at its start ----
inputs = " ".join(f"-i {TMP}/vo/{f['id']}_fit.wav" for f in fit)
delays = ";".join(f"[{i}:a]adelay={int(f['start'] * 1000)}|{int(f['start'] * 1000)}[v{i}]" for i, f in enumerate(fit))
mixv = "".join(f"[v{i}]" for i in range(len(fit)))
sh(f'ffmpeg -v error -y {inputs} -filter_complex "{delays};{mixv}amix=inputs={len(fit)}:normalize=0,apad,atrim=0:{dur_v}[vo]" '
   f'-map "[vo]" -ar 48000 -ac 2 {TMP}/voice.wav')

fade_out = dur_v - 3
music_chain = f"aloop=loop=-1:size={n},atrim=0:{dur_v},volume=0.16,afade=t=in:d=2,afade=t=out:st={fade_out}:d=3"
# With voice: duck the music under the voice.
sh(f'ffmpeg -v error -y -i {VIDEO} -i {TMP}/music_loop.wav -i {TMP}/voice.wav -filter_complex '
   f'"[1:a]{music_chain}[m];[2:a]asplit=2[vk][vm];[m][vk]sidechaincompress=threshold=0.02:ratio=9:attack=15:release=350[md];'
   f'[md][vm]amix=inputs=2:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[a]" '
   f'-map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -ar 48000 -movflags +faststart -shortest {OUT}/last-button-demo.mp4')
# Music only.
sh(f'ffmpeg -v error -y -i {VIDEO} -i {TMP}/music_loop.wav -filter_complex "[1:a]{music_chain.replace("volume=0.16", "volume=0.30")},loudnorm=I=-18:TP=-1.5:LRA=11[a]" '
   f'-map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -ar 48000 -movflags +faststart -shortest {OUT}/last-button-demo-music.mp4')

# ---- subtitles from the placed voice timings ----
def chunks(text):
    parts = re.split(r"(?<=[.!?])\s+|(?<=,)\s+", text)
    out, cur = [], ""
    for p in parts:
        if cur and len(cur) + 1 + len(p) > 84:
            out.append(cur); cur = p
        else:
            cur = f"{cur} {p}".strip()
    if cur:
        out.append(cur)
    return out


def wrap(s, width=42):
    words, lines, cur = s.split(), [], ""
    for w_ in words:
        if cur and len(cur) + 1 + len(w_) > width:
            lines.append(cur); cur = w_
        else:
            cur = f"{cur} {w_}".strip()
    lines.append(cur)
    return "\n".join(lines[:2]) if len(lines) <= 2 else "\n".join([" ".join(lines[: len(lines) // 2]), " ".join(lines[len(lines) // 2:])])


def ts(x):
    ms = int(round(x * 1000)); h, ms = divmod(ms, 3600000); mi, ms = divmod(ms, 60000); s_, ms = divmod(ms, 1000)
    return f"{h:02}:{mi:02}:{s_:02},{ms:03}"


cues = []
for l, f in zip(LINES, fit):
    cs = chunks(l["written"])
    total = sum(len(c) for c in cs)
    t0 = f["start"]
    for c in cs:
        d_ = f["final"] * len(c) / total
        cues.append([t0, t0 + d_, c])
        t0 += d_
for i in range(len(cues) - 1):
    cues[i][1] = min(cues[i][1], cues[i + 1][0] - 0.04)
with open(f"{OUT}/last-button-demo.srt", "w") as fh:
    for i, (a, b, c) in enumerate(cues, 1):
        fh.write(f"{i}\n{ts(a)} --> {ts(b)}\n{wrap(c)}\n\n")

for name in ["last-button-demo.mp4", "last-button-demo-music.mp4"]:
    sh(f"ffprobe -v error -show_entries format=duration -of csv=p=0 {OUT}/{name}")
    sh(f"ffmpeg -hide_banner -i {OUT}/{name} -af volumedetect -vn -f null - 2>&1 | grep -E 'mean_volume|max_volume'")
print("DONE", flush=True)
