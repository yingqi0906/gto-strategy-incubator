# verify-qr.py — 二维码验证第 2 步：读取 /tmp/qr-mine.json（qr.js 生成的矩阵），
# 与 Python qrcode 库（字节模式、纠错M、最小版本、掩码0）做矩阵级比对。
import json, sys, os
import qrcode
from qrcode.util import QRData, MODE_8BIT_BYTE

mine = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'qr-mine.json'), encoding='utf-8'))
passed = failed = 0
for case in mine:
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M,
                       mask_pattern=0, border=0, box_size=1)
    qr.add_data(QRData(case['text'].encode('utf-8'), mode=MODE_8BIT_BYTE))
    qr.make(fit=True)
    ref = qr.get_matrix()
    ok = case['size'] == len(ref)
    if ok:
        for r in range(len(ref)):
            if case['rows'][r] != ''.join('1' if ref[r][c] else '0' for c in range(len(ref))):
                ok = False
                print('  差异行 r=%d: 我=%s 参=%s' % (r, case['rows'][r], ''.join('1' if ref[r][c] else '0' for c in range(len(ref)))))
                break
    if ok:
        passed += 1
        print('PASS  v=%d  %s' % (qr.version, case['text']))
    else:
        failed += 1
        print('FAIL  %s  我的尺寸=%s 参考尺寸=%d' % (case['text'], case['size'], len(ref)))
print('结果: %d 通过 / %d 失败' % (passed, failed))
sys.exit(1 if failed else 0)
