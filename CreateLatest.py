#!/usr/bin/env python3
"""跨平台脚本：更新各音乐源的 latest.js 文件"""

import os
import shutil
import sys
from pathlib import Path

# 兼容 Windows GBK 控制台，避免 emoji 输出导致 UnicodeEncodeError
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# Latest Version Numbers
VERSIONS = {
    'changqing': '1.3.0',
    'feichangdao': '5',
    'fish': '1.9.0',
    'flower': '1',
    'grass': '1',
    'helloworld': '260925',
    'huanyin': '3',
    'huibq': '1.2.0',
    'hyw': '1.2.0',
    'ikun': '22',
    'jiexiang': '2.3.0',
    'lx': '7',
    'sixyin': '1.2.1',
    'suyin': '1',
    'juhe': '3',
    'qdy': '9.3',
    'qingliang': '2.1.0',
    'xinghai': '3.2.18',
    'xinglan': '4.0.2',
    'yuningxi': '1.2.5'
}

def main():
    script_dir = Path(__file__).parent.resolve()

    for source, version in VERSIONS.items():
        src = script_dir / source / f'{version}.js'
        dst = script_dir / source / 'latest.js'

        if src.exists():
            shutil.copy2(src, dst)
            print(f'✅ {source}: {version}.js → latest.js')
        else:
            print(f'❌ {source}: {version}.js 不存在')

if __name__ == '__main__':
    main()
