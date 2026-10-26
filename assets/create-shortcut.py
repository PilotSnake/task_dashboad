"""
生成 Windows 快捷方式（.lnk），不依赖 COM / pywin32。

用法：
    python assets/create-shortcut.py <目标.lnk 路径> <目标文件> <工作目录> <图标.ico>

说明：
    只写 LinkInfo（绝对路径）+ 字符串段 + 图标数据块，不写 LinkTargetIDList。
    Windows 在没有 IDList 时会回退到 LinkInfo 解析目标，兼容性足够，
    而且避免了手工拼装 shell item 的格式风险。
    写入前会把已存在的 .lnk 备份为 .bak2。
"""
import shutil
import struct
import sys
from pathlib import Path

CLSID_SHELL_LINK = bytes.fromhex("0114020000000000C000000000000046")
FILE_ATTRIBUTE_ARCHIVE = 0x20
SHOW_NORMAL = 1

# LinkFlags
HAS_LINK_INFO = 0x02
HAS_WORKING_DIR = 0x10
HAS_ICON_LOCATION = 0x40
IS_UNICODE = 0x80

SIG_ICON_LOCATION_BLOCK = 0xA0000005


def _u16str(text: str) -> bytes:
    """StringData 的 Unicode 格式：2 字节字符数（含结尾 NUL）+ UTF-16LE。"""
    raw = text.encode("utf-16-le") + b"\x00\x00"
    return struct.pack("<H", len(raw) // 2) + raw


def _link_info(target: str) -> bytes:
    local_base_path = target.encode("mbcs") + b"\x00"
    common_suffix = b"\x00"
    volume_id = struct.pack("<IIII", 17, 3, 0, 0x10) + b"\x00"  # size, DRIVE_FIXED, serial, label offset

    header_size = 0x1C
    volume_off = header_size
    lbp_off = volume_off + len(volume_id)
    suffix_off = lbp_off + len(local_base_path)
    total = suffix_off + len(common_suffix)

    header = struct.pack(
        "<IIIIIII",
        total,
        header_size,
        1,          # LinkInfoFlags: VolumeIDAndLocalBasePath
        volume_off,
        lbp_off,
        0,          # CommonNetworkRelativeLinkOffset
        suffix_off,
    )
    return header + volume_id + local_base_path + common_suffix


def build(target: Path, workdir: Path, icon: Path, icon_index: int = 0) -> bytes:
    flags = HAS_LINK_INFO | HAS_WORKING_DIR | HAS_ICON_LOCATION | IS_UNICODE

    header = b"".join([
        struct.pack("<I", 0x4C),
        CLSID_SHELL_LINK,
        struct.pack("<I", flags),
        struct.pack("<I", FILE_ATTRIBUTE_ARCHIVE),
        struct.pack("<QQQ", 0, 0, 0),          # Creation / Access / Write time
        struct.pack("<I", target.stat().st_size),
        struct.pack("<i", icon_index),
        struct.pack("<I", SHOW_NORMAL),
        struct.pack("<H", 0),                  # HotKey
        struct.pack("<H", 0),                  # Reserved
        struct.pack("<I", 0),                  # Reserved2
        struct.pack("<I", 0),                  # Reserved3
    ])
    assert len(header) == 76, len(header)

    strings = _u16str(str(workdir)) + _u16str(str(icon))

    blob = str(icon).encode("utf-16-le") + b"\x00\x00"
    icon_block = struct.pack("<II", 8 + len(blob), SIG_ICON_LOCATION_BLOCK) + blob

    return header + _link_info(str(target)) + strings + icon_block + struct.pack("<I", 0)


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)

    lnk = Path(sys.argv[1])
    target = Path(sys.argv[2])
    workdir = Path(sys.argv[3])
    icon = Path(sys.argv[4])

    for p, label in ((target, "目标文件"), (workdir, "工作目录"), (icon, "图标")):
        if not p.exists():
            raise SystemExit(f"{label}不存在：{p}")

    if lnk.exists():
        backup = lnk.with_suffix(lnk.suffix + ".bak2")
        shutil.copy2(lnk, backup)
        print(f"backup : {backup}")

    lnk.write_bytes(build(target, workdir, icon))
    print(f"written: {lnk}  ({lnk.stat().st_size} bytes)")
    print(f"target : {target}")
    print(f"icon   : {icon}")


if __name__ == "__main__":
    main()
