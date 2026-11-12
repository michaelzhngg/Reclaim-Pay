"""Image forensics: looks for a region pasted into a receipt photo, such as a typed-over total.

Two checks on a grid of 16 px blocks, Pillow and numpy only:

- Error level analysis (JPEG only). The image is saved again at a fixed quality and compared with itself.
  Content that went through the same compression as the rest of the photo changes by about the same amount
  for the same amount of detail; a pasted region often changes much more. Each block's error is divided by its
  own edge energy, so text-heavy areas don't stand out just for being text.
- Noise level. A camera photo has sensor noise everywhere. Digits typed or pasted from a clean source have
  almost none, so blocks far quieter than the rest of the paper stand out.

Only compact clusters of outlier blocks count; scattered single blocks are normal. This check has false
positives (heavy filters, screenshots stitched by apps), so a finding is evidence for HR, never a verdict.
Every failure returns None: forensics must never break an upload.
"""

from __future__ import annotations

import io
import logging
import time
from typing import Any

import numpy as np
from PIL import Image, ImageOps

from engine.risk.types import RiskSignal, Severity, SignalCode, make_signal

logger = logging.getLogger(__name__)

BLOCK = 16
MIN_SIDE = 256
# Longest side the noise check works at; ELA runs on the original pixels (resampling erases JPEG traces).
NOISE_MAX_SIDE = 1400
ELA_MAX_PIXELS = 2_500_000
# Bigger images are skipped: decoding them can take hundreds of MB, and no phone receipt needs it.
MAX_PIXELS = 50_000_000
ELA_QUALITY = 90

# Robust z-score (median / MAD over the image's own blocks) an ELA block must pass to be an outlier.
# Strict on purpose: on the demo receipts, their resized and re-saved copies, and the test fixtures, ELA
# never fires (the noise check does the catching). It stays as a second opinion for coarse JPEG pastes.
ELA_Z = 8.0
ELA_MAD_FLOOR = 0.02
ELA_MIN_LEVEL = 1.5
# Noise check: a pixel within this many grey levels of its neighbours' mean counts as noise-free. A block is an
# outlier when at least FLAT_MIN of its pixels are, and FLAT_MARGIN more than the image's median block.
# Honest demo photos peak at 0.71; typed-over regions reach 0.85 to 1.0.
FLAT_RESIDUAL = 1.0
FLAT_MIN = 0.82
FLAT_MARGIN = 0.4
# A cluster needs this many outlier blocks touching each other, and may cover at most this share of the image.
MIN_CLUSTER = 4
MAX_CLUSTER_SHARE = 0.08
VERSION = 1


def _robust_z(values: np.ndarray, mask: np.ndarray, floor: float) -> np.ndarray:
    sample = values[mask]
    if sample.size < 20:
        return np.zeros_like(values)
    med = float(np.median(sample))
    mad = float(np.median(np.abs(sample - med))) * 1.4826
    # The floor keeps a near-uniform image (MAD close to 0) from turning rounding noise into huge z-scores.
    mad = max(mad, floor, 0.05 * abs(med))
    return (values - med) / mad


