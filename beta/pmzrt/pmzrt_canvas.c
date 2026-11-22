// pmzrt_canvas.c - Canvas 2D on Cairo (image surfaces, premultiplied ARGB32) + Pango/fontconfig text.
// Included by pmzrt.c (after the DEF macros): every DEF here becomes a pmz.cvXxx export. See canvas2d.js for the JS side.
// A canvas / decoded image is one Cv (external object with a finalizer). Images have a surface only (cr == NULL).
#define PANGO_ENABLE_BACKEND 1
#include <cairo.h>
#include <pango/pangocairo.h>
#include <pango/pangofc-fontmap.h>
#include <fontconfig/fontconfig.h>
#include <fontconfig/fcfreetype.h>
#include <ctype.h>
#include <time.h>
#include <strings.h>

// ---------------------------------------------------------------------------------------------------
// CSS colours
// ---------------------------------------------------------------------------------------------------
static const struct { const char *n; uint32_t v; } g_named[] = {
  {"aliceblue",0xf0f8ff},{"antiquewhite",0xfaebd7},{"aqua",0x00ffff},{"aquamarine",0x7fffd4},{"azure",0xf0ffff},{"beige",0xf5f5dc},
  {"bisque",0xffe4c4},{"black",0x000000},{"blanchedalmond",0xffebcd},{"blue",0x0000ff},{"blueviolet",0x8a2be2},{"brown",0xa52a2a},
  {"burlywood",0xdeb887},{"cadetblue",0x5f9ea0},{"chartreuse",0x7fff00},{"chocolate",0xd2691e},{"coral",0xff7f50},{"cornflowerblue",0x6495ed},
  {"cornsilk",0xfff8dc},{"crimson",0xdc143c},{"cyan",0x00ffff},{"darkblue",0x00008b},{"darkcyan",0x008b8b},{"darkgoldenrod",0xb8860b},
  {"darkgray",0xa9a9a9},{"darkgreen",0x006400},{"darkgrey",0xa9a9a9},{"darkkhaki",0xbdb76b},{"darkmagenta",0x8b008b},{"darkolivegreen",0x556b2f},
  {"darkorange",0xff8c00},{"darkorchid",0x9932cc},{"darkred",0x8b0000},{"darksalmon",0xe9967a},{"darkseagreen",0x8fbc8f},{"darkslateblue",0x483d8b},
  {"darkslategray",0x2f4f4f},{"darkslategrey",0x2f4f4f},{"darkturquoise",0x00ced1},{"darkviolet",0x9400d3},{"deeppink",0xff1493},{"deepskyblue",0x00bfff},
  {"dimgray",0x696969},{"dimgrey",0x696969},{"dodgerblue",0x1e90ff},{"firebrick",0xb22222},{"floralwhite",0xfffaf0},{"forestgreen",0x228b22},
  {"fuchsia",0xff00ff},{"gainsboro",0xdcdcdc},{"ghostwhite",0xf8f8ff},{"gold",0xffd700},{"goldenrod",0xdaa520},{"gray",0x808080},
  {"green",0x008000},{"greenyellow",0xadff2f},{"grey",0x808080},{"honeydew",0xf0fff0},{"hotpink",0xff69b4},{"indianred",0xcd5c5c},
  {"indigo",0x4b0082},{"ivory",0xfffff0},{"khaki",0xf0e68c},{"lavender",0xe6e6fa},{"lavenderblush",0xfff0f5},{"lawngreen",0x7cfc00},
  {"lemonchiffon",0xfffacd},{"lightblue",0xadd8e6},{"lightcoral",0xf08080},{"lightcyan",0xe0ffff},{"lightgoldenrodyellow",0xfafad2},{"lightgray",0xd3d3d3},
  {"lightgreen",0x90ee90},{"lightgrey",0xd3d3d3},{"lightpink",0xffb6c1},{"lightsalmon",0xffa07a},{"lightseagreen",0x20b2aa},{"lightskyblue",0x87cefa},
  {"lightslategray",0x778899},{"lightslategrey",0x778899},{"lightsteelblue",0xb0c4de},{"lightyellow",0xffffe0},{"lime",0x00ff00},{"limegreen",0x32cd32},
  {"linen",0xfaf0e6},{"magenta",0xff00ff},{"maroon",0x800000},{"mediumaquamarine",0x66cdaa},{"mediumblue",0x0000cd},{"mediumorchid",0xba55d3},
  {"mediumpurple",0x9370db},{"mediumseagreen",0x3cb371},{"mediumslateblue",0x7b68ee},{"mediumspringgreen",0x00fa9a},{"mediumturquoise",0x48d1cc},{"mediumvioletred",0xc71585},
  {"midnightblue",0x191970},{"mintcream",0xf5fffa},{"mistyrose",0xffe4e1},{"moccasin",0xffe4b5},{"navajowhite",0xffdead},{"navy",0x000080},
  {"oldlace",0xfdf5e6},{"olive",0x808000},{"olivedrab",0x6b8e23},{"orange",0xffa500},{"orangered",0xff4500},{"orchid",0xda70d6},
  {"palegoldenrod",0xeee8aa},{"palegreen",0x98fb98},{"paleturquoise",0xafeeee},{"palevioletred",0xdb7093},{"papayawhip",0xffefd5},{"peachpuff",0xffdab9},
  {"peru",0xcd853f},{"pink",0xffc0cb},{"plum",0xdda0dd},{"powderblue",0xb0e0e6},{"purple",0x800080},{"rebeccapurple",0x663399},
  {"red",0xff0000},{"rosybrown",0xbc8f8f},{"royalblue",0x4169e1},{"saddlebrown",0x8b4513},{"salmon",0xfa8072},{"sandybrown",0xf4a460},
  {"seagreen",0x2e8b57},{"seashell",0xfff5ee},{"sienna",0xa0522d},{"silver",0xc0c0c0},{"skyblue",0x87ceeb},{"slateblue",0x6a5acd},
  {"slategray",0x708090},{"slategrey",0x708090},{"snow",0xfffafa},{"springgreen",0x00ff7f},{"steelblue",0x4682b4},{"tan",0xd2b48c},
  {"teal",0x008080},{"thistle",0xd8bfd8},{"tomato",0xff6347},{"turquoise",0x40e0d0},{"violet",0xee82ee},{"wheat",0xf5deb3},
  {"white",0xffffff},{"whitesmoke",0xf5f5f5},{"yellow",0xffff00},{"yellowgreen",0x9acd32},
};
static int hexv(int c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; }
static double clamp01(double v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
static void hsl2rgb(double h, double s, double l, double *r, double *g, double *b) {
  h = fmod(h, 360.0); if (h < 0) h += 360.0; h /= 60.0;
  double c = (1 - fabs(2 * l - 1)) * s, x = c * (1 - fabs(fmod(h, 2.0) - 1)), m = l - c / 2, R = 0, G = 0, B = 0;
  if (h < 1) { R = c; G = x; } else if (h < 2) { R = x; G = c; } else if (h < 3) { G = c; B = x; }
  else if (h < 4) { G = x; B = c; } else if (h < 5) { R = x; B = c; } else { R = c; B = x; }
  *r = R + m; *g = G + m; *b = B + m;
}
// functional notation: rgb()/rgba()/hsl()/hsla(); args separated by commas, spaces or '/'
static int parse_func_args(const char *p, double *v, int *pct, int max) {
  int n = 0;
  while (*p && n < max) {
    while (*p == ' ' || *p == ',' || *p == '/' || *p == '\t') p++;
    if (*p == ')' || !*p) break;
    char *e; double d = strtod(p, &e); if (e == p) return -1;
    v[n] = d; pct[n] = 0;
    if (*e == '%') { pct[n] = 1; e++; } else if (!strncasecmp(e, "deg", 3)) e += 3;
    n++; p = e;
  }
  return n;
}
static int parse_color(const char *s, double *o) {   // o = r,g,b,a in 0..1 (non-premultiplied); returns 1 on success
  while (*s == ' ' || *s == '\t' || *s == '\n') s++;
  size_t n = strlen(s); while (n && (s[n - 1] == ' ' || s[n - 1] == '\t' || s[n - 1] == '\n')) n--;
  if (!n || n > 63) return 0;
  char b[64]; for (size_t i = 0; i < n; i++) b[i] = (char)tolower((unsigned char)s[i]); b[n] = 0;
  if (b[0] == '#') {
    int d[8]; size_t k = n - 1; if (k != 3 && k != 4 && k != 6 && k != 8) return 0;
    for (size_t i = 0; i < k; i++) { d[i] = hexv(b[i + 1]); if (d[i] < 0) return 0; }
    if (k <= 4) { o[0] = d[0] * 17 / 255.0; o[1] = d[1] * 17 / 255.0; o[2] = d[2] * 17 / 255.0; o[3] = k == 4 ? d[3] * 17 / 255.0 : 1; }
    else { o[0] = (d[0] * 16 + d[1]) / 255.0; o[1] = (d[2] * 16 + d[3]) / 255.0; o[2] = (d[4] * 16 + d[5]) / 255.0; o[3] = k == 8 ? (d[6] * 16 + d[7]) / 255.0 : 1; }
    return 1;
  }
  int rgb = !strncmp(b, "rgb", 3), hsl = !strncmp(b, "hsl", 3);
  if (rgb || hsl) {
    const char *p = strchr(b, '('); if (!p) return 0;
    double v[4]; int pct[4]; int k = parse_func_args(p + 1, v, pct, 4); if (k < 3) return 0;
    double a = k >= 4 ? (pct[3] ? v[3] / 100 : v[3]) : 1;
    if (rgb) for (int i = 0; i < 3; i++) o[i] = clamp01((pct[i] ? v[i] / 100 : v[i] / 255));
    else hsl2rgb(v[0], clamp01(v[1] / 100), clamp01(v[2] / 100), &o[0], &o[1], &o[2]);
    o[3] = clamp01(a); return 1;
  }
  if (!strcmp(b, "transparent")) { o[0] = o[1] = o[2] = o[3] = 0; return 1; }
  if (!strcmp(b, "currentcolor")) { o[0] = o[1] = o[2] = 0; o[3] = 1; return 1; }
  int lo = 0, hi = (int)(sizeof g_named / sizeof g_named[0]) - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2, c = strcmp(b, g_named[mid].n);
    if (!c) { uint32_t v = g_named[mid].v; o[0] = ((v >> 16) & 255) / 255.0; o[1] = ((v >> 8) & 255) / 255.0; o[2] = (v & 255) / 255.0; o[3] = 1; return 1; }
    if (c < 0) hi = mid - 1; else lo = mid + 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------------------------------
typedef struct { double rgba[4]; cairo_pattern_t *pat; } Paint;
#define MAXDASH 16
typedef struct {
  Paint fill, stroke;
  double alpha; cairo_operator_t op;
  double lw, miter; cairo_line_join_t join; cairo_line_cap_t cap;
  double dash[MAXDASH]; int ndash; double dashOff;
  int smooth;
  double shColor[4], shBlur, shX, shY;
  double blur;
  PangoFontDescription *fd; char fontStr[160];
  int align, baseline;   // align: 0 start/left, 1 end/right, 2 center; baseline: 0 alphabetic 1 top 2 hanging 3 middle 4 ideographic 5 bottom
} State;
typedef struct Cv {
  cairo_surface_t *surf; cairo_t *cr; int w, h; int64_t mem;
  State st; State *stack; int sp, scap;
  PangoLayout *layout; PangoFontDescription *lfd;      // layout + the font description currently set on it
  char *ltext; cairo_matrix_t lmat; int lmatOk;        // text / ctm the layout currently holds (shaping is skipped when unchanged)
  PangoLayout *mlayout; PangoFontDescription *mlfd; char *mltext;   // second layout, hint metrics OFF: measureText gives Chromium-like fractional widths
  PangoFontDescription *mfd; double masc, mdesc;       // cached font metrics for mfd
  cairo_path_t *saved;
} Cv;

static cairo_font_options_t *g_fo, *g_fo_m;   // g_fo_m: same as g_fo but hint metrics off (measureText)
static int g_measure_frac = 1;                // PMZ_MEASURE=hinted: measureText uses the drawing layout (integer advances)
static unsigned g_fontEpoch;
static PangoLanguage *g_lang;

static void paint_free(Paint *p) { if (p->pat) { cairo_pattern_destroy(p->pat); p->pat = NULL; } }
static void paint_copy(Paint *d, const Paint *s) { *d = *s; if (d->pat) cairo_pattern_reference(d->pat); }
static void state_free(State *s) { paint_free(&s->fill); paint_free(&s->stroke); if (s->fd) { pango_font_description_free(s->fd); s->fd = NULL; } }
static void state_copy(State *d, const State *s) { *d = *s; paint_copy(&d->fill, &s->fill); paint_copy(&d->stroke, &s->stroke); if (s->fd) d->fd = pango_font_description_copy(s->fd); }

// ---- font registry: CSS family name given to FontFace -> real family inside the font file ----
typedef struct { char css[96]; char real[160]; } FontMap;
static FontMap g_fonts[64]; static int g_nfonts;

static void split_trim(const char *s, size_t n, char *out, size_t outsz) {   // trim spaces + one level of quotes
  while (n && isspace((unsigned char)*s)) { s++; n--; }
  while (n && isspace((unsigned char)s[n - 1])) n--;
  if (n >= 2 && (s[0] == '"' || s[0] == '\'') && s[n - 1] == s[0]) { s++; n -= 2; }
  if (n >= outsz) n = outsz - 1; memcpy(out, s, n); out[n] = 0;
}
// "A", 'B C', sans-serif -> pango family list "RealA,B C,sans-serif"
static void build_family(const char *list, char *out, size_t outsz) {
  out[0] = 0; size_t used = 0; const char *p = list;
  while (*p) {
    const char *e = p; char q = 0;
    while (*e && (q || *e != ',')) { if (*e == '"' || *e == '\'') q = q == *e ? 0 : q ? q : *e; e++; }
    char name[160]; split_trim(p, (size_t)(e - p), name, sizeof name);
    if (name[0]) {
      const char *use = name;
      if (!strcasecmp(name, "system-ui") || !strcasecmp(name, "cursive") || !strcasecmp(name, "fantasy") || !strcasecmp(name, "ui-sans-serif") || !strcasecmp(name, "-apple-system") || !strcasecmp(name, "blinkmacsystemfont")) use = "sans-serif";
      else if (!strcasecmp(name, "ui-monospace")) use = "monospace";
      for (int i = 0; i < g_nfonts; i++) if (!strcasecmp(g_fonts[i].css, name)) { use = g_fonts[i].real; break; }
      size_t l = strlen(use);
      if (used + l + 2 < outsz) { if (used) out[used++] = ','; memcpy(out + used, use, l); used += l; out[used] = 0; }
    }
    p = *e ? e + 1 : e;
  }
  if (!out[0]) snprintf(out, outsz, "sans-serif");
}
// CSS font shorthand -> description. Returns 0 if invalid.
static int parse_font(const char *s, PangoFontDescription **fdout) {
  int italic = 0, weight = 400; double px = 0; const char *p = s;
  for (;;) {
    while (*p && isspace((unsigned char)*p)) p++;
    if (!*p) return 0;
    const char *e = p; while (*e && !isspace((unsigned char)*e)) e++;
    size_t n = (size_t)(e - p); char t[48]; if (n >= sizeof t) { n = sizeof t - 1; } memcpy(t, p, n); t[n] = 0;
    for (size_t i = 0; i < n; i++) t[i] = (char)tolower((unsigned char)t[i]);
    if (!strcmp(t, "italic") || !strcmp(t, "oblique")) italic = 1;
    else if (!strcmp(t, "normal") || !strcmp(t, "small-caps") || !strcmp(t, "ultra-condensed") || !strcmp(t, "extra-condensed") || !strcmp(t, "condensed") || !strcmp(t, "semi-condensed") || !strcmp(t, "semi-expanded") || !strcmp(t, "expanded") || !strcmp(t, "extra-expanded") || !strcmp(t, "ultra-expanded")) {}
    else if (!strcmp(t, "bold")) weight = 700; else if (!strcmp(t, "bolder")) weight = 700; else if (!strcmp(t, "lighter")) weight = 300;
    else if (n == 3 && isdigit((unsigned char)t[0]) && t[1] == '0' && t[2] == '0') weight = (t[0] - '0') * 100;
    else if (isdigit((unsigned char)t[0]) || t[0] == '.') {   // size[/line-height]
      char *u; double v = strtod(t, &u);
      if (!strncmp(u, "px", 2)) px = v; else if (!strncmp(u, "pt", 2)) px = v * 4.0 / 3.0; else if (!strncmp(u, "em", 2) || !strncmp(u, "rem", 3)) px = v * 16;
      else if (*u == '%') px = v * 0.16; else if (!strncmp(u, "pc", 2)) px = v * 16; else if (!strncmp(u, "in", 2)) px = v * 96;
      else if (!strncmp(u, "cm", 2)) px = v * 96 / 2.54; else if (!strncmp(u, "mm", 2)) px = v * 96 / 25.4; else if (!*u || *u == '/') px = v; else return 0;
      p = e; break;
    } else if (!strcmp(t, "medium")) { px = 16; p = e; break; } else if (!strcmp(t, "small")) { px = 13; p = e; break; } else if (!strcmp(t, "large")) { px = 18; p = e; break; }
    else return 0;
    p = e;
  }
  if (!(px >= 0)) return 0;
  char fam[512]; build_family(p, fam, sizeof fam);
  PangoFontDescription *fd = pango_font_description_new();
  pango_font_description_set_family(fd, fam);
  pango_font_description_set_style(fd, italic ? PANGO_STYLE_ITALIC : PANGO_STYLE_NORMAL);
  pango_font_description_set_weight(fd, (PangoWeight)weight);
  pango_font_description_set_absolute_size(fd, (px < 0.01 ? 0.01 : px) * PANGO_SCALE);
  *fdout = fd; return 1;
}

static void state_init(State *s) {
  memset(s, 0, sizeof *s);
  s->fill.rgba[3] = 1; s->stroke.rgba[3] = 1; s->alpha = 1; s->op = CAIRO_OPERATOR_OVER;
  s->lw = 1; s->miter = 10; s->join = CAIRO_LINE_JOIN_MITER; s->cap = CAIRO_LINE_CAP_BUTT; s->smooth = 1;
  s->fontStr[0] = 0;
  parse_font("10px sans-serif", &s->fd);
}

static double g_text_tol = 0.1;   // cairo tolerance for stroked text (PMZ_TEXT_TOL); 0.1 = cairo default
static void cv_global_init(void) {
  if (g_fo) return;
  { const char *tt = getenv("PMZ_TEXT_TOL"); if (tt && atof(tt) > 0) g_text_tol = atof(tt); }
  g_fo = cairo_font_options_create();
  const char *hs = getenv("PMZ_HINT"), *hm = getenv("PMZ_HINTMETRICS"), *aa = getenv("PMZ_AA");
  cairo_font_options_set_antialias(g_fo, aa && !strcmp(aa, "subpixel") ? CAIRO_ANTIALIAS_SUBPIXEL : aa && !strcmp(aa, "none") ? CAIRO_ANTIALIAS_NONE : CAIRO_ANTIALIAS_GRAY);
  cairo_hint_style_t st = CAIRO_HINT_STYLE_SLIGHT;
  if (hs) st = !strcmp(hs, "none") ? CAIRO_HINT_STYLE_NONE : !strcmp(hs, "medium") ? CAIRO_HINT_STYLE_MEDIUM : !strcmp(hs, "full") ? CAIRO_HINT_STYLE_FULL : CAIRO_HINT_STYLE_SLIGHT;
  cairo_font_options_set_hint_style(g_fo, st);
  cairo_font_options_set_hint_metrics(g_fo, hm && hm[0] == '0' ? CAIRO_HINT_METRICS_OFF : CAIRO_HINT_METRICS_ON);
  g_fo_m = cairo_font_options_copy(g_fo); cairo_font_options_set_hint_metrics(g_fo_m, CAIRO_HINT_METRICS_OFF);
  { const char *mm = getenv("PMZ_MEASURE"); if (mm && !strcmp(mm, "hinted")) g_measure_frac = 0; }
  g_lang = pango_language_from_string("ja");
}

// ---------------------------------------------------------------------------------------------------
// canvas objects
// ---------------------------------------------------------------------------------------------------
static void cv_release_cairo(Cv *c) {
  if (c->layout) { g_object_unref(c->layout); c->layout = NULL; }
  if (c->lfd) { pango_font_description_free(c->lfd); c->lfd = NULL; }
  free(c->ltext); c->ltext = NULL; c->lmatOk = 0;
  if (c->mlayout) { g_object_unref(c->mlayout); c->mlayout = NULL; }
  if (c->mlfd) { pango_font_description_free(c->mlfd); c->mlfd = NULL; }
  free(c->mltext); c->mltext = NULL;
  if (c->mfd) { pango_font_description_free(c->mfd); c->mfd = NULL; }
  if (c->saved) { cairo_path_destroy(c->saved); c->saved = NULL; }
  for (int i = 0; i < c->sp; i++) state_free(&c->stack[i]);
  c->sp = 0;
  state_free(&c->st);
  if (c->cr) { cairo_destroy(c->cr); c->cr = NULL; }
}
static void cv_finalize(napi_env env, void *data, void *hint) {
  Cv *c = data; if (!c) return;
  cv_release_cairo(c);
  if (c->surf) cairo_surface_destroy(c->surf);
  free(c->stack);
  if (c->mem) { int64_t adj; napi_adjust_external_memory(env, -c->mem, &adj); }
  free(c);
}
static Cv *cv_arg(napi_env env, napi_value v) { void *p = NULL; if (napi_get_value_external(env, v, &p) != napi_ok) return NULL; return p; }
#define CV(i) cv_arg(env, a_[i])
static void pat_finalize(napi_env env, void *data, void *hint) { if (data) cairo_pattern_destroy(data); }

// (re)create surface + context for size w x h; resets state, clears pixels
static int cv_setup(napi_env env, Cv *c, int w, int h, int with_cr) {
  cv_global_init();
  if (w < 0) w = 0; if (h < 0) h = 0;
  int sameSize = c->surf && c->w == w && c->h == h;
  if (c->cr) { cv_release_cairo(c); }
  if (!sameSize) {
    if (c->surf) { cairo_surface_destroy(c->surf); c->surf = NULL; }
    c->surf = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, w, h);
    if (cairo_surface_status(c->surf) != CAIRO_STATUS_SUCCESS) { cairo_surface_destroy(c->surf); c->surf = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, 0, 0); w = h = 0; }
    int64_t nm = (int64_t)w * h * 4, adj; napi_adjust_external_memory(env, nm - c->mem, &adj); c->mem = nm;
    c->w = w; c->h = h;
  } else {   // same size: clear in place
    cairo_surface_flush(c->surf);
    unsigned char *d = cairo_image_surface_get_data(c->surf); int st = cairo_image_surface_get_stride(c->surf);
    if (d) memset(d, 0, (size_t)st * h);
    cairo_surface_mark_dirty(c->surf);
  }
  if (with_cr) { c->cr = cairo_create(c->surf); state_init(&c->st); }
  return 1;
}
DEFR(cvCreate, 2, Cv *c = calloc(1, sizeof *c); cv_setup(env, c, I(0), I(1), 1);
  napi_value r; napi_create_external(env, c, cv_finalize, NULL, &r); return r;)
