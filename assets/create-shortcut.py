"""
生成 Windows 快捷方式（.lnk），不依赖 COM / pywin32。

用法：
    python assets/create-shortcut.py <输出.lnk> <目标文件> <工作目录> <图标.ico> [模板.lnk]

原理：
    资源管理器解析 .lnk 时优先用 LinkTargetIDList（shell item 串）。
    只有 LinkInfo 而没有 IDList 的链接，实测双击无反应。
    所以这里从模板里取出「我的电脑 / 盘符 / 各级目录 / 文件」的 ItemID，
    只把最后那个文件项里的名字原位替换掉：

        ItemID 文件项 = 14 字节头 + ANSI 短名 + NUL + 扩展块(内含 UTF-16 长名)

    长名是 NUL 结尾的定长区域，新名字更短时用 0 填充，
    因此 cb / 扩展块大小 / 偏移量全都不用动，风险最小。
    另外重算文件大小与 DOS 时间戳，并重建 LinkInfo 指向新目标。
"""
import shutil
import struct
import sys
from datetime import datetime
from pathlib import Path

CLSID_SHELL_LINK = bytes.fromhex("0114020000000000C000000000000046")
FILE_ATTRIBUTE_ARCHIVE = 0x20
SHOW_NORMAL = 1

HAS_ID_LIST = 0x01
HAS_LINK_INFO = 0x02
HAS_WORKING_DIR = 0x10
HAS_ICON_LOCATION = 0x40
IS_UNICODE = 0x80

SIG_ICON_LOCATION_BLOCK = 0xA0000005


