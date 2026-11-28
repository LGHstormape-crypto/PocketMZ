#ifndef PMZRT_GIF_H
#define PMZRT_GIF_H

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define PMZ_GIF_MAX_FRAMES 256
#define PMZ_GIF_MAX_BYTES (128u * 1024u * 1024u)

typedef struct {
  uint8_t *rgba;
  int delay_ms;
} pmz_gif_frame_t;

typedef struct {
  int width;
  int height;
  int frame_count;
  pmz_gif_frame_t *frames;
} pmz_gif_result_t;

static void pmz_gif_free(pmz_gif_result_t *res) {
  if (!res) return;
  if (res->frames) {
    for (int i = 0; i < res->frame_count; i++) free(res->frames[i].rgba);
    free(res->frames);
    res->frames = NULL;
  }
  res->frame_count = 0;
}

static int pmz_gif_lzw_decode(const uint8_t *src, size_t len, size_t *pos_io,
                              int min_code_size, uint8_t *out, size_t out_len) {
  size_t pos = *pos_io;
  if (min_code_size < 2 || min_code_size > 8) return 0;

  uint16_t prefix[4096];
  uint8_t suffix[4096];
  uint8_t stack[4096];

  int clear_code = 1 << min_code_size;
  int eoi_code = clear_code + 1;
  int code_size = min_code_size + 1;
  int next_code = eoi_code + 1;
  int max_code = (1 << code_size) - 1;
  int old_code = -1;
  uint8_t first_char = 0;

  for (int i = 0; i < clear_code; i++) {
    prefix[i] = 0;
    suffix[i] = (uint8_t)i;
  }

  uint32_t bitbuf = 0;
  int bitcnt = 0;
  int sub_rem = 0;
  size_t out_pos = 0;
  int done = 0;

  while (!done) {
    while (bitcnt < code_size) {
      if (sub_rem == 0) {
        if (pos >= len) { done = 1; break; }
        sub_rem = src[pos++];
        if (sub_rem == 0) { done = 1; break; }
      }
      if (pos >= len) { done = 1; break; }
      bitbuf |= ((uint32_t)src[pos++]) << bitcnt;
      bitcnt += 8;
      sub_rem--;
    }
    if (bitcnt < code_size) break;

    int code = (int)(bitbuf & ((1u << code_size) - 1u));
    bitbuf >>= code_size;
    bitcnt -= code_size;

    if (code == clear_code) {
      code_size = min_code_size + 1;
      next_code = eoi_code + 1;
      max_code = (1 << code_size) - 1;
      old_code = -1;
      continue;
    }
    if (code == eoi_code) {
      break;
    }

    int in_code = code;
    int sp = 0;
    if (old_code == -1) {
      if (code >= clear_code) return 0;
      if (out_pos < out_len) out[out_pos++] = (uint8_t)code;
      old_code = code;
      first_char = (uint8_t)code;
      continue;
    }

    if (code >= next_code) {
      if (code > next_code || next_code >= 4096) return 0;
      stack[sp++] = first_char;
      code = old_code;
    }

    while (code >= clear_code) {
      if (sp >= 4096 || code >= 4096) return 0;
      stack[sp++] = suffix[code];
      code = prefix[code];
    }
    first_char = (uint8_t)code;
    if (sp < 4096) stack[sp++] = first_char;

    while (sp > 0) {
      uint8_t ch = stack[--sp];
      if (out_pos < out_len) out[out_pos++] = ch;
    }

    if (next_code < 4096) {
      prefix[next_code] = (uint16_t)old_code;
      suffix[next_code] = first_char;
      next_code++;
      if (next_code > max_code && code_size < 12) {
        code_size++;
        max_code = (1 << code_size) - 1;
      }
    }
    old_code = in_code;
  }

  /* Skip remaining sub-blocks */
  while (sub_rem > 0) {
    size_t skip = (size_t)sub_rem;
    if (pos + skip > len) { pos = len; break; }
    pos += skip;
    sub_rem = 0;
    if (pos < len) {
      sub_rem = src[pos++];
      if (sub_rem == 0) break;
    }
  }
  while (pos < len) {
    uint8_t sz = src[pos++];
    if (sz == 0) break;
    if (pos + sz > len) { pos = len; break; }
    pos += sz;
  }

  *pos_io = pos;
  return 1;
}