DEF(cvResize, 3, Cv *c = CV(0); if (c) cv_setup(env, c, I(1), I(2), 1))
// image surface from RGBA (non-premultiplied) pixels: cvFromRGBA(data, w, h)
DEFR(cvFromRGBA, 3, void *p; size_t len; int w = I(1), h = I(2);
  if (!argbytes(env, a_[0], &p, &len) || w <= 0 || h <= 0 || len < (size_t)w * h * 4) return ret_null(env);
  Cv *c = calloc(1, sizeof *c); cv_setup(env, c, w, h, 0);
  cairo_surface_flush(c->surf); unsigned char *d = cairo_image_surface_get_data(c->surf); int st = cairo_image_surface_get_stride(c->surf);
  for (int y = 0; y < h; y++) {
    const uint8_t *s = (const uint8_t *)p + (size_t)y * w * 4; uint32_t *o = (uint32_t *)(d + (size_t)y * st);
    for (int x = 0; x < w; x++, s += 4) {
      unsigned a = s[3];
      if (a == 255) o[x] = 0xff000000u | (uint32_t)s[0] << 16 | (uint32_t)s[1] << 8 | s[2];
      else if (!a) o[x] = 0;
      else o[x] = (uint32_t)a << 24 | (uint32_t)((s[0] * a + 127) / 255) << 16 | (uint32_t)((s[1] * a + 127) / 255) << 8 | (uint32_t)((s[2] * a + 127) / 255);
    }
  }
  cairo_surface_mark_dirty(c->surf);
  napi_value r; napi_create_external(env, c, cv_finalize, NULL, &r); return r;)

