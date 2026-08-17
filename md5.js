// md5.js — 精简 MD5 实现（公开领域算法，由内容脚本加载）
// 用途：B 站 WBI 接口签名（w_rid 计算）

function md5(string) {
  function RotateLeft(lValue, iShiftBits) {
    return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
  }

  function AddUnsigned(lX, lY) {
    const lX4 = lX & 0x40000000;
    const lY4 = lY & 0x40000000;
    const lX8 = lX & 0x80000000;
    const lY8 = lY & 0x80000000;
    const lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff);
    if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
    if (lX4 | lY4) {
      if (lResult & 0x40000000) return lResult ^ 0xc0000000 ^ lX8 ^ lY8;
      return lResult ^ 0x40000000 ^ lX8 ^ lY8;
    }
    return lResult ^ lX8 ^ lY8;
  }

  function F(x, y, z) { return (x & y) | (~x & z); }
  function G(x, y, z) { return (x & z) | (y & ~z); }
  function H(x, y, z) { return x ^ y ^ z; }
  function I(x, y, z) { return y ^ (x | ~z); }

  function FF(a, b, c, d, x, s, ac) {
    a = AddUnsigned(a, AddUnsigned(AddUnsigned(F(b, c, d), x), ac));
    return AddUnsigned(RotateLeft(a, s), b);
  }
  function GG(a, b, c, d, x, s, ac) {
    a = AddUnsigned(a, AddUnsigned(AddUnsigned(G(b, c, d), x), ac));
    return AddUnsigned(RotateLeft(a, s), b);
  }
  function HH(a, b, c, d, x, s, ac) {
    a = AddUnsigned(a, AddUnsigned(AddUnsigned(H(b, c, d), x), ac));
    return AddUnsigned(RotateLeft(a, s), b);
  }
  function II(a, b, c, d, x, s, ac) {
    a = AddUnsigned(a, AddUnsigned(AddUnsigned(I(b, c, d), x), ac));
    return AddUnsigned(RotateLeft(a, s), b);
  }

  // 字符串 → UTF-8 字节数组
  function utf8Bytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (
        c >= 0xd800 && c <= 0xdbff && i + 1 < str.length &&
        str.charCodeAt(i + 1) >= 0xdc00 && str.charCodeAt(i + 1) <= 0xdfff
      ) {
        const v = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(i + 1) - 0xdc00);
        bytes.push(0xf0 | (v >> 18), 0x80 | ((v >> 12) & 0x3f), 0x80 | ((v >> 6) & 0x3f), 0x80 | (v & 0x3f));
        i++;
      } else {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return bytes;
  }

  const bytes = utf8Bytes(string);
  const bitLen = bytes.length * 8;
  const bitLenLow = bitLen >>> 0;
  const bitLenHigh = Math.floor(bitLen / 4294967296);

  // 填充：0x80 + 0x00... 到 56 mod 64，再追加 64 位长度（小端）
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  bytes.push(
    bitLenLow & 0xff, (bitLenLow >>> 8) & 0xff, (bitLenLow >>> 16) & 0xff, (bitLenLow >>> 24) & 0xff,
    bitLenHigh & 0xff, (bitLenHigh >>> 8) & 0xff, (bitLenHigh >>> 16) & 0xff, (bitLenHigh >>> 24) & 0xff
  );

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
  const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
  const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
  const S41 = 6, S42 = 10, S43 = 15, S44 = 21;

  for (let off = 0; off < bytes.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) {
      M[i] = bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;

    // 第 1 轮
    A = FF(A, B, C, D, M[0], S11, 0xd76aa478);
    D = FF(D, A, B, C, M[1], S12, 0xe8c7b756);
    C = FF(C, D, A, B, M[2], S13, 0x242070db);
    B = FF(B, C, D, A, M[3], S14, 0xc1bdceee);
    A = FF(A, B, C, D, M[4], S11, 0xf57c0faf);
    D = FF(D, A, B, C, M[5], S12, 0x4787c62a);
    C = FF(C, D, A, B, M[6], S13, 0xa8304613);
    B = FF(B, C, D, A, M[7], S14, 0xfd469501);
    A = FF(A, B, C, D, M[8], S11, 0x698098d8);
    D = FF(D, A, B, C, M[9], S12, 0x8b44f7af);
    C = FF(C, D, A, B, M[10], S13, 0xffff5bb1);
    B = FF(B, C, D, A, M[11], S14, 0x895cd7be);
    A = FF(A, B, C, D, M[12], S11, 0x6b901122);
    D = FF(D, A, B, C, M[13], S12, 0xfd987193);
    C = FF(C, D, A, B, M[14], S13, 0xa679438e);
    B = FF(B, C, D, A, M[15], S14, 0x49b40821);

    // 第 2 轮
    A = GG(A, B, C, D, M[1], S21, 0xf61e2562);
    D = GG(D, A, B, C, M[6], S22, 0xc040b340);
    C = GG(C, D, A, B, M[11], S23, 0x265e5a51);
    B = GG(B, C, D, A, M[0], S24, 0xe9b6c7aa);
    A = GG(A, B, C, D, M[5], S21, 0xd62f105d);
    D = GG(D, A, B, C, M[10], S22, 0x02441453);
    C = GG(C, D, A, B, M[15], S23, 0xd8a1e681);
    B = GG(B, C, D, A, M[4], S24, 0xe7d3fbc8);
    A = GG(A, B, C, D, M[9], S21, 0x21e1cde6);
    D = GG(D, A, B, C, M[14], S22, 0xc33707d6);
    C = GG(C, D, A, B, M[3], S23, 0xf4d50d87);
    B = GG(B, C, D, A, M[8], S24, 0x455a14ed);
    A = GG(A, B, C, D, M[13], S21, 0xa9e3e905);
    D = GG(D, A, B, C, M[2], S22, 0xfcefa3f8);
    C = GG(C, D, A, B, M[7], S23, 0x676f02d9);
    B = GG(B, C, D, A, M[12], S24, 0x8d2a4c8a);

    // 第 3 轮
    A = HH(A, B, C, D, M[5], S31, 0xfffa3942);
    D = HH(D, A, B, C, M[8], S32, 0x8771f681);
    C = HH(C, D, A, B, M[11], S33, 0x6d9d6122);
    B = HH(B, C, D, A, M[14], S34, 0xfde5380c);
    A = HH(A, B, C, D, M[1], S31, 0xa4beea44);
    D = HH(D, A, B, C, M[4], S32, 0x4bdecfa9);
    C = HH(C, D, A, B, M[7], S33, 0xf6bb4b60);
    B = HH(B, C, D, A, M[10], S34, 0xbebfbc70);
    A = HH(A, B, C, D, M[13], S31, 0x289b7ec6);
    D = HH(D, A, B, C, M[0], S32, 0xeaa127fa);
    C = HH(C, D, A, B, M[3], S33, 0xd4ef3085);
    B = HH(B, C, D, A, M[6], S34, 0x04881d05);
    A = HH(A, B, C, D, M[9], S31, 0xd9d4d039);
    D = HH(D, A, B, C, M[12], S32, 0xe6db99e5);
    C = HH(C, D, A, B, M[15], S33, 0x1fa27cf8);
    B = HH(B, C, D, A, M[2], S34, 0xc4ac5665);

    // 第 4 轮
    A = II(A, B, C, D, M[0], S41, 0xf4292244);
    D = II(D, A, B, C, M[7], S42, 0x432aff97);
    C = II(C, D, A, B, M[14], S43, 0xab9423a7);
    B = II(B, C, D, A, M[5], S44, 0xfc93a039);
    A = II(A, B, C, D, M[12], S41, 0x655b59c3);
    D = II(D, A, B, C, M[3], S42, 0x8f0ccc92);
    C = II(C, D, A, B, M[10], S43, 0xffeff47d);
    B = II(B, C, D, A, M[1], S44, 0x85845dd1);
    A = II(A, B, C, D, M[8], S41, 0x6fa87e4f);
    D = II(D, A, B, C, M[15], S42, 0xfe2ce6e0);
    C = II(C, D, A, B, M[6], S43, 0xa3014314);
    B = II(B, C, D, A, M[13], S44, 0x4e0811a1);
    A = II(A, B, C, D, M[4], S41, 0xf7537e82);
    D = II(D, A, B, C, M[11], S42, 0xbd3af235);
    C = II(C, D, A, B, M[2], S43, 0x2ad7d2bb);
    B = II(B, C, D, A, M[9], S44, 0xeb86d391);

    a0 = AddUnsigned(a0, A);
    b0 = AddUnsigned(b0, B);
    c0 = AddUnsigned(c0, C);
    d0 = AddUnsigned(d0, D);
  }

  function toHexLE(x) {
    let s = '';
    for (let i = 0; i < 4; i++) {
      const b = (x >>> (i * 8)) & 0xff;
      s += (b < 16 ? '0' : '') + b.toString(16);
    }
    return s;
  }

  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}
