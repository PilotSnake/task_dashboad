"""
给桌面快捷方式写入自定义图标（直接改写 .lnk 二进制，不依赖 COM）。

用法：
    python assets/set-shortcut-icon.py "C:\\path\\to\\xxx.lnk" "D:\\projects\\task_dashboad\\assets\\taskboard.ico"

做法：保留原有的 IDList / LinkInfo / 字符串 / 额外数据块，
只在 WorkingDir 字符串后写入 ICON_LOCATION 字符串（并置位 HasIconLocation 标志），
再在终止块前插入 ICON_LOCATION 数据块（0xA0000005）。
写入前会自动生成 .bak 备份。
"""
import shutil
import struct
import sys
from pathlib import Path

FLAG_HAS_ICON_LOCATION = 1 << 6
SIG_ICON_LOCATION_BLOCK = 0xA0000005
HEADER_SIZE = 76


def parse(d: bytes) -> dict:
    """解析 ShellLink 结构，返回关键偏移。"""
    if struct.unpack("<I", d[:4])[0] != 0x4C:
        raise ValueError("不是标准的 ShellLink 文件")

    flags = struct.unpack("<I", d[20:24])[0]
    pos = HEADER_SIZE

    if flags & 1:  # HasLinkTargetIDList
        pos += 2 + struct.unpack("<H", d[pos:pos + 2])[0]
    if flags & 2:  # HasLinkInfo
        pos += struct.unpack("<I", d[pos:pos + 4])[0]

    unit = 2 if flags & 0x80 else 1  # IsUnicode

    # 字符串顺序：Name / RelativePath / WorkingDir / Arguments / IconLocation
    base_end = pos
    for bit in (2, 3, 4, 5):
        if flags & (1 << bit):
            n = struct.unpack("<H", d[base_end:base_end + 2])[0]
            base_end += 2 + n * unit

    strings_end = base_end
    if flags & FLAG_HAS_ICON_LOCATION:
        n = struct.unpack("<H", d[strings_end:strings_end + 2])[0]
        strings_end += 2 + n * unit

    blocks_end = strings_end
    while blocks_end + 4 <= len(d):
        size = struct.unpack("<I", d[blocks_end:blocks_end + 4])[0]
        if size == 0:
            break
        blocks_end += size

    return {"flags": flags, "base_end": base_end, "strings_end": strings_end, "blocks_end": blocks_end}


def patch(lnk: Path, icon: Path) -> None:
    d = lnk.read_bytes()
    info = parse(d)

    head = bytearray(d[:info["base_end"]])            # 到图标字符串之前为止
    extra_blocks = d[info["strings_end"]:info["blocks_end"]]  # 原有额外数据块

    text = str(icon) + "\x00"
    string_data = struct.pack("<H", len(text)) + text.encode("utf-16-le")

    blob = text.encode("utf-16-le")
    icon_block = struct.pack("<II", 8 + len(blob), SIG_ICON_LOCATION_BLOCK) + blob

    struct.pack_into("<I", head, 20, info["flags"] | FLAG_HAS_ICON_LOCATION)

    backup = lnk.with_suffix(lnk.suffix + ".bak")
    shutil.copy2(lnk, backup)

    lnk.write_bytes(bytes(head) + string_data + extra_blocks + icon_block + struct.pack("<I", 0))
    print(f"backup : {backup}")
    print(f"written: {lnk}  ({lnk.stat().st_size} bytes)")
    print(f"icon   : {icon}")


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    lnk, icon = Path(sys.argv[1]), Path(sys.argv[2])
    if not lnk.exists():
        raise SystemExit(f"快捷方式不存在：{lnk}")
    if not icon.exists():
        raise SystemExit(f"图标文件不存在：{icon}")
    patch(lnk, icon)


if __name__ == "__main__":
    main()