def dos_datetime(ts: float):
    d = datetime.fromtimestamp(ts)
    date = ((max(d.year, 1980) - 1980) << 9) | (d.month << 5) | d.day
    time = (d.hour << 11) | (d.minute << 5) | (d.second // 2)
    return date, time


def short_name_for(name: str) -> str:
    """生成 8.3 短名，用于 ItemID 的 ANSI 名字段。"""
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    stem = stem.upper()[:6]
    out = stem + "~1"
    if ext:
        out += "." + ext.upper()[:3]
    return out


def split_idlist(template: bytes):
    flags = struct.unpack("<I", template[20:24])[0]
    if not flags & HAS_ID_LIST:
        raise ValueError("模板缺少 LinkTargetIDList")
    size = struct.unpack("<H", template[76:78])[0]
    body = template[78:78 + size]
    items, i = [], 0
    while i < len(body):
        cb = struct.unpack("<H", body[i:i + 2])[0]
        if cb == 0:
            break
        items.append(body[i:i + cb])
        i += cb
    return items


def patch_file_item(item: bytes, old_long: str, new_long: str, size: int, mtime: float) -> bytes:
    b = bytearray(item)

    # 1. ANSI 短名（从偏移 14 开始，NUL 结尾）
    end = b.index(0, 14)
    old_short_len = end - 14
    new_short = short_name_for(new_long).encode("ascii")
    if len(new_short) > old_short_len:
        raise ValueError(f"短名过长：{new_short!r} > {old_short_len} 字节")
    b[14:end] = new_short + b"\x00" * (old_short_len - len(new_short))

    # 2. UTF-16 长名（NUL 结尾的定长区，短了用 0 填充）
    old_bytes = old_long.encode("utf-16-le")
    idx = bytes(b).find(old_bytes)
    if idx < 0:
        raise ValueError(f"在 ItemID 里找不到长名 {old_long!r}")
    new_bytes = new_long.encode("utf-16-le")
    if len(new_bytes) > len(old_bytes):
        raise ValueError(f"长名过长：{new_long!r} 超过原字段 {len(old_bytes)} 字节")
    b[idx:idx + len(old_bytes)] = new_bytes + b"\x00" * (len(old_bytes) - len(new_bytes))

    # 3. 文件大小 + 修改时间 + 属性
    struct.pack_into("<i", b, 4, size)
    date, time = dos_datetime(mtime)
    struct.pack_into("<HH", b, 8, date, time)
    struct.pack_into("<H", b, 12, FILE_ATTRIBUTE_ARCHIVE)

    return bytes(b)


def build_id_list(target: Path, template: bytes, old_long: str) -> bytes:
    items = split_idlist(template)
    if not items or items[-1][2] != 0x32:
        raise ValueError("模板最后一个 ItemID 不是文件项")

    items[-1] = patch_file_item(items[-1], old_long, target.name,
                                target.stat().st_size, target.stat().st_mtime)
    body = b"".join(items) + b"\x00\x00"
    return struct.pack("<H", len(body)) + body


def link_info(target: str) -> bytes:
    local_base_path = target.encode("mbcs") + b"\x00"
    common_suffix = b"\x00"
    volume_id = struct.pack("<IIII", 17, 3, 0, 0x10) + b"\x00"

    header_size = 0x1C
    volume_off = header_size
    lbp_off = volume_off + len(volume_id)
    suffix_off = lbp_off + len(local_base_path)
    total = suffix_off + len(common_suffix)

    header = struct.pack("<IIIIIII", total, header_size, 1, volume_off, lbp_off, 0, suffix_off)
    return header + volume_id + local_base_path + common_suffix


def u16str(text: str) -> bytes:
    raw = text.encode("utf-16-le") + b"\x00\x00"
    return struct.pack("<H", len(raw) // 2) + raw


def build(target: Path, workdir: Path, icon: Path, template: bytes,
          old_long: str, icon_index: int = 0) -> bytes:
    flags = HAS_ID_LIST | HAS_LINK_INFO | HAS_WORKING_DIR | HAS_ICON_LOCATION | IS_UNICODE

    header = b"".join([
        struct.pack("<I", 0x4C),
        CLSID_SHELL_LINK,
        struct.pack("<I", flags),
        struct.pack("<I", FILE_ATTRIBUTE_ARCHIVE),
        struct.pack("<QQQ", 0, 0, 0),
        struct.pack("<I", target.stat().st_size),
        struct.pack("<i", icon_index),
        struct.pack("<I", SHOW_NORMAL),
        struct.pack("<H", 0),
        struct.pack("<H", 0),
        struct.pack("<I", 0),
        struct.pack("<I", 0),
    ])
    assert len(header) == 76, len(header)

    strings = u16str(str(workdir)) + u16str(str(icon))

    blob = str(icon).encode("utf-16-le") + b"\x00\x00"
    icon_block = struct.pack("<II", 8 + len(blob), SIG_ICON_LOCATION_BLOCK) + blob

    return (header
            + build_id_list(target, template, old_long)
            + link_info(str(target))
            + strings
            + icon_block
            + struct.pack("<I", 0))


def main() -> None:
    if len(sys.argv) not in (5, 6):
        raise SystemExit(__doc__)

    lnk = Path(sys.argv[1])
    target = Path(sys.argv[2])
    workdir = Path(sys.argv[3])
    icon = Path(sys.argv[4])

    # 模板：优先用参数；否则用桌面快捷方式的备份（原本指向 index.html）
    template = Path(sys.argv[5]) if len(sys.argv) == 6 else lnk.with_suffix(lnk.suffix + ".bak2")
    for p, label in ((target, "目标文件"), (workdir, "工作目录"), (icon, "图标"), (template, "模板")):
        if not p.exists():
            raise SystemExit(f"{label}不存在：{p}")

    data = build(target, workdir, icon, template.read_bytes(), old_long="index.html")

    if lnk.exists():
        backup = lnk.with_suffix(lnk.suffix + ".bak3")
        shutil.copy2(lnk, backup)
        print(f"backup : {backup}")

    lnk.write_bytes(data)
    print(f"written: {lnk}  ({len(data)} bytes)")
    print(f"target : {target}")


if __name__ == "__main__":
    main()