// ---------------------------------------------------------------------------------------------------
// state setters
// ---------------------------------------------------------------------------------------------------
DEF(cvSave, 1, Cv *c = CV(0); if (c && c->cr) {
  if (c->sp == c->scap) { c->scap = c->scap ? c->scap * 2 : 16; c->stack = realloc(c->stack, c->scap * sizeof(State)); }
  state_copy(&c->stack[c->sp++], &c->st); cairo_save(c->cr); })
DEF(cvRestore, 1, Cv *c = CV(0); if (c && c->cr && c->sp > 0) {
  state_free(&c->st); c->st = c->stack[--c->sp]; cairo_restore(c->cr); })
DEF(cvSetAlpha, 2, Cv *c = CV(0); if (c && c->cr) { double v = D(1); if (v >= 0 && v <= 1) c->st.alpha = v; })
static const struct { const char *n; cairo_operator_t op; } g_ops[] = {
  {"source-over", CAIRO_OPERATOR_OVER}, {"source-in", CAIRO_OPERATOR_IN}, {"source-out", CAIRO_OPERATOR_OUT}, {"source-atop", CAIRO_OPERATOR_ATOP},
  {"destination-over", CAIRO_OPERATOR_DEST_OVER}, {"destination-in", CAIRO_OPERATOR_DEST_IN}, {"destination-out", CAIRO_OPERATOR_DEST_OUT}, {"destination-atop", CAIRO_OPERATOR_DEST_ATOP},
  {"lighter", CAIRO_OPERATOR_ADD}, {"copy", CAIRO_OPERATOR_SOURCE}, {"xor", CAIRO_OPERATOR_XOR}, {"multiply", CAIRO_OPERATOR_MULTIPLY}, {"screen", CAIRO_OPERATOR_SCREEN},
  {"overlay", CAIRO_OPERATOR_OVERLAY}, {"darken", CAIRO_OPERATOR_DARKEN}, {"lighten", CAIRO_OPERATOR_LIGHTEN}, {"color-dodge", CAIRO_OPERATOR_COLOR_DODGE}, {"color-burn", CAIRO_OPERATOR_COLOR_BURN},
  {"hard-light", CAIRO_OPERATOR_HARD_LIGHT}, {"soft-light", CAIRO_OPERATOR_SOFT_LIGHT}, {"difference", CAIRO_OPERATOR_DIFFERENCE}, {"exclusion", CAIRO_OPERATOR_EXCLUSION},
  {"hue", CAIRO_OPERATOR_HSL_HUE}, {"saturation", CAIRO_OPERATOR_HSL_SATURATION}, {"color", CAIRO_OPERATOR_HSL_COLOR}, {"luminosity", CAIRO_OPERATOR_HSL_LUMINOSITY},
};
DEFR(cvSetOp, 2, Cv *c = CV(0); int ok = 0; if (c && c->cr) { char *s = arg_utf8(env, a_[1]); if (s) {
  for (size_t i = 0; i < sizeof g_ops / sizeof g_ops[0]; i++) if (!strcmp(s, g_ops[i].n)) { c->st.op = g_ops[i].op; ok = 1; break; } free(s); } }
  return ret_b(env, ok);)
DEF(cvSetSmooth, 2, Cv *c = CV(0); if (c && c->cr) c->st.smooth = B(1))
DEF(cvSetLineWidth, 2, Cv *c = CV(0); if (c && c->cr) { double v = D(1); if (v > 0 && isfinite(v)) c->st.lw = v; })
DEF(cvSetLineJoin, 2, Cv *c = CV(0); if (c && c->cr) { int v = I(1); c->st.join = v == 1 ? CAIRO_LINE_JOIN_ROUND : v == 2 ? CAIRO_LINE_JOIN_BEVEL : CAIRO_LINE_JOIN_MITER; })
DEF(cvSetLineCap, 2, Cv *c = CV(0); if (c && c->cr) { int v = I(1); c->st.cap = v == 1 ? CAIRO_LINE_CAP_ROUND : v == 2 ? CAIRO_LINE_CAP_SQUARE : CAIRO_LINE_CAP_BUTT; })
DEF(cvSetMiter, 2, Cv *c = CV(0); if (c && c->cr) { double v = D(1); if (v > 0 && isfinite(v)) c->st.miter = v; })
DEF(cvSetDash, 3, Cv *c = CV(0); if (c && c->cr) { void *p; size_t len; c->st.ndash = 0; c->st.dashOff = D(2);
  if (argbytes(env, a_[1], &p, &len) && len >= 8) { int n = (int)(len / 8); if (n > MAXDASH) n = MAXDASH; const double *d = p; int ok = 1; for (int i = 0; i < n; i++) { c->st.dash[i] = d[i]; if (!(d[i] >= 0)) ok = 0; } if (ok) c->st.ndash = n; } })
