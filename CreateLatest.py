#!/usr/bin/env python3
"""跨平台脚本：更新各音乐源的 latest.js 文件"""

import os
import shutil
from pathlib import Path

# Latest Version Numbers
VERSIONS = {
    'flower': '1',
    'grass': '1',
    'huibq': '1.2.0',
    'ikun': '22',
    'lx': '4',
    'sixyin': '1.2.1',
    'juhe': '3',
    'qdy': '9.3'
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
