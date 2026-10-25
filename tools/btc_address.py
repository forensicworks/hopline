"""Bitcoin mainnet address checksums for the tools that turn a list into a label pack.

A list written by people (or copied by hand from a document) holds typos; an address that fails its checksum is left out here, so
it never reaches a pack. The page checks every address again when it reads a pack (public/js/hopline-address.js), and a test keeps
the two in step.

    address_ok("bc1q...")   True for a valid base58 address (1..., 3...) or a valid bech32 / bech32m address (bc1...), False for
                            anything else, including testnet addresses and addresses of other coins.
"""
import hashlib

B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
GEN = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)


def base58_ok(a):
    n = 0
    for ch in a:
        i = B58.find(ch)
        if i < 0:
            return False
        n = n * 58 + i
    raw = b"\0" * (len(a) - len(a.lstrip("1"))) + n.to_bytes((n.bit_length() + 7) // 8, "big")
    return len(raw) == 25 and raw[0] in (0, 5) and hashlib.sha256(hashlib.sha256(raw[:21]).digest()).digest()[:4] == raw[21:]


def polymod(values):
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= GEN[i] if (top >> i) & 1 else 0
    return chk


def bech32_ok(a):
    if a != a.lower() and a != a.upper():
        return False
    a = a.lower()
    pos = a.rfind("1")
    if a[:pos] != "bc" or pos < 1 or len(a) < 14 or len(a) > 90:
        return False
    data = [B32.find(c) for c in a[pos + 1:]]
    if min(data) < 0 or len(data) < 7:
        return False
    version, const = data[0], polymod([ord(x) >> 5 for x in "bc"] + [0] + [ord(x) & 31 for x in "bc"] + data)
    if version > 16 or const != (1 if version == 0 else 0x2BC830A3):
        return False
    acc, bits, size = 0, 0, 0
    for v in data[1:-6]:
        acc, bits = (acc << 5) | v, bits + 5
        while bits >= 8:
            bits -= 8
            size += 1
    if bits > 4 or (acc & ((1 << bits) - 1)):
        return False
    return size in (20, 32) if version == 0 else 2 <= size <= 40


def address_ok(a):
    return isinstance(a, str) and (a.startswith(("bc1", "BC1")) and bech32_ok(a) or a[:1] in ("1", "3") and base58_ok(a))