DEF(cvSetBlur, 2, Cv *c = CV(0); if (c && c->cr) { double v = D(1); c->st.blur = v > 0 && isfinite(v) ? v : 0; })
DEF(cvSetShadowColor, 2, Cv *c = CV(0); if (c && c->cr) { char *s = arg_utf8(env, a_[1]); double o[4]; if (s && parse_color(s, o)) memcpy(c->st.shColor, o, sizeof o); free(s); })
DEF(cvSetShadow, 4, Cv *c = CV(0); if (c && c->cr) { c->st.shBlur = D(1) > 0 ? D(1) : 0; c->st.shX = D(2); c->st.shY = D(3); })
DEF(cvSetTextAlign, 2, Cv *c = CV(0); if (c && c->cr) c->st.align = I(1))
DEF(cvSetTextBaseline, 2, Cv *c = CV(0); if (c && c->cr) c->st.baseline = I(1))
DEFR(cvSetFont, 2, Cv *c = CV(0); int ok = 0; if (c && c->cr) { char *s = arg_utf8(env, a_[1]); if (s) {
  if (!(c->st.fd && !strcmp(s, c->st.fontStr) && strlen(s) < sizeof c->st.fontStr)) {
    PangoFontDescription *fd = NULL;
    if (parse_font(s, &fd)) { if (c->st.fd) pango_font_description_free(c->st.fd); c->st.fd = fd; snprintf(c->st.fontStr, sizeof c->st.fontStr, "%s", s); ok = 1; }
  } else ok = 1;
  free(s); } }
  return ret_b(env, ok);)
// colour: cvSetFill(h, str) / cvSetStroke(h, str) -> bool;  cvSetFillPat(h, pattern) / cvSetStrokePat
static int set_paint_color(napi_env env, Cv *c, Paint *p, napi_value v) {
  char *s = arg_utf8(env, v); double o[4]; int ok = 0;
  if (s && parse_color(s, o)) { paint_free(p); memcpy(p->rgba, o, sizeof o); ok = 1; }
  free(s); return ok;
}
DEFR(cvSetFill, 2, Cv *c = CV(0); return ret_b(env, c && c->cr && set_paint_color(env, c, &c->st.fill, a_[1]));)
DEFR(cvSetStroke, 2, Cv *c = CV(0); return ret_b(env, c && c->cr && set_paint_color(env, c, &c->st.stroke, a_[1]));)
DEF(cvSetFillPat, 2, Cv *c = CV(0); void *p = NULL; napi_get_value_external(env, a_[1], &p); if (c && c->cr && p) { paint_free(&c->st.fill); c->st.fill.pat = cairo_pattern_reference(p); })
DEF(cvSetStrokePat, 2, Cv *c = CV(0); void *p = NULL; napi_get_value_external(env, a_[1], &p); if (c && c->cr && p) { paint_free(&c->st.stroke); c->st.stroke.pat = cairo_pattern_reference(p); })

// gradients / patterns
static napi_value wrap_pattern(napi_env env, cairo_pattern_t *p) { napi_value r; napi_create_external(env, p, pat_finalize, NULL, &r); return r; }
DEFR(cvLinearGradient, 4, return wrap_pattern(env, cairo_pattern_create_linear(D(0), D(1), D(2), D(3)));)
DEFR(cvRadialGradient, 6, return wrap_pattern(env, cairo_pattern_create_radial(D(0), D(1), D(2), D(3), D(4), D(5)));)
DEFR(cvAddColorStop, 3, void *p = NULL; napi_get_value_external(env, a_[0], &p); int ok = 0;
  if (p) { char *s = arg_utf8(env, a_[2]); double o[4]; if (s && parse_color(s, o) && D(1) >= 0 && D(1) <= 1) { cairo_pattern_add_color_stop_rgba(p, D(1), o[0], o[1], o[2], o[3]); ok = 1; } free(s); }
  return ret_b(env, ok);)
// createPattern(srcCv, mode) mode 0 repeat, 1 no-repeat, 2 repeat-x, 3 repeat-y
DEFR(cvPattern, 2, Cv *s = CV(0); if (!s || !s->surf) return ret_null(env);
  cairo_pattern_t *p = cairo_pattern_create_for_surface(s->surf);
  int m = I(1); cairo_pattern_set_extend(p, m == 1 ? CAIRO_EXTEND_NONE : CAIRO_EXTEND_REPEAT);
  cairo_pattern_set_filter(p, CAIRO_FILTER_GOOD); return wrap_pattern(env, p);)

// ---------------------------------------------------------------------------------------------------
// transforms
// ---------------------------------------------------------------------------------------------------
static int mat_ok(const cairo_matrix_t *m) { double det = m->xx * m->yy - m->xy * m->yx; return isfinite(det) && fabs(det) > 1e-12 && isfinite(m->x0) && isfinite(m->y0); }
DEF(cvSetTransform, 7, Cv *c = CV(0); if (c && c->cr) { cairo_matrix_t m; cairo_matrix_init(&m, D(1), D(2), D(3), D(4), D(5), D(6)); if (mat_ok(&m)) cairo_set_matrix(c->cr, &m); })
DEF(cvTransform, 7, Cv *c = CV(0); if (c && c->cr) { cairo_matrix_t m, cur, res; cairo_matrix_init(&m, D(1), D(2), D(3), D(4), D(5), D(6)); cairo_get_matrix(c->cr, &cur);
  cairo_matrix_multiply(&res, &m, &cur); if (mat_ok(&res)) cairo_set_matrix(c->cr, &res); })
DEF(cvResetTransform, 1, Cv *c = CV(0); if (c && c->cr) cairo_identity_matrix(c->cr))
DEF(cvTranslate, 3, Cv *c = CV(0); if (c && c->cr && isfinite(D(1)) && isfinite(D(2))) cairo_translate(c->cr, D(1), D(2)))
DEF(cvScale, 3, Cv *c = CV(0); if (c && c->cr) { cairo_matrix_t m, cur, res; cairo_matrix_init_scale(&m, D(1), D(2)); cairo_get_matrix(c->cr, &cur); cairo_matrix_multiply(&res, &m, &cur); if (mat_ok(&res)) cairo_set_matrix(c->cr, &res); })
DEF(cvRotate, 2, Cv *c = CV(0); if (c && c->cr && isfinite(D(1))) cairo_rotate(c->cr, D(1)))
DEFR(cvGetTransform, 1, Cv *c = CV(0); double v[6] = {1, 0, 0, 1, 0, 0}; if (c && c->cr) { cairo_matrix_t m; cairo_get_matrix(c->cr, &m); v[0] = m.xx; v[1] = m.yx; v[2] = m.xy; v[3] = m.yy; v[4] = m.x0; v[5] = m.y0; }
  return ret_arr_d(env, v, 6);)

// ---------------------------------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------------------------------
DEF(cvBeginPath, 1, Cv *c = CV(0); if (c && c->cr) cairo_new_path(c->cr))
DEF(cvClosePath, 1, Cv *c = CV(0); if (c && c->cr && cairo_has_current_point(c->cr)) cairo_close_path(c->cr))
DEF(cvMoveTo, 3, Cv *c = CV(0); if (c && c->cr && isfinite(D(1)) && isfinite(D(2))) cairo_move_to(c->cr, D(1), D(2)))
DEF(cvLineTo, 3, Cv *c = CV(0); if (c && c->cr && isfinite(D(1)) && isfinite(D(2))) cairo_line_to(c->cr, D(1), D(2)))
DEF(cvRect, 5, Cv *c = CV(0); if (c && c->cr && isfinite(D(1)) && isfinite(D(2)) && isfinite(D(3)) && isfinite(D(4))) { cairo_move_to(c->cr, D(1), D(2)); cairo_rel_line_to(c->cr, D(3), 0); cairo_rel_line_to(c->cr, 0, D(4)); cairo_rel_line_to(c->cr, -D(3), 0); cairo_close_path(c->cr); })
DEF(cvArc, 7, Cv *c = CV(0); if (c && c->cr && D(3) >= 0 && isfinite(D(1)) && isfinite(D(2)) && isfinite(D(4)) && isfinite(D(5))) {
  double a0 = D(4), a1 = D(5);
  if (!B(6)) { if (a1 - a0 >= 2 * M_PI) a1 = a0 + 2 * M_PI; cairo_arc(c->cr, D(1), D(2), D(3), a0, a1); }
  else { if (a0 - a1 >= 2 * M_PI) a1 = a0 - 2 * M_PI; cairo_arc_negative(c->cr, D(1), D(2), D(3), a0, a1); } })
// ellipse(h, x, y, rx, ry, rotation, a0, a1, ccw)
DEF(cvEllipse, 9, Cv *c = CV(0); if (c && c->cr && D(3) >= 0 && D(4) >= 0) {
  cairo_save(c->cr); cairo_translate(c->cr, D(1), D(2)); cairo_rotate(c->cr, D(5)); cairo_scale(c->cr, D(3) ? D(3) : 1e-9, D(4) ? D(4) : 1e-9);
  double a0 = D(6), a1 = D(7);
  if (!B(8)) { if (a1 - a0 >= 2 * M_PI) a1 = a0 + 2 * M_PI; cairo_arc(c->cr, 0, 0, 1, a0, a1); } else { if (a0 - a1 >= 2 * M_PI) a1 = a0 - 2 * M_PI; cairo_arc_negative(c->cr, 0, 0, 1, a0, a1); }
  cairo_restore(c->cr); })
