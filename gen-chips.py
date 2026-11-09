# -*- coding: utf-8 -*-
"""验证 sounds/*.wav 格式，并合成约1秒的筹码互相撞击声 chips.wav（纯标准库）。"""
import os
import wave
import math
import random
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
SND = os.path.join(HERE, 'sounds')

# ---------- 1) 验证语音 wav ----------
for f in sorted(os.listdir(SND)):
    if not f.endswith('.wav'):
        continue
    with wave.open(os.path.join(SND, f), 'rb') as w:
        dur = w.getnframes() / w.getframerate()
        print('%-10s %dch %dHz %dbit %.2fs' % (
            f, w.getnchannels(), w.getframerate(), w.getsampwidth() * 8, dur))

# ---------- 2) 合成筹码撞击声 ----------
SR = 44100
DUR = 1.0
random.seed(20260925)
n_total = int(SR * DUR)
buf = [0.0] * n_total

def add_click(t0, gain):
    """一枚筹码撞击：短促衰减的共振体（多正弦）+ 噪声瞬态，以及尾音轻震铃。"""
    start = int(t0 * SR)
    # 冲击体：3~5kHz 内随机基频 + 两个非谐分音，指数衰减
    f0 = random.uniform(2400, 4200)
    partials = [(f0, 1.0), (f0 * random.uniform(1.6, 2.1), 0.55), (f0 * random.uniform(2.6, 3.4), 0.3)]
    decay = random.uniform(28, 55)          # 衰减速率
    click_len = int(SR * random.uniform(0.05, 0.10))
    for i in range(click_len):
        idx = start + i
        if idx >= n_total:
            break
        t = i / SR
        env = math.exp(-decay * t)
        s = sum(a * math.sin(2 * math.pi * f * t) for f, a in partials) / sum(a for _, a in partials)
        # 前沿噪声瞬态（chip 碰撞的“脆”感）
        noise = (random.uniform(-1, 1)) * 0.5 * math.exp(-180 * t)
        buf[idx] += gain * (0.8 * s + noise) * env

def add_rattle(t0, gain, dur_ms, n):
    """筹码堆相互摩擦的一串快速小碰撞。"""
    for k in range(n):
        add_click(t0 + k * random.uniform(0.008, 0.02) + random.uniform(0, 0.004), gain * random.uniform(0.4, 0.8))

# 主体：约 14 次撞击，前后渐弱
times = [0.05 + 0.065 * i + random.uniform(-0.02, 0.02) for i in range(14)]
times = [t for t in times if t < DUR - 0.12]
for i, t in enumerate(times):
    edge = 0.55 + 0.45 * math.sin(math.pi * min(1.0, i / max(1, len(times) - 1)))
    add_click(t, 0.55 * edge)
    if random.random() < 0.5:
        add_rattle(t + 0.012, 0.22 * edge, 40, random.randint(2, 4))

# 归一化到 0.85 峰值，加 5ms 淡入 / 80ms 淡出
peak = max(abs(x) for x in buf) or 1.0
fade_in = int(SR * 0.005)
fade_out = int(SR * 0.08)
for i in range(n_total):
    g = 0.85 / peak
    if i < fade_in:
        g *= i / fade_in
    if i > n_total - fade_out:
        g *= (n_total - i) / fade_out
    buf[i] *= g

path = os.path.join(SND, 'chips.wav')
with wave.open(path, 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(b''.join(struct.pack('<h', max(-32767, min(32767, int(x * 32767)))) for x in buf))
with wave.open(path, 'rb') as w:
    print('%-10s %dch %dHz %dbit %.2fs' % (
        'chips.wav', w.getnchannels(), w.getframerate(), w.getsampwidth() * 8,
        w.getnframes() / w.getframerate()))
