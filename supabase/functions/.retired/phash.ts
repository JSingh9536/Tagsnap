import { decode as decodeJpeg } from 'npm:jpeg-js@0.4.4';

/**
 * A difference hash of a tag photo.
 *
 * The unique constraint on (quarry_id, ticket_number) catches the same ticket
 * filed twice. It does not catch the same physical ticket photographed from a
 * different angle and filed with one digit of the ticket number changed —
 * which is the version of that someone actually tries, because it looks like
 * an honest typo if anyone asks.
 *
 * dHash catches it. The method is deliberately crude: shrink to 9x8
 * greyscale, then record whether each pixel is brighter than the one to its
 * right. That yields 64 bits describing the *structure* of the image, which
 * survives a different angle, different lighting, and a different phone, while
 * two genuinely different documents diverge immediately.
 *
 * Chosen over a cryptographic hash for the obvious reason: SHA-256 of two
 * photos of the same ticket differs completely, which is the opposite of what
 * this needs to detect.
 */

const W = 9;
const H = 8;

export function dHash(bytes: Uint8Array, mediaType: string): bigint | null {
  // Only JPEG is decoded, which is what the app produces — the capture screen
  // re-encodes every photo to JPEG before it reaches the queue. A PNG or HEIC
  // arriving from somewhere else simply goes unhashed rather than failing the
  // extraction it is attached to.
  if (mediaType !== 'image/jpeg') return null;

  let img: { width: number; height: number; data: Uint8Array };
  try {
    img = decodeJpeg(bytes, { useTArray: true, maxMemoryUsageInMB: 128 });
  } catch {
    return null;
  }

  if (!img.width || !img.height) return null;

  const small = boxDownsampleToGrey(img, W, H);

  let hash = 0n;
  let bit = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      const left = small[y * W + x]!;
      const right = small[y * W + x + 1]!;
      if (left > right) hash |= 1n << BigInt(63 - bit);
      bit++;
    }
  }

  // Postgres bigint is signed. Reinterpreting rather than clamping keeps all
  // 64 bits, and the XOR-and-popcount distance in 008 works on the bit pattern
  // regardless of sign.
  return BigInt.asIntN(64, hash);
}

/**
 * Average every source pixel that falls in each destination cell.
 *
 * Nearest-neighbour sampling would be faster and would make the hash sensitive
 * to exactly the thing it must ignore — a one-pixel shift from a slightly
 * different camera angle. Averaging is what makes the result stable across two
 * photos of the same sheet of paper.
 */
function boxDownsampleToGrey(
  img: { width: number; height: number; data: Uint8Array },
  outW: number,
  outH: number
): Float64Array {
  const out = new Float64Array(outW * outH);
  const counts = new Uint32Array(outW * outH);

  for (let y = 0; y < img.height; y++) {
    const ty = Math.min(outH - 1, Math.floor((y * outH) / img.height));
    for (let x = 0; x < img.width; x++) {
      const tx = Math.min(outW - 1, Math.floor((x * outW) / img.width));
      const i = (y * img.width + x) * 4;

      // Rec. 601 luma. Scale tickets are near-monochrome anyway, but weighting
      // properly keeps a red carbon copy from reading as near-black.
      const grey =
        0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;

      const t = ty * outW + tx;
      out[t] += grey;
      counts[t]++;
    }
  }

  for (let i = 0; i < out.length; i++) {
    if (counts[i]! > 0) out[i] = out[i]! / counts[i]!;
  }
  return out;
}