DEF(cvQuadTo, 5, Cv *c = CV(0); if (c && c->cr) { cairo_t *cr = c->cr; double x0, y0, cx = D(1), cy = D(2), x = D(3), y = D(4);
  if (!cairo_has_current_point(cr)) cairo_move_to(cr, cx, cy);
  cairo_get_current_point(cr, &x0, &y0);
  cairo_curve_to(cr, x0 + 2.0 / 3.0 * (cx - x0), y0 + 2.0 / 3.0 * (cy - y0), x + 2.0 / 3.0 * (cx - x), y + 2.0 / 3.0 * (cy - y), x, y); })
DEF(cvBezierTo, 7, Cv *c = CV(0); if (c && c->cr) { if (!cairo_has_current_point(c->cr)) cairo_move_to(c->cr, D(1), D(2)); cairo_curve_to(c->cr, D(1), D(2), D(3), D(4), D(5), D(6)); })
DEF(cvArcTo, 6, Cv *c = CV(0); if (c && c->cr && D(5) >= 0) {   // arcTo(h, x1, y1, x2, y2, r)
  cairo_t *cr = c->cr; double x1 = D(1), y1 = D(2), x2 = D(3), y2 = D(4), r = D(5);
  if (!cairo_has_current_point(cr)) cairo_move_to(cr, x1, y1);
  double x0, y0; cairo_get_current_point(cr, &x0, &y0);
  double dx0 = x0 - x1, dy0 = y0 - y1, dx2 = x2 - x1, dy2 = y2 - y1;
  double l0 = hypot(dx0, dy0), l2 = hypot(dx2, dy2), cross = dx0 * dy2 - dy0 * dx2;
  if (l0 == 0 || l2 == 0 || r == 0 || fabs(cross) < 1e-12 * l0 * l2) { cairo_line_to(cr, x1, y1); }
  else {
    double cosA = (dx0 * dx2 + dy0 * dy2) / (l0 * l2), ang = acos(fmax(-1, fmin(1, cosA))), t = r / tan(ang / 2);
    double ax = x1 + dx0 / l0 * t, ay = y1 + dy0 / l0 * t, bx = x1 + dx2 / l2 * t, by = y1 + dy2 / l2 * t;
    double nx, ny;   // centre direction: bisector
    double bxs = dx0 / l0 + dx2 / l2, bys = dy0 / l0 + dy2 / l2, bl = hypot(bxs, bys); nx = bxs / bl; ny = bys / bl;
    double d = r / sin(ang / 2), cx = x1 + nx * d, cy = y1 + ny * d;
    double sa = atan2(ay - cy, ax - cx), ea = atan2(by - cy, bx - cx);
    cairo_line_to(cr, ax, ay);
    if (cross < 0) cairo_arc(cr, cx, cy, r, sa, ea); else cairo_arc_negative(cr, cx, cy, r, sa, ea);
  } })
DEFR(cvInPath, 4, Cv *c = CV(0); if (!c || !c->cr) return ret_b(env, 0); cairo_set_fill_rule(c->cr, B(3) ? CAIRO_FILL_RULE_EVEN_ODD : CAIRO_FILL_RULE_WINDING); return ret_b(env, cairo_in_fill(c->cr, D(1), D(2)));)

// keep the current path across operations that build their own (fillRect, drawImage, text ...)
static void path_save(Cv *c) { c->saved = cairo_has_current_point(c->cr) ? cairo_copy_path(c->cr) : NULL; cairo_new_path(c->cr); }
static void path_restore(Cv *c) {
  cairo_new_path(c->cr);
  if (c->saved) { cairo_append_path(c->cr, c->saved); cairo_path_destroy(c->saved); c->saved = NULL; }
}

// ---------------------------------------------------------------------------------------------------
// box blur (3 passes ~ gaussian) on a premultiplied ARGB32 surface, in place; outside = transparent
// ---------------------------------------------------------------------------------------------------
static void box_pass(uint8_t *data, int stride, int w, int h, int r, int horiz, uint32_t *tmp) {
  int len = horiz ? w : h, lines = horiz ? h : w, size = 2 * r + 1;
  for (int l = 0; l < lines; l++) {
    uint8_t *base = data + (horiz ? (size_t)l * stride : (size_t)l * 4); size_t step = horiz ? 4 : (size_t)stride;
    uint32_t s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (int i = 0; i < len; i++) memcpy(&tmp[i], base + i * step, 4);
    for (int i = 0; i <= r && i < len; i++) { uint8_t *p = (uint8_t *)&tmp[i]; s0 += p[0]; s1 += p[1]; s2 += p[2]; s3 += p[3]; }
    for (int i = 0; i < len; i++) {
      uint8_t *o = base + i * step;
      o[0] = (uint8_t)((s0 + size / 2) / size); o[1] = (uint8_t)((s1 + size / 2) / size); o[2] = (uint8_t)((s2 + size / 2) / size); o[3] = (uint8_t)((s3 + size / 2) / size);
      int add = i + r + 1, sub = i - r;
      if (add < len) { uint8_t *p = (uint8_t *)&tmp[add]; s0 += p[0]; s1 += p[1]; s2 += p[2]; s3 += p[3]; }
      if (sub >= 0) { uint8_t *p = (uint8_t *)&tmp[sub]; s0 -= p[0]; s1 -= p[1]; s2 -= p[2]; s3 -= p[3]; }
    }
  }
}
static void blur_image_surface(cairo_surface_t *s, double sigma) {
  if (!s || cairo_surface_get_type(s) != CAIRO_SURFACE_TYPE_IMAGE || sigma < 0.3) return;
  cairo_surface_flush(s);
  uint8_t *d = cairo_image_surface_get_data(s); int w = cairo_image_surface_get_width(s), h = cairo_image_surface_get_height(s), st = cairo_image_surface_get_stride(s);
  if (!d || w <= 0 || h <= 0) return;
  int n = 3; double wi = sqrt(12.0 * sigma * sigma / n + 1); int wl = (int)floor(wi); if (!(wl & 1)) wl--; if (wl < 1) wl = 1; int wu = wl + 2;
  double mi = (12.0 * sigma * sigma - n * wl * wl - 4.0 * n * wl - 3.0 * n) / (-4.0 * wl - 4.0); int m = (int)lround(mi);
  uint32_t *tmp = malloc((size_t)(w > h ? w : h) * 4); if (!tmp) return;
  for (int i = 0; i < n; i++) { int size = i < m ? wl : wu, r = (size - 1) / 2; if (r < 1) continue; box_pass(d, st, w, h, r, 1, tmp); box_pass(d, st, w, h, r, 0, tmp); }
  free(tmp); cairo_surface_mark_dirty(s);
}

// ---------------------------------------------------------------------------------------------------
// drawing effects (shadow / filter: blur): draw into a group, then post-process while compositing
// ---------------------------------------------------------------------------------------------------
static int has_shadow(const State *s) { return s->shColor[3] > 0 && (s->shBlur > 0 || s->shX != 0 || s->shY != 0); }
static int fx_begin(Cv *c) {
  int fx = has_shadow(&c->st) || c->st.blur > 0;
  if (fx) { cairo_push_group(c->cr); cairo_set_operator(c->cr, CAIRO_OPERATOR_OVER); }
  else cairo_set_operator(c->cr, c->st.op);
  return fx;
}
static void fx_end(Cv *c, int fx) {
  if (!fx) return;
  cairo_t *cr = c->cr; State *s = &c->st;
  if (s->blur > 0) blur_image_surface(cairo_get_group_target(cr), s->blur);
  cairo_pattern_t *grp = cairo_pop_group(cr);   // valid under the ctm that was current at push time (= now)
  cairo_set_operator(cr, s->op);
  if (has_shadow(s)) {
    cairo_matrix_t m; cairo_get_matrix(cr, &m);
    cairo_surface_t *tmp = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, c->w, c->h);
    cairo_t *tc = cairo_create(tmp); cairo_set_matrix(tc, &m); cairo_set_source(tc, grp); cairo_paint(tc); cairo_destroy(tc);
    if (s->shBlur > 0) blur_image_surface(tmp, s->shBlur / 2);
    cairo_save(cr); cairo_identity_matrix(cr);
    cairo_set_source_rgba(cr, s->shColor[0], s->shColor[1], s->shColor[2], s->shColor[3]);
    cairo_mask_surface(cr, tmp, s->shX, s->shY);
    cairo_restore(cr);
    cairo_surface_destroy(tmp);
  }
  cairo_set_source(cr, grp); cairo_paint(cr);
  cairo_pattern_destroy(grp);
}

// ---------------------------------------------------------------------------------------------------
// fill / stroke / clip / rects
// ---------------------------------------------------------------------------------------------------
static void setup_stroke(Cv *c) {
  cairo_t *cr = c->cr; State *s = &c->st;
  cairo_set_line_width(cr, s->lw); cairo_set_line_join(cr, s->join); cairo_set_line_cap(cr, s->cap); cairo_set_miter_limit(cr, s->miter);
  if (s->ndash) cairo_set_dash(cr, s->dash, s->ndash, s->dashOff); else cairo_set_dash(cr, NULL, 0, 0);
}
// fill or stroke the current path with the state's paint (path is kept)
static void paint_path(Cv *c, int stroke, int evenodd) {
  cairo_t *cr = c->cr; State *s = &c->st; Paint *p = stroke ? &s->stroke : &s->fill;
  cairo_set_fill_rule(cr, evenodd ? CAIRO_FILL_RULE_EVEN_ODD : CAIRO_FILL_RULE_WINDING);
  if (stroke) setup_stroke(c);
  if (!p->pat) {
    cairo_set_source_rgba(cr, p->rgba[0], p->rgba[1], p->rgba[2], p->rgba[3] * s->alpha);
    if (stroke) cairo_stroke_preserve(cr); else cairo_fill_preserve(cr);
  } else if (s->alpha >= 1) {
    cairo_set_source(cr, p->pat);
    if (stroke) cairo_stroke_preserve(cr); else cairo_fill_preserve(cr);
  } else if (!stroke) {
    cairo_save(cr); cairo_clip_preserve(cr); cairo_set_source(cr, p->pat); cairo_paint_with_alpha(cr, s->alpha); cairo_restore(cr);
  } else {
    cairo_push_group(cr); cairo_set_operator(cr, CAIRO_OPERATOR_OVER); cairo_set_source(cr, p->pat); cairo_stroke_preserve(cr);
    cairo_pop_group_to_source(cr); cairo_paint_with_alpha(cr, s->alpha);
  }
}
DEF(cvFill, 2, Cv *c = CV(0); if (c && c->cr) { int fx = fx_begin(c); paint_path(c, 0, B(1)); fx_end(c, fx); })
DEF(cvStroke, 1, Cv *c = CV(0); if (c && c->cr) { int fx = fx_begin(c); paint_path(c, 1, 0); fx_end(c, fx); })
DEF(cvClip, 2, Cv *c = CV(0); if (c && c->cr) { cairo_set_fill_rule(c->cr, B(1) ? CAIRO_FILL_RULE_EVEN_ODD : CAIRO_FILL_RULE_WINDING); cairo_clip_preserve(c->cr); })
DEF(cvFillRect, 5, Cv *c = CV(0); if (c && c->cr && isfinite(D(1)) && isfinite(D(2)) && isfinite(D(3)) && isfinite(D(4)) && D(3) != 0 && D(4) != 0) {
  path_save(c); int fx = fx_begin(c); cairo_rectangle(c->cr, D(1), D(2), D(3), D(4)); paint_path(c, 0, 0); fx_end(c, fx); path_restore(c); })