static int pmz_gif_decode(const uint8_t *data, size_t len, pmz_gif_result_t *out) {
  memset(out, 0, sizeof(*out));
  if (!data || len < 14) return 0;
  if (memcmp(data, "GIF87a", 6) != 0 && memcmp(data, "GIF89a", 6) != 0) return 0;

  int cw = (int)(data[6] | (data[7] << 8));
  int ch = (int)(data[8] | (data[9] << 8));
  if (cw <= 0 || ch <= 0 || cw > 8192 || ch > 8192) return 0;

  size_t frame_bytes = (size_t)cw * (size_t)ch * 4u;
  if (frame_bytes > PMZ_GIF_MAX_BYTES) return 0;

  uint8_t gct_packed = data[10];
  int has_gct = (gct_packed & 0x80) != 0;
  int gct_size = has_gct ? (1 << ((gct_packed & 0x07) + 1)) : 0;
  size_t pos = 13;

  const uint8_t *gct = NULL;
  if (has_gct) {
    if (pos + (size_t)gct_size * 3u > len) return 0;
    gct = data + pos;
    pos += (size_t)gct_size * 3u;
  }

  uint8_t *canvas = (uint8_t *)calloc(1, frame_bytes);
  uint8_t *prev_canvas = (uint8_t *)calloc(1, frame_bytes);
  if (!canvas || !prev_canvas) {
    free(canvas);
    free(prev_canvas);
    return 0;
  }

  int cap = 8;
  out->frames = (pmz_gif_frame_t *)calloc((size_t)cap, sizeof(pmz_gif_frame_t));
  if (!out->frames) {
    free(canvas);
    free(prev_canvas);
    return 0;
  }
  out->width = cw;
  out->height = ch;

  int gce_delay_cs = 0;
  int gce_disposal = 0;
  int gce_has_trans = 0;
  int gce_trans_idx = 0;
  size_t total_bytes = 0;

  while (pos < len) {
    uint8_t block = data[pos++];
    if (block == 0x3B) {
      break;
    } else if (block == 0x21) {
      if (pos >= len) break;
      uint8_t label = data[pos++];
      if (label == 0xF9) {
        if (pos >= len) break;
        uint8_t bsz = data[pos++];
        if (bsz == 4 && pos + 4 <= len) {
          uint8_t flags = data[pos];
          gce_disposal = (flags >> 2) & 0x07;
          gce_has_trans = (flags & 0x01) != 0;
          gce_delay_cs = (int)(data[pos + 1] | (data[pos + 2] << 8));
          gce_trans_idx = data[pos + 3];
        }
        pos += bsz;
        while (pos < len) {
          uint8_t sz = data[pos++];
          if (sz == 0) break;
          if (pos + sz > len) { pos = len; break; }
          pos += sz;
        }
      } else {
        while (pos < len) {
          uint8_t sz = data[pos++];
          if (sz == 0) break;
          if (pos + sz > len) { pos = len; break; }
          pos += sz;
        }
      }
    } else if (block == 0x2C) {
      if (pos + 10 > len) break;
      int fx = (int)(data[pos] | (data[pos + 1] << 8));
      int fy = (int)(data[pos + 2] | (data[pos + 3] << 8));
      int fw = (int)(data[pos + 4] | (data[pos + 5] << 8));
      int fh = (int)(data[pos + 6] | (data[pos + 7] << 8));
      uint8_t ipacked = data[pos + 8];
      pos += 9;

      int has_lct = (ipacked & 0x80) != 0;
      int interlaced = (ipacked & 0x40) != 0;
      int lct_size = has_lct ? (1 << ((ipacked & 0x07) + 1)) : 0;

      const uint8_t *ct = gct;
      int ct_size = gct_size;
      if (has_lct) {
        if (pos + (size_t)lct_size * 3u > len) break;
        ct = data + pos;
        ct_size = lct_size;
        pos += (size_t)lct_size * 3u;
      }

      if (pos >= len) break;
      int min_code_size = data[pos++];

      if (fw <= 0 || fh <= 0 || out->frame_count >= PMZ_GIF_MAX_FRAMES ||
          total_bytes + frame_bytes > PMZ_GIF_MAX_BYTES) {
        /* Skip LZW blocks and stop */
        while (pos < len) {
          uint8_t sz = data[pos++];
          if (sz == 0) break;
          if (pos + sz > len) { pos = len; break; }
          pos += sz;
        }
        break;
      }

      size_t idx_len = (size_t)fw * (size_t)fh;
      uint8_t *indices = (uint8_t *)calloc(1, idx_len);
      if (!indices) break;

      if (!pmz_gif_lzw_decode(data, len, &pos, min_code_size, indices, idx_len)) {
        free(indices);
        break;
      }

      if (gce_disposal == 3) {
        memcpy(prev_canvas, canvas, frame_bytes);
      }

      static const int il_start[4] = {0, 4, 2, 1};
      static const int il_step[4]  = {8, 8, 4, 2};

      size_t src_row = 0;
      if (!interlaced) {
        for (int y = 0; y < fh; y++) {
          int cy = fy + y;
          if (cy >= 0 && cy < ch) {
            for (int x = 0; x < fw; x++) {
              int cx = fx + x;
              if (cx < 0 || cx >= cw) continue;
              uint8_t idx = indices[(size_t)y * (size_t)fw + (size_t)x];
              if (gce_has_trans && idx == gce_trans_idx) continue;
              if (!ct || idx >= ct_size) continue;
              uint8_t *dst = canvas + ((size_t)cy * (size_t)cw + (size_t)cx) * 4u;
              dst[0] = ct[idx * 3 + 0];
              dst[1] = ct[idx * 3 + 1];
              dst[2] = ct[idx * 3 + 2];
              dst[3] = 255;
            }
          }
        }
      } else {
        for (int pass = 0; pass < 4; pass++) {
          for (int y = il_start[pass]; y < fh; y += il_step[pass]) {
            int cy = fy + y;
            if (cy >= 0 && cy < ch && src_row < (size_t)fh) {
              for (int x = 0; x < fw; x++) {
                int cx = fx + x;
                if (cx < 0 || cx >= cw) continue;
                uint8_t idx = indices[src_row * (size_t)fw + (size_t)x];
                if (gce_has_trans && idx == gce_trans_idx) continue;
                if (!ct || idx >= ct_size) continue;
                uint8_t *dst = canvas + ((size_t)cy * (size_t)cw + (size_t)cx) * 4u;
                dst[0] = ct[idx * 3 + 0];
                dst[1] = ct[idx * 3 + 1];
                dst[2] = ct[idx * 3 + 2];
                dst[3] = 255;
              }
            }
            src_row++;
          }
        }
      }
      free(indices);

      uint8_t *snap = (uint8_t *)malloc(frame_bytes);
      if (!snap) break;
      memcpy(snap, canvas, frame_bytes);

      if (out->frame_count >= cap) {
        cap *= 2;
        pmz_gif_frame_t *nf = (pmz_gif_frame_t *)realloc(out->frames, (size_t)cap * sizeof(pmz_gif_frame_t));
        if (!nf) { free(snap); break; }
        out->frames = nf;
      }
      int dms = gce_delay_cs > 0 ? gce_delay_cs * 10 : 100;
      out->frames[out->frame_count].rgba = snap;
      out->frames[out->frame_count].delay_ms = dms;
      out->frame_count++;
      total_bytes += frame_bytes;

      /* Apply disposal for next frame */
      if (gce_disposal == 2) {
        for (int y = 0; y < fh; y++) {
          int cy = fy + y;
          if (cy < 0 || cy >= ch) continue;
          for (int x = 0; x < fw; x++) {
            int cx = fx + x;
            if (cx < 0 || cx >= cw) continue;
            uint8_t *dst = canvas + ((size_t)cy * (size_t)cw + (size_t)cx) * 4u;
            dst[0] = dst[1] = dst[2] = dst[3] = 0;
          }
        }
      } else if (gce_disposal == 3) {
        memcpy(canvas, prev_canvas, frame_bytes);
      }

      gce_delay_cs = 0;
      gce_disposal = 0;
      gce_has_trans = 0;
      gce_trans_idx = 0;
    } else {
      break;
    }
  }

  free(canvas);
  free(prev_canvas);

  if (out->frame_count == 0) {
    pmz_gif_free(out);
    return 0;
  }
  return 1;
}

#endif
