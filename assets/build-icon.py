"""
生成 Windows 多尺寸 .ico（小尺寸用粗描边变体，大尺寸用精细母版），并输出尺寸校验图。

用法：
    python assets/build-icon.py

依赖：pillow
输入：
    assets/icon-1024.png       精细母版（带投影/高光）
    assets/icon-small-256.png  小尺寸母版（粗勾、无投影）
输出：
    assets/taskboard.ico
    assets/icon-sizes.png
"""
import io
import struct
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).parent
MASTER = HERE / "icon-1024.png"
MASTER_SMALL = HERE / "icon-small-1024.png"
ICO = HERE / "taskboard.ico"
SHEET = HERE / "icon-sizes.png"

# 16-64 用 BMP 编码（兼容性最好），96 以上用 PNG 压缩（体积小、支持 256）
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
SMALL_MAX = 64


def bmp_entry(img: Image.Image) -> bytes:
    """把 RGBA 图像编码成 ICO 内部使用的 BMP（DIB + AND mask）。"""
    w, h = img.size
    px = img.load()

    xor = bytearray()
    for y in range(h - 1, -1, -1):          # BMP 自下而上
        for x in range(w):
            r, g, b, a = px[x, y]
            xor += bytes((b, g, r, a))

    row_bytes = ((w + 31) // 32) * 4        # 1bpp，行按 4 字节对齐
    and_mask = bytearray(row_bytes * h)     # 全 0 = 全部不透明（靠 alpha 通道）

    header = struct.pack(
        "<IiiHHIIiiII",
        40,            # biSize
        w,             # biWidth
        h * 2,         # biHeight（XOR + AND 两段）
        1,             # biPlanes
        32,            # biBitCount
        0,             # biCompression
        len(xor) + len(and_mask),
        0, 0, 0, 0,
    )
    return header + bytes(xor) + bytes(and_mask)


def png_entry(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def build_ico(master: Image.Image, small: Image.Image) -> None:
    entries = []
    for size in SIZES:
        src = small if size <= SMALL_MAX else master
        im = src.resize((size, size), Image.LANCZOS)
        payload = bmp_entry(im) if size <= SMALL_MAX else png_entry(im)
        entries.append((size, payload))

    offset = 6 + 16 * len(entries)
    header = struct.pack("<HHH", 0, 1, len(entries))
    directory, blob = b"", b""
    for size, payload in entries:
        dim = 0 if size >= 256 else size
        directory += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(payload), offset)
        offset += len(payload)
        blob += payload

    ICO.write_bytes(header + directory + blob)
    print("ico  :", ICO.name, ICO.stat().st_size, "bytes")


def build_sheet(master: Image.Image, small: Image.Image) -> None:
    pad, gap, cell = 26, 26, 256
    total_w = sum(max(s, 44) + gap for s in SIZES) - gap + pad * 2
    row_h = cell + pad * 2
    sheet = Image.new("RGB", (total_w, row_h * 2), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    draw.rectangle([0, row_h, total_w, row_h * 2], fill=(30, 32, 38))

    for row in range(2):
        x = pad
        for s in SIZES:
            w = max(s, 44)
            src = small if s <= SMALL_MAX else master
            im = src.resize((s, s), Image.LANCZOS)
            y = row * row_h + pad + (cell - s) // 2
            sheet.paste(im, (x + (w - s) // 2, y), im)
            draw.text((x, row * row_h + row_h - 22), f"{s}px", fill=(150, 150, 150))
            x += w + gap

    sheet.save(SHEET)
    print("sheet:", SHEET.name)


def main() -> None:
    master = Image.open(MASTER).convert("RGBA")
    small = Image.open(MASTER_SMALL).convert("RGBA")

    # 防御：母版必须是「满画布」的，否则小尺寸会被缩成一角
    for name, im in (("icon-1024.png", master), ("icon-small-1024.png", small)):
        x0, y0, x1, y1 = im.getchannel("A").getbbox()
        if min(x0, y0) > 64 or (x1 - x0) < im.width * 0.9:
            raise SystemExit(f"{name} 内容未铺满画布：bbox={(x0, y0, x1, y1)}")

    build_ico(master, small)
    build_sheet(master, small)


if __name__ == "__main__":
    main()