DEF(cvStrokeRect, 5, Cv *c = CV(0); if (c && c->cr && isfinite(D(1)) && isfinite(D(2)) && isfinite(D(3)) && isfinite(D(4))) {
  path_save(c); int fx = fx_begin(c); cairo_rectangle(c->cr, D(1), D(2), D(3), D(4)); paint_path(c, 1, 0); fx_end(c, fx); path_restore(c); })
DEF(cvClearRect, 5, Cv *c = CV(0); if (c && c->cr && isfinite(D(1)) && isfinite(D(2)) && isfinite(D(3)) && isfinite(D(4))) {
  path_save(c); cairo_save(c->cr); cairo_set_operator(c->cr, CAIRO_OPERATOR_CLEAR); cairo_rectangle(c->cr, D(1), D(2), D(3), D(4)); cairo_fill(c->cr); cairo_restore(c->cr); path_restore(c); })

// ---------------------------------------------------------------------------------------------------
// images: cvDrawImage(dst, src, sx, sy, sw, sh, dx, dy, dw, dh)
// ---------------------------------------------------------------------------------------------------
DEF(cvDrawImage, 10, Cv *c = CV(0), *src = CV(1);
  if (c && c->cr && src && src->surf && src->w > 0 && src->h > 0) {
    double sx = D(2), sy = D(3), sw = D(4), sh = D(5), dx = D(6), dy = D(7), dw = D(8), dh = D(9);
    if (isfinite(sx + sy + sw + sh + dx + dy + dw + dh) && sw != 0 && sh != 0 && dw != 0 && dh != 0) {
      if (sw < 0) { sx += sw; sw = -sw; dx += dw; dw = -dw; } if (sh < 0) { sy += sh; sh = -sh; dy += dh; dh = -dh; }
      double kx = dw / sw, ky = dh / sh;   // clip the source rect to the image, adjusting the destination
      if (sx < 0) { dx -= sx * kx; dw += sx * kx; sw += sx; sx = 0; } if (sy < 0) { dy -= sy * ky; dh += sy * ky; sh += sy; sy = 0; }
      if (sx + sw > src->w) { dw -= (sx + sw - src->w) * kx; sw = src->w - sx; } if (sy + sh > src->h) { dh -= (sy + sh - src->h) * ky; sh = src->h - sy; }
      if (sw > 0 && sh > 0 && dw != 0 && dh != 0) {
        cairo_t *cr = c->cr; int full = sx == 0 && sy == 0 && sw == src->w && sh == src->h;
        cairo_surface_t *ss = src->surf, *sub = NULL;
        if (!full) { sub = cairo_surface_create_for_rectangle(src->surf, floor(sx + 0.5), floor(sy + 0.5), floor(sw + 0.5) < 1 ? 1 : floor(sw + 0.5), floor(sh + 0.5) < 1 ? 1 : floor(sh + 0.5)); ss = sub; }
        path_save(c); int fx = fx_begin(c);
        cairo_save(cr); cairo_translate(cr, dx, dy); cairo_scale(cr, dw / sw, dh / sh);
        cairo_set_source_surface(cr, ss, 0, 0);
        cairo_pattern_t *pt = cairo_get_source(cr); cairo_pattern_set_extend(pt, CAIRO_EXTEND_PAD);
        cairo_pattern_set_filter(pt, c->st.smooth ? CAIRO_FILTER_GOOD : CAIRO_FILTER_NEAREST);
        cairo_rectangle(cr, 0, 0, sw, sh); cairo_clip(cr); cairo_paint_with_alpha(cr, c->st.alpha);
        cairo_restore(cr); fx_end(c, fx); path_restore(c);
        if (sub) cairo_surface_destroy(sub);
      }
    }
  })

// ---------------------------------------------------------------------------------------------------
// pixels
// ---------------------------------------------------------------------------------------------------
// cvGetImageData(h, x, y, w, h, out Uint8ClampedArray)
DEF(cvGetImageData, 6, Cv *c = CV(0); void *p; size_t len; int x = I(1), y = I(2), w = I(3), h = I(4);
  if (c && c->surf && w > 0 && h > 0 && argbytes(env, a_[5], &p, &len) && len >= (size_t)w * h * 4) {
    uint8_t *o = p; memset(o, 0, (size_t)w * h * 4);
    cairo_surface_flush(c->surf); const uint8_t *d = cairo_image_surface_get_data(c->surf); int st = cairo_image_surface_get_stride(c->surf);
    int x0 = x < 0 ? 0 : x, x1 = x + w > c->w ? c->w : x + w, y0 = y < 0 ? 0 : y, y1 = y + h > c->h ? c->h : y + h;
    for (int yy = y0; yy < y1; yy++) {
      const uint32_t *s = (const uint32_t *)(d + (size_t)yy * st) + x0; uint8_t *q = o + ((size_t)(yy - y) * w + (x0 - x)) * 4;
      for (int xx = x0; xx < x1; xx++, s++, q += 4) {
        uint32_t v = *s; unsigned a = v >> 24;
        if (a == 255) { q[0] = (v >> 16) & 255; q[1] = (v >> 8) & 255; q[2] = v & 255; q[3] = 255; }
        else if (a) { q[0] = (uint8_t)fmin(255, (((v >> 16) & 255) * 255 + a / 2) / a); q[1] = (uint8_t)fmin(255, (((v >> 8) & 255) * 255 + a / 2) / a); q[2] = (uint8_t)fmin(255, ((v & 255) * 255 + a / 2) / a); q[3] = (uint8_t)a; }
      }
    }
  })
// cvPutImageData(h, data, w, h, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH)
DEF(cvPutImageData, 10, Cv *c = CV(0); void *p; size_t len; int iw = I(2), ih = I(3), dx = I(4), dy = I(5), rx = I(6), ry = I(7), rw = I(8), rh = I(9);
  if (c && c->surf && iw > 0 && ih > 0 && argbytes(env, a_[1], &p, &len) && len >= (size_t)iw * ih * 4) {
    if (rw < 0) { rx += rw; rw = -rw; } if (rh < 0) { ry += rh; rh = -rh; }
    if (rx < 0) { rw += rx; rx = 0; } if (ry < 0) { rh += ry; ry = 0; } if (rx + rw > iw) rw = iw - rx; if (ry + rh > ih) rh = ih - ry;
    cairo_surface_flush(c->surf); uint8_t *d = cairo_image_surface_get_data(c->surf); int st = cairo_image_surface_get_stride(c->surf);
    for (int yy = ry; yy < ry + rh; yy++) {
      int ty = dy + yy; if (ty < 0 || ty >= c->h) continue;
      const uint8_t *s = (const uint8_t *)p + ((size_t)yy * iw + rx) * 4; uint32_t *o = (uint32_t *)(d + (size_t)ty * st);
      for (int xx = rx; xx < rx + rw; xx++, s += 4) {
        int tx = dx + xx; if (tx < 0 || tx >= c->w) continue;
        unsigned a = s[3];
        o[tx] = a == 255 ? (0xff000000u | (uint32_t)s[0] << 16 | (uint32_t)s[1] << 8 | s[2]) : !a ? 0u
          : ((uint32_t)a << 24 | (uint32_t)((s[0] * a + 127) / 255) << 16 | (uint32_t)((s[1] * a + 127) / 255) << 8 | (uint32_t)((s[2] * a + 127) / 255));
      }
    }
    cairo_surface_mark_dirty(c->surf);
  })

