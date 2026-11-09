# -*- coding: utf-8 -*-
"""生成动作语音（女声）：fold / raise / call / all in -> sounds/*.wav
使用 Windows SAPI COM（同步写文件，避免 pyttsx3 runAndWait 挂死）。可重复运行。"""
import os
import comtypes.client

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sounds')
os.makedirs(OUT, exist_ok=True)

WORDS = {
    'fold': 'fold',
    'raise': 'raise',
    'call': 'call',
    'allin': 'all in',
    'check': 'check',
    'bet': 'bet',
}

def main():
    from comtypes.gen import SpeechLib
    voice = comtypes.client.CreateObject('SAPI.SpVoice')
    # 选择英语女声 Zira
    for i in range(voice.GetVoices().Count):
        v = voice.GetVoices().Item(i)
        if 'ZIRA' in v.GetAttribute('Name').upper():
            voice.Voice = v
            break
    voice.Rate = 0  # 正常语速（太慢会拖累连续行动的节奏）
    voice.Volume = 100
    for name, text in WORDS.items():
        path = os.path.join(OUT, name + '.wav')
        stream = comtypes.client.CreateObject('SAPI.SpFileStream')
        stream.Format.Type = SpeechLib.SAFT22kHz16BitMono
        stream.Open(path, SpeechLib.SSFMCreateForWrite)
        voice.AudioOutputStream = stream
        voice.Speak(text)
        stream.Close()
        print('生成', path)

if __name__ == '__main__':
    main()
