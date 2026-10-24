import sys

import qrcode
from qrcode.image.svg import SvgPathImage


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: qr.py <text>')
    image = qrcode.make(sys.argv[1], image_factory=SvgPathImage, box_size=8, border=3)
    image.save(sys.stdout.buffer)


if __name__ == '__main__':
    main()