// ---- GL upload from a canvas: texImageCv(target, level, internalformat, format, type, cv, flipY, premultiply, sub, xoff, yoff) ----
static uint8_t *g_scratch; static size_t g_scratchCap;
__attribute__((optimize("O3"))) static void swizzle_row(uint32_t *restrict o, const uint32_t *restrict s, int n) {
  for (int x = 0; x < n; x++) { uint32_t v = s[x]; o[x] = (v & 0xff00ff00u) | ((v >> 16) & 0xffu) | ((v & 0xffu) << 16); }
}
static uint8_t *cv_to_rgba(Cv *c, int flip, int premul) {
  size_t need = (size_t)c->w * c->h * 4;
  if (need > g_scratchCap) { free(g_scratch); g_scratch = malloc(need); g_scratchCap = g_scratch ? need : 0; }
  if (!g_scratch) return NULL;
  cairo_surface_flush(c->surf); const uint8_t *d = cairo_image_surface_get_data(c->surf); int st = cairo_image_surface_get_stride(c->surf);
  if (premul) {   // Cairo's premultiplied ARGB32 is what GL wants after a B<->R swap: one 32-bit op per pixel (vectorised)
    for (int y = 0; y < c->h; y++) {
      const uint32_t *s = (const uint32_t *)(d + (size_t)(flip ? c->h - 1 - y : y) * st); uint32_t *o = (uint32_t *)(g_scratch + (size_t)y * c->w * 4);
      swizzle_row(o, s, c->w);
    }
    return g_scratch;
  }
  for (int y = 0; y < c->h; y++) {
    const uint32_t *s = (const uint32_t *)(d + (size_t)(flip ? c->h - 1 - y : y) * st); uint8_t *o = g_scratch + (size_t)y * c->w * 4;
    for (int x = 0; x < c->w; x++, o += 4) {
      uint32_t v = s[x]; unsigned a = v >> 24; unsigned r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
      if (!premul && a && a != 255) { r = (r * 255 + a / 2) / a; g = (g * 255 + a / 2) / a; b = (b * 255 + a / 2) / a; if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255; }
      o[0] = (uint8_t)r; o[1] = (uint8_t)g; o[2] = (uint8_t)b; o[3] = (uint8_t)a;
    }
  }
  return g_scratch;
}
DEF(texImageCv, 11, Cv *c = CV(5); if (c && c->surf && c->w > 0 && c->h > 0) {
  uint8_t *px = cv_to_rgba(c, B(6), B(7)); int al; glGetIntegerv(GL_UNPACK_ALIGNMENT, &al); glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
  if (px) { if (B(8)) glTexSubImage2D(E(0), I(1), I(9), I(10), c->w, c->h, GL_RGBA, GL_UNSIGNED_BYTE, px); else glTexImage2D(E(0), I(1), I(2), c->w, c->h, 0, GL_RGBA, GL_UNSIGNED_BYTE, px); }
  glPixelStorei(GL_UNPACK_ALIGNMENT, al); })
// non-premultiplied RGBA copy as a fresh Uint8Array (used for formats other than RGBA)
DEFR(cvReadRGBA, 1, Cv *c = CV(0); if (!c || !c->surf || c->w <= 0 || c->h <= 0) return ret_null(env);
  size_t n = (size_t)c->w * c->h * 4; uint8_t *px = cv_to_rgba(c, 0, 0); if (!px) return ret_null(env);
  void *buf; napi_value ab, ta; napi_create_arraybuffer(env, n, &buf, &ab); memcpy(buf, px, n); napi_create_typedarray(env, napi_uint8_array, n, ab, 0, &ta); return ta;)

// ---- PNG encode of a canvas ----
typedef struct { uint8_t *d; size_t n, cap; } Grow;
static cairo_status_t png_write(void *cl, const unsigned char *data, unsigned int length) {
  Grow *g = cl; if (g->n + length > g->cap) { g->cap = (g->n + length) * 2 + 4096; g->d = realloc(g->d, g->cap); if (!g->d) return CAIRO_STATUS_NO_MEMORY; }
  memcpy(g->d + g->n, data, length); g->n += length; return CAIRO_STATUS_SUCCESS;
}
DEFR(cvToPng, 1, Cv *c = CV(0); if (!c || !c->surf || c->w <= 0 || c->h <= 0) return ret_null(env);
  Grow g = {0}; cairo_status_t st = cairo_surface_write_to_png_stream(c->surf, png_write, &g);
  if (st != CAIRO_STATUS_SUCCESS) { free(g.d); return ret_null(env); }
  napi_value r; napi_create_buffer_copy(env, g.n, g.d, NULL, &r); free(g.d); return r;)
DEFR(cvSize, 1, Cv *c = CV(0); double v[3] = {0, 0, 0}; if (c) { v[0] = c->w; v[1] = c->h; v[2] = (double)c->mem; } return ret_arr_d(env, v, 3);)

// ---------------------------------------------------------------------------------------------------
// fonts + text
// ---------------------------------------------------------------------------------------------------
// fontAdd(path) -> real family name (or null). The caller maps its CSS family to it with fontMap().
static PangoFontMap *font_map(void) { return pango_cairo_font_map_get_default(); }
DEFR(fontAdd, 1, char *path = arg_utf8(env, a_[0]); napi_value r = ret_null(env);
  if (path) {
    cv_global_init();
    int count = 0; FcPattern *pat = FcFreeTypeQuery((const FcChar8 *)path, 0, NULL, &count); FcChar8 *fam = NULL;
    if (pat && FcPatternGetString(pat, FC_FAMILY, 0, &fam) == FcResultMatch && fam) r = ret_str(env, (const char *)fam);
    if (pat) FcPatternDestroy(pat);
    if (FcConfigAppFontAddFile(FcConfigGetCurrent(), (const FcChar8 *)path)) {
      PangoFontMap *fm = font_map();
      if (PANGO_IS_FC_FONT_MAP(fm)) pango_fc_font_map_set_config(PANGO_FC_FONT_MAP(fm), FcConfigGetCurrent());
      g_fontEpoch++;
    } else r = ret_null(env);
    free(path);
  } return r;)
// fontMap(cssFamily, realFamily): from now on CSS family cssFamily resolves to realFamily
DEF(fontMap, 2, char *a = arg_utf8(env, a_[0]), *b = arg_utf8(env, a_[1]);
  if (a && b) { int i; for (i = 0; i < g_nfonts; i++) if (!strcasecmp(g_fonts[i].css, a)) break; if (i == g_nfonts && g_nfonts < 64) g_nfonts++;
    if (i < 64) { snprintf(g_fonts[i].css, sizeof g_fonts[i].css, "%s", a); snprintf(g_fonts[i].real, sizeof g_fonts[i].real, "%s", b); } }
  free(a); free(b);)

static void layout_create(Cv *c) {
  if (c->layout) return;
  c->layout = pango_cairo_create_layout(c->cr);
  PangoContext *pc = pango_layout_get_context(c->layout);
  pango_cairo_context_set_font_options(pc, g_fo); pango_context_set_language(pc, g_lang);
  pango_layout_set_single_paragraph_mode(c->layout, TRUE); pango_layout_set_auto_dir(c->layout, FALSE);
  pango_context_set_base_dir(pc, PANGO_DIRECTION_LTR);
}
static void layout_prepare(Cv *c, const char *text) {
  layout_create(c);
  int same = c->ltext && !strcmp(c->ltext, text);
  if (!c->lfd || !pango_font_description_equal(c->lfd, c->st.fd)) {
    if (c->lfd) pango_font_description_free(c->lfd);
    c->lfd = pango_font_description_copy(c->st.fd);
    pango_layout_set_font_description(c->layout, c->st.fd); same = 0;
  }
  if (!same) { pango_layout_set_text(c->layout, text, -1); free(c->ltext); c->ltext = strdup(text); }
  cairo_matrix_t m; cairo_get_matrix(c->cr, &m);
  if (!c->lmatOk || memcmp(&m, &c->lmat, sizeof m)) { pango_cairo_update_layout(c->cr, c->layout); c->lmat = m; c->lmatOk = 1; }
}
// layout for measureText: font + text as in layout_prepare, but with hint metrics off (unrounded advances, as Chromium's measureText)
static PangoLayout *measure_layout(Cv *c, const char *text) {
  if (!g_measure_frac) { layout_prepare(c, text); return c->layout; }
  if (!c->mlayout) {
    c->mlayout = pango_cairo_create_layout(c->cr);
    PangoContext *pc = pango_layout_get_context(c->mlayout);
    pango_cairo_context_set_font_options(pc, g_fo_m); pango_context_set_language(pc, g_lang);
    pango_context_set_round_glyph_positions(pc, FALSE);   // Pango >= 1.44 rounds advances to whole pixels by default; Chromium's widths are fractional
    pango_layout_set_single_paragraph_mode(c->mlayout, TRUE); pango_layout_set_auto_dir(c->mlayout, FALSE);
    pango_context_set_base_dir(pc, PANGO_DIRECTION_LTR);
  }
  int same = c->mltext && !strcmp(c->mltext, text);
  if (!c->mlfd || !pango_font_description_equal(c->mlfd, c->st.fd)) {
    if (c->mlfd) pango_font_description_free(c->mlfd);
    c->mlfd = pango_font_description_copy(c->st.fd);
    pango_layout_set_font_description(c->mlayout, c->st.fd); same = 0;
  }
  if (!same) { pango_layout_set_text(c->mlayout, text, -1); free(c->mltext); c->mltext = strdup(text); }
  pango_cairo_update_layout(c->cr, c->mlayout);   // font size is in user units: the ctm only matters for the (unhinted) scale
  return c->mlayout;
}
static void font_metrics(Cv *c, double *asc, double *desc) {
  if (!c->mfd || !pango_font_description_equal(c->mfd, c->st.fd)) {
    PangoContext *pc = pango_layout_get_context(c->layout);
    PangoFontMetrics *m = pango_context_get_metrics(pc, c->st.fd, g_lang);
    c->masc = pango_font_metrics_get_ascent(m) / (double)PANGO_SCALE; c->mdesc = pango_font_metrics_get_descent(m) / (double)PANGO_SCALE;
    pango_font_metrics_unref(m);
    if (c->mfd) pango_font_description_free(c->mfd); c->mfd = pango_font_description_copy(c->st.fd);
  }
  *asc = c->masc; *desc = c->mdesc;
}
static double baseline_shift(Cv *c) {   // distance the baseline lies below the y given to fillText
  if (c->st.baseline == 0) return 0;
  double a, d; font_metrics(c, &a, &d);
  switch (c->st.baseline) { case 1: return a; case 2: return a * 0.8; case 3: return (a - d) / 2; default: return -d; }
}
static double g_tt[3];   // stroked text: calls, layout->path us, stroke us (textTimes(), for profiling)
static double now_us(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return ts.tv_sec * 1e6 + ts.tv_nsec / 1e3; }
DEFR(textTimes, 0, return ret_arr_d(env, g_tt, 3);)