def _block_mean(arr: np.ndarray, size: int = BLOCK) -> np.ndarray:
    h, w = arr.shape[0] // size * size, arr.shape[1] // size * size
    return arr[:h, :w].reshape(h // size, size, w // size, size).mean(axis=(1, 3), dtype=np.float32)


def _clusters(mask: np.ndarray) -> list[list[tuple[int, int]]]:
    """4-connected groups of True cells (8-connected would join diagonal noise)."""
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    rows, cols = mask.shape
    for r0, c0 in zip(*np.nonzero(mask)):
        if seen[r0, c0]:
            continue
        stack, group = [(r0, c0)], []
        seen[r0, c0] = True
        while stack:
            r, c = stack.pop()
            group.append((int(r), int(c)))
            for nr, nc in ((r + 1, c), (r - 1, c), (r, c + 1), (r, c - 1)):
                if 0 <= nr < rows and 0 <= nc < cols and mask[nr, nc] and not seen[nr, nc]:
                    seen[nr, nc] = True
                    stack.append((nr, nc))
        out.append(group)
    return out


def _ela_z(img: Image.Image) -> tuple[np.ndarray, np.ndarray] | None:
    """Per-block z-score of error level per unit of edge energy, and the mask of blocks it is valid on.

    A block also has to be at least twice the median ratio and change by at least ELA_MIN_LEVEL grey levels
    on average, so an image the re-save barely touches can't produce outliers from rounding.
    """
    rgb = img.convert("RGB")
    buf = io.BytesIO()
    rgb.save(buf, "JPEG", quality=ELA_QUALITY)
    buf.seek(0)
    with Image.open(buf) as resaved:
        again = np.asarray(resaved.convert("RGB"), dtype=np.int16)
    orig = np.asarray(rgb, dtype=np.int16)
    diff = np.abs(orig - again).max(axis=2).astype(np.float32)

    gray = np.asarray(rgb.convert("L"), dtype=np.float32)
    gx = np.abs(np.diff(gray, axis=1, append=gray[:, -1:]))
    gy = np.abs(np.diff(gray, axis=0, append=gray[-1:, :]))
    edges = gx + gy

    ela = _block_mean(diff)
    energy = _block_mean(edges)
    level = _block_mean(gray)
    ratio = ela / (energy + 2.0)
    valid = (level > 12) & (level < 243)
    z = _robust_z(ratio, valid, ELA_MAD_FLOOR)
    if valid.any():
        strong = (ratio >= 2 * float(np.median(ratio[valid]))) & (ela >= ELA_MIN_LEVEL)
        z = np.where(strong, z, np.minimum(z, 0.0))
    return z, valid


def _flatness(img: Image.Image) -> tuple[np.ndarray, np.ndarray]:
    """Per-block share of noise-free pixels, and the mask of blocks it is valid on.

    A pixel is noise-free when it barely differs from the mean of its four neighbours. Camera noise keeps that
    share low across a photo; clean pasted or typed content pushes it towards 1.
    """
    gray = img.convert("L")
    if max(gray.size) > NOISE_MAX_SIDE:
        scale = NOISE_MAX_SIDE / max(gray.size)
        gray = gray.resize((max(1, round(gray.width * scale)), max(1, round(gray.height * scale))), Image.BILINEAR)
    arr = np.asarray(gray, dtype=np.float32)
    pad = np.pad(arr, 1, mode="edge")
    resid = np.abs(arr - (pad[:-2, 1:-1] + pad[2:, 1:-1] + pad[1:-1, :-2] + pad[1:-1, 2:]) / 4)
    flat = _block_mean((resid < FLAT_RESIDUAL).astype(np.float32))
    # Clipped highlights and shadows are flat in every photo.
    clipped = _block_mean(((arr >= 250) | (arr <= 5)).astype(np.float32))
    return flat, clipped < 0.2


def _best_cluster(outliers: np.ndarray, z: np.ndarray, total_blocks: int) -> tuple[list[tuple[int, int]], float] | None:
    best = None
    for group in _clusters(outliers):
        if len(group) < MIN_CLUSTER or len(group) > MAX_CLUSTER_SHARE * total_blocks:
            continue
        strength = float(np.mean([abs(z[r, c]) for r, c in group]))
        if best is None or strength * len(group) > best[1] * len(best[0]):
            best = (group, strength)
    return best


def _box(group: list[tuple[int, int]], grid: tuple[int, int]) -> dict[str, float]:
    rows = [r for r, _ in group]
    cols = [c for _, c in group]
    gh, gw = grid
    return {
        "x": round(min(cols) / gw, 3),
        "y": round(min(rows) / gh, 3),
        "w": round((max(cols) - min(cols) + 1) / gw, 3),
        "h": round((max(rows) - min(rows) + 1) / gh, 3),
    }


def _score(strength: float, threshold: float, blocks: int) -> int:
    """0-100 for HR: 50 at the threshold, rising with how far past it the cluster sits and how many blocks it has."""
    over = max(0.0, strength / threshold - 1.0)
    return int(min(100, 50 + over * 100 + min(blocks, 20)))


def analyze_image(path: str) -> dict[str, Any] | None:
    """The forensics result for an image file, or None when it doesn't apply or fails.

    Result: {"flagged", "score", "regions": [{x, y, w, h, method}], "reason", "checks", "ms", "version"}.
    Box coordinates are fractions of the image width and height.
    """
    started = time.perf_counter()
    try:
        with Image.open(path) as img:
            fmt = (img.format or "").upper()
            if fmt not in ("JPEG", "PNG", "WEBP"):
                return None
            if min(img.size) < MIN_SIDE or img.width * img.height > MAX_PIXELS:
                return None
            img.load()
            # Phone photos are often stored sideways with an EXIF Orientation tag. Turn them upright first,
            # so "where on the image" matches what HR sees (fingerprint.py does the same).
            img = ImageOps.exif_transpose(img)
            checks: dict[str, Any] = {}
            candidates = []

            # ELA means nothing without a JPEG history.
            if fmt == "JPEG" and img.width * img.height <= ELA_MAX_PIXELS:
                ela = _ela_z(img)
                if ela is not None:
                    z, valid = ela
                    outliers = valid & (z > ELA_Z)
                    found = _best_cluster(outliers, z, z.size)
                    checks["ela"] = {"max_z": round(float(z[valid].max()) if valid.any() else 0.0, 1)}
                    if found:
                        group, strength = found
                        candidates.append(("ela", group, strength, _score(strength, ELA_Z, len(group)), z.shape))
            else:
                checks["ela"] = "skipped"

            flat, valid = _flatness(img)
            if valid.sum() >= 20:
                median = float(np.median(flat[valid]))
                outliers = valid & (flat >= FLAT_MIN) & (flat - median >= FLAT_MARGIN)
                found = _best_cluster(outliers, flat, flat.size)
                checks["noise"] = {"median_flat": round(median, 2), "max_flat": round(float(flat[valid].max()), 2)}
                if found:
                    group, strength = found
                    candidates.append(("noise", group, strength, _score(strength, FLAT_MIN, len(group)), flat.shape))
    except Exception:
        logger.warning("[FORENSICS] Could not analyse %s", path, exc_info=True)
        return None

    score = max((c[3] for c in candidates), default=0)
    regions = [{**_box(group, grid), "method": method} for method, group, _, _, grid in candidates]
    flagged = bool(regions)
    methods = sorted({r["method"] for r in regions})
    reason = None
    if flagged:
        what = {
            "ela": "compresses differently from the rest of the photo",
            "noise": "has much less camera noise than the paper around it",
        }
        reason = "One area of the image " + " and ".join(what[m] for m in methods) + ", which can mean it was pasted in."
    return {
        "flagged": flagged,
        "score": score,
        "regions": regions,
        "reason": reason,
        "checks": checks,
        "ms": round((time.perf_counter() - started) * 1000),
        "version": VERSION,
    }


def forensics_signal(finding: dict | None, document_id: str | None, mode: str) -> RiskSignal | None:
    """The stored finding as a signal, or None when nothing was flagged or the mode is off.

    `observe`: zero points, LOW severity, kept out of decide() by the caller. `score`: MEDIUM at most, never HIGH.
    """
    if mode not in ("observe", "score") or not isinstance(finding, dict) or not finding.get("flagged"):
        return None
    evidence = {
        "regions": finding.get("regions") or [],
        "score": finding.get("score"),
        "scored": mode == "score",
    }
    if finding.get("reason"):
        evidence["reason"] = finding["reason"]
    message = "Image check: possible edited region. " + (finding.get("reason") or "")
    if mode == "score":
        return make_signal(SignalCode.IMAGE_FORENSICS, Severity.MEDIUM, message.strip(), evidence, document_id)
    signal = make_signal(SignalCode.IMAGE_FORENSICS, Severity.LOW, message.strip(), evidence, document_id)
    return signal.model_copy(update={"points": 0})