// ---- stroked-text cache ----
// Outlined text (Bitmap.drawText's outline pass) costs ~2.3 ms per line in Cairo's stroker, and MZ windows / gauges redraw the same strings many times
// (battle log: the same line every frame). The coverage of the stroke is kept as an A8 mask per (text, font, line style, sub-pixel origin) and painted with
// the current colour: same geometry and rasteriser, so the same pixels (+-1 level). Only for solid colours, no dashes, translate(+x-scale)-only transforms.
// PMZ_TEXTCACHE=0 turns it off.
#define SC_N 48
typedef struct { char *text; char font[160]; double lw, miter, tol, fx, fy, sx; int join, cap; unsigned epoch; cairo_surface_t *mask; int bx, by; unsigned long used; size_t bytes; } SCache;
static SCache g_sc[SC_N]; static unsigned long g_scTick; static size_t g_scBytes; static int g_scOn = -1; static double g_scHit, g_scMiss;
#define SC_MAXBYTES (6u << 20)
static void sc_free(SCache *e) { if (e->mask) cairo_surface_destroy(e->mask); free(e->text); g_scBytes -= e->bytes; memset(e, 0, sizeof *e); }
// returns 1 when the stroke was painted from the cache (hit or freshly built), 0 = caller strokes the layout path itself
static int stroke_text_cached(Cv *c, const char *text, double base, double sx) {
  if (g_scOn < 0) { const char *e = getenv("PMZ_TEXTCACHE"); g_scOn = !(e && e[0] == '0'); }
  State *s = &c->st; cairo_t *cr = c->cr;
  if (!g_scOn || s->stroke.pat || s->ndash || strlen(text) > 160) return 0;
  cairo_matrix_t m; cairo_get_matrix(cr, &m);
  if (fabs(m.xx - sx) > 1e-9 || fabs(m.yy - 1) > 1e-9 || m.xy != 0 || m.yx != 0 || !isfinite(m.x0) || !isfinite(m.y0)) return 0;
  double fx = m.x0 - floor(m.x0), fy = m.y0 - floor(m.y0);
  SCache *e = NULL;
  for (int i = 0; i < SC_N; i++) { SCache *q = &g_sc[i];
    if (q->mask && q->epoch == g_fontEpoch && q->lw == s->lw && q->miter == s->miter && q->join == (int)s->join && q->cap == (int)s->cap && q->tol == g_text_tol &&
        q->fx == fx && q->fy == fy && q->sx == sx && !strcmp(q->text, text) && !strcmp(q->font, s->fontStr)) { e = q; break; } }
  if (e) g_scHit++;
  else {
    g_scMiss++;
    cairo_move_to(cr, 0, -base); pango_cairo_layout_path(cr, c->layout); setup_stroke(c);
    double x1, y1, x2, y2; cairo_stroke_extents(cr, &x1, &y1, &x2, &y2); cairo_new_path(cr); cairo_move_to(cr, 0, -base);   // the caller continues from this point when we return 0
    if (!(x2 > x1) || !isfinite(x1 + x2 + y1 + y2)) return 0;
    int bx = (int)floor(x1 * sx + m.x0) - 1, by = (int)floor(y1 + m.y0) - 1, ex = (int)ceil(x2 * sx + m.x0) + 1, ey = (int)ceil(y2 + m.y0) + 1, w = ex - bx, h = ey - by;
    if (w <= 0 || h <= 0 || (size_t)w * h > 600000) return 0;
    size_t bytes = (size_t)w * h;
    int slot = -1; unsigned long oldest = ~0ul;
    while (g_scBytes + bytes > SC_MAXBYTES) { int o = -1; unsigned long ou = ~0ul; for (int i = 0; i < SC_N; i++) if (g_sc[i].mask && g_sc[i].used < ou) { ou = g_sc[i].used; o = i; } if (o < 0) break; sc_free(&g_sc[o]); }
    for (int i = 0; i < SC_N; i++) { if (!g_sc[i].mask) { slot = i; break; } if (g_sc[i].used < oldest) { oldest = g_sc[i].used; slot = i; } }
    if (slot < 0) return 0;
    if (g_sc[slot].mask) sc_free(&g_sc[slot]);
    cairo_surface_t *ms = cairo_image_surface_create(CAIRO_FORMAT_A8, w, h);
    if (cairo_surface_status(ms) != CAIRO_STATUS_SUCCESS) { cairo_surface_destroy(ms); return 0; }
    cairo_t *c2 = cairo_create(ms); cairo_matrix_t m2 = { sx, 0, 0, 1, m.x0 - bx, m.y0 - by }; cairo_set_matrix(c2, &m2);
    cairo_set_tolerance(c2, g_text_tol); cairo_set_line_width(c2, s->lw); cairo_set_line_join(c2, s->join); cairo_set_line_cap(c2, s->cap); cairo_set_miter_limit(c2, s->miter);
    cairo_set_source_rgba(c2, 1, 1, 1, 1); cairo_move_to(c2, 0, -base); pango_cairo_layout_path(c2, c->layout); cairo_stroke(c2); cairo_destroy(c2);
    e = &g_sc[slot]; e->mask = ms; e->text = strdup(text); snprintf(e->font, sizeof e->font, "%s", s->fontStr); e->lw = s->lw; e->miter = s->miter; e->tol = g_text_tol;
    e->join = s->join; e->cap = s->cap; e->fx = fx; e->fy = fy; e->sx = sx; e->epoch = g_fontEpoch; e->bx = bx; e->by = by; e->bytes = bytes; g_scBytes += bytes;
  }
  e->used = ++g_scTick;
  Paint *p = &s->stroke;
  cairo_save(cr); cairo_identity_matrix(cr);
  cairo_set_source_rgba(cr, p->rgba[0], p->rgba[1], p->rgba[2], p->rgba[3] * s->alpha);
  cairo_mask_surface(cr, e->mask, e->bx, e->by);
  cairo_restore(cr);
  return 1;
}
DEF(textCacheSet, 1, g_scOn = B(0);)   // tests: switch the stroked-text cache on/off
DEFR(textCacheStats, 0, double v[3] = { g_scHit, g_scMiss, (double)g_scBytes }; return ret_arr_d(env, v, 3);)
// cvText(h, text, x, y, maxWidth(-1 = none), stroke)
DEF(cvText, 6, Cv *c = CV(0); char *t = arg_utf8(env, a_[1]);
  if (c && c->cr && t && isfinite(D(2)) && isfinite(D(3)) && !(D(4) == 0)) {
    layout_prepare(c, t);
    PangoRectangle ink, lg; pango_layout_get_extents(c->layout, &ink, &lg);
    double width = lg.width / (double)PANGO_SCALE, base = pango_layout_get_baseline(c->layout) / (double)PANGO_SCALE, maxw = D(4), sx = 1;
    if (maxw > 0 && width > maxw) sx = maxw / width;
    double w2 = width * sx, off = c->st.align == 1 ? -w2 : c->st.align == 2 ? -w2 / 2 : 0, shift = baseline_shift(c);
    cairo_t *cr = c->cr; int stroke = B(5);
    path_save(c); int fx = fx_begin(c);
    cairo_save(cr); cairo_translate(cr, D(2) + off, D(3) + shift); if (sx != 1) cairo_scale(cr, sx, 1); cairo_move_to(cr, 0, -base);
    if (stroke) {
      cairo_set_tolerance(cr, g_text_tol);
      if (!stroke_text_cached(c, t, base, sx)) {
        double t0 = now_us(); pango_cairo_layout_path(cr, c->layout); double t1 = now_us(); paint_path(c, 1, 0); double t2 = now_us();
        g_tt[0]++; g_tt[1] += t1 - t0; g_tt[2] += t2 - t1;
      }
    }
    else {
      Paint *p = &c->st.fill;
      if (!p->pat) { cairo_set_source_rgba(cr, p->rgba[0], p->rgba[1], p->rgba[2], p->rgba[3] * c->st.alpha); pango_cairo_show_layout(cr, c->layout); }
      else { cairo_push_group(cr); cairo_set_operator(cr, CAIRO_OPERATOR_OVER); cairo_set_source(cr, p->pat); pango_cairo_show_layout(cr, c->layout); cairo_pop_group_to_source(cr); cairo_paint_with_alpha(cr, c->st.alpha); }
    }
    cairo_restore(cr); fx_end(c, fx); path_restore(c);
  }
  free(t);)
// cvMeasure(h, text) -> [width, boxLeft, boxRight, boxAscent, boxDescent, fontAscent, fontDescent, emAscent, emDescent]
DEFR(cvMeasure, 2, Cv *c = CV(0); char *t = arg_utf8(env, a_[1]); double v[9] = {0};
  if (c && c->cr && t) {
    layout_create(c);   // font_metrics reads the (hinted) drawing context
    PangoLayout *ml = measure_layout(c, t);
    PangoRectangle ink, lg; pango_layout_get_extents(ml, &ink, &lg);
    double width = lg.width / (double)PANGO_SCALE, base = pango_layout_get_baseline(ml) / (double)PANGO_SCALE;
    double off = c->st.align == 1 ? -width : c->st.align == 2 ? -width / 2 : 0, shift = baseline_shift(c), a, d; font_metrics(c, &a, &d);
    double ix = ink.x / (double)PANGO_SCALE, iy = ink.y / (double)PANGO_SCALE, iw = ink.width / (double)PANGO_SCALE, ih = ink.height / (double)PANGO_SCALE;
    v[0] = width; v[1] = -(off + ix); v[2] = off + ix + iw; v[3] = (base - iy) - shift; v[4] = (iy + ih - base) + shift;
    v[5] = a - shift; v[6] = d + shift; v[7] = a - shift; v[8] = d + shift;
    if (!*t) { v[1] = v[2] = v[3] = v[4] = 0; }
  }
  free(t); return ret_arr_d(env, v, 9);)
